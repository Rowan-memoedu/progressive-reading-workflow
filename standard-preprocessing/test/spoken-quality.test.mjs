import assert from 'node:assert/strict';
import test from 'node:test';
import { generateLosslessSpoken } from '../lib/producer.mjs';
import { validateSpokenReview, spokenOutlineMetrics, spokenQualityFromReceipt } from '../lib/spoken-quality.mjs';

const original = '我们计划在五月安排两个独立实验。先比较室温下的测量结果，再检查高温条件下的偏差。这个条件就是设备必须经过校准，然后才能采样。如果误差超过百分之三，就停止，不得把可能有效写成已经有效。需要保留每个样本的记录，并注意测量顺序和人员分工。';
const blocks = [{ source_block_key: 'independent-1', markdown: original }];
const candidate = () => ({ cleaned_sections: [{ source_block_keys: ['independent-1'],
  markdown: `## 实验计划\n\n- 我们计划在五月安排两个独立实验。\n  - 先比较室温下的测量结果，再检查高温条件下的偏差。\n  - 设备必须经过校准，然后才能采样。\n  - 如果误差超过百分之三，就停止；可能有效不能视为已经有效。\n- 保留每个样本的记录，并注意测量顺序和人员分工。`, reason: '整理条件与步骤，保留全部信息。' }] });

test('review rejects invalid verdicts, invented source keys and empty issue evidence', () => {
  assert.deepEqual(validateSpokenReview({ verdict: 'pass', issues: [] }, blocks), []);
  for (const output of [{ verdict: 'pass', issues: [{}] }, { verdict: 'revise', issues: [] },
    { verdict: 'revise', issues: [{kind:'written',source_block_keys:['made-up'],evidence:'片段',detail:'不清楚'}] }]) {
    assert.ok(validateSpokenReview(output, blocks).length);
  }
  assert.deepEqual(spokenOutlineMetrics(candidate().cleaned_sections[0].markdown), { headings:1,top_level_items:2,nested_items:3 });
});

test('quality retry regenerates from original blocks and reviews each new candidate', async () => {
  const payload = { blocks, cleaning_policy: {include_reading_guide:false}, source_metadata:{} };
  let production = 0, reviews = 0;
  const result = await generateLosslessSpoken({}, payload, [], 'general contract', new Map(), {
    auditContract: 'audit-only',
    callModel: async (_config, prompt) => {
      if (prompt.system === 'audit-only') {
        reviews += 1;
        const data = JSON.parse(prompt.user);
        assert.equal(data.original_blocks[0].markdown, original);
        return {output: reviews === 1 ? {verdict:'revise',issues:[{kind:'structure',source_block_keys:['independent-1'],evidence:'实验计划',detail:'条件应归入计划。'}]} : {verdict:'pass',issues:[]}};
      }
      production += 1;
      assert.ok(prompt.user.includes(original));
      if (production === 2) assert.match(prompt.user, /spoken_quality_structure/u);
      return {output:candidate()};
    }
  });
  assert.equal(production, 2);
  assert.equal(reviews, 2);
  assert.equal(result.usage.stages.spoken_quality.chunks[0].attempts.length, 2);
});

test('bounded failed reviews reject production instead of accepting a readable fallback', async () => {
  await assert.rejects(generateLosslessSpoken({}, {blocks,cleaning_policy:{include_reading_guide:false},source_metadata:{}}, [], 'contract', null, {
    auditContract: 'audit-only',callModel: async (_config,prompt) => ({output: prompt.system === 'audit-only'
      ? {verdict:'revise',issues:[{kind:'information',source_block_keys:['independent-1'],evidence:'两个',detail:'数量信息必须保留。'}]}
      : candidate()})
  }), error => error.terminal && /spoken_quality_information/u.test(error.message));
});

test('cache is invalidated when either production or review prompt changes', async () => {
  const cache = new Map();
  const payload = {blocks,cleaning_policy:{include_reading_guide:false},source_metadata:{}};
  let calls = 0;
  const invoke = async (contract,feedback=[]) => generateLosslessSpoken({},payload,feedback,contract,cache,{
    auditContract:'audit-only',callModel:async(_config,prompt)=>{calls+=1;return {output:prompt.system==='audit-only'?{verdict:'pass',issues:[]}:candidate()};}
  });
  await invoke('one'); await invoke('one');
  assert.equal(calls,2);
  await invoke('one',['The operation was aborted due to timeout']);
  assert.equal(calls,2);
  await invoke('two');assert.equal(calls,4);
});

test('quality evidence survives cached replay when current-call attempts are cleared', () => {
  const quality={version:'independent-contract',chunks:[{status:'passed',attempts:[{review:{verdict:'pass',issues:[]}}]}]};
  assert.equal(spokenQualityFromReceipt({validations:[{name:'spoken_quality_review',details:{quality}}],model:{calls:0,attempts:[]}}),quality);
  assert.equal(spokenQualityFromReceipt({validations:[],model:{attempts:[{status:'accepted',usage:{stages:{spoken_quality:quality}}}]}}),quality);
  assert.equal(spokenQualityFromReceipt({validations:[],model:{attempts:[]}}),null);
});
