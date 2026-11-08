import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function includesPublication(source, publishedAt) {
  if (source?.history_mode !== 'since') return true;
  const published = Date.parse(publishedAt);
  return Number.isFinite(published) && published >= Date.parse(source.earliest_date + 'T00:00:00+08:00');
}

export async function retainedFeedSnapshots(root, rssHome, feedUrl) {
  const list = async dir => fs.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const key = createHash('sha256').update(feedUrl).digest('hex').slice(0, 16);
  const automatic = path.join(rssHome, 'feeds', key);
  const snapshots = (await list(automatic)).filter(entry => entry.isFile() && entry.name.endsWith('.xml'))
    .map(entry => path.join(automatic, entry.name));
  const runs = path.join(root, 'imports', 'rss', 'source-v1', 'runs');
  for (const entry of await list(runs)) {
    if (!entry.isDirectory()) continue;
    const raw = path.join(runs, entry.name, 'raw');
    const response = await fs.readFile(path.join(raw, 'response.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!response) continue;
    const metadata = JSON.parse(response);
    if (metadata.requested_url !== feedUrl && metadata.final_url !== feedUrl) continue;
    for (const file of await list(raw)) {
      if (file.isFile() && /^feed\.(?:rss|atom)\.xml$/u.test(file.name)) snapshots.push(path.join(raw, file.name));
    }
  }
  const dated = await Promise.all(snapshots.map(async file => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
  return dated.sort((a, b) => b.mtime - a.mtime).map(entry => entry.file);
}
