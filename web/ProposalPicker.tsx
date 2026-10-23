import { useMemo } from 'react';
import type { AiPalette, ProposalSet } from '../shared/contracts';
import { compileDeck } from '../shared/layouts';
import { SlidePreview } from './SlidePreview';
import { Icon } from './ui';

const percent = (value: number) => `${Math.round(value * 100)}%`;
const swatches = (palette: AiPalette) =>
  [palette.background, palette.surface, palette.text, palette.accent, palette.accent2].filter(
    (color): color is string => !!color,
  );

/** The directions the AI offered for the first outline: each with where it fits, the AI's
 * recommendation, and samples (the cover and its most telling page) made one card after another.
 * Shown in full until one is picked; afterwards folded, so another direction can still be taken. */
export function ProposalPicker({
  set,
  busy,
  folded,
  previewing,
  samples: expected = true,
  onChoose,
}: {
  set: ProposalSet;
  busy: boolean;
  folded: boolean;
  previewing?: number;
  samples?: boolean;
  onChoose: (index: number) => void;
}) {
  const samples = useMemo(
    () => set.items.map(item => (item.preview ? compileDeck(item.preview) : undefined)),
    [set.items],
  );
  const cards = (
    <div className="proposal-grid">
      {set.items.map((item, index) => {
        const outline = item.outline,
          palette = outline.palette,
          chosen = set.chosen === index,
          recommended = set.recommended === index,
          sample = samples[index];
        return (
          <article
            className={`proposal-card${chosen ? ' chosen' : ''}${recommended ? ' recommended' : ''}`}
            key={index}
            aria-label={`${String.fromCharCode(65 + index)}案：${item.direction}`}
          >
            <div className="proposal-title">
              <span className="proposal-letter">{String.fromCharCode(65 + index)}</span>
              <h3>{item.direction}</h3>
              {recommended && (
                <span className="proposal-badge">
                  <Icon name="star" size={11} />
                  AIのおすすめ
                </span>
              )}
              {set.fresh === index && (
                <span
                  className="proposal-badge fresh"
                  title="これまでの選び方から一番遠い方向です。選び方が偏らないよう、2番目に置いています。"
                >
                  いつもと違う方向
                </span>
              )}
            </div>
            <p className="proposal-typicality" title="同じ依頼を受けた作り手が、この方向を選ぶ割合のAIによる見積もり">
              ありがちさ {percent(item.typicality)}
              {item.suitedFor && <> · 向いている場面：{item.suitedFor}</>}
            </p>
            {sample ? (
              <div className="proposal-samples" aria-label="見本（表紙と特徴的なページ）">
                {sample.slides.map((_, i) => (
                  <div className="proposal-sample" key={i}>
                    <SlidePreview document={sample} index={i} />
                  </div>
                ))}
              </div>
            ) : (
              expected && (
                <div className="proposal-samples pending" role="status">
                  {item.previewError ? (
                    <small>{item.previewError}</small>
                  ) : previewing === index ? (
                    <small>見本を作っています…</small>
                  ) : (
                    <small>見本を待っています</small>
                  )}
                </div>
              )
            )}
            {item.difference && <p className="proposal-difference">{item.difference}</p>}
            {palette && (
              <div className="proposal-palette">
                <span className="proposal-swatches" aria-hidden="true">
                  {swatches(palette).map((color, i) => (
                    <i key={i} style={{ background: color }} />
                  ))}
                </span>
                <small>
                  {palette.name}
                  {palette.headingFont ? ` · ${palette.headingFont}` : ''}
                  {palette.bodyFont && palette.bodyFont !== palette.headingFont ? ` / ${palette.bodyFont}` : ''}
                </small>
              </div>
            )}
            {outline.visualStyle && <p className="proposal-style">{outline.visualStyle}</p>}
            <ol className="proposal-slides">
              {outline.slides.map(slide => (
                <li key={slide.id}>{slide.title}</li>
              ))}
            </ol>
            <button
              className={`button small ${chosen ? 'secondary' : 'primary'}`}
              disabled={busy || chosen}
              onClick={() => onChoose(index)}
            >
              {chosen ? (
                <>
                  <Icon name="check" size={12} />
                  選択中
                </>
              ) : (
                'この案で進める'
              )}
            </button>
          </article>
        );
      })}
    </div>
  );
  const why = (
    <>
      {set.recommended !== undefined && set.reason && (
        <p className="proposal-reason">
          <strong>AIのおすすめは{String.fromCharCode(65 + set.recommended)}案</strong>：{set.reason}
        </p>
      )}
      {set.orderNote && <p className="proposal-order">{set.orderNote}</p>}
    </>
  );
  const compared = set.candidates.length > 0 && (
    <p className="proposal-candidates">
      AIが比べた方向：{set.candidates.map(c => `${c.direction}（${percent(c.typicality)}）`).join('、')}
    </p>
  );
  if (folded)
    return (
      <details className="proposals folded">
        <summary>ほかの構成案に切り替える（{set.items.length}案）</summary>
        {why}
        {cards}
        {compared}
      </details>
    );
  return (
    <section className="proposals" aria-label="構成案の候補">
      <div className="outline-heading">
        <h2>方向の違う構成案</h2>
        <span>{set.items.length} 案</span>
      </div>
      <p className="outline-description">
        「ありがちさ」は、同じ依頼を受けた作り手がその方向を選ぶ割合を、AIが見積もった値です。選ぶときは、読み手と目的に合うかを先に見てください。選んだ案は、次の画面で見出しや順番を直せます。
      </p>
      {why}
      {cards}
      {compared}
    </section>
  );
}
