import type {DeckSpec,SlideSpec} from './contracts';
import {slideContent} from './slots';

/** Design without disclosure: a design AI receives only the shape of each slide
 * (which places exist, their role and length, how many chart categories), never the
 * wording or numbers. Everything here is deterministic and runs on this PC. */
export type ShareLevel='structure'|'topic';
export interface DesignSlot {id:string; role:'title'|'heading'|'number'|'body'|'caption'; chars:number; sample:string}
export interface DesignRequestSlide {id:string; cover:boolean; slots:DesignSlot[]; charts:{id:string;type:string;categories:number;series:number}[]; tables:{id:string;columns:number;rows:number;longestCell:number}[]}
export interface DesignPacket {task:'design'; level:ShareLevel; topic?:string; colors:string[]; slides:DesignRequestSlide[]}
/** Real content per slide, kept on this PC and filled into the returned design. */
export interface SlotContent {texts:Record<string,{text:string;role:DesignSlot['role'];refs?:number[]}>; charts:Record<string,NonNullable<SlideSpec['chart']>>; tables:Record<string,NonNullable<SlideSpec['table']>>}

/** Same width, no wording: kana/kanji → 〇, digits → 0, letters → x. Only spaces and
 * the plain punctuation 、。,.・ are kept, so not even units or signs (円・%・△) leave. */
export function dummyText(text:string){
  return Array.from(text).map(ch=>/\s/u.test(ch)?ch:/[、。，．,.・]/u.test(ch)?ch:/[0-9０-９]/u.test(ch)?'0':/[A-Za-zＡ-Ｚａ-ｚ]/u.test(ch)?'x':'〇').join('');
}

export function designRequest(deck:DeckSpec,slideIds:string[],level:ShareLevel,topic?:string):{packet:DesignPacket;contents:Record<string,SlotContent>}{
  const contents:Record<string,SlotContent>={},slides:DesignRequestSlide[]=[];
  for(const slide of deck.slides.filter(s=>slideIds.includes(s.id))){
    const content=slideContent(slide),texts:SlotContent['texts']={},slots:DesignSlot[]=[];
    const add=(id:string,role:DesignSlot['role'],text:string,refs?:number[])=>{texts[id]={text,role,...(refs?.length?{refs}:{})};slots.push({id,role,chars:Array.from(text).length,sample:dummyText(text)});};
    add('t','title',content.title);
    content.texts.forEach((t,i)=>add(`s${i+1}`,t.role,t.text,t.refs));
    const charts:SlotContent['charts']={},tables:SlotContent['tables']={};
    content.charts.forEach((c,i)=>charts[`c${i+1}`]=c);content.tables.forEach((t,i)=>tables[`b${i+1}`]=t);
    contents[slide.id]={texts,charts,tables};
    slides.push({id:slide.id,cover:slide.layoutId==='cover',slots,
      charts:content.charts.map((c,i)=>({id:`c${i+1}`,type:c.type,categories:c.categories.length,series:c.series.length})),
      tables:content.tables.map((t,i)=>({id:`b${i+1}`,columns:t.headers.length,rows:t.rows.length,longestCell:Math.max(...[t.headers,...t.rows].flat().map(c=>Array.from(c).length))}))});
  }
  // Colour names only: a company's own colour values could identify it.
  const packet:DesignPacket={task:'design',level,...(level==='topic'&&topic?{topic}:{}),colors:['bg','ink','muted','accent','accent2','surface','rule','negative','onAccent','white'],slides};
  return {packet,contents};
}

const meaningful=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]{2,}|[A-Za-z]{4,}|\d{3,}/gu;
/** Values the app itself writes into a design packet (roles, chart types, colour
 * names, ids). They carry no content and are not compared. */
const appValues=/^(?:design|structure|topic|title|heading|number|body|caption|bg|ink|muted|accent|accent2|surface|rule|negative|onAccent|white|bar|column|line|pie|doughnut|stackedBar|stackedColumn|waterfall|slide-\d+|t|s\d+|c\d+|b\d+)$/;
/** Every string the packet would send is searched for wording or numbers of the
 * protected texts (documents, prompt, conversation, slide content). Returns each
 * match; the packet may only be sent when there are none. `allowed` is text the user
 * explicitly approved to send (the topic). */
export function leakCheck(packet:unknown,protectedTexts:string[],allowed:string[]=[]){
  const corpus=protectedTexts.join('\n').normalize('NFKC'),digits=corpus.replace(/(?<=\d)[,，](?=\d)/g,''),values:string[]=[];
  const walk=(v:unknown)=>{if(typeof v==='string'){if(!allowed.includes(v)&&!appValues.test(v))values.push(v);}else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')Object.values(v).forEach(walk);};
  walk(packet);
  const hits=new Set<string>();
  for(const value of values)for(const token of value.normalize('NFKC').replace(/(?<=\d)[,，](?=\d)/g,'').match(meaningful)??[]){
    // Any two-character piece of a longer run counts, so a sentence cannot slip through split differently.
    const chars=Array.from(token),pieces=/\d/.test(token)||/^[A-Za-z]/.test(token)?[token]:chars.slice(0,-1).map((_,i)=>chars[i]+chars[i+1]);
    for(const piece of pieces)if(!/^[〇0x]+$/u.test(piece)&&(corpus.includes(piece)||(/^\d+$/.test(piece)&&digits.includes(piece))))hits.add(piece);
  }
  return {checkedCharacters:corpus.length,sentStrings:values.length,hits:[...hits]};
}

/** SHA-256 (hex) of the exact text prepared for sending, for the local send record. */
export function sha256(text:string){
  const bytes=new TextEncoder().encode(text),K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const length=bytes.length,padded=new Uint8Array(((length+9+63)>>6)<<6);padded.set(bytes);padded[length]=0x80;
  const view=new DataView(padded.buffer);view.setUint32(padded.length-4,(length*8)>>>0);view.setUint32(padded.length-8,Math.floor(length/0x20000000));
  const w=new Uint32Array(64),rotr=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  for(let offset=0;offset<padded.length;offset+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);
    for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3),s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
    let [a,b,c,d,e,f,g,h]=H;
    for(let i=0;i<64;i++){const t1=(h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    H[0]+=a;H[1]+=b;H[2]+=c;H[3]+=d;H[4]+=e;H[5]+=f;H[6]+=g;H[7]+=h;
  }
  return Array.from(H).map(v=>v.toString(16).padStart(8,'0')).join('');
}

/** For app-written notes (corrections): does any of them reuse a phrase of `window`
 * consecutive characters (or a 3+ digit number) from the protected texts? Common
 * grammar shared with ordinary Japanese is not flagged; copied wording is. */
export function phraseLeak(texts:string[],protectedTexts:string[],window=6){
  const sent=texts.join('\n').normalize('NFKC'),sentDigits=sent.replace(/(?<=\d)[,，](?=\d)/g,'');
  for(const source of protectedTexts){
    const text=source.normalize('NFKC'),chars=Array.from(text);
    for(let i=0;i+window<=chars.length;i++){const piece=chars.slice(i,i+window).join('');if(/^[\p{L}\p{N}ー々]+$/u.test(piece)&&sent.includes(piece))return true;}
    for(const number of text.replace(/(?<=\d)[,，](?=\d)/g,'').match(/\d{3,}/g)??[])if(sentDigits.includes(number))return true;
  }
  return false;
}

/** Masking for content generation by a cloud AI (send scope "masked"): company names,
 * project terms, contacts and numbers become tokens such as 【社名1】【語2】【数値3】.
 * The same original always gets the same token; replies are restored on this PC. */
type MaskKind='語'|'社名'|'連絡先'|'数値';
const companyPattern=/(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人)\s*[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー・&＆]{1,20}|[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー・&＆]{1,20}?\s*(?:株式会社|ホールディングス|（株）|\(株\))|\b[A-Z][\w&]*(?:\s+[A-Z][\w&]*){0,3}\s*(?:Inc\.?|Corp\.?|Corporation|Co\.,?\s*Ltd\.?|Ltd\.?|LLC)/gu;
const contactPattern=/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/[^\s"'<>）)」]+|0\d{1,4}-\d{1,4}-\d{3,4}/g;
const numberPattern=/[+＋\-−△▲]?\d[\d,，]*(?:\.\d+)?(?:(?:兆|億|万|千)\d[\d,，]*(?:\.\d+)?)*(?:百万|兆|億|万|千)?(?:円|ドル|%|％|倍|ポイント|pt)?/gu;
const tokenPattern=/【(語|社名|連絡先|数値)(\d+)】/g;
const outsideTokens=(text:string,replace:(segment:string)=>string)=>text.split(/(【(?:語|社名|連絡先|数値)\d+】)/).map((part,i)=>i%2?part:replace(part)).join('');

export class Masker {
  private byOriginal=new Map<string,string>();private byToken=new Map<string,string>();private counts:Record<MaskKind,number>={'語':0,'社名':0,'連絡先':0,'数値':0};
  private entities:string[]=[];
  constructor(private terms:string[]=[]){this.entities=terms.filter(t=>t.trim()).map(t=>t.trim());}
  /** Learns names before masking, so "トヨタ自動車" is masked even where "株式会社" is omitted. */
  learn(texts:string[]){
    const found=new Set(this.entities);
    for(const text of texts)for(const match of text.normalize('NFKC').match(companyPattern)??[]){
      const name=match.trim();found.add(name);
      const bare=name.replace(/^(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人)\s*|\s*(?:株式会社|ホールディングス|（株）|\(株\)|,?\s*(?:Inc\.?|Corp\.?|Corporation|Co\.,?\s*Ltd\.?|Ltd\.?|LLC))$/gu,'').trim();
      if(Array.from(bare).length>=2)found.add(bare);
    }
    this.entities=[...found].sort((a,b)=>b.length-a.length);
    return this;
  }
  private token(kind:MaskKind,original:string){
    const existing=this.byOriginal.get(original);if(existing)return existing;
    const token=`【${kind}${++this.counts[kind]}】`;this.byOriginal.set(original,token);this.byToken.set(token,original);return token;
  }
  mask(text:string){
    let out=text.normalize('NFKC');
    for(const entity of this.entities)out=outsideTokens(out,part=>part.includes(entity)?part.split(entity).join(this.token(this.terms.includes(entity)?'語':'社名',entity)):part);
    out=outsideTokens(out,part=>part.replace(contactPattern,m=>this.token('連絡先',m)));
    out=outsideTokens(out,part=>part.replace(numberPattern,m=>/\d/.test(m)?this.token('数値',m):m));
    return out;
  }
  /** Masks every string of a request; ids, locators and app vocabulary stay as they are. */
  maskDeep<T>(value:T):T{
    const skip=new Set(['documentId','locator','id','sourceIds','layoutId','themeId','typographyId','mode','kind','task','role','t','shape','type','icon','slideId','path','requestId','variationSeed']);
    const walk=(v:unknown,key?:string):unknown=>typeof v==='string'?(key&&skip.has(key)?v:this.mask(v)):Array.isArray(v)?v.map(item=>walk(item,key==='sourceIds'?key:undefined)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,item])=>[k,walk(item,k)])):v;
    return walk(value) as T;
  }
  /** Restores tokens in a reply. Chart values given as tokens become numbers again. */
  unmaskDeep<T>(value:T):{value:T;unknown:string[]}{
    const unknown=new Set<string>();
    const restore=(text:string)=>text.replace(tokenPattern,token=>{const original=this.byToken.get(token);if(original===undefined){unknown.add(token);return token;}return original;});
    const walk=(v:unknown,key?:string):unknown=>{
      if(typeof v==='string'){const restored=restore(v);if(key==='values'){const n=Number(restored.replace(/[,，]/g,'').replace(/[%％]$/,''));return Number.isFinite(n)&&/\d/.test(restored)?n:restored;}return restored;}
      if(Array.isArray(v))return v.map(item=>walk(item,key));
      if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,item])=>[k,walk(item,k)]));
      return v;
    };
    return {value:walk(value) as T,unknown:[...unknown]};
  }
  /** Proof for the masked packet: originals that still appear in it (should be none). */
  residual(packetText:string){const text=packetText.normalize('NFKC');return [...this.byOriginal.keys()].filter(original=>Array.from(original).length>=2&&text.includes(original));}
  get size(){return this.byOriginal.size;}
  items(){return [...this.byToken].map(([token,original])=>({token,original}));}
}
