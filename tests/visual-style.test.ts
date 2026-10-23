import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { compileDeck } from '../shared/layouts';
import { sampleDeck, sampleSlide } from '../shared/layout-samples';
import { themes, themeCatalog } from '../shared/themes';
import { typographyProfiles, withTypography } from '../shared/typography';
import { contrast, itemColor, panelFill, readableColor } from '../shared/color';
import { SettingsStore } from '../server/settings';
import { SessionEngine } from '../server/engine';
import { validateDeck, validateOutline } from '../server/validation';
import { demoOutline } from '../server/demo';
import { systemPrompt } from '../server/prompts';

test('Japanese text, numeric values and equations retain separate font roles and all content', () => {
  const deck = sampleDeck([sampleSlide('cover'), sampleSlide('kpi'), sampleSlide('concept_full')]);
  for (const [id, p] of Object.entries(typographyProfiles)) {
    const scene = compileDeck({ ...deck, typographyId: id }),
      texts = scene.slides.flatMap(s => s.elements).filter(e => e.kind === 'text');
    assert.equal(texts.find(e => e.role === 'heading')?.font, p.heading);
    assert.equal(texts.find(e => e.role === 'number')?.font, p.number);
    assert.equal(texts.find(e => e.role === 'number')?.fontFarEast, p.body);
    assert.equal(texts.find(e => e.role === 'equation')?.font, 'Cambria Math');
    assert.equal(texts.find(e => e.role === 'body')?.font, p.body);
    assert.ok(texts.some(e => e.text === '24点'));
    assert.ok(texts.some(e => e.text === '1 + 3 + 5 = 9'));
    assert.deepEqual(
      scene.slides.flatMap(s => s.textIssues ?? []),
      [],
    );
  }
  assert.equal(Object.keys(themes).length, 12);
  assert.ok(new Set(themeCatalog().map(t => t.typographyId)).size >= 6);
  assert.ok(systemPrompt('plan').includes('BIZ UDPGothic'));
  assert.ok(systemPrompt('plan').includes('字幅が広い'));
});
test('panel text remains readable on light/dark themes; new list grammars provide real separation', () => {
  for (const theme of Object.values(themes))
    for (let i = 0; i < 4; i++) {
      const color = itemColor(theme, i),
        fill = panelFill(theme, i);
      assert.ok(contrast(color, fill) >= 4.5, theme.name);
      assert.ok(contrast(readableColor('#FFFFFF', color), color) >= 4.5);
    }
  for (const id of [
    'summary',
    'central_thesis',
    'comparison_spotlight',
    'equation_bottom',
    'kpi',
    'ms_color_columns',
    'ms_banner_comparison',
  ]) {
    const s = compileDeck(sampleDeck([sampleSlide(id, 3)], 'colorblock')).slides[0];
    assert.ok(s.elements.filter(e => e.kind === 'shape').length >= 3, id);
    assert.deepEqual(s.textIssues ?? [], [], id);
  }
});
test('font preference survives settings/schema, overrides AI, and changing it uses no model call', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-style-'));
  try {
    const store = await new SettingsStore(dir, '').load();
    await store.update({ provider: 'demo', typographyId: 'editorial', themeId: 'colorblock' });
    assert.equal((await new SettingsStore(dir, '').load()).get().typographyId, 'editorial');
    await assert.rejects(store.update({ typographyId: '__proto__' }));
    assert.throws(() => validateOutline({ ...demoOutline('検証', 'presentation', []), typographyId: 'bad' }));
    const engine = new SessionEngine({
      settings: store,
      dataDir: dir,
      render: async () => ({ artifactId: 'x', pptxUrl: 'x', thumbnails: [], native: false, warnings: [] }),
    });
    const session = await engine.create({ prompt: '確認' }, []);
    await engine.message(session.id, 'おまかせ');
    await engine.generate(session.id);
    const v = session.variants[0];
    assert.equal(v.deck.typographyId, 'editorial');
    assert.equal(validateDeck(v.deck).typographyId, 'editorial');
    const slides = structuredClone(v.deck.slides);
    await engine.render(session.id, v.id);
    await engine.changeTheme(session.id, { variantId: v.id, themeId: v.deck.themeId, typographyId: 'classroom' });
    assert.equal(v.deck.typographyId, 'classroom');
    assert.deepEqual(v.deck.slides, slides);
    assert.equal(v.render, undefined);
    assert.equal(session.usage.calls, 0);
    await assert.rejects(
      engine.changeTheme(session.id, { variantId: v.id, themeId: v.deck.themeId, typographyId: 'bad' }),
    );
    assert.equal(v.deck.typographyId, 'classroom');
    await engine.changeTheme(session.id, { variantId: v.id, themeId: 'archive', typographyId: 'auto' });
    assert.equal(v.deck.typographyId, undefined);
    assert.equal(compileDeck(v.deck).theme.headingFont, 'Yu Mincho');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
