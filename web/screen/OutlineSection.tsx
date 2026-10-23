import type { Outline } from '../../shared/contracts';
import { OpenFactsForm } from '../BlankFields';
import { Icon } from '../ui';

/** The outline to check before the pages are made: its pages, the facts it still needs, and the button to make it. */
export function OutlineSection({
  outline,
  facts,
  disabled,
  canGenerate,
  onFacts,
  onGenerate,
}: {
  outline: Outline;
  facts: Record<string, string>;
  disabled: boolean;
  /** False while a stopped creation is offered to be resumed instead. */
  canGenerate: boolean;
  onFacts: (values: Record<string, string>) => void;
  onGenerate: () => void;
}) {
  return (
    <section className="outline" aria-label="構成案">
      <div className="outline-heading">
        <h2>スライドの構成案</h2>
        <span>{outline.slides.length} 枚</span>
      </div>
      {outline.assumptions.length > 0 && <p className="outline-description">{outline.assumptions.join(' / ')}</p>}
      {!!outline.openFacts?.length && (
        <OpenFactsForm facts={outline.openFacts} values={facts} disabled={disabled} onChange={onFacts} />
      )}
      {outline.inputBrief && (
        <details className="input-brief" open>
          <summary>確認する条件</summary>
          <p>{outline.inputBrief}</p>
          <small>
            原文は会話に保持します。この条件と構成を確認してから作成してください。作成時は整理した条件を使って送信量を減らします。
          </small>
        </details>
      )}
      {outline.slides.map((slide, index) => (
        <div className="outline-row" key={slide.id}>
          <span className="outline-number">{String(index + 1).padStart(2, '0')}</span>
          <div>
            <h3>{slide.title}</h3>
            <p>{slide.intent}</p>
            {slide.keyPoints.length > 0 && <p>{slide.keyPoints.join(' · ')}</p>}
          </div>
        </div>
      ))}
      {canGenerate && (
        <div className="outline-actions">
          <button className="button primary" disabled={disabled} onClick={onGenerate}>
            <Icon name="slides" size={16} />
            この構成で作成
          </button>
        </div>
      )}
    </section>
  );
}
