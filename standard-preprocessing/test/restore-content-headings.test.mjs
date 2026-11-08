import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreContentHeadings} from '../lib/restore-content-headings.mjs';

test('heading repair reuses ordered source headings and preserves every target character',()=>{
  const first='The first observation records the temperature before any adjustment to the equipment. The original measurement remains available for comparison.';
  const second='The second observation records the temperature after the adjustment. The two observations must use the same measurement interval and sensor position.';
  const reference=`## Before adjustment\n${first}\n\n## After adjustment\n${second}`;
  const target=`# Observations\n\n${first}\n\n${second}\n`;
  const result=restoreContentHeadings(reference,target);
  assert.equal(result.placements.length,2);
  assert.equal(result.markdown.replace(/^## (?:Before|After) adjustment\n\n/gmu,''),target);
  assert.equal(result.prose_unchanged,true);
});

test('heading repair refuses unrelated prose instead of guessing placement',()=>{
  assert.throws(()=>restoreContentHeadings('## Unrelated subject\nA completely unrelated explanation that has no shared literal evidence in the requested target paragraphs.','# Target\n\nDifferent material.'),/no_unambiguous_heading_alignment/);
});
