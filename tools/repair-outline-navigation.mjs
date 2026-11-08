import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {processMaterial, renderReadingMarkdown, sha256, stableJson, auditVisibleReadingAnchors} from '../standard-preprocessing/lib/core.mjs';
import {publishReadingArtifact, validateResultContract} from '../standard-preprocessing/index.mjs';
import {retargetSubdividedInsights} from '../standard-preprocessing/lib/insight-target-repair.mjs';

export async function repairOutlineNavigation(previous) {
  const body = previous.artifacts.body_blocks.map(block => block.markdown).join('\n\n');
  const parsed = await processMaterial({schema_version: previous.schema_version.replace('.result/', '.request/'),
    contract_version: previous.contract_version, material_id: previous.material_id,
    source_type: previous.source_metadata.source_type || 'navigation_repair',
    source_metadata: previous.source_metadata, user_instruction: '', material: {markdown: body},
    processing_options: {cleaning_mode: 'semantic_only', include_reading_guide: false}}, {
    skipCacheRead: true, producer: {generate() { throw new Error('navigation_repair_must_not_call_model'); }}
  });
  if (parsed.status !== 'completed') throw new Error('outline_parse_failed');
  const blocks = parsed.artifacts.body_blocks;
  const mapping = retargetSubdividedInsights(previous.artifacts.semantic.insights, previous.artifacts.body_blocks, blocks);
  const result = structuredClone(previous);
  result.artifacts.body_blocks = blocks;
  result.artifacts.cleaning_manifest = parsed.artifacts.cleaning_manifest;
  result.artifacts.semantic = {...previous.artifacts.semantic, insights: mapping.insights};
  result.artifacts.reading_markdown = renderReadingMarkdown({materialId: result.material_id,
    metadata: result.source_metadata, sourceType: result.artifacts.reading_markdown.match(/^source_type: "(.*)"$/mu)?.[1] || 'navigation_repair',
    hashes: result.receipt.hashes, semantic: result.artifacts.semantic, bodyBlocks: blocks,
    translationState: result.translation_state});
  for (const key of ['body_blocks', 'cleaning_manifest', 'semantic']) {
    result.artifacts.artifact_hashes[key] = sha256(stableJson(result.artifacts[key]));
  }
  result.artifacts.artifact_hashes.reading_markdown = sha256(result.artifacts.reading_markdown);
  const contentLines = text => text.split('\n').filter(line => line.trim()).join('\n');
  if (contentLines(body) !== contentLines(blocks.map(block => block.markdown).join('\n\n'))) throw new Error('body_content_changed');
  if (stableJson(previous.artifacts.semantic.insights.map(({target_block_key, ...prose}) => prose))
    !== stableJson(result.artifacts.semantic.insights.map(({target_block_key, ...prose}) => prose))) throw new Error('insight_prose_changed');
  const audit = {version: 'outline-subtree-navigation/v1', api_calls: 0,
    previous_reading_sha256: previous.artifacts.artifact_hashes.reading_markdown,
    previous_body_block_count: previous.artifacts.body_blocks.length, body_block_count: blocks.length,
    body_content_unchanged: true, insight_prose_unchanged: true, target_mapping: mapping.audit};
  const anchors = auditVisibleReadingAnchors(result.artifacts.reading_markdown, blocks);
  if (!anchors.passed) throw new Error('repaired_navigation_invalid');
  result.receipt.validations = result.receipt.validations.map(validation => validation.name === 'visible_body_anchor_pruning'
    ? {...validation, status: 'passed', details: anchors} : validation);
  result.receipt.validations.push({name: 'outline_subtree_navigation', status: 'passed', details: audit});
  const validation = await validateResultContract(result);
  if (!validation.valid) throw new Error(`invalid_repaired_result:${JSON.stringify(validation)}`);
  return {result, audit};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readArg = key => args[args.indexOf(key) + 1];
  const resultPath = readArg('--result');
  if (!args.includes('--result')) throw new Error('--result_required');
  const previous = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const {result, audit} = await repairOutlineNavigation(previous);
  if (!args.includes('--publish')) console.log(JSON.stringify({body_blocks: audit.body_block_count, api_calls: 0,
    mapping: audit.target_mapping.map(item => ({title: item.title, candidates: item.candidates.map(({section, score}) => ({section, score}))}))}, null, 2));
  if (args.includes('--publish')) {
    const publishPath = readArg('--publish');
    const outputDir = readArg('--output');
    if (!args.includes('--output')) throw new Error('--output_required');
    const before = await fs.readFile(publishPath, 'utf8');
    if (sha256(before) !== audit.previous_reading_sha256) throw new Error('published_source_changed');
    await fs.mkdir(outputDir, {recursive: true});
    for (const [name, content] of [['before.md', before], ['before-result.json', JSON.stringify(previous, null, 2) + '\n']]) {
      try { await fs.writeFile(path.join(outputDir, name), content, {flag: 'wx'}); }
      catch (error) {
        if (error.code !== 'EEXIST' || sha256(await fs.readFile(path.join(outputDir, name))) !== sha256(content)) throw error;
      }
    }
    // Guard against concurrent user edits before the final projection.
    if (sha256(await fs.readFile(publishPath, 'utf8')) !== sha256(before)) throw new Error('published_source_changed');
    const publication = await publishReadingArtifact(result, {publishPath, runDir: outputDir, expectedExistingSha256: sha256(before)});
    await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await fs.writeFile(path.join(outputDir, 'receipt.json'), JSON.stringify({...audit, publication}, null, 2) + '\n');
    console.log(JSON.stringify({published: publication.markdown.path, sha256: publication.markdown.sha256}));
  }
}
