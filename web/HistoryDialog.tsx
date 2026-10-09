import {useEffect,useState} from 'react';
import type {HistoryEntry,HistoryVersion} from '../shared/contracts';
import {api} from './api';
import {Modal,Spinner} from './ui';

export function HistoryDialog({onOpen,onDeleted,onClose,busy,projectId,projectName}:{onOpen:(id:string,duplicate:boolean,revision?:number)=>void;onDeleted:(id:string)=>void;onClose:()=>void;busy:boolean;projectId:string;projectName:string}){
  const [entries,setEntries]=useState<HistoryEntry[]>([]),[warnings,setWarnings]=useState<string[]>([]),[loading,setLoading]=useState(true),[deleting,setDeleting]=useState(''),[error,setError]=useState('');
  const [versions,setVersions]=useState<Record<string,HistoryVersion[]>>({}),[expanded,setExpanded]=useState(''),[versionsLoading,setVersionsLoading]=useState('');
  useEffect(()=>{const controller=new AbortController();api<{entries:HistoryEntry[];warnings:string[]}>(`/history?projectId=${encodeURIComponent(projectId)}`,{signal:controller.signal}).then(value=>{setEntries(value.entries);setWarnings(value.warnings);setLoading(false);}).catch(e=>{if(e.name!=='AbortError'){setError(e.message);setLoading(false);}});return()=>controller.abort();},[projectId]);
  async function remove(id:string){setDeleting(id);setError('');try{await api('/history/'+id,{method:'DELETE'});setEntries(previous=>previous.filter(e=>e.id!==id));onDeleted(id);}catch(e){setError(e instanceof Error?e.message:'削除できませんでした。');}finally{setDeleting('');}}
  async function showVersions(id:string){if(expanded===id){setExpanded('');return;}setExpanded(id);if(versions[id])return;setVersionsLoading(id);setError('');try{const value=await api<{versions:HistoryVersion[]}>(`/history/${id}/versions`);setVersions(previous=>({...previous,[id]:value.versions}));}catch(e){setError(e instanceof Error?e.message:'保存版を読み込めませんでした。');}finally{setVersionsLoading('');}}
  return <Modal title={`「${projectName}」の資料履歴`} onClose={onClose}>
    <p className="modal-prose">このプロジェクトで作成した資料はこのPCに自動保存されます。開く・複製・見た目の変更は、AIの追加料金なしで利用できます。</p>
    <p className="modal-prose">スライド・会話・抽出した根拠資料を保存します。変更前の保存版は複製して開けるので、元の履歴を上書きせず比較できます。削除はこの一覧の履歴だけが対象です。</p>
    {loading&&<p role="status"><Spinner/> 履歴を読み込んでいます</p>}
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {warnings.map(w=><p className="modal-prose" key={w}>{w}</p>)}
    {!loading&&!entries.length&&!error&&<p className="history-empty">まだ保存した資料はありません。スライドを作成すると、ここに表示されます。</p>}
    <div className="history-list">{entries.map(entry=><article className="history-entry" key={entry.id}>
      {entry.thumbnail&&<img src={entry.thumbnail} alt="表紙" onError={event=>{event.currentTarget.style.display='none';}}/>}
      <div className="history-description"><h3>{entry.title}</h3><p>{entry.slides}枚 · {entry.mode==='reading'?'読む資料':'発表用'} · {entry.variants}案</p><p>更新 {new Date(entry.updatedAt).toLocaleString('ja-JP')}</p></div>
      <div className="history-actions"><button className="button primary small" disabled={busy||!!deleting} onClick={()=>onOpen(entry.id,false)}>開く</button><button className="button secondary small" disabled={busy||!!deleting} onClick={()=>onOpen(entry.id,true)}>複製して編集</button><button className="button secondary small" disabled={busy||!!deleting||!!versionsLoading} aria-expanded={expanded===entry.id} onClick={()=>void showVersions(entry.id)}>{expanded===entry.id?'保存版を閉じる':'保存版を見る'}</button><button className="button ghost small" disabled={busy||!!deleting} onClick={()=>void remove(entry.id)}>{deleting===entry.id?'削除中':'削除'}</button></div>
      {expanded===entry.id&&<div className="history-versions" aria-label={`${entry.title}の保存版`}>{versionsLoading===entry.id?<p role="status"><Spinner/> 保存版を読み込んでいます</p>:!versions[entry.id]?.length?<p>保存版はまだありません。</p>:versions[entry.id].map(version=><div className="history-version" key={version.revision}><div><strong>保存版 {version.revision}</strong><span>{version.slides}枚 · {new Date(version.savedAt).toLocaleString('ja-JP')}</span></div><button className="button secondary small" disabled={busy||!!deleting} onClick={()=>onOpen(entry.id,true,version.revision)}>この版を複製して開く</button></div>)}</div>}
    </article>)}</div>
  </Modal>;
}
