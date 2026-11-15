import { appendToRegularFile, createFileExclusive } from '../../core/security/safe-file.js';

const MAX_GITIGNORE_BYTES = 1024 * 1024;
const GUARDIAN_ENTRY = /^\/?\.guardian\/?$/m;

// Both writers refuse symlinks and non-regular files (UnsafeFileError) and never modify anything outside `root`.

export function ensureGitignore(root: string): void {
  if (createFileExclusive(root, '.gitignore', '.guardian/\n')) return;
  appendToRegularFile(root, '.gitignore', MAX_GITIGNORE_BYTES, (current) =>
    GUARDIAN_ENTRY.test(current) ? null : `${current && !current.endsWith('\n') ? '\n' : ''}.guardian/\n`,
  );
}

// An existing config is never rewritten.
export function ensureConfig(root: string, fileName: string): void {
  createFileExclusive(root, fileName, `${JSON.stringify({ ignore: [], llm: true }, null, 2)}\n`);
}
