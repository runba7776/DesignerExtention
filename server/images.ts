import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FreeElement } from '../shared/contracts.js';
import { IMAGE_SRC } from '../shared/free-design.js';

type ImagePlace = Extract<FreeElement, { t: 'image' }>;
interface Found {
  src: string;
  iw: number;
  ih: number;
  credit: string;
  page: string;
}
/** Photos and illustrations for the places an AI marked on its pages (an image with English search words),
 * found on Wikimedia Commons under a free licence (CC0, public domain, CC BY, CC BY-SA) and kept in
 * runtime/images with their author and licence. The search words leave this PC, so the engine uses it only
 * when the content already goes to a cloud AI. */
export interface ImageStore {
  /** Finds a picture for every place in value (a session) that has none, or whose words changed, each picture
   * once in a deck; returns how many places are left without one. */
  place(value: unknown): Promise<number>;
  /** The file of a stored picture. */
  file(src: string): string | undefined;
}

const API = 'https://commons.wikimedia.org/w/api.php';
const AGENT = 'DesignerExtention/1.0 (PowerPoint add-in; +https://runba7776.github.io/DesignerExtention/)';
const FREE = /^(cc0|public domain|pd|cc by(-sa)? \d)/i;
/** Words in a file's name, categories or description saying a person is in it: a slide is not to show a real
 * person (few files say so in their structured data, so the search itself cannot leave them out). */
const PERSON =
  /\b(people|persons?|humans?|m[ae]n|wom[ae]n|girls?|boys?|child(ren)?|kids?|portraits?|faces?|selfies?|female|male|business(m[ae]n|wom[ae]n|people)|doctors?|nurses?|workers?|employees?|students?|teachers?|politicians?|officials?|ministers?|mayors?|governors?|senators?|ambassadors?|presidents?|director|chairman|ceo|actors?|actress(es)?|singers?|crowds?|ceremony)\b(?!-)/i;
const plain = (html: string) =>
  html
    .replace(/<(\w+)[^>]*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function createImageStore(root: string, fetcher: typeof fetch = fetch): ImageStore {
  const indexFile = path.join(root, 'index.json');
  let index: Record<string, Found> | undefined;
  const missing = new Set<string>();
  const load = async () =>
    (index ??= await readFile(indexFile, 'utf8')
      .then(text => JSON.parse(text) as Record<string, Found>)
      .catch((): Record<string, Found> => ({})));
  const key = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');
  const get = (url: string) =>
    fetcher(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(15_000) }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    });

  /** Commons finds only files that match every word, so words are left out from the end until a picture is found
   * or two are left (the AI writes the subject first: "evacuation drill outdoor" is not to become "drill outdoor"),
   * and then the last two are tried ("office worker laptop desk": no worker, but a desk). */
  async function search(q: string, aspect: number, taken: Set<string>) {
    const words = q.trim().split(/\s+/),
      tries = new Set<string>();
    for (let n = words.length; n === words.length || n >= 2; n--) tries.add(words.slice(0, n).join(' '));
    tries.add(words.slice(-2).join(' '));
    for (const tried of tries) {
      const found = await searchWords(tried, aspect, taken);
      if (found) return found;
    }
  }
  async function searchWords(q: string, aspect: number, taken: Set<string>): Promise<Found | undefined> {
    const query = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `${q} filetype:bitmap|drawing`,
      gsrnamespace: '6',
      gsrlimit: '12',
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|size|mime',
      iiurlwidth: '1280',
      iiextmetadatafilter: 'LicenseShortName|Artist|Restrictions|Categories|ImageDescription',
      format: 'json',
    });
    const data = (await (await get(`${API}?${query}`)).json()) as {
      query?: { pages?: Record<string, { index: number; title: string; imageinfo?: any[] }> };
    };
    // A file named for none of the words was found by its description alone, and is mostly of something else
    // ("office computer security": a locomotive shed); the first letters let "variegated" find "variegation".
    const stems = q
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .map(w => w.slice(0, 5));
    // The first results in search order, the one closest to the place's shape first (it is cut to fill the place).
    const candidates = Object.values(data.query?.pages ?? {})
      .sort((a, b) => a.index - b.index)
      .flatMap(p => {
        const info = p.imageinfo?.[0],
          meta = info?.extmetadata ?? {},
          license = String(meta.LicenseShortName?.value ?? '');
        if (!info?.thumburl || !/^image\/(jpeg|png|svg\+xml)$/.test(info.mime) || !FREE.test(license)) return [];
        const name = p.title.replace(/^File:/, '').toLowerCase();
        if (!stems.some(s => name.includes(s))) return [];
        // Personality rights: a person in it may not be used to promote anything without consent.
        if (/personality/i.test(String(meta.Restrictions?.value ?? ''))) return [];
        if (
          PERSON.test(`${p.title} ${meta.Categories?.value ?? ''} ${plain(String(meta.ImageDescription?.value ?? ''))}`)
        )
          return [];
        if (!(info.thumbwidth >= 480 && info.thumbheight >= 320)) return [];
        return [{ info, license, title: p.title }];
      })
      .slice(0, 6)
      .sort(
        (a, b) =>
          Math.abs(Math.log(a.info.thumbwidth / a.info.thumbheight / aspect)) -
          Math.abs(Math.log(b.info.thumbwidth / b.info.thumbheight / aspect)),
      );
    for (const { info, license, title } of candidates) {
      const response = await get(info.thumburl),
        type = response.headers.get('content-type') ?? '',
        ext = type.startsWith('image/jpeg') ? 'jpg' : type.startsWith('image/png') ? 'png' : undefined;
      if (!ext) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 6_000_000) continue;
      const src = `${createHash('sha256').update(info.thumburl).digest('hex').slice(0, 16)}.${ext}`;
      if (taken.has(src)) continue;
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, src), bytes);
      const name = plain(String(info.extmetadata?.Artist?.value ?? '')),
        artist = !name || /^unknown author/i.test(name) ? '作者不明' : name.slice(0, 40);
      return {
        src,
        iw: info.thumbwidth,
        ih: info.thumbheight,
        credit: `${artist}, ${license}`,
        page: String(info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${title}`).slice(0, 300),
      };
    }
    return undefined;
  }

  return {
    file: src => (IMAGE_SRC.test(src) && existsSync(path.join(root, src)) ? path.join(root, src) : undefined),
    async place(value) {
      // Each place with the pictures its deck uses (a place outside a deck, like the earlier version of a page, is
      // on its own).
      const places: { place: ImagePlace; taken: Set<string> }[] = [];
      const walk = (v: unknown, taken?: Set<string>) => {
        if (Array.isArray(v)) v.forEach(item => walk(item, taken));
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (o.t === 'image' && typeof o.q === 'string')
            places.push({ place: o as unknown as ImagePlace, taken: taken ?? new Set() });
          else for (const [name, item] of Object.entries(o)) walk(item, name === 'slides' ? new Set() : taken);
        }
      };
      walk(value);
      if (!places.length) return 0;
      const found = await load();
      let changed = false,
        left = 0;
      // A page keeps the picture it has, and a new one takes a picture its deck does not use yet: a touch-up sees its
      // own page only, and wrote the words of the cover.
      places.sort((a, b) => Number(!a.place.src) - Number(!b.place.src));
      for (const { place, taken } of places) {
        const k = key(place.q);
        // A stored picture is checked against its file; the credit always comes from the store. The further pictures
        // for the same words are stored as "words #file".
        const stored = Object.keys(found)
          .filter(name => name === k || name.startsWith(`${k} #`))
          .map(name => found[name])
          .filter(p => !taken.has(p.src) && existsSync(path.join(root, p.src)));
        let picture: Found | undefined = stored.find(p => p.src === place.src) ?? stored[0];
        if (!picture && !missing.has(k)) {
          try {
            picture = await search(place.q, place.w / place.h, taken);
            if (picture) {
              found[found[k] ? `${k} #${picture.src}` : k] = picture;
              changed = true;
            } else missing.add(k);
          } catch {
            /* offline or refused: the place stays a frame, and is tried again next time */
          }
        }
        if (picture) {
          Object.assign(place, picture);
          taken.add(picture.src);
        } else {
          for (const field of ['src', 'iw', 'ih', 'credit', 'page'] as const) delete place[field];
          left++;
        }
      }
      if (changed) {
        await mkdir(root, { recursive: true });
        await writeFile(indexFile, JSON.stringify(found), 'utf8');
      }
      return left;
    },
  };
}
