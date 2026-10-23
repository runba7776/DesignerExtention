import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Outline, Settings } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import { freeSystemPrompt, reviewPrompt } from '../server/free-prompts.js';
import { validatePlanResponse } from '../server/validation.js';
import { AppError } from '../server/errors.js';

const usage = { ...emptyUsage(), calls: 1 };
const t = (x: number, y: number, w: number, h: number, text: string, size: number, role?: string) => ({
  t: 'text',
  x,
  y,
  w,
  h,
  text,
  size,
  ...(role ? { role } : {}),
});
const outlineOf = (name: string, background = '#FFFFFF', count = 3): Outline =>
  ({
    title: name,
    mode: 'presentation',
    palette: {
      name,
      background,
      text: background === '#FFFFFF' ? '#1F2937' : '#F3F4F6',
      muted: '#6B7280',
      accent: '#2B6CB0',
      accent2: '#DD6B20',
    },
    visualStyle: `${name}の見せ方`,
    assumptions: [],
    slides: Array.from({ length: count }, (_, i) => ({
      id: `slide-${i + 1}`,
      title: i ? `${name}の本文${i}` : name,
      intent: i ? '本文' : '表紙',
      layoutId: i ? 'free' : 'cover',
      keyPoints: [],
    })),
  }) as Outline;
const direction = (name: string, typicality: number, background = '#FFFFFF') => ({
  direction: name,
  difference: `${name}の違い`,
  typicality,
  suitedFor: `${name}の場面`,
  previewSlide: 'slide-3',
  outline: outlineOf(name, background),
});
const offer = {
  kind: 'proposals',
  candidates: [{ direction: '定番', typicality: 0.6 }],
  proposals: [
    direction('定番の流れ', 0.6),
    direction('問いから始める', 0.15),
    direction('暗い背景の物語', 0.08, '#14181F'),
  ],
  recommended: 1,
  reason: '読み手が初心者なので問いから入るのがよい',
};
const page = (id: string, title: string, y = 28) => ({
  id,
  title,
  layoutId: id === 'slide-1' ? 'cover' : 'free',
  notes: '',
  sources: [],
  design: { elements: id === 'slide-1' ? [t(64, 160, 832, 100, title, 40)] : [t(56, y, 848, 52, title, 28, 'title')] },
});

test('directions carry where they fit and the recommendation; dropping an unusable one keeps the recommendation on its card', () => {
  const reply = {
    ...offer,
    proposals: [
      { ...direction('枚数違い', 0.5), outline: outlineOf('枚数違い', '#FFFFFF', 4) },
      direction('問いから始める', 0.15),
      { ...direction('物語', 0.08), previewSlide: 'slide-1', suitedFor: undefined },
    ],
    recommended: 2,
    reason: '理由',
  };
  const parsed = validatePlanResponse(reply, outline => {
    if (outline.slides.length !== 3) throw new AppError(422, '枚数', 'SLIDE_COUNT_MISMATCH');
  }).proposals!;
  assert.deepEqual(
    parsed.items.map(i => [i.direction, i.suitedFor, i.previewSlide]),
    [
      ['問いから始める', '問いから始めるの場面', 'slide-3'],
      ['物語', undefined, 'slide-3'],
    ],
    'a cover is not a sample page; a middle body page is used instead',
  );
  assert.equal(parsed.recommended, 1);
  assert.equal(parsed.reason, '理由');
  const plan = freeSystemPrompt('plan', { proposals: 3 });
  assert.match(plan, /suitedForには、その案が向いている場面や読み手を25文字以内/);
  assert.match(plan, /previewSlideには、その案の見た目の特徴が一番よく分かる本文ページのid/);
  assert.match(plan, /recommendedには、依頼の目的と読み手に一番合う案の番号/);
  assert.match(plan, /ありがちさの高い低いでは決めません/);
  assert.match(reviewPrompt(), /request\.focus=trueのときは、利用者がこのページを選んで見直しを求めています/);
});

async function fixture(
  patch: Partial<Settings> = {},
  options: { refuseFirstRemake?: boolean; nothingToFix?: boolean } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-choices-')),
    artifacts = path.join(dir, 'artifacts');
  const settings = await new SettingsStore(dir, '').load();
  await settings.update({
    provider: 'subscription',
    subscriptionService: 'claude',
    slideCount: 3,
    mode: 'presentation',
    designMode: 'free',
    ...patch,
  });
  const generated: string[][] = [],
    reviews: CompletionRequest[] = [],
    remakes: any[] = [];
  let renders = 0;
  const render = async (deck: any) => {
    renders++;
    const id = `art${renders}`;
    await mkdir(path.join(artifacts, id), { recursive: true });
    const thumbnails = [];
    for (let i = 0; i < deck.slides.length; i++) {
      await writeFile(path.join(artifacts, id, `slide-${i + 1}.png`), `PNG-${deck.slides[i].id}`);
      thumbnails.push(`/api/artifacts/${id}/slide-${i + 1}.png`);
    }
    return { artifactId: id, pptxUrl: 'x', thumbnails, warnings: [], native: true };
  };
  const engine = new SessionEngine({
    settings,
    dataDir: dir,
    artifactRoot: artifacts,
    subscriptionBinding: () => 'account',
    render,
    providerFactory: () => ({
      images: true,
      complete: async (r: CompletionRequest) => {
        const req = JSON.parse(r.content).request;
        if (r.images) {
          reviews.push(r);
          return {
            text: JSON.stringify({
              pages: [
                {
                  id: req.pages[0].id,
                  problems: options.nothingToFix
                    ? []
                    : [{ severity: 'medium', what: '見出しが弱い', fix: '見出しを大きくする' }],
                },
              ],
            }),
            usage,
          };
        }
        if (!req.targetSlides) return { text: JSON.stringify(offer), usage };
        if (req.repair?.reason === 'VISUAL_REVIEW') {
          remakes.push(req);
          const refused = options.refuseFirstRemake && remakes.length === 1;
          return {
            text: JSON.stringify({
              mode: 'presentation',
              id: 'd',
              title: 'x',
              slides: req.targetSlides.map((s: any) => page(s.id, '直した' + s.title, refused ? 480 : 28)),
            }),
            usage,
          };
        }
        generated.push(req.targetSlides.map((s: any) => s.id));
        return {
          text: JSON.stringify({
            mode: 'presentation',
            id: 'd',
            title: 'x',
            slides: req.targetSlides.map((s: any) => page(s.id, s.title)),
          }),
          usage,
        };
      },
    }),
  });
  return {
    dir,
    engine,
    settings,
    generated,
    reviews,
    remakes,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

test('picks and ratings are remembered per project (numbers only) and order the next directions', async () => {
  const f = await fixture();
  try {
    for (const rating of [5, 4]) {
      const s = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
      assert.equal(s.proposals!.orderNote, undefined, 'not ordered before two picks');
      const rare = s.proposals!.items.findIndex(i => i.typicality === 0.08);
      await f.engine.chooseProposal(s.id, rare);
      const ready = await f.engine.generate(s.id);
      await f.engine.feedback({ sessionId: s.id, variantId: ready.variants[0].id, rating });
    }
    const stored = await readFile(path.join(f.dir, 'proposal-choices.jsonl'), 'utf8');
    assert.doesNotMatch(stored, /物語|問い|定番|本文/, 'no text of the outline is kept');
    assert.equal(stored.trim().split('\n').length, 4);
    const next = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    assert.deepEqual(
      next.proposals!.items.map(i => i.typicality),
      [0.08, 0.6, 0.15],
      'closest to the earlier picks first, the furthest second',
    );
    assert.equal(next.proposals!.fresh, 1, 'the furthest direction is marked, so the picks do not narrow');
    assert.equal(
      next.proposals!.items[next.proposals!.recommended!].direction,
      '問いから始める',
      'the recommendation stays on its card',
    );
    assert.match(
      next.proposals!.orderNote!,
      /これまでの2回の選び方（ありがちさ8%前後の案・暗い背景を選ぶことが多い）に一番近い案を先頭に、いつもと違う方向の案をその次に並べています/,
    );
    const other = await f.engine.createProject({ name: '別の案件' });
    await f.settings.update({ activeProjectId: other.id });
    const fresh = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    assert.equal(fresh.proposals!.orderNote, undefined, 'another project starts without habits');
  } finally {
    await f.dispose();
  }
});

test('samples are the cover and the telling page of a direction; the picked direction uses them in the deck', async () => {
  const f = await fixture();
  try {
    const s = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    const shown = await f.engine.previewProposal(s.id, 1);
    const sample = shown.proposals!.items[1].preview!;
    assert.deepEqual(
      sample.slides.map(x => x.id),
      ['slide-1', 'slide-3'],
    );
    assert.ok(sample.aiTheme, "drawn in the direction's own colours");
    assert.deepEqual(f.generated, [['slide-1', 'slide-3']]);
    await f.engine.previewProposal(s.id, 1);
    assert.equal(f.generated.length, 1, 'made once');
    await f.engine.chooseProposal(s.id, 1);
    const ready = await f.engine.generate(s.id);
    assert.deepEqual(f.generated.slice(1), [['slide-2']], 'only the page that had no sample is written');
    assert.deepEqual(
      ready.variants[0].deck.slides.map(x => x.id),
      ['slide-1', 'slide-2', 'slide-3'],
    );
    await f.settings.update({ proposalPreviews: false });
    const off = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await assert.rejects(f.engine.previewProposal(off.id, 0), /見本は、月額版の自動作成/);
  } finally {
    await f.dispose();
  }
});

test('a page the user picks is looked at as its PowerPoint picture and remade; a refused remake is asked once more', async () => {
  const f = await fixture({}, { refuseFirstRemake: true });
  try {
    const s = await f.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await f.engine.chooseProposal(s.id, 0);
    const ready = await f.engine.generate(s.id);
    const done = await f.engine.refinePage(s.id, ready.variants[0].id, 'slide-2');
    assert.equal(f.reviews.length, 1);
    assert.equal(
      f.reviews[0].images![0].data,
      Buffer.from('PNG-slide-2').toString('base64'),
      'the PowerPoint thumbnail of that page',
    );
    assert.equal(JSON.parse(f.reviews[0].content).request.focus, true);
    assert.equal(f.remakes.length, 2, 'refused by the checks, asked once more');
    assert.match(f.remakes[1].repair.detail, /作り直した案は次の検査で通りませんでした/);
    assert.equal((done.variants[0].deck.slides[1].design!.elements[0] as any).text, '直した定番の流れの本文1');
    assert.equal(done.polish?.versions?.['slide-2'].applied, 'after');
    assert.equal(done.variants[0].render, undefined, 'drawn again');
    assert.deepEqual(
      done.reviewHints!.map(h => [h.slideId, h.severity, !!h.fixed]),
      [['slide-2', 'medium', true]],
    );
    assert.ok(done.messages.some(m => /2枚目を画像で見直し、1点を直して作り直しました/.test(m.text)));
    const back = await f.engine.reviewVersion(s.id, 'slide-2', 'before');
    assert.equal((back.variants[0].deck.slides[1].design!.elements[0] as any).text, '定番の流れの本文1');
  } finally {
    await f.dispose();
  }
  const quiet = await fixture({}, { nothingToFix: true });
  try {
    const s = await quiet.engine.create({ prompt: '3枚', cloudConsent: true }, []);
    await quiet.engine.chooseProposal(s.id, 0);
    const ready = await quiet.engine.generate(s.id);
    const same = await quiet.engine.refinePage(s.id, ready.variants[0].id, 'slide-2');
    assert.equal(quiet.remakes.length, 0);
    assert.ok(same.messages.some(m => /直すべき点は見つかりませんでした/.test(m.text)));
  } finally {
    await quiet.dispose();
  }
});
