// Local recovery for existing guides whose old block has been subdivided.
// Never invent or rewrite insights; score evidence within the old target only.
function terms(text) {
  const tokens = String(text).toLowerCase().match(/[a-z][a-z0-9_.-]*|\p{Script=Han}+/gu) || [];
  return tokens.flatMap(token => /\p{Script=Han}/u.test(token)
    ? (token.length === 1 ? [] : Array.from({length: token.length - 1}, (_, i) => token.slice(i, i + 2)))
    : [token]);
}

export function rankInsightTargets(insight, bodyBlocks) {
  const candidates = bodyBlocks.filter(block => block.type !== 'heading');
  const documents = candidates.map(block => terms(block.markdown));
  const frequencies = new Map();
  for (const document of documents) for (const token of new Set(document)) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  const query = new Map();
  for (const [text, weight] of [[insight.title, 2], [insight.description, 1]]) {
    for (const token of new Set(terms(text))) query.set(token, (query.get(token) || 0) + weight);
  }
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1);
  return candidates.map((block, index) => {
    const counts = new Map();
    for (const token of documents[index]) counts.set(token, (counts.get(token) || 0) + 1);
    let score = 0;
    const evidence = [];
    for (const [token, weight] of query) {
      const count = counts.get(token) || 0;
      if (!count) continue;
      const df = frequencies.get(token);
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += weight * idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * documents[index].length / average));
      evidence.push(token);
    }
    return {source_block_key: block.source_block_key, block_id: block.block_id,
      section: block.markdown.split('\n')[0], score, evidence};
  }).sort((a, b) => b.score - a.score || a.source_block_key.localeCompare(b.source_block_key));
}

export function retargetSubdividedInsights(insights, previousBlocks, bodyBlocks) {
  const unchanged = new Set(bodyBlocks.flatMap(block => block.source_block_keys || [block.source_block_key]));
  const audit = [];
  const repaired = insights.map((insight, index) => {
    if (unchanged.has(insight.target_block_key)) return structuredClone(insight);
    const old = previousBlocks.find(block => (block.source_block_keys || [block.source_block_key]).includes(insight.target_block_key));
    if (!old) throw new Error(`old_insight_target_missing:${index}`);
    const children = bodyBlocks.filter(block => old.markdown.includes(block.markdown));
    const ranking = rankInsightTargets(insight, children);
    if (!ranking[0]?.score || ranking[0].evidence.length < 3) throw new Error(`insufficient_target_evidence:${index}`);
    if (ranking[1] && ranking[0].score < ranking[1].score * 1.1) throw new Error(`ambiguous_target_evidence:${index}`);
    audit.push({index, title: insight.title, previous_target: insight.target_block_key, candidates: ranking.slice(0, 3)});
    return {...insight, target_block_key: ranking[0].source_block_key};
  });
  return {insights: repaired, audit};
}
