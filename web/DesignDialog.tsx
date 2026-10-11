import {useEffect,useRef,useState} from 'react';
import type {DesignEntry} from '../shared/contracts';
import {themes} from '../shared/themes';
import {typographyProfiles,withTypography} from '../shared/typography';
import {api} from './api';
import {Icon,Modal,Spinner} from './ui';

function DesignPreview({entry}:{entry:DesignEntry}){
  const [failed,setFailed]=useState(false);
  const theme=entry.palette??themes[entry.themeId]??themes.paper,typography=withTypography(theme,entry.typographyId);
  if(entry.thumbnail&&!failed)return <img className="design-thumbnail" src={entry.thumbnail} alt={`${entry.name}の保存時のスライド`} onError={()=>setFailed(true)}/>;
  return <div className="design-swatch" style={{background:theme.background,color:theme.foreground,fontFamily:`"${typography.headingFont??typography.font}",sans-serif`}}><span className="design-swatch-caption">DESIGN SAMPLE</span><strong style={{borderColor:theme.accent}}>伝わるデザイン</strong><div className="design-swatch-panels">{(theme.itemColors??[theme.accent,theme.secondary,theme.pale]).slice(0,3).map((color,index)=><span key={index} style={{background:color}}/>)}</div></div>;
}

export function DesignDialog({busy,canApply,preferredId,projectId,projectName,onApply,onPrefer,onDeleted,onClose}:{busy:boolean;canApply:boolean;preferredId?:string;projectId:string;projectName:string;onApply:(id:string)=>void;onPrefer:(entry:DesignEntry|undefined)=>Promise<void>;onDeleted:(id:string)=>void;onClose:()=>void}){
  const [entries,setEntries]=useState<DesignEntry[]>([]),[warnings,setWarnings]=useState<string[]>([]),[loading,setLoading]=useState(true),[working,setWorking]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [sort,setSort]=useState<'votes'|'recent'>('votes');
  const importInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{const controller=new AbortController();api<{entries:DesignEntry[];warnings:string[]}>(`/designs?projectId=${encodeURIComponent(projectId)}`,{signal:controller.signal}).then(value=>{setEntries(value.entries);setWarnings(value.warnings);setLoading(false);}).catch(e=>{if(e.name!=='AbortError'){setError(e.message);setLoading(false);}});return()=>controller.abort();},[projectId]);
  async function vote(id:string,delta:1|-1){setWorking(id);setError('');try{const entry=await api<DesignEntry>(`/designs/${id}/vote`,{method:'POST',body:JSON.stringify({delta})});setEntries(previous=>previous.map(value=>value.id===id?entry:value));}catch(e){setError(e instanceof Error?e.message:'投票できませんでした。');}finally{setWorking('');}}
  async function remove(id:string){setWorking(id);setError('');try{await api(`/designs/${id}`,{method:'DELETE'});setEntries(previous=>previous.filter(entry=>entry.id!==id));onDeleted(id);}catch(e){setError(e instanceof Error?e.message:'削除できませんでした。');}finally{setWorking('');}}
  async function prefer(entry:DesignEntry|undefined){setWorking(entry?.id??'clear');setError('');try{await onPrefer(entry);}catch(e){setError(e instanceof Error?e.message:'設定できませんでした。');}finally{setWorking('');}}
  async function exportPack(){setWorking('export');setError('');try{const pack=await api<{format:string;schemaVersion:number;designs:unknown[]}>(`/projects/${projectId}/design-pack`);const blob=new Blob([JSON.stringify(pack,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='Designer-Extention-design-set.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(e instanceof Error?e.message:'共有用ファイルを作れませんでした。');}finally{setWorking('');}}
  async function importPack(file?:File){if(!file)return;setError('');setWorking('import');try{if(file.size>256*1024)throw new Error('共有用ファイルは256 KB以内です。');const pack=JSON.parse(await file.text());const result=await api<{imported:number;template?:boolean}>(`/projects/${projectId}/design-pack`,{method:'POST',body:JSON.stringify(pack)});const value=await api<{entries:DesignEntry[];warnings:string[]}>(`/designs?projectId=${encodeURIComponent(projectId)}`);setEntries(value.entries);setWarnings(value.warnings);setNotice(`「${projectName}」にデザイン設定を${result.imported}件取り込みました。${result.template?'会社テンプレートの配色・書体もこのプロジェクトに登録しました。':''}`);}catch(e){setError(e instanceof Error?e.message:'共有用ファイルを読み込めませんでした。');}finally{setWorking('');if(importInput.current)importInput.current.value='';}}
  const ordered=[...entries].sort((a,b)=>sort==='votes'?b.votes-a.votes||b.updatedAt.localeCompare(a.updatedAt):b.updatedAt.localeCompare(a.updatedAt));
  return <Modal title="お気に入りのデザイン" onClose={onClose} wide>
    <p className="modal-prose">良かった配色・書体・構図をこのPCに保存し、別の資料に再利用します。投票は好みの記録です。AIモデルの学習は行いません。本文や根拠資料はデザインに保存しません。</p>
    <div className="design-toolbar"><label>並び順<select value={sort} onChange={event=>setSort(event.target.value as typeof sort)}><option value="votes">投票の多い順</option><option value="recent">更新の新しい順</option></select></label><div className="design-share-actions"><button className="button secondary small" disabled={busy||!!working} onClick={()=>void exportPack()}>共有用に書き出す</button><button className="button secondary small" disabled={busy||!!working} onClick={()=>importInput.current?.click()}>共有設定を取り込む</button><input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event=>void importPack(event.target.files?.[0])}/></div>{preferredId&&<button className="button secondary small" disabled={busy||!!working} onClick={()=>void prefer(undefined)}>次回のデザイン指定を解除</button>}</div>
    {loading&&<p role="status"><Spinner/> デザインを読み込んでいます</p>}{error&&<p className="error-banner" role="alert">{error}</p>}{notice&&<p className="success-note" role="status">{notice}</p>}{warnings.map(warning=><p className="modal-prose" key={warning}>{warning}</p>)}
    {!loading&&!entries.length&&!error&&<p className="history-empty">まだ保存したデザインはありません。作成した資料の「デザインを保存」、またはスライドの星ボタンから追加できます。</p>}
    <div className="design-gallery">{ordered.map(entry=>{const theme=entry.palette??themes[entry.themeId]??themes.paper, typography=withTypography(theme,entry.typographyId);return <article className="design-entry" key={entry.id}>
      <DesignPreview entry={entry}/>
      <div className="design-description"><h3>{entry.name}</h3><p>{theme.name??entry.themeId} · {entry.typographyId?typographyProfiles[entry.typographyId as keyof typeof typographyProfiles]?.name??entry.typographyId:'テーマの書体'}</p><p>{entry.layoutIds.length} 種類の構図 · {entry.mode==='reading'?'読む資料':'発表用'}</p><div className="design-votes"><Icon name="star" size={14}/><strong>{entry.votes} 票</strong><button className="button ghost small" disabled={busy||!!working} onClick={()=>void vote(entry.id,1)}>+1 投票</button><button className="icon-button" aria-label={`${entry.name}の票を減らす`} disabled={busy||!!working||entry.votes<=0} onClick={()=>void vote(entry.id,-1)}>−</button></div>
      <div className="design-actions">{canApply&&<button className="button primary small" disabled={busy||!!working} onClick={()=>onApply(entry.id)}>選択中の案に適用</button>}<button className="button secondary small" aria-pressed={preferredId===entry.id} disabled={busy||!!working||preferredId===entry.id} onClick={()=>void prefer(entry)}>{preferredId===entry.id?'次回に使用 ✓':'次回の作成に使う'}</button><button className="button ghost small" disabled={busy||!!working} onClick={()=>void remove(entry.id)}>削除</button></div></div>
    </article>;})}</div>
  </Modal>;
}

export function SaveDesignDialog({initialName,onSave,onClose,busy}:{initialName:string;onSave:(name:string)=>void;onClose:()=>void;busy:boolean}){
  const [name,setName]=useState(initialName);
  return <Modal title="良かったデザインを保存" onClose={onClose}><p className="modal-prose">配色・書体・構図だけを保存します。スライドの文章や資料は履歴に保存されます。</p><label className="field"><span>デザイン名</span><input value={name} maxLength={100} onChange={event=>setName(event.target.value)} placeholder="例：比較が分かりやすい配色" autoFocus/></label><div className="settings-actions"><button className="button secondary" disabled={busy} onClick={onClose}>キャンセル</button><button className="button primary" disabled={busy||!name.trim()} onClick={()=>onSave(name.trim())}><Icon name="star" size={15}/>保存して1票</button></div></Modal>;
}
