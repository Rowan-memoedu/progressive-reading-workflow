import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CODEX_TRANSPORT_VERSION} from './codex-exec.mjs';

export const FULL_TEXT_BODY_VERSION = 'full-text-body/v1';
export const BODY_PROMPTS = Object.freeze({
  strong_structuring: {name:'强结构化整理', file:'强结构化整理.md'},
  spoken_to_written: {name:'全文口语转书面', file:'spoken-to-written-fulltext-v1.md'}
});
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

// A shared source-neutral step: one whole input, one response, no automatic retry.
export async function fullTextBodyContext({markdown, mode, cacheDir, producerIdentity,producerConfig,requiredProvider}) {
  const definition = BODY_PROMPTS[mode];
  if (!definition) throw new Error(`unknown_body_mode:${mode}`);
  const promptPath = path.resolve(import.meta.dirname, '../prompts', definition.file);
  const prompt = await fs.readFile(promptPath);
  const sourceProtocol=await fs.readFile(path.resolve(import.meta.dirname,'../prompts/source-preservation-protocol-v1.md'));
  if(!producerIdentity||requiredProvider){
    const {loadProducerConfig,producerBackend,producerModel}=await import('./producer.mjs');
    producerConfig ||= await loadProducerConfig({requiredProvider});
    const backend=producerBackend(producerConfig);
    if(requiredProvider&&backend!==requiredProvider)throw Error('producer_requires_'+requiredProvider);
    const actual=[backend,backend==='codex_exec'?'codex_exec':new URL(producerConfig.AI_PRODUCER_BASE_URL).hostname,producerModel(producerConfig),
      ...(backend==='codex_exec'?[CODEX_TRANSPORT_VERSION]:[])];
    if(producerIdentity&&JSON.stringify(producerIdentity)!==JSON.stringify(actual))throw Error('producer_identity_changed');
    producerIdentity=actual;
  }
  const identity = hash(JSON.stringify([FULL_TEXT_BODY_VERSION,mode,hash(prompt),hash(sourceProtocol),'system-source-protocol/v2',markdown,
    'unified-reading-transport/v1',producerIdentity,
    ...(/\$|\\\(|\\\[/u.test(markdown)?['math-source-reference/v1']:[])]));
  const root = cacheDir || process.env.PR_FULL_TEXT_CACHE || 'D:/Caches/ProgressiveReading/full-text-body';
  const target = path.join(path.resolve(root),'full-text-body',identity);
  return {target,promptPath,definition,producerConfig,producerIdentity};
}

export async function refineFullTextOnce({markdown, mode, outputDir, cacheDir, producerConfig, producerIdentity,requiredProvider}) {
  producerConfig ||= await (await import('./producer.mjs')).loadProducerConfig({requiredProvider});
  const {target,promptPath,definition}=await fullTextBodyContext({markdown,mode,cacheDir,producerIdentity,producerConfig,requiredProvider});
  await fs.mkdir(target,{recursive:true});
  const input = path.join(target,'original.md');
  try { await fs.writeFile(input,markdown,{flag:'wx'}); }
  catch(error) { if(error.code !== 'EEXIST' || await fs.readFile(input,'utf8') !== markdown) throw error; }
  const response = await execute(process.env.PR_AUDIO_PYTHON || 'D:/AppData/AudioWorkflow/python/Scripts/python.exe',[
    '-u',path.resolve(import.meta.dirname,'../refine-full-text.py'),
    '--input',input,'--output',target,'--mode',mode,'--prompt',promptPath,
    '--max-output-tokens','65536',
    '--reading-transport',...(requiredProvider?['--required-provider',requiredProvider]:[])
  ],{maxBuffer:1024*1024,windowsHide:true, env: { ...process.env,
    ...Object.fromEntries(Object.entries(producerConfig).map(([key,value]) => [key,String(value)])),
    PR_READING_NODE: process.execPath }});
  const receipt = JSON.parse(await fs.readFile(path.join(target,'refinement-receipt.json'),'utf8'));
  if(receipt.status !== 'completed') throw new Error('full_text_body_incomplete');
  if(outputDir && path.resolve(outputDir) !== target) {
    await fs.mkdir(outputDir,{recursive:true});
    // Audit files contain only source, prompts, output and allowlisted call metadata.
    for(const name of await fs.readdir(target)) await fs.copyFile(path.join(target,name),path.join(outputDir,name));
  }
  return {markdown:await fs.readFile(path.join(target,'body.md'),'utf8'),
    receipt:{...receipt,name:definition.name,audit_dir:outputDir ? path.resolve(outputDir) : target,
      cache_dir:target}, log:response.stdout.trim()};
}
