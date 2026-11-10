import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import {fetchArticleContent,originalArticleTarget,ARTICLE_EXTRACTION_VERSION} from '../rss-source/article-fetch.mjs';
import {parseFeedDocument,extractArticleMarkdown,syncFeedDocument} from '../rss-source/core.mjs';

const rich='## 方法与边界\n\n**先验证条件**，再查看[完整说明](https://example.test/details)。\n\n'+
  '> 这一结论只适用于上述范围。\n\n- 检查输入\n- 保存输出\n\n'+
  '![示意图](https://example.test/image.png)\n\n```js\nconst limit = 4;\n```\n\n'+
  '| 条件 | 结果 |\n| --- | --- |\n| 成立 | 保留 |\n\n'+ '正文解释与实例。'.repeat(30);
const url='https://kirigaya.cn/api/rss/blog?seq=17';
const lean='<html><head><title>格式样例</title></head><body><article><h1>格式样例</h1><p>'+ '正文解释与实例。'.repeat(30)+'</p></article></body></html>';
const record=(overrides={})=>({code:200,data:{seq:17,isPrivate:false,name:'格式样例',text:gzipSync(rich).toString('base64'),...overrides}});
const fetched=(text,url)=>({text,finalUrl:url,response:{status:200}});
const mock=payload=>async target=>fetched(target===url?lean:JSON.stringify(payload),target);
const feed=`<rss version="2.0"><channel><title>样例订阅</title><link>https://kirigaya.cn/</link><item><guid>article-17</guid><title>格式样例</title><link>${url}</link><description>正文摘要</description></item></channel></rss>`;

test('original article resolution is narrowly scoped and retains the Markdown source exactly',async()=>{
  for(const other of ['https://kirigaya.cn.attacker.invalid/api/rss/blog?seq=17','https://kirigaya.cn:444/api/rss/blog?seq=17','https://kirigaya.cn/api/rss/blog?seq=bad','https://example.test/article'])assert.equal(originalArticleTarget(other),null);
  const actual=await fetchArticleContent(url,mock(record()));
  assert.equal(actual.markdown,rich);
  assert.equal(actual.original.url,'https://kirigaya.cn/blog/article?seq=17');
  assert.equal(actual.extraction_version,ARTICLE_EXTRACTION_VERSION);
  let calls=0;
  await fetchArticleContent('https://example.test/article',async target=>{calls++;return fetched(lean,target);});
  assert.equal(calls,1);
});

test('a public original must match the requested identity and remain readable; failures do not flatten the RSS page',async()=>{
  for(const data of [record({seq:18}),record({isPrivate:true}),record({text:''}),record({text:'H4sIbroken!'}),{code:403,data:null}]){
    await assert.rejects(fetchArticleContent(url,mock(data)));
  }
  await assert.rejects(fetchArticleContent(url,async target=>target===url?fetched(lean,target):fetched(JSON.stringify(record()),'https://other.test/article')),/origin_changed/u);
});

test('RSS HTML fragments retain headings, links, emphasis, lists, tables, code, images and formulas',async()=>{
  const html='<h2>完整标题</h2><p><strong>强调重点</strong>与<em>条件</em>，参考<a href="./details">说明</a>。</p>'+
    '<blockquote>原文引述。</blockquote><ul><li>第一步</li><li>第二步</li></ul>'+
    '<p><img src="/figure.png" alt="配图"></p><pre><code class="language-js">const value = 2;</code></pre>'+
    '<table><thead><tr><th>输入</th><th>输出</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p>公式 $x_i^2$。</p>';
  const xml=`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>多格式</title><link>https://other.test/</link><item><title>样例</title><link>https://other.test/posts/sample</link><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`;
  const md=(await parseFeedDocument(xml,'https://other.test/feed.xml')).items[0].feed_content.markdown;
  for(const expected of ['## 完整标题','**强调重点**','[说明](https://other.test/posts/details)','![配图](https://other.test/figure.png)','const value = 2;','$x_i^2$','| 输入 | 输出 |','> 原文引述。'])assert.ok(md.includes(expected),expected);
  assert.match(md,/^-\s+第一步$/mu);assert.match(md,/```js\n/u);assert.match(md,/[_*]条件[_*]/u);
  const article=extractArticleMarkdown('<html><body><article>'+html+'<p>'+'完整文章。'.repeat(100)+'</p></article></body></html>','https://other.test/posts/sample');
  assert.ok(article.markdown.includes('**强调重点**'));
  assert.ok(article.markdown.includes('[说明](https://other.test/posts/details)'));
});

test('format refresh keeps the original material identity and freezes the previous preprocessing request',async()=>{
  const artifacts='D:/Artifacts/ProgressiveReading/richtext-20261108/tests';await fs.mkdir(artifacts,{recursive:true});
  const root=await fs.mkdtemp(path.join(artifacts,'source-'));
  const first=await syncFeedDocument({feedUrl:'https://kirigaya.cn/rss.xml',xml:feed,outputRoot:root,fetchFulltext:true,
    articleFetcher:async()=>({...await fetchArticleContent(url,mock(record())),markdown:'正文解释与实例。'.repeat(30)})});
  const item=first.items[0],packageFile=path.join(item.package_path,'package.json');
  const old=JSON.parse(await fs.readFile(packageFile,'utf8'));
  const oldRequest=path.join(item.package_path,old.artifacts.preprocess_request),saved=await fs.readFile(oldRequest,'utf8');
  delete old.receipt.fulltext_evidence.extraction_version;old.receipt.fulltext_evidence.source_ref='item-page-readability';
  await fs.writeFile(packageFile,JSON.stringify(old));
  const second=await syncFeedDocument({feedUrl:'https://kirigaya.cn/rss.xml',xml:feed,outputRoot:root,fetchFulltext:true,
    articleFetcher:target=>fetchArticleContent(target,mock(record()))});
  assert.equal(second.items[0].material_id,item.material_id);
  assert.equal(second.items[0].updated_existing_package,true);
  assert.equal(await fs.readFile(oldRequest,'utf8'),saved);
  const current=JSON.parse(await fs.readFile(packageFile,'utf8'));
  assert.match(current.artifacts.preprocess_request,/^revisions\//u);
  const request=JSON.parse(await fs.readFile(path.join(item.package_path,current.artifacts.preprocess_request),'utf8'));
  assert.equal(request.material.markdown,'# 格式样例\n\n'+rich+'\n');
  assert.equal(request.source_metadata.original_url,'https://kirigaya.cn/blog/article?seq=17');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(item.package_path,current.artifacts.raw_original_article),'utf8')),record());
  const schema=JSON.parse(await fs.readFile(new URL('../rss-source/contracts/source-package.v1.schema.json',import.meta.url),'utf8'));
  const validator=new Ajv2020({strict:false}).compile(schema);assert.equal(validator(current),true,JSON.stringify(validator.errors));
  const replay=await syncFeedDocument({feedUrl:'https://kirigaya.cn/rss.xml',xml:feed,outputRoot:root,fetchFulltext:true,articleFetcher:()=>{throw Error('completed rich source must be reused');}});
  assert.equal(replay.items[0].status,'duplicate');
});
