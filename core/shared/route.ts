import type { DesignMode, ProviderKind, SendScope, SubscriptionService } from './contracts';

/** How a page is written.
 * html: the AI writes the page as HTML/CSS and a browser the app runs reads where everything landed.
 * coordinates: the AI writes the position and size of every part as numbers.
 * template: the AI fills one of the app's layouts with text. */
export type MakingMethod = 'html' | 'coordinates' | 'template';

export const makingNames: Record<MakingMethod, string> = { html: 'HTML/CSS', coordinates: '座標', template: '型' };

/** The one place that decides how a page is written. It depends on where the app runs and how the material is
 * sent, not on which AI writes: Claude and ChatGPT are asked in the same way.
 *
 *   use                               installed app            no-install version
 *   monthly plan, automatic           html                     (not available)
 *   local model                       html                     template
 *   pasted into an AI chat            coordinates              coordinates
 *   content kept on this PC           template, then the design alone is asked for in coordinates
 *   sample                            template (when no recorded creation is replayed)
 *
 * The setting can choose coordinates or the template for every use instead. A browser to read HTML exists only
 * in the installed app; a local model without one gets the template, because it wrote coordinates poorly (most
 * pages of a 12B model broke or did not finish in a comparison).
 *
 * provider is the session's; writer is the AI of this run when the session has several. */
export function makingMethod(input: {
  provider: ProviderKind;
  writer?: ProviderKind;
  designMode?: DesignMode;
  sendScope?: SendScope;
  canReadHtml: boolean;
}): MakingMethod {
  const mode = input.designMode ?? 'html',
    route = routeOf(input.provider);
  if (route.drive === 'sample' || mode === 'template') return 'template';
  if (mode === 'html' && route.onThisPc && !input.canReadHtml) return 'template';
  const writer = routeOf(input.writer ?? input.provider);
  return mode === 'html' && input.canReadHtml && writer.drive === 'automatic' && input.sendScope !== 'design'
    ? 'html'
    : 'coordinates';
}

/** How a session reaches its AI, and everything that follows from it, in one place. The engine and the screen ask
 * the route instead of comparing provider names, so a new way to reach an AI is added here and nowhere else.
 *
 * Claude and ChatGPT of a monthly plan get the same instruction and the same handling; only a model on this PC is
 * treated differently, each point from a measured run (gemma4 12B and 26B). For every AI alike, a page it cannot get
 * right gives way to a layout instead of stopping the deck, and what the look at the drawn pages finds is shown for
 * the user to fix (docs/system-design.md, 5). */
export interface Route {
  provider: ProviderKind;
  /** automatic: the app calls the AI (a monthly plan or a model on this PC). handoff: the user copies the instruction
   * into an AI chat and pastes the answer back. sample: nothing is called; the sample deck or a recording is used. */
  drive: 'automatic' | 'handoff' | 'sample';
  /** The material goes to Claude or ChatGPT over the user's monthly plan: the user agrees first, the session stays
   * with the account connected then, a masked project is masked, and each call counts against the plan. */
  cloud: boolean;
  /** A model on this PC: the session stays with the endpoint it was made with. */
  onThisPc: boolean;
  /** Only in the installed app (the no-install version cannot sign in to a monthly plan). */
  installedOnly: boolean;
  /** The AIs that write can be chosen at creation: several drafts at once, or the content kept on this PC. */
  choosesTargets: boolean;
  /** What a pasted instruction carries can be chosen (as it is, or names and numbers masked). */
  choosesChatScope: boolean;
  /** The first outline comes as directions to pick from (a one-shot chat asks for the deck in one reply). */
  offersDirections: boolean;
  /** Automatic retries of one operation while the AI designs its own pages: a local model costs no quota and slips
   * more often. */
  designRetries: number;
  /** Its instruction carries the business layout guide, and the standing instruction and icon list come short. */
  localGuide: boolean;
  /** Text a little below the smallest size is kept as written: asked to fix it, it rarely did and the deck stopped. */
  keepsSmallText: boolean;
  /** A page made from a layout in its place is made again in HTML when the look at the drawn pages finds a problem
   * on it (5 of 8 passed). It costs no quota; on a monthly plan the quota is left for the user's own fixes. */
  remakesInLook: boolean;
  /** A layout page with nothing but its title is refused and asked again (gemma4 returned such pages). */
  refusesTitleOnlyPages: boolean;
  /** Photos are searched outside this PC, so not for a model chosen to keep the material here (nor the sample). */
  photos: boolean;
  /** Text that does not fit is fitted (the sample deck is made to fit and is only checked). */
  fitsText: boolean;
}

/** The route of a provider. oneShot: a chat asked for the whole deck in one reply. */
export function routeOf(provider: ProviderKind, options: { oneShot?: boolean } = {}): Route {
  const local = provider === 'local',
    cloud = provider === 'subscription';
  const drive = provider === 'chat' ? 'handoff' : provider === 'demo' ? 'sample' : 'automatic';
  return {
    provider,
    drive,
    cloud,
    onThisPc: local,
    installedOnly: cloud,
    choosesTargets: drive === 'automatic',
    choosesChatScope: drive === 'handoff',
    offersDirections: cloud || (drive === 'handoff' && !options.oneShot),
    designRetries: local ? 4 : 2,
    localGuide: local,
    keepsSmallText: local,
    remakesInLook: local,
    refusesTitleOnlyPages: local,
    photos: !local && drive !== 'sample',
    fitsText: drive !== 'sample',
  };
}

/** The name a deck an AI of this route wrote is shown with. */
export function writerName(route: Route, service?: SubscriptionService) {
  return route.onThisPc
    ? 'ローカルLLM'
    : route.drive === 'sample'
      ? 'サンプル'
      : route.cloud
        ? service === 'claude'
          ? 'Claude'
          : 'ChatGPT'
        : 'AI';
}
