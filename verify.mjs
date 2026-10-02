import { createHash } from 'node:crypto'

export function configuration(inputs, event, context) {
  const pr =
    event.pull_request ??
    (event.workflow_run?.pull_requests?.length === 1 ? event.workflow_run.pull_requests[0] : null)
  const number = Number(String(inputs.pr || pr?.number || '').replace(/^#/, ''))
  if (!inputs.sha && event.workflow_run?.head_sha && pr?.head?.sha &&
      event.workflow_run.head_sha !== pr.head.sha) {
    throw new Error('workflow_run has different workflow and PR head SHAs. Set sha to the exact commit deployed.')
  }
  const sha = inputs.sha || pr?.head?.sha || event.workflow_run?.head_sha
  if (!inputs.token) throw new Error('Set token to a Composal API token stored in a GitHub secret.')
  if (!inputs.org) throw new Error('Set org to your Composal organization slug.')
  if (!Number.isSafeInteger(number) || number < 1 || !/^[0-9a-f]{40,64}$/.test(sha ?? '')) {
    throw new Error('Run on a PR event, or supply pr and sha for the exact deployed PR head.')
  }
  if (inputs['preview-url'] && inputs.environment)
    throw new Error('Supply preview-url or environment, not both.')
  if (inputs['preview-url']) {
    const preview = new URL(inputs['preview-url'])
    if (!['https:', 'http:'].includes(preview.protocol) || preview.username || preview.password)
      throw new Error('preview-url must be an HTTP(S) URL without embedded credentials.')
  }
  const base = new URL(inputs['api-url'] || 'https://composal.ai')
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('api-url must be an HTTPS origin without credentials.')
  const wait = inputs.wait || 'true'
  const minutes = Number(inputs.timeout || '15')
  if (!['true', 'false'].includes(wait) || !Number.isFinite(minutes) || minutes < 1 || minutes > 60)
    throw new Error('wait must be true or false; timeout must be between 1 and 60 minutes.')
  const repository =
    inputs.repository || event.repository?.name || context.repository?.split('/').at(-1)
  if (!repository) throw new Error('Set repository to the connected Composal repository slug.')
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        context.repository,
        context.runId,
        context.runAttempt,
        context.job,
        number,
        sha,
      ])
    )
    .digest('hex')
  return {
    token: inputs.token,
    org: inputs.org,
    repository,
    number,
    sha,
    previewUrl: inputs['preview-url'],
    environment: inputs.environment,
    wait: wait === 'true',
    timeoutMs: minutes * 60_000,
    base: base.origin,
    key: `github-action:${key}`,
  }
}

export async function verify(
  config,
  {
    fetch: request = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    publish = () => {},
  } = {}
) {
  const root = `${config.base}/api/v1/organizations/${encodeURIComponent(config.org)}/verify`
  async function api(path, body) {
    for (let attempt = 0; ; attempt++) {
      let response
      try {
        response = await request(`${root}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
      } catch {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        throw new Error('Unable to reach Composal. Check connectivity and retry the workflow.')
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      if (!response.ok) {
        const hints = {
          401: 'Check the Composal token.',
          403: 'The token needs administrator access to this organization.',
          404: 'Check the org, repository, and PR verification setup.',
          409: 'The PR changed or this preview handoff conflicts with an earlier request.',
        }
        // Do not echo response bodies: they can contain credentials or preview URL query strings.
        throw new Error(
          `Composal returned HTTP ${response.status}. ${hints[response.status] || 'Check the PR preview configuration and supplied inputs.'}`
        )
      }
      try {
        return await response.json()
      } catch {
        throw new Error('Composal returned an invalid response.')
      }
    }
  }
  const pr = await api('/pull_requests', {
    repository_id: config.repository,
    number: config.number,
    head_sha: config.sha,
    idempotency_key: config.key,
  })
  if (
    !('requested_run_id' in pr) ||
    typeof pr.web_path !== 'string' ||
    !pr.web_path.startsWith('/')
  )
    throw new Error(
      'The Composal endpoint does not support this action version. Update its PR verification API.'
    )
  if (pr.head_sha !== config.sha)
    throw new Error('The workflow commit is no longer the current PR head.')
  const url = new URL(pr.web_path, config.base)
  if (url.origin !== config.base) throw new Error('Composal returned an invalid verification URL.')
  const outputs = {
    url: url.href,
    'pull-request-id': pr.id,
    'run-id': pr.requested_run_id || '',
    'sweep-id': '',
    status: pr.requested_run_id ? 'queued' : 'skipped',
  }
  await publish(outputs)
  if (!pr.requested_run_id) return outputs // Draft or closed PR; no browser run was requested.
  if (config.previewUrl || config.environment) {
    const run = await api('/pull_requests/preview', {
      repository_id: config.repository,
      number: config.number,
      head_sha: config.sha,
      ...(config.previewUrl
        ? { preview_url: config.previewUrl }
        : { environment: config.environment }),
    })
    if (run.id !== pr.requested_run_id)
      throw new Error('A newer verification request superseded this handoff.')
    outputs.status = run.display_state
    outputs['sweep-id'] = run.verify_sweep_id || ''
    await publish(outputs)
  }
  if (!config.wait) return outputs
  const deadline = now() + config.timeoutMs
  const active = new Set(['queued', 'waiting_for_preview', 'running', 'cancelling', 'terminal'])
  while (now() < deadline) {
    const page = await api(`/pull_requests/${encodeURIComponent(pr.id)}`)
    const run = page.runs.find((candidate) => candidate.id === pr.requested_run_id)
    if (
      !run ||
      run.head_sha !== config.sha ||
      page.pull_request.head_sha !== config.sha ||
      page.runs[0]?.id !== run.id
    )
      throw new Error('A newer PR revision or verification request superseded this run.')
    outputs.status = run.display_state
    outputs['sweep-id'] = run.verify_sweep_id || ''
    await publish(outputs)
    if (!active.has(outputs.status)) {
      if (!['passed', 'skipped'].includes(outputs.status))
        throw new Error(`Verification ${outputs.status}. Review the results: ${outputs.url}`)
      return outputs
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - now())))
  }
  outputs.status = 'waiting'
  await publish(outputs)
  throw new Error(
    `Verification is still running after the action timeout. It continues in Composal: ${outputs.url}`
  )
}
