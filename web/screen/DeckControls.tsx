import type { DeckSpec, DeckVariant } from '../../shared/contracts';
import { themes, TEMPLATE_THEME_ID } from '../../shared/themes';
import { AI_THEME_ID } from '../../shared/ai-theme';
import { typographyProfiles } from '../../shared/typography';
import { Icon } from '../ui';

/** With two or more drafts: which two are shown side by side, and which one is chosen. */
export function VariantHeadings({
  variants,
  pair,
  currentId,
  busy,
  letterOf,
  onPair,
  onSelect,
}: {
  variants: DeckVariant[];
  pair: DeckVariant[];
  currentId?: string;
  busy: boolean;
  letterOf: (variant: DeckVariant) => string;
  onPair: (ids: string[]) => void;
  onSelect: (variantId: string) => void;
}) {
  return (
    <div className="variant-headings">
      {pair.map((variant, index) => (
        <div className="variant-label" key={variant.id}>
          <span>
            {variants.length > 2 ? (
              <select
                className="variant-pick"
                aria-label={`${index + 1}列目に表示する案`}
                value={variant.id}
                disabled={busy}
                onChange={event =>
                  onPair(index ? [pair[0].id, event.target.value] : [event.target.value, pair[1]?.id ?? ''])
                }
              >
                {variants.map(v => (
                  <option key={v.id} value={v.id}>
                    {letterOf(v)} 案 · {v.label}
                  </option>
                ))}
              </select>
            ) : (
              <>
                {letterOf(variant)} 案<span className="variant-title">{variant.label}</span>
              </>
            )}
          </span>
          <button
            className={`button small ${currentId === variant.id ? 'secondary active' : 'secondary'}`}
            aria-pressed={currentId === variant.id}
            disabled={busy}
            onClick={() => onSelect(variant.id)}
          >
            {currentId === variant.id ? (
              <>
                <Icon name="check" size={12} />
                選択中
              </>
            ) : (
              'この案を選ぶ'
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

/** The chosen draft's theme and fonts, and saving its design as a favourite (no AI). */
export function OutputStyle({
  deck,
  hasTemplate,
  busy,
  onTheme,
  onSaveDesign,
}: {
  deck?: DeckSpec;
  hasTemplate: boolean;
  busy: boolean;
  onTheme: (themeId: string, typographyId?: string) => void;
  onSaveDesign: () => void;
}) {
  return (
    <div className="output-style">
      <label className="output-theme">
        選択中の案のテーマ
        <select
          aria-label="作成した資料のテーマ"
          value={deck?.themeId}
          disabled={busy}
          onChange={event => onTheme(event.target.value)}
        >
          {(hasTemplate || deck?.themeId === TEMPLATE_THEME_ID) && (
            <option value={TEMPLATE_THEME_ID}>会社テンプレート</option>
          )}
          {deck?.aiTheme && <option value={AI_THEME_ID}>AIが決めた配色</option>}
          {Object.entries(themes).map(([id, theme]) => (
            <option key={id} value={id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      <label className="output-theme">
        書体
        <select
          aria-label="作成した資料の書体"
          value={deck?.typographyId ?? 'auto'}
          disabled={busy}
          onChange={event => deck && onTheme(deck.themeId, event.target.value)}
        >
          <option value="auto">テーマに合わせる</option>
          {Object.entries(typographyProfiles).map(([id, p]) => (
            <option key={id} value={id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button className="button secondary small" disabled={busy} onClick={onSaveDesign}>
        <Icon name="star" size={13} />
        デザインを保存
      </button>
      <small>見た目の変更・デザインの保存にAIを呼び出しません。</small>
      {deck?.typographyId && (
        <p className="font-description">
          {typographyProfiles[deck.typographyId as keyof typeof typographyProfiles]?.description}
        </p>
      )}
    </div>
  );
}
