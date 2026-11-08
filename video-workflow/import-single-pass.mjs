import fs from 'node:fs/promises';
import {importTranscript} from './import-transcript.mjs';

const args = {};
for (let i=2;i<process.argv.length;i+=2) args[process.argv[i].replace(/^--/u,'')]=process.argv[i+1];
for (const key of ['input','output','publish']) if (!args[key]) throw new Error(`--${key} required`);
if (args.mode && !['strong_structuring','spoken_to_written'].includes(args.mode)) throw new Error('unknown --mode');

const receipt=await importTranscript({inputDir:args.input,outputDir:args.output,publishPath:args.publish,
  processingOptions:{...(args.options ? JSON.parse(await fs.readFile(args.options,'utf8')) : {}),
    structure_body:args.mode !== 'spoken_to_written', spoken_to_written:args.mode === 'spoken_to_written'}});
console.log(JSON.stringify({status:receipt.status,path:receipt.publication.markdown.path,
  refinement_calls:receipt.refinement.api_calls_this_run,total_calls:receipt.model.calls,
  attachments_retained:receipt.attachments.length,attachments_referenced:receipt.used_attachments.length}));
