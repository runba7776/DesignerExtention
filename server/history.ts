import {randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,lstat,rename,writeFile,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import type {HistoryEntry,HistoryVersion,RefreshSummary,Session,RenderResult,VariantOrigin} from '../shared/contracts.js';
import {MAX_PROMPT_CHARACTERS} from '../shared/contracts.js';
import {documentContext,DOCUMENT_LIMITS,type ParsedDocument} from './document-model.js';
import {AppError,requireText} from './errors.js';
import {validateOutline,validateDeck} from './validation.js';
import {emptyUsage} from './providers.js';
import {DEFAULT_PROJECT_ID} from './projects.js';

export interface HistoryRecord {schemaVersion:1;id:string;revision:number;createdAt:string;updatedAt:string;session:Session;documents:ParsedDocument[]}
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const MAX_HISTORY_BYTES=6*1024*1024,MAX_VERSIONS=20;
function preservedText(value:unknown,label:string,max:number){requireText(value,label,max);return value as string;}
function safeRender(value:any,count:number):RenderResult|undefined {
  if(!value||typeof value.artifactId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(value.artifactId))return;
  const base=`/api/artifacts/${value.artifactId}/`;
  if(value.pptxUrl!==base+'presentation.pptx'||!Array.isArray(value.thumbnails)||value.thumbnails.length<count||value.thumbnails.length>count+3||value.thumbnails.some((url:unknown)=>typeof url!=='string'||!url.startsWith(base)||!/^slide-\d+\.png$/.test(url.slice(base.length))))return;
  return {artifactId:value.artifactId,pptxUrl:value.pptxUrl,thumbnails:value.thumbnails,warnings:Array.isArray(value.warnings)?value.warnings.filter((w:unknown)=>typeof w==='string'):[],native:value.native===true};
}
const strings=(value:unknown,max:number,length:number)=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'&&v.length<=length).slice(0,max):[];
function safeOrigin(value:any):VariantOrigin|undefined{
  if(!value||!['ai','restyle','combined','refresh'].includes(value.kind))return;
  return {kind:value.kind,...(typeof value.ai==='string'&&value.ai.length<=40?{ai:value.ai}:{}),...(Array.isArray(value.parents)?{parents:strings(value.parents,6,100)}:{}),...(Array.isArray(value.notes)?{notes:strings(value.notes,40,400)}:{})};
}
function safeRefresh(value:any):RefreshSummary|undefined{
  if(!value||typeof value.from!=='string'||typeof value.at!=='string'||!Array.isArray(value.changes))return;
  const count=(n:unknown)=>Number.isSafeInteger(n)&&(n as number)>=0?n as number:0;
  const changes=value.changes.slice(0,3000).filter((c:any)=>c&&typeof c.slideId==='string'&&Number.isSafeInteger(c.page)&&typeof c.where==='string'&&typeof c.before==='string'&&typeof c.after==='string'&&(c.kind==='text'||c.kind==='value'))
    .map((c:any)=>({slideId:c.slideId.slice(0,100),page:c.page,where:c.where.slice(0,80),before:c.before.slice(0,40),after:c.after.slice(0,40),kind:c.kind}));
  return {at:value.at.slice(0,40),from:value.from.slice(0,200),documents:strings(value.documents,8,200),previousDocuments:strings(value.previousDocuments,8,200),changes,edited:count(value.edited),unresolved:count(value.unresolved)};
}
function checked(value:any):HistoryRecord {
  if(!value||value.schemaVersion!==1||!validId(value.id)||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.updatedAt)))throw new AppError(422,'履歴の形式を読み取れません。','INVALID_HISTORY');
  const raw=value.session;if(!raw||raw.phase!=='ready'||!Array.isArray(raw.variants)||!raw.variants.length||raw.variants.length>3||!Array.isArray(raw.messages))throw new AppError(422,'作成済み資料の履歴を読み取れません。','INVALID_HISTORY');
  const outline=validateOutline(raw.outline),variants=raw.variants.map((v:any)=>{const deck=validateDeck(v.deck,outline);const origin=safeOrigin(v.origin);return {id:requireText(v.id,'案のID',100),label:requireText(v.label,'案の名前',100),deck,...(origin?{origin}:{}),...(safeRender(v.render,deck.slides.length)?{render:safeRender(v.render,deck.slides.length)}:{})};});
  const messages=raw.messages.map((m:any)=>{if(!m||!['user','assistant'].includes(m.role))throw new AppError(422,'履歴の会話形式が正しくありません。');return {role:m.role as 'user'|'assistant',text:preservedText(m.text,'会話',MAX_PROMPT_CHARACTERS+300)};});
  if(messages.reduce((sum:number,m:{text:string})=>sum+m.text.length,0)>250_000)throw new AppError(413,'履歴の会話が大きすぎます。');
  if(!Array.isArray(value.documents)||value.documents.length>DOCUMENT_LIMITS.files)throw new AppError(422,'履歴の根拠資料を読み取れません。');
  const documents:ParsedDocument[]=value.documents.map((doc:any)=>{
    if(!doc||!validId(doc.id)||!['pdf','csv','xlsx','pptx','txt'].includes(doc.kind)||!Array.isArray(doc.sources)||doc.sources.length>DOCUMENT_LIMITS.rows+DOCUMENT_LIMITS.pages)throw new AppError(422,'履歴の根拠資料の形式が正しくありません。');
    const sources=doc.sources.map((s:any)=>({id:requireText(s.id,'参照ID',100),locator:requireText(s.locator,'根拠の位置',300),text:preservedText(s.text,'根拠の内容',DOCUMENT_LIMITS.characters)}));
    const characters=sources.reduce((sum:number,s:{text:string})=>sum+s.text.length,0);if(characters>DOCUMENT_LIMITS.characters)throw new AppError(413,'履歴の資料が大きすぎます。');
    return {id:doc.id,name:requireText(doc.name,'資料名',200),kind:doc.kind,sources,units:sources.length,characters,warnings:Array.isArray(doc.warnings)?doc.warnings.filter((w:unknown)=>typeof w==='string'):[]};
  });documentContext(documents);
  const usage=emptyUsage();for(const key of Object.keys(usage) as (keyof typeof usage)[])if(typeof raw.usage?.[key]==='number'&&Number.isFinite(raw.usage[key])&&raw.usage[key]>=0)usage[key]=raw.usage[key];
  const provider=['subscription','chat','claude','local','demo'].includes(raw.provider)?raw.provider as Session['provider']:undefined;
  const projectId=raw.projectId??DEFAULT_PROJECT_ID;if(!validId(projectId))throw new AppError(422,'履歴のプロジェクト情報が正しくありません。','INVALID_HISTORY');
  const subscriptionService=provider==='subscription'&&['chatgpt','claude'].includes(raw.subscriptionService)?raw.subscriptionService as Session['subscriptionService']:undefined;
  return {schemaVersion:1,id:value.id,revision:value.revision,createdAt:value.createdAt,updatedAt:value.updatedAt,documents,session:{id:requireText(raw.id,'作業ID',100),phase:'ready',outline,messages,variants,usage,projectId,...(provider?{provider}:{}),...(subscriptionService?{subscriptionService}:{}),...(safeRefresh(raw.refresh)?{refresh:safeRefresh(raw.refresh)}:{}),warnings:Array.isArray(raw.warnings)?raw.warnings.filter((w:unknown)=>typeof w==='string'):[]}};
}
function entry(record:HistoryRecord):HistoryEntry {const deck=record.session.variants[0].deck;return {id:record.id,title:deck.title,createdAt:record.createdAt,updatedAt:record.updatedAt,slides:deck.slides.length,variants:record.session.variants.length,mode:deck.mode,projectId:record.session.projectId??DEFAULT_PROJECT_ID,thumbnail:record.session.variants.find(v=>v.render?.thumbnails[0])?.render?.thumbnails[0]};}
function version(record:HistoryRecord):HistoryVersion {const deck=record.session.variants[0].deck;return {revision:record.revision,savedAt:record.updatedAt,title:deck.title,slides:deck.slides.length};}
// Rendering, token counters and reopening a session do not create a content version.
function contentKey(record:HistoryRecord){return JSON.stringify({projectId:record.session.projectId,outline:record.session.outline,messages:record.session.messages,variants:record.session.variants.map(v=>({id:v.id,label:v.label,deck:v.deck})),documents:record.documents});}

/** User-authorized local content storage. API keys/settings/bootstrap tokens are never included. */
export class HistoryStore {
  private directory:string;private queue:Promise<unknown>=Promise.resolve();
  constructor(dataDir:string){this.directory=path.resolve(dataDir,'presentations');}
  private file(id:string){if(!validId(id))throw new AppError(400,'履歴IDが正しくありません。');return path.join(this.directory,id+'.json');}
  private versionFile(id:string,revision:number){this.file(id);if(!Number.isSafeInteger(revision)||revision<1)throw new AppError(400,'履歴の版番号が正しくありません。');return path.join(this.directory,'versions',id,revision+'.json');}
  private async safeDirectory(relative:string[]=[] ,create=false){
    let current=this.directory;
    for(const part of ['',...relative]){
      if(part)current=path.join(current,part);
      let stat;try{stat=await lstat(current);}catch(error:any){if(error.code!=='ENOENT')throw error;if(!create)return false;await mkdir(current,{recursive:current===this.directory});stat=await lstat(current);}
      if(!stat.isDirectory()||stat.isSymbolicLink())throw new AppError(422,'履歴の保存先を読み取れません。','INVALID_HISTORY');
    }
    return true;
  }
  private async readRecord(name:string,id:string,revision?:number){
    let stat;try{stat=await lstat(name);}catch(error:any){if(error.code==='ENOENT')throw new AppError(404,'保存した履歴が見つかりません。');throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_HISTORY_BYTES)throw new AppError(422,'履歴ファイルを読み取れません。','INVALID_HISTORY');
    try{const record=checked(JSON.parse(await readFile(name,'utf8')));if(record.id!==id||(revision!==undefined&&record.revision!==revision))throw new Error('ID/revision');return record;}catch(error){if(error instanceof AppError)throw error;throw new AppError(422,'履歴が破損しています。元のPowerPointファイルは変更していません。','INVALID_HISTORY');}
  }
  async load(id:string){const name=this.file(id);if(!await this.safeDirectory())throw new AppError(404,'保存した履歴が見つかりません。');return this.readRecord(name,id);}
  async list(projectId?:string){if(!await this.safeDirectory())return {entries:[] as HistoryEntry[],warnings:[] as string[]};const names=await readdir(this.directory),entries:HistoryEntry[]=[],warnings:string[]=[];for(const name of names.filter(n=>n.endsWith('.json')&&validId(n.slice(0,-5))).slice(0,500)){try{entries.push(entry(await this.load(name.slice(0,-5))));}catch{warnings.push('読み取れない履歴があります。元のPowerPointファイルは保持されています。');}}return {entries:entries.filter(item=>!projectId||item.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),warnings:[...new Set(warnings)]};}
  /** Retained content versions plus the current version, newest first. */
  async versions(id:string):Promise<HistoryVersion[]>{
    const current=await this.load(id),result=[version(current)];
    if(!await this.safeDirectory(['versions',id]))return result;
    const names=(await readdir(path.join(this.directory,'versions',id))).filter(name=>/^[1-9]\d{0,15}\.json$/.test(name)).sort((a,b)=>Number(b.slice(0,-5))-Number(a.slice(0,-5))).slice(0,MAX_VERSIONS);
    for(const name of names){const revision=Number(name.slice(0,-5));if(revision>=current.revision||!Number.isSafeInteger(revision))continue;try{result.push(version(await this.readRecord(this.versionFile(id,revision),id,revision)));}catch{/* Corrupt snapshots never replace the valid current presentation. */}}
    return result.sort((a,b)=>b.revision-a.revision);
  }
  async loadVersion(id:string,revision:number):Promise<HistoryRecord>{
    const name=this.versionFile(id,revision),current=await this.load(id);if(current.revision===revision)return current;
    if(revision>current.revision||!await this.safeDirectory(['versions',id]))throw new AppError(404,'保存した履歴の版が見つかりません。');
    return this.readRecord(name,id,revision);
  }
  save(session:Session,documents:ParsedDocument[],id?:string,expectedRevision=0){return this.serial(async()=>{
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw new AppError(400,'履歴の版番号が正しくありません。');
    await this.safeDirectory([],true);const historyId=id??randomUUID(),now=new Date().toISOString();this.file(historyId);let prior:HistoryRecord|undefined;
    if(id){try{prior=await this.load(id);}catch(error){if(!(error instanceof AppError)||error.status!==404)throw error;}}
    if((prior?.revision??0)!==expectedRevision)throw new AppError(409,'別の画面でこの履歴が更新されました。履歴を開き直すか、複製して編集してください。','HISTORY_CONFLICT');
    if(!prior&&(await readdir(this.directory)).filter(n=>n.endsWith('.json')).length>=500)throw new AppError(413,'保存履歴は500件までです。不要な履歴を削除してください。');
    const record=checked({schemaVersion:1,id:historyId,revision:expectedRevision+1,createdAt:prior?.createdAt??now,updatedAt:now,session,documents});
    const data=JSON.stringify(record);if(Buffer.byteLength(data)>MAX_HISTORY_BYTES)throw new AppError(413,'履歴に保存する内容が大きすぎます。');
    if(prior&&contentKey(prior)!==contentKey(record)){await this.safeDirectory(['versions',historyId],true);await this.atomicWrite(this.versionFile(historyId,prior.revision),JSON.stringify(prior));}
    await this.atomicWrite(this.file(historyId),data);await this.pruneVersions(historyId);return record;
  });}
  remove(id:string){return this.serial(async()=>{
    const name=this.file(id);if(!await this.safeDirectory())return;
    // Verify every managed directory before deleting anything. Never traverse a symlink/junction.
    const hasVersions=await this.safeDirectory(['versions',id]);
    if(hasVersions){const directory=path.join(this.directory,'versions',id);for(const filename of await readdir(directory)){if(!/^[1-9]\d{0,15}\.json$/.test(filename))continue;await this.removeRegular(path.join(directory,filename));}await rmdir(directory).catch(error=>{if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;});}
    await this.removeRegular(name);
  });}
  private async atomicWrite(name:string,data:string){
    try{const stat=await lstat(name);if(!stat.isFile()||stat.isSymbolicLink())throw new AppError(422,'履歴の保存先が正しくありません。','INVALID_HISTORY');}catch(error:any){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(path.dirname(name),path.basename(name)+'.'+randomUUID()+'.tmp');try{await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,name);}finally{await unlink(temporary).catch(()=>{});}
  }
  private async removeRegular(name:string){let stat;try{stat=await lstat(name);}catch(error:any){if(error.code==='ENOENT')return;throw error;}if(!stat.isFile()||stat.isSymbolicLink())throw new AppError(422,'履歴ファイルを削除できません。','INVALID_HISTORY');await unlink(name);}
  private async pruneVersions(id:string){
    if(!await this.safeDirectory(['versions',id]))return;
    const directory=path.join(this.directory,'versions',id),names=(await readdir(directory)).filter(name=>/^[1-9]\d{0,15}\.json$/.test(name)&&Number.isSafeInteger(Number(name.slice(0,-5)))).sort((a,b)=>Number(b.slice(0,-5))-Number(a.slice(0,-5)));
    for(const filename of names.slice(MAX_VERSIONS))await this.removeRegular(path.join(directory,filename));
  }
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const result=this.queue.then(operation,operation);this.queue=result.catch(()=>{});return result;}
}
