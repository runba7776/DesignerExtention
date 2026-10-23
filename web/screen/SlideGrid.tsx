import type { ReactNode } from 'react';
import type { DeckVariant } from '../../shared/contracts';
import { Icon } from '../ui';

/** What can be done to one page from its caption. */
export interface SlideActions {
  onExpand: (index: number) => void;
  onLayout: (variantId: string, index: number) => void;
  /** Only when the page can be looked at as a picture (a monthly plan, AI design). */
  onRefine?: (variantId: string, slideId: string) => void;
  onChart: (variantId: string, index: number) => void;
  onSources: (variantId: string, slideId: string) => void;
  onSaveDesign: (variantId: string, slideId: string, index: number) => void;
  onRevise: (variant: DeckVariant, index: number) => void;
}

/** The pages of the chosen draft, side by side with a second draft when there is one, each with its actions. */
export function SlideGrid({
  current,
  pair,
  compared,
  busy,
  renderSlide,
  actions,
}: {
  current: DeckVariant;
  pair: DeckVariant[];
  /** Two or more drafts: the chosen one is marked. */
  compared: boolean;
  busy: boolean;
  renderSlide: (variant: DeckVariant, index: number) => ReactNode;
  actions: SlideActions;
}) {
  return (
    <div className="slide-grid">
      {current.deck.slides.map((_, index) => (
        <div className={`slide-row ${compared ? 'paired' : ''}`} key={index}>
          {pair.map(variant => {
            const slide = variant.deck.slides[index];
            if (!slide) return null;
            return (
              <div className="slide-card" key={variant.id}>
                <button
                  type="button"
                  className={`slide-preview ${compared && variant.id === current.id ? 'selected' : ''}`}
                  aria-label={`${variant.label}、スライド ${index + 1}：${slide.title}を拡大`}
                  onClick={() => actions.onExpand(index)}
                >
                  {renderSlide(variant, index)}
                  <span className="expand-overlay">
                    <Icon name="expand" size={15} />
                  </span>
                </button>
                <div className="slide-caption">
                  <span>
                    <strong>{String(index + 1).padStart(2, '0')}</strong>
                    <span className="slide-title">{slide.title}</span>
                  </span>
                  <button
                    type="button"
                    className="button ghost small"
                    disabled={busy}
                    aria-label={`${variant.label}のスライド ${index + 1}の構図を変更`}
                    onClick={() => actions.onLayout(variant.id, index)}
                  >
                    構図
                  </button>
                  {actions.onRefine && (
                    <button
                      type="button"
                      className="button ghost small"
                      disabled={busy}
                      title="このページを画像でAIに見直させ、気づいた点を直して作り直します（直す前に戻せます）"
                      aria-label={`${variant.label}のスライド ${index + 1}を画像で見直して作り直す`}
                      onClick={() => actions.onRefine?.(variant.id, slide.id)}
                    >
                      見直す
                    </button>
                  )}
                  {slide.chart && (
                    <button
                      type="button"
                      className="button ghost small"
                      disabled={busy}
                      aria-label={`${variant.label}のスライド ${index + 1}のグラフを変更`}
                      onClick={() => actions.onChart(variant.id, index)}
                    >
                      グラフ
                    </button>
                  )}
                  {slide.sources.length > 0 && (
                    <button
                      type="button"
                      className="button ghost small source-button"
                      aria-label={`${variant.label}のスライド ${index + 1}の出典と根拠を確認`}
                      onClick={() => actions.onSources(variant.id, slide.id)}
                    >
                      出典 {slide.sources.length}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={`${variant.label}のスライド ${index + 1}のデザインを保存`}
                    onClick={() => actions.onSaveDesign(variant.id, slide.id, index)}
                  >
                    <Icon name="star" size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={`${variant.label}のスライド ${index + 1}を修正`}
                    onClick={() => actions.onRevise(variant, index)}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
