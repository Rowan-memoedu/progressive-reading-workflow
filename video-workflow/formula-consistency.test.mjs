import test from 'node:test';
import assert from 'node:assert/strict';
import {checkFormulaConsistency} from './formula-consistency.mjs';

test('compound spoken denominators are not mistaken for atomic inverse fractions',()=>{
  assert.equal(checkFormulaConsistency('u加v分之w',['$\\frac{v}{w}$']).status,'passed');
  assert.equal(checkFormulaConsistency('九分之四',['$\\frac{9}{4}$']).status,'needs_review');
});

test('multi-character Chinese numerals retain their complete value in both directions',()=>{
  assert.equal(checkFormulaConsistency('六十四分之九',['$\\frac{4}{9}$']).status,'passed');
  const result=checkFormulaConsistency('六十四分之九',['$\\frac{64}{9}$']);
  assert.equal(result.status,'needs_review');assert.equal(result.issues[0].parsed_fraction,'9/64');
  assert.equal(checkFormulaConsistency('一百零二分之十二',['$\\frac{102}{12}$']).status,'needs_review');
  assert.equal(checkFormulaConsistency('一亿零二万分之九',['$\\frac{100020000}{9}$']).issues[0].parsed_fraction,'9/100020000');
});

test('held-out letters and coefficients catch inverted prose without repairing the candidate',()=>{
  const source=['$\\frac q7+\\frac1q$'],body='# 测量\n- 计算q分之七加q分之一';
  const result=checkFormulaConsistency(body,source);
  assert.equal(result.status,'needs_review');assert.equal(result.issues.length,1);
  assert.equal(result.issues[0].source_fraction,'q/7');assert.equal(result.issues[0].parsed_fraction,'7/q');
  assert.equal(result.body_modified,false);assert.equal(result.model_calls,0);
});

test('do not reject a source that really uses both orientations or an unknown incidental example',()=>{
  assert.equal(checkFormulaConsistency('- q分之七',['$\\frac q7+\\frac7q$']).status,'passed');
  assert.equal(checkFormulaConsistency('- x分之四',['$\\frac q7$']).status,'passed');
  assert.equal(checkFormulaConsistency('- 七分之q，q分之一',['$\\frac q7+\\frac1q$']).status,'passed');
});
