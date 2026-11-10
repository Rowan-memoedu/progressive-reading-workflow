import {gunzipSync} from 'node:zlib';

export const ARTICLE_EXTRACTION_VERSION='rss-richtext/v2';

// This site's RSS reader endpoint deliberately flattens its Markdown. The
// public article view loads the original Markdown through this read-only API.
export function originalArticleTarget(itemUrl) {
  const url=new URL(itemUrl);
  if(url.protocol!=='https:' || url.hostname!=='kirigaya.cn' || url.port || url.pathname!=='/api/rss/blog')return null;
  const seq=url.searchParams.get('seq');
  if(!/^[1-9]\d*$/u.test(seq || ''))return null;
  return {seq,api:new URL('/api/blog/fetch-blog-by-seq?seq='+seq,url).href,
    page:new URL('/blog/article?seq='+seq,url).href};
}

export async function fetchArticleContent(itemUrl,fetchPage) {
  const page=await fetchPage(itemUrl,{maxBytes:12*1024*1024});
  const target=originalArticleTarget(itemUrl);
  const result={html:page.text,response:{status:page.response.status,final_url:page.finalUrl || itemUrl}};
  if(!target)return result;
  const original=await fetchPage(target.api,{maxBytes:12*1024*1024});
  const responseUrl=new URL(original.finalUrl || target.api);
  if(responseUrl.origin!==new URL(target.api).origin)throw new Error('original_article_origin_changed');
  const record=JSON.parse(original.text);
  if(record.code!==200)throw new Error('original_article_unavailable_'+(/^\d+$/u.test(String(record.code))?record.code:'unknown'));
  if(!record.data || String(record.data.seq)!==target.seq
    || record.data.isPrivate!==false || typeof record.data.text!=='string')throw new Error('original_article_identity_or_access_invalid');
  let markdown=record.data.text;
  if(markdown.startsWith('H4sI')) {
    if(!/^[A-Za-z0-9+/=\r\n]+$/u.test(markdown))throw new Error('original_article_encoding_invalid');
    markdown=new TextDecoder('utf-8',{fatal:true}).decode(gunzipSync(Buffer.from(markdown,'base64'),{maxOutputLength:12*1024*1024}));
  }
  if(!markdown.trim())throw new Error('original_article_empty');
  return {...result,markdown:markdown.replace(/\r\n/gu,'\n').trim(),title:record.data.name,
    extraction_version:ARTICLE_EXTRACTION_VERSION,
    original:{url:target.page,api:target.api,raw:original.text,
      response:{status:original.response.status,final_url:original.finalUrl || target.api},format:'markdown'}};
}
