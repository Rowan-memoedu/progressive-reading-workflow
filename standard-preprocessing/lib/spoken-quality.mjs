// The production/review contract is source-neutral. Fixtures never enter prompts.
export const SPOKEN_REFINEMENT_VERSION = 'spoken-outline-quality/v3-written';

export function spokenQualityFromReceipt(receipt) {
  return receipt?.validations?.find(item => item.name === 'spoken_quality_review')?.details?.quality
    || receipt?.model?.attempts?.find(attempt => attempt.status === 'accepted')?.usage?.stages?.spoken_quality
    || null;
}

export function validateSpokenReview(output, blocks) {
  const keys = new Set(blocks.map(block => block.source_block_key));
  const failures = [];
  if (!output || !['pass', 'revise'].includes(output.verdict) || !Array.isArray(output.issues)) {
    return ['spoken_quality_review_invalid_shape'];
  }
  for (const issue of output.issues) {
    if (!['information', 'written', 'repetition', 'structure'].includes(issue?.kind)
        || !Array.isArray(issue.source_block_keys) || !issue.source_block_keys.length
        || issue.source_block_keys.some(key => !keys.has(key))
        || !String(issue.evidence || '').trim() || !String(issue.detail || '').trim()) {
      failures.push('spoken_quality_review_invalid_issue');
    }
  }
  if ((output.verdict === 'pass') !== (output.issues.length === 0)) failures.push('spoken_quality_review_verdict_mismatch');
  if (failures.length) return failures;
  return output.issues.map(issue => `spoken_quality_${issue.kind}:${JSON.stringify(issue)}`);
}

export function spokenOutlineMetrics(markdown) {
  const lines = String(markdown || '').split(/\r?\n/u);
  return {
    headings: lines.filter(line => /^#{2,3}\s+\S/u.test(line)).length,
    top_level_items: lines.filter(line => /^-\s+\S/u.test(line)).length,
    nested_items: lines.filter(line => /^(?: {2})+-\s+\S/u.test(line)).length
  };
}

export function validateSpokenStructure(blocks, sections) {
  if (!Array.isArray(sections)) return ['spoken_structure_sections_missing'];
  const prose = blocks.filter(block => !['code', 'math', 'table'].includes(block.type));
  if (!prose.length) return [];
  const source = prose.map(block => block.markdown).join('\n');
  const metrics = spokenOutlineMetrics(sections.map(section => section.markdown).join('\n\n'));
  const failures = [];
  if (!metrics.top_level_items) failures.push('spoken_structure_outline_required');
  if (source.replace(/\s/gu, '').length > 800 && /因为|例如|比如|首先|其次|一方面|另一方面|如果/u.test(source)
      && !metrics.nested_items) failures.push('spoken_structure_supports_must_be_nested');
  return failures;
}

export function buildSpokenReviewPrompt(contract, blocks, sections, context = {}) {
  return {
    thinking: 'enabled',
    system: contract,
    user: JSON.stringify({ original_blocks: blocks, candidate_sections: sections, readonly_boundary_context: context }, null, 2)
  };
}
