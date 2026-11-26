/** What a host of the engine provides when it can, as types only: the installed app's server (Express, Edge for
 * reading HTML pages, PowerPoint over COM, the monthly plans' sign-in, photos from Wikimedia Commons) implements
 * these in server/; the no-install build in web/hosted provides none of them. The engine depends on these
 * interfaces, never on server/. */
import type { SubscriptionConnection, SubscriptionService, SubscriptionStatus, Theme } from './shared/contracts.js';

/** One AI-written HTML page, read back as free-design elements. Problems are the
 * app's findings (text outside the slide, in the footer or clipped), sent with a retry. */
/** fitted: the share (0.85-0.95) the text was made smaller to keep it above the footer, without asking the AI.
 * squeezed: the share the spacing was made smaller to (0.6 or 0.35), before or with the text, without asking the AI.
 * grown: text below the smallest size was made that size (the page still fitted), without asking the AI.
 * keptSmall: text a little below the smallest size was kept as written (made larger, it did not fit).
 * unreadable: of the problems left, some text cannot be read (on other parts, under a shape, cut off or off the slide).
 * shot: the drawn page as a 960x540 PNG (base64), when asked for. */
export type HtmlPageLayout =
  | {
      background?: string;
      elements: Record<string, unknown>[];
      problems: string[];
      fitted?: number;
      squeezed?: number;
      grown?: boolean;
      keptSmall?: boolean;
      unreadable?: boolean;
      shot?: string;
    }
  | { error: string };
/** minTextSize: body text, and text marked data-role="caption", drawn smaller than this (px = pt) is reported.
 * keepSmall: text that cannot be made that size is kept down to the fitting floor instead (a local model
 * rarely fixed 14px text when asked, and the deck stopped). */
export interface HtmlLayoutOptions {
  minTextSize?: { body: number; caption: number };
  screenshot?: boolean;
  keepSmall?: boolean;
}
export type HtmlLayout = (
  pages: { id: string; html: string }[],
  theme: Theme,
  options?: HtmlLayoutOptions,
) => Promise<HtmlPageLayout[]>;

/** Photos and illustrations for the places an AI marked on its pages (an image with English search words),
 * found on Wikimedia Commons under a free licence (CC0, public domain, CC BY, CC BY-SA) and kept in
 * runtime/images with their author and licence. The search words leave this PC, so the engine uses it only
 * when the content already goes to a cloud AI. */
export interface ImageStore {
  /** Finds a picture for every place in value (a session) that has none, or whose words changed, each picture
   * once in a deck; returns how many places are left without one. */
  place(value: unknown): Promise<number>;
  /** The pictures of the places in value (a page) are not used again: the look saw a real person in one, or something
   * other than the words asked for. The next placing takes another. */
  passOver(value: unknown): Promise<void>;
  /** The file of a stored picture. */
  file(src: string): string | undefined;
}

/** The monthly plans' sign-in, as the routes use it. */
export interface SubscriptionControl {
  status(): Promise<SubscriptionStatus>;
  connect(
    service: SubscriptionService,
    input?: { accountId?: unknown; newAccount?: unknown },
  ): Promise<SubscriptionConnection>;
  refresh(service: SubscriptionService): Promise<unknown>;
  disconnect(service: SubscriptionService): Promise<unknown>;
}
