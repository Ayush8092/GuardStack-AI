# Changelog

All notable changes to GuardStack AI are documented here.

## Unreleased

### Security
- Hardened secret masking for inline credentials and sensitive values.
- Added stricter outbound payload validation to prevent unverified or unsafe content from reaching external providers.
- Improved fail-closed behaviour when masking or outbound validation encounters an error.

### Reliability
- Improved Windows Git process-tree cleanup and failure reporting.
- Added bounded memory usage during repository discovery.
- Hardened cache directory identity checks, corruption recovery, and cache integrity validation.
- Improved safe file creation against symbolic-link and directory replacement races.
- Improved cancellation handling and provider cooldown behaviour.

### Analysis and accuracy
- Improved Python parser error classification and evidence in affected findings.
- Reduced false positives in import resolution, unused-code detection, and package entry-point discovery.
- Improved partial-analysis reporting when configuration or repository files cannot be processed.
- Hardened validation against configuration changes that could otherwise hide existing findings.

### Performance and resource limits
- Added discovery time, memory, and entry limits.
- Improved indexing time-budget enforcement and cancellation responsiveness.
- Added bounded syntax-tree processing to reduce resource-exhaustion risks.

### Developer experience
- Improved CLI and MCP diagnostics, validation reporting, and release packaging checks.
- Expanded regression coverage for security, filesystem safety, parser reliability, and Windows behaviour.

## 0.3.0

### Security
- Expanded secret masking for provider tokens, multiline credentials, configuration values, and query-string secrets.
- Added strict outbound validation and improved handling of untrusted model responses.
- Hardened filesystem access, workspace boundaries, and repository-derived prompt content.

### Reliability
- Added explicit partial-analysis and partial-validation reporting.
- Improved baseline reconstruction and configuration-change detection.
- Added provider rate limiting, cooldowns, retries, and fallback handling.
- Improved cancellation handling and bounded repository analysis.
- Added cache integrity checks and safer recovery behaviour.

### Analysis and accuracy
- Improved JavaScript, TypeScript, and Python import resolution and unused-code detection.
- Added scope-aware unused-import analysis.
- Improved duplicate-code classification and confidence reporting.
- Improved parser health reporting and handling of incomplete or invalid source files.
- Added support for additional package exports, workspace configurations, and framework conventions.

### Features
- Added `guardian find` and the `find_reusable_code` MCP tool for locating reusable code.
- Added configurable analysis profiles, entry points, rules, exceptions, and secret-masking options.
- Added explanatory scan output and structured JSON diagnostics.
- Added benchmarks, accuracy fixtures, and package smoke tests.
