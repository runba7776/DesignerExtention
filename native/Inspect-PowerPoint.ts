import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseDocument} from '../server/documents.js';
for(const name of process.argv.slice(2)){
  const doc=await parseDocument(path.basename(name),await readFile(name));
  console.log(JSON.stringify({name:doc.name,kind:doc.kind,units:doc.units,characters:doc.characters,chartSeries:doc.sources.filter(s=>s.locator.includes('グラフ')).length,smartArt:doc.sources.filter(s=>s.locator.includes('SmartArt')).length,notes:doc.sources.filter(s=>s.locator.includes('発表者ノート')).length,warnings:doc.warnings.length}));
}
