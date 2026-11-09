import path from 'node:path';
import { videoId, canonicalUrl, biliApi, itemKey, entryPublication } from '../video-workflow/watch-core.mjs';
import { existingPublications } from '../video-workflow/watch.mjs';
import { processWatchItem } from '../video-workflow/watch-process.mjs';
import { WATCH_WORKFLOW, WATCH_MODEL, WATCH_FRAME_POLICY } from '../video-workflow/watch-illustrated.mjs';

// One-off requests use the subscription worker, without registering a source
// or expanding a selected part into the video's other parts or collection.
export function normalizeVideoRequest(root, input) {
  const bvid = videoId(input.url);
  const selected = input.parts ?? [Number(new URL(input.url).searchParams.get('p') || 1)];
  if (!Array.isArray(selected) || !selected.length || selected.length > 200
      || selected.some(part => !Number.isSafeInteger(part) || part < 1)) throw new Error('请提供有效的分 P 编号数组');
  const parts = [...new Set(selected)].sort((a,b) => a-b);
  const destination = String(input.destination || '视频');
  const reading = path.resolve(root, '阅读区'), target = path.resolve(reading, destination);
  const relative = path.relative(reading, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('视频目标必须位于阅读区的子文件夹');
  return { url: canonicalUrl(bvid), bvid, parts, destination: relative.replaceAll('\\','/'), output_type:'illustrated' };
}

export async function runVideoRequest(root, input, step, {
  api = biliApi, existing = existingPublications, processItem = processWatchItem, onProgress = async()=>{}
} = {}) {
  const request = normalizeVideoRequest(root, input);
  const watch = { workflow:WATCH_WORKFLOW, body_mode:'strong_structuring', media_policy:'generated_and_reviewed',
    frame_policy:WATCH_FRAME_POLICY, provider:'codex_exec', model:WATCH_MODEL, part_unit:'individual' };
  const items = await step('video-parts', async () => {
    const view = await api('x/web-interface/view?bvid='+request.bvid);
    if (view.bvid !== request.bvid || !Array.isArray(view.pages)) throw new Error('视频来源身份不匹配');
    return request.parts.map(part => {
      const page = view.pages.find(page => page.page === part);
      if (!page || !Number.isSafeInteger(page.cid)) throw new Error('视频没有 P'+part);
      const item = { key:itemKey(request.bvid,page.cid), bvid:request.bvid, cid:page.cid, part, parts:view.pages.length,
        video_title:view.title, part_title:page.part, duration:page.duration, url:canonicalUrl(request.bvid,part) };
      item.publish_path = entryPublication(path.resolve(root,'阅读区',request.destination),item);
      return item;
    });
  });
  if (!Array.isArray(items) || items.length !== request.parts.length
      || items.some((item,index) => item.part !== request.parts[index] || item.bvid !== request.bvid
        || item.url !== canonicalUrl(request.bvid,item.part) || item.key !== itemKey(item.bvid,item.cid))) {
    throw new Error('保存的分 P 清单与本次请求不匹配');
  }
  const publications = await existing(), results = [];
  for (const item of items) {
    const result = await step('video-P'+item.part, async () => {
      const published=publications.get(item.url);
      try {
        const result=await processItem(published ? {...item,publish_path:published,resume_mode:'verification_only'} : item,
          watch,{onProgress:event=>onProgress({part:item.part,...event})});
        return published ? {...result,reused:true} : result;
      } catch (error) {
        const reason=error.stderr ? String(error.stderr).trim().split(/\r?\n/u).at(-1) : String(error.message);
        return { status:'blocked', reason:reason.slice(0,1000) };
      }
    });
    results.push({ part:item.part, url:item.url, title:item.part_title, ...result });
  }
  const faults = results.filter(result => result.status !== 'completed')
    .map(result => ({ title:result.title, url:result.url, part:result.part, error:result.reason || result.status }));
  return { status:faults.length === results.length ? 'blocked' : faults.length ? 'completed_with_issues' : 'completed', results, faults };
}
