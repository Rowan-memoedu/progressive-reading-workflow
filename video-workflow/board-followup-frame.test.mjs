import test from 'node:test';import assert from 'node:assert/strict';import {boardFollowupFrame,bindFollowupQuote} from './board-followup-frame.mjs';
import {screenshotTiming} from './media-timing.mjs';
test('a static completed-board window ends before the spoken wrap-up can erase it; every frame still requires review',()=>{
 const t={duration:180,segments:[{start:'00:01:20',end:'00:01:25',text:'这样就完成证明'}]};
 const item=boardFollowupFrame(t,{segment_index:0,expected_visual:'完整证明',reason:'旧帧已擦除'});
 assert.equal(item.time,'00:01:13');assert.equal(item.window_end,'00:01:24');assert.equal(item.source_quote,t.segments[0].text);
 assert.deepEqual(screenshotTiming(item,t).candidates,['00:01:13','00:01:24']);
 assert.throws(()=>boardFollowupFrame(t,{segment_index:4}),/index_invalid/);
});
test('a short closing utterance binds exact adjacent source text, without inventing a quotation',()=>{
 const t={segments:[{start:'00:00:20',text:'所以两数之和非负'},{start:'00:00:25',text:'搞定啊'}]};
 const item=bindFollowupQuote({time:'00:00:23',source_segment_index:1,source_quote:'搞定啊'},t);
 assert.equal(item.source_quote,'所以两数之和非负搞定啊');assert.deepEqual(item.source_quote_segment_range,[0,1]);
 assert.throws(()=>bindFollowupQuote({time:'00:00:23',source_segment_index:1,source_quote:'结束'},t),/not_exact_source/);
});
