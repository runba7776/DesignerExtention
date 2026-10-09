import type {ChartElement} from '../shared/contracts';
import {chartNumber,isShareChart,isStackedChart} from '../shared/charts';
import {readableColor} from '../shared/color';
import {measureText,wrapText,textUnits} from '../shared/layouts';

function Label({text,x,y,w,h=28,size=14,color,align='left'}:{text:string;x:number;y:number;w:number;h?:number;size?:number;color:string;align?:'left'|'center'|'right'}){
  const fitted=measureText(text,{x,y,w,h},size),lines=wrapText(text,w-8,fitted.fontSize);
  const anchor=align==='left'?'start':align==='right'?'end':'middle',left=x+(align==='left'?0:align==='right'?w:w/2);
  return <text x={left} y={y+fitted.fontSize} fontSize={fitted.fontSize} fill={color} textAnchor={anchor}>{lines.map((line,i)=><tspan key={i} x={left} dy={i?fitted.fontSize*1.35:0}>{line}</tspan>)}</text>;
}
/** The preliminary SVG follows the same data/type rules as editable Office charts. */
export function ChartPreview({element:e,textColor}:{element:ChartElement;textColor:string}){
  const color=(i:number)=>e.colors[i%e.colors.length],font=e.labelSize??14,stacked=isStackedChart(e.chartType),share=isShareChart(e.chartType);
  const legend=<g>{e.series.length>1&&e.series.map((s,j)=>{const w=e.w/e.series.length,x=e.x+j*w;return <g key={j}><rect x={x} y={e.y+e.h-17} width={10} height={10} fill={color(j)}/><Label text={s.name} x={x+16} y={e.y+e.h-23} w={w-22} h={26} size={font-1} color={textColor}/></g>;})}</g>;
  if(share){
    const values=e.series[0].values,total=values.reduce((a,b)=>a+b,0),r=Math.min(e.h*.42,e.w*.27),cx=e.x+e.w*.3,cy=e.y+e.h*.45,inner=e.chartType==='doughnut'?r*.42:0;
    let angle=-Math.PI/2;
    return <g>{values.map((value,i)=>{const start=angle;angle+=value/total*Math.PI*2;const end=angle-.000001,mid=(start+angle)/2,point=(radius:number,a:number)=>`${cx+radius*Math.cos(a)},${cy+radius*Math.sin(a)}`;
      const path=inner?`M${point(r,start)} A${r},${r} 0 ${end-start>Math.PI?1:0} 1 ${point(r,end)} L${point(inner,end)} A${inner},${inner} 0 ${end-start>Math.PI?1:0} 0 ${point(inner,start)} Z`:`M${cx},${cy} L${point(r,start)} A${r},${r} 0 ${end-start>Math.PI?1:0} 1 ${point(r,end)} Z`;
      const row=e.h*.86/values.length,y=e.y+i*row,legendX=e.x+e.w*.62;
      return <g key={i}>{value>0&&<path d={path} fill={color(i)} stroke={e.background??'white'} strokeWidth={2}/>}<rect x={legendX} y={y+6} width={10} height={10} fill={color(i)}/><Label text={`${e.categories[i]}  ${chartNumber(value)}${e.unit??''}`} x={legendX+17} y={y} w={e.w*.38-19} h={row-4} size={font-1} color={textColor}/>{e.showValues&&value/total>=.055&&<text x={cx+Math.cos(mid)*(r+inner)/2} y={cy+Math.sin(mid)*(r+inner)/2+5} textAnchor="middle" fontSize={font} fontWeight={700} fill={readableColor('#FFFFFF',color(i))}>{(value/total*100).toFixed(1)}%</text>}</g>;
    })}</g>;
  }
  const all=stacked?e.categories.map((_,i)=>e.series.reduce((sum,s)=>sum+s.values[i],0)):e.series.flatMap(s=>s.values),maximum=Math.max(...all,1),minimum=Math.min(...all,0),high=maximum*1.2,low=minimum<0?minimum*1.2:0;
  const horizontal=e.chartType==='bar'||e.chartType==='stackedBar';
  const left=horizontal?Math.min(e.w*.32,Math.max(90,...e.categories.map(c=>textUnits(c)*(font-1)+14))):Math.min(e.w*.23,Math.max(52,textUnits(chartNumber(maximum))*9));
  const plot={x:e.x+left,y:e.y+12,w:e.w-left-48,h:e.h-(horizontal?38:70)};
  const valueX=(v:number)=>plot.x+(v-low)/(high-low)*plot.w,valueY=(v:number)=>plot.y+plot.h-(v-low)/(high-low)*plot.h,slot=(horizontal?plot.h:plot.w)/e.categories.length;
  return <g>{[0,.5,1].map(t=>{const v=low+(high-low)*t;return <g key={t}>{horizontal?<line x1={valueX(v)} x2={valueX(v)} y1={plot.y} y2={plot.y+plot.h} stroke={e.gridColor??'#E3E8EE'}/>:<line x1={plot.x} x2={plot.x+plot.w} y1={valueY(v)} y2={valueY(v)} stroke={e.gridColor??'#E3E8EE'}/>}</g>;})}
    {e.categories.map((category,i)=><Label key={i} text={category} x={horizontal?e.x:plot.x+slot*i} y={horizontal?plot.y+i*slot+slot*.24:plot.y+plot.h+7} w={horizontal?left-12:slot} h={horizontal?slot*.7:32} size={font-1} color={textColor} align={horizontal?'right':'center'}/>)}
    {e.series.map((series,j)=>e.chartType==='line'?<g key={j}><polyline points={series.values.map((v,i)=>`${plot.x+slot*(i+.5)},${valueY(v)}`).join(' ')} stroke={color(j)} strokeWidth={3} fill="none"/>{series.values.map((v,i)=><g key={i}><circle cx={plot.x+slot*(i+.5)} cy={valueY(v)} r={4} fill={color(j)}/>{e.showValues&&<Label text={chartNumber(v)} x={plot.x+slot*i} y={valueY(v)-(j%2?0:26)} w={slot} size={font-2} color={textColor} align="center"/>}</g>)}</g>:<g key={j}>{series.values.map((v,i)=>{
      const base=stacked?e.series.slice(0,j).reduce((sum,s)=>sum+s.values[i],0):0,end=base+v,thickness=slot*.68/(stacked?1:e.series.length),offset=slot*.16+(stacked?0:j*thickness),x=horizontal?Math.min(valueX(base),valueX(end)):plot.x+slot*i+offset,y=horizontal?plot.y+slot*i+offset:Math.min(valueY(base),valueY(end)),w=horizontal?Math.abs(valueX(end)-valueX(base)):thickness-3,h=horizontal?thickness-3:Math.abs(valueY(end)-valueY(base));
      const labelX=stacked?x+(horizontal?w/2:0):horizontal?valueX(v)+5:x,labelY=stacked?y+h/2-8:horizontal?y+h/2-9:v<0?valueY(v):valueY(v)-24;
      const labelW=horizontal?(stacked?Math.max(1,w/2):48):w;
      return <g key={i}><rect x={x} y={y} width={Math.max(.3,w)} height={Math.max(.3,h)} fill={color(j)}/>{e.showValues&&(!stacked||(horizontal?w:h)>28)&&<Label text={chartNumber(v)} x={labelX} y={labelY} w={labelW} size={font-2} color={stacked?readableColor('#FFFFFF',color(j)):textColor} align={horizontal?'left':'center'}/>}</g>;
    })}</g>)}
    {!horizontal&&<><Label text={chartNumber(maximum)} x={e.x} y={valueY(maximum)-10} w={left-8} size={font-2} color={textColor} align="right"/><Label text={chartNumber(minimum)} x={e.x} y={valueY(minimum)-10} w={left-8} size={font-2} color={textColor} align="right"/></>}
    {e.unit&&<Label text={e.unit} x={e.x} y={e.y-6} w={left-8} color={textColor} size={font-2}/>} {legend}
  </g>;
}
