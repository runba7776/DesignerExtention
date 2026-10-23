import { useMemo, useState } from 'react';
import type { AssistState, AssistTask, OpenSlideContent, ProviderKind, Theme } from '../shared/contracts';
import { compileDeck } from '../shared/layouts';
import { TEMPLATE_THEME_ID } from '../shared/themes';
import { api } from './api';
import { ChatHandoffPanel } from './ChatHandoffPanel';
import { SlidePreview } from './SlidePreview';
import { Icon } from './ui';
import {
  canReadPresentationFile,
  canReadSelection,
  deleteSlide,
  insertIntoPresentation,
  readPresentationFile,
  readSelectedSlide,
  replaceShapeTexts,
} from './office';

export type Runner = (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
const actions: { task: AssistTask; label: string; icon: string; busy: string; help: string }[] = [
  {
    task: 'slide-visualize',
    label: '図解にする',
    icon: 'compare',
    busy: '選択中のスライドを図解にしています',
    help: '文章の関係（順序・階層・比較など）を図にした1枚を作ります',
  },
  {
    task: 'slide-chart',
    label: 'グラフにする',
    icon: 'slides',
    busy: '選択中のスライドの数値をグラフにしています',
    help: 'スライドに書かれた数値だけで、編集できるグラフを作ります',
  },
  {
    task: 'slide-summarize',
    label: '文章を短くする',
    icon: 'edit',
    busy: '選択中のスライドの文章を要約しています',
    help: '配置と書式はそのままで、各図形の文章を短くします',
  },
];

/** Builds the PPTX of a one-slide result in this pane (no local renderer). */
export async function slidePptxUrl(deck: Parameters<typeof compileDeck>[0]) {
  const { deckToPptx } = await import('./hosted/pptx-renderer');
  const { blob } = await deckToPptx(deck);
  return URL.createObjectURL(blob);
}

/** Actions on the slide selected in PowerPoint. The AI receives only the text
 * of that slide; the original slide stays until the user chooses to replace it. */
export function SlideActionsPanel({
  busy,
  run,
  provider,
  onNotice,
}: {
  busy: boolean;
  run: Runner;
  provider: ProviderKind;
  onNotice: (text: string) => void;
}) {
  const [state, setState] = useState<AssistState>(),
    [source, setSource] = useState<OpenSlideContent>();
  const [matchDeck, setMatchDeck] = useState(true),
    [replace, setReplace] = useState(false),
    [consent, setConsent] = useState(false);
  const [deckTheme, setDeckTheme] = useState<{ themeId: string; customTheme: Theme }>();
  const [applied, setApplied] = useState<{ slideId: string; shapes: { id: string; before: string }[] }>();
  const result = state?.status === 'done' ? state.result : undefined;
  const preview = useMemo(() => (result?.kind === 'slide' ? compileDeck(result.deck) : undefined), [result]);
  const available = canReadSelection();

  async function themeOfOpenDeck() {
    if (!matchDeck || !canReadPresentationFile()) return undefined;
    if (deckTheme) return deckTheme;
    const { extractTemplateTheme, templateToTheme } = await import('../shared/template-theme');
    const value = {
      themeId: TEMPLATE_THEME_ID,
      customTheme: templateToTheme(await extractTemplateTheme(await readPresentationFile(), '開いている資料')),
    };
    setDeckTheme(value);
    return value;
  }
  function start(task: AssistTask, label: string) {
    if (provider === 'subscription' && !consent) {
      onNotice('選択中のスライドの文章を月額版のAIへ送ることを確認し、チェックを入れてください。');
      return;
    }
    void run(label, async signal => {
      setState(undefined);
      setApplied(undefined);
      const slide = await readSelectedSlide();
      setSource(slide);
      let theme: { themeId: string; customTheme: Theme } | undefined;
      if (task !== 'slide-summarize') {
        try {
          theme = await themeOfOpenDeck();
        } catch {
          onNotice('開いている資料の配色を読み取れなかったため、設定のテーマで作成します。');
        }
      }
      setState(
        await api<AssistState>('/assist', {
          method: 'POST',
          body: JSON.stringify({ task, slide, ...(theme ? { theme } : {}), cloudConsent: consent }),
          signal,
        }),
      );
    });
  }
  async function respond(requestId: string, response: string) {
    await run('AIの返答を検証しています', async signal => {
      setState(
        await api<AssistState>(`/assist/${requestId}/response`, {
          method: 'POST',
          body: JSON.stringify({ response }),
          signal,
        }),
      );
    });
  }
  function insert() {
    if (result?.kind !== 'slide') return;
    void run(replace ? 'スライドを置き換えています' : 'スライドを挿入しています', async signal => {
      const url = await slidePptxUrl(result.deck);
      try {
        await insertIntoPresentation(url, {
          signal,
          afterSlideId: source?.slideId,
          useDestinationTheme: result.deck.themeId === TEMPLATE_THEME_ID,
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      if (replace && source?.slideId) await deleteSlide(source.slideId);
      onNotice(
        replace
          ? '選択していたスライドを、作成したスライドに置き換えました。'
          : '選択中のスライドの後ろに、作成したスライドを挿入しました。元のスライドはそのままです。',
      );
      setState(undefined);
    });
  }
  function applySummary() {
    if (result?.kind !== 'summary' || !source?.slideId) return;
    const slideId = source.slideId,
      shapes = result.shapes;
    void run('スライドの文章を書き換えています', async () => {
      await replaceShapeTexts(
        slideId,
        shapes.map(shape => ({ id: shape.id, text: shape.text })),
      );
      setApplied({ slideId, shapes: shapes.map(shape => ({ id: shape.id, before: shape.before })) });
      setState(undefined);
      onNotice(`${shapes.length}個の図形の文章を短くしました。配置と書式は変えていません。`);
    });
  }
  function restore() {
    if (!applied) return;
    void run('元の文章に戻しています', async () => {
      await replaceShapeTexts(
        applied.slideId,
        applied.shapes.map(shape => ({ id: shape.id, text: shape.before })),
      );
      setApplied(undefined);
      onNotice('元の文章に戻しました。');
    });
  }

  return (
    <section className="slide-actions" aria-label="選択中のスライドへの操作">
      <div className="slide-actions-heading">
        <h2>選択中のスライドを作り直す</h2>
        <span>PowerPoint</span>
      </div>
      {!available ? (
        <p className="slide-actions-note">
          この操作には、選択中のスライドを読み取れるPowerPoint（Microsoft 365の最新版、またはWeb版）が必要です。
        </p>
      ) : (
        <>
          <p className="slide-actions-note">
            PowerPointでスライドを1枚選び、操作を選んでください。AIへ渡すのはそのスライドの文章だけです。
          </p>
          <div className="slide-action-buttons">
            {actions.map(action => (
              <button
                key={action.task}
                type="button"
                className="slide-action"
                disabled={busy}
                title={action.help}
                onClick={() => start(action.task, action.busy)}
              >
                <Icon name={action.icon} size={15} />
                <span>{action.label}</span>
              </button>
            ))}
          </div>
          <label className="slide-actions-option">
            <input
              type="checkbox"
              checked={matchDeck}
              disabled={busy || !canReadPresentationFile()}
              onChange={event => setMatchDeck(event.target.checked)}
            />
            開いている資料の配色と書体に合わせる
          </label>
          {provider === 'subscription' && (
            <label className="slide-actions-option">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy}
                onChange={event => setConsent(event.target.checked)}
              />
              選択中のスライドの文章を月額版のAIへ送ることに同意します
            </label>
          )}
          {provider === 'demo' && (
            <p className="slide-actions-note">
              サンプル体験ではAIを使わず、改行や句点で区切って機械的に作ります。設定で処理先を変えるとAIで作り直せます。
            </p>
          )}
        </>
      )}
      {state?.status === 'handoff' && state.handoff && (
        <ChatHandoffPanel handoff={state.handoff} busy={busy} onApply={respond} onCancel={() => setState(undefined)} />
      )}
      {result?.kind === 'slide' && preview && (
        <div className="slide-action-result">
          <div className="slide-action-preview">
            <SlidePreview document={preview} index={0} />
          </div>
          {result.slide.notes && (
            <details className="speaker-notes">
              <summary>発表者ノート</summary>
              <p>{result.slide.notes}</p>
            </details>
          )}
          <label className="slide-actions-option">
            <input
              type="checkbox"
              checked={replace}
              disabled={busy}
              onChange={event => setReplace(event.target.checked)}
            />
            元のスライドと置き換える（オフなら後ろに追加）
          </label>
          <div className="preview-actions">
            <button className="button secondary small" disabled={busy} onClick={() => setState(undefined)}>
              やめる
            </button>
            <button className="button primary small" disabled={busy} onClick={insert}>
              <Icon name="plus" size={14} />
              {replace ? '置き換える' : 'この資料に挿入'}
            </button>
          </div>
        </div>
      )}
      {result?.kind === 'summary' && (
        <div className="slide-action-result">
          <ol className="summary-diff">
            {result.shapes.map(shape => (
              <li key={shape.id}>
                <p className="before">{shape.before}</p>
                <p className="after">{shape.text}</p>
              </li>
            ))}
          </ol>
          <div className="preview-actions">
            <button className="button secondary small" disabled={busy} onClick={() => setState(undefined)}>
              やめる
            </button>
            <button className="button primary small" disabled={busy} onClick={applySummary}>
              <Icon name="check" size={14} />
              スライドに反映
            </button>
          </div>
        </div>
      )}
      {applied && (
        <p className="slide-actions-note">
          文章を書き換えました。
          <button className="text-link" disabled={busy} onClick={restore}>
            元の文章に戻す
          </button>
        </p>
      )}
    </section>
  );
}
