import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { loadMachineKey } from '../src/db/cache-key.js';
import { aclProblem, checkWindowsAcls, currentUserSid } from '../src/db/windows-acl.js';
import { cleanup, fileSymlinksWork, hardLinksWork, workspace } from './helpers.js';

// Windows ignores POSIX owners and modes, so the machine key's directory and file are checked against their ACLs. The decision
// logic and the flow around it run on every platform (the ACL reader is replaced by a stub); the tests at the end run only on
// real Windows and use the real ACLs.

const saved = process.env.GUARDIAN_STATE_HOME;
const home = workspace({}, 'guardian-winkey-');
let counter = 0;
let state = '';
beforeEach(() => {
  state = path.join(home, `state-${counter++}`);
  process.env.GUARDIAN_STATE_HOME = state;
});
afterEach(() => {
  fs.rmSync(state, { recursive: true, force: true });
});
after(() => {
  if (saved === undefined) delete process.env.GUARDIAN_STATE_HOME;
  else process.env.GUARDIAN_STATE_HOME = saved;
  cleanup();
});

const USER = 'S-1-5-21-111-222-333-1001';
const OTHER = 'S-1-5-21-111-222-333-1002';
const dacl = (...aces: string[]): string => `O:${USER}G:${USER}D:PAI${aces.map((a) => `(${a})`).join('')}`;
const daclOwnedBy = (owner: string, ...aces: string[]): string =>
  `O:${owner}G:${owner}D:PAI${aces.map((a) => `(${a})`).join('')}`;
const allow = (sid: string, flags = ''): string => `A;${flags};FA;;;${sid}`;

test('the ACL decision: only the user, SYSTEM and Administrators may have access', () => {
  const private1 = dacl(allow(USER), allow('SY'), allow('BA'));
  assert.equal(aclProblem(private1, USER, 'dir'), null);
  assert.equal(aclProblem(dacl(allow(USER, 'OICI'), allow('S-1-5-18', 'OICI'), allow('S-1-5-32-544', 'OICI')), USER, 'dir'), null, 'SIDs written out are the same as the aliases');

  const LOCAL_ADMIN = 'S-1-5-21-111-222-333-500';

  assert.equal(
    aclProblem(daclOwnedBy(LOCAL_ADMIN, allow(LOCAL_ADMIN), allow('LA')), LOCAL_ADMIN, 'dir', LOCAL_ADMIN),
    null,
    'LA is trusted when it resolves to the current user',
  );
  assert.match(
    aclProblem(dacl(allow(USER), allow('LA')), USER, 'dir', 'S-1-5-21-444-555-666-500') ?? '',
    /accessible to other users/,
    'LA is refused when it resolves to a different local Administrator',
  );
  assert.match(
    aclProblem(dacl(allow(USER), allow('LA')), USER, 'dir') ?? '',
    /accessible to other users/,
    'LA is refused when the local Administrator SID cannot be resolved',
  );

  assert.equal(
    aclProblem(daclOwnedBy('LA', allow(LOCAL_ADMIN)), LOCAL_ADMIN, 'dir', LOCAL_ADMIN),
    null,
    'LA owner is trusted when it resolves to the current user',
  );
  assert.match(
    aclProblem(daclOwnedBy('LA', allow(USER)), USER, 'dir', 'S-1-5-21-444-555-666-500') ?? '',
    /not owned by the current user/,
    'LA owner is refused when it resolves to a different local Administrator',
  );
  assert.match(
    aclProblem(daclOwnedBy('LA', allow(USER)), USER, 'dir') ?? '',
    /not owned by the current user/,
    'LA owner is refused when its SID cannot be resolved',
  );


  assert.equal(aclProblem(dacl(allow(USER), 'A;OICIIO;GA;;;CO'), USER, 'dir'), null, 'creator-owner entries are trusted');
  assert.equal(aclProblem(dacl(allow(USER), allow('BU', 'IO')), USER, 'dir'), null, 'an inherit-only entry does not apply to this object');
  assert.equal(aclProblem(dacl(allow(USER), 'D;;FA;;;WD'), USER, 'dir'), null, 'a deny entry only removes access');
  assert.equal(aclProblem(dacl(allow(USER.toLowerCase()), allow('SY')), USER, 'dir'), null, 'SID comparison ignores case');
});

test('the ACL decision: any other principal with access is refused', () => {
  for (const other of ['WD', 'BU', 'AU', 'IU', 'S-1-1-0', 'S-1-5-32-545', 'S-1-15-2-1', OTHER]) {
    assert.match(aclProblem(dacl(allow(USER), allow(other)), USER, 'the key directory') ?? '', /accessible to other users/, other);
  }
  assert.match(aclProblem(dacl('XA;;FA;;;WD;(Member_of{SID(BU)})'), USER, 'k') ?? '', /./, 'a conditional entry for Everyone');
  assert.match(aclProblem(dacl(allow(USER), 'OA;;FA;guid;;BU'), USER, 'k') ?? '', /accessible to other users/);
});

test('the ACL decision: unreadable, null or foreign-owned descriptors are refused', () => {
  assert.match(aclProblem(`O:${USER}G:${USER}`, USER, 'k') ?? '', /could not be read/, 'no DACL means everyone has full access');
  assert.match(aclProblem('', USER, 'k') ?? '', /could not be read/);
  assert.match(aclProblem('garbage', USER, 'k') ?? '', /could not be read/);
  assert.match(aclProblem(dacl('A;;FA'), USER, 'k') ?? '', /could not be read/);
  assert.match(aclProblem(dacl('ZZ;;FA;;;' + USER), USER, 'k') ?? '', /unexpected type/);
  assert.match(aclProblem(`O:${OTHER}G:${OTHER}D:PAI(A;;FA;;;${USER})`, USER, 'k') ?? '', /not owned by the current user/);
  assert.equal(aclProblem(`O:BAG:BAD:PAI(A;;FA;;;${USER})`, USER, 'k'), null, 'owned by Administrators (created by an elevated process) is fine');
});

const asWindows = (acl: (t: Array<{ path: string; what: string }>) => string | null) => ({ platform: 'win32' as const, acl });
const keyFile = (): string => path.join(state, 'cache-key');

test('Windows: a private directory gets a key, created once and reused', () => {
  const seen: string[][] = [];
  const options = asWindows((t) => (seen.push(t.map((x) => x.what)), null));
  const root = workspace();
  const first = loadMachineKey(root, options);
  assert.equal(first?.length, 32);
  assert.deepEqual(seen, [['the key directory'], ['cache-key']], 'the directory is verified before the key is created, the new key afterwards');
  seen.length = 0;
  assert.deepEqual(loadMachineKey(root, options), first);
  assert.deepEqual(seen, [['the key directory', 'cache-key']], 'an existing key is verified together with its directory');
});

test('Windows: a permissive directory is refused before any key is created', () => {
  const key = loadMachineKey(workspace(), asWindows(() => 'the key directory is accessible to other users (BU)'));
  assert.equal(key, null);
  assert.equal(fs.existsSync(keyFile()), false, 'nothing was written into a directory that failed the check');
});

test('Windows: an existing key with a permissive ACL is refused', () => {
  const root = workspace();
  assert.ok(loadMachineKey(root, asWindows(() => null)));
  const key = loadMachineKey(root, asWindows((t) => (t.some((x) => x.what === 'cache-key') ? 'cache-key is accessible to other users (WD)' : null)));
  assert.equal(key, null);
});

test('Windows: a new key whose ACL does not verify after creation is refused', () => {
  const key = loadMachineKey(workspace(), asWindows((t) => (t.length === 1 && t[0].what === 'cache-key' ? 'cache-key is accessible to other users' : null)));
  assert.equal(key, null);
});

test('Windows: an ACL that cannot be inspected is refused, never assumed safe', () => {
  assert.equal(loadMachineKey(workspace(), asWindows(() => 'the permissions of the key directory could not be verified (powershell.exe is not available)')), null);
});

test('Windows: the POSIX mode bits are not taken as proof of anything', () => {
  // On POSIX a group/other-writable directory is refused by mode. Under the Windows rules only the ACL decides, so the stub is the
  // only thing that can accept or refuse: this also shows the modes are not consulted.
  fs.mkdirSync(state, { recursive: true });
  fs.chmodSync(state, 0o777);
  const calls: number[] = [];
  const key = loadMachineKey(workspace(), asWindows(() => (calls.push(1), null)));
  assert.ok(key);
  assert.ok(calls.length > 0);
});

test('Windows: an unavailable state directory falls back safely', () => {
  fs.writeFileSync(state, 'a file where the directory should be');
  assert.equal(loadMachineKey(workspace(), asWindows(() => null)), null);
  fs.rmSync(state);
});

test('Windows: a state directory inside the workspace is refused', () => {
  const root = workspace();
  process.env.GUARDIAN_STATE_HOME = path.join(root, 'state');
  assert.equal(loadMachineKey(root, asWindows(() => null)), null);
});

test('Windows: the key file replaced by a symbolic link is refused', { skip: fileSymlinksWork }, () => {
  const root = workspace();
  assert.ok(loadMachineKey(root, asWindows(() => null)));
  const elsewhere = path.join(home, `elsewhere-${counter}`);
  fs.copyFileSync(keyFile(), elsewhere);
  fs.rmSync(keyFile());
  fs.symlinkSync(elsewhere, keyFile());
  assert.equal(loadMachineKey(root, asWindows(() => null)), null);
});

test('Windows: the key file replaced by a hard link is refused', { skip: hardLinksWork }, () => {
  const root = workspace();
  assert.ok(loadMachineKey(root, asWindows(() => null)));
  fs.linkSync(keyFile(), path.join(home, `second-name-${counter}`));
  assert.equal(loadMachineKey(root, asWindows(() => null)), null);
});

test('other platforms never consult the Windows check', { skip: process.platform === 'win32' }, () => {
  let called = false;
  assert.ok(loadMachineKey(workspace(), { acl: () => ((called = true), 'refuse') }));
  assert.equal(called, false);
});

// ---- Real Windows only: the real ACLs, set with icacls and read back through PowerShell. ----

const real = process.platform === 'win32' ? false : 'these tests use the Windows ACL tools';
const icacls = (...args: string[]): void => void execFileSync('icacls.exe', args, { stdio: 'ignore', windowsHide: true });
const privateDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  icacls(dir, '/inheritance:r', '/grant:r', `*${currentUserSid()}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F');
};
const share = (target: string): void => icacls(target, '/grant', '*S-1-1-0:(OI)(CI)F');

test('real Windows: a custom directory that is private to the user works', { skip: real }, () => {
  privateDir(state);
  const aclError = checkWindowsAcls([{ path: state, what: 'test state directory' }]);
  assert.equal(aclError, null, aclError ?? 'Expected the directory ACL to be private');
  assert.equal(loadMachineKey(workspace())?.length, 32);
  assert.equal(loadMachineKey(workspace())?.length, 32, 'and is found again');
});

test('real Windows: the standard user-local state directory works', { skip: real }, () => {
  delete process.env.GUARDIAN_STATE_HOME;
  assert.equal(loadMachineKey(workspace())?.length, 32);
});

test('real Windows: a custom directory that Everyone can access is refused', { skip: real }, () => {
  fs.mkdirSync(state, { recursive: true });
  share(state);
  assert.equal(loadMachineKey(workspace()), null);
  assert.equal(fs.existsSync(keyFile()), false);
});

test('real Windows: an existing key that was opened up to Everyone is refused', { skip: real }, () => {
  privateDir(state);
  assert.ok(loadMachineKey(workspace()));
  icacls(keyFile(), '/grant', '*S-1-1-0:F');
  assert.equal(loadMachineKey(workspace()), null);
});

test('real Windows: a missing key is created with an ACL that passes the check', { skip: real }, () => {
  privateDir(state);
  assert.equal(fs.existsSync(keyFile()), false);
  assert.ok(loadMachineKey(workspace()));
  assert.ok(fs.existsSync(keyFile()));
});

test('real Windows: a state directory that does not exist and cannot be created falls back safely', { skip: real }, () => {
  fs.writeFileSync(state, 'file');
  assert.equal(loadMachineKey(workspace()), null);
  fs.rmSync(state);
});
