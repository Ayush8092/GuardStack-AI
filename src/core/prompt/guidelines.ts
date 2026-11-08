import type { FileInfo } from '../ast/types.js';

export const DAY_ONE_RULES = [
  'The workspace is new, so keep the structure simple from the start.',
  'One folder per responsibility (for example routes/, services/, utils/). No giant files and no one-file-per-function.',
  'Put shared helpers in utils/ and import them. Never copy a helper into a second file.',
  'No interfaces, factories or base classes until a second concrete use exists.',
  'Prefer the standard library and existing dependencies over adding packages.',
  'Use strict types. No `any`, @ts-ignore, eslint-disable, `# type: ignore` or `# noqa`.',
];

export function constraints(files: FileInfo[]): string[] {
  const hasJs = files.some((f) => f.lang !== 'python');
  const hasPy = files.some((f) => f.lang === 'python');
  const suppressions = [hasJs && '@ts-ignore, eslint-disable, `any`', hasPy && '`# type: ignore`, `# noqa`']
    .filter(Boolean)
    .join(', ');

  return [
    'Reuse the existing code listed above instead of writing a new helper with the same purpose.',
    'Before adding a function, check the codebase map for one that already does the job.',
    `Do not hide errors with ${suppressions}. Fix the underlying problem.`,
    'Make the smallest change that solves the task: no new abstractions, no unrequested refactors, no new dependencies unless unavoidable.',
    'Follow the existing folder layout and naming. Put new code next to the code it belongs with.',
  ];
}
