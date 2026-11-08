// Isolated browser acceptance: synthetic configuration only, no user profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {SCHEMA,SCHEDULE,paths,normalizeSource,writeJson,loadConfig} from '../subscription-workflow/config.mjs';
import {handleSubscriptions} from '../subscription-workflow/http.mjs';

const output=path.resolve(process.argv[2]||'D:/Artifacts/ProgressiveReading/subscription-sections-ui');
await fs.mkdir(output,{recursive:true});
const temp=path.join(output,'browser-temp');await fs.mkdir(temp,{recursive:true});process.env.TEMP=temp;process.env.TMP=temp;
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await fs.mkdtemp(path.join(output,'fixture-')),home=path.join(root,'home');
const sources=[
  {kind:'rss',name:'RSS 示例',url:'https://active.test/feed'},
  {kind:'zhihu_column',name:'知乎专栏示例',url:'https://www.zhihu.com/column/c_synthetic'},
  {kind:'zhihu_author',name:'知乎作者示例',url:'https://www.zhihu.com/people/synthetic'},
  {kind:'bilibili_collection',name:'B 站合集示例',url:'https://www.bilibili.com/video/BV1234567890/'},
  {kind:'bilibili_video',name:'B 站多 P 示例',url:'https://www.bilibili.com/video/BV0987654321/'},
  {kind:'rss',name:'已停用 RSS 示例',url:'https://disabled.test/feed',enabled:false},
  {kind:'zhihu_column',name:'已停用专栏示例',url:'https://www.zhihu.com/column/c_disabled',enabled:false}
].map(value=>normalizeSource({...value,mode:'reports'}));
await writeJson(paths(root).marker,{home});
await writeJson(paths(root).config,{schema:SCHEMA,revision:1,enabled:true,schedule:SCHEDULE,rss_home:path.join(root,'rss'),subscriptions:sources});
const historical=path.join(root,'existing-article.md');await fs.writeFile(historical,'Synthetic imported body and annotations.');
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/api/subscriptions'){
      const config=await loadConfig(root);res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({...config,initialized:true,heartbeat:{at:new Date().toISOString()},reports:[],jobs:[],conflicts:[],pending:[],failures:[],zhihu_sources:{orphan:{error:'Removed subscription error must stay hidden'}}}));return;
    }
    if(!await handleSubscriptions(req,res,root)){res.writeHead(404);res.end();}
  }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
let browser;
const errors=[];
try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/subscriptions');await page.waitForSelector('#sources .source');
  assert.equal(await page.locator('#sources .source-group').count(),5);assert.equal(await page.locator('.badge').count(),0);
  assert.equal(await page.locator('#disabled-subscriptions').evaluate(e=>e.open),false);
  assert.equal(await page.getByText('Removed subscription error must stay hidden').count(),0);
  const columnGroup=page.locator('[data-source-group="enabled:zhihu_column"]');
  await columnGroup.locator('summary').click();await page.locator('#refresh').click();
  assert.equal(await columnGroup.evaluate(e=>e.open),false);
  await columnGroup.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await columnGroup.evaluate(e=>e.open),true);

  const active=sources[0],activeRow=()=>page.locator(`#sources [data-source-id="${active.id}"]`);
  await activeRow().getByRole('button',{name:'停用',exact:true}).click();
  await page.waitForFunction(id=>!document.querySelector(`#sources [data-source-id="${id}"]`),active.id);
  assert.equal(await page.locator(`#disabled-sources [data-source-id="${active.id}"]`).count(),1);
  assert.equal(await page.locator('#disabled-subscriptions').evaluate(e=>e.open),false);
  await page.locator('#disabled-subscriptions>summary').click();
  await page.locator(`#disabled-sources [data-source-id="${active.id}"]`).getByRole('button',{name:'启用',exact:true}).click();
  await page.waitForSelector(`#sources [data-source-id="${active.id}"]`);
  assert.equal(await activeRow().getByRole('button',{name:'删除',exact:true}).count(),0);

  const disabled=sources.at(-1),disabledRow=page.locator(`#disabled-sources [data-source-id="${disabled.id}"]`);
  let release;const failureGate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/subscriptions/source/delete',async route=>{await failureGate;await route.fulfill({status:400,json:{error:'Synthetic deletion failure'}});});
  await disabledRow.getByRole('button',{name:'删除',exact:true}).click();
  await page.waitForSelector('[aria-busy="true"]');assert.equal(await disabledRow.getByRole('button',{name:'正在处理…',exact:true}).isDisabled(),true);
  release();await page.waitForFunction(()=>document.getElementById('message').textContent==='Synthetic deletion failure');
  assert.equal(await disabledRow.count(),1);await page.unroute('**/api/subscriptions/source/delete');
  await disabledRow.getByRole('button',{name:'删除',exact:true}).click();
  await page.waitForFunction(id=>!document.querySelector(`[data-source-id="${id}"]`),disabled.id);
  assert.equal((await loadConfig(root)).subscriptions.some(s=>s.id===disabled.id),false);
  await page.reload();await page.waitForSelector('#sources .source');
  assert.equal(await page.getByText(disabled.name,{exact:true}).count(),0);
  assert.equal(await page.locator('#disabled-subscriptions').evaluate(e=>e.open),false);
  assert.equal(await fs.readFile(historical,'utf8'),'Synthetic imported body and annotations.');

  const widths=[];
  for(const width of [1280,768,414,375,320]){
    await page.setViewportSize({width,height:1000});
    for(const disabledOpen of [false,true]){
      await page.locator('#disabled-subscriptions').evaluate((e,open)=>{e.open=open;},disabledOpen);
      const dimensions=await page.evaluate(()=>({root:document.documentElement.scrollWidth,viewport:innerWidth,smallButtons:[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<44).length}));
      assert.ok(dimensions.root<=width,JSON.stringify({width,disabledOpen,...dimensions}));assert.equal(dimensions.smallButtons,0);
      await page.screenshot({path:path.join(output,`subscriptions-${width}-${disabledOpen?'expanded':'collapsed'}.png`),fullPage:true});
    }
    widths.push(width);
  }
  assert.deepEqual(errors,[]);
  const receipt={status:'passed',widths,grouping:true,collapse_state_preserved:true,disabled_default_closed:true,disable_enable_delete_persisted:true,previous_material_preserved:true,live_user_writes:0,console_errors:errors};
  await fs.writeFile(path.join(output,'ui-verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
