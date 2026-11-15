# CodeGuardian AI: final integration audit (cg_14_09)

## 1. Executive assessment

**Conclusion: Not ready for release.**

The required verification could not be performed. The archive has no `node_modules` and the audit environment has no network, so `npm ci` failed. No typecheck, full test suite, build, `npm pack`, installed-package run or packaged stdio handshake was executed. No Windows, macOS or Node 24 result exists. What was done: a static review of the security-critical code, `scripts/dist-integrity.mjs` run for real, and a partial test run (tests that import no third-party package). Two real defects were found and fixed, with regression tests that fail on the original code.

The code is in good shape where it was read. I found no fail-open path, no unbounded read and no TOCTOU hole beyond the limits the code already documents. That is a statement about the files listed in section 9, not about the whole product.

## 2. Security issues found (all from actual code)

| # | File | Issue | Severity |
|---|------|-------|----------|
| 1 | `src/core/security/safe-file.ts` | `fs.writeSync` return value ignored in `createFileExclusive` and `appendToRegularFile`. A short write (full disk, quota) left an incomplete file reported as created or appended. | Low to medium (partial operation reported as success) |
| 2 | `src/db/cache-key.ts` | The "key directory is inside the workspace" check used `rel.startsWith('..')`, so `<workspace>/..state` was not recognised as inside. | Low (the directory comes from `GUARDIAN_STATE_HOME`, not from a repository) |
| 3 | archive `dist/` | `dist/build-manifest.json` is version 1; `node scripts/dist-integrity.mjs verify` fails. The shipped `dist/` is stale. | Release blocker (process, not code) |
| 4 | `test-report*.txt` | Stale reports of an unrecorded tree and platform. | Documentation integrity |
| 5 | `release-verification.md` vs `docs/release-verification.md` | The two copies differed in the last bullet (the root one had the older, less accurate wording). | Documentation integrity |

## 3. Issues fixed

1 and 2 in code, 5 by making both copies identical, and 4 by removing the reports (see section 4). Item 3 needs a rebuild, which this environment could not do.

## 4. Files changed (zip contains only these)

- `src/core/security/safe-file.ts`: new `writeAll` loop; an incomplete write throws `UnsafeFileError` and a created file is discarded as before.
- `src/db/cache-key.ts`: `inside()` now tests for a real parent step.
- `test/integration-audit.test.ts`: new.
- `release-verification.md` and `docs/release-verification.md`: audit section added, generated-reports paragraph updated, copies made identical.

**Delete these from your tree** (a zip cannot carry a deletion): `test-report.txt`, `test-report-tap.txt`. They are already git-ignored. Do not ship the archive's `dist/`; run `npm run build`.

## 5. Regression tests added

`test/integration-audit.test.ts` (7 tests): short writes across `createFileExclusive` and `appendToRegularFile`, multi-byte text, zero-byte writes (file removed, error raised), key directory named `..state` inside the workspace, and a guard that a sibling key directory is still accepted. Against the original sources 6 of 7 fail; against the fixed sources 7 of 7 pass.

## 6. Verification commands actually run

| Command | Platform / Node | Result |
|---|---|---|
| `npm ci --ignore-scripts` | Linux, v22.23.4 | Failed (no network) |
| `node scripts/dist-integrity.mjs verify` | Linux, v22.23.4 | Failed: manifest version 1, tool reads 2 (stale `dist/`) |
| `tsx --test` on `cache-key-read`, `masker`, `redos`, `git-config-guard`, `windows-evidence` (before the fix) | Linux, v22.23.4 | 50 pass, 0 fail, 0 skipped |
| `tsx --test` on those five plus `limits`, `untrusted`, `audit-hardening`, `version-sync`, `integration-audit` (after the fix) | Linux, v22.23.4 | 93 pass, 0 fail, 0 skipped |
| `tsx --test test/scope.test.ts` | Linux, v22.23.4 | Could not load: `@vscode/tree-sitter-wasm` not installed (environment, not a test result) |
| `tsx --test test/integration-audit.test.ts` on the original sources | Linux, v22.23.4 | 1 pass, 6 fail (as intended) |

## 7. Test results

Only the rows above exist. The full suite (about 650 tests) was **not run**. Do not read the 93 as a suite result: it covers 10 of 90 test files.

## 8. Platform coverage

Linux, Node 22.23.4, as root, partial. Windows, macOS, Node 24, the six-job CI matrix: **not run**. The Windows process-tree and ACL tests remain unobserved.

## 9. Remaining known limitations and unreviewed areas

Read, no defect found (static): `git.ts`, `sandbox.ts`, `client.ts`, `discovery.ts`, `config.ts`, `src/index.ts`, `src/mcp/**`, `dist-integrity.mjs`, `mcp-stdio-smoke.mjs`, first 120 lines of `masker.ts`.
**Not reviewed:** rest of the masker, `schema-check.ts`, `windows-acl.ts`, the indexer, provider and prompt modules, CLI commands, `pack-smoke.mjs`.

Observations, not defects: the stdio smoke script is well built (real child process, JSON-RPC line classification, exit code 0 on stdin close, process-table check for survivors), but it has never been run here. A failed append cannot be rolled back, so the error is the only signal. The limitations already documented in `release-verification.md` stand.

## 10. Release readiness and what you must run

**Not ready for release.** On a networked machine, on the exact final tree:

```
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run verify:dist
node bin/cli.js doctor
node scripts/pack-smoke.mjs      # npm pack, clean install, installed CLI, real stdio handshake, shutdown, child-process check
```

Then run the six-job CI workflow and record per job the counts, skips and Node version. Regenerate `test-report*.txt` only from that run, or leave them out.
