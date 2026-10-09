import { useState } from 'react';
import type { Settings, ProviderKind, TemplateTheme } from '../shared/contracts';
import { api } from './api';
import { Icon, Modal, Spinner } from './ui';
import { MAX_SLIDES } from '../shared/contracts';
import { themes, TEMPLATE_THEME_ID } from '../shared/themes';
import { templateToTheme } from '../shared/template-style';
import {typographyProfiles,withTypography} from '../shared/typography';
import {chatServices} from './ChatHandoffPanel';
import {SubscriptionConnectionPanel} from './SubscriptionConnectionPanel';
import {inWebPowerPoint} from './office';

export function SettingsDialog({settings, template, activeSession, onClose, onSaved}: {settings: Settings; template?: TemplateTheme; activeSession: boolean; onClose: () => void; onSaved: (value: Settings) => void}) {
  const [draft, setDraft] = useState<Settings>({...settings,provider:settings.provider==='claude'||(__HOSTED__&&settings.provider==='subscription')?'chat':settings.provider});
  const templateTheme = template ? templateToTheme(template) : undefined;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const provider = (value: ProviderKind) => setDraft(previous => ({...previous, provider: value, model: value==='subscription'?previous.provider==='subscription'?previous.model:'auto':value === 'chat' ? 'manual-chat' : value === 'demo' ? 'demo' : previous.provider==='local'?previous.model:'', subscriptionService:previous.subscriptionService??'chatgpt', chatService:previous.chatService??'chatgpt', endpoint: previous.endpoint || 'http://127.0.0.1:11434/v1'}));
  async function save() {
    setSaving(true); setError('');
    try {
      const {apiKey:unusedKey,hasKey:unusedHasKey,...safeDraft}=draft;
      const saved = await api<Settings>('/settings', {method: 'PUT', body: JSON.stringify(safeDraft)});
      onSaved(saved); onClose();
    } catch(e) {setError(e instanceof Error ? e.message : '設定を保存できませんでした。');}
    finally {setSaving(false);}
  }
  return <Modal title="設定" onClose={() => {if (!saving) onClose();}}>
    <div className="field"><span>処理する場所</span></div>
    <div className="settings-provider subscription-providers" role="group" aria-label="処理する場所">
      {([['subscription','月額版で自動作成'],['local','ローカル LLM'],['chat','手動チャット連携'],['demo','サンプル体験']] as const).map(([id,label]) => <button key={id} type="button" disabled={activeSession || saving || (__HOSTED__ && id === 'subscription')} title={__HOSTED__ && id === 'subscription' ? 'ブラウザ版では使えません。PCにローカルアプリを導入すると利用できます。' : undefined} className={draft.provider === id ? 'selected' : ''} aria-pressed={draft.provider === id} onClick={() => provider(id)}>{label}</button>)}
    </div>
    {__HOSTED__ && <div className="settings-note"><Icon name="info" size={15}/><span>インストール不要のブラウザ版です。資料の読み取り・スライドの作成はこのブラウザの中で行い、履歴や設定はこのブラウザに保存します。月額版での自動作成は、PCにローカルアプリを導入した場合だけ使えます。</span></div>}
    {activeSession && <div className="settings-note"><Icon name="info" size={15}/><span>処理先と表示モードは資料ごとに固定されます。変更する場合は「新しく作成」から始めてください。</span></div>}
    {draft.provider==='subscription'&&<SubscriptionConnectionPanel service={draft.subscriptionService??'chatgpt'} model={draft.model} locked={activeSession} saving={saving} onServiceChange={value=>setDraft(previous=>({...previous,subscriptionService:value,model:'auto'}))} onModelChange={value=>setDraft(previous=>previous.model===value?previous:{...previous,model:value})}/>}
    {draft.provider === 'chat' && <>
      <div className="settings-note"><Icon name="message" size={16}/><span>指示をコピーし、ご自身のAIチャットで実行して返答を取り込みます。有料APIは使いません。月額版・無料版の利用可否や上限は、ご利用のAIに従います。ログイン・送信はご自身で行います。</span></div>
      <label className="field"><span>利用するAIチャット</span><select value={draft.chatService??'chatgpt'} disabled={saving} onChange={event=>setDraft({...draft,chatService:event.target.value as Settings['chatService']})}>{Object.entries(chatServices).map(([id,service])=><option key={id} value={id}>{service.name}</option>)}</select><small>Claude Design等で、指定したJSON形式の返答を作成できる場合は「その他のAI」を選べます。作成済みの画像やPPTXを直接反映する連携ではありません。Claude Desktopは追加設定で、指示の取得・返答の取り込みを自動化できます。</small></label>
      {!__HOSTED__&&draft.chatService==='claude'&&<details className="connector-help"><summary>Claude Desktopで直接連携する</summary><p>Claude Desktopの設定に接続用の設定を追加すると、指示の取得・返答の取り込みをClaudeから操作できます。月額版の利用枠が適用され、資料はClaudeのクラウドに渡ります。設定はご自身で追加してください。</p><a className="button secondary small" href="/api/chat-connector-config" download>接続用の設定をダウンロード</a><small>このPCのClaude Desktop用です。ほかのAIチャットにはコピー・貼り付け方式を使います。</small></details>}
    </>}
    {draft.provider === 'local' && <>
      {inWebPowerPoint()&&<div className="settings-note warning" role="alert"><Icon name="info" size={16}/><span>PowerPoint for the webの中からは、ブラウザーの安全機能（ローカル ネットワーク アクセスの制限）により、このPCのローカルLLMに接続できません。ここでは「手動チャット連携」を使うか、デスクトップ版PowerPoint、またはこのページをブラウザーで直接開いて使ってください。</span></div>}
      <div className="settings-note"><Icon name="lock" size={16}/><span>このPCのOpenAI互換サーバーに接続します。資料を外部のAIへ送信せず、ローカルLLMで生成します。クラウドへの自動切り替えは行いません。</span></div>
      <label className="field"><span>接続先</span><input value={draft.endpoint || ''} onChange={event => setDraft({...draft,endpoint:event.target.value})} placeholder="http://127.0.0.1:11434/v1" spellCheck={false}/><small>{__HOSTED__?<>このPCのループバック（127.0.0.1）か社内のプライベートIPに接続します。ブラウザ版から接続するには、Ollamaは環境変数 OLLAMA_ORIGINS に {location.origin} を追加して再起動、LM Studioは「CORSを有効化」をオンにしてください。</>:'初期版はこの PC のループバック接続に対応します。先にローカル LLM サーバーを起動してください。'}</small></label>
    </>}
    {draft.provider === 'local' && <label className="field"><span>モデル</span><input value={draft.model} onChange={event => setDraft({...draft,model:event.target.value})} placeholder="ローカルサーバーで使用するモデル名" spellCheck={false}/><small>接続先にインストールしたモデルの名前を入力してください。</small></label>}
    {draft.provider === 'demo' && <div className="settings-note"><Icon name="slides" size={16}/><span>API キーなしで操作を試せます。あらかじめ用意したサンプル資料を使用し、入力した指示やファイルの分析は行いません。</span></div>}
    <hr className="setting-divider"/>
    {(draft.provider==='local'||draft.provider==='subscription')&&<label className="field auto-repair-setting"><span><input type="checkbox" checked={draft.autoRepair!==false} disabled={saving} onChange={event=>setDraft({...draft,autoRepair:event.target.checked})}/>生成・修正の不備を自動で対処</span><small>出力上限や形式・出典・文字量の不備に、1回の操作で最大2回再試行します。処理後に対処内容を表示します。{draft.provider==='subscription'?'再試行も月額版の利用枠を消費します。':''}変更は次の操作から有効です。</small></label>}
    <label className="field"><span>スライドの表示モード</span><select disabled={activeSession || saving} value={draft.mode} onChange={event => setDraft({...draft,mode:event.target.value as Settings['mode']})}><option value="presentation">発表用 — 図を大きく、要点は短く</option><option value="reading">読む資料 — 説明・条件もスライドに</option></select></label>
    <label className="field"><span>スライドの枚数</span><select disabled={activeSession||saving} value={draft.slideCount??'auto'} onChange={event=>setDraft({...draft,slideCount:event.target.value==='auto'?'auto':Number(event.target.value)})}><option value="auto">AIにおまかせ</option>{Array.from({length:MAX_SLIDES-1},(_,i)=>i+2).map(count=><option key={count} value={count}>{count} 枚（表紙込み）</option>)}</select><small>最大 {MAX_SLIDES} 枚。おまかせの場合も希望の枚数を伝えられます。枚数が多いと処理時間やチャットとの受け渡しが増えます。</small></label>
    <div className="field"><span>資料全体のテーマ</span><small>背景・配色・表紙・見出し・表の雰囲気をそろえます。</small></div>
    <button className={`theme-auto ${(draft.themeId??'auto')==='auto'?'selected':''}`} disabled={activeSession||saving} aria-pressed={(draft.themeId??'auto')==='auto'} onClick={()=>setDraft({...draft,themeId:'auto'})}>AIにおまかせ — 内容と希望する雰囲気から選ぶ</button>
    {(templateTheme||draft.themeId===TEMPLATE_THEME_ID)&&<button className={`theme-auto template-choice ${draft.themeId===TEMPLATE_THEME_ID?'selected':''}`} disabled={activeSession||saving||!templateTheme} aria-pressed={draft.themeId===TEMPLATE_THEME_ID} onClick={()=>setDraft({...draft,themeId:TEMPLATE_THEME_ID})}>{templateTheme?<><span className="template-swatches small">{(templateTheme.itemColors??[templateTheme.accent]).map((color,i)=><span key={i} style={{background:color}}/>)}</span>会社テンプレート — {template!.name}の配色と書体</>:'会社テンプレート — このプロジェクトに未登録です'}</button>}
    <div className="theme-choices" role="group" aria-label="テーマを選択">{Object.entries(themes).map(([id,theme])=><button key={id} className={`theme-choice ${draft.themeId===id?'selected':''}`} disabled={activeSession||saving} aria-pressed={draft.themeId===id} onClick={()=>setDraft({...draft,themeId:id})}><span className="theme-swatch" style={{background:theme.background,color:theme.foreground,borderColor:theme.pale,fontFamily:`"${withTypography(theme,draft.typographyId==='auto'?undefined:draft.typographyId).headingFont}",sans-serif`}}><b style={{borderColor:theme.accent}}>伝わる Aa</b>{theme.itemColors?.slice(0,3).map(color=><i key={color} style={{background:color,width:'24%'}}/>)}</span><strong>{theme.name}</strong><small>{theme.description}</small></button>)}</div>
    <label className="field"><span>資料全体の書体</span><select aria-label="資料全体の書体" value={draft.typographyId??'auto'} disabled={activeSession||saving} onChange={event=>setDraft({...draft,typographyId:event.target.value})}><option value="auto">テーマに合わせる / AIにおまかせ</option>{Object.entries(typographyProfiles).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</select><small>{draft.typographyId&&draft.typographyId!=='auto'?typographyProfiles[draft.typographyId as keyof typeof typographyProfiles]?.description:'見出し・本文・数字の組み合わせを資料全体でそろえます。'}</small></label>
    <div className="settings-actions"><span className="error-inline" role="alert">{error}</span><button className="button secondary" disabled={saving} onClick={onClose}>キャンセル</button><button className="button primary" disabled={saving || ((draft.provider==='local'||draft.provider==='subscription')&&!draft.model.trim())} onClick={save}>{saving?<Spinner/>:<Icon name="check" size={15}/>}保存</button></div>
  </Modal>;
}
