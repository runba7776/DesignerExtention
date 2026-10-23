import { useEffect, useState } from 'react';
import type { ChatService, Settings } from '../shared/contracts';
import { api } from './api';
import { chatServices } from './ChatHandoffPanel';
import { openExternal } from './office';
import { Icon, Modal, Spinner } from './ui';

export interface AiKit {
  version: string;
  instructions: string;
  catalog: string;
  fileName: string;
}
const steps: Partial<Record<ChatService, { create: string; instructions: string; file: string }>> = {
  claude: {
    create: 'Claudeの左側の「プロジェクト」→「プロジェクトを作成」で、名前を「Designer Extention」にして作成します。',
    instructions: 'プロジェクトの「指示を設定」（Instructions）に貼り付けて保存します。',
    file: 'プロジェクトの「ファイルを追加」から保存したファイルをアップロードします（または「テキストコンテンツを追加」に全文を貼り付け、名前をファイル名と同じにします）。',
  },
  chatgpt: {
    create: 'ChatGPTの左側の「プロジェクト」→「新しいプロジェクト」で、名前を「Designer Extention」にして作成します。',
    instructions: 'プロジェクトの「指示」（Instructions）に貼り付けて保存します。',
    file: 'プロジェクトの「ファイルを追加」から保存したファイルをアップロードします。',
  },
};
const generic = {
  create: 'お使いのAIでプロジェクト（または指示とファイルを保持できる場所）を作成します。',
  instructions: 'プロジェクトの指示（システム指示）に貼り付けます。',
  file: 'プロジェクトのファイルとして追加します。',
};

/** One-time preparation of a ChatGPT/Claude project that holds the fixed part of
 * every instruction. Afterwards each request sends only the task and documents. */
export function AiSetupDialog({
  service,
  settings,
  onSaved,
  onClose,
}: {
  service: ChatService;
  settings: Settings;
  onSaved: (value: Settings) => void;
  onClose: () => void;
}) {
  const [kit, setKit] = useState<AiKit>(),
    [url, setUrl] = useState(settings.chatProjects?.[service]?.url ?? ''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false);
  const info = chatServices[service],
    guide = steps[service] ?? generic,
    link = settings.chatProjects?.[service];
  useEffect(() => {
    const controller = new AbortController();
    api<AiKit>('/ai-kit', { signal: controller.signal })
      .then(setKit)
      .catch(e => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => controller.abort();
  }, []);
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label}をコピーしました。`);
    } catch {
      setError('コピーできませんでした。表示された文章を選択してコピーしてください。');
    }
  }
  function download() {
    if (!kit) return;
    const href = URL.createObjectURL(new Blob([kit.catalog], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = kit.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setNotice(`「${kit.fileName}」を保存しました。保存できない場合は「全文をコピー」を使ってください。`);
  }
  async function save(remove = false) {
    if (!kit) return;
    setSaving(true);
    setError('');
    try {
      const chatProjects = {
        ...(settings.chatProjects ?? {}),
        [service]: remove ? null : { url: url.trim(), kitVersion: kit.version },
      };
      onSaved(await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify({ chatProjects }) }));
      setNotice(
        remove
          ? 'AI用プロジェクトの登録を解除しました。次の指示から完全版に戻ります。'
          : `登録しました。次の指示から短い指示になり、「${info.name}を開く」でこのプロジェクトが開きます。`,
      );
      if (remove) setUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存できませんでした。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={`AIの準備（${info.name}）`} onClose={onClose}>
      <p className="modal-prose">
        {info.name}に「Designer
        Extention」用のプロジェクトを1回だけ作り、毎回同じ参考の一覧（アイコン・グラフ・テーマ・書体）をそこに置きます。以降、AIに渡す指示が短くなり、上限にかかりにくくなります。デザインの型や見本は含みません。
      </p>
      {link && kit && (
        <p className={`settings-note ${link.kitVersion === kit.version ? '' : 'warning'}`}>
          <Icon name="info" size={15} />
          <span>
            {link.kitVersion === kit.version
              ? '準備済みです。説明は最新の版です。'
              : 'アプリの更新で説明の版が変わりました。手順2・3の内容をプロジェクトに貼り直し、手順4で登録し直してください。それまでは完全版の指示を使います。'}
          </span>
        </p>
      )}
      {!kit && !error && (
        <p className="busy-status">
          <Spinner />
          説明を準備しています
        </p>
      )}
      {kit && (
        <ol className="guide-steps setup-steps">
          <li>
            <strong>{info.name}でプロジェクトを作る</strong>
            <span>{guide.create}</span>
            {info.projectsUrl && (
              <button className="button secondary small" onClick={() => openExternal(info.projectsUrl!, false)}>
                {info.name}を開く
                <Icon name="arrow" size={12} />
              </button>
            )}
          </li>
          <li>
            <strong>プロジェクトの指示を貼る</strong>
            <span>{guide.instructions}</span>
            <textarea readOnly className="setup-text" value={kit.instructions} aria-label="プロジェクトの指示" />
            <button className="button primary small" onClick={() => void copy(kit.instructions, 'プロジェクトの指示')}>
              <Icon name="file" size={13} />
              指示をコピー
            </button>
          </li>
          <li>
            <strong>説明のファイルを追加する</strong>
            <span>
              {guide.file} ファイル名：{kit.fileName}（版 {kit.version}・{kit.catalog.length.toLocaleString()}文字）
            </span>
            <div className="handoff-actions">
              <button className="button primary small" onClick={download}>
                <Icon name="download" size={13} />
                ファイルを保存
              </button>
              <button className="button secondary small" onClick={() => void copy(kit.catalog, '説明の全文')}>
                全文をコピー
              </button>
            </div>
          </li>
          <li>
            <strong>プロジェクトのURLを登録する</strong>
            <span>作ったプロジェクトを開き、ブラウザーのアドレス欄のURLをコピーして貼り付けます。</span>
            <input
              className="setup-url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder={
                service === 'claude'
                  ? 'https://claude.ai/project/…'
                  : service === 'chatgpt'
                    ? 'https://chatgpt.com/g/…/project'
                    : 'https://…'
              }
              spellCheck={false}
              aria-label="プロジェクトのURL"
            />
            <div className="handoff-actions">
              <button className="button primary small" disabled={saving || !url.trim()} onClick={() => void save()}>
                {saving ? <Spinner /> : <Icon name="check" size={13} />}登録
              </button>
              {link && (
                <button className="button ghost small" disabled={saving} onClick={() => void save(true)}>
                  登録を解除
                </button>
              )}
            </div>
          </li>
        </ol>
      )}
      <p className="modal-prose">
        使い方：構成の指示と、続くスライド作成の指示は、プロジェクト内の同じチャットに貼ってください。AIがファイルを読めない様子のときは、連携画面の「完全版の指示に切り替える」で従来の指示を使えます。プロジェクトに入れるのはアプリ共通の説明だけで、資料や会話は含まれません。
      </p>
      {error && (
        <p className="error-inline" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}
      <div className="settings-actions">
        <button className="button primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Modal>
  );
}
