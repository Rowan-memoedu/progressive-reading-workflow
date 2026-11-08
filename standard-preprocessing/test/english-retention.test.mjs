import test from "node:test";
import assert from "node:assert/strict";
import { processMaterial } from "../lib/core.mjs";
import { isShortEnglishLabel } from "../lib/producer.mjs";

test("short label exemption is bounded and never covers ordinary paragraphs", () => {
  assert.equal(isShortEnglishLabel({ type: "list", markdown: "- Regression to the mean" }), true);
  assert.equal(isShortEnglishLabel({ type: "paragraph", markdown: "Regression to the mean" }), false);
  assert.equal(isShortEnglishLabel({ type: "list", markdown: "- " + "word ".repeat(21) }), false);
});

for (const chineseHeading of [true, false]) {
  test(`English labels retain document-level Chinese check: chineseHeading=${chineseHeading}`, async () => {
    const result = await processMaterial({
      schema_version: "progressive-reading.preprocess.request/v1", contract_version: "1.0.0",
      material: { markdown: "# Experimental design\n\n- Regression to the mean" },
      source_type: "synthetic_retention_regression",
      source_metadata: { source_url: "https://example.invalid/retention-test", source_is_original: true },
      user_instruction: "翻译正文，允许英文标签。",
      processing_options: { cleaning_mode: "source_translation", translation_target_language: "zh-CN" }
    }, { producer: { async generate(payload) {
      return { provider: "synthetic", model: "retention-regression", usage: null, output: {
        cleaned_blocks: payload.blocks.map((block, index) => ({ source_block_key: block.source_block_key,
          markdown: index === 0 && chineseHeading ? "# 实验设计" : block.markdown })),
        judgments: { value: { level: "medium", reason: "验证术语保留。" },
          density: { level: "medium", reason: "包含一个统计概念。" },
          continue_reading: { level: 2, reason: "适合查看概念。" } },
        insights: [], translation: { is_bilingual: false, alignments: [] }
      } };
    } } });
    assert.equal(result.status, chineseHeading ? "completed" : "completed_with_warnings");
    if (!chineseHeading) assert.match(result.errors[0].message, /translation_document_target_language_missing/u);
  });
}

for (const prose of ['', '\n\nThis ordinary paragraph explains how readers can evaluate the evidence and should be translated.']) {
  test(`English bibliography-only leaf can remain literal without exempting prose: prose=${Boolean(prose)}`,async()=>{
    const result=await processMaterial({schema_version:'progressive-reading.preprocess.request/v1',contract_version:'1.0.0',
      source_type:'synthetic_bibliography',material:{markdown:'# References\n\nP. Deitel, H. Deitel, Java: How to Program'+(prose ? '\n\n# Discussion'+prose : '')},
      source_metadata:{source_url:'https://example.invalid/bibliography',source_is_original:true},user_instruction:'',
      processing_options:{cleaning_mode:'source_translation',translation_target_language:'zh-CN',include_reading_guide:false}},
      {producer:{async generate(payload){return {provider:'fixture',model:'fixture',output:{cleaned_blocks:payload.blocks.map(b=>({source_block_key:b.source_block_key,markdown:b.markdown})),judgments:null,insights:[],translation:{is_bilingual:false,alignments:[]}}};}}});
    assert.equal(result.status,prose ? 'completed_with_warnings' : 'completed');
  });
}
