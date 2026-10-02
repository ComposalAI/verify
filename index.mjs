import { appendFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { configuration, verify } from './verify.mjs'

const escapeCommand = (value) =>
  String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const inputs = Object.fromEntries(
  [
    'token',
    'org',
    'preview-url',
    'environment',
    'repository',
    'pr',
    'sha',
    'wait',
    'timeout',
    'api-url',
  ].map((key) => [key, (process.env[`INPUT_${key.toUpperCase()}`] || '').trim()])
)
if (inputs.token) console.log(`::add-mask::${escapeCommand(inputs.token)}`)
let outputs
try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const config = configuration(inputs, event, {
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
  })
  outputs = await verify(config, {
    publish: async (values) => {
      outputs = { ...values }
      if (process.env.GITHUB_OUTPUT) {
        for (const [key, value] of Object.entries(values)) {
          const marker = randomUUID()
          await appendFile(process.env.GITHUB_OUTPUT, `${key}<<${marker}\n${value}\n${marker}\n`)
        }
      }
    },
  })
  console.log(`Verify ${outputs.status}: ${outputs.url}`)
} catch (error) {
  const message = error.message.replaceAll(inputs.token || '\0', '[redacted]')
  console.log(`::error::${escapeCommand(message)}`)
  process.exitCode = 1
} finally {
  if (outputs && process.env.GITHUB_STEP_SUMMARY) {
    const status = outputs.status.replace(/[^a-z_]/g, '')
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Composal Verify\n\n**${status}** · [PR verification history](${outputs.url})\n\nFindings, recordings, and feedback are available in Verify and the GitHub results comment.\n`
    )
  }
}
