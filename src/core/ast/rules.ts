export const RULES = [
  'duplicate-body',
  'similar-structure',
  'duplicate-symbol',
  'circular-dependency',
  'unused-import',
  'unresolved-import',
  'dead-export',
  'orphan-file',
  'suppression',
] as const;
export type Rule = (typeof RULES)[number];

export type Severity = 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'medium' | 'low';

// How a finding was produced. Confidence is derived from this, so a label always says what was actually compared.
export type Method =
  | 'exact-text-match'
  | 'normalized-structure-match'
  | 'name-match'
  | 'import-graph'
  | 'scope-analysis'
  | 'comment-scan'
  | 'import-resolution';

// unreferenced: nothing indexed imports it, and the scan cannot say more.
// potentially-unused: nothing imports it, but runtime loading, registration or a launch-on-load script could still reach it.
// confidently-unused: nothing imports it, the scan is complete, and no runtime or framework signal points at it.
export type Classification = 'unreferenced' | 'potentially-unused' | 'confidently-unused';

export const PROFILES = ['auto', 'none', 'next', 'nuxt', 'sveltekit', 'vite', 'astro', 'node', 'library'] as const;
export type Profile = (typeof PROFILES)[number];

// gitignore-style patterns for files a framework loads by convention, with no import statement pointing at them.
export const PROFILE_ENTRIES: Record<Exclude<Profile, 'auto' | 'none'>, string[]> = {
  next: [
    '**/app/**/page.*', '**/app/**/layout.*', '**/app/**/route.*', '**/app/**/loading.*', '**/app/**/error.*',
    '**/app/**/not-found.*', '**/app/**/template.*', '**/app/**/default.*', '**/app/**/global-error.*',
    '**/pages/**', '**/middleware.*', '**/instrumentation.*', 'next.config.*', '**/_app.*', '**/_document.*',
  ],
  nuxt: ['**/pages/**', '**/layouts/**', '**/middleware/**', '**/plugins/**', '**/server/**', '**/composables/**', '**/components/**', '**/utils/**', '**/stores/**', 'nuxt.config.*'],
  sveltekit: ['src/routes/**', 'src/hooks.*', 'src/hooks/**', 'svelte.config.*'],
  vite: ['vite.config.*', 'src/main.*', 'vitest.config.*'],
  astro: ['src/pages/**', 'src/middleware.*', 'astro.config.*', 'src/content/**'],
  node: ['src/index.*', 'src/main.*', 'src/server.*', 'src/app.*', 'bin/**', 'scripts/**', 'migrations/**', 'seeds/**'],
  library: ['src/index.*', 'index.*'],
};

export const REMEDIATION: Record<Rule, string> = {
  'duplicate-body': 'Keep one implementation and import it from the other places.',
  'similar-structure': 'Compare the listed functions; if they do the same job, extract one shared function and call it from each.',
  'duplicate-symbol': 'Check whether these are the same concept. If so reuse one; if not, rename one so they are not confused.',
  'circular-dependency': 'Move the shared code into a third module, or make one direction a type-only import.',
  'unused-import': 'Remove the import. If it is re-exported on purpose, export it explicitly.',
  'unresolved-import': 'Fix the path or alias, or add the missing file or package.',
  'dead-export': 'Remove the export (or the symbol), or import it where it is meant to be used.',
  'orphan-file': 'Delete the file, or import it where it is needed. If it is loaded at runtime, add it to entryPoints in .guardianrc.',
  suppression: 'Fix the underlying type or lint error and remove the suppression, or leave a comment saying why it is needed.',
};
