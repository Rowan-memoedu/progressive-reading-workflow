import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMermaidSource} from './mermaid-source.mjs';
import {bindDiagramReview} from './automate-board-correction.mjs';
test('quoted comparisons preserve semantics through both source and reviewed diagram paths',()=>{
  const code='flowchart TD\nA["0<u<3/4"] --> B["u>0"]';
  const normalized='flowchart TD\nA["0#60;u#60;3/4"] --> B["u>0"]';
  assert.equal(normalizeMermaidSource(code),normalized);
  assert.equal(normalizeMermaidSource(normalized),normalized);
  const changes=bindDiagramReview({items:[{kind:'mermaid',time:'00:00:03',code:'flowchart TD\nA-->B'}]},
    {items:[{part:1,diagram_index:0,status:'correct',code,evidence:['image'],reason:'受控来源'}]}, {frames:[{file:'image'}]},1);
  assert.equal(changes[0].after,normalized);
  assert.equal(normalizeMermaidSource('graph LR\nA<-->B'),'graph LR\nA<-->B');
});
test('HTML, external links, interactive directives and unquoted comparison text remain rejected',()=>{
  for(const code of ['A["<img src=x onerror=evil()>"]','A["<script>x</script>"]','click A "https://example.test"','%%{init: {}}%%','A[u<3]'])
    assert.throws(()=>normalizeMermaidSource('flowchart TD\n'+code),/unsafe/);
});
