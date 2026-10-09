/** Exact decimal form of a number token, without rounding or unit conversion:
 * "1,200" -> "1200", "12.50%" -> "12.5", "1.2e3" -> "1200", "△3" -> "-3". */
export function canonicalNumber(token:string){
  const normalized=token.normalize('NFKC').replace(/,/g,'').replace(/[−△▲]/g,'-').replace(/^\+/,'').replace(/[%％]$/,'');
  const match=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(normalized);
  if(!match)return normalized;
  const exponent=Number(match[4]??0);
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000)return normalized;
  const digits=match[2]+(match[3]??''),point=match[2].length+exponent;
  const expanded=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
  const [integer,fraction='']=expanded.split('.'),whole=integer.replace(/^0+(?=\d)/,''),tail=fraction.replace(/0+$/,'');
  const value=whole+(tail?'.'+tail:'');return (match[1]&&value!=='0'?'-':'')+value;
}
const numberPattern=/[+−△▲-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+−-]?\d+)?[%％]?/g;
/** Number tokens as written, e.g. ["1,200", "12.5%"]. */
export function numberTokens(text:string){return Array.from(text.normalize('NFKC').match(numberPattern)??[]);}
export function numbersIn(text:string){return numberTokens(text).map(canonicalNumber);}
/** Single digits ("3つの観点") are counts rather than data and are not checked. */
export function isCheckedNumber(token:string){return !/^[+−△▲-]?\d$/.test(token.normalize('NFKC'));}
