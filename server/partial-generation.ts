/** Read complete JSON values from a truncated deck, without repairing any value.
 * Only ordered, fully closed slide objects are candidates; callers must validate
 * IDs, schema, cover roles and sources before retaining them. Raw text is private.
 */
export function completeSlidePrefix(raw:string):{mode:unknown;themeId?:unknown;slides:unknown[]} {
  const text=raw.trim().replace(/^```(?:json)?\s*/i,'');
  let at=0;
  const space=()=>{while(/\s/.test(text[at]??'')&&at<text.length)at++;};
  const read=():{value:unknown}|undefined=>{
    space();const start=at,first=text[at];if(!first)return;
    if(first==='"'){
      at++;let escaped=false;
      while(at<text.length){const c=text[at++];if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){try{return {value:JSON.parse(text.slice(start,at))};}catch{return;}}}
      return;
    }
    if(first==='{'||first==='['){
      const stack:string[]=[];let quoted=false,escaped=false;
      while(at<text.length){const c=text[at++];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
        if(c==='"')quoted=true;else if(c==='{'||c==='[')stack.push(c);else if(c==='}'||c===']'){
          if(stack.pop()!==(c==='}'?'{':'['))return;
          if(!stack.length){try{return {value:JSON.parse(text.slice(start,at))};}catch{return;}}
        }
      }return;
    }
    while(at<text.length&&!/[\s,}\]]/.test(text[at]))at++;
    // Scalars cut at EOF are not known to be complete (e.g. a cut number).
    if(at===text.length)return;
    try{return {value:JSON.parse(text.slice(start,at))};}catch{return;}
  };
  const result:{mode:unknown;themeId?:unknown;slides:unknown[]}={mode:undefined,slides:[]};
  const keys=new Set<string>();space();if(text[at++]!=='{')return result;
  while(at<text.length){
    const key=read();if(typeof key?.value!=='string'||keys.has(key.value))return {mode:undefined,slides:[]};
    keys.add(key.value);space();if(text[at++]!==':')return {mode:undefined,slides:[]};space();
    if(key.value==='slides'){
      if(text[at++]!=='[')return {mode:undefined,slides:[]};space();
      if(text[at]!==']')while(at<text.length){
        if(text[at]!=='{')return result;
        const entry=read();if(!entry)return result;
        space();
        // A closed object also requires a JSON array separator, never junk.
        if(at<text.length&&text[at]!==','&&text[at]!==']')return result;
        result.slides.push(entry.value);
        if(text[at]!==',')break;at++;space();
      }
      if(text[at]!==']')return result;at++;
    }else{
      const entry=read();if(!entry)return result;
      if(key.value==='mode')result.mode=entry.value;
      if(key.value==='themeId')result.themeId=entry.value;
    }
    space();if(text[at]!==',')return result;at++;space();
  }
  return result;
}
