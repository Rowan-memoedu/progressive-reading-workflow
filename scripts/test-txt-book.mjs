import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildPreprocessRequest } from '../standard-preprocessing/index.mjs';
import { buildTxtBookManifest, buildTxtBookRequest } from './txt-book-structure.mjs';
import { importTxtBook } from './import-txt-book.mjs';

function request(markdown) {
  return buildPreprocessRequest({ markdown, sourceType: 'txt', sourceMetadata: {
    title: '独立样本', source_url: 'file:///independent-sample.txt', source_is_original: true,
    input_form: 'written', content_profile: 'natural_language', language: 'zh'
  }, processingOptions: { workflow_mode: 'standard', include_reading_guide: false } });
}

test('chapter folders contain smallest sections; parent prose and all source lines remain covered exactly once', async () => {
  const parent = request('书名\n\n作者简介\n\n前言\n\n前言正文\n\n第一章观察\n\n第1节记录\n\n二、这是正文列表。\n\n第2节解释\n\n解释正文\n\n第二章实验\n\n章前说明\n\n第1节设计\n\n实验正文\n');
  const manifest = buildTxtBookManifest(parent);
  assert.equal(manifest.split_count, 6);
  assert.ok(manifest.splits.some(split => split.relative_path === '03 第二章实验/00 开篇.md'));
  assert.ok(manifest.splits.some(split => split.relative_path === '02 第一章观察/01 第1节记录.md'));
  assert.equal(manifest.splits.map(split => buildTxtBookRequest(parent, manifest, split).material.markdown).join('\n'), parent.material.markdown);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-txt-book-canary-'));
  try {
    const report = await importTxtBook({ request: parent, output: path.join(temporary, 'audit'), publish: path.join(temporary, 'book') });
    assert.equal(report.status, 'completed');
    assert.equal(report.split_count, 6);
    assert.equal(report.guide_generated, false);
    assert.equal(report.model_calls, 0);
    assert.ok(report.rows.every(row => row.quality_status === 'ready'));
    await assert.rejects(importTxtBook({ request: parent, output: path.join(temporary, 'other-audit'), publish: path.join(temporary, 'book') }), /target_already_exists/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('an indivisible appendix peer prevents splitting another appendix while preserving inline-title boundaries', () => {
  const parent = request('导言\n\n1、问题\n\n问题正文\n\n2、方法\n\n方法正文\n\n附录：\n\n编者说明\n\n附录一：访谈\n\n问答正文\n\n附录二：报告\n\n报告开场\n\n（一）\n\n第一部分正文\n\n（二）\n\n第二部分正文\n\n作者公开信致读者：信的正文。\n');
  const manifest = buildTxtBookManifest(parent, { heading_overrides: [{ line_prefix: '作者公开信致读者：', title: '作者公开信', level: 2 }] });
  assert.equal(manifest.split_count, 6);
  assert.ok(manifest.splits.some(split => split.relative_path.endsWith('02 附录二：报告.md')));
  assert.ok(manifest.splits.every(split => !split.relative_path.includes('附录二：报告/')));
  const report = manifest.splits.find(split => split.title === '附录二：报告');
  assert.match(buildTxtBookRequest(parent, manifest, report).material.markdown, /（一）[\s\S]*（二）/u);
  assert.ok(manifest.splits.at(-1).relative_path.endsWith('03 作者公开信.md'));
  assert.equal(manifest.splits.map(split => buildTxtBookRequest(parent, manifest, split).material.markdown).join('\n'), parent.material.markdown);
  const edited = structuredClone(parent);
  edited.material.markdown += '不能静默混入变化的来源。';
  assert.throws(() => buildTxtBookRequest(edited, manifest, manifest.splits[0]), /source_hash_mismatch/);
  assert.throws(() => buildTxtBookManifest(parent, { heading_overrides: [{ line_prefix: '缺失标题', title: '缺失', level: 2 }] }), /not_unique/);
});

test('indivisible chapter peers apply the same policy outside appendices and do not treat front matter as chapters', () => {
  const parent = request('前言\n\n说明正文\n\n第一章方法\n\n第1节步骤\n\n步骤正文\n\n第二章案例\n\n案例正文\n');
  const manifest = buildTxtBookManifest(parent);
  assert.equal(manifest.split_count, 3);
  assert.ok(manifest.splits.some(split => split.relative_path === '02 第一章方法.md'));
  assert.ok(manifest.splits.some(split => split.relative_path === '03 第二章案例.md'));
  assert.equal(manifest.splits.map(split => buildTxtBookRequest(parent, manifest, split).material.markdown).join('\n'), parent.material.markdown);
});

test('parallel appendices that all contain parts continue to split into their smallest uniform level', async () => {
  const parent = request('附录：\n\n附录一：研究\n\n（一）\n\n研究甲\n\n（二）\n\n研究乙\n\n附录二：应用\n\n（一）\n\n应用甲\n\n（二）\n\n应用乙\n');
  const manifest = buildTxtBookManifest(parent);
  assert.equal(manifest.split_count, 4);
  assert.ok(manifest.splits.every(split => split.relative_path.split('/').length === 3));
  assert.equal(manifest.splits.map(split => buildTxtBookRequest(parent, manifest, split).material.markdown).join('\n'), parent.material.markdown);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-txt-peer-canary-'));
  try {
    const report = await importTxtBook({ request: parent, output: path.join(temporary, 'audit'), publish: path.join(temporary, 'book') });
    assert.equal(report.split_count, 4);
    assert.equal(report.guide_generated, false);
    assert.equal(report.model_calls, 0);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('independent raw TXT canary passes source and peer-granularity verification without any appendix-specific input', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-txt-peer-source-'));
  const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const python = process.env.PR_TEST_PYTHON || 'python';
  try {
    const source = path.join(temporary, '研究札记.txt');
    const sourceText = '研究札记\n\n第一章假设\n\n第1节设问\n\n假设需要接受检验。\n\n第二章反例\n\n反例能够限制结论范围。\n';
    await fs.writeFile(source, '\ufeff' + sourceText);
    const packageDir = path.join(temporary, 'package');
    execFileSync(python, ['-c', 'import sys; from pathlib import Path; import rich_text_import.core as c; c.PROJECT_ROOT=Path(sys.argv[1]); c.build_package(sys.argv[2], sys.argv[3], language="zh", content_profile="natural_language", include_reading_guide=False)', temporary, source, packageDir], {
      env: { ...process.env, PYTHONPATH: path.join(project, 'rich-text-import/src') }, windowsHide: true
    });
    const parent = JSON.parse(await fs.readFile(path.join(packageDir, 'request.json'), 'utf8'));
    const audit = path.join(temporary, 'audit');
    const report = await importTxtBook({ request: parent, output: audit, publish: path.join(temporary, 'book') });
    assert.equal(report.split_count, 3);
    const verified = JSON.parse(execFileSync(python, [path.join(project, 'scripts/verify-txt-book.py'), source, packageDir, audit], { encoding: 'utf8', windowsHide: true }));
    assert.equal(verified.passed, true);
    assert.equal(verified.uniform_sibling_granularity, true);
    assert.equal(verified.full_source_coverage, true);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
