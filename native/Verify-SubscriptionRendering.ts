/** Isolated subscription-flow export check: existing mock QA history only, no model/API. */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';
import {HistoryStore} from '../server/history.js';
import {createRenderBridge} from '../server/render-bridge.js';

const root=fileURLToPath(new URL('..',import.meta.url)),verificationDirectory=path.join(root,'runtime','qa-v090'),sourceDirectory=path.join(verificationDirectory,'web');
const history=new HistoryStore(sourceDirectory),entries=(await history.list()).entries;
assert.ok(entries.length,'Create a completed mock presentation in the isolated QA app first.');
let source;
for(const entry of entries){const candidate=await history.load(entry.id);if(candidate.session.provider==='chat'&&candidate.documents.length===0&&candidate.session.variants[0].deck.slides.length===3&&candidate.session.variants[0].deck.title.includes('模擬データ')){source=candidate;break;}}
assert.ok(source,'Only a three-slide mock subscription presentation can be used by this check.');
const deck=structuredClone(source.session.variants[0].deck),expected=[24,42,58];
assert.equal(deck.slides.length,3);assert.equal(source.session.usage.calls,0);assert.deepEqual(deck.slides[1].chart?.series[0].values,expected);

// The existing renderer creates a new deck, closes only that owned deck and
// its embedded workbook, and never quits PowerPoint or closes user decks.
const bridge=createRenderBridge(root);assert.ok(await bridge.nativeAvailable(),'Build the native renderer first.');
const rendered=await bridge.render(deck,'subscription-qa-v090');assert.equal(rendered.native,true);assert.equal(rendered.thumbnails.length,3);
const directory=path.join(bridge.artifactRoot,rendered.artifactId),pptx=path.join(directory,'presentation.pptx'),zip=await JSZip.loadAsync(await fs.readFile(pptx));
const slides=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name));assert.equal(slides.length,3);
const second=await zip.file('ppt/slides/slide2.xml')!.async('string');assert.match(second,/<c:chart\b/,'The chart must remain a native editable chart.');
const charts=Object.keys(zip.files).filter(name=>/^ppt\/charts\/chart\d+\.xml$/.test(name));assert.equal(charts.length,1);
const chart=await zip.file(charts[0])!.async('string'),cache=chart.match(/<c:val\b[^>]*>([\s\S]*?)<\/c:val>/)?.[1];assert.ok(cache);
const chartValues=Array.from(cache.matchAll(/<c:v>([^<]+)<\/c:v>/g),match=>Number(match[1]));assert.deepEqual(chartValues,expected);
const books=Object.keys(zip.files).filter(name=>/^ppt\/embeddings\/[^/]+\.xlsx$/.test(name));assert.equal(books.length,1,'A native chart must include its editable workbook.');
const workbook=await JSZip.loadAsync(await zip.file(books[0])!.async('nodebuffer')),sheet=await workbook.file('xl/worksheets/sheet1.xml')!.async('string');
const workbookValues=Array.from(sheet.matchAll(/<c\b[^>]*\br="B[234]"[^>]*>([\s\S]*?)<\/c>/g),match=>Number(match[1].match(/<v>([^<]+)<\/v>/)![1]));assert.deepEqual(workbookValues,expected);
const editableTextCounts=[];
for(let index=1;index<=3;index++){
  const xml=await zip.file(`ppt/slides/slide${index}.xml`)!.async('string'),textCount=Array.from(xml.matchAll(/<a:t>/g)).length;assert.ok(textCount>0,'Slide text must remain editable.');editableTextCounts.push(textCount);
  const png=await fs.readFile(path.join(directory,`slide-${index}.png`));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),1600);assert.equal(png.readUInt32BE(20),900);
}
const verification={version:'0.9.0',checkedAt:new Date().toISOString(),sourceHistoryId:source.id,sourceRevision:source.revision,sourceProvider:source.session.provider,realApiCalls:0,slides:3,native:true,editableChart:true,chartValues,embeddedWorkbookValues:workbookValues,editableTextCounts,pptx,thumbnails:[1,2,3].map(index=>path.join(directory,`slide-${index}.png`)),warnings:rendered.warnings,existingUserPresentationsClosed:false};
await fs.mkdir(verificationDirectory,{recursive:true});await fs.writeFile(path.join(verificationDirectory,'native-verification.json'),JSON.stringify(verification,null,2));
console.log(JSON.stringify(verification));
