import type { ReactNode } from 'react';
import type { DeckVariant, DocumentInfo } from '../../shared/contracts';
import { Icon, Modal } from '../ui';

/** What goes to the AI with a request: to a monthly service directly, or into the instruction for a chat. */
export function TransmissionDialog({
  subscription,
  aiName,
  prompt,
  documents,
  onClose,
}: {
  subscription: boolean;
  aiName: string;
  prompt: string;
  documents: DocumentInfo[];
  onClose: () => void;
}) {
  return (
    <Modal title={subscription ? `${aiName}へ送信する内容` : 'AIチャットに渡す指示に含まれる内容'} onClose={onClose}>
      <p className="modal-prose">
        {subscription
          ? `構成・作成・修正のため、次の内容を接続した${aiName}のクラウドへ送信します。APIキーは使用せず、ご契約の利用権限と上限が適用されます。`
          : '次の内容を含む指示を、このPCで組み立てます。AIのチャットへの貼り付けやファイルの添付は、ご自身で行います。このアドインから自動送信はしません。'}
      </p>
      <ul className="transmission-list">
        <li>プロンプトと、その後の会話・修正指示</li>
        <li>添付資料のファイル名と、抽出した文章・表・数値（上限12万文字）</li>
        <li>構成案、生成した内容、表示モード</li>
      </ul>
      <p className="transmission-prompt">{prompt || 'プロンプトはまだ入力されていません。'}</p>
      {documents.length > 0 && (
        <ul className="transmission-list">
          {documents.map(doc => (
            <li key={doc.id}>
              {doc.name} · 抽出 {doc.characters.toLocaleString()} 文字
            </li>
          ))}
        </ul>
      )}
      <p className="modal-prose">
        {subscription
          ? '月額版もクラウドへ情報を送信します。'
          : '実際に渡す全文は「AIに渡す指示」から確認できます。月額版のチャットもクラウドへ情報を渡します。'}
        機密資料は、作り方で「伏せ字にして送る」を選ぶか、ローカルLLMで作ってください。
      </p>
      <div className="settings-actions">
        <button className="button primary" onClick={onClose}>
          確認しました
        </button>
      </div>
    </Modal>
  );
}

/** One page large, of one draft or of two side by side, with their notes and a way to revise. */
export function CompareDialog({
  index,
  current,
  pair,
  variants,
  busy,
  letterOf,
  renderSlide,
  onIndex,
  onSelect,
  onRevise,
  onClose,
}: {
  index: number;
  current: DeckVariant;
  pair: DeckVariant[];
  variants: DeckVariant[];
  busy: boolean;
  letterOf: (variant: DeckVariant) => string;
  renderSlide: (variant: DeckVariant, index: number) => ReactNode;
  onIndex: (index: number) => void;
  onSelect: (variantId: string) => void;
  onRevise: (variant: DeckVariant, index: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={variants.length > 1 ? 'スライドを比較' : 'スライドを確認'} wide onClose={onClose}>
      <div className="compare-toolbar">
        <p>
          {variants.every(item => item.render?.native)
            ? 'PowerPoint の描画を表示しています。'
            : '未書き出しの案はレイアウトの概略です。実際の PowerPoint では表示が変わる場合があります。'}
        </p>
        <div className="compare-pages">
          <button
            className="icon-button"
            aria-label="前のスライド"
            disabled={index === 0}
            onClick={() => onIndex(index - 1)}
          >
            <Icon name="chevron" size={16} />
          </button>
          <span>
            {index + 1} / {current.deck.slides.length}
          </span>
          <button
            className="icon-button"
            aria-label="次のスライド"
            disabled={index >= current.deck.slides.length - 1}
            onClick={() => onIndex(index + 1)}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
      </div>
      <div className={`compare-grid ${variants.length === 1 ? 'single' : ''}`}>
        {pair.map(variant => (
          <div key={variant.id}>
            <div className="compare-variant-label">
              <span>
                {letterOf(variant)} 案 · {variant.label}
              </span>
              <div className="preview-actions">
                {variants.length > 1 && (
                  <button
                    className={`button secondary small ${current.id === variant.id ? 'active' : ''}`}
                    onClick={() => onSelect(variant.id)}
                  >
                    {current.id === variant.id ? (
                      <>
                        <Icon name="check" size={12} />
                        選択中
                      </>
                    ) : (
                      'この案を選ぶ'
                    )}
                  </button>
                )}
                <button className="button ghost small" disabled={busy} onClick={() => onRevise(variant, index)}>
                  <Icon name="edit" size={13} />
                  修正
                </button>
              </div>
            </div>
            <div className="compare-slide">{renderSlide(variant, index)}</div>
            {variant.deck.slides[index]?.notes && (
              <details className="speaker-notes">
                <summary>発表者ノート・補足</summary>
                <p>{variant.deck.slides[index].notes}</p>
              </details>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
