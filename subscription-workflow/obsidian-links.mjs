import fs from 'node:fs/promises';
import path from 'node:path';
import { codeRoot, readJson } from './config.mjs';
import { directArticle, obsidianReadingLink } from './reading-options.mjs';
import { ensureObsidianVisible } from '../rss-import/obsidian.mjs';

// Obsidian indexes the vault's junction path, which can differ from the source
// workspace path. Resolve the registered vault before constructing open links.
export async function resolveVaultLocation(workflowRoot, registryFile) {
  const registry = await readJson(registryFile,{vaults:{}});
  const actualRoot = await fs.realpath(workflowRoot);
  async function find(folder,depth) {
    let actual;
    try { actual = await fs.realpath(folder); } catch { return null; }
    const relative = path.relative(actual,actualRoot);
    if (relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)) return path.join(folder,relative);
    if (!depth) return null;
    const entries = await fs.readdir(folder,{withFileTypes:true}).catch(()=>[]);
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.') || ['node_modules','_assets','images','附件'].includes(entry.name)) continue;
      const result = await find(path.join(folder,entry.name),depth-1);
      if (result) return result;
    }
    return null;
  }
  const vaults = Object.entries(registry.vaults).sort(([,a],[,b])=>Number(Boolean(b.open))-Number(Boolean(a.open)));
  for (const [id,vault] of vaults) {
    const mapped = await find(vault.path,3);
    if (mapped) return {id,root:vault.path,workflow_path:path.relative(vault.path,mapped)};
  }
  return null;
}

export async function refreshObsidianLinks(paths,items,{vaultRegistry} = {}) {
  if (!vaultRegistry && path.resolve(paths.workflowRoot)!==codeRoot) return;
  const registry = vaultRegistry || path.join(process.env.APPDATA || '', 'obsidian','obsidian.json');
  const location = await resolveVaultLocation(paths.workflowRoot,registry);
  if (!location) return;
  const articles = items.filter(item=>directArticle(item) && item.publication?.status==='published');
  for (const item of articles) {
    const relative = path.relative(paths.workflowRoot,item.publication.path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const file = path.join(location.workflow_path,relative).replaceAll('\\','/');
    item.publication.obsidian_uri = obsidianReadingLink(file,location.id);
  }
  const visibility = path.resolve(paths.workflowRoot)===codeRoot && articles.length
    ? await ensureObsidianVisible(articles.map(item=>({path:item.publication.path})),{vault:location.id}) : null;
  return {vault_id:location.id,article_links:articles.length,visibility};
}
