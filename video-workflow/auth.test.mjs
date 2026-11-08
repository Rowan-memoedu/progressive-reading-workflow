import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedNetscapeCookies } from './run-authenticated.mjs';

test('site cookies exclude other sites, expired and partitioned credentials', () => {
  const cookie = { domain: 'bilibili.com', name: 'synthetic', value: 'fixture-value', path: '/',
    hostOnly: false, secure: true, session: true };
  const result = scopedNetscapeCookies([
    cookie, { ...cookie, domain: 'unrelated.example' }, { ...cookie, domain: 'bilibili.com.attacker.example' },
    { ...cookie, partitionKey: { topLevelSite: 'https://example.org' } },
    { ...cookie, session: false, expirationDate: 10 }
  ], 'www.bilibili.com', 20);
  assert.equal(result.count, 1);
  assert.ok(result.text.includes('.bilibili.com\tTRUE\t/\tTRUE\t0\tsynthetic\tfixture-value'));
});

test('control characters are rejected before a credential file can be written', () => {
  assert.throws(() => scopedNetscapeCookies([{ domain: 'bilibili.com', name: 'synthetic', value: 'x\ty',
    hostOnly: false, session: true }], 'www.bilibili.com'), /unsafe_cookie_field/u);
});
