# Composal Verify for GitHub Actions

Test the product journeys affected by your PR against its deployed preview. Verify selects what to test, runs browser checks, and keeps one GitHub comment updated with findings and issue recordings.

```yaml
- uses: composalai/verify@1
  with:
    token: ${{ secrets.COMPOSAL_TOKEN }}
    org: ${{ vars.COMPOSAL_ORG }}
    preview-url: ${{ steps.deploy.outputs.url }}
```

Configure the connected repository once in **Verify → PR verification**. Select **Preview supplied by CI**, your scenario pack, and an external Verify environment template containing your personas and safety policy. Add a Composal administrator API token as the `COMPOSAL_TOKEN` Actions secret and your organization slug as the `COMPOSAL_ORG` variable.

Run this step after deploying **`github.event.pull_request.head.sha`** and waiting for the preview to become reachable. GitHub's `github.sha` can be a synthetic merge commit; Verify deliberately uses the PR head. Your existing deployment provider supplies the URL; this action does not build an arbitrary app.

The action infers the PR number and repository name. Set `repository` if the connected Composal repository has a different slug. It needs no checkout, installed CLI, or GitHub token: Composal's connected GitHub App maintains the results comment.

## Composal-hosted previews

If the repository is configured to **Build a Composal preview**, leave out `preview-url`. Verify provisions and deploys the exact PR commit using the configured profile. The same minimal step works with **GitHub deployment preview** discovery.

```yaml
- uses: composalai/verify@1
  with:
    token: ${{ secrets.COMPOSAL_TOKEN }}
    org: ${{ vars.COMPOSAL_ORG }}
```

For a pipeline that already readies a Verify preview environment, pass its slug with `environment` instead of `preview-url`. CI must attest the deployed commit; Composal-managed targets also validate their healthy deployments against that SHA.

## A complete workflow

Call the action in your existing preview job after its deployment step. A separate job can consume a deployed URL from job outputs:

```yaml
name: Verify PR
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
concurrency:
  group: verify-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  verify:
    if: ${{ !github.event.pull_request.draft && github.event.pull_request.head.repo.full_name == github.repository }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      # With Composal preview deployment configured, no deploy step is needed.
      - uses: composalai/verify@1
        id: verify
        with:
          token: ${{ secrets.COMPOSAL_TOKEN }}
          org: ${{ vars.COMPOSAL_ORG }}
```

The fork condition avoids running a secret-dependent step when GitHub withholds secrets. Keep your deployment and secret use on trusted workflow events; do not switch to `pull_request_target` just to expose secrets to fork code.

By default the action waits up to 15 minutes. Passed or explicitly skipped requests succeed. Failed, blocked, cancelled, superseded, cleanup-blocked, and timed-out requests fail the step. A wait timeout also fails the step, with a link to the run that continues in Composal. Set `wait: 'false'` for an asynchronous handoff; a successful handoff means accepted, not passed.

## Inputs and outputs

| Input         | Default                | Meaning                                                                                         |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `token`       | Required               | Composal API token, supplied through a secret.                                                  |
| `org`         | Required               | Composal organization slug.                                                                     |
| `preview-url` | Omitted                | Ready URL deployed from this PR head. Requires CI preview mode and an external Verify template. |
| `environment` | Omitted                | Ready Verify preview environment slug; mutually exclusive with `preview-url`.                   |
| `repository`  | GitHub repository name | Connected Composal repository slug.                                                             |
| `pr`          | PR event               | PR number. `workflow_run` works when it identifies one PR.                                      |
| `sha`         | PR head                | Full deployed PR head SHA. Supply it with `pr` on other event types.                            |
| `wait`        | `'true'`               | Wait for results; `'false'` only requests verification.                                         |
| `timeout`     | `'15'`                 | Wait limit in minutes, between 1 and 60. Set the job timeout higher.                            |
| `api-url`     | `https://composal.ai`  | HTTPS API origin, for installations using another endpoint.                                     |

Outputs: `url` (PR verification history), `pull-request-id`, `run-id`, `sweep-id` (when started), and `status`. The workflow summary links to the full results. Critical/high issue recordings remain authenticated links in Verify.

Retries within the same workflow attempt reuse the same verification request. Rerunning the workflow creates a fresh request. A workflow for an obsolete head cannot start a run for the newer head.

## Maintainers: release

This directory is the complete dependency-free action distribution. It runs on GitHub's [Node 24 action runtime](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runs-for-javascript-actions). No build or dependency installation is needed by consumers.

The `1` tag is the supported major release. To publish an update from the Vex monorepo, copy `action.yml`, `index.mjs`, `verify.mjs`, the tests, and this README to that repository's root. Run `node --test verify.test.mjs`, commit the reviewed files, and create the `1` release tag at that commit. Update that major tag deliberately for compatible releases; use immutable commit pins where your workflow requires them.
