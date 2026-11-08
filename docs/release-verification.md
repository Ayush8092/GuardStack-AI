# Release verification

This file describes the tree it ships in. Every PASS is a command that was executed on this tree. NOT RUN means the command was not executed. Nothing is carried over from an earlier revision.

## Release classification: NOT READY

Not because a known defect remains, but because the checks that decide a release have **not been run**: the sandbox this revision was prepared in has no network access, so `npm ci` cannot install the project's dependencies (Tree-sitter, SQLite, zod, the MCP SDK, the AI SDKs, `ignore`). Without them the project typecheck, `npm test`, `npm run build`, `node bin/cli.js doctor`, `node scripts/pack-smoke.mjs`, both real Tree-sitter test files, the MCP transport tests and benchmark, and the six-job CI matrix could not run. They must run, and pass, before release. Do not read the sections below as a substitute for them.

## What was run, and with what

Linux x64 container (1 vCPU), Node v22.23.4, global TypeScript 6.0.3 (the project pins `typescript ^7.0.2`), `npm ci` failing for lack of network.

Tests ran with Node's built-in type stripping and a loader that substitutes the packages that could not be installed. The discovery and race tests use the **real file system and real discovery code** (no substitute for either). The rest use stand-ins:

| Stand-in | Used for | Cannot show |
| --- | --- | --- |
| a regex "parser" instead of Tree-sitter | the indexer's flow: limits, deadline, cancellation, cache, completeness | anything about real grammar output |
| `node:sqlite` behind the `better-sqlite3` API | the cache | real `better-sqlite3` behaviour |
| a minimal gitignore matcher instead of `ignore` | ignore rules | exact `ignore` semantics |
| a no-op instead of `zod`, stubs for the AI SDKs | importing `refiner.ts` and `config.ts` in local mode | schema validation of model replies and of `.guardianrc` |

| Check | Result |
| --- | --- |
| `test/discovery-races.test.ts` (new, real file system: a directory replaced by an external link at three different moments, a replacement that is undone, a removed directory; failed `lstat` with EACCES, EIO and ENOENT; a file replaced by a link or a directory; unknown-type entries; an unopenable directory) | 12 of 12 pass; 10 of them fail on the previous `discovery.ts` |
| `test/discovery-entry-types.test.ts`, `test/limits.test.ts` | 8 of 8 and 18 of 18 pass |
| `test/index-deadline.test.ts` (cold cache, warm cache, no confident absence finding after an interruption, convergence, preparation counted against the budget) | 6 of 6 pass (stub parser); the preparation test fails when the clock is started after the cache load |
| `test/index-limits.test.ts` | 10 of 10 pass (stub parser) |
| `test/parse-health.test.ts` (fake trees, Python method scope) | 26 of 26 pass |
| `test/prompt-injection-local.test.ts` (final `optimize_prompt` output, codebase map, find output, one invisible-character definition), `test/untrusted.test.ts` | 5 of 5 and 13 of 13 pass; the local tests fail when the local escaping is weakened |
| `test/masker.test.ts`, `test/redos.test.ts`, `test/version-sync.test.ts` | 8, 14 and 1 pass. `package.json`, `package-lock.json` and its root entry all say 0.3.0 |
| All 41 original test files run against the user's previous tree and this tree under the same stand-ins | the set of failing tests is identical for every file (those failures are limits of the stand-ins): no regression was visible |
| `bench/discovery.ts`, 20000 files, 5 runs, this tree | tree layout: synchronous walk median 98 ms total with a 98.7 ms event-loop stall; yielding walk 433 ms total with a 7.1 ms stall; with `maxEntries=5000` 91 ms and 4.1 ms. Flat layout: 78 ms / 78.5 ms stall against 141 ms / 19.5 ms stall |
| the same benchmark on the previous tree | tree layout: yielding walk 261 ms total, 8.1 ms stall; so the directory-race checks cost about 170 ms over 9000 directories (about 20 microseconds each) and do not change the stall. Flat layout unchanged (141 ms against 136 ms). One vCPU, one machine, five runs: indicative only |
| `tsc --noEmit -p tsconfig.json` (global TypeScript 6.0.3) | **not clean, for environment reasons only**: `TS2307` (cannot find module) and the implicit-`any` errors that follow from the missing packages. No error in `discovery.ts`, `indexer.ts`, `health.ts`, `untrusted.ts`, `text.ts`, `compressor.ts`, `refiner.ts` or `find.ts` other than those consequences. This is **not** the project typecheck |

## Revision note: Python parser follow-up

This revision changes `src/core/ast/health.ts` (a structural check for Python: empty function and class bodies, trailing commas in unparenthesized imports) and `src/core/ast/analysis.ts` (syntax-error details in the evidence of `orphan-file`, `dead-export` and `unused-import`). The tables above describe the revision before this change; they are carried over only for files this change cannot affect (discovery, the indexer, the prompt builders), and none of those files was edited here.

Executed on this tree after the change (Linux x64, Node v22.23.4, real `zod`, `ignore`, `commander` and `smol-toml` from the sandbox's global package set, which are not the versions in `package-lock.json`; no stand-in for any of them in these runs):

| Check | Result |
| --- | --- |
| `test/parse-health.test.ts` | 36 of 36 pass (the 10 new Python and JavaScript/TypeScript cases included; 7 of them fail against the previous `health.ts`) |
| `test/syntax-evidence.test.ts` (new) | 7 of 7 pass (6 of them fail against the previous `analysis.ts`) |
| `test/limits.test.ts`, `test/untrusted.test.ts`, `test/masker.test.ts`, `test/redos.test.ts`, `test/pyproject-reader.test.ts`, `test/repo-hygiene.test.ts`, `test/version-sync.test.ts` | pass; 102 tests in the nine files together, 0 failures |
| TypeScript check of the edited files against hand-written stand-in typings | no errors in `health.ts` or in the new tests; two implicit-`any` messages in `analysis.ts` come from the stand-in for the config type, not from the code. This is **not** `npm run typecheck`. |

**Not run for this change:** the 8 new real Tree-sitter cases in `test/parse-health-treesitter.test.ts`. They are written, but whether the bundled Python grammar really produces an empty block for `def f():` and a trailing `,` token as the last child of an unparenthesized import is the assumption the whole check rests on, and it is unverified until those tests run. If the real tree differs, those tests (not the fake-tree ones) will show it. `hasEmptyBody` also assumes the suite is the `body` field of `function_definition` / `class_definition`, and `endsWithComma` that the comma is a direct child token of the import statement.

## NOT RUN

- `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, `npm run build`, `node bin/cli.js doctor`, `node scripts/pack-smoke.mjs`, npm packaging and installation of the tarball.
- Real Tree-sitter tests: `test/parse-health-treesitter.test.ts` (including the new Python method-scope, empty-body and trailing-comma cases), `test/parser-reliability.test.ts`, `test/tree-sitter-api.test.ts`. The fake-tree tests prove the classification logic; whether Tree-sitter really produces those tree shapes is unverified, and any real grammar failure would need a fix in `health.ts` or `extract-py.ts`.
- All MCP checks: `test/mcp-transport.test.ts`, `test/hardening.test.ts`, tool listing and argument validation, concurrency, responsiveness during a scan, protocol-level cancellation and the request that follows it, stdio start-up in a separate process, and `bench/mcp.ts` (no median, p95 or event-loop figures exist for the transport; `bench/discovery.ts` above is an internal function benchmark, not a transport measurement).
- The six-job CI matrix (Ubuntu, macOS, Windows; Node 22 and 24). Nothing was run on macOS or Windows, and the directory-race protection differs there (README, "Directory races").
- `test/model-validation.test.ts`, `test/security-p1.test.ts`, `test/outbound.test.ts`, and every other file that needs real zod, the AI SDKs, Tree-sitter or the MCP SDK.
- A file system that really reports unknown entry types: those tests make the Dirent predicates answer false for chosen names.

## How to verify this revision

```
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node bin/cli.js doctor
node scripts/pack-smoke.mjs
npm run bench
npm run bench:mcp
```

Run the six-job CI workflow. Expect these existing assertions to differ from the earlier revision on purpose (CHANGELOG): `test/limits.test.ts` (`entries` equals the limit), `test/parse-health.test.ts` (a swallowed sibling method is `degraded`), `test/index-limits.test.ts` (the convergence test ends with a normal-budget call).

## Known limitations

- Prompt-injection protection is structural and reduces the risk; it does not eliminate it. A model can still be influenced by what a string means.
- A directory replaced and restored inside the open window cannot be detected on macOS and Windows (Linux reads from the verified descriptor).
- `maxIndexMs` is a hard bound on starting work, not on finishing it: one read or one parse that has begun runs to the end. A warm scan whose cached files take longer than the limit to re-hash cannot finish in one call.
