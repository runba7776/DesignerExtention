import type { Session } from '../core/shared/contracts';

/** The making of a presentation on the screen as one state machine: the open presentation, which draft and page
 * are selected, and the operation in progress with its outcome. Every change comes as an event, so what an
 * operation does to the screen can be read (and tested) in one place instead of across separate states.
 *
 *   idle ──started──▶ working ──finished──▶ idle
 *                       │  └──failed / aborted──▶ idle, with the error or a notice
 *                       └──updated / refreshed (the presentation the server returned)
 */
export interface FlowState {
  session?: Session;
  /** The draft shown (a variant of the session). */
  selectedVariant: string;
  /** The page the next instruction is for. */
  selectedSlide?: { id: string; index: number; variantId: string };
  /** The page shown beside its earlier version. */
  compareIndex?: number;
  /** What the operation in progress is doing, for the screen; empty when none runs. */
  busy: string;
  error: string;
  notice: string;
}

export type FlowEvent =
  /** A presentation opened (resumed, restored from history, refreshed): its first draft is shown. */
  | { type: 'opened'; session: Session }
  /** The server returned the presentation after an operation; the draft shown stays if it still exists. */
  | { type: 'updated'; session: Session }
  /** A newer copy of the presentation fetched in the background; ignored if another presentation is open now. */
  | { type: 'refreshed'; session: Session }
  /** The history entry of the open presentation was deleted. */
  | { type: 'unsaved' }
  /** Everything closed for a new presentation. */
  | { type: 'cleared' }
  | { type: 'started'; label: string }
  /** The operation moved on to another step. */
  | { type: 'working'; label: string }
  | { type: 'finished' }
  | { type: 'failed'; message: string }
  | { type: 'aborted' }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'variantSelected'; variantId: string }
  | { type: 'slideSelected'; slide?: FlowState['selectedSlide'] }
  | { type: 'compared'; index?: number };

export const initialFlow: FlowState = { selectedVariant: '', busy: '', error: '', notice: '' };
export const ABORTED_NOTICE = '待機を中止しました。サーバー側の処理が続いている場合があります。';

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'opened':
      return { ...state, session: event.session, selectedVariant: event.session.variants[0]?.id ?? '' };
    case 'updated':
      return {
        ...state,
        session: event.session,
        selectedVariant: event.session.variants.some(v => v.id === state.selectedVariant)
          ? state.selectedVariant
          : (event.session.variants[0]?.id ?? ''),
      };
    case 'refreshed':
      return state.session?.id === event.session.id ? { ...state, session: event.session } : state;
    case 'unsaved':
      return state.session
        ? { ...state, session: { ...state.session, historyId: undefined, savedAt: undefined } }
        : state;
    case 'cleared':
      return { ...initialFlow, busy: state.busy };
    case 'started':
      return { ...state, busy: event.label, error: '', notice: '' };
    case 'working':
      return { ...state, busy: event.label };
    case 'finished':
      return { ...state, busy: '' };
    case 'failed':
    case 'error':
      return { ...state, error: event.message };
    case 'aborted':
      return { ...state, notice: ABORTED_NOTICE };
    case 'notice':
      return { ...state, notice: event.message };
    case 'variantSelected':
      return { ...state, selectedVariant: event.variantId };
    case 'slideSelected':
      return { ...state, selectedSlide: event.slide };
    case 'compared':
      return { ...state, compareIndex: event.index };
  }
}

/** Where the making stands, for the screen: working while an operation runs, else the presentation's own phase. */
export function flowPhase(state: FlowState): 'working' | 'empty' | Session['phase'] {
  return state.busy ? 'working' : state.session ? state.session.phase : 'empty';
}
