import { useRef, useState } from 'react';
import type { ProjectProfile, TemplateTheme } from '../shared/contracts';
import { templateToTheme } from '../shared/template-style';
import { api } from './api';
import { Icon, Spinner } from './ui';
import { canReadPresentationFile, readPresentationFile } from './office';

/** The project's company template: palette and font names read from a
 * PowerPoint theme. Slide text, images and logos are not stored. */
export function TemplateSection({
  project,
  busy,
  onSaved,
  onUse,
}: {
  project: ProjectProfile;
  busy: boolean;
  onSaved: (project: ProjectProfile) => Promise<void>;
  onUse: () => Promise<void>;
}) {
  const [working, setWorking] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const template = project.template,
    theme = template ? templateToTheme(template) : undefined;
  async function save(read: () => Promise<TemplateTheme>, label: string) {
    setWorking(label);
    setError('');
    setNotice('');
    try {
      const value = await read();
      const saved = await api<ProjectProfile>(`/projects/${project.id}/template`, {
        method: 'PUT',
        body: JSON.stringify({ template: value }),
      });
      await onSaved(saved);
      setNotice(`「${value.name}」の配色と書体を登録しました。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'テンプレートを読み込めませんでした。');
    } finally {
      setWorking('');
      if (input.current) input.current.value = '';
    }
  }
  const fromFile = (file?: File) => {
    if (!file) return;
    if (!/\.(pptx|potx)$/i.test(file.name)) {
      setError('.pptx または .potx を選んでください。');
      return;
    }
    if (file.size > 60 * 1024 * 1024) {
      setError('ファイルが大きすぎます（60 MBまで）。');
      return;
    }
    void save(async () => {
      const { extractTemplateTheme } = await import('../shared/template-theme');
      return extractTemplateTheme(new Uint8Array(await file.arrayBuffer()), file.name);
    }, 'file');
  };
  const fromOpenDeck = () =>
    void save(async () => {
      const { extractTemplateTheme } = await import('../shared/template-theme');
      return extractTemplateTheme(await readPresentationFile(), '開いている資料');
    }, 'deck');
  async function remove() {
    setWorking('remove');
    setError('');
    try {
      await onSaved(await api<ProjectProfile>(`/projects/${project.id}/template`, { method: 'DELETE' }));
      setNotice('会社テンプレートの登録を解除しました。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '解除できませんでした。');
    } finally {
      setWorking('');
    }
  }
  return (
    <section className="template-section" aria-label="会社テンプレート">
      <h3>会社テンプレート</h3>
      <p className="modal-prose">
        社内のPowerPointテンプレートから配色と書体を読み取り、このプロジェクトの資料・図解をその見た目で作ります。読み取るのは色と書体の名前だけで、スライドの文章・画像・ロゴは保存しません。お気に入りの「共有用に書き出す」に含まれるので、チームで同じテンプレートを使えます。
      </p>
      {template && theme ? (
        <div className="template-card">
          <div className="template-swatches" aria-label="テンプレートの色">
            {[
              template.colors.dk1,
              template.colors.lt1,
              template.colors.accent1,
              template.colors.accent2,
              template.colors.accent3,
              template.colors.accent4,
              template.colors.accent5,
              template.colors.accent6,
            ].map((color, i) => (
              <span key={i} style={{ background: color }} title={color} />
            ))}
          </div>
          <div className="template-meta">
            <strong>{template.name}</strong>
            <span>
              見出し：{theme.headingFont} ／ 本文：{theme.font}
            </span>
            <span>
              読み込み元：{template.source} · {new Date(template.importedAt).toLocaleDateString('ja-JP')}
            </span>
          </div>
          <div className="project-actions">
            <button className="button primary small" disabled={busy || !!working} onClick={() => void onUse()}>
              このテンプレートで作成する
            </button>
            <button className="button ghost small" disabled={busy || !!working} onClick={() => void remove()}>
              {working === 'remove' ? <Spinner /> : '登録を解除'}
            </button>
          </div>
        </div>
      ) : (
        <p className="source-empty">未登録です。</p>
      )}
      <div className="project-actions">
        {canReadPresentationFile() && (
          <button className="button secondary small" disabled={busy || !!working} onClick={fromOpenDeck}>
            {working === 'deck' ? (
              <>
                <Spinner />
                読み取り中
              </>
            ) : (
              <>
                <Icon name="slides" size={13} />
                開いている資料から読み込む
              </>
            )}
          </button>
        )}
        <button className="button secondary small" disabled={busy || !!working} onClick={() => input.current?.click()}>
          {working === 'file' ? (
            <>
              <Spinner />
              読み取り中
            </>
          ) : (
            <>
              <Icon name="upload" size={13} />
              .pptx / .potx を選ぶ
            </>
          )}
        </button>
        <input
          ref={input}
          type="file"
          accept=".pptx,.potx"
          className="sr-only"
          tabIndex={-1}
          onChange={event => fromFile(event.target.files?.[0])}
        />
      </div>
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
    </section>
  );
}
