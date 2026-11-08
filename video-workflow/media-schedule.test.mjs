import test from 'node:test';
import assert from 'node:assert/strict';
import {compileMediaSchedule} from './media-schedule.mjs';
import {screenshotTiming} from './media-timing.mjs';
const transcript={duration:100,segments:[{start:'00:00:30',end:'00:00:34',text:'演示结果已经出现'}]};
const item={kind:'screenshot',scene:'demonstration',time:'00:00:30',window_end:'00:00:50',result_start:'00:00:30',result_quote:'结果已经出现',expected_visual:'完成的结果'};
test('schedule narrows only a declared scene and binds capture to exact result end',()=>{
  const original={items:[item]},bytes=JSON.stringify(original);
  const {plan,receipt}=compileMediaSchedule(original,transcript);
  assert.equal(JSON.stringify(original),bytes);assert.equal(plan.items[0].time,'00:00:34');assert.equal(plan.items[0].window_end,'00:00:46');
  assert.equal(receipt.scene_windows_expanded,false);assert.equal(screenshotTiming(plan.items[0],transcript).requested_time,'00:00:34');
});
test('millisecond subtitles retain exact evidence; whole-second capture rounds forward inside the declared window',()=>{
  const source={duration:100,segments:[{start:'00:00:30.125',end:'00:00:34.750',text:'演示结果已经出现'}]};
  const before=JSON.stringify(source);
  const {plan}=compileMediaSchedule({items:[{...item,result_start:'00:00:30.125'}]},source);
  assert.equal(plan.items[0].time,'00:00:35');
  const timing=screenshotTiming(plan.items[0],source);
  assert.equal(timing.completion_evidence.end,'00:00:34.750');
  assert.equal(JSON.stringify(source),before);
  assert.throws(()=>compileMediaSchedule({items:[{...item,result_start:'00:00:30.125',window_end:'00:00:34'}]},source),/outside_declared/);
});
test('compiler cannot expand a scene, create evidence or accept an invalid planned time',()=>{
  assert.throws(()=>compileMediaSchedule({items:[{...item,window_end:'00:00:31'}]},transcript),/outside_declared/);
  assert.throws(()=>compileMediaSchedule({items:[{...item,result_quote:'不存在的结果'}]},transcript),/not_exact_source/);
  assert.throws(()=>compileMediaSchedule({items:[{...item,time:'00:90:00'}]},transcript),/invalid_capture/);
  assert.throws(()=>screenshotTiming(item,transcript),/invalid_capture_window/);
});
test('held-out static scene keeps selected time and only reduces its latest endpoint',()=>{
  const {plan}=compileMediaSchedule({items:[{kind:'screenshot',scene:'static',time:'00:01:20',window_end:'00:02:00',expected_visual:'讲义'}]},transcript);
  assert.equal(plan.items[0].time,'00:01:20');assert.equal(plan.items[0].window_end,'00:01:32');
  assert.equal(screenshotTiming(plan.items[0],transcript).scene,'static');
});
test('mathematical less-than in a quoted graph label uses a display-equivalent Mermaid entity; HTML remains rejected',()=>{
 const code='flowchart TD\nA["x<7"] --> B["成立"]';
 const {plan}=compileMediaSchedule({items:[{kind:'mermaid',code}]},transcript);
 assert.equal(plan.items[0].code,'flowchart TD\nA["x#60;7"] --> B["成立"]');
 assert.throws(()=>compileMediaSchedule({items:[{kind:'mermaid',code:'flowchart TD\nA["<script>bad</script>"]'}]},transcript),/unsafe_mermaid_html/);
});
