import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {publishedAssetRelative} from './book-folder.mjs';
import { restoreBookMedia } from './restore-book-media.mjs';
import { captionMediaSource, extractBookMedia, projectBookMedia, removeMediaInsertions, verifyBookMedia } from './book-media.mjs';

const diagram = '```mermaid\ngraph LR\n  A["采样 $x$"] --> B["校验"]\n```';
const book = '# 测量\n\n## 校准\n\n*(参考时间: 00:05)*\n\n' + diagram + '\n\n![校准图](images/shot_00_00_05.png)\n\n## 复核\n\n*(参考时间: 00:25)*\n\n![复核图](images/shot_00_00_25.png)';
const inventory = [{path:'images/shot_00_00_05.png'},{path:'images/shot_00_00_25.png'},{path:'unused.pdf'}];
const first = '校准之后再进行采样，以确保每一批样本具有相同的起始条件，并完整记录所有测量结果，以便后续对照。';
const second = '复核时应当同时检查样本编号、仪器读数和原始记录，发现不一致就保留现场，等待确认之后再继续后面的操作。';
const paragraphs = [{start:'00:00:00',text:first},{start:'00:00:20',text:second}];

test('caption source retains native diagrams and inline attachment links before a body call', () => {
  const raw = first+'\n\n'+second;
  const projected = captionMediaSource({markdown:raw,paragraphs,bookMarkdown:book,inventory,slug:'测量'});
  assert.deepEqual(projected.counts,{images:2,mermaid:1});
  assert.equal(removeMediaInsertions(projected.markdown,projected.insertions),raw);
  assert.ok(projected.markdown.indexOf(diagram)<projected.markdown.indexOf(second));
  assert.match(projected.markdown,/!\[校准图\]\(images\/shot_00_00_05.png\)/u);
  assert.doesNotMatch(projected.markdown,/unused\.pdf|来源附件/u);
  assert.deepEqual(verifyBookMedia(projected.markdown,extractBookMedia(book,inventory),'测量'),{images:2,mermaid:1});
  assert.throws(()=>verifyBookMedia(projected.markdown.replace('校验','其他内容'),extractBookMedia(book,inventory),'测量'),/changed/u);
});

test('accepted prose and guide anchors survive a deterministic repair and idempotent replay', () => {
  const target='# 导读\n\n示例\n\n## 正文\n\n## 校准\n\n'+first.replace('校准之后','完成校准之后').replace('，','；')+'\n\n^pr-first\n\n## 复核\n\n'+second+'\n';
  const params={readingMarkdown:target,bookMarkdown:book,inventory,slug:'测量',paragraphs,
    sourceNodes:[{id:'one',text:first},{id:'two',text:second}],
    bodyBlocks:[{source_block_key:'one',markdown:first},{source_block_key:'two',markdown:second}]};
  const output=projectBookMedia(params);
  assert.equal(removeMediaInsertions(output.markdown,output.insertions),target);
  assert.ok(output.markdown.indexOf(diagram)>output.markdown.indexOf('^pr-first'));
  assert.ok(output.placements.some(p=>p.method==='source_block_exact_spans'));
  const replay=projectBookMedia({...params,readingMarkdown:output.markdown});
  assert.equal(replay.markdown,output.markdown);
  assert.equal(replay.insertions.length,0);
  assert.throws(()=>projectBookMedia({...params,readingMarkdown:'正文完全不同，没有足够的连续文字证据。'}),/ambiguous/u);
});

test('literal fence parsing ignores examples, handles CRLF, and rejects unanchored or missing media', () => {
  const example='~~~~text\n![不是图片](absent.png)\n```mermaid\nA-->B\n```\n~~~~\n';
  assert.equal(extractBookMedia(example,[]).length,0);
  const crlf=book.replace(/\n/gu,'\r\n');
  assert.equal(extractBookMedia(crlf,inventory)[0].literal,diagram.replace(/\n/gu,'\r\n'));
  assert.throws(()=>extractBookMedia('![图](missing.png)',inventory),/missing_asset/u);
  assert.throws(()=>extractBookMedia('![图](cover.png)',[{path:'cover.png'}]),/no_time_anchor/u);
  assert.throws(()=>extractBookMedia('```mermaid\nA-->B',[]),/unclosed/u);
});

test('repair copies absent companion assets beside the reading file and rejects changed retained files', async () => {
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/book-media-files-');
  const source=path.join(root,'source');
  const reading=path.join(root,'reading','测量','测量.md');
  await fs.mkdir(path.join(source,'images'),{recursive:true});
  await fs.mkdir(path.dirname(reading),{recursive:true});
  const files={'book.md':book,'images/shot_00_00_05.png':'fixture A','images/shot_00_00_25.png':'fixture B','unused.pdf':'retained unused'};
  const records=[];
  for(const [name,value] of Object.entries(files)) {
    await fs.writeFile(path.join(source,name),value);
    records.push({path:name,bytes:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')});
  }
  await fs.writeFile(path.join(source,'source.json'),JSON.stringify({files:records}));
  await fs.writeFile(reading,'# 测量\n\n## 正文\n\n'+first+'\n\n'+second+'\n');
  const captions=path.join(root,'captions.json');
  const sourceResult=path.join(root,'source-result.json');
  await fs.writeFile(captions,JSON.stringify({paragraphs}));
  await fs.writeFile(sourceResult,JSON.stringify({artifacts:{cleaning_manifest:{source_nodes:[{id:'one',text:first},{id:'two',text:second}]},
    body_blocks:[{source_block_key:'one',markdown:first},{source_block_key:'two',markdown:second}]}}));
  const params={reading,book:path.join(source,'book.md'),captions,sourceResult,audit:path.join(root,'audit'),apply:true};
  const result=await restoreBookMedia(params);
  assert.equal(result.status,'applied');
  assert.equal(result.model_calls,0);
  for(const [name,value] of Object.entries(files)) assert.equal(await fs.readFile(path.join(path.dirname(reading),publishedAssetRelative(name)),'utf8'),value);
  assert.doesNotMatch(await fs.readFile(reading,'utf8'),/unused\.pdf/u);
  assert.equal((await restoreBookMedia(params)).sha256,result.sha256);
  await fs.writeFile(path.join(path.dirname(reading),'images/shot_00_00_05.png'),'user changed asset');
  await assert.rejects(restoreBookMedia(params),/media_retained_asset_changed/u);
});

test('strong lists keep source topics and verify native diagrams after list indentation', () => {
  const target='# 测量\n\n## 正文\n\n- 校准 ^pr-calibration\n  - 先校准仪器，然后开始采样。\n- 复核 ^pr-review\n  - 不一致时保留现场。\n';
  const result=projectBookMedia({readingMarkdown:target,bookMarkdown:book,inventory,slug:'测量',paragraphs,
    sourceNodes:[{id:'one',text:first},{id:'two',text:second}],
    bodyBlocks:[{source_block_key:'one',markdown:'## 校准\n\n'+first},{source_block_key:'two',markdown:'## 复核\n\n'+second}]});
  assert.equal(removeMediaInsertions(result.markdown,result.insertions),target);
  assert.ok(result.markdown.indexOf(diagram)<result.markdown.indexOf('- 复核'));
  const nested='- 概念\n  - '+diagram.replace(/\n/gu,'\n    ')+'\n  - ![校准图](images/shot_00_00_05.png)\n  - ![复核图](images/shot_00_00_25.png)';
  assert.deepEqual(verifyBookMedia(nested,extractBookMedia(book,inventory),'测量'),{images:2,mermaid:1});
});
