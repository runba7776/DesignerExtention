import type { DesignMode, ProviderKind, SendScope } from './contracts';

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
  const mode = input.designMode ?? 'html';
  if (input.provider === 'demo' || mode === 'template') return 'template';
  if (mode === 'html' && input.provider === 'local' && !input.canReadHtml) return 'template';
  const writer = input.writer ?? input.provider;
  return mode === 'html' &&
    input.canReadHtml &&
    (writer === 'subscription' || writer === 'local') &&
    input.sendScope !== 'design'
    ? 'html'
    : 'coordinates';
}

/** What differs by the AI that writes. Claude and ChatGPT of a monthly plan get the same instruction and the same
 * handling; only a model on this PC is treated differently, each point from a measured run (gemma4 12B and 26B).
 * For every AI alike, a page it cannot get right gives way to a layout instead of stopping the deck, and what the
 * look at the drawn pages finds is shown for the user to fix (docs/system-design.md, 5). */
export function writerTraits(provider: ProviderKind) {
  const local = provider === 'local';
  return {
    /** Automatic retries of one operation while it designs its own pages: it costs no quota and slips more often. */
    designRetries: local ? 4 : 2,
    /** Its instruction carries the business layout guide, and the standing instruction and icon list come short. */
    localGuide: local,
    /** Text a little below the smallest size is kept as written: asked to fix it, it rarely did and the deck stopped. */
    keepsSmallText: local,
    /** A page made from a layout in its place is made again in HTML when the look at the drawn pages finds a problem
     * on it (5 of 8 passed). It costs no quota; on a monthly plan the quota is left for the user's own fixes. */
    remakesInLook: local,
    /** Photos are searched outside this PC, so not for a model chosen to keep the material here (nor the sample). */
    photos: !local && provider !== 'demo',
  };
}
