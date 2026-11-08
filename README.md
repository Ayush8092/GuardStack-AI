# CodeGuardian AI

A local MCP server and CLI that tells your AI coding assistant what already exists in your codebase, so it reuses code instead of duplicating it, and then checks what the assistant changed. It parses the project with tree-sitter, caches results in SQLite, and hands the assistant a compact, secret-free map before it writes anything.

## Setup

Requires Node 22 or newer.

```bash
npm ci --ignore-scripts
npm run build
node bin/cli.js doctor      # verifies better-sqlite3, the parsers and git on this machine
```

To use it as a command (`guardian`) without publishing, build a tarball and install it: `npm run build && npm pack`, then `npm install -g ./code-guardian-ai-0.3.0.tgz`. `npm run pack:smoke` does exactly this in a throwaway directory and runs the CLI from both a local and a global install. It has been run on Linux; the CI matrix runs it on Ubuntu, macOS and Windows, and that is the check to trust for those platforms.

A `package-lock.json` is committed. `better-sqlite3` 13 ships prebuilt binaries for macOS, Linux (glibc and musl) and Windows on x64 and arm64 inside the package itself, so `npm ci --ignore-scripts` needs no compiler and runs no install scripts. CI installs this way on Ubuntu, macOS and Windows with Node 22 and 24 (`.github/workflows/ci.yml`). If `doctor` reports a failure on your platform, please open an issue with its output.

Copy `.env.example` to `.env` only if you want the optional external LLM step (see [Security model](#security-model)). Then, inside the project you want to protect:

```bash
node /path/to/code-guardian-ai/bin/cli.js init
```

`init` creates `.guardianrc`, adds `.guardian/` to `.gitignore`, shows the privacy mode, and prints ready-to-paste config for Claude Code, Claude Desktop and Cursor.

## Commands

| Command | What it does |
| --- | --- |
| `guardian init` | Prepares the workspace and prints MCP client config |
| `guardian serve` | Starts the MCP server on stdio (your AI client runs this) |
| `guardian doctor` | Checks native modules, parsers, git and the privacy mode |
| `guardian scan` | Duplicates, circular dependencies, unused imports, unresolved imports, orphan files, unused exports, suppressed checks |
| `guardian scan --json` | Full report including the import graph, cycles and imports the resolver could not judge |
| `guardian scan --explain` | Adds the evidence and a recommended action under each finding |
| `guardian check` | Only the problems introduced by your uncommitted git changes. `--base main` compares against a branch, `--all` also lists pre-existing ones, `--fail-on medium` exits 1 for CI |
| `guardian optimize "prompt"` | Adds codebase context to a prompt. `--no-llm` forces local, `--dry-run` prints the exact external payload without sending |

Use `--root <dir>` on any command to point at another project.

**Exit codes** (the same on every platform): `0` success, `1` the check found something (`check --fail-on`, `doctor`), `2` usage or runtime error. A `check` whose comparison is partial still fails on what it lists, because those findings are provisional rather than absent.

## MCP tools

- `find_reusable_code`: local, read-only lookup of existing functions and classes that match what the assistant is about to write, with the reason for each match. Says plainly when nothing matches.
- `get_codebase_context`: compact map of exported symbols, ranked for your query, within a token budget.
- `optimize_prompt`: keeps your request verbatim and adds the acceptance criteria it found, the existing code to reuse, related modules and constraints.
- `validate_rules`: git-aware. Reports only what your changes introduced, counts pre-existing findings without listing them, and notes what you fixed.

MCP is pull-based: the assistant decides whether to call a tool, and nothing here intercepts a prompt before the assistant sees it. The server sends instructions telling it to call `find_reusable_code` first, but for reliable use add the line printed by `guardian init` to `CLAUDE.md` or `.cursorrules`.

## How analysis works

**Indexing.** Every eligible file is discovered, sorted by path, then limited to `maxFiles`, so which files are indexed is deterministic. A file's SHA-256 content hash is the only cache validity check; size and mtime are never trusted. Hitting `maxFiles` never evicts cache entries for files left out of that pass. Every report says whether analysis is complete or partial and why. Findings that need a view of every file (orphans, unused exports) are low confidence on a partial scan.

**Extraction.** TypeScript, JavaScript (JSX, ESM and CommonJS) and Python: destructured declarations, `export *`, named and aliased re-exports, `import x = require()`, `module.exports`, `require()` with destructuring, namespace member tracking, dynamic `import()`/`require()`/`import.meta.glob` (including computed paths), and decorated classes. Unused imports are scope-aware: a parameter, local or catch variable with the same name neither hides an unused import nor counts as a use of it.

**Resolution.** Relative imports (including `.js` to `.ts` and trailing-slash directories), index files and barrels; `tsconfig`/`jsconfig` `paths`, `baseUrl`, `extends` (relative and from packages), `include`/`exclude`, `references`; workspace packages through `exports`, `main`, `module` and `types`, mapped back to source through `outDir`/`rootDir`; `package.json` `imports` (`#alias`); SvelteKit (`$lib`) and Nuxt (`~`, `@`) aliases when their dependency is present; Python packages with relative imports and configurable roots. Two equally valid targets are reported as ambiguous, not guessed. Anything the resolver cannot model (a Vite or webpack alias, a built package whose source it cannot find, a relative import into a missing `dist/`) is reported as **unsupported** and is never counted as a broken import.

**Duplicates.** Two separate rules, each saying what it compared. `duplicate-body`: the bodies are identical once whitespace is ignored (high confidence). `similar-structure`: the syntax trees match after local names are renumbered and literals and type annotations are ignored, with at least 40 tokens (medium confidence). Called function names and property names are not ignored. Neither rule compares behaviour. A shared name alone is a low-confidence `duplicate-symbol`.

**Unused code.** A file or export nobody imports is classified. `confidently-unused`: the scan is complete and nothing points at it. `potentially-unused`: something could still reach it, such as a dynamic import or glob whose path covers it, a framework or plugin directory, a decorated class, a file that runs code when loaded, an import through an alias the resolver cannot follow, or unanalysed `.vue`/`.svelte`/`.astro`/`.mdx` files. `unreferenced`: the scan was partial, so nothing more can be said. Entry points come from conventions, the detected framework profile, public package exports (`exports`, `main`, `bin`) and your `entryPoints`.

**Cycles.** Strongly connected components over runtime imports, including a file that imports itself. Type-only imports, `import()` and function-scoped or `TYPE_CHECKING` Python imports do not count.

**Retrieval.** Query understanding (identifiers, path hints, stems, a small synonym table), IDF-weighted matching over each symbol's name, doc comment or docstring, and signature, with a bonus for covering more of the request's terms, then dependency, importer and sibling expansion. A symbol is a candidate when its name, signature or description matched; a match through the file path alone only makes the file "related", so a path match never lists every function in it. Output states one of four things: strong matches, weak matches ("No confident match" plus the weak candidates), related files only, or no match. Candidates that matched but did not fit under `--limit` are counted. Each candidate carries the reasons it matched; popularity only orders files that already matched. Descriptions are used locally and are never sent to an external model.

**Validation.** `validate_rules` and `guardian check` read the git diff (staged, unstaged and untracked, against `HEAD` or `--base`), rebuild the project as it was at the base commit (its files, tsconfig, `.gitignore`, `.guardianrc` and manifests, not today's), run the same analysis on both, and compare findings by identity. The base manifests are compared on what resolution reads (names, entry fields, `exports`, `imports`, detected frameworks), so a `package.json` edit alone is validated. A renamed file comes back at its original path and its findings follow it to the new one. Editing a config file counts as a change to everything it affects. If the comparison cannot be complete (more than 400 changed source files, a base file that cannot be read back, or a base `.guardianrc`, `.gitignore`, tsconfig or `package.json` that exists but cannot be read or parsed) the report says `PARTIAL VALIDATION`, lists what was not compared, and labels results provisional.

**Token figures** are estimates (about four bytes per token). The comparison is always against reading the files that actually appear in the output in full. Truncation is reported, and budgets apply to new workspaces too.


## Configuration

`.guardianrc` in the project root, read through the same sandbox as every other file (a symlink out of the workspace is refused). Every field is optional and the file is schema-validated; unknown keys are an error.

```json
{
  "ignore": ["generated/"],
  "maxFiles": 5000,
  "maxFileKb": 512,
  "maxDiscoveryEntries": 500000,
  "maxDiscoveryMs": 20000,
  "maxIndexMs": 30000,
  "contextTokens": 4000,
  "llm": true,
  "pythonRoots": ["", "src"],
  "profile": "auto",
  "entryPoints": ["tools/seed.ts", "src/plugins/**"],
  "rules": { "similar-structure": "low", "unused-import": "off" },
  "exceptions": [{ "rule": "dead-export", "path": "src/api/**", "symbol": "handler" }],
  "strictOutbound": false,
  "maskPatterns": [{ "name": "ticket", "pattern": "TKT-\\d{6}" }],
  "maskLiterals": ["internal-host-7"]
}
```

- `maxDiscoveryEntries`, `maxDiscoveryMs`, `maxIndexMs`: resource limits for indexing; see "Resource limits" below for exactly what each one bounds. A scan that hits a limit is reported as `PARTIAL` (`stopped` in `--json` output), never as complete, and findings that need every file are low confidence. Files already parsed stay cached, so running the scan again continues where it stopped.
- `profile`: `auto` (detect from `package.json` dependencies), `none` (trust only `entryPoints`), or `next`, `nuxt`, `sveltekit`, `vite`, `astro`, `node`, `library`. A profile only says which files a framework loads by convention.
- `entryPoints`: gitignore-style patterns for files loaded by something other than an import.
- `rules`: per-rule severity (`high`, `medium`, `low`) or `off`. Rules: `duplicate-body`, `similar-structure`, `duplicate-symbol`, `circular-dependency`, `unused-import`, `unresolved-import`, `dead-export`, `orphan-file`, `suppression`.
- `exceptions`: findings of a rule in matching files (optionally mentioning a symbol) are not reported.
- `maskPatterns` are extra regular expressions to redact. Because a repository controls this file, patterns with nested quantifiers, back-references, look-around or empty matches are rejected.

`.gitignore` is respected. Environment variables: `GUARDIAN_LLM`, `GUARDIAN_STRICT`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `GEMINI_MODEL`, `GROQ_MODEL`, `GUARDIAN_LLM_TIMEOUT_MS` (default 12000), `GUARDIAN_LOG`, `GUARDIAN_ROOT`, `GUARDIAN_ENV_FILE`. Keys set by your MCP client in its `env` block take precedence over `.env`.

### Resource limits

Discovery distinguishes three numbers, and `maxDiscoveryEntries` bounds only one of them:

| Quantity | Meaning | Bounded by |
| --- | --- | --- |
| entries **read** (`listed`) | directory entries read from the file system | the time limit `maxDiscoveryMs` (not the entry limit) |
| entries **processed** (`entries`) | entries classified, ignore-checked and stat-ed, in sorted order. The entry that would exceed the limit is detected (that is how `entry-limit` is reported) but is neither processed nor counted, so `entries` never exceeds `maxDiscoveryEntries` | `maxDiscoveryEntries` |
| **peak listing buffer** (`peakListingBuffer`) | the most entries the directory-listing buffer held at one moment, counted in entries, not bytes. It covers **only that buffer**. It is not total discovery memory: the retained candidates (`eligible`), the directories still to visit and the result lists are not part of it | about `1.5 × (maxDiscoveryEntries − entries so far) + 8192` per directory, usually much less |

- **Why the whole directory is read.** Discovery is deterministic: when a limit applies, the entries kept are the first ones in name order, whatever order the operating system lists them. Knowing which names come first requires reading the entire directory. A directory of a million files with `maxDiscoveryEntries: 500` is therefore still read completely (and the scan reports `entry-limit`); only 500 entries are processed and only a bounded number are held in memory. The listing is streamed in batches, yields to the event loop, and is cut off by `maxDiscoveryMs`. Choosing not to read everything would make the selected files depend on file-system order, so it was not done.
- **Memory.** A listed entry is kept as its name and kind only, entries that sort after the current cutoff are dropped on arrival, and the buffer is cut back as it grows. Retained candidates (`eligible`) cost roughly 0.2 KB per eligible file and are the main remaining cost (they are not counted in `peakListingBuffer`); at the default `maxDiscoveryEntries` of 500,000 that is on the order of 100 MB if every entry is an eligible source file. Measured numbers are in `docs/release-verification.md`.
- **Entries of unknown type.** Some file systems and network mounts report no type for a directory entry. Such an entry is classified with `lstat`, which never follows a symbolic link: an unknown file is indexed, an unknown directory is entered, a link is skipped, and a socket or device is ignored. The size check of a candidate file also uses `lstat`, so a file swapped for a link after it was listed is not followed. Failures are never dropped silently. If `lstat` fails with a permission or I/O error, or an entry listed as a file is no longer a file when examined (replaced by a link or a directory), the entry could be a source file the scan could not see, so it is reported as skipped with reason `unclassified` and the scan is `PARTIAL`. If the error is `ENOENT` the entry was removed during the scan: it is recorded as `vanished` and is not a gap.
- **Directory races.** A directory that was listed can be replaced by a symbolic link before it is opened. Each directory is therefore checked and opened in layers: `lstat` must show a directory and not a link; on Linux and macOS the descriptor is opened with `O_NOFOLLOW | O_DIRECTORY` (the kernel refuses a link atomically) and `fstat` must show the same device and inode; on Linux the listing is read through `/proc/self/fd/<fd>`, from the verified directory itself, so a replacement that is undone changes nothing and the real path (`readlink`) must be inside the workspace; after the listing the path is checked again. A directory that fails any check is reported as skipped with reason `directory-replaced`, nothing from it is used, and the scan is `PARTIAL`. **Limits:** Node has no `openat` or `fdopendir`, so on macOS and Windows the listing is still opened by path and the checks before and after only bracket it: a replacement that happens and is undone inside that window cannot be detected there (Windows also has no `O_NOFOLLOW`; junctions and links are caught by `lstat` and the real-path check). File contents are never read through discovery's paths: `readInside` refuses links and paths outside the workspace by itself. The checks cost about 20 microseconds per directory (see the discovery benchmark).
- **What `maxIndexMs` covers.** The time from the end of discovery (which has its own limit) until the last file has been handled: loading the grammars and the cache (neither can be interrupted, but their time counts against the budget), and for each file reading, hashing, the cache lookup and parsing. No further file is started once it has passed, and a file that was already read is not parsed after it. Not covered: discovery, the first file of every call, and the steps after the last file (writing the cache, loading tsconfig, package and pyproject files, building the result), which are bounded by the number of configuration files rather than of sources. Files that certainly need parsing (no cache row, or a row whose size or mtime differ; size and mtime only order the work, the SHA-256 still decides validity) are handled first, so a call stopped by the limit has spent its time on new work and repeated calls finish. The first file of a call is always handled. One consequence: if hashing the files that are already cached takes longer than `maxIndexMs`, a warm scan cannot finish in one call and is reported as `index-time-limit`; raise the limit. Interrupted indexing is always `PARTIAL`, never evicts cache rows, and `orphan-file`, `dead-export` and `unresolved-import` findings from it are low confidence.
- **Hitting a limit is never silent.** `stopped` is `entry-limit`, `time-limit` or `index-time-limit`, `complete` is `false`, the cache is never pruned by a partial scan, and absence-based findings (`orphan-file`, `dead-export`) are not reported as confident.
- **Time limits and cancellation are cooperative.** `maxDiscoveryMs`, `maxIndexMs` and an MCP client's cancellation are checked between units of work: between directory batches and sort slices, after every entry, between files, and between phases. They cannot interrupt a file system call or a Tree-sitter parse that is already running, so a limit can be exceeded by the time of one such call, for example the parse of the largest file you allow with `maxFileKb`. Nothing expensive is started after the deadline has passed or the request was cancelled, and a stopped or cancelled scan is reported as incomplete (a cancelled request throws instead of returning a result). Treat the time limits as best-effort, not as hard deadlines.

### Known limits of the verification

`test/mcp-transport.test.ts` exercises the real server through the SDK client over an in-memory transport. It does not exercise stdio framing, a separate server process, or several clients at once. `npm run bench:mcp` measures the tool workflows in-process and, with `--transport`, through that in-memory transport; neither is an end-to-end client latency.

## Security model

There are two modes, and the tool always says which one produced a result.

**Fully local mode (default).** Nothing leaves your machine. This is what you get unless every one of these is true: `GUARDIAN_LLM=on` is set, `.guardianrc` does not say `"llm": false`, `--no-llm` was not passed, and a Gemini or Groq key exists. `GUARDIAN_LLM=off`, or anything unrecognised, is local.

**External LLM mode (explicit opt-in).** `optimize_prompt` sends your request, the acceptance criteria found in it, up to 8 matching symbol signatures with file paths, and a folder summary (paths, names and signatures are written as escaped JSON strings and marked untrusted in the system prompt; comments, docstrings and bodies are never included) to Gemini (fallback Groq) for a short scope note. No file contents or function bodies are sent. The note is added to the prompt; it never replaces your request. `guardian optimize --dry-run` prints the exact masked payload and sends nothing.

Everywhere else:

- **One outbound choke point.** The complete payload (system text, XML context blocks, signatures, paths, folder metadata) is masked as a unit inside the provider layer immediately before transmission and then re-scanned. If anything still looks like a secret it is not sent.
- **Masking everywhere.** Everything returned to an MCP client, printed by the CLI (text and JSON), or written to logs passes through the masker: provider API keys and tokens, JWTs, bearer and basic auth, private keys, credentials in URLs and query strings, assignments including multiline and concatenated values, YAML values and block scalars, `.env` lines, your configured `maskPatterns` and `maskLiterals`, and live values of your own key environment variables. Pattern-based masking can miss a secret in a format it does not know.
- **Custom patterns are restricted, then bounded.** `maskPatterns` come from a file the repository controls, so a pattern is accepted only if it stays inside a safe subset: no repeated groups (so no nested quantifiers), no back-references or look-around, at most 4 quantifiers of which at most 2 unbounded, repeat counts up to 64, 5 groups, and it must not match an empty string. Even an accepted pattern runs over the whole text (never in pieces, so a secret cannot straddle a cut) in a time-limited context with the `m` flag: `^` and `$` anchor at every line, and `\s` or a negated class can match across a newline. If the 250 ms limit is hit, every non-empty line of that text is replaced by `[REDACTED:unscanned]` instead of being passed through, and any failure while masking an outbound payload blocks the send. A very slow but valid pattern therefore blanks output rather than hang the tool or leak. See `test/redos.test.ts`.
- **Strict mode.** With `strictOutbound` or `GUARDIAN_STRICT=1`, a payload that still contains key-like high-entropy strings, encoded blobs, binary content or more text than the masker scans is refused instead of sent, and the reason is reported without echoing the content.
- **Model output is untrusted.** The external reply must be one JSON object that matches a strict schema. Every file, symbol, path and identifier it mentions must exist in the index (or in your own request); anything else is dropped and reported. The note shown to you is built locally from the validated fields and has two labelled parts: references that were checked against the index, and the model's commentary, which only passed the checks below and is still opinion. Replies are also dropped item by item when they contain links, shell fragments, markup or instructions to the next model, or name a directory, file, symbol or identifier that does not exist in the project.
- **Prompt injection: what is guaranteed, and what is not.** Repository text is untrusted data, and the design keeps it away from instructions:
  - *Guaranteed by the code (tested).* The system prompt is a constant that contains no repository text. Everything derived from the workspace that goes to an external model (file and directory names, symbol names, signatures) is serialized as one JSON object per line with `<`, `>`, `&`, control characters, line separators, zero-width and bidirectional characters, variation selectors and the invisible Unicode tag block escaped, so a hostile name cannot close a section, open one, start a Markdown block, forge a field, or hide text from a reader. Comments, docstrings and function bodies are not sent. The text built locally for your own assistant (`optimize_prompt`, `get_codebase_context`, `find_reusable_code`) is Markdown, so it uses the same rules adapted to Markdown: every invisible or reordering character (one shared definition for all paths) is replaced, a `<` that could open a tag is written `&lt;` (generics such as `Promise<void>` are escaped too), text that starts a line cannot start a heading, quote, list or code fence, and line breaks cannot occur. Each of those outputs says that its entries are repository data, not instructions. The same scrub is applied to the model's reply.
  - *Checked after the fact.* The reply must be one JSON object matching a strict schema; every file, symbol, path, directory and identifier it names is checked against the index and the item is dropped if it is not there; malformed output is discarded as a whole and the local result is used.
  - *Not guaranteed.* Escaping protects the structure of the prompt, not the meaning of the words inside it. A signature or file name that reads like an instruction is still text a language model sees, and no encoding can promise a model will never be influenced by it. What limits the damage is what is sent (names, paths and signatures only), the trusted instructions that tell the model those strings are data, the strict reply schema, and local validation, which keeps a misled model from putting an invented file, a link, a command or hidden characters into your prompt. Treat the "Unverified commentary" section as the model's opinion. The prompt-injection risk is reduced and bounded, not eliminated. The local-only mode, which is the default, sends nothing.
- **Workspace lock.** All file access goes through one sandbox: lexical and symlink-resolved checks, `O_NOFOLLOW`, `fstat` regular-file checks, size limits, and a check after opening that the file we hold is still the one the path names and still inside the workspace. Node has no atomic open-beneath, so a perfectly timed directory swap is narrowed, not made impossible. Windows device names and UNC forms are rejected. Tools accept only relative paths. Starting in `/` or your home directory is refused.
- **Files never read.** `.env*`, private keys, `.npmrc`, anything named `*secret*` or `*credential*`, minified and generated files. Symlinks are never followed while scanning.
- **Git is run safely.** Arguments are passed without a shell, refs are validated, `GIT_*` environment overrides are dropped, and repo-configured helpers (fsmonitor, external diff, textconv) are disabled.
- **Bounded input and cost.** Tool inputs are schema-validated. A prompt over 8000 characters is rejected, not silently cut. LLM calls have a hard deadline, are capped at 20 per minute, and a provider that returns 429 is skipped until its cooldown ends.
- **stdout is protocol-only.** Logs go to stderr.

## Failure behaviour

- **Bad files.** Syntax errors are parsed as far as possible. Unreadable, binary, oversized or unparseable files are skipped, listed in `scan --json`, and make the scan partial.
- **Tool errors.** A failing tool returns `isError: true` with `{"error":{"code":"invalid_path"|"invalid_input"|"internal_error","message":"..."}}`. Internal details go only to the stderr log.
- **Process level.** Unhandled rejections are logged and the server keeps running. A closed pipe shuts it down cleanly.
- **Cache.** `.guardian/cache.db` uses WAL with a 5 s busy timeout, so several processes can share it. A corrupted database is rebuilt, corrupted rows are re-parsed, and a read-only or unusable folder falls back to an in-memory cache.
- **LLM step.** Timeouts, HTTP errors and malformed responses fall through to the next provider, then to the local result.

## Known limits

Findings are candidates, not verdicts; read the confidence, method and evidence on each. Specifically:

- Static analysis cannot see code outside the workspace, run-time registration it has no signal for, or importers in file types it does not read. Those cases lower confidence where a signal exists and are invisible where none does.
- Structural similarity is a syntax comparison. It can match code that looks alike but is meant to differ, and miss code that does the same thing written differently.
- Retrieval is lexical with a small synonym table, no embeddings: "add two numbers" does not find `sum`, and an abbreviation such as `len` for "length" is missed. It found 5 of 6 labelled fixture queries and 15 of 17 on real repositories.
- A Python string used as a subscript index (`d["Name"]`) counts as a possible type reference, so an unused import of the same name is not reported.
- Generated files (`*.gen.ts`, `*.generated.ts`, `__generated__/`) are not checked for unused imports.
- Vite/webpack aliases, `tsconfig` `rootDirs`, and custom export conditions beyond what the resolver tries are reported as unsupported, not followed.
- A Python `from . import sub` is treated as loading the submodule, not as a dependency on the package `__init__`, so cycles that exist only through a package's `__init__` are not reported. Python dead-export detection treats every public top-level name as an export. Python imports used through `getattr`, `globals()` or star imports are not seen.
- Files that only import each other (an unreferenced cluster) are not reported as orphans: each has an importer.
- Python entry points come from `pyproject.toml` console-script tables only (`setup.cfg` and `setup.py` entry points are not read, and a project that relies on them is reported as partial). The reader checks only what affects those tables; it is not a TOML parser.
- Custom mask patterns are only accepted if they stay inside a restricted subset (no repeated groups, look-around or back-references, a few quantifiers). A very slow pattern blanks the text it cannot scan instead of passing it through.
- Validation compares up to 400 changed source files; beyond that it says so and the result is provisional.
- Supported languages: TypeScript, JavaScript and Python. The TypeScript Compiler API is deliberately not used; see `docs/decisions/0001-typescript-compiler-api.md`.
- Tested end to end on Linux. Windows and macOS are covered by the CI matrix, not by any run behind this README.

## Measured behaviour

From `npm run bench` and the checks below, on one Linux x64 machine (1 vCPU Xeon, Node 22). Timings are the median of 3 runs on a throwaway copy of each repository; memory is the operating system's peak resident set size for the whole process, which includes about 100 MB of baseline (Node, tree-sitter, SQLite). Treat the numbers as a guide: run-to-run spread on this machine was large (the cold index of 2000 files ranged from 0.7 to 1.5 s).

| Repository | Source files | Cold index | Warm index | Analysis | Retrieval / query | Validate 25 changed files | Peak memory |
| --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic | 2000 | 0.76 s | 0.10 s | 0.08 s | 37 ms | 0.29 s | 205 MB |
| express | 142 | 0.60 s | 0.02 s | 0.01 s | 2 ms | 0.16 s | 150 MB |
| got | 96 | 1.5 s | 0.01 s | 0.02 s | 15 ms | 0.45 s | 184 MB |
| zod | 522 | 3.1 s | 0.06 s | 0.18 s | 47 ms | 0.78 s | 197 MB |
| next-learn | 129 | 0.25 s | 0.02 s | 0.02 s | 9 ms | 0.26 s | 151 MB |
| requests | 36 | 0.31 s | 0.01 s | 0.01 s | 3 ms | 0.28 s | 152 MB |

**Real repositories (express, got, zod, next-learn, create-t3-turbo, requests, click).** Running the analysis on them and checking results against the TypeScript compiler, pyflakes and the source found ten false positives that the fixtures had not, all fixed. What was checked automatically, what only by hand, and what was not checked at all is listed in [docs/evaluation.md](docs/evaluation.md). In short: unused imports (16 reported) and cycles (2) were verified in full with 0 known false positives; duplicate bodies were verified by an independent comparison; orphan files and dead exports were reviewed only as a sample, and most of the roughly 270 reported on these repositories were not reviewed. Do not read these results as an accuracy rate.

The 11 labelled fixtures in `test/fixtures/` (TypeScript, JavaScript and Python) are scored per rule by `test/accuracy.test.ts`: 32 true positives, 0 false positives, 0 false negatives and 2 documented misses. They are small and hand-written, so this shows the rules behave as designed on known patterns, not how they perform on an arbitrary repository.

## Development

```bash
npm run typecheck
npm test            # unit, integration and the labelled accuracy fixtures
npm run bench       # --root <dir> for a real repository (copied first, never modified), --runs <n>, --files <n>, --json
npm run bench:mcp   # longest event-loop stall per phase: internal workflow (default) or --transport (real server + SDK client, in-memory); --sizes, --runs, --threshold <ms>, --root, --json
npm run pack:smoke  # npm pack, clean install, global install, run the CLI
npm run dev -- scan --root ../some-project
```

## Syntax errors and parser limits

Tree-sitter repairs code it cannot parse and still returns a tree. Each file's tree is checked for `ERROR` and `MISSING` nodes. Such a file stays indexed and its valid symbols are kept, but it is listed in `parseIssues` (`scan --json`) and in the coverage note, the analysis is `PARTIAL`, and findings that depend on it are low confidence:

- `recovered`: the damage is inside the body of a function, method or class, including one wrapped in `export` (`export function f() { <error> }` is still the exported function `f`). Top-level declarations, imports and exports were extracted; names used inside the damaged region may be missed (so `unused-import` is low confidence there).
- `degraded`: the damage is at the top level, inside an import or export header (a specifier list, an export clause, the signature of an exported function), or an unclosed body swallowed the code after it (an `export` or `import` found inside a function body can only be code that belongs at the top level). Imports, exports or declarations may be missing (so `orphan-file` and `dead-export` anywhere in the workspace are low confidence, because the missing importer may be the damaged file).
- A function whose body contains an error is not hashed, so it never takes part in duplicate detection. Its symbol is marked `partial`.
- Valid syntax that the bundled grammar does not support also shows up here. That is a parser limitation, reported the same way.
- **Python code the grammar accepts without an error.** The Python grammar is forgiving in two places, so `hasError` alone is not enough for Python and a second, structural check runs on every Python file:
  - An empty suite: `def f():` or `class A:` with nothing under it parses with an empty body and no error node. It is reported as a syntax error and the file is `recovered` (the declaration itself, its name and position, is intact). `pass`, `...`, a docstring, a comment followed by a statement and one-line suites such as `def f(): pass` are valid and are not reported.
  - A trailing comma in an import that is not parenthesized: `import os,` and `from os import path,`. It is reported and the file is `degraded`, because a malformed import is not a dependency to rely on. `from os import (path,)` and `from os import (path, name,)` are valid Python and are not reported.
  - A problem the tree already reports as an `ERROR` or `MISSING` node is counted once, by the error walk; the structural check skips any node whose subtree reports an error. JavaScript and TypeScript are not affected by this check.
- **Findings say why they are low confidence.** `orphan-file`, `dead-export` and `unused-import` findings that were made less certain by a damaged file list the first three damaged files with the same description used elsewhere (`path: 1 syntax error(s) near line 3: imports, exports or declarations may be missing from the extraction`), and count the rest.
