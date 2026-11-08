import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { links, eligible, advance, verifyReceipt, startImportService } from './bot-reading-service.mjs';
import { LiveCookieSnapshot, COOKIE_SYNC_EXTENSION_ID } from './live-cookie-snapshot.mjs';

test('text links, tracking dedupe, Weixin parameters and private URLs', () => {
  assert.deepEqual(links('看看 https://example.org/a?utm_source=qq。 https://example.org/a'), ['https://example.org/a']);
  assert.equal(links('https://mp.weixin.qq.com/s?__biz=abc&mid=12&idx=1&sn=xyz').length, 1);
  assert.deepEqual(links('http://127.0.0.1/a http://192.168.1.1/ https://user:pass@example.org'), []);
});
test('only configured private inbound peers and new messages qualify', () => {
  const config = { since: '2026-09-10T00:00:00Z', allowedSenders: { qq: ['owner'], weixin: ['owner'] } };
  const row = { direction: 'inbound', user_openid: 'owner', received_at: '2026-09-10T01:00:00Z' };
  assert.equal(eligible(row, 'qq', config), true);
  for (const change of [{ user_openid: 'stranger' }, { direction: 'outbound' }, { group_openid: 'group' }, { received_at: '2026-08-24T00:00:00Z' }])
    assert.equal(eligible({ ...row, ...change }, 'qq', config), false);
});
test('uncertain POST replay keeps its key; success requires actual artifact and matching hash', async () => {
  const directory = await fs.mkdtemp('D:/Artifacts/bot-reading-test-');
  const artifact = path.join(directory, 'article.md');
  const body = '# Independent test\n\nMeaningful fixture body.\n';
  await fs.writeFile(artifact, body);
  const receipt = { request_id: 'r1', terminal: true, status: 'completed', imported: 1, failed: 0, degraded: 0,
    results: [{ artifacts: [{ kind: 'markdown', path: artifact, sha256: createHash('sha256').update(body).digest('hex') }] }] };
  const item = { url: 'https://example.org/a', clientId: 'stable-key', status: 'processing' };
  const calls = [];
  let first = true;
  const request = async (url, payload) => {
    if (payload) { calls.push(payload); if (first) { first = false; throw new Error('network_uncertain'); } return receipt; }
    return receipt;
  };
  await assert.rejects(advance(item, 'http://127.0.0.1:1', directory, request));
  const result = await advance(item, 'http://127.0.0.1:1', directory, request);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].user_instruction, '');
  assert.equal((await verifyReceipt({ ...receipt, terminal: false }, directory)).status, 'processing');
  assert.equal((await verifyReceipt({ ...receipt, failed: 1 }, directory)).status, 'failed');
  await fs.writeFile(artifact, 'changed');
  assert.equal((await verifyReceipt(receipt, directory)).status, 'unresolved');
  // Keep the tiny fixture under Artifacts as repeatable evidence; no production writes.
});

test('Bot cold start preserves live sync despite a missing legacy pointer, including the next restart', async () => {
  const directory = await fs.mkdtemp('D:/Artifacts/ProgressiveReading/auth-tests/bot-launch-');
  const workflowRoot = path.join(directory, 'workflow');
  const dataRoot = path.join(directory, 'credentials');
  await fs.mkdir(path.join(workflowRoot, 'config'), { recursive: true });
  await fs.mkdir(path.join(workflowRoot, '.local-ir'), { recursive: true });
  await fs.copyFile(new URL('../config/import-destination-routes.json', import.meta.url), path.join(workflowRoot, 'config/import-destination-routes.json'));
  await fs.writeFile(path.join(workflowRoot, '.local-ir/cookie-snapshot.path'), path.join(directory, 'missing-manual.json'));
  const source = new LiveCookieSnapshot({ workflowRoot, dataRoot });
  await source.accept({ schema: 'local.chrome-cookie-snapshot', schemaVersion: 1, sensitivity: 'local_sensitive_credential',
    snapshotId: crypto.randomUUID(), generatedAt: stampForTest(),
    producer: { name: 'chrome-cookie-sync-extension', version: '1.1.0', api: 'chrome.cookies.getAll', partitionQuery: 'all_partition_keys' },
    profile: { browser: 'Google Chrome', scope: 'current_regular_profile', storeIds: ['0'] }, cookies: []
  }, `chrome-extension://${COOKIE_SYNC_EXTENSION_ID}`);
  const env = { ...process.env, NODE_ENV: 'test', PROGRESSIVE_READING_WORKFLOW_ROOT: workflowRoot,
    PROGRESSIVE_READING_APP_PORT: '0', PROGRESSIVE_READING_WRITE_SERVER_INFO: 'false',
    PROGRESSIVE_READING_COOKIE_DATA_ROOT: dataRoot, PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH: '',
    PROGRESSIVE_READING_URL_COOKIE_MAP_JSON: '', PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER: 'synthetic',
    LEARNING_PROJECT_ROOT: path.join(directory, 'learning') };
  const checks = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = startImportService(env); let output = '';
    child.stdout.on('data', bytes => { output += bytes.toString(); });
    child.stderr.on('data', () => {});
    try {
      let base;
      for (let i = 0; i < 300; i++) {
        base = output.match(/Progressive reading app: (http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
        if (base || child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(base, 'Bot launcher must start the isolated shared service');
      const response = await fetch(base + '/api/browser-import/cookies/status', { signal: AbortSignal.timeout(5000) });
      const health = await response.json();
      assert.equal(health.receiver_enabled, true);
      assert.equal(health.mode, 'chrome_live_sync');
      assert.equal(health.loaded, true);
      assert.equal(health.error, null);
      checks.push(attempt ? 'restart_keeps_live_receiver' : 'cold_start_keeps_live_receiver');
    } finally {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill(); await closed;
    }
  }
  await fs.writeFile(path.join(directory, 'acceptance.json'), JSON.stringify({ status: 'passed', production_credentials_read: false, checks }, null, 2));
});

function stampForTest() { return new Date().toISOString(); }
