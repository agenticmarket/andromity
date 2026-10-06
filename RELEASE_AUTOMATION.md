# Release README pull requests

The **Andromity Release Notes** workflow opens a README-only PR when a stable GitHub release is published. It can also be started manually under **Actions → Andromity Release Notes → Run workflow** for the current latest release, including 0.2.15.

It copies up to three bullet points from the published notes into one marked `Latest release` section, links to the release and complete changelog, and replaces that section on the next release. Historical entries in `CHANGELOG.md` are retained. Runs always use the latest stable release, so an older event cannot replace newer release notes. Repeated runs reuse the release branch/PR and skip an already-current README. PRs are never merged automatically.

## Cost and identity

This is deterministic automation. No model inference, LLM API key, or model tokens are used. GitHub Actions runner usage can still count toward your account's allowance.

By default the workflow uses `GITHUB_TOKEN` and the PR is attributed to GitHub Actions. Commits credit Andromity as co-author. To have the PR opened by the actual Andromity bot account, optionally set the repository secret `ANDROMITY_BOT_TOKEN` to a repository-scoped token belonging to that account, with Contents and Pull requests read/write access. Never paste that token in a chat or commit it.

## Enablement

Merge the workflow and script into `main`. Under **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**, if repository or organization policy permits it. The workflow requests write permissions only in its release-update job. It does not approve PRs.

With the default `GITHUB_TOKEN`, PR workflows may require a maintainer to approve runs. Check CI before merging. A GitHub App installation token or bot token can provide the desired identity and workflow triggering; neither is needed for the zero-token default setup.

The separate root `action.yml` supports AI PR reviews. Its legacy `task` mode explicitly reports that coding tasks and PR creation are unavailable, instead of claiming changes were made. This release workflow demonstrates real release maintenance, not autonomous AI coding.

## PyPI publishing

The **Publish to PyPI** workflow publishes on new stable `vMAJOR.MINOR.PATCH` tag pushes. For an existing tag, run it manually from `main` and supply that tag, such as `v0.2.15`. It checks out the exact tag, validates the package versions and changelog, and builds a wheel and source archive. A separate job downloads those artifacts, checks their metadata, and uploads them with the repository Actions secret `PYPI_TOKEN`.

Build jobs cannot access the publishing token. Upload failures remain failures; the workflow does not silently skip previously published files. Do not move an existing release tag or expect an already-pushed tag to trigger a newly added workflow. VS Code Marketplace publication remains manual, and Open VSX uses the separate platform-build workflow.

## Recover an Open VSX publication

If a tag build failed but a later rebuild succeeded, use **Publish Existing VSIX to Open VSX** from `main`. Supply the successful **Build Platform Binaries** run ID and expected extension version. The workflow checks the source run, locks the three artifact IDs, validates the publisher, extension name, version, platform coverage, and server binaries, then publishes those exact packages. Registry credentials are available only to the publishing job.

For the 0.2.15 recovery, the successful rebuild is run `37542533127`. This avoids rebuilding the old tag or changing its commit. The workflow accepts `OVSX_PAT`, `OPEN_VSX_TOKEN`, or `OPENVSX_TOKEN`. Normal future tag builds still publish through **Build Platform Binaries**. VS Code Marketplace publishing remains manual.
