# 0001: Keep tree-sitter; do not add the TypeScript Compiler API

Status: accepted. Revisit if the cases listed at the end start to matter.

## Question

Would project-aware analysis through the TypeScript Compiler API (type-checker symbol resolution) be worth adding to,
or replacing part of, the tree-sitter based analysis?

## What was measured

All numbers are from this repository's own `src/` (49 TypeScript files) on one Linux x64 machine, Node 22. They are
a single-machine comparison, not a general benchmark.

| | tree-sitter (current) | TypeScript 5.9 Compiler API |
| --- | --- | --- |
| Parse 49 files | part of a full `scan` that took 0.7 to 0.85 s warm, including process start | 0.5 s syntax only |
| Build a program with a type checker | not needed | 2.7 s |
| Extra heap | cache-backed, about 130 to 185 MB peak RSS across the real repositories in `bench/` | +154 MB for the program |
| Install size | `@vscode/tree-sitter-wasm` 22 MB (already a dependency) | +23 MB, a second parser |
| Languages | TypeScript, JavaScript, Python in one pipeline | TypeScript and JavaScript only |

## Two blocking facts

1. The project pins `typescript@^7` as a dev dependency. The 7.x package is the native compiler and does not expose the
   JavaScript Compiler API: `require('typescript')` returns only `version` and `versionMajorMinor`. Using the API means
   shipping a second, older `typescript` as a runtime dependency.
2. The slow part is exactly the part that would be added. A program with a checker is about 3 to 4 times the cost of
   the whole current scan, per run, and the content-hash cache that makes warm scans cheap cannot cache a checker.

## What the compiler API would have bought, and what was done instead

| Need | Done with tree-sitter |
| --- | --- |
| Shadowing-aware unused imports | Scope analysis over the syntax tree (`scope-js.ts`, and a Python equivalent). Tests cover parameters, locals, catch variables, nested functions, var hoisting, destructuring and type-only names. |
| Module resolution fidelity | The resolver models `paths`, `baseUrl`, `extends` (relative and package), `include`/`exclude`, `references`, package `exports`/`imports`, workspace packages and framework aliases. What it cannot model is reported as `unsupported`, not as broken. |
| Type-aware duplicate detection | Not attempted. The tool labels what it compares: identical text, or identical syntax shape after renaming locals. It never claims semantic equality. |

## Hybrid option, rejected for now

An optional `--deep` mode that loads a TypeScript program only when the user asks and `typescript` is installed in the
workspace would avoid the install cost. It was not built because nothing in the current findings needs types: every
rule is about imports, exports, names and syntax. Adding it would create a second, slower code path to keep consistent
with the first.

## Revisit when

- Re-export chains through `export =`, declaration merging or conditional types cause measurable false positives.
- A rule is wanted that needs types (for example, "this function's parameters and return type match another's").
- The `typescript` 7 package ships a stable JavaScript API that is cheap to load.
