import { JSDOM } from 'jsdom';
import { unzipSync, gunzipSync } from 'node:zlib';
import { htmlArticleToMarkdown } from '../scripts/browser-page-markdown.mjs';
import { canonicalUrl, digest } from '../subscription-workflow/config.mjs';
import {articleTaxonomy,taxonomyFromJson} from './taxonomy.mjs';

export function scopedUrl(value,base) {
  const url=new URL(value,base),origin=new URL(base);
  if(process.env.NODE_ENV!=='test')canonicalUrl(url.href);
  if(url.origin!==origin.origin)throw new Error('站点发现地址超出当前网站：'+url.origin);
  url.hash='';return url.href;
}
export async function fetchSiteText(url,{base=url,fetchImpl=globalThis.fetch,maxBytes=6*1024*1024}={}) {
  let target=scopedUrl(url,base);
  for(let i=0;i<8;i++){
    const response=await fetchImpl(target,{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html,application/json,application/xml,text/xml,*/*'},redirect:'manual',signal:AbortSignal.timeout(45000)});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw new Error('站点跳转没有目标地址');
      const next=new URL(location,target);
      // A bare hostname commonly redirects to its www origin. Accept only that canonical alias.
      if(next.hostname.replace(/^www\./u,'')===new URL(base).hostname.replace(/^www\./u,'')&&next.protocol==='https:')base=next.origin;
      target=scopedUrl(next.href,base);continue;
    }
    if(!response.ok){await response.body?.cancel();const error=new Error('site_http_'+response.status);error.status=response.status;throw error;}
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new Error('站点响应超过完整读取上限');chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8');
    return {url:target,body,sha256:digest(body),bytes,content_type:response.headers.get('content-type') || ''};
  }
  throw new Error('站点跳转次数过多');
}
export function field(object,key) {
  if(!key || key==='$')return object;
  return key.split('.').reduce((value,part)=>value?.[part],object);
}
export function templateUrl(template,articleUrl,base,item=null) {
  const article=new URL(articleUrl);
  const url=String(template).replace(/\{(query\.[\w-]+|path(?:\.(?:last|\d+))?|item\.[\w.-]+)\}/gu,(_match,key)=>{
    const value=key==='path'?article.pathname:key.startsWith('path.')?article.pathname.split('/').filter(Boolean).at(key==='path.last'?-1:Number(key.slice(5))):key.startsWith('query.')?article.searchParams.get(key.slice(6)):field(item,key.slice(5));
    if(value===null || value===undefined)throw new Error('来源地址模板缺少字段：'+key);
    return encodeURIComponent(value);
  });
  if(/[{}]/u.test(url))throw new Error('来源地址模板含未识别占位符');
  return scopedUrl(url,base);
}
export function decodeBody(value,encoding='plain') {
  if(typeof value!=='string'||!value.trim())throw new Error('article_body_missing');
  if(encoding==='plain')return value;
  const data=Buffer.from(value,'base64');
  if(encoding==='base64')return data.toString('utf8');
  // Browser pako.inflate accepts both zlib and gzip wrappers; preserve that
  // behavior rather than confusing gzip-backed source text with missing content.
  if(encoding==='base64_deflate')return unzipSync(data,{maxOutputLength:8*1024*1024}).toString('utf8');
  if(encoding==='base64_gzip')return gunzipSync(data,{maxOutputLength:8*1024*1024}).toString('utf8');
  throw new Error('正文编码不支持');
}
export async function captureArticle(url,recipe,{fetchPage=fetchSiteText}={}) {
  const source=recipe?.type==='json' ? templateUrl(recipe.url_template,url,url) : url;
  let response;
  try{response=await fetchPage(source,{base:url});}catch(error){if(error.status===404||error.status===410)return {excluded:true,url,reason:'来源已下线',response_status:error.status};throw error;}
  let title='',markdown='',metadata={};
  if(recipe?.type==='json'){
    const json=JSON.parse(response.body);
    if(recipe.private_path&&field(json,recipe.private_path)===true)return {excluded:true,url,reason:'来源标记为私密，未解码正文',response_sha256:response.sha256};
    if(recipe.status_path && recipe.success_values?.length && !recipe.success_values.map(String).includes(String(field(json,recipe.status_path)))){
      const message=String(field(json,recipe.message_path)||'');
      if(/不存在|未找到|已删除|not found|does not exist|deleted/iu.test(message))return {excluded:true,url,reason:message,response_sha256:response.sha256};
      throw new Error('来源接口未返回文章：'+message.slice(0,200));
    }
    if(recipe.identity_path&&recipe.identity_query){
      if(String(field(json,recipe.identity_path))!==new URL(url).searchParams.get(recipe.identity_query))throw new Error('article_source_identity_mismatch');
    }
    title=String(field(json,recipe.title_path)||'').trim();
    const body=decodeBody(field(json,recipe.content_path),recipe.encoding);
    markdown=recipe.content_format==='html'?htmlArticleToMarkdown({html:body,sourceUrl:url,title,extractArticle:false}).markdown:body;
    metadata={published_at:recipe.published_at_path?field(json,recipe.published_at_path):null,taxonomy:taxonomyFromJson(json,{collection_item_identity_path:recipe.identity_path?.split('.').at(-1),...recipe.taxonomy},field,recipe.identity_path?field(json,recipe.identity_path):null)};
  } else {
    let html=response.body;
    if(recipe?.body_selector){
      const dom=new JSDOM(html,{url});try{const body=dom.window.document.querySelector(recipe.body_selector);if(!body)throw new Error('站点指定的正文区域不存在');html=body.outerHTML;title=dom.window.document.title;}finally{dom.window.close();}
    }
    const converted=htmlArticleToMarkdown({html,sourceUrl:url,title,extractArticle:!recipe?.body_selector});
    title=title || converted.title;markdown=converted.markdown;
    if(/^(?:loading[. …]*|正在加载[. …]*)$/iu.test(markdown.trim()) || markdown.replace(/\s/gu,'').length<20)throw new Error('网页未提供可核验正文，需要站点正文接口');
  }
  if(!markdown.trim()||!title)throw new Error('来源缺少完整正文或文章标题');
  if(!metadata.taxonomy){const dom=new JSDOM(response.body,{url});try{metadata.taxonomy=articleTaxonomy({categories:[...dom.window.document.querySelectorAll('a[rel~=category],meta[property="article:section"]')].map(n=>n.content||n.textContent.trim()),tags:[...dom.window.document.querySelectorAll('a[rel~=tag],meta[property="article:tag"]')].map(n=>n.content||n.textContent.trim())});}finally{dom.window.close();}}
  return {url,title,markdown,source_response:{url:response.url,sha256:response.sha256,bytes:response.bytes,content_type:response.content_type},metadata};
}
