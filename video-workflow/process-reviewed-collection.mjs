import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mergeReviewedVideoParts} from './merge-reviewed-video-parts.mjs';
import {importTranscript,parseTranscript} from './import-transcript.mjs';
import {groupTranscriptSegments} from '../scripts/import-youtube-subtitle-canary.mjs';
import {captionMediaSource,extractBookMedia,imageEmbed} from './book-media.mjs';
import {refineAndProjectGeneratedMedia} from './generated-media-projection.mjs';
import {loadProducerConfig,ExternalProducer} from '../standard-preprocessing/lib/producer.mjs';
import {checkFormulaConsistency} from './formula-consistency.mjs';
const execute=promisify(execFile),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
export async function processReviewedCollection({parts,title,outputDir,publishPath}){
 const source=path.join(outputDir,'source'),run=path.join(outputDir,'run');await fs.mkdir(outputDir,{recursive:true});
 const python='D:/Caches/ProgressiveReading/videobook-python/Scripts/python.exe';
 for(const part of parts){
  await execute(python,[path.join(import.meta.dirname,'verify-board-correction.py'),'--input',part.inputDir],{windowsHide:true});
  await execute(python,[path.join(import.meta.dirname,'admit-board-correction.py'),'--input',part.inputDir,'--run',part.runDir],{windowsHide:true});
 }
 const merged=await mergeReviewedVideoParts({parts,title,outputDir:source});
 const segments=parseTranscript(merged.transcript.segments.map(s=>'['+s.start+'] placeholder').join('\n'));
 segments.forEach((s,i)=>s.text=merged.transcript.segments[i].text);
 const paragraphs=groupTranscriptSegments(segments),book=await fs.readFile(path.join(source,'book.md'),'utf8');
 const inventory=merged.manifest.images.map(a=>({path:a.target}));
 const media=captionMediaSource({markdown:paragraphs.map(p=>p.text).join('\n\n'),paragraphs,bookMarkdown:book,inventory,slug:title});
 const refinement=await refineAndProjectGeneratedMedia({markdown:media.markdown,mode:'strong_structuring',outputDir:path.join(run,'preprocess/body-refinement'),
  generatedMedia:extractBookMedia(book,inventory).map(item=>({...item,literal:item.literal||imageEmbed(item.label,item.path)})),transcript:merged.transcript});
 const notes=[];for(const part of parts){const ledger=await read(path.join(part.inputDir,'board-correction.json'));notes.push(...ledger.formula_notes.map(n=>n.text));}
 const formulas=checkFormulaConsistency(refinement.markdown,notes);await fs.writeFile(path.join(outputDir,'formula-consistency.json'),JSON.stringify(formulas,null,2)+'\n');
 if(formulas.status!=='passed')throw Error('collection_formula_review_required');
 const producer=new ExternalProducer(await loadProducerConfig({requiredProvider:'codex_exec'}));
 const receipt=await importTranscript({inputDir:source,outputDir:run,publishPath,producer,
  processingOptions:{source_language:'zh',content_profile:'math_lecture',structure_body:true,spoken_to_written:false,include_reading_guide:true},
  bodyRefiner:async({markdown})=>{if(markdown!==media.markdown)throw Error('collection_source_changed');return refinement;}});
 await fs.writeFile(path.join(outputDir,'collection-receipt.json'),JSON.stringify({status:'completed',parts:merged.manifest.parts,publication:receipt.publication.markdown,
  body_calls:refinement.receipt.api_calls_total,guide_calls:receipt.reading_guide.calls,media:receipt.book_media.counts,formula_check:formulas.status},null,2)+'\n');
 return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/u,'')]=process.argv[i+1];
 try{console.log(JSON.stringify(await processReviewedCollection(await read(args.input))));}catch(e){console.error(e.message);process.exitCode=1;}
}
