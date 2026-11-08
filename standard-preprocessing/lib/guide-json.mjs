// Guide-only JSON transport repair. It never edits strings or fills fields.
// Accept a complete root object followed only by surplus closing delimiters.
export function parseGuideJsonObject(text, parseObject = JSON.parse) {
  try { return {output:parseObject(text),recovery:null}; }
  catch (error) {
    const source=String(text).trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,'');
    if(!source.startsWith('{'))throw error;
    const stack=[];let quoted=false,escaped=false;
    for(let n=0;n<source.length;n++){
      const c=source[n];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"'){quoted=true;continue;}
      if(c==='{'||c==='[')stack.push(c);
      else if(c==='}'||c===']'){
        if(stack.pop()!==(c==='}'?'{':'['))throw error;
        if(!stack.length){
          const suffix=source.slice(n+1).trim();
          if(!/^[}\]\s]+$/u.test(suffix))throw error;
          let output;try{output=JSON.parse(source.slice(0,n+1));}catch{throw error;}
          return {output,recovery:{kind:'surplus_closing_delimiters',removed_suffix:suffix,values_changed:false}};
        }
      }
    }
    throw error;
  }
}
