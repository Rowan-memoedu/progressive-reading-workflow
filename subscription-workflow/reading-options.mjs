import path from 'node:path';
import sanitizeFilename from 'sanitize-filename';

export function readingOptions(source = {}) {
  return { direct_reading:source.direct_reading === true, translation_mode:source.translation_mode || 'terminology', generate_guide:source.generate_guide === true };
}

export function readingSource(config, item) {
  return config.subscriptions.find(source=>source.mode === 'reports' && item.subscription_ids?.includes(source.id))
    || config.subscriptions.find(source=>source.mode === 'reports' && source.url === item.feed_url);
}

export function directArticle(item) {
  return Boolean(item && item.platform !== 'bilibili' && item.route === 'long_review' && item.reading_options?.direct_reading === true);
}

export function obsidianReadingLink(file,vault = null) {
  const encoded = encodeURIComponent(file).replaceAll('(','%28').replaceAll(')','%29');
  return 'obsidian://open?'+(vault ? 'vault='+encodeURIComponent(vault)+'&file=' : 'path=')+encoded+'&paneType=tab';
}
export function readingDestination(item) {
  const categories={rss:'RSS',zhihu_column:'知乎专栏',zhihu_author:'知乎作者',bilibili_collection:'B站合集',bilibili_video:'B站多P视频'};
  const kind=item.subscription_kind || (categories[item.platform] ? item.platform : item.platform==='bilibili'
    ? item.video?.watch?.collection ? 'bilibili_collection' : 'bilibili_video' : item.platform==='zhihu' ? 'zhihu_column' : 'rss');
  let fallback='未命名订阅';try{fallback=new URL(item.feed_url || item.item_url || item.url).hostname;}catch{}
  const source=sanitizeFilename(item.subscription_name || item.name || fallback).trim().slice(0,100) || fallback;
  const configured=String(item.destination || '').replaceAll('\\','/').replace(/\/$/u,'');
  const base=configured.startsWith('订阅/') ? configured : path.join('订阅',categories[kind] || '其他来源');
  return path.basename(base)===source ? path.normalize(base) : path.join(base,source);
}
