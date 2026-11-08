import test from "node:test";
import assert from "node:assert/strict";
import { chunkTranslationUnits, continuousTranslationInput, decodeContinuousTranslation } from "../lib/translation-units.mjs";

test("short list stays with its heading and introducing paragraph beyond six blocks", () => {
  const blocks = [
    { type:"heading", markdown:"## Questions" },
    { type:"paragraph", markdown:"These questions refer to the preceding explanation." },
    ...Array.from({length:16},(_,i)=>({type:"list",markdown:"- Question "+i+"?"}))
  ];
  assert.deepEqual(chunkTranslationUnits(blocks),[blocks]);
});

test("large material splits at semantic boundaries without losing or duplicating blocks", () => {
  const blocks=Array.from({length:8},(_,i)=>[
    {type:"heading",markdown:"## Part "+i},
    {type:"paragraph",markdown:"x".repeat(300)},
    {type:"list",markdown:"- A"},
    {type:"list",markdown:"- B"}
  ]).flat();
  const chunks=chunkTranslationUnits(blocks,{maxChars:700});
  assert.ok(chunks.length>1);
  assert.deepEqual(chunks.flat(),blocks);
  assert.ok(chunks.every(c=>c[0].type==="heading"));
});

test("continuous transport restores keys, indentation and duplicate per-block protected tokens", () => {
  const blocks=[{source_block_key:"a"},{source_block_key:"b"}];
  const protectedByKey=new Map([["a",{protectedMarkdown:"Text ZXQPRP0000QXZ"}],["b",{protectedMarkdown:"    - Other ZXQPRP0000QXZ"}]]);
  const input=continuousTranslationInput(blocks,protectedByKey);
  const output=decodeContinuousTranslation({markdown:input.replace("Text","正文").replace("Other","其他")},blocks);
  assert.deepEqual(output.translations,[{source_block_key:"a",markdown:"正文 ZXQPRP0000QXZ"},{source_block_key:"b",markdown:"    - 其他 ZXQPRP0000QXZ"}]);
  assert.deepEqual(decodeContinuousTranslation({markdown:input.replace("ZXQSEG000001QXZ","ZXQSEG000000QXZ")},blocks),{translations:[]});
  assert.deepEqual(decodeContinuousTranslation({markdown:"Unexpected introduction\n"+input},blocks),{translations:[]});
});
