// Optional rendering check using installed Playwright + Chrome; all POSTs mocked.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const {chromium}=await import(process.env.LOCAL_IR_PLAYWRIGHT_MODULE?pathToFileURL(process.env.LOCAL_IR_PLAYWRIGHT_MODULE).href:'playwright');
const output=process.argv[2];if(!output)throw new Error('需要截图输出目录');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[],submissions=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/subscriptions/source',async route=>{submissions.push(route.request().postDataJSON());await route.fulfill({json:{status:'saved'}});});
  await page.goto((process.env.PROGRESSIVE_READING_ENDPOINT || 'http://127.0.0.1:37829')+'/subscriptions',{waitUntil:'networkidle'});
  await page.locator('.source').first().waitFor();
  await page.locator('#add').click();await page.locator('#kind').selectOption('github_repository');
  await page.locator('#name').fill('Repository fixture');await page.locator('#url').fill('https://github.com/example/translations');
  await page.locator('#repository-root').fill('docs');await page.locator('#repository-site').fill('https://example.github.io/translations/');
  assert.equal(await page.locator('#mode').inputValue(),'original_text');assert.equal(await page.locator('#history_mode').inputValue(),'all');
  assert.equal(await page.locator('#destination').inputValue(),'订阅/GitHub仓库');
  const widths=[768,414,375,320],results=[];
  for(const width of widths){
    await page.setViewportSize({width,height:1000});
    const dimensions=await page.evaluate(()=>({content:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(dimensions.content<=width);await page.locator('#editor').screenshot({path:path.join(output,`repository-${width}.png`)});results.push({width,...dimensions});
  }
  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('已保存'));
  assert.equal(submissions.length,1);assert.equal(submissions[0].source.repository.content_root,'docs');assert.equal(submissions[0].source.repository.public_base,'https://example.github.io/translations/');
  assert.deepEqual(errors,[]);
  const report={status:'passed',real_writes:0,widths:results};await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
