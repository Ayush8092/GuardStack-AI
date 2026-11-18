# Security Policy

## Supported Versions

Security fixes are prioritized for the latest released version of GuardStack AI.

The `main` branch may contain unreleased changes. Users should update to the latest release when security fixes become available.

## Reporting a Vulnerability

Please report suspected security vulnerabilities through GitHub's **Private Vulnerability Reporting** feature:

https://github.com/Ayush8092/GuardStack-AI/security/advisories/new

Do not report undisclosed vulnerabilities through public GitHub issues, pull requests, or discussions.

If private vulnerability reporting is unavailable, open a public issue requesting a private reporting channel. Do not include exploit details, credentials, tokens, or other sensitive information in that issue.

## What to Include

When reporting a vulnerability, include:

- A description of the affected component and potential impact.
- The affected GuardStack AI version, operating system, and Node.js version.
- Reproduction steps or a minimal proof of concept.
- Any relevant logs or error messages, with secrets and personal information removed.
- Whether the issue requires specific configuration, permissions, or user interaction.

Please avoid including real API keys, access tokens, private source code, or other sensitive data in reports.

## Scope

Examples of security issues worth reporting include:

- Workspace path traversal or unauthorized file access.
- Symlink or hard-link handling that allows operations outside the selected workspace.
- Exposure of secrets or sensitive workspace content through logs, cache files, or outbound LLM requests.
- Unsafe command or process execution.
- MCP or CLI input handling that enables unintended access or execution.
- Cache integrity failures that allow untrusted data to be treated as verified results.
- Vulnerabilities in dependencies that materially affect GuardStack AI.

## Security Design Limitations

GuardStack AI is a local-first code analysis and context tool. Its security controls reduce risk but do not guarantee detection of every malicious instruction, secret, or unsafe code pattern.

It does not intercept or control the actions of an AI coding assistant, and it is not a replacement for operating-system isolation, access controls, or independent security review.

Prompt-injection findings or static-analysis inaccuracies alone are not necessarily security vulnerabilities. Reports should demonstrate a concrete security impact or a meaningful bypass of an implemented security control.

## Disclosure

Please allow the maintainers reasonable time to investigate and address a reported vulnerability before publicly disclosing technical details.

There is currently no formal bug-bounty program or guaranteed response-time commitment.
