import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataPath, artifactPath } from '../scripts/runtime-paths.mjs';

test('explicit portable roots reach subscription, RSS, video and credential consumers', () => {
  const data = path.join(os.tmpdir(), 'pr-portable-fixture', 'data');
  const artifacts = path.join(os.tmpdir(), 'pr-portable-fixture', 'artifacts');
  const script = `
    const {HOME,paths}=await import('./subscription-workflow/config.mjs');
    const {DEFAULT_HOME}=await import('./rss-import/config.mjs');
    const {defaultCookieDataRoot}=await import('./scripts/live-cookie-snapshot.mjs');
    const {WATCH_ARTIFACTS}=await import('./video-workflow/watch-process.mjs');
    console.log(JSON.stringify([HOME,DEFAULT_HOME,defaultCookieDataRoot('.'),paths().artifactRoot,WATCH_ARTIFACTS]));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PROGRESSIVE_READING_DATA_HOME: data, PROGRESSIVE_READING_ARTIFACT_HOME: artifacts, NODE_ENV: 'production', PROGRESSIVE_READING_COOKIE_DATA_ROOT: '' }
  }));
  assert.deepEqual(result, [path.join(data, 'ProgressiveReading', 'Subscriptions'), path.join(data, 'RSSImport'),
    path.join(data, 'ProgressiveReading', 'BrowserAuth'), path.join(artifacts, 'ProgressiveReading', 'subscriptions'), path.join(artifacts, 'ProgressiveReading', 'video-watch')]);
});

test('runtime storage defaults stay absolute and outside the source root', () => {
  const source = path.resolve(import.meta.dirname, '..');
  for (const directory of [dataPath('ProgressiveReading'), artifactPath('ProgressiveReading')]) {
    assert.ok(path.isAbsolute(directory));
    assert.ok(!directory.startsWith(source + path.sep));
  }
});
