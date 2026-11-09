// A conservative, deterministic check. This never rewrites a model response.
// Only flag an inverted atomic fraction when its opposite is explicitly known
// from immutable formulas and the spoken orientation is not itself a source one.
const digits={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
const units={'十':10,'百':100,'千':1000,'万':10000,'亿':100000000};
const normalize=value=>{
  if(!/^[零一二两三四五六七八九十百千万亿]+$/u.test(value))return value.toLowerCase();
  if(!/[十百千万亿]/u.test(value))return value.split('').map(c=>digits[c]).join('');
  let total=0,section=0,number=0;
  for(const c of value){
    if(c in digits){number=digits[c];continue;}
    const unit=units[c];
    if(unit<10000){section+=(number||1)*unit;number=0;}
    else{section+=number;total=unit===10000?total+section*unit:(total+section)*unit;section=0;number=0;}
  }
  return String(total+section+number);
};
export function checkFormulaConsistency(markdown,sourceMath,{preservedSource=[]}={}){
  const pairs=new Set();
  const atomic=String.raw`(?:\{([a-zA-Z]|\d+)\}|([a-zA-Z]|\d))`;
  const fraction=new RegExp(String.raw`\\(?:dfrac|tfrac|frac)\s*`+atomic+String.raw`\s*`+atomic,'gu');
  for(const math of sourceMath){
    for(const m of math.matchAll(fraction))pairs.add(normalize(m[1]||m[2])+'/'+normalize(m[3]||m[4]));
  }
  // Independently attributed source conflicts may contain both orientations.
  // Accept only orientations literally present there, never waive new claims.
  for(const text of preservedSource){
    for(const m of text.matchAll(/([a-zA-Z]|\d+|[零一二两三四五六七八九十百千万亿]+)\s*分之\s*([a-zA-Z]|\d+|[零一二两三四五六七八九十百千万亿]+)/gu))
      pairs.add(normalize(m[2])+'/'+normalize(m[1]));
  }
  const issues=[];
  markdown.split('\n').forEach((line,index)=>{
    // Native formulas are already verified as literal source spans. Here we
    // check additional spoken-math explanations outside those spans.
    const prose=line.replace(/\$[^\n$]+\$/gu,'');
    for(const m of prose.matchAll(/([a-zA-Z]|\d+|[零一二两三四五六七八九十百千万亿]+)\s*分之\s*([a-zA-Z]|\d+|[零一二两三四五六七八九十百千万亿]+)/gu)){
      // “u加v分之w” has a compound denominator. Matching only its final
      // atom would compare w/v with an unrelated v/w elsewhere in the source.
      if(/(?:加|减|乘|除|[+−*/])\s*$/u.test(prose.slice(0,m.index)))continue;
      const denominator=normalize(m[1]),numerator=normalize(m[2]);
      if(numerator===denominator)continue;
      const actual=numerator+'/'+denominator,inverse=denominator+'/'+numerator;
      if(!pairs.has(actual)&&pairs.has(inverse))issues.push({line:index+1,kind:'spoken_fraction_inverted_against_source',
        literal:m[0],parsed_fraction:actual,source_fraction:inverse,exact_line:line});
    }
  });
  return {version:'source-fraction-consistency/v1',status:issues.length?'needs_review':'passed',issues,body_modified:false,model_calls:0};
}
