import { createHash } from 'node:crypto'

export function configuration(inputs, event, context) {
  const pr =
    event.pull_request ??
    (event.workflow_run?.pull_requests?.length === 1 ? event.workflow_run.pull_requests[0] : null)
  const rawNumber = String(inputs.pr || pr?.number || '').replace(/^#/, '')
  const number = rawNumber ? Number(rawNumber) : undefined
  if (
    !inputs.sha &&
    event.workflow_run?.head_sha &&
    pr?.head?.sha &&
    event.workflow_run.head_sha !== pr.head.sha
  ) {
    throw new Error(
      'workflow_run has different workflow and PR head SHAs. Set sha to the exact commit deployed.'
    )
  }
  const sha =
    inputs.sha ||
    pr?.head?.sha ||
    event.workflow_run?.head_sha ||
    (context.eventName === 'push' && context.refType === 'branch' ? context.sha : undefined)
  const branch =
    inputs.branch ||
    pr?.head?.ref ||
    event.workflow_run?.head_branch ||
    (!number && context.refType === 'branch' ? context.refName : undefined)
  if (!inputs.token) throw new Error('Set token to a Composal API token stored as a CI secret.')
  if (!inputs.org) throw new Error('Set org to your Composal organization slug.')
  if (!inputs.project && context.provider !== 'gitlab')
    throw new Error('Set project to your Composal project slug or ID.')
  if (
    (rawNumber && (!Number.isSafeInteger(number) || number < 1)) ||
    (!number && !branch) ||
    !/^[0-9a-f]{40,64}$/.test(sha ?? '')
  ) {
    throw new Error('Supply a PR number or source branch and the exact deployed source commit.')
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
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        context.repository,
        context.runId,
        context.runAttempt,
        context.job,
        number,
        inputs.project,
        branch,
        sha,
      ])
    )
    .digest('hex')
  return {
    token: inputs.token,
    org: inputs.org,
    project: inputs.project,
    ...(context.provider === 'gitlab' ? { repository: inputs.repository } : {}),
    branch,
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
  const requests = config.provider === 'gitlab' ? '/merge_requests' : '/pull_requests'
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
          404: 'Check the org, project, and project PR Testing setup.',
          409: 'The request changed or this preview handoff conflicts with an earlier request.',
        }
        // Do not echo response bodies: they can contain credentials or preview URL query strings.
        throw new Error(
          `Composal returned HTTP ${response.status}. ${hints[response.status] || 'Check the preview configuration and supplied inputs.'}`
        )
      }
      try {
        return await response.json()
      } catch {
        throw new Error('Composal returned an invalid response.')
      }
    }
  }
  const pr = await api(requests, {
    ...(config.provider === 'gitlab' ? { repository_id: config.repository } : {}),
    ...(config.number ? { number: config.number } : {}),
    head_sha: config.sha,
    ...(config.project ? { project_id: config.project } : {}),
    ...(config.branch ? { branch: config.branch } : {}),
    ...(!config.number && config.previewUrl ? { preview_url: config.previewUrl } : {}),
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
  if (
    config.project &&
    pr.project_id !== config.project &&
    pr.project_slug !== config.project.toLowerCase()
  )
    throw new Error(
      'Composal did not assign the preview to the requested project. Update its preview API.'
    )
  if (config.branch && pr.source_branch !== config.branch)
    throw new Error(
      'Composal did not confirm the deployed source branch. Check the branch and preview API version.'
    )
  const url = new URL(pr.web_path, config.base)
  if (url.origin !== config.base) throw new Error('Composal returned an invalid verification URL.')
  const outputs = {
    url: url.href,
    'pull-request-id': pr.id || '',
    'run-id': pr.requested_run_id || '',
    'sweep-id': '',
    status: pr.requested_run_id ? 'queued' : pr.status || 'skipped',
    'environment-id': pr.environment_id || '',
  }
  await publish(outputs)
  if (!pr.requested_run_id) return outputs // Registered branch preview, draft or closed PR.
  if (config.previewUrl || config.environment) {
    const run = await api(`${requests}/preview`, {
      ...(config.provider === 'gitlab' ? { repository_id: config.repository } : {}),
      number: pr.number || config.number,
      head_sha: config.sha,
      ...(config.project ? { project_id: config.project } : {}),
      ...(config.branch ? { branch: config.branch } : {}),
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
    const page = await api(`${requests}/${encodeURIComponent(pr.id)}`)
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
