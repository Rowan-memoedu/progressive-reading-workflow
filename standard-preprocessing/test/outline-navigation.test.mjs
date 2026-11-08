import assert from 'node:assert/strict';
import test from 'node:test';
import {splitOutlineSubtrees} from '../lib/outline-blocks.mjs';
import {processMaterial, sha256} from '../lib/core.mjs';
import {buildPreprocessRequest, runPreprocessingRequest, standardWorkflowOptions} from '../index.mjs';
import {SyntheticProducer} from '../test-support/synthetic-producer.mjs';
import {repairOutlineNavigation} from '../../tools/repair-outline-navigation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publishReadingArtifact} from '../index.mjs';

const outline = '# 栽培观察\n- 光照条件\n  - 日照保持六小时\n    - 记录叶片颜色\n- 排水条件\n  - 土壤保持疏松\n  - 雨后检查积水\n- 冬季温度\n  - 低于五度移入室内';
const request = markdown => buildPreprocessRequest({markdown, sourceType: 'fixture',
  sourceMetadata: {title: '栽培观察', language: 'zh', input_form: 'written', content_profile: 'natural_language'},
  processingOptions: {cleaning_mode: 'semantic_only', include_reading_guide: false}});

test('continuous outlines preserve each top-level subtree and source lines', async () => {
  const result = await processMaterial(request(outline));
  assert.equal(result.status, 'completed');
  assert.equal(result.artifacts.body_blocks.length, 4);
  assert.equal(result.artifacts.body_blocks[1].markdown, '- 光照条件\n  - 日照保持六小时\n    - 记录叶片颜色');
  assert.equal(result.artifacts.body_blocks.map(block => block.markdown).join('\n'), outline);
  assert.equal(result.artifacts.body_blocks[0].type, 'heading');
});

test('blank lines and list-like syntax in protected literals do not break subtrees', () => {
  const input = '# 记录\n- 流程示例\n  - 步骤\n\n  ````mermaid\n- literal\n```\n  ````\n  $$\n- another literal\n  $$\n- 第二主题\n  - 说明';
  const sections = splitOutlineSubtrees(input);
  assert.equal(sections.length, 3);
  assert.match(sections[1], /- literal\n```\n  ````/);
  assert.match(sections[1], /- another literal/);
  assert.equal(sections[2], '- 第二主题\n  - 说明');
  assert.equal(splitOutlineSubtrees('# 文章\n\n正文段落\n\n- 一般列表'), null);
  const math='# 条件\n- 实验\n  - $$\n    - x\n    $$\n  - 观测结果\n- 复核';
  const mathGroups=splitOutlineSubtrees(math,{maxSubtreeCharacters:10});
  assert.equal(mathGroups.join('\n'),math);
  assert.ok(mathGroups.some(group=>group==='  - $$\n    - x\n    $$'));
});

test('standard strong workflow gives the guide distinct subtree targets without another body call', async () => {
  const producer = new SyntheticProducer();
  const req = request(outline);
  req.processing_options = standardWorkflowOptions({structure_body: true, translate: false, include_reading_guide: true});
  const {result} = await runPreprocessingRequest(req, {producer, cacheDir: false});
  assert.equal(result.status, 'completed');
  assert.equal(producer.bodyCalls.length, 1);
  assert.equal(producer.calls, 1);
  assert.equal(producer.lastPayload.blocks.length, 4);
  assert.equal(new Set(result.artifacts.semantic.insights.map(item => item.target_block_key)).size, 3);
  const markdown = result.artifacts.reading_markdown;
  for (const insight of result.artifacts.semantic.insights) {
    const block = result.artifacts.body_blocks.find(item => item.source_block_key === insight.target_block_key);
    assert.ok(block.markdown.length < outline.length);
    assert.ok(markdown.includes(`[[#^${block.block_id}|正文跳转]]`));
    const [topic, ...children] = block.markdown.split('\n');
    assert.ok(markdown.includes(`${topic} ^${block.block_id}\n${children.join('\n')}`));
  }
});

test('list-prefixed Mermaid fences keep subsequent topics available as distinct navigation targets',async()=>{
  const text='# 原生图文\n- 温度采集\n  - 先校准\n  - ```mermaid\n    flowchart TD\n    A-->B\n    ```\n- 湿度采集\n  - 保持探头清洁\n- 异常停止\n  - 阈值超过上限时停止';
  const sections=splitOutlineSubtrees(text);
  assert.equal(sections.length,4);assert.match(sections[2],/^- 湿度采集/);
  const result=await processMaterial(request(text));
  assert.equal(result.artifacts.body_blocks.length,4);
  assert.equal(result.artifacts.body_blocks.map(b=>b.markdown).join('\n'),text);
});

test('large nested outlines expose existing child topics without flattening or splitting literal diagrams',async()=>{
  const diagram='    - ```mermaid\n      graph TD\n      A-->B\n      ```';
  const nested='# 观测手册\n- 长期观测\n  - 温度校准\n    - '+('温度探头需定期校准并记录环境条件。'.repeat(80))+'\n'+diagram+'\n  - 土壤含水量\n    - '+('土壤含水量过高时先检查排水。'.repeat(80));
  const sections=splitOutlineSubtrees(nested);
  assert.ok(sections.some(section=>section.startsWith('  - 土壤含水量')));
  assert.equal(sections.join('\n'),nested);
  assert.equal(sections.filter(section=>section.includes('```mermaid')).length,1);
  assert.ok(sections.some(section=>section.includes(diagram)));
  const result=await processMaterial(request(nested));
  assert.equal(result.artifacts.body_blocks.map(block=>block.markdown).join('\n'),nested);
  const target=result.artifacts.body_blocks.find(block=>block.markdown.includes('土壤含水量过高'));
  result.artifacts.semantic.judgments={value:{level:'high',reason:'观测记录'},density:{level:'high',reason:'具体条件'},continue_reading:{level:3,reason:'通读'}};
  result.artifacts.semantic.insights=[{title:'排水检查',description:'土壤含水量过高时先检查排水。',target_block_key:target.source_block_key}];
  const {renderReadingMarkdown}=await import('../lib/core.mjs');
  const rendered=renderReadingMarkdown({materialId:result.material_id,metadata:result.source_metadata,sourceType:'fixture',
    hashes:result.receipt.hashes,semantic:result.artifacts.semantic,bodyBlocks:result.artifacts.body_blocks,
    translationState:result.translation_state,includeReadingGuide:true});
  assert.ok(rendered.includes(target.markdown.split('\n')[0]+` ^${target.block_id}`));
});

test('legacy navigation repair uses source evidence, preserves prose and never calls AI', async () => {
  const previous = await processMaterial(request(outline));
  previous.artifacts.body_blocks = [{...previous.artifacts.body_blocks[0],
    source_block_key: 'legacy', source_block_keys: ['legacy'], markdown: outline, block_id: 'pr-legacy'}];
  previous.artifacts.semantic = {judgments: {
    value: {level: 'high', reason: '完整记录'}, density: {level: 'high', reason: '包含条件'},
    continue_reading: {level: 3, reason: '阅读原始记录'}}, insights: [
    {title: '雨后排水', description: '土壤保持疏松，雨后检查积水。', target_block_key: 'legacy'},
    {title: '冬季温度', description: '温度低于五度时，需要将植物移入室内。', target_block_key: 'legacy'}]};
  previous.artifacts.artifact_hashes.reading_markdown = sha256('legacy');
  const {result, audit} = await repairOutlineNavigation(previous);
  assert.equal(audit.api_calls, 0);
  assert.equal(audit.body_content_unchanged, true);
  const targets = result.artifacts.semantic.insights.map(insight => result.artifacts.body_blocks.find(block => block.source_block_key === insight.target_block_key).markdown);
  assert.match(targets[0], /^- 排水条件/);
  assert.match(targets[1], /^- 冬季温度/);
  assert.deepEqual(result.artifacts.semantic.insights.map(({target_block_key, ...prose}) => prose),
    previous.artifacts.semantic.insights.map(({target_block_key, ...prose}) => prose));
  await assert.rejects(repairOutlineNavigation({...previous, artifacts: {...previous.artifacts,
    semantic: {...previous.artifacts.semantic, insights: [{title: '陌生观点', description: '无关信息没有对应材料', target_block_key: 'legacy'}]}}}), /insufficient_target_evidence/);
});

test('navigation publication replaces only the exact reviewed source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'outline-navigation-'));
  const publishPath = path.join(root, 'reading.md');
  await fs.writeFile(publishPath, 'reviewed source');
  const result = await processMaterial(request(outline));
  await assert.rejects(publishReadingArtifact(result, {publishPath}), error => error.code === 'publish_target_conflict');
  await assert.rejects(publishReadingArtifact(result, {publishPath, expectedExistingSha256: sha256('different source')}), error => error.code === 'publish_source_changed');
  assert.equal(await fs.readFile(publishPath, 'utf8'), 'reviewed source');
  const publication = await publishReadingArtifact(result, {publishPath, expectedExistingSha256: sha256('reviewed source')});
  assert.equal(sha256(await fs.readFile(publishPath)), publication.markdown.sha256);
  assert.match(await fs.readFile(publishPath, 'utf8'), /- 冬季温度/);
});
