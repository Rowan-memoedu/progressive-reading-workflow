// Reuse the existing local Chrome snapshot and pass only target-site cookies to upstream.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LiveCookieSnapshot } from '../scripts/live-cookie-snapshot.mjs';
import {resolveVideoMode} from './video-mode.mjs';

export function scopedNetscapeCookies(cookies, hostname, now = Date.now() / 1000) {
  const relevant = cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./u, '');
    return (hostname === domain || hostname.endsWith(`.${domain}`))
      && !cookie.partitionKey && (cookie.session || cookie.expirationDate > now);
  });
  const lines = relevant.map(cookie => {
    const domain = cookie.domain.replace(/^\./u, '');
    const fields = [cookie.hostOnly ? domain : `.${domain}`, cookie.hostOnly ? 'FALSE' : 'TRUE',
      cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', cookie.session ? '0' : String(Math.floor(cookie.expirationDate)),
      cookie.name, cookie.value];
    if (fields.some(field => /[\r\n\t]/u.test(field))) throw new Error('unsafe_cookie_field');
    return fields.join('\t');
  });
  return { count: relevant.length, text: '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n' };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/u, '')] = process.argv[i + 1];
  if(process.argv.includes('--help')) {
    console.log('视频处理：默认字幕模式。明确开启图文模式：--type illustrated（或 --type 图文模式）。旧名称 illustrated_strong 仅作显式兼容别名。');
    return;
  }
  const mode=resolveVideoMode(args.type);
  for (const key of ['url', 'output', 'publish']) if (!args[key]) throw new Error(`required_argument:${key}`);
  const url = new URL(args.url);
  if (!['www.bilibili.com', 'www.youtube.com', 'youtu.be'].includes(url.hostname)) throw new Error('unsupported_cookie_target');
  const root = path.dirname(fileURLToPath(import.meta.url));
  const snapshot = new LiveCookieSnapshot({ workflowRoot: path.dirname(root), dataRoot: 'D:/AppData/ProgressiveReading/BrowserAuth' });
  snapshot.refresh({ force: true });
  if (!snapshot.health().loaded || !snapshot.headerForUrl(args.url)) throw new Error('target_login_snapshot_unavailable');
  const cookies = scopedNetscapeCookies(snapshot.jar.cookies, url.hostname === 'youtu.be' ? 'www.youtube.com' : url.hostname);
  if (!cookies.count) throw new Error('target_login_cookies_missing');
  await snapshot.protectDirectory();
  const cookiePath = path.join(snapshot.dataRoot, `videobook-${randomUUID()}.cookies.txt`);
  try {
    await fs.writeFile(cookiePath, cookies.text, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ stage: 'upstream_authenticated_subtitles', cookie_site: url.hostname,
      site_cookie_count: cookies.count, credential_values_exposed: false }));
    const subprocessArgs = ['-NoLogo', '-NoProfile', '-File', path.join(root, 'run-workflow.ps1'),
      '-VideoUrl', args.url, '-CookiesFile', cookiePath, '-OutputDir', args.output, '-PublishPath', args.publish];
    if (args.options) subprocessArgs.push('-OptionsFile', args.options);
    subprocessArgs.push('-OutputType', mode.id);
    if (args.resume === 'true') subprocessArgs.push('-ReuseTranscript');
    if (args['fetch-only'] === 'true') subprocessArgs.push('-FetchOnly');
    const child = spawn('pwsh', subprocessArgs, { stdio: 'inherit', windowsHide: true });
    const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (exitCode !== 0) throw new Error(`authenticated_workflow_exit:${exitCode}`);
  } finally {
    // Only the credential file created by this invocation is removed.
    await fs.unlink(cookiePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
