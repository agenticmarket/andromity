# Security Policy

Andromity runs code, edits files and calls model providers on your behalf, so we treat security reports as our highest priority.

## Supported versions

Security fixes are released for the latest published version of each package:

| Package | Supported |
|---|---|
| VS Code extension (`agenticmarket.andromity-agent`, Marketplace and Open VSX) | Latest release |
| Python package (`andromity` on PyPI), CLI and TUI | Latest release |
| Docker image | Latest tag |

Please upgrade to the latest version before reporting, and tell us if the issue is also present there.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report privately in either of these ways:

1. **GitHub private vulnerability reporting:** open the repository's **Security** tab and choose **Report a vulnerability**.
2. **Email:** hello@agenticmarket.dev with the subject line `SECURITY`.

Include as much of the following as you can:

- The affected component and version (extension, CLI/TUI, Python package, Docker image, or one of the hosted services below).
- Steps to reproduce, a proof of concept, or the request and response involved.
- The impact you observed or expect.
- Whether the issue is already public or known to others.

## What to expect

- We acknowledge your report within **3 business days**.
- We send an initial assessment, including whether we can reproduce it, within **7 days**.
- We keep you updated until it is fixed, agree a disclosure date with you, and credit you in the release notes unless you prefer otherwise.

## Scope

In scope:

- The code in this repository: the agent core, CLI, TUI, VS Code extension, telemetry worker and GitHub Action.
- Andromity's hosted services: `gateway.agenticmarket.dev`, `telemetry.agenticmarket.dev`, and account sign-in on `agenticmarket.dev`.
- Ways the agent can be made to act outside its trust and permission controls: folder trust, permission modes, profiles and air-gap mode.

Out of scope:

- Denial-of-service and volumetric testing, spam, and social engineering.
- Vulnerabilities in third-party model providers, MCP servers or tools that you connect yourself; please report those to their maintainers.
- Findings that require an already-compromised machine or an account you control.

## Testing guidelines

- Test only against your own accounts and data. Never access, change or delete other people's data.
- Do not degrade the hosted services for other users.
- Stop and report as soon as you have shown the issue; do not keep or share data you encounter.

We will not take legal action against research done in good faith under these guidelines.
