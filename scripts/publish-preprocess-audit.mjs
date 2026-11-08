import fs from 'node:fs/promises';
import path from 'node:path';
import { publishReadingArtifact } from '../standard-preprocessing/index.mjs';
const runDir = path.resolve(process.argv[2]);
const result = JSON.parse(await fs.readFile(path.join(runDir,'result.json'),'utf8'));
const publication = await publishReadingArtifact(result,{runDir,publishPath:path.resolve(process.argv[3])});
console.log(JSON.stringify(publication));
