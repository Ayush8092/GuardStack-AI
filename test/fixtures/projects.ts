// Representative projects with hand-labelled ground truth. `expected` lists every finding that should be reported,
// as finding keys; anything else the analysis reports counts as a false positive, anything missing as a false negative.
// `possible` lists findings that are acceptable only as "potentially unused": the file or export has no importer but a
// runtime signal could reach it. Reporting them as confidently unused would be a false positive.
// `knownMisses` are real problems the analysis is documented not to detect (see README, known limits). They are counted as
// false negatives in the report, and the test fails if one starts being detected so the label is moved to `expected`.
export type Fixture = { name: string; files: Record<string, string>; expected: string[]; possible?: string[]; knownMisses?: string[]; config?: Record<string, unknown> };

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export const fixtures: Fixture[] = [
  {
    name: 'small TypeScript project',
    files: {
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/main.ts': "import { formatDate } from '@/utils/date';\nimport { readFileSync } from 'node:fs';\nimport { helper } from './helper';\nimport { unusedThing } from './helper';\nconsole.log(formatDate(new Date()), helper(), readFileSync);\n",
      'src/helper.ts': "export const helper = () => 1;\nexport const unusedThing = 2;\nexport const neverImported = 3;\n",
      'src/utils/date.ts': "export function formatDate(d: Date) {\n  const format = 'iso';\n  return format === 'iso' ? d.toISOString() : String(d);\n}\n",
      'src/legacy.ts': "export const legacy: any = 1;\n",
      'src/shadow.ts': "import { format } from './utils/fmt';\nexport function render(format: string) { return format.trim(); }\n",
      'src/utils/fmt.ts': "export const format = (s: string) => s;\n",
      'src/entry.ts': "import './shadow';\nimport './main';\n",
    },
    expected: [
      'dead-export|src/helper.ts|neverImported',
      'dead-export|src/shadow.ts|render',
      'orphan-file|src/legacy.ts',
      'orphan-file|src/entry.ts',
      'suppression|src/legacy.ts|any',
      'unused-import|src/shadow.ts|./utils/fmt|format',
      'unused-import|src/main.ts|./helper|unusedThing',
    ],
  },
  {
    name: 'medium TypeScript project with barrels, type-only imports and cycles',
    files: {
      'package.json': json({ name: 'app', private: true }),
      'src/index.ts': "export * from './models';\nexport { createStore } from './store';\n",
      'src/models/index.ts': "export { User } from './user';\nexport type { Role } from './role';\n",
      'src/models/user.ts': "import type { Role } from './role';\nexport interface User { id: string; role: Role }\n",
      'src/models/role.ts': "export type Role = 'admin' | 'member';\n",
      'src/store.ts': "import { User } from './models';\nimport { notify } from './notify';\nexport const createStore = (u: User) => notify(u.id);\n",
      'src/notify.ts': "import { createStore } from './store';\nexport const notify = (id: string) => (id ? createStore : null);\n",
      'src/lazy.ts': "export const load = () => import('./heavy');\n",
      'src/heavy.ts': "export const heavy = 1;\n",
      'src/app.ts': "import { load } from './lazy';\nimport { createStore } from './index';\nconsole.log(load, createStore);\n",
    },
    expected: ['circular-dependency|src/notify.ts,src/store.ts'],
  },
  {
    name: 'monorepo with workspace packages',
    files: {
      'package.json': json({ name: 'mono', private: true }),
      'packages/ui/package.json': json({ name: '@mono/ui', exports: { '.': './dist/index.js', './forms': './dist/forms.js' } }),
      'packages/ui/tsconfig.json': json({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
      'packages/ui/src/index.ts': "export { Button } from './button';\n",
      'packages/ui/src/button.ts': "export const Button = () => 1;\n",
      'packages/ui/src/forms.ts': "export const Form = () => 2;\n",
      'packages/ui/src/internal.ts': "export const hidden = 3;\n",
      'packages/utils/package.json': json({ name: '@mono/utils', main: './lib/index.js' }),
      'packages/utils/src/index.ts': "export const sum = (a: number, b: number) => a + b;\nexport const unusedAnywhere = 1;\n",
      'apps/web/package.json': json({ name: 'web', dependencies: { '@mono/ui': '*' } }),
      'apps/web/src/main.ts': "import { Button } from '@mono/ui';\nimport { Form } from '@mono/ui/forms';\nimport { sum } from '@mono/utils';\nconsole.log(Button, Form, sum);\n",
    },
    // packages/utils/src/index.ts is the package's public entry (main), so its exports are API, not dead code.
    expected: ['orphan-file|packages/ui/src/internal.ts'],
  },
  {
    name: 'Next.js application',
    files: {
      'package.json': json({ name: 'site', dependencies: { next: '15', react: '19' } }),
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
      'app/layout.tsx': "import { Nav } from '@/components/nav';\nexport default function Layout({ children }: { children: unknown }) { return <div><Nav />{children as never}</div>; }\n",
      'app/page.tsx': "import { greet } from '@/lib/greet';\nexport default function Page() { return <p>{greet('x')}</p>; }\n",
      'app/api/health/route.ts': "export function GET() { return Response.json({ ok: true }); }\n",
      'components/nav.tsx': "export const Nav = () => <nav />;\n",
      'components/footer.tsx': "export const Footer = () => <footer />;\n",
      'lib/greet.ts': "export const greet = (n: string) => `hi ${n}`;\nexport const shout = (n: string) => n.toUpperCase();\n",
      'middleware.ts': "export function middleware() { return undefined; }\n",
      'next.config.js': "module.exports = {};\n",
    },
    expected: ['dead-export|lib/greet.ts|shout', 'orphan-file|components/footer.tsx'],
  },
  {
    name: 'Node.js backend with plugin loading and scripts',
    files: {
      'package.json': json({ name: 'api', main: 'src/index.js', dependencies: { express: '4' } }),
      'src/index.ts': "import { start } from './server';\nstart();\n",
      'src/server.ts': "import { loadRoutes } from './routes';\nexport const start = () => loadRoutes();\n",
      'src/routes/index.ts': "export const loadRoutes = (names: string[] = []) => names.map((n) => require('./' + n));\n",
      'src/routes/users.ts': "export const users = () => 'users';\n",
      'src/routes/orders.ts': "export const orders = () => 'orders';\n",
      'src/jobs/cleanup.ts': "export const cleanup = () => 1;\n",
      'src/db/migrations/001-init.ts': "export const up = () => 1;\n",
      'scripts/seed.ts': "console.log('seed');\n",
      'src/old/report.ts': "export const report = () => 1;\n",
    },
    // routes/* are reachable through the dynamic require; jobs/ and migrations/ are conventional runtime directories;
    // only the truly stray file is a confident orphan.
    expected: ['orphan-file|src/old/report.ts'],
    possible: ['orphan-file|src/routes/users.ts', 'orphan-file|src/routes/orders.ts', 'orphan-file|src/jobs/cleanup.ts'],
  },
  {
    name: 'Python package',
    files: {
      'pyproject.toml': '[project]\nname = "pkg"\n',
      'pkg/__init__.py': 'from .core import run\nfrom .util import slugify\n__all__ = ["run", "slugify"]\n',
      'pkg/core.py': 'import os\nimport json\nfrom .util import slugify\n\ndef run(items):\n    return [slugify(i) for i in items] + [json.dumps(os.sep)]\n',
      'pkg/util.py': 'def slugify(text):\n    return text.lower().replace(" ", "-")\n\ndef unused_public():\n    return 1\n',
      'pkg/cli.py': 'import sys\nfrom pkg import run\n\nif __name__ == "__main__":\n    print(run(sys.argv))\n',
      'pkg/shadow.py': 'import re\n\ndef f(re):\n    return re\n',
      'pkg/extra.py': 'import json\nVALUE = 1\n',
      'main.py': 'import pkg.shadow\nimport pkg.extra\nfrom pkg import run\nrun([])\n',
    },
    expected: [
      'dead-export|pkg/util.py|unused_public',
      'unused-import|pkg/extra.py|json|json',
      'unused-import|pkg/shadow.py|re|re',
      // `import pkg.shadow` binds the name `pkg`, which nothing reads (flake8 F401 reports the same).
      'unused-import|main.py|pkg.shadow|pkg',
      'unused-import|main.py|pkg.extra|pkg',
    ],
  },
  // ---- Fixtures below reproduce patterns seen when the analysis was run on real repositories. Their labels were written
  // from how the code behaves at run time (Python and Node semantics), before looking at what the analysis reported. ----
  {
    name: 'Python library with compat shim, submodule imports, console script and a real cycle (requests/click patterns)',
    files: {
      'pyproject.toml': '[project]\nname = "lib"\n\n[project.scripts]\nlibcli = "lib.cli:main"\n',
      'src/lib/__init__.py': 'from .core import run\nfrom . import types\n',
      'src/lib/core.py': 'from . import types\nfrom .compat import quote\n\n\ndef run(x):\n    return quote(x) + types.NAME\n',
      'src/lib/types.py': 'NAME = "n"\n',
      // Imports names for other modules to import from here. quote is consumed by core.py; urlsplit and os are not.
      'src/lib/compat.py': 'import os\nfrom urllib.parse import quote, urlsplit\n\nIS_COMPAT = True\n',
      // Entry point declared in pyproject.toml, never imported.
      'src/lib/cli.py': 'import click\n\n\n@click.command()\ndef main():\n    pass\n',
      // A runtime cycle: both modules import each other at module level.
      'src/lib/a.py': 'from .b import fb\n\n\ndef fa():\n    return fb()\n',
      'src/lib/b.py': 'from .a import fa\n\n\ndef fb():\n    return fa()\n',
      // typing exists as a directory in tests, but the import is the standard library module.
      'tests/typing/example.py': 'X = 1\n',
      'tests/test_core.py': 'from typing import Literal\nfrom lib import run\nfrom lib.a import fa\nfrom lib.b import fb\n\nMODE: Literal["x"] = "x"\nrun(MODE)\nfa()\nfb()\n',
      // Forward references in quotes are uses.
      'src/lib/hooks.py': 'from typing import Any, Callable, TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .types import NAME\n\nHook = Callable[["NAME"], Any]\n\n\ndef make():\n    return Hook\n',
      'src/lib/dead.py': 'def never_called():\n    return 1\n',
    },
    expected: [
      'circular-dependency|src/lib/a.py,src/lib/b.py',
      'unused-import|src/lib/compat.py|os|os',
      'unused-import|src/lib/compat.py|urllib.parse|urlsplit',
      'orphan-file|src/lib/dead.py',
      // Nothing imports hooks.py (its only symbol is reported through the orphan, not again as a dead export), and nothing
      // imports IS_COMPAT from compat.py.
      'orphan-file|src/lib/hooks.py',
      'dead-export|src/lib/compat.py|IS_COMPAT',
    ],
  },
  {
    name: 'Node.js JavaScript service: CommonJS, lazy and dynamic requires, an examples folder, a real runtime cycle (express patterns)',
    files: {
      'package.json': json({ name: 'svc', main: 'lib/index.js' }),
      'lib/index.js': "const util = require('./util');\nconst router = require('./router');\nmodule.exports = { util, router };\n",
      'lib/util.js': "exports.pad = (s) => String(s).padStart(4, '0');\nexports.unusedHelper = () => 1;\n",
      // router and view require each other at load time.
      'lib/router.js': "const view = require('./view');\nexports.route = () => view.render();\n",
      'lib/view.js': "const router = require('./router');\nexports.render = () => router.route;\n",
      // Loaded by a computed path, so the importer cannot be known statically.
      'lib/plugins/auth.js': 'module.exports = () => 1;\n',
      'lib/loader.js': "const path = require('path');\nmodule.exports = (name) => require(path.join(__dirname, 'plugins', name));\n",
      // Required inside a function: still a dependency, but not a load-time one, so no cycle.
      'lib/lazy-a.js': "exports.a = () => require('./lazy-b').b();\n",
      'lib/lazy-b.js': "const { a } = require('./lazy-a');\nexports.b = () => a;\n",
      // A standalone example run with `node examples/hello/index.js`.
      'examples/hello/index.js': "const { util } = require('../../lib');\nconsole.log(util.pad(7));\n",
      'bin/serve.js': "#!/usr/bin/env node\nrequire('../lib');\n",
    },
    expected: [
      'circular-dependency|lib/router.js,lib/view.js',
      'orphan-file|lib/loader.js',
    ],
    // lib/util.js is re-exported whole from the package entry (module.exports = { util }), so unusedHelper is public API.
    // lazy-a.js and lazy-b.js are dead code, but they import each other, so each has an importer: an island of files that
    // only reference one another is not detected.
    knownMisses: ['orphan-file|lib/lazy-a.js', 'orphan-file|lib/lazy-b.js'],
    // lib/plugins/auth.js could be loaded by loader.js; it may be reported only as potentially unused.
    possible: ['orphan-file|lib/plugins/auth.js', 'orphan-file|examples/hello/index.js'],
  },
  {
    name: 'TypeScript workspace with generated code, a hidden generated alias target and a type-only cycle (zod/create-t3-turbo patterns)',
    files: {
      'package.json': json({ name: 'ws', private: true }),
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
      // Generated: its unused import is not actionable.
      'app/routeTree.gen.ts': "import type { createStart } from '@tanstack/react-start';\nexport const routeTree = 1;\n",
      'app/router.ts': "import { routeTree } from './routeTree.gen';\nexport const router = routeTree;\n",
      // @/.source is produced by a build step and is not in the repository.
      'app/docs.ts': "import { docs } from '@/.source';\nexport const d = docs;\n",
      // core and util import each other at run time.
      'src/core.ts': "import { members } from './util';\nexport const globalConfig = { members };\n",
      'src/util.ts': "import { globalConfig } from './core';\nexport const members = () => globalConfig;\n",
      // type-only mutual imports are erased and are not a cycle.
      'src/types-a.ts': "import type { B } from './types-b';\nexport interface A { b: B }\n",
      'src/types-b.ts': "import type { A } from './types-a';\nexport interface B { a: A }\n",
      'src/use-types.ts': "import type { A } from './types-a';\nimport { router } from '../app/router';\nimport { d } from '../app/docs';\nimport { globalConfig } from './core';\nexport const x: A | null = null;\nconsole.log(router, d, globalConfig);\n",
      'src/entry.ts': "import './use-types';\n",
    },
    expected: [
      'circular-dependency|src/core.ts,src/util.ts',
      'orphan-file|src/entry.ts',
      'dead-export|src/use-types.ts|x',
    ],
  },
  {
    name: 'duplicate detection: identical bodies, renamed locals, near misses and short helpers',
    files: {
      'package.json': json({ name: 'dup', private: true }),
      'src/a.ts': "export function totalA(items: number[]) {\n  let sum = 0;\n  const limit = 100;\n  for (const item of items) {\n    if (item > 0) {\n      sum += item * 2;\n    }\n  }\n  return sum > limit ? limit : sum;\n}\n",
      // Identical text apart from the function name.
      'src/b.ts': "export function totalB(items: number[]) {\n  let sum = 0;\n  const limit = 100;\n  for (const item of items) {\n    if (item > 0) {\n      sum += item * 2;\n    }\n  }\n  return sum > limit ? limit : sum;\n}\n",
      // Same structure with every local renamed.
      'src/c.ts': "export function totalC(rows: number[]) {\n  let acc = 0;\n  const limit = 100;\n  for (const row of rows) {\n    if (row > 0) {\n      acc += row * 2;\n    }\n  }\n  return acc > limit ? limit : acc;\n}\n",
      // Looks similar but is not: different operator, different constant, an extra branch.
      'src/d.ts': "export function totalD(items: number[]) {\n  let sum = 0;\n  const floor = 0;\n  for (const item of items) {\n    if (item > 0) {\n      sum -= item * 3;\n    } else {\n      sum += 1;\n    }\n  }\n  return sum < floor ? floor : sum;\n}\n",
      // Tiny helpers are not duplicates worth reporting.
      'src/e.ts': 'export const inc = (n: number) => n + 1;\n',
      'src/f.ts': 'export const inc2 = (n: number) => n + 1;\n',
      'src/main.ts': "import { totalA } from './a';\nimport { totalB } from './b';\nimport { totalC } from './c';\nimport { totalD } from './d';\nimport { inc } from './e';\nimport { inc2 } from './f';\nconsole.log(totalA([1]), totalB([1]), totalC([1]), totalD([1]), inc(1), inc2(1));\n",
      'src/start.ts': "import './main';\n",
    },
    expected: [
      'duplicate-body|src/a.ts:totalA,src/b.ts:totalB',
      'similar-structure|src/a.ts:totalA,src/b.ts:totalB,src/c.ts:totalC',
      'orphan-file|src/start.ts',
    ],
    possible: [],
  },
  {
    name: 'Python duplicate detection: renamed locals are similar, a different algorithm is not',
    files: {
      'pyproject.toml': '[project]\nname = "d"\n',
      'pkg/__init__.py': 'from .a import score_a\nfrom .b import score_b\nfrom .c import score_c\n',
      'pkg/a.py': 'def score_a(values):\n    total = 0\n    for value in values:\n        if value > 0:\n            total += value * 2\n    return min(total, 100)\n',
      'pkg/b.py': 'def score_b(numbers):\n    acc = 0\n    for n in numbers:\n        if n > 0:\n            acc += n * 2\n    return min(acc, 100)\n',
      'pkg/c.py': 'def score_c(values):\n    return sorted(values, reverse=True)[:3]\n',
    },
    expected: ['similar-structure|pkg/a.py:score_a,pkg/b.py:score_b'],
  },
];
