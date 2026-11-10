// Exercise the actual link-entry controller against already-published aliases.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountImportPage} from './browser-import-web/app.mjs';

const args=process.argv.slice(2),value=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const urls=args.flatMap((arg,i)=>arg==='--url'?[args[i+1]]:[]),endpoint=value('--endpoint','http://127.0.0.1:37829');
if(!urls.length)throw Error('usage: node scripts/canary-source-reuse.mjs --url URL --url ALIAS [--output file.json]');
const fetchImpl=(route,options)=>fetch(endpoint+route,options),dom=new JSDOM(await (await fetchImpl('/imports')).text(),{url:endpoint+'/imports#links'}),doc=dom.window.document;
const mounted=mountImportPage(doc,{fetchImpl,pollMs:100}),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  doc.getElementById('input').value=urls.join('\n');doc.getElementById('input').dispatchEvent(new dom.window.Event('input'));
  doc.getElementById('link-mode').value='original_text';doc.getElementById('link-mode').dispatchEvent(new dom.window.Event('change'));
  doc.getElementById('link-destination').value=value('--destination','链接/复用验收');doc.getElementById('link-destination').dispatchEvent(new dom.window.Event('input'));
  doc.getElementById('start').click();
  const deadline=Date.now()+120000;while((!mounted.session.current||mounted.session.pending)&&Date.now()<deadline)await delay(100);
  assert.ok(mounted.session.current&&!mounted.session.pending,'link entry did not finish');
  const rows=mounted.session.latestResults();assert.equal(rows.length,urls.length);
  for(const row of rows){assert.equal(row.status,'idempotent_replay');assert.equal(row.receipt.existing_article_preserved,true);}
  const artifacts=rows.map(row=>row.artifacts.find(a=>a.kind==='markdown'));assert.equal(new Set(artifacts.map(a=>a.path)).size,1);assert.equal(new Set(artifacts.map(a=>a.sha256)).size,1);
  const report={status:'passed',entry:'/imports#links',frontend_controller:true,urls,results:rows,summary:doc.getElementById('summary').textContent};
  const output=value('--output');if(output)await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:artifacts}));
}finally{mounted.stop();dom.window.close();}
