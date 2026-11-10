// Use the same strict KaTeX runtime as the existing standalone renderer.
import {createRequire} from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const library=process.argv[2];
if(!library||!fs.existsSync(library))throw Error('math_syntax_runtime_unavailable');
const katex=require(library);
let input='';for await(const chunk of process.stdin)input+=chunk;
const expressions=JSON.parse(input);
const errors=[];
for(const [index,row] of expressions.entries()){
  try{katex.renderToString(row.tex,{displayMode:row.display,throwOnError:true,strict:'error'});}
  catch(error){errors.push({kind:'rendering',index,candidate_evidence:row.tex,
    description:String(error)});}
}
process.stdout.write(JSON.stringify(errors));
