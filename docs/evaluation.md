# Evaluation: what was checked, how, and what it does and does not show

Nothing here is a claim of accuracy in general. Seeded defects and hand-written fixtures show that the rules behave as designed on patterns someone thought of; they say little about an arbitrary repository. The real-repository work below is what found the false positives that were fixed in this release.

## Reproducing the real-repository results

Everything in the tables below that is marked automated comes from the scripts in `eval/`. They were run twice from freshly fetched, pinned copies of the repositories, and the two runs produced byte-identical output (`summary.json`, every `*.findings.json` and `compare.json`).

**Repositories, pinned to exact commits** (`eval/repos.json`)

| Repository | Kind | Commit |
| --- | --- | --- |
| expressjs/express | Node.js (JavaScript) | `1c6f1b0fe4000977b9a7b4f34097e4d527dd9824` |
| sindresorhus/got | TypeScript library | `6b5aafc1cd538998728be6f45c65b0f80bae01b2` |
| colinhacks/zod | TypeScript monorepo | `2554b70c3d4a80273381e61d527d820720626440` |
| vercel/next-learn | Next.js | `bb2558441a6673ab76c89914c25018bffa27a2ba` |
| t3-oss/create-t3-turbo | TypeScript monorepo (Turborepo) | `8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee` |
| psf/requests | Python library | `3c7baaa05ab4aa49cc819ce3a819d260de19c157` |
| pallets/click | Python library | `2247b35ea1c47c727d7a06e51fa280e12a863ff6` |

**Tool versions used**

| Tool | Version |
| --- | --- |
| CodeGuardian AI | 0.3.0 (the source tree this file ships in) |
| Node.js / npm | 22.22.2 / 10.9.7 |
| tsx / @vscode/tree-sitter-wasm / better-sqlite3 | 4.23.15 / 0.3.1 / 13.0.3 |
| TypeScript, used only as the unused-import oracle | 5.9.3 |
| Python / pyflakes, the Python oracle | 3.12.3 / 4.1.0 |
| git | 2.43.0 |
| OS | Linux x64 container |

(`package-lock.json` pins the first group; `eval/compare.py` prints the second group into `compare.json` on every run.)

**Exact commands** (from the repository root; needs network access to GitHub, npm and PyPI once)

```bash
npm ci --ignore-scripts
node eval/fetch.mjs eval/repos                         # clone each repository at its pinned commit
node --import tsx eval/analyze.mts eval/repos eval/out # findings and per-rule counts -> eval/out/summary.json
npm install --prefix eval/.tools typescript@5.9.3 --no-audit --no-fund
pip install pyflakes==4.1.0
python3 eval/compare.py eval/repos eval/out eval/.tools/node_modules   # oracle comparisons -> eval/out/compare.json
```

`eval/out/` and `eval/repos/` are ignored by git. If a run differs from the tables here, the commit pins, the tool versions and the analysis source are the three things to compare.

**Result of the two reproduction runs:** identical. Counts per rule match the table in this file exactly.

## How each check was done

| Check | Method | Automated or manual |
| --- | --- | --- |
| Findings counts per rule | `eval/analyze.mts` | Automated (reproducible) |
| Unused imports, TypeScript and JavaScript | `eval/compare.py` against the TypeScript 5.9 compiler (`noUnusedLocals`) on 5 repositories. The compiler pass does not report unused imports in plain `.js` files, so those were checked by hand | Automated, plus manual for `.js` |
| Unused imports, Python | `eval/compare.py` against pyflakes on 2 repositories. Imports in `__init__.py`, imports that another module imports from the same file, and `# noqa` lines are exempt by design, so pyflakes reports more | Automated |
| Duplicate bodies | `eval/compare.py`: the members of every group were re-extracted from the source and compared with a separate script. Of the 4 groups it could not confirm, 2 were diffed by hand and are identical, 1 (`PostCard` in create-t3-turbo) was inconclusive and 1 was not checked | Automated, plus manual |
| Cycles | Every reported cycle was read in the source (not scripted) | Manual, all |
| Unresolved imports | Every reported one was checked against the filesystem (not scripted) | Manual, all |
| Orphan files and dead exports | A grep for other references was used to find findings worth a second look; only the ones listed below were then reviewed by hand | Manual, **a sample only** |
| Similar-structure duplicates, suppression comments | Not reviewed on real repositories | **Not verified** |
| Fixtures | `test/fixtures/projects.ts`: 11 labelled projects (TypeScript, JavaScript, Python), scored per rule by `test/accuracy.test.ts` | Automated |

## Reported counts on real repositories (after the fixes in this release)

| Repository | Language | unused-import | unresolved-import | cycle | orphan-file | dead-export | duplicate-body | similar-structure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| express | JS | 0 | 0 | 0 | 3 | 0 | 0 | 3 |
| got | TS | 0 | 0 | 0 | 6 | 48 | 0 | 0 |
| zod | TS | 2 | 0 | 1 | 116 | 16 | 7 | 29 |
| next-learn | JS/TS (Next.js) | 8 | 7 | 0 | 15 | 20 | 42 | 6 |
| create-t3-turbo | TS (monorepo) | 0 | 0 | 0 | 6 | 8 | 4 | 1 |
| requests | Python | 6 | 0 | 0 | 2 | 14 | 0 | 2 |
| click | Python | 0 | 0 | 1 | 3 | 15 | 0 | 1 |

## Results per check

**Unused imports (full comparison with a compiler or pyflakes).**
- next-learn: 8 reported, 8 confirmed by the compiler, 0 missed.
- got, express, create-t3-turbo: 0 reported, 0 reported by the compiler.
- zod: 2 reported, neither reported by the compiler. Both were confirmed unused by hand (a `.js` file the compiler pass does not cover, and an `_`-prefixed type import the compiler does not flag).
- requests: 6 reported, all 6 also reported by pyflakes, 0 reported by us only. pyflakes reports 36 more (10 in `__init__.py`, the rest imports that other modules import from the same file or lines marked `# noqa`); those are not counted as misses because that is the intended policy, but a few of them were not individually checked.
- click: 0 reported; all 64 pyflakes reports are in `__init__.py` re-exports.
- Totals: 16 reported, 16 confirmed, 0 known false positives, 0 known misses outside the exemptions above. 16 is a small number.

**Cycles.** 2 reported, 2 confirmed by reading the code: zod `core.ts` and `util.ts` import each other at load time; click `_compat.py` and `_winconsole.py` form a cycle only on Windows (the import is inside `if sys.platform.startswith("win")`).

**Unresolved imports.** 7 reported, all in next-learn. The one inspected in detail (`@/app/ui/fonts`) is a real gap: the starter project does not contain that file. The other six were not individually inspected beyond confirming the target paths are absent.

**Duplicate bodies.** 53 groups reported across 3 repositories (zod 7, next-learn 42, create-t3-turbo 4). 49 were confirmed identical by an independent comparison and 2 more by a manual diff. 1 (`PostCard` in create-t3-turbo) is inconclusive and 1 in next-learn was not checked further. Most groups in next-learn are the same tutorial file copied into several step directories.

**Orphan files and dead exports (sample only).** These are the findings most likely to be wrong, because "nobody imports it" says nothing about code loaded by a framework, a build tool, a documentation system or a user of the package.
- Reviewed: express (the 3 orphans are example scripts or files served by path, all reported only as *potentially unused*), the click and requests orphans, and a handful of dead exports.
- Not reviewed: 116 zod orphans, 48 got dead exports, 20 next-learn dead exports, 15 next-learn orphans, and the dead exports in create-t3-turbo, zod and click. These counts say how many were reported, not how many are right.

## False positives found by this process, and fixed

Each has a regression test in `test/real-world-regressions.test.ts` or `test/config-completeness.test.ts`.

| Found in | Problem | Fix |
| --- | --- | --- |
| requests, click | `from . import x` created a cycle through the package `__init__.py` | Importing submodules is not an edge to `__init__` |
| click | `typing` reported unresolved because `tests/typing/` exists | Standard-library names are external |
| requests | `requests.packages.*` (a runtime `sys.modules` alias) reported as broken | Reported as unsupported |
| zod | `@/.source` (a generated directory) reported as broken | Targets in hidden or build directories are unsupported |
| requests | `compat.py` imports that other modules import from it reported as unused | Not reported when another file imports the name |
| requests | `cast("T", x)` and `Callable[["T"], Any]` references reported as unused imports | String type references count as uses |
| create-t3-turbo | Unused import in a generated `routeTree.gen.ts` | Generated files are not checked for unused imports |
| click | 9 example scripts reported as unused; they are `[project.scripts]` entry points | `pyproject.toml` console scripts are entry points |
| click, requests | Public names of importable package modules reported as confidently unused, although callers reach them as `package.module.name` | Reported as potentially unused, low confidence |
| express | `module.exports = User` required as a variable reported as an unused default export | Using any member of a required value uses its default export |

## Known false negatives and open questions

- A group of dead files that only import each other has an importer each, so none is reported (`knownMisses` in the fixtures, 2 files).
- Python dead exports in library packages are downgraded to *potentially unused* on purpose; some of them are truly dead.
- Seeded-defect check (a throwaway experiment, not part of the test suite): an unused import, a broken import, a two-file cycle, a copied function body, an orphan and a dead export were added to copies of 6 repositories and all were detected. That shows the rules fire on obvious cases and nothing more; two of my first seeds were themselves wrong.
- Retrieval: 15 of 17 labelled natural-language queries returned the wanted symbol on real repositories (11 first, 14 in the top three).

## Fixture scores

Run `npm test -- --test-name-pattern accuracy` to see them. At the time of writing, per rule: circular-dependency 4 TP, dead-export 6 TP, duplicate-body 1 TP, orphan-file 10 TP and 2 documented misses, similar-structure 2 TP, unused-import 8 TP, suppression 1 TP; 0 false positives. The labels for the last five fixtures were written before running the analysis, then corrected in five places where my label, not the tool, was wrong (a wrong key separator, constants and orphans I forgot to list, bodies below the 120-character comparison minimum). The corrected labels are the file's current contents, so there is no record of the first versions.
