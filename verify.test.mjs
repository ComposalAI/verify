import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configuration, verify } from './verify.mjs'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const sha = '2'.repeat(40)
const event = {
  repository: { name: 'shop' },
  pull_request: { number: 45, head: { sha, ref: 'fix/checkout' } },
}
const context = { repository: 'example/shop', runId: '123', runAttempt: '1', job: 'verify' }
const config = (inputs = {}, payload = event) =>
  configuration(
    { token: 'private-token', org: 'acme', project: 'storefront', ...inputs },
    payload,
    context
  )
const pr = {
  id: 'vpr_1',
  head_sha: sha,
  web_path: '/acme/verify/pull-requests/vpr_1',
  requested_run_id: 'vprun_1',
  project_id: 'project_storefront',
  project_slug: 'storefront',
  source_branch: 'fix/checkout',
}
const run = (status = 'passed') => ({
  id: 'vprun_1',
  head_sha: sha,
  display_state: status,
  run_id: 'run_grouped_1',
})
function transport(responses) {
  const calls = []
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined })
      const body = responses.shift()
      assert.notEqual(body, undefined, 'unexpected API request')
      return body instanceof Response ? body : Response.json(body)
    },
  }
}

test('infers PR head rather than GitHub merge SHA and uses stable retry keys', () => {
  const first = config()
  assert.equal(first.number, 45)
  assert.equal(first.sha, sha)
  assert.equal(first.project, 'storefront')
  assert.equal(first.repository, undefined)
  assert.equal(first.branch, 'fix/checkout')
  assert.equal(first.key, config().key)
  assert.notEqual(
    first.key,
    configuration({ token: 'private-token', org: 'acme', project: 'storefront' }, event, {
      ...context,
      runAttempt: '2',
    }).key
  )
  assert.equal(
    config(
      {},
      {
        repository: event.repository,
        workflow_run: {
          head_sha: sha,
          pull_requests: [{ number: 45, head: { sha } }],
        },
      }
    ).sha,
    sha
  )
})

test('conflicting workflow and PR commits require an explicit deployed SHA', () => {
  const workflowEvent = {
    repository: event.repository,
    workflow_run: {
      head_sha: '3'.repeat(40),
      pull_requests: [{ number: 45, head: { sha } }],
    },
  }
  assert.throws(() => config({}, workflowEvent), /exact commit deployed/)
  assert.equal(config({ sha }, workflowEvent).sha, sha)
})

test('accepts explicit project, PR and branch and infers workflow_run source branches', () => {
  const explicit = config({ project: 'storefront', pr: '46', branch: 'fix/payments', sha }, {})
  assert.equal(explicit.project, 'storefront')
  assert.equal(explicit.number, 46)
  assert.equal(explicit.branch, 'fix/payments')
  assert.equal(
    config(
      {},
      {
        workflow_run: {
          head_sha: sha,
          head_branch: 'fix/payments',
          pull_requests: [{ number: 46 }],
        },
      }
    ).branch,
    'fix/payments'
  )
})

test('branch-only pushes infer the deployed commit and register previews without a PR', async () => {
  const branchConfig = configuration(
    {
      token: 'private-token',
      org: 'acme',
      project: 'storefront',
      'preview-url': 'https://branch.preview.test',
    },
    {},
    { ...context, eventName: 'push', refType: 'branch', refName: 'fix/payments', sha }
  )
  assert.equal(branchConfig.number, undefined)
  assert.equal(branchConfig.branch, 'fix/payments')
  assert.equal(branchConfig.sha, sha)
  const api = transport([
    {
      id: null,
      number: null,
      requested_run_id: null,
      head_sha: sha,
      status: 'preview_registered',
      project_slug: 'storefront',
      source_branch: 'fix/payments',
      environment_id: 'venv_branch',
      web_path: '/acme/verify/storefront/environments/venv_branch',
    },
  ])
  const result = await verify(branchConfig, api)
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].body.number, undefined)
  assert.equal(api.calls[0].body.preview_url, 'https://branch.preview.test')
  assert.equal(result.status, 'preview_registered')
  assert.equal(result['environment-id'], 'venv_branch')
  assert.equal(result['run-id'], '')
})

test('branch selectors resolve an open PR before handing off its URL', async () => {
  const api = transport([{ ...pr, number: 45, source_branch: 'fix/payments' }, run('queued')])
  const result = await verify(
    config(
      { branch: 'fix/payments', sha, 'preview-url': 'https://branch.preview.test', wait: 'false' },
      {}
    ),
    api
  )
  assert.equal(api.calls[0].body.number, undefined)
  assert.equal(api.calls[1].body.number, 45)
  assert.equal(result.status, 'queued')
})

test('validates input authority and refuses ambiguous or missing PR context', () => {
  for (const inputs of [
    { token: '' },
    { org: '' },
    { sha: 'merge-sha' },
    { wait: 'yes' },
    { timeout: '0' },
    { timeout: 'Infinity' },
    { 'api-url': 'http://composal.ai' },
    { 'api-url': 'https://user:secret@composal.ai' },
    { 'preview-url': 'https://user:secret@preview.test' },
    { 'preview-url': 'https://preview.test', environment: 'other' },
  ]) {
    assert.throws(() => config(inputs))
  }
  assert.throws(() =>
    config({}, { workflow_run: { head_sha: sha, pull_requests: [{ number: 45 }, { number: 46 }] } })
  )
  assert.equal(config({ pr: '#45', sha }, {}).number, 45)
})

test('hands a deployed URL to the exact request, waits, and publishes the grouped run identity', async () => {
  const api = transport([
    pr,
    run('waiting_for_preview'),
    { pull_request: pr, runs: [run('preparing')] },
    { pull_request: pr, runs: [run('prepared')] },
    { pull_request: pr, runs: [run('queued')] },
    { pull_request: pr, runs: [run('running')] },
    { pull_request: pr, runs: [run()] },
  ])
  const updates = []
  const result = await verify(
    config({ project: 'storefront', 'preview-url': 'https://pr-45.preview.test' }),
    {
      ...api,
      sleep: async () => {},
      publish: (value) => updates.push({ ...value }),
    }
  )
  assert.equal(api.calls[0].body.head_sha, sha)
  assert.equal(api.calls[0].body.number, 45)
  assert.equal(api.calls[0].body.project_id, 'storefront')
  assert.equal('repository_id' in api.calls[0].body, false)
  assert.equal(api.calls[0].body.branch, 'fix/checkout')
  assert.equal(api.calls[1].body.project_id, 'storefront')
  assert.equal('repository_id' in api.calls[1].body, false)
  assert.equal(api.calls[1].body.branch, 'fix/checkout')
  assert.equal(api.calls[1].body.preview_url, 'https://pr-45.preview.test')
  assert.equal(api.calls[1].body.head_sha, sha)
  assert.equal(api.calls[0].headers.Authorization, 'Bearer private-token')
  assert.equal(api.calls[0].redirect, 'error')
  assert.equal(result.status, 'passed')
  assert.equal(result['test-run-id'], 'run_grouped_1')
  assert.equal(result.url, 'https://composal.ai/acme/verify/pull-requests/vpr_1')
  assert.deepEqual(
    updates.map((value) => value.status),
    ['queued', 'waiting_for_preview', 'preparing', 'prepared', 'queued', 'running', 'passed']
  )
})

test('accepts an existing environment without registering a URL', async () => {
  const api = transport([pr, run('queued')])
  const result = await verify(config({ environment: 'preview-45', wait: 'false' }), api)
  assert.equal(api.calls[1].body.environment, 'preview-45')
  assert.equal(api.calls[1].body.preview_url, undefined)
  assert.equal(result.status, 'queued')
})

test('configured managed previews need only one request when wait is false', async () => {
  const api = transport([pr])
  assert.equal((await verify(config({ wait: 'false' }), api)).status, 'queued')
  assert.equal(api.calls.length, 1)
})

test('refuses APIs that silently ignore the project or deployed branch', async () => {
  await assert.rejects(
    verify(config({ project: 'another-project' }), transport([pr])),
    /requested project/
  )
  await assert.rejects(
    verify(config(), transport([{ ...pr, source_branch: undefined }])),
    /source branch/
  )
})

test('drafts do not attempt a preview handoff', async () => {
  const api = transport([{ ...pr, requested_run_id: null }])
  assert.equal(
    (await verify(config({ 'preview-url': 'https://preview.test' }), api)).status,
    'skipped'
  )
  assert.equal(api.calls.length, 1)
})

test('unsuccessful outcomes fail while retaining outputs', async () => {
  for (const status of [
    'failed',
    'blocked',
    'cleanup_blocked',
    'timed_out',
    'cancelled',
    'superseded',
  ]) {
    const api = transport([pr, { pull_request: pr, runs: [run(status)] }])
    let output
    await assert.rejects(
      verify(config(), {
        ...api,
        publish: (value) => {
          output = { ...value }
        },
      }),
      /Verification /
    )
    assert.equal(output.status, status)
  }
  const api = transport([pr, { pull_request: pr, runs: [run('skipped')] }])
  assert.equal((await verify(config(), api)).status, 'skipped')
})

test('stale heads and concurrent reruns cannot be reported as passed', async () => {
  const api = transport([pr, { pull_request: pr, runs: [{ ...run(), id: 'vprun_newer' }, run()] }])
  await assert.rejects(verify(config(), api), /superseded/)
  const handoff = transport([pr, { ...run(), id: 'vprun_newer' }])
  await assert.rejects(verify(config({ environment: 'preview-45' }), handoff), /superseded/)
  const stale = transport([new Response('sensitive server body', { status: 409 })])
  await assert.rejects(verify(config({ 'preview-url': 'https://preview.test' }), stale), /HTTP 409/)
  assert.equal(stale.calls.length, 1)
})

test('timeout fails with a history link while server verification continues', async () => {
  const api = transport([pr, { pull_request: pr, runs: [run('running')] }])
  let time = 0
  let output
  await assert.rejects(
    verify(
      { ...config(), timeoutMs: 100 },
      {
        ...api,
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
        publish: (value) => {
          output = { ...value }
        },
      }
    ),
    /still running/
  )
  assert.equal(output.status, 'waiting')
  assert.equal(api.calls.length, 2)
})

test('transient errors retry without changing identity; error bodies never leak', async () => {
  const api = transport([new Response('secret response', { status: 503 }), pr])
  await verify(config({ wait: 'false' }), { ...api, sleep: async () => {} })
  assert.deepEqual(api.calls[0].body, api.calls[1].body)
  const refused = transport([new Response('private-token database credentials', { status: 401 })])
  await assert.rejects(
    verify(config(), refused),
    (error) => !error.message.includes('private-token') && !error.message.includes('database')
  )
})

test('entrypoint reads Actions inputs, writes outputs and summary, and masks the token', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verify-action-'))
  try {
    const eventPath = join(directory, 'event.json')
    const outputPath = join(directory, 'output.txt')
    const summaryPath = join(directory, 'summary.md')
    const hook = join(directory, 'transport.mjs')
    writeFileSync(eventPath, JSON.stringify(event))
    writeFileSync(hook, `globalThis.fetch = async () => Response.json(${JSON.stringify(pr)});`)
    const stdout = execFileSync(
      process.execPath,
      ['--import', hook, fileURLToPath(new URL('./index.mjs', import.meta.url))],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          INPUT_TOKEN: 'private-token',
          INPUT_ORG: 'acme',
          INPUT_PROJECT: 'storefront',
          INPUT_BRANCH: 'fix/checkout',
          INPUT_WAIT: 'false',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_JOB: 'verify',
          GITHUB_REPOSITORY: 'example/shop',
        },
      }
    )
    assert.ok(stdout.startsWith('::add-mask::private-token'))
    assert.ok(readFileSync(outputPath, 'utf8').includes('vprun_1'))
    assert.ok(readFileSync(summaryPath, 'utf8').includes('**queued**'))
    assert.ok(!readFileSync(summaryPath, 'utf8').includes('private-token'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('requires a Composal project and never infers it from a GitHub repository', () => {
  assert.throws(() => config({ project: '' }), /Set project/)
  assert.equal(config({ repository: 'ignored-repository' }).project, 'storefront')
  assert.equal(config({ repository: 'ignored-repository' }).repository, undefined)
})
