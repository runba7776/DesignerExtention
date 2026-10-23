// The state the engine keeps for each open presentation, and the drafts of work in progress.
import type {
  AiTarget,
  SendScope,
  ChatService,
  DeckSpec,
  DeckVariant,
  DesignEntry,
  Outline,
  ReviewHint,
  Session,
  Settings,
  SlideSpec,
  SubscriptionService,
  ProjectProfile,
  RefreshPlan,
} from '../../shared/contracts.js';
import type { ParsedDocument } from '../document-model.js';
import type { ModelTask } from '../prompts.js';
import type { Showcase } from '../showcase.js';
import { Masker, type ShareLevel, type SlotContent } from '../../shared/confidential.js';

/** force: the user chose to finish with smaller text (no AI). */
export interface FitDraft {
  deck: DeckSpec;
  batchSize: number;
  singleFailures: number;
  force?: boolean;
}

/** Picks of the three directions and ratings of the decks made from them (see remember). */
export const PROPOSAL_CHOICES_FILE = 'proposal-choices.jsonl';

/** ceiling: after a reply was cut or broken, the batch size that failed is not tried again. */
export interface GenerationDraft {
  key: string;
  slides: SlideSpec[];
  themeId: string;
  batchSize: number;
  ceiling?: number;
  singleFailures: number;
  compact: boolean;
  fit?: FitDraft;
  /** Valid pages that came after a rejected page; they join the deck once the gap before them is filled. */
  pending?: Record<string, SlideSpec>;
  /** The drawn pages (PNG, base64), kept for the look at them after the deck is shown. */
  shots?: Record<string, string>;
}

export interface RevisionDraft {
  variantId: string;
  slideId: string;
  instruction: string;
  title: string;
  base: string;
  failures: number;
  compact: boolean;
  result?: SlideSpec;
  fit?: FitDraft;
}

export interface RepairOperation {
  remaining: number;
  startedCalls: number;
  next?: { task: ModelTask; code: string; detail?: string };
}

/** full: the user chose the self-contained instruction for this request. */
export interface DesignDraft {
  variantId: string;
  level: ShareLevel;
  topic?: string;
  ids: string[];
  done: SlideSpec[];
  contents: Record<string, SlotContent>;
  base: string;
}

export interface ChatDraft {
  design?: DesignDraft;
  full?: boolean;
  task: Exclude<ModelTask, 'review'> | 'design';
  payload: any;
  messages?: Session['messages'];
  purpose?: 'generate' | 'revise' | 'alternate' | 'design';
  service?: ChatService;
  summaryDeck?: DeckSpec;
  variantBase?: string;
  variantId?: string;
  instruction?: string;
  targetIds?: string[];
}

/** A refresh compared with new documents, waiting for the user's review. base pins the deck it was made from. */
export interface RefreshDraft {
  plan: RefreshPlan;
  documents: ParsedDocument[];
  base: string;
}

/** One AI writing for this session besides (or instead of) its own provider: the AI
 * chosen at creation, another draft, or a design-only request. Each keeps its own
 * call count and retry budget, so AIs can work at the same time. */
export interface AiRun {
  target: AiTarget;
  label: string;
  repair: RepairOperation;
  calls: number;
  notes: string[];
}

/** targets: the AIs chosen at creation (the first writes the main draft); bindings: the
 * monthly accounts connected at that moment; extras: other drafts written alongside. */
export interface SessionState {
  showcase?: Showcase;
  targets?: AiTarget[];
  sendScope?: SendScope;
  polish?: {
    shots: Record<string, string>;
    outline: Outline;
    compact: boolean;
    variantId: string;
    findings: ReviewHint[];
  };
  previewSeeds?: { outline: string; slides: SlideSpec[]; shots: Record<string, string> }[];
  bindings?: Partial<Record<SubscriptionService, string>>;
  extras?: { started: boolean; ready: DeckVariant[]; failed: string[] };
  refresh?: RefreshDraft;
  masker?: Masker;
  oneShot?: boolean;
  session: Session;
  documents: ParsedDocument[];
  settings: Settings;
  project: ProjectProfile;
  createdAt: number;
  busy: boolean;
  subscriptionBinding?: string;
  historyRevision?: number;
  design?: DesignEntry;
  pendingPlan?: { messages: Session['messages']; failures: number };
  draft?: GenerationDraft;
  revision?: RevisionDraft;
  repairOperation?: RepairOperation;
  chat?: ChatDraft;
}

export const MAX_VARIANTS = 3;

/** AI calls: per operation (creating a deck, one revision) and per presentation. */
export const OPERATION_CALL_LIMIT = 12,
  SESSION_CALL_LIMIT = 40;
