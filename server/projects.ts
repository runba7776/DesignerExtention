import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {ProjectProfile,TemplateTheme} from '../shared/contracts.js';
import {isTemplateColor,templateColorKeys} from '../shared/template-colors.js';
import {AppError} from './errors.js';

export const DEFAULT_PROJECT_ID='00000000-0000-4000-8000-000000000001';
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const DEFAULT_PROJECT:ProjectProfile={id:DEFAULT_PROJECT_ID,name:'個人プロジェクト',audience:'',guidance:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};

function text(value:unknown,label:string,max:number,required:boolean){
  if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value))throw new AppError(400,`${label}は${max}文字以内で入力してください。`);
  const result=value.trim();if(required&&!result)throw new AppError(400,`${label}を入力してください。`);return result;
}
const fontName=(value:unknown,label:string,optional:boolean)=>{if(value===undefined&&optional)return undefined;if(typeof value!=='string'||!value.trim()||value.length>64||[...value].some(ch=>ch.charCodeAt(0)<32||'<>"'.includes(ch)))throw new AppError(400,`${label}の書体名を確認してください。`,'INVALID_TEMPLATE');return value.trim();};
/** Company template = palette and font names only. No slide text, images or masters. */
export function validateTemplate(value:unknown):TemplateTheme{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(400,'テンプレートの形式が正しくありません。','INVALID_TEMPLATE');
  const data=value as Record<string,any>,colors={} as TemplateTheme['colors'];
  for(const key of templateColorKeys){if(!isTemplateColor(data.colors?.[key]))throw new AppError(400,`テンプレートの色（${key}）が正しくありません。`,'INVALID_TEMPLATE');colors[key]=data.colors[key];}
  const majorEa=fontName(data.fonts?.majorEa,'見出し（日本語）',true),minorEa=fontName(data.fonts?.minorEa,'本文（日本語）',true);
  if(typeof data.importedAt!=='string'||!Number.isFinite(Date.parse(data.importedAt)))throw new AppError(400,'テンプレートの読み込み日時が正しくありません。','INVALID_TEMPLATE');
  return {name:text(data.name,'テンプレート名',80,true),source:text(data.source??'','読み込み元',120,false),colors,fonts:{major:fontName(data.fonts?.major,'見出し',false)!,minor:fontName(data.fonts?.minor,'本文',false)!,...(majorEa?{majorEa}:{}),...(minorEa?{minorEa}:{})},importedAt:data.importedAt};
}
function checked(value:any):ProjectProfile{
  if(!value||!validId(value.id)||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.updatedAt)))throw new AppError(422,'プロジェクト設定を読み取れません。','INVALID_PROJECT');
  return {id:value.id,name:text(value.name,'プロジェクト名',80,true),audience:text(value.audience??'','対象読者',120,false),guidance:text(value.guidance??'','デザイン・作成方針',2000,false),createdAt:value.createdAt,updatedAt:value.updatedAt,...(value.template?{template:validateTemplate(value.template)}:{})};
}

/** User-owned project guidance; source documents, presentation contents, and credentials are never stored here. */
export class ProjectStore{
  private file:string;private queue:Promise<unknown>=Promise.resolve();private projects:ProjectProfile[]=[{...DEFAULT_PROJECT}];
  constructor(dataDir:string){this.file=path.resolve(dataDir,'projects.json');}
  async load(){
    await mkdir(path.dirname(this.file),{recursive:true});
    try{
      const stat=await lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw new AppError(422,'プロジェクト設定ファイルを読み取れません。','INVALID_PROJECT');
      const raw=JSON.parse(await readFile(this.file,'utf8'));
      if(raw?.schemaVersion!==1||!Array.isArray(raw.projects)||raw.projects.length>100)throw new Error('schema');
      this.projects=raw.projects.map(checked);
      if(new Set(this.projects.map(project=>project.id)).size!==this.projects.length)throw new Error('duplicate project');
      if(!this.projects.some(p=>p.id===DEFAULT_PROJECT_ID))this.projects.unshift({...DEFAULT_PROJECT,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      await this.persist();
    }catch(error:any){
      if(error?.code!=='ENOENT'){if(error instanceof AppError)throw error;throw new AppError(422,'プロジェクト設定が壊れているため起動できません。runtime/projects.jsonを退避して再起動してください。','INVALID_PROJECT');}
      this.projects=[{...DEFAULT_PROJECT}];await this.persist();
    }
    return this;
  }
  list(){return this.projects.map(project=>({...project}));}
  get(id:unknown){if(!validId(id))throw new AppError(400,'プロジェクトを選択してください。','INVALID_PROJECT');const project=this.projects.find(item=>item.id===id);if(!project)throw new AppError(404,'選択したプロジェクトが見つかりません。','PROJECT_NOT_FOUND');return {...project};}
  create(input:unknown){return this.serial(async()=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError(400,'プロジェクト設定の形式が正しくありません。');
    if(this.projects.length>=100)throw new AppError(413,'プロジェクトは100件まで作成できます。');
    const now=new Date().toISOString(),value=input as Record<string,unknown>,project=checked({id:randomUUID(),name:value.name,audience:value.audience??'',guidance:value.guidance??'',createdAt:now,updatedAt:now});
    this.projects.push(project);await this.persist();return {...project};
  });}
  update(id:string,input:unknown){return this.serial(async()=>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError(400,'プロジェクト設定の形式が正しくありません。');
    const index=this.projects.findIndex(project=>project.id===id);if(index<0)throw new AppError(404,'プロジェクトが見つかりません。');
    const value=input as Record<string,unknown>,prior=this.projects[index];
    const project=checked({...prior,name:value.name??prior.name,audience:value.audience??prior.audience,guidance:value.guidance??prior.guidance,updatedAt:new Date().toISOString()});
    this.projects[index]=project;await this.persist();return {...project};
  });}
  /** Sets (or with null, removes) the company template of a project. */
  setTemplate(id:string,input:unknown){return this.serial(async()=>{
    const index=this.projects.findIndex(project=>project.id===id);if(index<0)throw new AppError(404,'プロジェクトが見つかりません。');
    const {template:_previous,...rest}=this.projects[index];
    const project=checked({...rest,...(input===null?{}:{template:validateTemplate(input)}),updatedAt:new Date().toISOString()});
    this.projects[index]=project;await this.persist();return {...project};
  });}
  private async persist(){
    const data=JSON.stringify({schemaVersion:1,projects:this.projects.map(checked)});if(Buffer.byteLength(data)>256*1024)throw new AppError(413,'プロジェクト設定が大きすぎます。');
    try{const stat=await lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink())throw new AppError(422,'プロジェクトの保存先が正しくありません。','INVALID_PROJECT');}catch(error:any){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(path.dirname(this.file),`projects.${randomUUID()}.tmp`);try{await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,this.file);}finally{await unlink(temporary).catch(()=>{});}
  }
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.queue.then(operation,operation);this.queue=next.catch(()=>{});return next;}
}
