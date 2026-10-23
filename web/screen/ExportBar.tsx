import type { RenderResult } from '../../shared/contracts';
import { Icon } from '../ui';

/** Making the PowerPoint file, then saving it, opening it, or inserting it into the open presentation. */
export function ExportBar({
  render,
  nativeAvailable,
  officeInsert,
  blanksLeft,
  busy,
  onRender,
  onOpen,
  onInsert,
}: {
  render?: RenderResult;
  nativeAvailable: boolean;
  /** Inside PowerPoint: the slides can be inserted into the open presentation. */
  officeInsert: boolean;
  blanksLeft: number;
  busy: boolean;
  onRender: () => void;
  onOpen: () => void;
  onInsert: () => void;
}) {
  return (
    <div className="export-bar">
      <p>
        {render?.native
          ? 'PowerPoint で図形やテキストを編集できます。'
          : '表示は概略です。ファイル作成後、PowerPoint で実際の表示を確認できます。'}
        {blanksLeft > 0 && <strong className="blank-left"> 記入欄が{blanksLeft}項目残っています。</strong>}
      </p>
      <div className="preview-actions">
        {!render ? (
          <button className="button primary" disabled={busy} onClick={onRender}>
            <Icon name="slides" size={16} />
            PowerPoint ファイルを作成
          </button>
        ) : (
          <>
            <a className="button secondary" href={render.pptxUrl} download>
              <Icon name="download" size={15} />
              保存
            </a>
            {nativeAvailable && (
              <button className={`button ${officeInsert ? 'secondary' : 'primary'}`} disabled={busy} onClick={onOpen}>
                <Icon name="slides" size={16} />
                {officeInsert ? '別ファイルで開く' : 'PowerPoint で開く'}
              </button>
            )}
            {officeInsert && (
              <button className="button primary" disabled={busy} onClick={onInsert}>
                <Icon name="plus" size={16} />
                この資料に挿入
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** With documents attached: a list of sources at the end of the file, and the sources of every page to check. */
export function SourceExport({
  referencesSlide,
  busy,
  onReferences,
  onSources,
}: {
  referencesSlide: boolean;
  busy: boolean;
  onReferences: (enabled: boolean) => void;
  onSources: () => void;
}) {
  return (
    <div className="source-export">
      <label>
        <input
          type="checkbox"
          checked={referencesSlide}
          disabled={busy}
          onChange={event => onReferences(event.target.checked)}
        />
        書き出すファイルの末尾に「出典一覧」を付ける
      </label>
      <button className="button ghost small" onClick={onSources}>
        出典と根拠を確認
      </button>
    </div>
  );
}
