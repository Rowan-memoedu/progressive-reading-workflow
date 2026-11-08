import assert from 'node:assert/strict';
import test from 'node:test';
import { isBibliographicReferenceBlock } from '../lib/producer.mjs';
test('standalone linked author-year citations are references, explanatory prose is not', () => {
  assert.equal(isBibliographicReferenceBlock('[A Survey of Quantum Systems](https://example.org/paper.pdf) (Miller, 2021)'), true);
  assert.equal(isBibliographicReferenceBlock('[Tree Growth](https://example.org/tree.pdf) (Evans, Clark, & Jones, 1999)'), true);
  assert.equal(isBibliographicReferenceBlock('[A Survey of Quantum Systems](https://example.org/paper.pdf) (Miller, 2021) Importance: This experiment changed how we understand the system.'), false);
  assert.equal(isBibliographicReferenceBlock('Miller (2021) claims that the treatment works in all cases.'), false);
  assert.equal(isBibliographicReferenceBlock('The measurement was reported by J. Field and R. Stone in 2019. This paragraph explains why that method fails under uncertainty.'), false);
  assert.equal(isBibliographicReferenceBlock('- J. Field, R. Stone, Measuring Evidence, 2019.'), true);
  assert.equal(isBibliographicReferenceBlock('Field, J., and Stone, R. Measuring Evidence. 2019.'), true);
  assert.equal(isBibliographicReferenceBlock('Miller, Anna. 2018. “Measuring Evidence.” New York: Example Press.'), true);
});
