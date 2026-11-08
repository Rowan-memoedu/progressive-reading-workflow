import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseChapterCatalog,extractWikiBody,verifyChapterPublication} from './import-wiki-chapters.mjs';

test('catalog preserves nested source order and rejects an incomplete boundary',()=>{
  const html='<div class="mw-parser-output"><h1>Chapters</h1><h2>Group</h2><ul><li><a href="/wiki/Parent">Parent</a><ul><li><a href="/wiki/Child">Child</a></li></ul></li><li><a href="/wiki/Parent">Again</a></li></ul><h1>References</h1></div>';
  const capture={url:'https://example.org/wiki/Book',html};
  const {rows}=parseChapterCatalog(capture);
  assert.deepEqual(rows.map(r=>[r.order,r.parents,r.hasChildren]),[[1,[],true],[2,['Parent'],false],[3,[],false]]);
  assert.equal(rows[0].url,rows[2].url);
  assert.throws(()=>parseChapterCatalog({...capture,html:html.replace('<h1>References</h1>','')}),/catalog_incomplete/);
});
test('body extraction keeps article text and removes page controls',()=>{
  const result=extractWikiBody({url:'https://example.org/wiki/Article',html:'<div class="mw-parser-output"><p>This text is part of: Book</p><div id="toc">Contents navigation</div><h2>Independent fixture heading</h2><p>A complete paragraph with enough words to check preservation of the original source and its <a href="/wiki/Other">reference link</a>.</p><span class="mw-editsection">Edit section</span></div>'});
  assert.match(result.markdown,/Independent fixture heading/);
  assert.match(result.markdown,/https:\/\/example.org\/wiki\/Other/);
  assert.doesNotMatch(result.markdown,/Contents navigation|Edit section|This text is part/);
  assert.equal(result.receipt.missing_text_nodes,0);
});
function fixture(warning){
  const sourceMarkdown='A complete original article for an independent fixture.';
  const markdown=warning?'---\n---\n\n## 正文\n\n'+sourceMarkdown:'---\n---\n\n## 正文\n\n完整译文。\n\n## 原文\n\n'+sourceMarkdown;
  const result={status:warning?'completed_with_warnings':'completed',processing_state:warning?'degraded':'rendered',artifacts:{target_zone:warning?'preprocess-review':'local-ir-reading',reading_markdown:markdown,body_blocks:[{markdown:sourceMarkdown}],semantic:{judgments:null,insights:[]}},receipt:{cleaning_policy:{include_reading_guide:false},validations:['request_schema','lossless_source_mapping','block_coverage','visible_body_anchor_pruning'].map(name=>({name,status:'passed'}))},errors:warning?[{severity:'warning',code:'producer_output_rejected'}]:[]};
  return {result,request:{material:{markdown:sourceMarkdown}},publication:{quality_status:warning?'warning':'ready',duplicate_original_removed:warning,markdown:{sha256:createHash('sha256').update(markdown).digest('hex')}},markdown,sourceMarkdown};
}
test('translated publication and explicit original-only fallback retain distinct quality',()=>{
  assert.equal(verifyChapterPublication(fixture(false)).quality.quality_status,'ready');
  const verified=verifyChapterPublication(fixture(true));
  assert.equal(verified.quality.quality_status,'warning');
  assert.equal(verified.original_location,'body');
});
test('site footer is removed while article further-reading remains',()=>{
  const {markdown}=extractWikiBody({url:'https://example.org/wiki/Independent',html:'<div class="mw-parser-output"><p>This independent article contains enough source text to verify that the extractor preserves all meaningful content.</p><h2>Further reading</h2><p>Useful specific references belonging to this article.</p><p><br></p><hr><div class="more">Generic website footer promotion</div></div>'});
  assert.match(markdown,/Useful specific references/);
  assert.doesNotMatch(markdown,/Generic website footer/);
  assert.doesNotMatch(markdown,/\* \* \*$/);
});
test('fallback cannot hide missing original, changed input or changed publication',()=>{
  const sample=fixture(true);
  assert.throws(()=>verifyChapterPublication({...sample,markdown:sample.markdown.replace('complete original','partial')}),/published_original_incomplete/);
  assert.throws(()=>verifyChapterPublication({...sample,sourceMarkdown:'different input'}),/audit_source_mismatch/);
  assert.throws(()=>verifyChapterPublication({...sample,publication:{...sample.publication,markdown:{sha256:'bad'}}}),/publication_hash_mismatch/);
  assert.throws(()=>verifyChapterPublication({...sample,publication:{...sample.publication,duplicate_original_removed:false}}),/published_original_incomplete/);
});
