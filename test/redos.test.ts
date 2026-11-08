import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMaskPattern, configureMasking, maskSecrets } from '../src/core/security/masker.js';

const LINE = 2000;
const timeIt = (fn: () => void): number => {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

test('classic catastrophic and polynomial patterns are rejected', () => {
  const evil = [
    '(a+)+$', '(a*)*b', '(.*)*x', '(a|a)+$', '(a|aa)+$', '(a|ab)*c', '(\\w+\\s?)*$', '([a-z]+)*\\d', '(?:a?){30}a{30}',
    '(.*a){12}', '(x+x+)+y', 'a*a*a*b', '.*.*.*x', '\\d+\\d+\\d+!', '(a+){2,}', '(?:\\d+)+x', '(a|b)\\1', '(?<n>a)\\k<n>',
    '(?=a+)b', '(?!x)a', '(?<=x)y', 'a{1,1000}', 'a{65}', '[a-z]+[a-z]+[a-z]+x', '(a)(b)(c)(d)(e)(f)', 'a?a?a?a?a?b', '\\p{L}+',
  ];
  for (const pattern of evil) assert.notEqual(checkMaskPattern(pattern), null, `should reject ${pattern}`);
});

test('ordinary secret-shaped patterns are accepted', () => {
  const fine = ['TKT-\\d{6}', 'acme_[A-Za-z0-9]{32}', '(?:corp|internal)-token-[a-f0-9]{16,40}', 'AKIA[0-9A-Z]{16}', '\\bsk-[\\w-]+', '^key:\\s*\\S+$', '[A-Z]{3}-\\d+-[A-Z]+'];
  for (const pattern of fine) assert.equal(checkMaskPattern(pattern), null, `should accept ${pattern}: ${checkMaskPattern(pattern)}`);
});

test('patterns that match the empty string or are malformed are rejected', () => {
  for (const bad of ['', 'x?', '(a|)', '[', '(', 'a**', '*a', '+']) assert.notEqual(checkMaskPattern(bad), null, bad);
});

// A seeded generator over the allowed grammar: whatever it produces and the validator accepts must stay fast on
// hostile input, so the limits are checked by measurement and not only by reading the code.
test('every pattern the validator accepts is bounded by masking, whatever the input', () => {
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const atoms = ['a', 'b', '\\d', '\\w', '\\s', '.', '[a-z]', '[A-Z0-9]', '[^x]', '\\S', '-', '_'];
  const quants = ['', '', '*', '+', '?', '{2}', '{1,8}', '{3,}', '{1,64}'];
  const pieces = (): string => {
    const parts: string[] = [];
    for (let i = 1 + rnd(5); i > 0; i--) {
      const atom = atoms[rnd(atoms.length)] as string;
      parts.push(rnd(6) === 0 ? `(?:${atom}|${atoms[rnd(atoms.length)]})` : atom + (quants[rnd(quants.length)] as string));
    }
    return parts.join('');
  };

  const inputs = ['a'.repeat(LINE), `${'a'.repeat(LINE - 1)}!`, '1'.repeat(LINE), 'a1_- '.repeat(LINE / 5), `${'a '.repeat(LINE / 2)}`];
  let accepted = 0;
  let worst = { ms: 0, pattern: '' };
  for (let i = 0; i < 700; i++) {
    const pattern = pieces();
    if (checkMaskPattern(pattern) !== null) continue;
    accepted++;
    configureMasking({ literals: [], patterns: [{ name: 'p', pattern }] });
    for (const input of inputs) {
      const ms = timeIt(() => maskSecrets(input));
      if (ms > worst.ms) worst = { ms, pattern };
    }
  }
  assert.ok(accepted > 40, `the generator should produce plenty of accepted patterns, got ${accepted}`);
  configureMasking({ literals: [], patterns: [] });
  assert.ok(worst.ms < 1200, `slowest accepted pattern took ${worst.ms.toFixed(0)} ms: ${worst.pattern}`);
});

// Changed deliberately: matching is now over the whole text, so a pattern that times out leaves nothing in that text
// verifiably scanned. The old expectation (a second line still redacted by another pattern) described per-line matching.
test('a hostile text is bounded by the time limit and nothing in it passes through unscanned', () => {
  configureMasking({ literals: [], patterns: [{ name: 'tok', pattern: 'acme_[A-Za-z0-9]{8,32}' }, { name: 'dig', pattern: '\\d+x\\d+y' }] });
  const hostile = `${'1'.repeat(200_000)}\nacme_${'Z9'.repeat(10)}`;
  let result = { text: '', count: 0 };
  const ms = timeIt(() => {
    result = maskSecrets(hostile);
  });
  configureMasking({ literals: [], patterns: [] });
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.ok(!result.text.includes('acme_Z9') && !/\d{50}/.test(result.text));
  assert.ok(result.text.includes('[REDACTED:unscanned]'));
  assert.equal(result.text.split('\n').length, 2, 'line structure is kept');
});

test('a linear pattern over a large text is fast and masks every occurrence', () => {
  configureMasking({ literals: [], patterns: [{ name: 'tok', pattern: 'acme_[A-Za-z0-9]{32}' }] });
  const secret = `acme_${'Qz7'.repeat(11).slice(0, 32)}`;
  const text = Array.from({ length: 50_000 }, (_, i) => (i % 5000 === 0 ? `line ${i} ${secret}` : `line ${i} filler text without anything secret in it`)).join('\n');
  let out = '';
  const ms = timeIt(() => {
    out = maskSecrets(text).text;
  });
  configureMasking({ literals: [], patterns: [] });
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms for ${text.length} characters`);
  assert.ok(!out.includes('acme_Qz7'));
  assert.equal(out.split('[REDACTED:tok]').length - 1, 10);
});

test('a custom pattern may span lines: a multi-line secret block is masked', () => {
  configureMasking({ literals: [], patterns: [{ name: 'blk', pattern: 'BEGIN-SECRET\\s+[A-Za-z0-9]{8,32}\\s+END-SECRET' }] });
  const out = maskSecrets('before\nBEGIN-SECRET\n  Abcd1234Efgh5678\nEND-SECRET\nafter').text;
  assert.ok(!out.includes('Abcd1234Efgh5678'));
  assert.equal(out, 'before\n[REDACTED:blk]\nafter');
  // The same block with CRLF line endings.
  assert.ok(!maskSecrets('BEGIN-SECRET\r\nAbcd1234Efgh5678\r\nEND-SECRET').text.includes('Abcd1234'));
  configureMasking({ literals: [], patterns: [] });
});

test('an unsafe or invalid pattern makes configuration fail instead of being skipped silently', () => {
  assert.throws(() => configureMasking({ literals: [], patterns: [{ name: 'evil', pattern: '(a+)+$' }] }), /maskPatterns "evil" cannot be used/);
  assert.throws(() => configureMasking({ literals: [], patterns: [{ name: 'bad', pattern: '[' }] }), /cannot be used/);
  assert.throws(() => configureMasking({ literals: ['abc'], patterns: [] }), /at least 6 characters/);
  // A failed configuration leaves the previous, valid one in place instead of half-applying the new one.
  configureMasking({ literals: [], patterns: [{ name: 'ok', pattern: 'TKT-\\d{6}' }] });
  assert.throws(() => configureMasking({ literals: [], patterns: [{ name: 'ok2', pattern: 'TKT-\\d{6}' }, { name: 'evil', pattern: '(a|a)+$' }] }));
  assert.ok(maskSecrets('see TKT-123456').text.includes('[REDACTED:ok]'));
  configureMasking({ literals: [], patterns: [] });
});

test('a secret that straddles any internal boundary of a long line is still masked', () => {
  configureMasking({ literals: [], patterns: [{ name: 'tok', pattern: 'acme_[A-Za-z0-9]{32}' }] });
  const secret = `acme_${'Ab3'.repeat(11).slice(0, 32)}`;
  for (const offset of [0, 1, 500, 990, 994, 998, 999, 1000, 1001, 1500, 1999, 2000, 2001, 5000]) {
    const line = `${'x'.repeat(offset)}${secret}${'y '.repeat(50)}`;
    const out = maskSecrets(line).text;
    assert.ok(!out.includes('acme_Ab3'), `leaked at offset ${offset}`);
    assert.ok(out.includes('[REDACTED:tok]'), `not redacted at offset ${offset}`);
  }
  configureMasking({ literals: [], patterns: [] });
});

test('a pattern that is slow on some input times out and fails closed instead of hanging or leaking', () => {
  // (?:\\s|[^x]) overlaps with the neighbouring classes; this is the slowest shape the validator still accepts.
  const pattern = '[^x]{3,}[^x]{1,64}(?:\\s|[^x])[^x]{1,8}a';
  assert.equal(checkMaskPattern(pattern), null);
  configureMasking({ literals: [], patterns: [{ name: 'slow', pattern }] });
  const input = 'k'.repeat(LINE * 3);
  let out = '';
  const ms = timeIt(() => {
    out = maskSecrets(input).text;
  });
  configureMasking({ literals: [], patterns: [] });
  assert.ok(ms < 2500, `took ${ms.toFixed(0)} ms`);
  assert.ok(!out.includes('kkkkkkkk'), 'unscanned text must not pass through');
});

test('a hostile file of many slow lines is bounded by the time budget and the unscanned rest is redacted, not passed through', () => {
  const pattern = '[^x]{3,}[^x]{1,64}(?:\\s|[^x])[^x]{1,8}a';
  configureMasking({ literals: [], patterns: [{ name: 'slow', pattern }] });
  const lines = Array.from({ length: 60 }, (_, i) => `${'k'.repeat(LINE)}${i}`);
  let out = '';
  const ms = timeIt(() => {
    out = maskSecrets(lines.join('\n')).text;
  });
  configureMasking({ literals: [], patterns: [] });
  assert.ok(ms < 4000, `took ${ms.toFixed(0)} ms`);
  assert.ok(!out.includes('kkkkkkkk'), 'no scanned-or-unscanned text may pass through');
  assert.equal(out.split('\n').length, 60, 'line structure is preserved');
});

test('anchored patterns: ^ and $ apply per line, wherever the line sits in a long text and however long it is', () => {
  configureMasking({ literals: [], patterns: [{ name: 'start', pattern: '^key:\\s*\\S+$' }, { name: 'end', pattern: 'tok_[A-Za-z0-9]{20}$' }] });
  const secret = 'tok_AbCdEfGhIjKlMnOpQrSt';
  const text = ['plain line', 'key: hunter2value', `mid key: not-at-start`, `${'x'.repeat(2999)} ${secret}`, `${secret} but not at the end`, `${'y'.repeat(998)}`, `key: second`].join('\n');
  const out = maskSecrets(text).text.split('\n');
  assert.equal(out[1], '[REDACTED:start]', '^ matches at the start of a later line');
  assert.equal(out[2], 'mid key: not-at-start', '^ does not match mid-line');
  assert.ok(out[3]?.endsWith('[REDACTED:end]') && !out[3].includes('tok_AbCd'), '$ matches at the end of a 3000-character line');
  assert.ok(out[4]?.includes(secret), 'a $-anchored pattern does not match when the secret is not at the end (the built-in rules decide that case)');
  assert.equal(out[6], '[REDACTED:start]');
  configureMasking({ literals: [], patterns: [] });
});

test('anchored patterns still match with CRLF line endings and keep them', () => {
  configureMasking({ literals: [], patterns: [{ name: 'a', pattern: '^key:\\s*\\S+$' }, { name: 'b', pattern: 'tok_[A-Za-z0-9]{20}$' }] });
  const out = maskSecrets('key: abc\r\nx tok_AbCdEfGhIjKlMnOpQrSt\r\nend').text;
  assert.equal(out, '[REDACTED:a]\r\nx [REDACTED:b]\r\nend');
  configureMasking({ literals: [], patterns: [] });
});

test('every boundary offset, anchored or not, is masked: secret immediately before, at and after 1000 and 2000 characters', () => {
  configureMasking({ literals: [], patterns: [{ name: 'tok', pattern: 'acme_[A-Za-z0-9]{32}' }, { name: 'tail', pattern: 'end_[a-z]{8}$' }] });
  const secret = `acme_${'Qz7'.repeat(11).slice(0, 32)}`;
  for (const center of [1000, 2000]) {
    for (let offset = center - 40; offset <= center + 3; offset += 1) {
      const out = maskSecrets(`${'.'.repeat(offset)}${secret} tail`).text;
      assert.ok(!out.includes('acme_Qz7'), `leaked at ${offset}`);
    }
    const anchored = maskSecrets(`${'.'.repeat(center - 4)}end_abcdefgh`).text;
    assert.ok(!anchored.includes('end_abcdefgh'), `anchored secret leaked near ${center}`);
  }
  configureMasking({ literals: [], patterns: [] });
});
