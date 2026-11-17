import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSecrets } from '../src/core/security/masker.js';

const redacts = (input: string, secret: string) => {
  const { text, count } = maskSecrets(input);
  assert.ok(!text.includes(secret), `leaked: ${text}`);
  assert.ok(count > 0);
};

test('redacts unquoted inline secret assignments', () => {
  redacts('use password=hunter2hunter2 for the db', 'hunter2hunter2');
  redacts('use password: hunter2hunter2 for the db', 'hunter2hunter2');
  redacts('set DB_PASSWORD=hunter2hunter2 then run it', 'hunter2hunter2');
  redacts('the apiKey=abcd1234efgh5678 is in the vault', 'abcd1234efgh5678');
  redacts('pass --token=abcd1234efgh5678ijkl to the CLI', 'abcd1234efgh5678ijkl');
  redacts('password=correcthorsebatterystaple', 'correcthorsebatterystaple');

  const { text } = maskSecrets('Set password=hunter2hunter2. Then continue.');
  assert.ok(!text.includes('hunter2hunter2'));
  assert.ok(text.endsWith('.'));
});

test('does not redact ordinary inline values or environment references', () => {
  const inputs = [
    'the password: string field is required',
    'read token=process.env.API_TOKEN at startup',
    'set password=${DB_PASSWORD} in compose',
    'rename secret=<your-secret-here> before use',
    'a passwordless login flow',
  ];

  for (const input of inputs) {
    const { text, count } = maskSecrets(input);
    assert.equal(text, input, `unexpected modification: ${input}`);
    assert.equal(count, 0, `unexpected redaction: ${input}`);
  }
});
