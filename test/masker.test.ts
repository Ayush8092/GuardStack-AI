import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSecrets } from '../src/core/security/masker.js';

const redacts = (input: string, secret: string) => {
  const { text, count } = maskSecrets(input);
  assert.ok(!text.includes(secret), `leaked: ${text}`);
  assert.ok(count > 0);
};

test('redacts well-known key formats', () => {
  redacts('key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE');
  redacts('ghp_' + 'a'.repeat(36), 'a'.repeat(36));
  redacts('AIza' + 'B'.repeat(35), 'B'.repeat(35));
  redacts('gsk_' + 'c'.repeat(30), 'c'.repeat(30));
  redacts('sk-ant-' + 'd'.repeat(40), 'd'.repeat(40));
  redacts('xoxb-1234567890-abcdef', '1234567890-abcdef');
});

test('redacts JWTs, bearer tokens and private keys', () => {
  redacts('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0');
  redacts('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123');
  redacts('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA');
});

test('redacts credentials in URLs and quoted assignments', () => {
  redacts('postgres://admin:hunter2pass@db.local/app', 'hunter2pass');
  redacts('const apiKey = "not-a-real-but-long-value"', 'not-a-real-but-long-value');
  redacts("password: 'correct horse battery'", 'correct horse battery');
});

test('redacts .env style lines but keeps variable names', () => {
  const { text } = maskSecrets('DB_PASSWORD=supersecretvalue\nPORT=3000');
  assert.ok(text.includes('DB_PASSWORD='));
  assert.ok(!text.includes('supersecretvalue'));
  assert.ok(text.includes('PORT=3000'));
});

test('redacts the value of secret-looking environment variables', () => {
  process.env.TEST_API_KEY = 'live-value-123456789';
  redacts('calling with live-value-123456789 now', 'live-value-123456789');
  delete process.env.TEST_API_KEY;
});

test('leaves ordinary code alone', () => {
  const code = [
    'const apiKey = process.env.API_KEY;',
    'const token: string = getToken();',
    'function authenticate(user: User) {}',
    "const label = 'hello world';",
  ].join('\n');
  const { text, count } = maskSecrets(code);
  assert.equal(count, 0);
  assert.equal(text, code);
});

test('is idempotent', () => {
  const once = maskSecrets('gsk_' + 'x'.repeat(30)).text;
  assert.equal(maskSecrets(once).text, once);
});

test('stays fast on long identifier-like input', () => {
  const start = Date.now();
  maskSecrets('a'.repeat(8000));
  maskSecrets('token_'.repeat(1300));
  assert.ok(Date.now() - start < 1000);
});
