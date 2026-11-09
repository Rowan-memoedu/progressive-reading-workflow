// Entity codes preserve comparisons in labels; reject markup before encoding.
export function normalizeMermaidSource(value){
  const code=String(value||'').trim();
  if(!/^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b/u.test(code)
      ||/```|https?:|\bclick\b|%%\{|<\/?[a-z][\w:-]*(?:\s+[^<>\n]*)?\/?>/iu.test(code))throw Error('invalid_or_unsafe_mermaid');
  const normalized=code.replace(/"(?:\\.|[^"\\])*"/gu,label=>label.replaceAll('<','#60;'));
  if(/</u.test(normalized.replace(/<(?:--|==|\.\.-)/gu,'')))throw Error('invalid_or_unsafe_mermaid');
  return normalized;
}
