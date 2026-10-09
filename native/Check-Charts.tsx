/** Optional integration check; uses installed PowerPoint, no AI or external data. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {createRenderBridge} from '../server/render-bridge';
const root=fileURLToPath(new URL('..',import.meta.url));
const types=['column','bar','line','pie'] as const;
const slides=types.map((type,i)=>{
  const slide=sampleSlide('chart_full',1);
  return {...slide,id:`chart-${i+1}`,title:`グラフの表示値検証 ${type}`,chart:{
    type,categories:['検証A','=データ','検証C'],
    series:type==='pie'?[{name:'構成比',values:[24,36,48]}]:[
      {name:'実績',values:[-2.5,0,17.75]},{name:'比較',values:[12.5,27.6,34.75]}],unit:'件',
  }};
});
const bridge=createRenderBridge(root), result=await bridge.render(sampleDeck(slides),'chart-check');
console.log(JSON.stringify({directory:path.join(bridge.artifactRoot,result.artifactId),warnings:result.warnings}));
