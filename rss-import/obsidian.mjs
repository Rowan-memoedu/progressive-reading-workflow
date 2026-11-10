import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Resolve through the open vault's existing folders, including directory junctions.
// Reconciliation updates Obsidian's index only; it never rewrites the Markdown.
export async function reconcileInVault(absolutePaths, app, nodePath, nodeFs) {
  const folders = [app.vault.getRoot(), ...app.vault.getAllLoadedFiles().filter(file => Array.isArray(file.children))];
  const resolved = new Map();
  const files = [];
  for (const absolutePath of absolutePaths) {
    const names = new Set();
    for (let current = nodePath.dirname(absolutePath);;) {
      names.add(nodePath.basename(current));
      const parent = nodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // A vault can contain tens of thousands of generated folders. Do not run
    // synchronous filesystem probes across that entire tree on its UI thread.
    const candidates = folders.filter(folder => names.has(folder.name) || folder.path.split('/').length <= 2)
      .sort((a,b)=>a.path.split('/').length-b.path.split('/').length);
    let match = null;
    for (const folder of candidates) {
      try {
        if (!resolved.has(folder.path)) resolved.set(folder.path, nodeFs.realpathSync(app.vault.adapter.getFullPath(folder.path)));
        const real = resolved.get(folder.path);
        const relative = nodePath.relative(real, absolutePath);
        if (relative === '..' || relative.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(relative)) continue;
        if (!match || real.length > match.real.length) match = {real, folder, relative};
        if (nodePath.dirname(absolutePath) === real) break;
      } catch {}
    }
    if (!match) { files.push({absolute_path:absolutePath,status:'vault_path_unresolved'}); continue; }
    const vaultPath = [match.folder.path === '/' ? '' : match.folder.path, match.relative.split(nodePath.sep).join('/')].filter(Boolean).join('/');
    let reconciled = false;
    if (!app.vault.getAbstractFileByPath(vaultPath)) {
      if (typeof app.vault.adapter.reconcileFile !== 'function') {
        files.push({absolute_path:absolutePath,path:vaultPath,status:'index_refresh_unavailable'}); continue;
      }
      await app.vault.adapter.reconcileFile(vaultPath, vaultPath);
      reconciled = true;
    }
    const entry = app.vault.getAbstractFileByPath(vaultPath);
    files.push({absolute_path:absolutePath,path:vaultPath,status:entry && !Array.isArray(entry.children) ? 'visible' : 'index_pending',reconciled});
  }
  return {status:files.every(file=>file.status==='visible') ? 'visible' : 'pending',files};
}

export async function ensureObsidianVisible(artifacts, {run = execute, platform = process.platform, vault} = {}) {
  if (platform !== 'win32') return {status:'unsupported_platform'};
  const options = {windowsHide:true,timeout:15000,maxBuffer:1024*1024};
  try {
    const processes = await run('tasklist.exe',['/FI','IMAGENAME eq Obsidian.exe','/FO','CSV','/NH'],options);
    if (!/^"Obsidian\.exe"/imu.test(processes.stdout)) return {status:'app_not_running'};
    const cli = path.join(process.env.LOCALAPPDATA || '', 'Programs','Obsidian','Obsidian.com');
    const source = `(${reconcileInVault.toString()})(${JSON.stringify(artifacts.map(item=>item.path))},app,require('node:path'),require('node:fs')).then(result=>JSON.stringify(result))`;
    const encoded = Buffer.from(source).toString('base64');
    const argument = `code=eval(require('node:buffer').Buffer.from('${encoded}','base64').toString('utf8'))`;
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    // Obsidian.com needs the PowerShell console host on Windows; a direct
    // child_process invocation can wait indefinitely without dispatching the CLI.
    const command = `& ${quote(cli)} ${vault ? quote('vault='+vault)+' ' : ''}eval ${quote(argument)}`;
    const {stdout} = await run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],options);
    const payload = stdout.trim().replace(/^=>\s*/u,'');
    return JSON.parse(payload);
  } catch (error) { return {status:'error',error:error.killed ? 'obsidian_cli_timeout' : String(error.stderr?.trim() || error.code || error.message).slice(0,500)}; }
}
