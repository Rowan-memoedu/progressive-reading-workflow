// Readable source fallback cannot satisfy a requested guide. All entries must
// report the missing result without creating a formal reading document.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startFixture } from "./browser-import-web/fixture.mjs";
const fixture=await startFixture({producer:"synthetic-invalid"});
const post=async(route,body)=>fetch(fixture.baseUrl+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
try {
  const source=fixture.sourceUrl+"/required-guide";
  const draft={id:"failed-guide",url:source,title:"缺少必需导读",html:"<article><p>中文正文清晰可读，但是没有生成所要求的导读，因此不能放行。</p></article>",sourceMetadata:{input_form:"written",content_profile:"natural_language",language:"zh"}};
  const response=await post("/api/highlights/import-local",{draft});
  assert.equal(response.status,422);
  const error=await response.json();
  assert.equal(error.code,"required_reading_guide_missing");
  assert.equal(error.details.stage,"reading_guide");
  for (const entry of ["obsidian_local_ir","browser_extension","web_import_page"]) {
    const created=await(await post("/api/browser-import/requests",{urls:[source],source:entry,client_request_id:entry})).json();
    let result;
    for(let i=0;i<100;i++){const request=await(await fetch(fixture.baseUrl+"/api/browser-import/requests/"+created.request_id)).json();if(request.terminal){result=request.results[0];break;}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(result?.status,"failed",JSON.stringify(result));
    assert.equal(result.errors[0].code,"required_reading_guide_missing");
    assert.match(result.error,/未生成所要求的导读/u);
  }
  const entries=await fs.readdir(fixture.workflowRoot+"/阅读区",{recursive:true});
  assert.equal(entries.filter(name=>name.endsWith(".md")).length,0);
  const empty=await post("/api/highlights/import-local",{draft:{...draft,html:"",pageText:""}});
  assert.equal(empty.status,422);
  console.log(JSON.stringify({status:"passed",checks:["readable_source_not_a_generated_guide","browser_422_stage_error","three_entries_reject_missing_guide","no_formal_markdown","empty_body_rejected"],root:fixture.root}));
}finally{await fixture.stop();}
