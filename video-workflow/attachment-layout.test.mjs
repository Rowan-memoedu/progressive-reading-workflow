import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutInlineAttachments } from './attachment-layout.mjs';

test('referenced images stay at their subtitle point, unused files are retained without links', () => {
  const first='## 测量条件\n\n- 设备校准后开始测量。';
  const second='## 停止条件\n\n- 偏差过大时停止。';
  const input={readingMarkdown:first+'\n\n'+second,sourceMarkdown:'设备校准后开始测量。\n\n偏差过大时停止。',
    bookMarkdown:'![校准图](images/shot_00_00_05.png)',slug:'独立测量',
    inventory:[{path:'images/shot_00_00_05.png'},{path:'cover.png'},{path:'audio.mp3'}],
    paragraphs:[{start:'00:00:00'},{start:'00:00:10'}],sourceNodes:[{id:'a'},{id:'b'}],
    bodyBlocks:[{source_block_key:'a',markdown:first},{source_block_key:'b',markdown:second}]};
  const output=layoutInlineAttachments(input);
  assert.deepEqual(output.used_attachments,['images/shot_00_00_05.png']);
  assert.ok(output.markdown.indexOf('[校准图]')>output.markdown.indexOf(first));
  assert.ok(output.markdown.indexOf('[校准图]')<output.markdown.indexOf(second));
  assert.match(output.markdown,/!\[校准图\]\(images\/shot_00_00_05.png\)/u);
  assert.doesNotMatch(output.markdown,/cover\.png|audio\.mp3|来源附件/u);
});

test('source inline attachments keep their position and native syntax remains literal', () => {
  const source='- 参考 ![图](diagram.svg) 再进行验证。\n\n```mermaid\ngraph TD\nA-->B\n```\n\n$x^2=1$';
  const output=layoutInlineAttachments({readingMarkdown:source,sourceMarkdown:source,inventory:[{path:'diagram.svg'},{path:'unused.pdf'}],
    slug:'试验',paragraphs:[],sourceNodes:[],bodyBlocks:[]});
  assert.ok(output.markdown.startsWith('- 参考 ![图](images/'));
  assert.ok(output.markdown.includes('再进行验证。'));
  assert.ok(output.markdown.includes('```mermaid\ngraph TD\nA-->B\n```'));
  assert.ok(output.markdown.includes('$x^2=1$'));
  assert.doesNotMatch(output.markdown,/unused\.pdf|来源附件/u);
});
