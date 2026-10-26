# Release automation

Pushing a stable `vMAJOR.MINOR.PATCH` tag starts the release workflows below. Release notes live in `CHANGELOG.md` and `vscode-extension/CHANGELOG.md`; the README does not repeat them.

The separate root `action.yml` supports AI PR reviews. Its legacy `task` mode explicitly reports that coding tasks and PR creation are unavailable, instead of claiming changes were made.

## PyPI publishing

The **Publish to PyPI** workflow publishes on new stable `vMAJOR.MINOR.PATCH` tag pushes. For an existing tag, run it manually from `main` and supply that tag, such as `v0.2.15`. It checks out the exact tag, validates the package versions and changelog, and builds a wheel and source archive. A separate job downloads those artifacts, checks their metadata, and uploads them with the repository Actions secret `PYPI_TOKEN`.

Build jobs cannot access the publishing token. Upload failures remain failures; the workflow does not silently skip previously published files. Do not move an existing release tag or expect an already-pushed tag to trigger a newly added workflow. VS Code Marketplace publication remains manual, and Open VSX uses the separate platform-build workflow.

## Recover an Open VSX publication

If a tag build failed but a later rebuild succeeded, use **Publish Existing VSIX to Open VSX** from `main`. Supply the successful **Build Platform Binaries** run ID and expected extension version. The workflow checks the source run, locks the three artifact IDs, validates the publisher, extension name, version, platform coverage, and server binaries, then publishes those exact packages. Registry credentials are available only to the publishing job.

For the 0.2.15 recovery, the successful rebuild is run `37542533127`. This avoids rebuilding the old tag or changing its commit. The workflow accepts `OVSX_PAT`, `OPEN_VSX_TOKEN`, or `OPENVSX_TOKEN`. Normal future tag builds still publish through **Build Platform Binaries**. VS Code Marketplace publishing remains manual.
