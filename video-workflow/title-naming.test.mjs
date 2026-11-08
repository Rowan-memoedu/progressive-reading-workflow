import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {bookPublicationPath} from './book-folder.mjs';
test('BV placeholders use source title and retain mode suffix in file and folder',()=>{
 const base='D:/Artifacts/fixture/reading';
 const source={video_id:'BV1Zx2345678',title:'仪器校准'};
 const expected=path.resolve(base,'仪器校准（强结构化整理）','仪器校准（强结构化整理）.md');
 assert.equal(bookPublicationPath(base+'/BV1Zx2345678（强结构化整理）.md',source),expected);
 assert.equal(bookPublicationPath(base+'/BV1Zx2345678（强结构化整理）/BV1Zx2345678（强结构化整理）.md',source),expected);
});
test('explicit titles and other video ids are preserved',()=>{
 const source={video_id:'BV1Zx2345678',title:'仪器校准'};
 assert.equal(bookPublicationPath('D:/Artifacts/fixture/用户自定.md',source),path.resolve('D:/Artifacts/fixture/用户自定/用户自定.md'));
 assert.equal(bookPublicationPath('D:/Artifacts/fixture/BV1Ab2345678.md',source),path.resolve('D:/Artifacts/fixture/BV1Ab2345678/BV1Ab2345678.md'));
});
test('unsafe title characters cannot change the destination directory',()=>{
 const source={video_id:'BV1Zx2345678',title:'../校准 | 观测?'};
 const output=bookPublicationPath('D:/Artifacts/fixture/BV1Zx2345678.md',source);
 assert.equal(path.dirname(path.dirname(output)),path.resolve('D:/Artifacts/fixture'));
 assert.equal(path.basename(output),'..－校准 － 观测－.md');
});
