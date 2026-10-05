# Composal Verify for GitHub Actions

Test the product journeys affected by your PR against its deployed preview. Verify selects what to test, runs browser checks, and keeps one GitHub comment updated with findings and issue recordings.

```yaml
- uses: composalai/verify@1
  with:
    token: ${{ secrets.COMPOSAL_TOKEN }}
    org: ${{ vars.COMPOSAL_ORG }}
    project: ${{ vars.COMPOSAL_PROJECT }}
    preview-url: ${{ steps.deploy.outputs.url }}
```

Configure the connected repository once in **Verify → PR verification**. Select **Preview supplied by CI**, your scenario pack, and an external Verify environment template containing your personas and safety policy. Add a Composal administrator API token as the `COMPOSAL_TOKEN` Actions secret and your organization slug as the `COMPOSAL_ORG` variable.

Run this step after deploying **`github.event.pull_request.head.sha`** and waiting for the preview to become reachable. GitHub's `github.sha` can be a synthetic merge commit; Verify deliberately uses the PR head. Your existing deployment provider supplies the URL; this action does not build an arbitrary app.

Set `COMPOSAL_PROJECT` to your Composal project slug or public ID. Each URL handoff automatically registers a preview in that project’s **Environments** page, labelled with its PR number and branch. Repeated handoffs reuse the environment; new requests keep separate preview records. When the connected GitHub App observes the PR merge, Composal archives its generated previews after active verification finishes. Use **Show Archived** to view their retained history. This does not delete the deployment at your provider.

The action accepts either `pr` or `branch`; both are optional when GitHub supplies the context. It infers PR numbers from PR events and source branches from PR, `workflow_run`, or branch `push` events. Set `repository` if the connected Composal repository has a different slug. It needs no checkout, installed CLI, or GitHub token: Composal's connected GitHub App maintains the results comment.

For a branch deployment with no open PR, supply the preview URL and project. The action registers the environment and succeeds with `status: preview_registered` and an `environment-id`; it does not report a browser test pass. When a PR later opens for that branch, Verify links the branch previews to it and archives them after merge. If a branch has multiple open PRs, supply `pr` explicitly. Branches registered in multiple projects need an explicit project selection before they can be linked automatically.

```yaml
# After a deployment in a branch push workflow; branch and SHA are auto-detected.
- uses: composalai/verify@1
  with:
    token: ${{ secrets.COMPOSAL_TOKEN }}
    org: ${{ vars.COMPOSAL_ORG }}
    project: ${{ vars.COMPOSAL_PROJECT }}
    preview-url: ${{ steps.deploy.outputs.url }}
    # For another event type, set branch OR pr and the deployed sha explicitly:
    # branch: feature/checkout
    # sha: <full deployed commit SHA>
```

## Composal-hosted previews

If the repository is configured to **Build a Composal preview**, leave out `preview-url`. Verify provisions and deploys the exact PR commit using the configured profile. The same minimal step works with **GitHub deployment preview** discovery.

```yaml
- uses: composalai/verify@1
  with:
    token: ${{ secrets.COMPOSAL_TOKEN }}
    org: ${{ vars.COMPOSAL_ORG }}
    project: ${{ vars.COMPOSAL_PROJECT }}
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
          project: ${{ vars.COMPOSAL_PROJECT }}
```

The fork condition avoids running a secret-dependent step when GitHub withholds secrets. Keep your deployment and secret use on trusted workflow events; do not switch to `pull_request_target` just to expose secrets to fork code.

By default the action waits up to 15 minutes. Passed or explicitly skipped requests succeed. Failed, blocked, cancelled, superseded, cleanup-blocked, and timed-out requests fail the step. A wait timeout also fails the step, with a link to the run that continues in Composal. Set `wait: 'false'` for an asynchronous handoff; a successful handoff means accepted, not passed.

## Inputs and outputs

| Input         | Default                | Meaning                                                                                                           |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `token`       | Required               | Composal API token, supplied through a secret.                                                                    |
| `org`         | Required               | Composal organization slug.                                                                                       |
| `preview-url` | Omitted                | Ready URL deployed from this PR head or branch commit. Requires CI preview mode and an external Verify template.  |
| `environment` | Omitted                | Ready Verify preview environment slug; mutually exclusive with `preview-url`.                                     |
| `repository`  | GitHub repository name | Connected Composal repository slug.                                                                               |
| `project`     | Template’s project     | Composal project slug or public ID where PR previews are listed. Set explicitly when the template has no project. |
| `branch`      | GitHub source branch   | Optional alternative to `pr`. Resolves an open PR or registers a branch preview when none exists.                 |
| `pr`          | PR event               | Optional alternative to `branch`. `workflow_run` works when it identifies one PR.                                 |
| `sha`         | PR head or branch push | Full deployed commit SHA. PR heads and branch pushes are inferred; supply it for other event types.               |
| `wait`        | `'true'`               | Wait for results; `'false'` only requests verification.                                                           |
| `timeout`     | `'15'`                 | Wait limit in minutes, between 1 and 60. Set the job timeout higher.                                              |
| `api-url`     | `https://composal.ai`  | HTTPS API origin, for installations using another endpoint.                                                       |

Outputs: `url` (PR history or registered branch environment), `pull-request-id`, `run-id`, `sweep-id` (when started), `environment-id` (branch registration), and `status`. The workflow summary links to the full results. Critical/high issue recordings remain authenticated links in Verify.

Retries within the same workflow attempt reuse the same verification request. Rerunning the workflow creates a fresh request. A workflow for an obsolete head cannot start a run for the newer head.

## Maintainers: release

This directory is the complete dependency-free action distribution. It runs on GitHub's [Node 24 action runtime](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runs-for-javascript-actions). No build or dependency installation is needed by consumers.

The `1` tag is the supported major release. To publish an update from the Vex monorepo, copy `action.yml`, `index.mjs`, `verify.mjs`, the tests, and this README to that repository's root. Run `node --test verify.test.mjs`, commit the reviewed files, and create the `1` release tag at that commit. Update that major tag deliberately for compatible releases; use immutable commit pins where your workflow requires them.

## GitLab CI

For GitLab.com merge request pipelines, include
`https://composal.ai/ci/verify/v1/gitlab.yml` and extend `.composal-verify`
after your preview deployment. The copyable configuration in Verify → PR & MR
Testing includes direct MR pipeline rules and the connected Composal repo slug.
The helper reads GitLab's IID and source SHA, hands off the exact preview, waits
for its own verification run, and writes safe result IDs/links to
`composal-verify.json`.

See [GitLab setup and CI variables](https://composal.ai/docs/verify/source-control/gitlab#gitlab-ci)
for dotenv handoff, fork and synthetic-commit restrictions, merge protection,
and CLI/API examples.
