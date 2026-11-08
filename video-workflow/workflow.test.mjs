import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTranscript, importTranscript, verifyUpstream } from './import-transcript.mjs';
import { SyntheticProducer } from '../standard-preprocessing/test-support/synthetic-producer.mjs';
import {bookPublicationPath} from './book-folder.mjs';

test('ordered timestamp parser preserves duplicates, rejects malformed and empty input', () => {
  assert.equal(parseTranscript('[00:00:00] 相同内容\n[00:00:00] 相同内容\n')[1].text, '相同内容');
  assert.throws(() => parseTranscript('[00:01:00] 一\n[00:00:00] 二'), /unordered/u);
  assert.throws(() => parseTranscript('[00:61:00] 一'), /invalid_timestamp/u);
  assert.throws(() => parseTranscript('丢失时间码'), /invalid_transcript_line/u);
  assert.throws(() => parseTranscript(''), /empty/u);
});

test('all pinned upstream files remain byte-identical', async () => {
  assert.equal((await verifyUpstream()).unchanged_files, 33);
});

test('single-pass body enters the standard workflow as written text without another body generation', async () => {
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/single-pass-fixture-');
  const source=path.join(root,'source');await fs.mkdir(source);
  await fs.writeFile(path.join(source,'source.json'),JSON.stringify({source_url:'https://example.org/independent',title:'实验计划',language:'zh'}));
  await fs.writeFile(path.join(source,'transcript.txt'),'[00:00:00] 我们计划比较两组样本。\n[00:00:05] 如果误差超过百分之三，就停止采样。');
  const outline='# 实验计划\n\n- 我们计划比较两组样本。\n  - 如果误差超过百分之三，就停止采样。\n';
  let calls=0;
  const receipt=await importTranscript({inputDir:source,outputDir:path.join(root,'audit'),
    publishPath:bookPublicationPath(path.join(root,'实验计划.md')),
    processingOptions:{source_language:'zh',content_profile:'natural_language',include_reading_guide:false},
    producer:{generate(){throw new Error('unexpected_body_generation');}},
    bodyRefiner:async({markdown})=>{
      calls+=1;assert.ok(markdown.includes('比较两组样本'));assert.ok(markdown.includes('百分之三'));
      return {markdown:outline,receipt:{mode:'synthetic-single-pass',api_calls_total:1}};
    }});
  assert.equal(calls,1);assert.equal(receipt.model.calls,0);
  assert.ok(receipt.workflow_route.stages.every(stage=>stage.id!=='spoken_to_written'));
  const final=await fs.readFile(bookPublicationPath(path.join(root,'实验计划.md')),'utf8');
  assert.match(final,/  - 如果误差超过百分之三，就停止采样。/u);
  assert.equal(receipt.used_attachments.length,0);
});

test('upstream JSON adapter keeps Markdown-native Mermaid and LaTeX as source text', async () => {
  const root = await fs.mkdtemp('D:/Artifacts/ProgressiveReading/videobook-json-test-');
  await fs.mkdir(path.join(root, 'source'));
  const text = '这是保留原样的公式 $x^2+y^2=1$。\n\n```mermaid\ngraph TD\nA-->B\n```';
  await fs.writeFile(path.join(root, 'source', 'transcript.json'), JSON.stringify({
    video_url: 'https://example.org/json-video', title: 'JSON独立样例',
    segments: [{ start: '00:00:00', end: '00:00:05', text }]
  }));
  const publishPath = bookPublicationPath(path.join(root, 'reading', 'JSON独立样例.md'));
  await importTranscript({ inputDir: path.join(root, 'source'), outputDir: path.join(root, 'audit'), publishPath,
    processingOptions: { source_language: 'zh', content_profile: 'natural_language', include_reading_guide: false },
    producer: new SyntheticProducer() });
  const markdown = await fs.readFile(publishPath, 'utf8');
  assert.ok(markdown.includes('```mermaid\ngraph TD\nA-->B\n```'));
  assert.ok(markdown.includes('$x^2+y^2=1$'));
});

for (const mode of ['spoken_to_written','strong_structuring']) test(`companion book media survives ${mode} publication without extra calls`, async () => {
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/book-media-canary-');
  const input=path.join(root,'source');
  await fs.mkdir(path.join(input,'images'),{recursive:true});
  await fs.writeFile(path.join(input,'source.json'),JSON.stringify({source_url:'https://example.org/measurement',title:'温度测量',language:'zh'}));
  await fs.writeFile(path.join(input,'transcript.txt'),'[00:00:00] 开始采样前必须校准仪器，保留原始记录。\n[00:00:20] 公式 $T=20$ 保持原样。');
  const diagram='```mermaid\ngraph LR\nA["校准"]-->B["采样"]\n```';
  const book='# 实验\n\n*(参考时间: 00:05)*\n\n'+diagram+'\n\n![校准](images/shot_00_00_05.png)';
  await fs.writeFile(path.join(input,'book.md'),book);
  await fs.writeFile(path.join(input,'images/shot_00_00_05.png'),Buffer.from([1,2,3]));
  await fs.writeFile(path.join(input,'unused.pdf'),'retained fixture');
  const producer=new SyntheticProducer();
  const publishedDiagram=mode==='strong_structuring'?diagram.split('\n').map(line=>'  '+line).join('\n'):diagram;
  if(mode==='strong_structuring') {
    const refine=producer.refineFullText.bind(producer);
    producer.refineFullText=async params=>{
      const response=await refine(params);
      return {...response,markdown:response.markdown.replace(diagram,publishedDiagram)};
    };
  }
  const publishPath=bookPublicationPath(path.join(root,'reading','温度测量.md'));
  const options={inputDir:input,outputDir:path.join(root,'audit'),publishPath,producer,
    processingOptions:{source_language:'zh',content_profile:'natural_language',include_reading_guide:false,structure_body:mode==='strong_structuring'}};
  const receipt=await importTranscript(options);
  assert.equal(producer.bodyCalls.length,1);
  assert.equal(producer.bodyCalls[0].mode,mode);
  assert.ok(producer.bodyCalls[0].markdown.includes(diagram));
  assert.ok(producer.bodyCalls[0].markdown.includes('![校准](images/'));
  assert.deepEqual(receipt.book_media.counts,{images:1,mermaid:1});
  const final=await fs.readFile(publishPath,'utf8');
  assert.ok(final.includes(publishedDiagram));
  assert.ok(final.includes('$T=20$'));
  assert.match(final,/!\[校准\]\(images\/shot_00_00_05.png\)/u);
  assert.doesNotMatch(final,/unused\.pdf|来源附件/u);
  assert.equal(receipt.attachments_verified,4);
  const broken=new SyntheticProducer();
  broken.refineFullText=async params=>{
    const response=await producer.refineFullText(params);
    return {...response,markdown:response.markdown.replace(publishedDiagram,'')};
  };
  await assert.rejects(importTranscript({...options,outputDir:path.join(root,'broken-audit'),publishPath:path.join(root,'broken.md'),producer:broken}),/book_media_missing_changed_or_duplicated/u);
  await assert.rejects(fs.readFile(bookPublicationPath(path.join(root,'broken.md'))),{code:'ENOENT'});
});

test('independent synthetic package: opaque attachments survive, MD references work, replay is idempotent', async () => {
  const root = await fs.mkdtemp('D:/Artifacts/ProgressiveReading/videobook-test-');
  const input = path.join(root, 'source');
  const output = path.join(root, 'audit');
  const publish = bookPublicationPath(path.join(root, 'reading', '独立样例.md'));
  await fs.mkdir(path.join(input, 'files'), { recursive: true });
  await fs.writeFile(path.join(input, 'source.json'), JSON.stringify({ source_url: 'https://example.org/video', title: '独立样例', language: 'zh' }));
  await fs.writeFile(path.join(input, 'transcript.txt'), '[00:00:00] 这是来源中的独立观点，必须保留条件和结论。实验资料见 [实验资料](files/含 空格.pdf)。\n[00:00:05] 公式 $x^2+y^2=1$ 应当保留。');
  const attachment = Buffer.from([0, 1, 2, 250, 255]);
  await fs.writeFile(path.join(input, 'files', '含 空格.pdf'), attachment);
  await fs.writeFile(path.join(input, 'files', 'player.html'), '<html>附件</html>');
  await fs.writeFile(path.join(input, '_cookies.txt'), '# Netscape HTTP Cookie File\nsynthetic credential fixture');
  const params = { inputDir: input, outputDir: output, publishPath: publish,
    processingOptions: { content_profile: 'natural_language', include_reading_guide: false }, producer: new SyntheticProducer() };
  const receipt = await importTranscript(params);
  assert.equal(receipt.attachments_verified, 3);
  assert.deepEqual(receipt.excluded_sensitive_paths, ['_cookies.txt']);
  await assert.rejects(fs.readFile(path.join(path.dirname(publish), '_assets', 'source', '_cookies.txt')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(path.dirname(publish), '_assets', 'source', 'files', '含 空格.pdf')), attachment);
  const markdown = await fs.readFile(publish, 'utf8');
  assert.ok(markdown.includes(encodeURIComponent('含 空格.pdf')));
  assert.deepEqual(receipt.used_attachments,['files/含 空格.pdf']);
  assert.ok(!markdown.includes('来源附件'));
  assert.ok(!markdown.includes('player.html'));
  assert.ok(!markdown.includes('transcript.txt'));
  assert.ok(markdown.includes('$x^2+y^2=1$'));
  assert.ok(!markdown.includes('[00:00:00]'));
  const replay = await importTranscript(params);
  assert.equal(replay.publication.markdown.sha256, receipt.publication.markdown.sha256);
  await fs.writeFile(path.join(path.dirname(publish), '_assets', 'source', 'files', '含 空格.pdf'), 'user edit');
  await assert.rejects(importTranscript(params), /output_conflict/u);
});
