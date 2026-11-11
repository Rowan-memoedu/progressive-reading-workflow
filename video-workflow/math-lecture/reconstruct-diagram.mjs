// Numeric scientific diagrams reuse the maintained Topic Diagrams renderer.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
for(const name of ['source-image','source-id','plan','output'])if(!args[name])throw Error('required_argument:'+name);
const rendererRoot=process.env.MATH_LECTURE_DIAGRAMS_ROOT||'D:/Projects/MathTopicPipeline/diagrams';
const {resolveFigures}=require(path.join(rendererRoot,'geometry.cjs'));
const {render}=require(path.join(rendererRoot,'render.cjs'));
const source=await fs.readFile(args['source-image']);
const bytes=await fs.readFile(args.plan),plan=JSON.parse(bytes.toString('utf8'));
if(plan.source_sha256!==hash(source)||plan.source_id!==args['source-id'])throw Error('diagram_original_source_mismatch');
const figures=resolveFigures(plan.figures);
if(figures.size!==1)throw Error('one_local_purpose_per_diagram');
const figure=[...figures.values()][0];
for(const check of plan.curve_checks||[]){
  const element=figure.expanded.elements[check.element];
  if(element?.type!=='curve'||element.kind!=='polynomial'||!Number.isFinite(check.at)||!Number.isFinite(check.value))throw Error('invalid_curve_check');
  const actual=element.coefficients.reduceRight((value,c)=>value*check.at+c,0);
  if(check.at<element.domain[0]||check.at>element.domain[1]||Math.abs(actual-check.value)>1e-8*Math.max(1,Math.abs(check.value)))throw Error('diagram_curve_source_constraint_failed');
}
const output=path.resolve(args.output),key=hash(bytes),folder=path.join(output,key);
await fs.mkdir(folder,{recursive:true});
const receiptFile=path.join(folder,'receipt.json');
try{
  const saved=JSON.parse(await fs.readFile(receiptFile,'utf8'));
  for(const [ext,digest]of Object.entries(saved.hashes))if(hash(await fs.readFile(path.join(folder,'diagram.'+ext)))!==digest)throw Error('diagram_cached_asset_changed');
  if(saved.source_sha256!==hash(source)||saved.plan_sha256!==key)throw Error('diagram_cache_identity_changed');
  console.log(JSON.stringify({...saved,receipt_path:receiptFile}));
}catch(error){
  if(error.code!=='ENOENT')throw error;
  const result=await render(figure);
  for(const [name,data]of [['diagram.png',result.png],['diagram.svg',result.svg],['plan.json',bytes]]){
    const file=path.join(folder,name);
    try{await fs.writeFile(file,data,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||!Buffer.from(data).equals(await fs.readFile(file)))throw e;}
  }
  const receipt={source_image_id:args['source-id'],source_sha256:hash(source),plan_path:path.resolve(args.plan),plan_sha256:key,
    path:path.join(folder,'diagram.png'),svg:path.join(folder,'diagram.svg'),hashes:{png:hash(result.png),svg:hash(result.svg)},
    renderer:'MathTopicPipeline/diagrams',checks:figure.checkResults,curve_checks:plan.curve_checks||[],layout:result.layout};
  await fs.writeFile(receiptFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...receipt,receipt_path:receiptFile}));
}
