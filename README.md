# GuardStack AI

GuardStack AI is a local MCP server and CLI for helping AI coding assistants work with an existing codebase.

It provides tools to find reusable code, retrieve relevant project context, prepare coding prompts, and check changes for issues such as duplicate implementations, circular dependencies, and unused code.

Analysis runs locally. An optional LLM step can be enabled for prompt clarification, with outbound data restricted and masked before it is sent.

**Package:** `code-guardian-ai`
**CLI:** `guardian`
**Runtime:** Node.js 22 or later
**License:** MIT

---

## What it does

AI coding assistants often work with incomplete knowledge of a project. They may recreate utilities that already exist, introduce another implementation of an existing feature, or make changes that weaken the project's existing checks.

GuardStack AI gives an assistant access to structured information about the codebase and a way to validate changes against it.

| Capability | Description |
|---|---|
| Reusable code search | Find existing functions and classes relevant to a task |
| Codebase context | Retrieve a compact map of files, exports, functions, classes, and types |
| Prompt optimization | Add relevant project context and reuse constraints to a coding request |
| Change validation | Identify newly introduced code-quality findings |
| Local analysis | Parse and analyze supported source files without sending their contents to an external model |

GuardStack AI supports TypeScript, JavaScript, and Python analysis.

It is designed to work through MCP. The assistant decides when to call its tools; GuardStack AI does not intercept prompts or independently control the assistant's actions.

## Requirements

- Node.js 22 or later
- Git, for change validation against a base revision
- An MCP-compatible coding assistant, if using the MCP server

The CLI can be used independently of an MCP client.

## Installation

After the package is published to npm:

```bash
npm install -g code-guardian-ai
```

Check the installation:

```bash
guardian --version
guardian doctor
```

`guardian doctor` checks the local runtime, native modules, parsers, and Git availability.

## Quick start

Run the following commands from the root of the project you want to analyze.

### 1. Initialize the workspace

```bash
guardian init
```

This prepares the workspace for GuardStack AI:

- Creates `.guardianrc` if it does not already exist.
- Prepares the local `.guardian/` cache directory.
- Adds `.guardian/` to `.gitignore` when needed.
- Displays the active privacy policy.
- Prints MCP configuration examples for supported clients.
- Prints an instruction that can be added to your assistant's project instructions.

Existing `.guardianrc` files are preserved rather than overwritten.

### 2. Inspect the codebase

```bash
guardian scan
```

The scan reports findings such as duplicate implementations, circular dependencies, unused imports, orphan files, and dead exports.

For structured output:

```bash
guardian scan --json
```

For evidence and suggested actions:

```bash
guardian scan --explain
```

### 3. Search for existing code

```bash
guardian find "authentication middleware"
```

This performs local retrieval over indexed code. It does not require an external LLM.

### 4. Check your changes

```bash
guardian check
```

In a Git repository, this compares findings against the selected base revision and reports newly introduced issues by default.

---

## Connect an MCP client

GuardStack AI exposes its functionality through an MCP server using standard input and output (stdio).

Initialize the workspace first:

```bash
guardian init
```

Use the MCP configuration printed by the command for your client. The generated configuration contains the resolved CLI path and workspace root.

The server configuration has this general form:

```json
{
  "mcpServers": {
    "codeguardian": {
      "command": "node",
      "args": [
        "/absolute/path/to/code-guardian-ai/bin/cli.js",
        "serve",
        "--root",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

Use the actual paths printed by `guardian init`; the paths above are illustrative.

### Claude Code

`guardian init` prints a Claude Code registration command. Run the generated command from your terminal.

### Claude Desktop and Cursor

Add the generated `mcpServers` entry to the MCP configuration used by your client.

Restart or reload the client after changing its MCP configuration.

### Add project instructions

MCP tools are called at the assistant's discretion. To make their intended use clearer, add the instruction printed by `guardian init` to your project's `CLAUDE.md` or `.cursorrules` file.

The instruction asks the assistant to:

1. Search for reusable code before writing new helpers.
2. Use the existing implementations where appropriate.
3. Validate its changes after implementation.

These instructions guide the assistant; they are not an enforcement mechanism.

---

## CLI reference

Run `guardian --help` or `guardian <command> --help` for command-specific options.

| Command | Purpose |
|---|---|
| `guardian init` | Initialize a workspace and print MCP configuration |
| `guardian serve` | Start the MCP server over stdio |
| `guardian doctor` | Check runtime dependencies and local setup |
| `guardian scan` | Analyze the workspace |
| `guardian scan --json` | Print the scan report as JSON |
| `guardian scan --explain` | Include evidence and recommended actions |
| `guardian check` | Validate changes against a Git base revision |
| `guardian find <query>` | Search locally for reusable code |
| `guardian optimize [prompt]` | Add relevant codebase context to a coding request |

### Workspace selection

All commands accept:

```bash
--root <dir>
```

This selects the workspace to operate on. If omitted, the current directory is used, unless overridden by the configured workspace environment.

### `guardian check` options

| Option | Description |
|---|---|
| `--base <ref>` | Compare against a Git reference instead of `HEAD` |
| `--all` | Include pre-existing findings |
| `--json` | Print structured JSON output |
| `--fail-on <severity>` | Exit with code 1 when a new finding reaches the selected severity (`high`, `medium`, or `low`) |
| `--fail-on-partial` | Exit with code 1 when validation is partial |
| `--config-policy <policy>` | Choose how weakened analysis configuration is handled: `warn`, `fail`, or `approve` |

By default, `check` focuses on newly introduced findings. In a Git repository, it considers staged, unstaged, and untracked changes.

### `guardian find` options

| Option | Description |
|---|---|
| `--json` | Print structured results |
| `--limit <n>` | Maximum number of candidates to return (1–50; default 8) |

### `guardian optimize` options

| Option | Description |
|---|---|
| `--no-llm` | Disable the optional external LLM step |
| `--dry-run` | Print the exact masked payload that would be sent, without sending it |

If no prompt is supplied, `guardian optimize` reads the request from standard input.

---

## MCP tools

The MCP server exposes four tools.

### `find_reusable_code`

Searches the indexed codebase for existing functions and classes relevant to a request.

Inputs:

- `query`: search text or identifiers.
- `limit`: optional result limit, defaulting to 8.

The search is local and does not call an LLM. If no useful match is found, the tool reports that rather than inventing an implementation.

### `get_codebase_context`

Returns a compact representation of relevant project structure and symbols.

It can accept:

- A natural-language query.
- A list of workspace-relative paths.
- A maximum token budget.

The result prioritizes relevant files and symbols, and reports truncation, omitted files, dropped exports, token usage, and indexing notes.

It is a structural context summary, not a full dump of source files.

### `optimize_prompt`

Adds relevant codebase context to a coding request.

It can provide:

- Existing functions and modules to reuse.
- Constraints against unnecessary duplication and code bloat.
- Acceptance criteria identified in the request.
- Relevant project structure.

The original request is retained. Depending on the active privacy policy, an optional external LLM may be used to clarify the request.

### `validate_rules`

Checks code for selected issues, including:

- Duplicate functions.
- Circular dependencies.
- Unused imports.
- Orphan files.
- Unused exports.
- Suppressed type and lint checks, including patterns such as `@ts-ignore`, `eslint-disable`, `any`, `# noqa`, and `# type: ignore`.

In a Git repository, it compares against a base revision and focuses on newly introduced findings unless existing findings are explicitly requested.

Outside a Git repository, validation applies to the workspace as a whole.

---

## Privacy and data handling

GuardStack AI runs locally by default.

Indexing, parsing, retrieval, caching, and static analysis do not require an external LLM provider.

### Local mode

Local mode is the default. When the optional LLM step is disabled, GuardStack AI does not send project data to Gemini or Groq.

### Optional external LLM mode

The external step is used only when all of the following conditions are met:

1. `GUARDIAN_LLM` is explicitly enabled.
2. `.guardianrc` allows the LLM step with `"llm": true`.
3. At least one supported provider API key is configured.
4. The operation has not explicitly disabled LLM use with `--no-llm`.

The outbound payload is limited to:

- The developer's request.
- Up to eight matching symbol signatures and their file paths.
- A folder summary.

The payload passes through the configured secret-masking layer before transmission. Source file contents and function bodies are not included in this external payload.

### Preview before sending

To inspect the exact masked payload without making an external request, use:

```bash
guardian optimize "Add request validation to the API" --dry-run

Use `--no-llm` when you want to explicitly keep an optimization operation local.

### Important privacy limitation

Secret masking reduces the risk of accidental disclosure; it cannot guarantee detection of every possible secret or sensitive value.

Review the preview before enabling external processing in a sensitive workspace.

---

## Configuration

Workspace configuration is stored in `.guardianrc`.

A configuration can look like this:

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
  "entryPoints": [
    "tools/seed.ts",
    "src/plugins/**"
  ],
  "rules": {
    "similar-structure": "low",
    "unused-import": "off"
  },
  "exceptions": [
    {
      "rule": "dead-export",
      "path": "src/api/**",
      "symbol": "handler"
    }
  ],
  "strictOutbound": false,
  "maskPatterns": [
    {
      "name": "ticket",
      "pattern": "TKT-\\d{6}"
    }
  ],
  "maskLiterals": [
    "internal-host-7"
  ]
}
```

### Configuration options

| Option | Purpose |
|---|---|
| `ignore` | Paths to exclude from analysis |
| `maxFiles` | Maximum number of files to index |
| `maxFileKb` | Maximum file size considered for indexing |
| `maxDiscoveryEntries` | Maximum filesystem entries considered during discovery |
| `maxDiscoveryMs` | Time budget for file discovery |
| `maxIndexMs` | Time budget for indexing |
| `contextTokens` | Default token budget for retrieved context |
| `llm` | Allows or disables the optional external LLM step |
| `pythonRoots` | Additional Python import roots |
| `profile` | Analysis profile; `auto` selects automatically |
| `entryPoints` | Paths or patterns used as entry points |
| `rules` | Per-rule severity overrides |
| `exceptions` | Targeted exceptions for selected findings |
| `strictOutbound` | Blocks outbound payloads containing content the secret masker cannot verify |
| `maskPatterns` | Additional regular expressions used to mask sensitive values |
| `maskLiterals` | Literal values to mask in outbound text |

Configuration changes can affect analysis coverage and confidence. In particular, disabling rules or excluding paths can hide findings.

### Environment variables

| Variable | Purpose |
|---|---|
| `GUARDIAN_LLM` | Enables the optional external LLM step when explicitly set to an accepted enabled value |
| `GUARDIAN_STRICT` | Overrides `strictOutbound`; `1`, `on`, `true`, and `yes` enable strict mode. Any other non-empty value disables it |
| `GEMINI_API_KEY` | Gemini provider key |
| `GROQ_API_KEY` | Groq provider key |
| `GEMINI_MODEL` | Overrides the Gemini model |
| `GROQ_MODEL` | Overrides the Groq model |
| `GUARDIAN_LLM_TIMEOUT_MS` | Per-provider timeout in milliseconds |
| `GUARDIAN_LOG` | Log level: `debug`, `info`, `warn`, or `error` |
| `GUARDIAN_ROOT` | Workspace root override |
| `GUARDIAN_ENV_FILE` | Explicit environment-file path |

The optional LLM step is disabled by default.

Default provider models:

- Gemini: `gemini-3.1-flash-lite`
- Groq: `openai/gpt-oss-120b`

When both provider keys are configured, Gemini is attempted first and Groq is used as a fallback. If only one key is configured, only that provider is available.

The default per-provider timeout is 12 seconds. It can be configured with `GUARDIAN_LLM_TIMEOUT_MS`, within the supported range of 200 ms to 60 seconds.

Keep API keys in a local environment file or your environment. Do not commit secrets to the repository.

---

## How analysis works

GuardStack AI uses deterministic indexing and static analysis rather than relying on an LLM to discover code-quality findings.

### 1. File discovery and indexing

The workspace is traversed in a deterministic, sorted order, subject to configured discovery and indexing limits.

File content is hashed with SHA-256. The hash is used to determine whether cached analysis remains valid.

Partial scans do not evict the entire existing cache. Resource limits are applied to prevent unexpectedly large workspaces from consuming unbounded time or memory.

### 2. Parsing and symbol extraction

Tree-sitter parsers are used to extract supported language structures.

The current supported languages are:

- TypeScript
- JavaScript, including JSX, ESM, and CommonJS patterns
- Python

The index records relevant declarations, references, imports, exports, and relationships.

Unused-import analysis includes scope-aware handling to avoid treating every textual occurrence as a valid reference.

### 3. Import resolution

Import resolution handles common project structures, including:

- Relative imports.
- TypeScript and JavaScript aliases.
- `tsconfig` and `jsconfig` path mappings.
- Workspace package exports.
- Python import roots and relative imports.

Unsupported or ambiguous resolution is reported as a limitation rather than automatically treated as a broken import.

### 4. Duplicate detection

Duplicate analysis uses more than one signal:

- Duplicate symbol detection.
- Duplicate function-body matching.
- Similarity based on structural patterns.

Similarity findings are evidence for review, not proof that two implementations are interchangeable.

### 5. Unused-code analysis

The analyzer looks for code that appears unused, including imports, exports, and files.

Findings use different confidence levels because static analysis cannot always determine how a project is used at runtime.

For example, a public API, dynamically loaded module, framework convention, or external entry point may be used without a direct reference visible to the analyzer.

Configured entry points and exceptions can help account for these patterns.

### 6. Dependency cycles

Import relationships are used to identify circular dependencies.

Resolution limitations can affect cycle detection, so unsupported import patterns are not silently treated as fully understood.

### 7. Local retrieval

Code retrieval uses lexical scoring with IDF-style weighting over indexed symbols and code metadata.

It does not require embeddings or a hosted vector database.

### 8. Change validation

In a Git repository, validation reconstructs the selected base state and compares its findings with those in the current workspace.

The comparison accounts for changed files and relevant configuration or manifest changes.

By default, pre-existing findings are not reported as new issues. Use `--all` when you want to include them.

Validation can be marked partial when the base state or changed-file coverage cannot be fully compared. Use `--fail-on-partial` in workflows where partial validation should fail the command.

### 9. Configuration weakening

Validation can identify changes that weaken analysis configuration.

The `--config-policy` option controls how these changes are handled:

- `warn`: report the change.
- `fail`: fail validation.
- `approve`: explicitly accept the configuration change.

### 10. Resource and token budgets

Discovery, indexing, file sizes, and retrieved context are bounded by configuration.

Context retrieval reports token usage and indicates when content has been omitted or truncated. Token estimates are budgeting estimates, not guarantees of a provider's exact tokenizer count.

---

## Security model

GuardStack AI is designed around local-first operation and explicit control over outbound processing.

### Workspace boundaries

Workspace operations are restricted to the selected project root. File access and configuration writes use checks intended to prevent symlink-based escapes and unsafe file handling.

Sensitive files and unsupported file types are excluded from ordinary source indexing.

Git operations use controlled process execution rather than shell-interpolated commands.

### Outbound data controls

External LLM requests pass through a central outbound-processing path.

The masking layer supports built-in detection and user-defined patterns and literals. Pattern execution is bounded. If masking fails, the outbound request is blocked rather than sending unprocessed text.

`strictOutbound` enables fail-closed outbound checks. In addition to secret masking and re-scanning, strict mode blocks payloads containing content the masker cannot verify, such as high-entropy key-like strings, encoded blobs, binary data, or text beyond its scanning limits. `GUARDIAN_STRICT` can override this setting through the environment.

### Model output

External model output is treated as untrusted input and validated before being used as an optimization result.

The model does not receive unrestricted access to the workspace or the ability to execute project commands.

### Prompt injection and limitations

Prompt-injection and secret-masking protections reduce risk; they do not guarantee detection of every malicious instruction or sensitive value.

GuardStack AI is an analysis and context tool, not a security boundary around the coding assistant. It does not intercept the assistant's actions or guarantee that the assistant follows its recommendations.

Review generated code and validate changes using your normal development and security processes.

---
## Resource limits and failure behaviour

GuardStack AI applies resource limits to keep workspace analysis bounded. When a limit prevents complete analysis, the result is reported as partial or degraded rather than being presented as complete.

### Indexing and parsing

- File discovery and indexing are subject to configured limits and time budgets.
- Files exceeding configured size or resource limits may be skipped.
- Syntax trees exceeding 1,000 nesting levels or 750,000 nodes are marked degraded and are not used for normal symbol extraction.
- Malformed or unsupported syntax can produce partial analysis or lower-confidence findings.
- Parser resource limits protect against excessive memory use and call-stack depth. They do not interrupt a synchronous parser while it is running.

### Local cache

The `.guardian/` directory stores workspace-specific cache data. If persistent cache initialization is unavailable, the application can use an in-memory fallback.

The cache should not be committed to version control.

### External provider failures

When external LLM mode is enabled, the provider chain uses Gemini first and Groq as a fallback when both are configured.

Provider errors, timeouts, rate limits, and unusable responses are handled through fallback and retry controls. If no provider returns a usable response, the operation uses its local result where possible.

Requests blocked by outbound-data policy are not sent.

### MCP transport

The MCP server communicates over stdio. Protocol messages are written to standard output, while diagnostic logs go to standard error so they do not corrupt the protocol stream.

---

## Known limitations

GuardStack AI uses static analysis. It cannot determine every runtime behaviour or project convention.

Important limitations include:

- Dynamic imports, reflection, plugin registries, and runtime-generated references can make code usage difficult to determine.
- Framework conventions and external entry points may make apparently unused code necessary.
- Complex aliasing and package-resolution behaviour may not be fully supported.
- Structural similarity does not establish that two functions have identical behaviour.
- Lexical retrieval can miss conceptually related code when a query uses different terminology.
- Python and JavaScript projects can contain dynamic patterns that static analysis cannot resolve reliably.
- Syntax errors and damaged source files can reduce parsing confidence.
- Results depend on the selected workspace, configuration, entry points, ignore rules, and resource budgets.

Source-level analysis currently focuses on TypeScript, JavaScript, and Python. Other file types do not receive equivalent source-level analysis.
---

## Evaluation and measured behaviour

GuardStack AI has been tested against real repositories, controlled seeded defects, and independent analysis tools.

These results describe specific test sets and environments. They are not a universal accuracy guarantee.

### Repository checks

The evaluation included:

- Express
- Got
- Zod
- Next Learn
- Requests
- Click

Independent-tool comparisons produced the following results:

- **TypeScript compiler:** agreed with 8 findings, with 0 missed across four checked TypeScript repositories.
- **Pyflakes:** matched 6 of 8 checked cases across Requests and Click.

Agreement with another tool is useful evidence for the cases tested. It does not establish that every finding is correct or that every possible issue is detected.

### Seeded-defect tests

Across six repositories containing controlled defects, GuardStack AI detected **36 of 36 seeded defects**.

This measures detection of the defects deliberately introduced for the test. It should not be interpreted as 100% accuracy on arbitrary codebases.

### Benchmark environment

The following measurements were collected on Linux x64 with a 1-vCPU Xeon environment and Node.js 22.

Values are medians across three runs. RSS includes the process baseline.

| Repository | Cold scan | Warm scan | Analysis | Retrieval | Validation | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| Synthetic 2,000 files | 0.76 s | 0.10 s | 0.08 s | 37 ms | 0.29 s | 205 MB |
| Express | 0.60 s | 0.02 s | 0.01 s | 2 ms | 0.16 s | 150 MB |
| Got | 1.50 s | 0.01 s | 0.02 s | 15 ms | 0.45 s | 184 MB |
| Zod | 3.10 s | 0.06 s | 0.18 s | 47 ms | 0.78 s | 197 MB |
| Next Learn | 0.25 s | 0.02 s | 0.02 s | 9 ms | 0.26 s | 151 MB |
| Requests | 0.31 s | 0.01 s | 0.01 s | 3 ms | 0.28 s | 152 MB |

These measurements describe the tested environment and repositories. Actual results depend on hardware, project size, file types, and configuration.

### Platform testing

CI runs test, type-checking, build, and packaging checks across:

- Ubuntu
- macOS
- Windows
- Node.js 22 and 24

The Windows CI jobs also include platform-specific process-tree termination and ACL-related checks.

CI coverage is not exhaustive end-to-end testing on every machine or project configuration.

---

## Development

### Set up the repository

```bash
git clone https://github.com/Ayush8092/GuardStack-AI.git
cd GuardStack-AI
npm ci --ignore-scripts
```

Build the project:

```bash
npm run build
```

Check the local environment:

```bash
node bin/cli.js doctor
```

### Development commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | Run TypeScript type checking |
| `npm test` | Run the test suite |
| `npm run build` | Build the project |
| `npm run bench` | Run analysis benchmarks |
| `npm run bench:mcp` | Run MCP benchmarks |
| `npm run pack:smoke` | Test the packed package and installation |
| `npm run dev -- scan --root ../some-project` | Run the CLI from the development environment |

The package smoke test checks the packed artifact and exercises installation and CLI/MCP behaviour.

### Package contents

The npm package includes the CLI, compiled output, license, environment example, and README.

Tests, source-only development files, local caches, and workspace data are not intended to be part of the published package.

---

## License

GuardStack AI is released under the [MIT License](LICENSE).