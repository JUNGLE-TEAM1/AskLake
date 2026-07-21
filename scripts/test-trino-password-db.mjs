#!/usr/bin/env node

import { validateTrinoPasswordDatabase } from './lib/validate-trino-password-db.mjs';

const hash = (cost = '12', fill = 'a') => `$2y$${cost}$${fill.repeat(53)}`;
const valid = `asklake-api:${hash()}\n\nasklake-materializer:${hash('12', 'b')}\n`;
const cases = [
  ['plaintext-two-identities', valid, true],
  ['base64-text', Buffer.from(valid).toString('base64'), false],
  ['third-identity', `${valid}other:${hash('12', 'c')}\n`, false],
  ['duplicate-identity', `asklake-api:${hash()}\nasklake-api:${hash('12', 'b')}\n`, false],
  ['low-cost', `asklake-api:${hash('07')}\nasklake-materializer:${hash('12', 'b')}\n`, false],
  ['malformed-hash', 'asklake-api:not-bcrypt\nasklake-materializer:not-bcrypt\n', false],
];

for (const [name, value, expected] of cases) {
  const passed = validateTrinoPasswordDatabase(value).length === 0;
  if (passed !== expected) {
    console.error(`Trino password DB case failed: ${name}`);
    process.exit(1);
  }
}

console.log(`Trino password DB tests passed (${cases.length} scenarios).`);
