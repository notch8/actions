# actions
Github action for Docker build, Rubocop linting, and running Rspec tests for Rails applications.

## Release process (GitLab flow)

Shared pieces of samvera/hyku's release process, so each Hyku knapsack only carries small callers.

- `auto-merger`: composite action. On a push to `staging` or `production`, opens or updates a draft merge-down PR for anything that skipped the branch below it (hotfixes). Pass `merges: '{"production":"main"}'` for repos without a `staging` step.
- `.github/workflows/release-draft.yaml`: drafts release notes from the caller's `.github/release-drafter*.yml`, prerelease on `staging`, and notes the pinned Hyku version and SHA in the footer.
- `.github/workflows/publish-release.yaml`: after a production Deploy succeeds, waits for approval on the `production` environment, then publishes the newest stable draft pinned to the deployed commit. Approve once the deploy is verified.
- `.github/workflows/verify-labels.yaml`: requires one release-notes label per PR. The required check is named `<caller job> / PR has required labels`.

```yaml
# .github/workflows/auto-merger.yml
on:
  push:
    branches: [staging, production]
jobs:
  auto-merger:
    runs-on: ubuntu-latest
    steps:
      - uses: notch8/actions/auto-merger@v1.0.13
        with:
          app-id: ${{ secrets.AUTO_MERGER_APP_ID }}
          private-key: ${{ secrets.AUTO_MERGER_APP_PRIVATE_KEY }}

# .github/workflows/release-draft.yml
on:
  push:
    branches: [staging, production]
permissions:
  contents: write
  pull-requests: read
jobs:
  draft:
    uses: notch8/actions/.github/workflows/release-draft.yaml@v1.0.13

# .github/workflows/publish-release.yml
on:
  workflow_run:
    workflows: ["Deploy"]
    types: [completed]
    branches: [production]
jobs:
  publish:
    if: github.event.workflow_run.conclusion == 'success'
    permissions:
      contents: write
    uses: notch8/actions/.github/workflows/publish-release.yaml@v1.0.13
    with:
      sha: ${{ github.event.workflow_run.head_sha }}
      deploy-run-id: ${{ github.event.workflow_run.id }}
```
See `examples/` for caller workflows, including a deploy that runs after Build Test Lint succeeds on `main`, `staging` or `production`.
