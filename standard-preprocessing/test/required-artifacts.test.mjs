import test from "node:test";
import assert from "node:assert/strict";
import { processMaterial } from "../lib/core.mjs";
import { classifyStandardImportQuality } from "../../scripts/standard-import-quality.mjs";
import { buildPreprocessRequest, runPreprocessingRequest, standardWorkflowOptions } from "../index.mjs";

const metadata = { source_url: "https://example.org/translation", source_is_original: true, input_form: "written", content_profile: "natural_language", source_language: "en" };
const source = "# Working systems\n\n![Author portrait](https://example.org/avatar.png \"Author portrait\")\n\nKeep the exact invariant $x^2$ and test the result.\n\n- Regression to the mean";
const output = payload => ({ provider:"synthetic", model:"required-artifact-test", api_calls:1, output: {
  cleaned_blocks: payload.blocks.map(block=>({source_block_key:block.source_block_key, markdown: block.markdown.replace("Working systems","运行中的系统").replace("Keep the exact invariant", "保持精确的不变量").replace("and test the result.","并验证结果。")})),
  judgments: payload.cleaning_policy.include_reading_guide !== false ? { value:{level:"medium",reason:"可读。"},density:{level:"high",reason:"紧凑。"},continue_reading:{level:2,reason:"继续。"}} : null,
  insights: payload.cleaning_policy.include_reading_guide !== false ? [{title:"验证",description:"测试不变量。",target_block_key:payload.blocks[0].source_block_key}] : [], translation:{is_bilingual:false,alignments:[]}
}});

test("images, English labels and short guides do not reject actual translation", async () => {
  let calls=0;
  const request=buildPreprocessRequest({markdown:source,sourceType:"fixture",sourceMetadata:metadata,processingOptions:standardWorkflowOptions({translate:true,include_reading_guide:true})});
  const {result}=await runPreprocessingRequest(request,{cacheDir:false,producer:{async generate(payload){calls++;const result=output(payload); if(payload.cleaning_policy.mode==='semantic_only') result.output.cleaned_blocks=payload.blocks.map(({source_block_key,markdown})=>({source_block_key,markdown})); return result;}}});
  assert.equal(classifyStandardImportQuality(result).admissible,true,JSON.stringify({errors:result.errors,quality:classifyStandardImportQuality(result),route:result.receipt.workflow_route,translation:result.translation_state}));
  assert.equal(result.translation_state,"generated_translation");
  assert.equal(result.receipt.reading_guide.status,"generated");
  assert.equal(calls,2);
  assert.ok(result.artifacts.reading_markdown.includes("$x^2$"));
});
test("raw fallback is never mislabeled or published as translation", async () => {
  const result=await processMaterial(buildPreprocessRequest({markdown:source,sourceType:"fixture",sourceMetadata:metadata,processingOptions:{cleaning_mode:"source_translation",translation_target_language:"zh-CN",include_reading_guide:false}}),{cacheDir:false,producer:{async generate(){throw Object.assign(new Error("fixture generation failed"),{terminal:true});}}});
  assert.equal(result.translation_state,"unknown");
  assert.equal(classifyStandardImportQuality(result).admissible,false);
});
test("missing requested guide blocks readable warnings", async () => {
  const request=buildPreprocessRequest({markdown:"中文正文用于验证必须生成导读。",sourceType:"fixture",sourceMetadata:{...metadata,source_language:"zh"},processingOptions:standardWorkflowOptions({translate:false,include_reading_guide:true})});
  const {result}=await runPreprocessingRequest(request,{cacheDir:false,producer:{async generate(){throw Object.assign(new Error("fixture guide failed"),{terminal:true});}}});
  assert.equal(result.receipt.reading_guide.status,"failed");
  assert.equal(classifyStandardImportQuality(result).admissible,false);
});
