import test from 'node:test';
import assert from 'node:assert/strict';
import{discover,observe,processPending,itemKey,canonicalUrl,entryPublication,videoId,resumePublishedItem}from'./watch-core.mjs';
const a='BV1234567890',b='BVabcdefghij';
const watch={id:'course',url:canonicalUrl(a),destination:'D:/Reading/Course'};
const view=(bvid,pages,season)=>({bvid,title:bvid,owner:{mid:1},pages:pages.map((cid,n)=>({cid,page:n+1,part:'章节'+n})),ugc_season:season});
test('discovers every part of every collection video, rather than just first cid',async()=>{
 const data={[a]:view(a,[11,12],{id:7,ep_count:2,sections:[{episodes:[{bvid:a},{bvid:b}]}]}),[b]:view(b,[21,22])};
 const result=await discover(watch,{api:async endpoint=>data[endpoint.split('=')[1]]});
 assert.deepEqual(result.items.map(i=>i.key),[itemKey(a,11),itemKey(a,12),itemKey(b,21),itemKey(b,22)]);
 assert.equal(result.items[3].url,canonicalUrl(b,2));
});
test('paginates incomplete collection lists and rejects truncated pagination',async()=>{
 const seed=view(a,[11],{id:7,ep_count:2,sections:[{episodes:[{bvid:a}]}]});
 const api=async e=>e.includes('seasons_archives_list')?{page:{total:2},archives:[{bvid:a},{bvid:b}]}:e.endsWith(a)?seed:view(b,[21]);
 assert.equal((await discover(watch,{api})).items.length,2);
 await assert.rejects(discover(watch,{api:async e=>e.includes('seasons_archives_list')?{page:{total:2},archives:[]}:seed}),/incomplete/);
});
test('cid identity survives title or page-number changes; overlapping watches and repeated scans deduplicate',()=>{
 const state={entries:{}},first={key:itemKey(a,11),bvid:a,cid:11,part:1,parts:1,video_title:'旧标题',url:canonicalUrl(a)};
 observe(state,watch,[first],{baseline:true});
 assert.equal(observe(state,watch,[{...first,part:2,video_title:'改名'}]).length,0);
 const newPart={...first,key:itemKey(a,12),cid:12,part:2,parts:2};
 assert.equal(observe(state,watch,[newPart]).length,1);
 assert.equal(observe(state,{...watch,id:'second'},[newPart]).length,0);
 assert.equal(Object.keys(state.entries).length,2);
});
test('existing publications are reused and baseline never queues old videos',()=>{
 const state={entries:{}},item={key:itemKey(a,1),bvid:a,cid:1,part:1,parts:1,video_title:'一讲',url:canonicalUrl(a)};
 observe(state,watch,[item],{existing:new Map([[item.url,'existing.md']]),baseline:true});
 assert.equal(state.entries[item.key].status,'completed');
 assert.equal(state.entries[item.key].publication,'existing.md');
 assert.match(entryPublication(watch.destination,{...item,parts:2,part:2,part_title:'续篇'}),/P2/);
 assert.throws(()=>videoId('https://evil.example/video/'+a));
});
test('no-subtitle items wait, failed model jobs block, and completed jobs never repeat',async()=>{
 const state={entries:{one:{key:'one',status:'pending'},two:{key:'two',status:'pending'},three:{key:'three',status:'running'}}};
 let calls=0;
 const processItem=async item=>{calls++;if(item.key==='one')return{status:'waiting_source',reason:'no_subtitles'};throw Error('saved_response_rejected');};
 await processPending(state,{processItem,save:async()=>{}});
 assert.equal(calls,2);assert.equal(state.entries.two.status,'blocked');assert.equal(state.entries.three.status,'blocked');
 await processPending(state,{processItem:async()=>{calls++;return{status:'completed',publication:'ready.md'};},save:async()=>{}});
 assert.equal(calls,3);assert.equal(state.entries.one.status,'completed');
 await processPending(state,{processItem,save:async()=>{}});assert.equal(calls,3);
});
test('explicit resume requires verified existing output and cannot authorize new generation',async()=>{
 const state={entries:{one:{key:'one',status:'blocked',reason:'render failed'},two:{key:'two',status:'completed'}}};
 await assert.rejects(resumePublishedItem(state,'one',async()=>{throw Error('changed output');}),/changed output/);
 assert.equal(state.entries.one.status,'blocked');
 await assert.rejects(resumePublishedItem(state,'two',async()=>{}),/blocked/);
 await resumePublishedItem(state,'one',async item=>assert.equal(item.key,'one'));
 assert.equal(state.entries.one.status,'pending');assert.equal(state.entries.one.resume_mode,'verification_only');
});
