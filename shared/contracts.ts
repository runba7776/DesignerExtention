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
export const APP_VERSION = '0.12.0';
export const MAX_PROMPT_CHARACTERS = 60_000;
export const MAX_SLIDES = 30;
export const GENERATION_BATCH_SIZE = 6;
export const READING_BATCH_SIZE = 4;
export const GENERATION_OUTPUT_TOKENS = 16_000;
export const PLAN_OUTPUT_TOKENS = 16_000;
export const PLAN_RETRY_OUTPUT_TOKENS = 20_000;
/** Colors and fonts read from a company PowerPoint theme. Slide text, images and
 * masters are not copied; only the reusable style is stored with a project. */
export interface TemplateTheme { name:string; source:string; colors:{dk1:string;lt1:string;dk2:string;lt2:string;accent1:string;accent2:string;accent3:string;accent4:string;accent5:string;accent6:string}; fonts:{major:string;minor:string;majorEa?:string;minorEa?:string}; importedAt:string }
export interface ProjectProfile {id:string;name:string;audience:string;guidance:string;createdAt:string;updatedAt:string;template?:TemplateTheme}
export interface Settings { provider: ProviderKind; model: string; endpoint?: string; mode: OutputMode; hasKey?: boolean; apiKey?: string; themeId?: string; typographyId?:string; slideCount?: number | 'auto'; autoRepair?:boolean; chatService?:ChatService; subscriptionService?:SubscriptionService; preferredDesignId?:string; activeProjectId?:string }
export interface AppStatus { provider: ProviderKind; model: string; hasKey: boolean; nativeAvailable: boolean; version: string; apiFree?:boolean; hosted?:boolean }
export interface DocumentInfo { id: string; name: string; kind: string; units: number; characters: number; warnings: string[] }
export interface SourceRef { documentId: string; documentName?: string; locator: string; quote?: string }
export type IconId = 'idea'|'document'|'chart'|'people'|'globe'|'shield'|'calculator'|'clock'|'target'|'building'|'coins'|'search'
  |'laptop'|'smartphone'|'server'|'database'|'cloud'|'network'|'code'|'chip'
  |'book'|'graduation'|'flask'|'atom'|'geometry'|'puzzle'
  |'leaf'|'recycle'|'energy'|'water'|'sun'|'heart'|'medical'|'accessibility'
  |'factory'|'tools'|'truck'|'train'|'plane'|'shopping'|'package'
  |'message'|'mail'|'camera'|'pin'|'calendar'|'flag'|'balance';
/** refs are 1-based indexes into the slide's sources, shown as citation markers. */
export interface SlideItem { label: string; description?: string; value?: string; parent?: number; icon?:IconId|'none'; refs?:number[] }
export type ChartType = 'bar'|'column'|'line'|'pie'|'doughnut'|'stackedBar'|'stackedColumn';
export interface ChartSpec { type: ChartType; categories: string[]; series: { name: string; values: number[] }[]; unit?: string; caption?: string }
export interface DiagramSpec { type: 'process' | 'cycle' | 'hierarchy' | 'list'; items: SlideItem[] }
export interface TableSpec { headers: string[]; rows: string[][] }
export interface SlideSpec {
  id: string; title: string; layoutId: string; headline?: string; body?: string;
  items: SlideItem[]; chart?: ChartSpec; diagram?: DiagramSpec; table?: TableSpec;
  equation?: { text: string; explanation?: string }; notes: string; sources: SourceRef[];
}
/** themeId 'template' renders with customTheme, a copy of the project's company template. */
export interface DeckSpec { id: string; title: string; mode: OutputMode; themeId: string; typographyId?:string; customTheme?:Theme; referencesSlide?:boolean; pageNumbers?:boolean; slides: SlideSpec[] }
export interface OutlineSlide { id: string; title: string; intent: string; layoutId: string; keyPoints: string[]; sourceIds?: string[] }
export interface Outline { title: string; mode: OutputMode; themeId?: string; typographyId?:string; audience?: string; inputBrief?:string; assumptions: string[]; slides: OutlineSlide[] }
export interface ChatMessage { role: 'user' | 'assistant'; text: string }
export interface Usage { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd?: number }
export interface RenderResult { artifactId: string; pptxUrl: string; thumbnails: string[]; warnings: string[]; native: boolean }
export interface DeckVariant { id: string; label: string; deck: DeckSpec; render?: RenderResult }
export interface RepairReport {status:'recovered'|'stopped';retries:number;apiCalls:number;steps:{reason:string;adjustment:string}[];changes?:string[]}
export type AssistTask = 'slide-visualize'|'slide-chart'|'slide-summarize'|'rehearsal';
export interface ChatHandoff { requestId:string; task:'plan'|'generate'|'revise'|'summarize'|AssistTask; service:ChatService; serviceUrl?:string; instruction:string; validationIssues?:string[]; completedSlides?:number; totalSlides?:number; slideId?:string }
export interface Session { id: string; phase: 'clarifying' | 'outline' | 'ready'; messages: ChatMessage[]; outline?: Outline; variants: DeckVariant[]; usage: Usage; warnings: string[]; historyId?:string; savedAt?:string; historySaveError?:string; cloudConsentRequired?:boolean; repairReport?:RepairReport; provider?:ProviderKind; subscriptionService?:SubscriptionService; projectId?:string; chatHandoff?:ChatHandoff; recovery?:{task:'plan'|'generate'|'revise';message:string;retryAvailable:boolean;stage?:'content'|'text-fit';completedSlides?:number;totalSlides?:number;nextBatchSize?:number;slideId?:string} }
export interface HistoryEntry { id:string; title:string; createdAt:string; updatedAt:string; slides:number; variants:number; mode:OutputMode; projectId?:string; thumbnail?:string }
export interface HistoryVersion { revision:number; savedAt:string; title:string; slides:number }
/** Only reusable visual style is saved here; slide text and source documents are excluded. */
export interface DesignEntry { id:string; name:string; mode:OutputMode; themeId:string; typographyId?:string; layoutIds:string[]; createdAt:string; updatedAt:string; votes:number; projectId?:string; thumbnail?:string }
export interface RestoredPresentation { session:Session; documents:DocumentInfo[]; mode:OutputMode }
export interface Feedback { sessionId: string; variantId: string; slideId?: string; rating: number; reason?: string }

export interface Theme { background: string; foreground: string; muted: string; accent: string; secondary: string; pale: string; font: string; headingFont?:string; numberFont?:string; equationFont?:string; typographyId?:string; itemColors?:string[]; panelStyle?:'tint'|'outline'|'header'; name?:string; description?:string; coverStyle?:'editorial'|'split'|'band'|'block'; headingStyle?:'rule'|'accent'|'band'; tableStyle?:'minimal'|'striped'|'contrast' }
export interface Rect { x: number; y: number; w: number; h: number }
export interface TextElement extends Rect { kind: 'text'; text: string; fontSize: number; color: string; font?:string; fontFarEast?:string; role?:'heading'|'body'|'label'|'number'|'equation'; bold?: boolean; align?: 'left' | 'center' | 'right'; noWrap?:boolean }
export interface ShapeElement extends Rect { kind: 'shape'; shape: 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'arrow'; fill: string; stroke?: string; strokeWidth?:number }
export interface LineElement extends Rect { kind: 'line'; stroke: string; strokeWidth?: number; flipY?:boolean }
export interface ChartElement extends Rect { kind: 'chart'; chartType: ChartSpec['type']; categories: string[]; series: ChartSpec['series']; colors: string[]; unit?: string; background?:string; gridColor?:string; labelSize?:number; showValues?:boolean; categoryOrder?:'input' }
export interface SmartArtElement extends Rect { kind: 'smartart'; layout: DiagramSpec['type']; items: SlideItem[]; accent: string; color: string; fontSize: number }
export type SceneElement = TextElement | ShapeElement | LineElement | ChartElement | SmartArtElement;
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
