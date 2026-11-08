// Fetches every repository in repos.json at its pinned commit: node eval/fetch.mjs <directory>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'eval/repos');
const repos = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'repos.json'), 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = (cwd) => {
  try {
    return git(cwd, 'rev-parse', 'HEAD');
  } catch {
    return ''; // a new repository has no commit yet
  }
};

fs.mkdirSync(target, { recursive: true });
for (const repo of repos) {
  const dir = path.join(target, repo.name);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', repo.url);
  }
  if (head(dir) !== repo.commit) {
    git(dir, 'fetch', '-q', '--depth', '1', 'origin', repo.commit);
    git(dir, 'checkout', '-q', '--detach', repo.commit);
  }
  console.log(`${repo.name.padEnd(16)} ${head(dir)}`);
}
