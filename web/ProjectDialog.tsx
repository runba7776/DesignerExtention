import { useEffect, useState } from 'react';
import type { ProjectProfile } from '../shared/contracts';
import { api } from './api';
import { Icon, Modal, Spinner } from './ui';
import { TemplateSection } from './TemplateSection';

export function ProjectDialog({
  projects,
  activeProjectId,
  busy,
  activeSession,
  onSelect,
  onSaved,
  onTemplateSaved,
  onUseTemplate,
  onClose,
}: {
  projects: ProjectProfile[];
  activeProjectId: string;
  busy: boolean;
  activeSession: boolean;
  onSelect: (project: ProjectProfile) => Promise<void>;
  onSaved: (project: ProjectProfile) => Promise<void>;
  onTemplateSaved: (project: ProjectProfile) => Promise<void>;
  onUseTemplate: () => Promise<void>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [audience, setAudience] = useState(''),
    [guidance, setGuidance] = useState(''),
    [privacyMode, setPrivacyMode] = useState<'full' | 'masked'>('full'),
    [terms, setTerms] = useState(''),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const active = projects.find(project => project.id === activeProjectId) ?? projects[0];
  useEffect(() => {
    if (!creating && active) {
      setName(active.name);
      setAudience(active.audience);
      setGuidance(active.guidance);
      setPrivacyMode(active.privacy?.mode ?? 'full');
      setTerms((active.privacy?.terms ?? []).join('\n'));
    }
  }, [active?.id, active?.name, active?.audience, active?.guidance, active?.privacy, creating]);
  async function save() {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const wasCreating = creating,
        data = {
          name,
          audience,
          guidance,
          privacy: {
            mode: privacyMode,
            terms: terms
              .split('\n')
              .map(t => t.trim())
              .filter(Boolean),
          },
        };
      const project = await api<ProjectProfile>(wasCreating ? '/projects' : `/projects/${active?.id}`, {
        method: wasCreating ? 'POST' : 'PUT',
        body: JSON.stringify(data),
      });
      await onSaved(project);
      setCreating(false);
      setNotice(
        wasCreating ? '新しいプロジェクトを作成し、次の資料から選択します。' : 'プロジェクト設定を保存しました。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'プロジェクトを保存できませんでした。');
    } finally {
      setWorking(false);
    }
  }
  async function select(project: ProjectProfile) {
    setWorking(true);
    setError('');
    try {
      await onSelect(project);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'プロジェクトを切り替えられませんでした。');
    } finally {
      setWorking(false);
    }
  }
  function newProject() {
    setCreating(true);
    setName('');
    setAudience('');
    setGuidance('');
    setError('');
    setNotice('');
  }
  return (
    <Modal title="プロジェクト" onClose={onClose}>
      <p className="modal-prose">
        プロジェクトごとに資料履歴・お気に入り・対象読者・デザイン方針を分けます。設定はこのPCに保存され、資料本文やAIログイン情報はプロジェクト設定に含まれません。
      </p>
      <div className="project-list">
        {projects.map(project => (
          <article className={`project-card ${project.id === activeProjectId ? 'active' : ''}`} key={project.id}>
            <div>
              <strong>{project.name}</strong>
              <span>
                {project.audience || '対象読者は未設定'}
                {project.id === activeProjectId ? ' · 選択中' : ''}
              </span>
            </div>
            {project.id !== activeProjectId && (
              <button
                className="button secondary small"
                disabled={busy || working || activeSession}
                onClick={() => void select(project)}
              >
                このプロジェクトに切り替え
              </button>
            )}
          </article>
        ))}
      </div>
      {activeSession && (
        <p className="modal-prose">
          作成中の資料は「{active?.name}
          」に属しています。履歴やお気に入りを分けるため、この資料を閉じてから切り替えてください。
        </p>
      )}
      {!creating && (
        <div className="project-toolbar">
          <button
            className="button secondary small"
            disabled={busy || working || !active}
            onClick={() => {
              setCreating(false);
              setName(active?.name ?? '');
              setAudience(active?.audience ?? '');
              setGuidance(active?.guidance ?? '');
              setEditing(!editing);
              setNotice('');
              setError('');
            }}
          >
            {editing ? '編集を閉じる' : '選択中の設定を編集'}
          </button>
          <button className="button ghost small" disabled={busy || working} onClick={newProject}>
            <Icon name="plus" size={14} />
            プロジェクトを追加
          </button>
        </div>
      )}
      {(editing || creating) && (
        <section className="project-form">
          <h3>{creating ? '新しいプロジェクト' : 'プロジェクト設定'}</h3>
          <label className="field">
            <span>名前</span>
            <input
              value={name}
              maxLength={80}
              onChange={event => setName(event.target.value)}
              placeholder="例：ゼミ発表"
            />
          </label>
          <label className="field">
            <span>対象読者</span>
            <input
              value={audience}
              maxLength={120}
              onChange={event => setAudience(event.target.value)}
              placeholder="例：経営層、大学生、初学者"
            />
          </label>
          <label className="field">
            <span>デザイン・作成方針</span>
            <textarea
              value={guidance}
              maxLength={2000}
              rows={5}
              onChange={event => setGuidance(event.target.value)}
              placeholder="例：結論を先に示す。1枚1メッセージ。専門語は短く説明する。"
            />
            <small>新しい作成の構成相談・スライド生成で、選択したAIへこの方針を渡します。</small>
          </label>
          <label className="field">
            <span>外部のAIに送る内容</span>
            <select value={privacyMode} onChange={event => setPrivacyMode(event.target.value as 'full' | 'masked')}>
              <option value="full">そのまま送る</option>
              <option value="masked">社名・数値などを伏せ字にして送る</option>
            </select>
            <small>
              ChatGPT・Claudeなど外部のAIで作るときに適用します（ローカルLLMはこのPCで処理します）。伏せ字にすると、社名・下の語・連絡先・数値を【社名1】【数値1】のような記号に置き換えて送り、返答をこのPCで元に戻します。AIは数値を計算・比較できなくなります。内容を一切送らない場合は、作成後に「内容を送らずにデザインだけ頼む」を使います。
            </small>
          </label>
          {privacyMode === 'masked' && (
            <label className="field">
              <span>必ず伏せる語（1行に1つ）</span>
              <textarea
                value={terms}
                rows={4}
                onChange={event => setTerms(event.target.value)}
                placeholder={'例：社内のプロジェクト名\n取引先名\n製品のコード名'}
              />
              <small>
                社名（株式会社など）・メールアドレス・URL・電話番号・数値は自動で伏せます。人名や社内の固有名は、ここに入れてください。
              </small>
            </label>
          )}
          <div className="project-actions">
            <button
              className="button primary small"
              disabled={busy || working || !name.trim()}
              onClick={() => void save()}
            >
              {working ? (
                <>
                  <Spinner />
                  保存中
                </>
              ) : (
                '保存'
              )}
            </button>
            {creating && (
              <button className="button secondary small" disabled={working} onClick={() => setCreating(false)}>
                キャンセル
              </button>
            )}
          </div>
        </section>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}
      {active && !creating && (
        <TemplateSection project={active} busy={busy || working} onSaved={onTemplateSaved} onUse={onUseTemplate} />
      )}
      <p className="modal-prose">
        共有する場合は「お気に入り」からデザイン設定だけを書き出してください。書き出しファイルに資料・スライド本文・プレビュー画像・ログイン情報は入りません。
      </p>
    </Modal>
  );
}
