import {protectTranslationMarkdown} from './producer.mjs';

// Text-mode underscores are literal characters, not mathematical subscripts.
// Keep math inside text (and already escaped characters) untouched.
function normalizeTexText(tex) {
  let escaped = 0;
  const modes = ['math'];
  let output = '';
  for (let i = 0; i < tex.length;) {
    const command = /^\\([A-Za-z]+)(\s*)\{/u.exec(tex.slice(i));
    if (command && /^(?:text|textrm|textsf|texttt|textnormal|textbf|textit|emph|ensuremath)$/u.test(command[1])) {
      output += command[0];
      modes.push(command[1] === 'ensuremath' ? 'math' : 'text');
      i += command[0].length;
      continue;
    }
    const pair = tex.slice(i, i + 2);
    if (pair === '\\(' || pair === '\\[') {
      modes.push('math'); output += pair; i += 2; continue;
    }
    if (pair === '\\)' || pair === '\\]') {
      if (modes.length > 1) modes.pop();
      output += pair; i += 2; continue;
    }
    if (tex[i] === '\\') {
      const control = /^\\(?:[A-Za-z]+|[\s\S])/u.exec(tex.slice(i))?.[0] || '\\';
      output += control; i += control.length; continue;
    }
    const char = tex[i++];
    if (char === '{') modes.push(modes.at(-1));
    else if (char === '}' && modes.length > 1) modes.pop();
    else if (char === '$') {
      if (modes.at(-1) === 'dollar_math') modes.pop();
      else if (modes.at(-1) === 'text') modes.push('dollar_math');
    }
    if (char === '_' && modes.at(-1) === 'text') { output += '\\_'; escaped++; }
    else output += char;
  }
  return { tex: output, escaped };
}

function protectDollarMath(input) {
  const values = [];
  let prefix = 'READERMATHSLOT';
  while (input.includes(prefix)) prefix += 'X';
  let text = '', start = 0;
  const openings = /(?<!\\)\$(\$)?/gu;
  for (let match; (match = openings.exec(input));) {
    const delimiter = match[0];
    let depth = 0, close = -1;
    for (let i = openings.lastIndex; i < input.length; i++) {
      if (input[i] === '\\') { i++; continue; }
      if (delimiter === '$' && input[i] === '\n') break;
      if (input[i] === '{') depth++;
      if (input[i] === '}') depth = Math.max(0, depth - 1);
      if (depth === 0 && input.startsWith(delimiter, i)) { close = i; break; }
    }
    if (close < 0) continue;
    const token = `${prefix}${values.length}END`;
    values.push({token, value: input.slice(match.index, close + delimiter.length)});
    text += input.slice(start, match.index) + token;
    start = close + delimiter.length;
    openings.lastIndex = start;
  }
  return {protectedMarkdown: text + input.slice(start), values};
}

// Normalize the reading artifact only; source and fidelity audit text stays literal.
export function normalizeReaderMath(markdown) {
  let inline=0,display=0,currency=0,textUnderscores=0,fence=null,frontmatter=false;
  const normalize = content => {
    const result = normalizeTexText(content);
    textUnderscores += result.escaped;
    return result.tex;
  };
  const lines=String(markdown).split('\n'),output=[];let plain=[];
  const flush=()=>{
    if(!plain.length)return;
    const literal=protectTranslationMarkdown(plain.join('\n'),{includeMath:false});
    let input=literal.protectedMarkdown.replace(/(?<!\\)\$\d[\d,.]*(?=\s|[;:!?)]|$)/gu,(amount,offset,source)=>{
      const lineEnd=source.indexOf('\n',offset), end=lineEnd<0?source.length:lineEnd;
      const next=/(?<!\\)\$/u.exec(source.slice(offset+amount.length,end));
      const close=next?offset+amount.length+next.index:-1;
      if(close>=0&&!/\s/u.test(source[close-1])&&!/[\d$]/u.test(source[close+1]||''))return amount;
      currency++;return '\\'+amount;
    });
    const protectedValue=protectDollarMath(input);
    let text=protectedValue.protectedMarkdown
      .replace(/(?<!\\)\\\(([^\n]*?)\\\)/gu,(whole,content)=>{
        if(!content.trim()||/(?<!\\)\$/u.test(content))return whole;
        inline++;return '$'+normalize(content)+'$';
      })
      .replace(/(?<!\\)\\\[([\s\S]*?)\\\]/gu,(whole,content)=>{
        if(!content.trim()||/(?<!\\)\$/u.test(content))return whole;
        // Turndown also escapes ordinary square brackets. Keep bracketed prose
        // literal unless it contains explicit TeX or mathematical operators.
        const explicitMath=/\\[A-Za-z]+|[=^_{}]/u.test(content);
        if(!explicitMath&&(/\p{Script=Han}/u.test(content)||/\b[A-Za-z]{3,}\b/u.test(content)))return whole;
        display++;return '$$'+normalize(content)+'$$';
      });
    for(const item of [...protectedValue.values].reverse()) {
      const value = /^\$\$[\s\S]*\$\$$/u.test(item.value)
        ? '$$'+normalize(item.value.slice(2,-2))+'$$'
        : /^\$(?!\$)[\s\S]*\$$/u.test(item.value)
          ? '$'+normalize(item.value.slice(1,-1))+'$' : item.value;
      text=text.replaceAll(item.token,()=>value);
    }
    for(const item of [...literal.values].reverse())text=text.replaceAll(item.token,()=>item.value);
    output.push(text);plain=[];
  };
  for(let index=0;index<lines.length;index++) {
    const line=lines[index];
    if(index===0&&line==='---')frontmatter=true;
    if(frontmatter){output.push(line);if(index>0&&/^---\s*$/u.test(line))frontmatter=false;continue;}
    if(fence){output.push(line);if(new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`,'u').test(line))fence=null;continue;}
    const opening=/^\s*(?:[-*+]\s+)?(`{3,}|~{3,})/u.exec(line);
    if(opening){flush();fence=opening[1];output.push(line);}else plain.push(line);
  }
  flush();
  return {markdown:output.join('\n'),report:{policy:'reader-math-compatibility/v2',inline_converted:inline,display_converted:display,literal_currency_escaped:currency,text_underscores_escaped:textUnderscores,formula_content_unchanged:textUnderscores===0}};
}
