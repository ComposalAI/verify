# Changelog

## 1.1.0

- Track one grouped saved-Scenario Run with `test-run-id`, replacing retired sweep IDs.
- Wait through scenario preparation and approval before evaluating results.
- Document saved YAML Scenarios as the repeatable PR testing rules and report cleanup separately.

- Assign preview URLs to a Composal project and track the PR number or source branch.
- Auto-detect PR, workflow-run, and branch-push context; register branch previews even before an open PR exists.
- Confirm the requested project and deployed branch, and publish the registered environment identity.
- Document project environment listing and automatic archival after PR merge.


## 1

- Request PR verification against a ready CI preview or a configured Composal-managed preview.
- Pin preview handoff to the deployed PR head and reject obsolete workflows.
- Wait for results, publish workflow outputs, and link the PR verification history.
