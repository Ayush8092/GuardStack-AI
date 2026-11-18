# Release verification

This file separates verification of the current working revision from the historical audit of the original source archive. A PASS means the stated command was executed and its result observed on the stated tree and platform. Historical results are not evidence for the current revision.

## Current revision status: Windows and cross-platform CI verified

The current revision was verified on Windows x64 with Node.js v24.16.0 and npm 11.13.0. The six-job GitHub Actions matrix also passed across Ubuntu, macOS and Windows with Node.js 22 and 24. This provides CI evidence across those operating systems and Node.js versions; local packaging and process-safety verification was performed on Windows x64.

| Check | Command | Platform / Node | Result |
| --- | --- | --- | --- |
| Typecheck | `npm.cmd run typecheck` | Windows x64, Node 24.16.0 | PASS |
| Build | `npm.cmd run build` | Windows x64, Node 24.16.0 | PASS |
| Distribution integrity | `npm.cmd run verify:dist` | Windows x64, Node 24.16.0 | PASS |
| Doctor | `npm.cmd run doctor` | Windows x64, Node 24.16.0 | PASS |
| Full test suite | `npm.cmd test` | Windows x64, Node 24.16.0 | PASS; 1,005 tests, 953 passed, 0 failed, 52 skipped |
| Packaging smoke test | `npm.cmd run pack:smoke` | Windows x64, Node 24.16.0 | PASS; package contents, clean install, CLI, MCP stdio lifecycle, process cleanup and global installation verified |
| Dependency security audit | `npm.cmd audit` | Windows x64, Node 24.16.0 | PASS; 0 vulnerabilities |
| GitHub Actions matrix | Ubuntu, macOS and Windows; Node 22 and 24 | GitHub Actions | PASS; all six jobs |

The 52 skipped tests are reported as skipped, not passed. Platform-specific and capability-dependent tests must be assessed from their individual results. The Windows-specific process-safety test file was also run separately and passed 11/11.

The verified source revision is commit `612ce4c`. The verification document itself is being updated separately.

## Historical integration audit of the original source archive

The following section records the earlier partial audit of the source archive on Linux with Node 22.23.4. Its installation failure, stale distribution finding and coverage limitations describe that archive and that audit only. They do **not** describe the current Windows verification above.
| Check | Command | Platform / Node | Result |
| --- | --- | --- | --- |
| Install | `npm ci --ignore-scripts` | Linux, Node v22.23.4 | FAILED (no network): dependencies not installed |
| Dist integrity of the archive | `node scripts/dist-integrity.mjs verify` | Linux, Node v22.23.4 | FAILED, as it must: the archive's `dist/` has a version 1 manifest and this tool reads version 2. `dist/` is stale and must be rebuilt (`npm run build`), never shipped as found |
| Tests that import no third-party package (`cache-key-read`, `masker`, `redos`, `git-config-guard`, `windows-evidence`, `limits`, `untrusted`, `audit-hardening`, `version-sync`) plus the new `integration-audit` | `tsx --test <files>` (tsx 4.23.12) | Linux, Node v22.23.4, root | 93 passed, 0 failed, 0 skipped. `test/scope.test.ts` was also started and could not load (`@vscode/tree-sitter-wasm` is not installed): that is a missing dependency, not a test result |
| New regression tests against the original sources | `tsx --test test/integration-audit.test.ts` | Linux, Node v22.23.4 | 6 of 7 fail on the original code and 7 of 7 pass on the fixed code (the seventh guards against an over-broad check) |

Not covered by the initial archive audit: Windows, macOS, Node 24, the six-job CI matrix, the packaged tarball, the installed CLI, the stdio handshake and process cleanup after shutdown. Several of these are covered by the current Windows verification above.

Defects found by reading the code, and fixed:

1. `src/core/security/safe-file.ts`: the result of `fs.writeSync` was ignored in `createFileExclusive` and `appendToRegularFile`. A short write (full disk, quota) left an incomplete file that was reported as created or appended. The data is now written in full through `writeAll`, and an incomplete write fails with `UnsafeFileError`; a file this call created is discarded as for any other failure. An append that fails part-way cannot be rolled back (the file was opened for appending), so the error is the only signal there.
2. `src/db/cache-key.ts`: the "key directory is inside the workspace" check used `rel.startsWith('..')`, which also matched a child directory whose name begins with two dots (`<workspace>/..state`), so such a directory was not recognised as inside the workspace. It now tests for a real parent step only. Exposure was small (the directory comes from `GUARDIAN_STATE_HOME`, which a repository does not control), but the check exists precisely to keep the key out of a workspace.

New tests: `test/integration-audit.test.ts`.

Read and found no defect (static inspection only, not a guarantee): `src/core/git/git.ts`, `src/core/security/sandbox.ts`, `src/db/client.ts`, `src/core/ast/discovery.ts`, `src/utils/config.ts`, `src/index.ts`, `src/mcp/**`, `scripts/dist-integrity.mjs`, `scripts/mcp-stdio-smoke.mjs`, the first 120 lines of `src/core/security/masker.ts`. Not read in this audit: the rest of the masker, `src/db/schema-check.ts`, `src/db/windows-acl.ts`, the indexer, the model provider and prompt modules, the CLI commands and `scripts/pack-smoke.mjs`.

## Changes since the historical Linux full run

Cache directory identity binding, identity-verified corruption recovery and signed cache results (`src/db/client.ts`, `src/db/cache-key.ts`, `src/core/ast/cached-info.ts`); `.gitignore` read failures reported as a partial scan (`src/core/ast/indexer.ts`); whole-tree termination of Git processes on Windows (`src/core/git/git.ts`); stale-`dist` checks in `scripts/pack-smoke.mjs`; a deterministic clock in `test/index-deadline.test.ts`; README and this file. New tests: `test/cache-state-dir.test.ts`, `test/cache-integrity.test.ts`, `test/gitignore-problems.test.ts`, `test/process-safety-windows.test.ts`.

## Verified commit

| Item | Value |
| --- | --- |
| Commit SHA | `612ce4c` — source revision verified. The release-verification document updates are not included in this commit. |
| Version | `0.3.0` in `package.json` (`test/version-sync.test.ts` passed in the current Windows full test run above) |

## Environment

On the previous revision: Linux x86_64 container, Node v22.23.4, npm 10.9.9, TypeScript 7.0.2 (the version the project pins, installed by `npm ci`). The full run below was made as uid 0 (root). A second, partial run of four test files was made as uid 65534 (see "Skipped tests").

In this container a plain `npm ci` fails while compiling `better-sqlite3` (node-gyp cannot download Node headers; no network to nodejs.org), so the install used `npm ci --ignore-scripts` and `better-sqlite3` ran from its bundled prebuilt `linux-x64` binary. That is the same install the CI workflow uses.

## Executed on the previous revision (not this tree)

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci --ignore-scripts` | PASS (exit 0) |
| Typecheck | `npm run typecheck` | PASS (exit 0, no diagnostics) |
| Full test suite | `npm test` | PASS on the second of two runs (exit 0): 647 tests, 646 passed, 0 failed, 0 cancelled, 1 skipped. The first run failed one test, `test/index-deadline.test.ts` "repeated calls with a small budget progressively populate the cache" (see "Flaky test" below). |
| Provider tests alone | `node --import tsx --test test/provider-limits.test.ts test/provider-resilience.test.ts test/llm.test.ts` | PASS: 27 tests, 27 passed |
| Filesystem race tests alone | `node --import tsx --test test/create-exclusive.test.ts test/create-hardlink-publish.test.ts` | PASS: 18 tests in `create-exclusive` and 21 in `create-hardlink-publish`, all passed |
| Policy downgrade tests alone | `node --import tsx --test test/policy-downgrade.test.ts test/config-downgrade-settings.test.ts` | PASS: 20 tests, 20 passed |
| Five files as a non-root user | `setpriv --reuid=65534 ... node --import tsx --test test/hardening.test.ts test/create-exclusive.test.ts test/create-hardlink-publish.test.ts test/hardlink.test.ts test/init-symlink.test.ts` | PASS: 77 tests, 77 passed, 0 skipped |
| Build | `npm run build` | PASS (exit 0) |
| Doctor | `node bin/cli.js doctor` | PASS (exit 0): Node, better-sqlite3, Tree-sitter grammars and Git all reported ok |
| Packaging smoke test | `node scripts/pack-smoke.mjs` | PASS (exit 0): tarball contents, clean install, global install, installed CLI `doctor`, `scan`, `find` and usage-error exit code 2 |

The previous revision's full suite had 626 tests; the difference of 21 is the new `test/create-hardlink-publish.test.ts`.

### Previously flaky test (fix verified on current Windows run)

`test/index-deadline.test.ts` "repeated calls with a small budget progressively populate the cache, and a later call completes" used a real 4 ms indexing budget and failed intermittently (1 of 2 full runs, 2 of 12 isolated runs on the previous revision). Two causes: the outcome depended on how fast the machine was, and the loop broke out on the call that completed the scan before recording that call's cache size, so `last` stayed below 80 whenever the final call finished inside 4 ms. The fix was subsequently exercised in the current Windows full test run, which passed with zero failures. The test now drives `performance.now()` with a controlled clock (every reading costs 1 ms, budget 4 ms), records the cache size before it stops, and the "preparation counts against maxIndexMs" test moves the same controlled clock instead of spinning for 400 ms. The assertions are unchanged in strength (a new one checks that the budget really was too small for one call). The fix passed in the current Windows full test run.

The real Tree-sitter, SQLite, Git and MCP transport tests are part of the 647 and ran against the real dependencies. Every test ran on Linux only. The Windows file-creation strategy (`createFileByHardLink`) ran on Linux, directly and through a `process.platform` override; it was **not** run on Windows or macOS by this verification.

## Skipped tests

One test is skipped, by its own condition: `falls back to memory in a read-only workspace` (`test/hardening.test.ts`) is skipped on Windows and when the process runs as root, because root can write to a read-only directory. The full run was made as root, so in that run **the test was skipped**. It was then run on its own as uid 65534 (together with three other files, 56 tests) and passed there; that is one Linux run, not a Windows or macOS result.

## Additional checks not run on the current revision

| Check | Command | Status |
| --- | --- | --- |
| Benchmarks | `npm run bench`, `npm run bench:mcp` | NOT RUN in this verification; not part of the release gate. CHANGELOG figures are from earlier runs. |
| `eval/` accuracy harness | `eval/` | NOT RUN; needs network access to fetch repositories. |

The current Windows full-suite result is 1,005 tests: 953 passed, 0 failed and 52 skipped. The skipped tests remain skipped; their status must not be represented as passing. The Windows-specific process-safety test file was also run separately and passed 11/11. The cache, integrity and `.gitignore` regression tests were included in the full test run.
## Generated reports

`test-report.txt` and `test-report-tap.txt` were captured output of an earlier run of an unrecorded tree on an unrecorded platform. They are not evidence for this revision and were removed from the project; they are generated files, excluded from the repository (`.gitignore`) and from the package. Regenerate them only from a run of the exact revision being released.

## How to repeat this verification

```
git rev-parse HEAD          # record this SHA here
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node bin/cli.js doctor
node scripts/pack-smoke.mjs
```

Then run the six-job CI workflow and record, per job, the result and the Node version.

## Known limitations


- Prompt-injection protection is structural and reduces the risk; it does not eliminate it. A model can still be influenced by what a string means.
- A directory replaced and restored inside the open window cannot be detected on macOS and Windows (Linux reads from the verified descriptor).
- `maxIndexMs` is a hard bound on starting work, not on finishing it: one read or one parse that has begun runs to the end. A warm scan whose cached files take longer than the limit to re-hash cannot finish in one call.
- AST budgets (750,000 nodes, depth 1,000) bound call-stack use and the work of every pass, not wall-clock time. The parse of one file is synchronous and cannot be interrupted; no worker-thread isolation was added.
- Cancellation stops Git child processes and the work between files. The small configuration reads of baseline reconstruction use synchronous Git calls that are bounded by a 20 s timeout and are checked for cancellation before and after, not during.
- The provider cooldowns are per process and kept in memory; a new process starts without them.
- Configuration downgrades (`src/core/validation/policy.ts`) are detected for: rules turned `off`, a configured severity lowered, `ignore`, `exceptions`, `entryPoints`, files that were analysed at the base and no longer are, `profile`, `pythonRoots`, and weakened outbound protection (`strictOutbound` turned off, `maskPatterns` or `maskLiterals` removed). The exact rules for the last two settings that change what is analysed:
  - `profile`: any change to a value other than `none` is reported as `profile-changed`. Moving to `none` is not (it only removes entry points). It is not recomputed which files the new profile covers: every vanished `orphan-file` and `dead-export` finding is kept out of "fixed" while the profile change stands.
  - `pythonRoots`: only a root that was not there before is reported (`python-roots-added`), compared after normalising `./src/`, `src` and `.`/`""`. Removing a root, or respelling one, is not reported. Vanished `unresolved-import`, `orphan-file` and `dead-export` findings in `.py`/`.pyi` files are kept out of "fixed".
  - If either side has no value for the setting (a view built from an older shape), nothing is reported for it.
  - Test coverage: `test/policy-downgrade.test.ts` covers both settings at unit level. `test/config-downgrade-settings.test.ts` covers `profile` end to end through git and the `--config-policy` exit codes; for `pythonRoots` its only end-to-end case is the unchanged one, so an added root is verified at unit level only.
- Cache contents (`src/db/client.ts`, `src/db/cache-key.ts`, `src/core/ast/cached-info.ts`): a result in `.guardian/cache.db` is used only if its signature verifies. Each stored result is signed (HMAC-SHA256 over its path, content hash and text) with a 32-byte key kept in a per-user directory outside the workspace (`%LOCALAPPDATA%\guardian`, `~/Library/Application Support/guardian`, `$XDG_STATE_HOME/guardian`, or `GUARDIAN_STATE_HOME`), created exclusively with owner-only permissions; a key directory inside the workspace, a symlinked, hard-linked, wrongly owned or malformed key file is refused, and without a key the cache stays in memory. A database shipped in a repository therefore cannot supply results, and a result copied to another path, edited, or paired with other content does not verify. A database with triggers, views, extra indexes or a different `files`/`usage` layout is replaced. After the signature, every nested field of a result is type-checked before reuse. Limits: the key protects against a repository, not against another process running as the same user, which can read the key; the `usage` table (token statistics) is not signed and only affects displayed totals; the key is per machine, so a copied cache is rebuilt.
- Cache directory and recovery (`src/db/client.ts`): the `.guardian` directory is bound by identity (device and inode, not a symlink) and every later step re-proves it; creation, opening and deletion fall back to an in-memory cache when it differs. On Linux the directory is held open and recovery deletes through that descriptor. Corruption recovery deletes `cache.db` and the sidecars only after proving the directory and the file are the ones that were verified, and never a symlink, a hard-linked file or a different file. SQLite itself opens `cache.db` and its sidecars by path and Node has no `openat`, so a swap in the instant between the last check and SQLite's open is detected before SQLite writes where the order allows (it is checked after the open and after the journal-mode change) but cannot be excluded; on every platform other than Linux the delete is also path-based after verification. Inode numbers can be reused after a delete, so a file removed and recreated may keep the same identity.
- Filesystem writes (`src/core/security/safe-file.ts`): `createFileExclusive` and `appendToRegularFile` verify, around the write, that the descriptor is still the file the path names, that it has one hard link, and that the directory has the same realpath and the same device and inode. They are before-and-after comparisons, not atomic: Node has no `openat`/`linkat`/`unlinkat`, so a swap in the final instant after the last check, or a swap that is undone between two checks, is not detected. A created file is removed on failure only while the path still names the inode this call created; the unlink goes by path, so a swap between that check and the unlink is a remaining window.
- Windows file creation: on Windows `O_NOFOLLOW` does not exist and `O_CREAT|O_EXCL` follows a dangling symlink and creates its target (confirmed on Windows with Node v24.16.0). `createFileExclusive` therefore never opens the destination there. It creates the file in a private `.guardian-stage-*` directory inside the destination directory (same volume) and publishes it with `fs.linkSync`, which fails with `EEXIST` for any existing entry, a dangling symlink included. Limits that remain: publication is path based, so a swap in the instant between the last check and `linkSync` is not excluded and is only detected afterwards; if the directory is renamed away between staging and publication, the staging directory moves with it and is left there (nothing is created at the destination); a staged name or directory that cannot be removed (a handle held by an antivirus or indexer) can leave an empty `.guardian-stage-*` directory, and a staged name that cannot be unlinked fails the creation closed through the link-count check; a file system without hard links (FAT, exFAT, some network shares) makes creation fail with an `UnsafeFileError`; an empty file exists at the destination between publication and the write, as it does on POSIX. The Windows hard-link publication path was exercised in the current Windows x64 / Node 24.16.0 verification. This does not establish behaviour on every Windows filesystem. File systems that report inode 0 or reuse inode numbers can make two directories look identical.
- `.gitignore`: a missing file is normal; one that exists but cannot be applied (unreadable, a symlink out of the workspace, a hard link, not a regular file, over 256 KB) makes the scan partial and is listed as a configuration problem. Its rules are then not applied, so files it would have excluded are analysed.
- Windows process shutdown: `terminateGitChildren()` and a cancelled request end the Git process tree with `taskkill /T /F` (System32) and report the cleanup as terminated only when taskkill succeeded and the launcher is gone; otherwise it is reported as degraded (only the launcher is killed). Git processes that were already detached, or Git helpers on POSIX (only the Git process itself receives SIGTERM there), are not tracked. The Windows-specific process-safety test file passed 11/11 on Windows x64 with Node 24.16.0. The Linux and macOS CI jobs passed, but this does not establish cleanup of already-detached Git helpers or guarantee every possible POSIX process-tree scenario.
