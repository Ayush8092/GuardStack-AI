import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Windows has no owner/mode bits that mean anything: a file's protection is its ACL. The machine key is only secret and
// unmodifiable if nobody but the current user (and the accounts that can take over the machine anyway) can read or change it,
// so on Windows the key directory and the key file are checked against their actual ACLs instead of against POSIX modes.
//
// The ACL is read with Windows PowerShell's Get-Acl (present on every desktop Windows, no dependency to add) as an SDDL string,
// which uses SIDs, so the check does not depend on the language of the account names. Anything that cannot be read or parsed
// is refused: the caller then keeps the cache in memory, as it does for every other unsafe key location.

// The principals that may hold access: the current user, the local SYSTEM account and the Administrators group (who can take
// ownership of any file anyway), and the CREATOR OWNER / OWNER RIGHTS placeholders, which stand for the owner.
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const ALIASES: Record<string, string> = { SY: SYSTEM, BA: ADMINISTRATORS, CO: 'S-1-3-0', OW: 'S-1-3-4' };
const sid = (token: string): string => ALIASES[token] ?? token;

const SDDL = /^O:(S-1-[\d-]+|[A-Z]{2})(?:G:(?:S-1-[\d-]+|[A-Z]{2}))?(D:[A-Z]*(?:\([^()]*\))*)(?:S:.*)?$/;
const ALLOW = new Set(['A', 'OA', 'XA', 'ZA']);
const DENY = new Set(['D', 'OD', 'XD']);

// null when the ACL gives nobody but trusted principals any access, otherwise what is wrong with it.
export function aclProblem(sddl: string, userSid: string, what: string): string | null {
  const match = SDDL.exec(sddl.trim());
  if (!match) return `${what} has an access control list that could not be read (no owner or no DACL)`;
  const trusted = new Set([userSid.toUpperCase(), SYSTEM, ADMINISTRATORS, 'S-1-3-0', 'S-1-3-4']);
  const owner = sid(match[1]).toUpperCase();
  if (owner !== userSid.toUpperCase() && owner !== SYSTEM && owner !== ADMINISTRATORS) return `${what} is not owned by the current user (owner ${match[1]})`;
  // A NULL DACL (everyone has full access) has no D: section at all and was refused by the pattern above.
  const aces = [...match[2].matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  for (const ace of aces) {
    const fields = ace.split(';');
    if (fields.length < 6) return `${what} has an access control entry that could not be read`;
    const [type, flags, , , , trustee] = fields;
    if (DENY.has(type)) continue;
    if (!ALLOW.has(type)) return `${what} has an access control entry of an unexpected type (${type})`;
    // Inherit-only entries apply to children, not to this object.
    if (/IO/.test(flags)) continue;
    if (!trusted.has(sid(trustee).toUpperCase())) return `${what} is accessible to other users (${trustee})`;
  }
  return null;
}

const system32 = (name: string): string => path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', name);
const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env): string => {
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} is not available`);
  return execFileSync(file, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'], env });
};

let userSid: string | undefined;
export function currentUserSid(): string {
  if (userSid) return userSid;
  const found = /"(S-1-[\d-]+)"/.exec(run(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']));
  if (!found) throw new Error('the current user could not be identified');
  return (userSid = found[1]);
}

// One SDDL string per path, in order. Paths travel in an environment variable, never inside the script text.
export function readSddls(paths: string[]): string[] {
  const script = "$ErrorActionPreference = 'Stop'; foreach ($p in @(ConvertFrom-Json $env:GUARDIAN_ACL_PATHS)) { (Get-Acl -LiteralPath $p).Sddl }";
  const out = run(system32(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoProfile', '-NonInteractive', '-Command', script], {
    ...process.env,
    GUARDIAN_ACL_PATHS: JSON.stringify(paths),
  });
  const lines = out.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== paths.length) throw new Error('the access control lists could not be read');
  return lines;
}

export type WindowsAclCheck = (targets: Array<{ path: string; what: string }>) => string | null;

// null when every target is private to the current user, otherwise the first problem. A failure to inspect is a problem too.
export const checkWindowsAcls: WindowsAclCheck = (targets) => {
  try {
    const user = currentUserSid();
    const sddls = readSddls(targets.map((t) => t.path));
    for (let i = 0; i < targets.length; i++) {
      const problem = aclProblem(sddls[i], user, targets[i].what);
      if (problem) return problem;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err
        ? typeof err.stderr === 'string'
          ? err.stderr
          : Buffer.isBuffer(err.stderr)
            ? err.stderr.toString('utf8')
            : ''
        : '';
    const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
    return `the permissions of ${targets.map((t) => t.what).join(' and ')} could not be verified (${message}${detail ? `; stderr: ${detail}` : ''})`;
  }
};
