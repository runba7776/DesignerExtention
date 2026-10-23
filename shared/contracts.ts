/** Content, layout and provider contracts are independent of any use case. */
export type OutputMode = 'presentation' | 'reading';
/** claude is retained only to read/migrate older settings; paid API calls are disabled. */
export type ProviderKind = 'subscription' | 'chat' | 'claude' | 'local' | 'demo';
export type SubscriptionService = 'chatgpt' | 'claude';
export interface SubscriptionAccount { id:string; label:string; email?:string; active:boolean }
export interface SubscriptionModel { id:string; name:string }
export interface SubscriptionConnection {
  service:SubscriptionService;
  state:'disconnected'|'pending'|'connected'|'permission_required'|'limited'|'unavailable'|'error';
  message:string; account?:SubscriptionAccount; accounts:SubscriptionAccount[];
  models:SubscriptionModel[]; canGenerate:boolean; canConnect:boolean;
  pendingExpiresAt?:string; documentationUrl?:string;
}
export interface SubscriptionStatus { services:SubscriptionConnection[] }
export type ChatService = 'chatgpt' | 'claude' | 'gemini' | 'copilot' | 'other';
/** An AI that writes slides by itself, without copy and paste: a connected monthly
 * service or this PC's local LLM. Several can be chosen for one creation. */
export type AiTarget = 'claude' | 'chatgpt' | 'local';
/** What leaves this PC for a cloud AI in one creation: everything, names and numbers
 * masked, or only the design skeleton (the content is written by the local LLM). */
export type SendScope = 'full' | 'masked' | 'design';
export const APP_VERSION = '0.13.0';
export const MAX_PROMPT_CHARACTERS = 60_000;
export const MAX_SLIDES = 30;
export const GENERATION_BATCH_SIZE = 6;
export const READING_BATCH_SIZE = 4;
/** Manual chat handoff: fewer, larger batches so a typical deck needs one paste. */
export const CHAT_GENERATION_BATCH_SIZE = 10;
export const CHAT_READING_BATCH_SIZE = 8;
/** AI-designed slides carry every element's position, so a reply holds fewer pages. */
export const FREE_CHAT_BATCH_SIZE = 4;
export const FREE_GENERATION_BATCH_SIZE = 3;
export const GENERATION_OUTPUT_TOKENS = 16_000;
export const PLAN_OUTPUT_TOKENS = 16_000;
export const PLAN_RETRY_OUTPUT_TOKENS = 20_000;
/** Directions offered at the first outline when the AI designs the slides (see ProposalSet). */
export const OUTLINE_PROPOSALS = 3;
/** Smallest text the HTML method accepts (px = pt on the 960x540 slide): body text, and notes the AI marks
 * as captions (data-role="caption"). Text a little smaller is made larger by the app when the page still fits. */
export const MIN_TEXT_SIZE = {presentation: {body: 16, caption: 12}, reading: {body: 12, caption: 10}} as const;
/** Drawn pages shown to the AI in one look, and the answer budget of that look. */
export const REVIEW_BATCH_SIZE = 4;
export const REVIEW_OUTPUT_TOKENS = 4_000;
/** Colors and fonts read from a company PowerPoint theme. Slide text, images and
 * masters are not copied; only the reusable style is stored with a project. */
export interface TemplateTheme { name:string; source:string; colors:{dk1:string;lt1:string;dk2:string;lt2:string;accent1:string;accent2:string;accent3:string;accent4:string;accent5:string;accent6:string}; fonts:{major:string;minor:string;majorEa?:string;minorEa?:string}; importedAt:string }
/** What a project lets a cloud AI see when it writes content: everything, or masked
 * company names, terms, contacts and numbers (restored on this PC). */
export interface ProjectPrivacy { mode:'full'|'masked'; terms:string[] }
export interface ProjectProfile {id:string;name:string;audience:string;guidance:string;createdAt:string;updatedAt:string;template?:TemplateTheme;privacy?:ProjectPrivacy}
/** A ChatGPT/Claude project the user prepared with the AI kit (kitVersion). */
export interface ChatProjectLink { url:string; kitVersion:string }
export interface Settings { provider: ProviderKind; model: string; endpoint?: string; mode: OutputMode; hasKey?: boolean; apiKey?: string; themeId?: string; typographyId?:string; slideCount?: number | 'auto'; autoRepair?:boolean; editorialGuide?:boolean; outlineProposals?:boolean; proposalPreviews?:boolean; visualReview?:boolean; chatService?:ChatService; subscriptionService?:SubscriptionService; preferredDesignId?:string; activeProjectId?:string; chatProjects?:Partial<Record<ChatService,ChatProjectLink>>; chatOpenIn?:'browser'|'app'; designMode?:DesignMode; localModel?:string; targets?:AiTarget[] }
/** free: the AI designs each slide (positions, shapes, colours). template: the AI
 * picks one of the registered layouts and the app places everything. */
/** free: the AI places elements by coordinates (JSON). html (trial): the AI writes each page as HTML/CSS and
 * the app reads the browser's layout. template: the app's layout catalogue. */
export type DesignMode = 'free'|'template'|'html';
export interface AppStatus { provider: ProviderKind; model: string; hasKey: boolean; nativeAvailable: boolean; version: string; apiFree?:boolean; hosted?:boolean }
export interface DocumentInfo { id: string; name: string; kind: string; units: number; characters: number; warnings: string[] }
export interface SourceRef { documentId: string; documentName?: string; locator: string; quote?: string }
export type IconId = 'idea'|'document'|'chart'|'people'|'globe'|'shield'|'calculator'|'clock'|'target'|'building'|'coins'|'search'
  |'laptop'|'smartphone'|'server'|'database'|'cloud'|'network'|'code'|'chip'
  |'book'|'graduation'|'flask'|'atom'|'geometry'|'puzzle'
  |'leaf'|'recycle'|'energy'|'water'|'sun'|'heart'|'medical'|'accessibility'
  |'factory'|'tools'|'truck'|'train'|'plane'|'shopping'|'package'
  |'message'|'mail'|'camera'|'pin'|'calendar'|'flag'|'balance'
  |'person'|'family'|'child'|'elder'|'home'|'school'|'food'|'walk'
  |'warning'|'info'|'question'|'checklist'|'bell'|'megaphone'|'phone'|'pencil'
  |'fire'|'umbrella'|'exit'|'map'|'bus'|'car'|'bicycle'|'trash'|'key'|'lock'|'star';
/** refs are 1-based indexes into the slide's sources, shown as citation markers. */
export interface SlideItem { label: string; description?: string; value?: string; parent?: number; icon?:IconId|'none'; refs?:number[] }
export type ChartType = 'bar'|'column'|'line'|'pie'|'doughnut'|'stackedBar'|'stackedColumn'|'waterfall';
export interface ChartSpec { type: ChartType; categories: string[]; series: { name: string; values: number[] }[]; unit?: string; caption?: string }
export interface DiagramSpec { type: 'process' | 'cycle' | 'hierarchy' | 'list'; items: SlideItem[] }
export interface TableSpec { headers: string[]; rows: string[][] }
export interface SlideSpec {
  id: string; title: string; layoutId: string; headline?: string; body?: string;
  items: SlideItem[]; chart?: ChartSpec; diagram?: DiagramSpec; table?: TableSpec;
  equation?: { text: string; explanation?: string }; notes: string; sources: SourceRef[];
  /** An AI-designed slide: drawn from these elements instead of a layout. */
  design?: FreeDesign;
}
/** Colours are theme tokens (bg, ink, muted, accent, accent2, surface, rule, negative, onAccent) or #RRGGBB. */
export type FreeShape = 'rect'|'roundRect'|'ellipse'|'triangle'|'arrow'|'leftArrow'|'upArrow'|'downArrow'|'chevron'|'pentagon'|'hexagon'|'diamond'|'parallelogram'|'trapezoid'|'octagon'|'donut';
export type FreeElement =
  | {t:'text'; x:number; y:number; w:number; h:number; text:string; size:number; color?:string; bold?:boolean; italic?:boolean; align?:'l'|'c'|'r'; va?:'t'|'m'|'b'; role?:'title'|'heading'|'body'|'number'|'caption'; refs?:number[]; lh?:number; exact?:boolean; runs?:TextRun[]; font?:string; fontFarEast?:string}
  | {t:'box'; x:number; y:number; w:number; h:number; shape?:FreeShape; fill?:string; line?:string; lw?:number; op?:number; r?:number; rot?:number}
  | {t:'line'; x1:number; y1:number; x2:number; y2:number; color?:string; lw?:number; dash?:boolean; arrow?:'none'|'end'|'start'|'both'}
  | {t:'icon'; icon:IconId; x:number; y:number; size:number; color?:string}
  | {t:'chart'; x:number; y:number; w:number; h:number; chart:ChartSpec}
  | {t:'table'; x:number; y:number; w:number; h:number; headers:string[]; rows:string[][]; size?:number}
  /** Vector artwork converted from an AI-written HTML slide (never accepted from AI JSON). */
  | {t:'svg'; x:number; y:number; w:number; h:number; svg:string};
export interface FreeDesign { background?:string; elements:FreeElement[] }
/** Part of an exact text (s: start, l: length, in UTF-16 units) with its own colour or weight. */
export interface TextRun { s:number; l:number; color?:string; bold?:boolean; italic?:boolean }
/** themeId 'template' renders with customTheme, a copy of the project's company template. */
/** themeId 'ai' renders with aiTheme, the palette the AI chose; it is kept when another theme is tried, so the deck can switch back. */
export interface DeckSpec { id: string; title: string; mode: OutputMode; themeId: string; typographyId?:string; customTheme?:Theme; aiTheme?:Theme; referencesSlide?:boolean; pageNumbers?:boolean; slides: SlideSpec[] }
export interface OutlineSlide { id: string; title: string; intent: string; layoutId: string; keyPoints: string[]; sourceIds?: string[] }
/** Colours an AI chose for one deck while planning it. The app checks contrast and
 * turns them into the deck's own theme (DeckSpec.aiTheme). */
export interface AiPalette { name?:string; background:string; text:string; muted:string; accent:string; accent2:string; surface?:string; headingFont?:string; bodyFont?:string }
/** A fact the deck needs that the request and documents do not give (a date, a place, a contact). The AI
 * names it while planning; the user may answer before the pages are made (value). What is still unknown
 * is written on the slides as one kind of blank, ［label］, which the app marks, lists and fills. */
export interface OpenFact { label:string; hint?:string; value?:string }
export interface Outline { title: string; mode: OutputMode; themeId?: string; typographyId?:string; palette?:AiPalette; audience?: string; inputBrief?:string; visualStyle?:string; assumptions: string[]; openFacts?: OpenFact[]; slides: OutlineSlide[] }
/** One direction the AI offered before the user picked an outline. typicality is the AI's own
 * estimate (0-1) of how many makers would choose this direction for the same request. suitedFor is
 * where the direction fits best; previewSlide the page that shows its look best; preview the cover and
 * that page made in advance (or previewError when they could not be made). */
export interface OutlineProposal { direction:string; difference:string; typicality:number; outline:Outline; suitedFor?:string; previewSlide?:string; preview?:DeckSpec; previewError?:string }
/** The directions offered (items), the wider list the AI compared them against (candidates), the one
 * the AI recommends for this request and why, how the app ordered them from the user's earlier
 * choices (orderNote), the one furthest from those choices (fresh, kept near the top so the picks do
 * not narrow), and the one the user picked (chosen, an index into items). */
export interface ProposalSet { items:OutlineProposal[]; candidates:{direction:string;typicality:number}[]; recommended?:number; reason?:string; orderNote?:string; fresh?:number; chosen?:number }
/** What the AI saw on a drawn page. high problems are fixed automatically (fixed, or unresolved when that
 * failed); medium and low ones are only shown to the user as hints. */
export interface ReviewHint { slideId:string; title:string; severity:'high'|'medium'|'low'; what:string; fix:string; unresolved?:boolean; fixed?:boolean }
/** One look at the drawn pages: how many were seen, which were made again, and the calls it took. */
export interface ReviewReport { checked:number; fixed:string[]; unresolved:string[]; calls:number }
/** The look at drawn pages runs after the deck is shown (pending until then). versions keeps each remade
 * page before and after, and which one the deck uses, so the user can go back. */
export interface PolishState { state:'pending'|'done'|'failed'|'skipped'; variantId?:string; pages?:number; seconds?:number; versions?:Record<string,{before:SlideSpec;after:SlideSpec;applied:'before'|'after'}> }
export interface ChatMessage { role: 'user' | 'assistant'; text: string }
export interface Usage { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd?: number }
export interface RenderResult { artifactId: string; pptxUrl: string; thumbnails: string[]; warnings: string[]; native: boolean }
/** Where a draft came from: an AI, a restyle of another draft, or a combination of drafts. */
export interface VariantOrigin { kind:'ai'|'restyle'|'combined'|'refresh'; ai?:string; parents?:string[]; notes?:string[] }
export interface DeckVariant { id: string; label: string; deck: DeckSpec; render?: RenderResult; origin?: VariantOrigin }
/** A per-slide choice when combining drafts: whose content, whose design. */
export interface CombinePick { content: string; design: string }
export interface ChoiceStats { decisions:number; content:Record<string,number>; design:Record<string,number> }
export interface RepairReport {status:'recovered'|'stopped';retries:number;apiCalls:number;steps:{reason:string;adjustment:string}[];changes?:string[]}
export type AssistTask = 'slide-visualize'|'slide-chart'|'slide-summarize'|'rehearsal';
/** What a design-only request sends and how it was checked (kept with the hand-off and in the local send record). */
export interface PrivacyCheck { level:'structure'|'topic'|'masked'; topic?:string; checkedCharacters:number; hits:number; sha256:string; characters:number; masked?:number; items?:{token:string;original:string}[] }
export interface SendRecord { at:string; task:string; service:string; level:'structure'|'topic'|'masked'; topic?:string; slides?:number; characters:number; checkedCharacters:number; hits:number; sha256:string; masked?:number }
export interface ChatHandoff { privacy?:PrivacyCheck; requestId:string; task:'plan'|'generate'|'revise'|'summarize'|'design'|AssistTask; service:ChatService; serviceUrl?:string; instruction:string; instructionMode?:'full'|'project'; projectStale?:boolean; validationIssues?:string[]; completedSlides?:number; totalSlides?:number; slideId?:string }
/** Recurring report: where a number was found, in the previous or the new documents. */
export interface RefreshPlace { documentId:string; documentName:string; locator:string; label:string; excerpt?:string }
/** One number on a slide and its value in the new documents. Matching is local and
 * by the item the number belongs to (row/column label or the words before it);
 * nothing is sent to an AI. start/end locate the number inside a text field. */
export interface RefreshEntry { id:string; slideId:string; page:number; path:string; start?:number; end?:number; where:string; context:string; before:string; after:string; status:'changed'|'same'|'review'|'missing'; basis?:RefreshPlace; previous?:RefreshPlace; candidates?:{value:string;basis:RefreshPlace}[]; note?:string }
/** A sentence whose numbers changed and whose wording ("増益", "上回る") may no longer be true. */
export interface RefreshText { id:string; slideId:string; page:number; path:string; where:string; before:string; reason:string }
export interface RefreshPlan { id:string; variantId:string; title:string; documents:{id:string;name:string}[]; previousDocuments:string[]; entries:RefreshEntry[]; texts:RefreshText[]; counts:{changed:number;same:number;review:number;missing:number} }
/** Kept with a refreshed deck: what changed from the previous report, for the marks in the preview. */
export interface RefreshSummary { at:string; from:string; documents:string[]; previousDocuments:string[]; changes:{slideId:string;page:number;where:string;before:string;after:string;kind:'text'|'value'}[]; edited:number; unresolved:number }
export interface Session { targets?:AiTarget[]; sendScope?:SendScope; refresh?:RefreshSummary; id: string; phase: 'clarifying' | 'outline' | 'ready'; messages: ChatMessage[]; outline?: Outline; proposals?: ProposalSet; reviewHints?: ReviewHint[]; reviewReport?: ReviewReport; polish?: PolishState; variants: DeckVariant[]; usage: Usage; warnings: string[]; historyId?:string; savedAt?:string; historySaveError?:string; cloudConsentRequired?:boolean; repairReport?:RepairReport; provider?:ProviderKind; subscriptionService?:SubscriptionService; projectId?:string; chatHandoff?:ChatHandoff; recovery?:{task:'plan'|'generate'|'revise';message:string;retryAvailable:boolean;stage?:'content'|'text-fit';completedSlides?:number;totalSlides?:number;nextBatchSize?:number;slideId?:string} }
export interface HistoryEntry { id:string; title:string; createdAt:string; updatedAt:string; slides:number; variants:number; mode:OutputMode; projectId?:string; thumbnail?:string }
export interface HistoryVersion { revision:number; savedAt:string; title:string; slides:number }
/** Only reusable visual style is saved here; slide text and source documents are excluded. */
export interface DesignEntry { id:string; name:string; mode:OutputMode; themeId:string; palette?:Theme; typographyId?:string; layoutIds:string[]; createdAt:string; updatedAt:string; votes:number; projectId?:string; thumbnail?:string }
export interface RestoredPresentation { session:Session; documents:DocumentInfo[]; mode:OutputMode }
export interface Feedback { sessionId: string; variantId: string; slideId?: string; rating: number; reason?: string }

export interface Theme { background: string; foreground: string; muted: string; accent: string; secondary: string; pale: string; font: string; headingFont?:string; numberFont?:string; equationFont?:string; typographyId?:string; itemColors?:string[]; panelStyle?:'tint'|'outline'|'header'; name?:string; description?:string; coverStyle?:'editorial'|'split'|'band'|'block'; headingStyle?:'rule'|'accent'|'band'; tableStyle?:'minimal'|'striped'|'contrast' }
export interface Rect { x: number; y: number; w: number; h: number }
export interface TextElement extends Rect { kind: 'text'; text: string; fontSize: number; color: string; font?:string; fontFarEast?:string; role?:'heading'|'body'|'label'|'number'|'equation'; bold?: boolean; italic?:boolean; align?: 'left' | 'center' | 'right'; verticalAlign?:'top'|'middle'|'bottom'; noWrap?:boolean; lineHeight?:number; exact?:boolean; minFontSize?:number; runs?:{start:number;length:number;color?:string;bold?:boolean;italic?:boolean}[];
  /** The colour of the blanks still to fill (［実施日］) in this text; they are also given as runs. */
  blankColor?:string }
/** A picture: SVG artwork (inserted as an editable-in-PowerPoint vector image) or PNG data. */
export interface ImageElement extends Rect { kind: 'image'; svg?: string; png?: string }
export interface ShapeElement extends Rect { kind: 'shape'; shape: FreeShape; fill: string; stroke?: string; strokeWidth?:number; opacity?:number; radius?:number; rotation?:number }
/** Drawn from (x, flipY ? y+h : y) to (x+w, flipY ? y : y+h); arrow marks the end, arrowStart the start. */
export interface LineElement extends Rect { kind: 'line'; stroke: string; strokeWidth?: number; flipY?:boolean; arrow?:boolean; arrowStart?:boolean; dash?:boolean }
export interface ChartElement extends Rect { kind: 'chart'; chartType: ChartSpec['type']; categories: string[]; series: ChartSpec['series']; colors: string[]; unit?: string; background?:string; gridColor?:string; labelSize?:number; showValues?:boolean; categoryOrder?:'input' }
export interface SmartArtElement extends Rect { kind: 'smartart'; layout: DiagramSpec['type']; items: SlideItem[]; accent: string; color: string; fontSize: number }
export type SceneElement = TextElement | ShapeElement | LineElement | ChartElement | SmartArtElement | ImageElement;
export interface TextFitIssue { text:string; maxCharacters:number; field?:string }
export interface SceneSlide { id: string; title: string; notes: string; elements: SceneElement[]; warnings: string[]; textIssues?:TextFitIssue[] }
export interface RenderDocument { title: string; mode: OutputMode; theme: Theme; width: number; height: number; slides: SceneSlide[] }

/** Text of a slide in the open presentation, read through Office.js. */
export interface OpenSlideShape { id:string; name?:string; text:string }
export interface OpenSlideContent { slideId?:string; index?:number; title?:string; shapes:OpenSlideShape[] }
export interface RehearsalSlide { id:string; title:string; text:string; seconds?:number }
export interface RehearsalPlan { totalSeconds:number; slides:{id:string;title:string;seconds:number;notes:string}[]; questions:{question:string;answer:string}[]; generated:'ai'|'local' }
export type AssistResult =
  | {kind:'slide';slide:SlideSpec;deck:DeckSpec}
  | {kind:'summary';shapes:{id:string;before:string;text:string}[]}
  | {kind:'rehearsal';plan:RehearsalPlan};
export interface AssistState { requestId:string; task:AssistTask; status:'handoff'|'done'; handoff?:ChatHandoff; result?:AssistResult; usage?:Usage }
/** Per-slide citations with the original extracted text, and whether each
 * number on the slide appears in that cited text. Computed locally. */
export interface SourceCheck { value:string; status:'matched'|'uncited'|'unmatched'; locator?:string }
export interface SlideSourceReport { slideId:string; title:string; sources:{index:number;documentName:string;locator:string;quote?:string;excerpt:string;missing?:boolean}[]; numbers:SourceCheck[] }
export interface SourceReport { variantId:string; slides:SlideSourceReport[]; documents:number }
