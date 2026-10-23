import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { DeckSpec, SlideSpec } from '../shared/contracts.js';
import { compileDeck, citationMarker } from '../shared/layouts.js';
import { extractTemplateTheme, parseThemeXml, templateToTheme } from '../shared/template-theme.js';
import { contrast } from '../shared/color.js';
import { auditSlide } from '../shared/source-audit.js';
import { allocateTime, localRehearsal, rescaleSeconds } from '../shared/rehearsal.js';
import { canonicalNumber, numbersIn } from '../shared/numbers.js';
import { validateDeck, validateSlide } from '../server/validation.js';
import { ProjectStore } from '../server/projects.js';
import { SettingsStore } from '../server/settings.js';
import { SessionEngine } from '../server/engine.js';
import { AssistService, acceptAssistResponse, validateAssistInput } from '../server/assist.js';
import { apiRoutes, matchRoute } from '../server/routes.js';
import type { Provider } from '../server/providers.js';

const themeXml = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Contoso &amp; Co"><a:themeElements><a:clrScheme name="Contoso"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="C00000"/></a:accent1><a:accent2><a:srgbClr val="FFE699"/></a:accent2><a:accent3><a:srgbClr val="2E75B6"/></a:accent3><a:accent4><a:srgbClr val="70AD47"/></a:accent4><a:accent5><a:srgbClr val="7030A0"/></a:accent5><a:accent6><a:srgbClr val="ED7D31"/></a:accent6></a:clrScheme><a:fontScheme name="Contoso"><a:majorFont><a:latin typeface="Segoe UI Semibold"/><a:ea typeface=""/><a:font script="Jpan" typeface="游ゴシック"/></a:majorFont><a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Meiryo"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

async function templateDeck() {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst></p:presentation>',
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>',
  );
  zip.file('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>');
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/></Relationships>',
  );
  zip.file('ppt/theme/theme1.xml', themeXml.replace('C00000', '111111'));
  zip.file('ppt/theme/theme2.xml', themeXml);
  return zip.generateAsync({ type: 'uint8array' });
}

test('company template: master theme colors and Japanese fonts become a readable deck theme', async () => {
  const template = await extractTemplateTheme(await templateDeck(), 'contoso.potx');
  assert.equal(template.name, 'Contoso & Co');
  assert.equal(template.colors.accent1, '#C00000', 'follows the first master, not theme1');
  assert.equal(template.colors.dk1, '#000000');
  assert.equal(template.fonts.majorEa, '游ゴシック');
  assert.equal(template.fonts.minorEa, 'Meiryo');
  const theme = templateToTheme(template);
  assert.equal(theme.font, 'Meiryo');
  assert.equal(theme.headingFont, '游ゴシック');
  assert.equal(theme.numberFont, 'Segoe UI');
  assert.ok(contrast(theme.foreground, theme.background) >= 7);
  for (const color of theme.itemColors!) assert.ok(contrast(color, theme.background) >= 3, `${color} stays visible`);
  assert.throws(() => parseThemeXml('<a:theme/>', 'x'), /配色/);
  const macro = new JSZip();
  macro.file('ppt/vbaProject.bin', 'x');
  await assert.rejects(extractTemplateTheme(await macro.generateAsync({ type: 'uint8array' }), 'm.pptm'), /マクロ/);
});

const slide = (over: Partial<SlideSpec> = {}): SlideSpec => ({
  id: 'slide-2',
  title: '売上の比較',
  layoutId: 'summary',
  items: [
    { label: '東日本', value: '1,200万円', description: '前年比12.5%増', refs: [1] },
    { label: '西日本', value: '980万円', description: '横ばい', refs: [2] },
  ],
  notes: '',
  sources: [
    { documentId: 'd1', documentName: '売上.xlsx', locator: 'Sheet1!行 2' },
    { documentId: 'd1', documentName: '売上.xlsx', locator: 'Sheet1!行 3' },
  ],
  ...over,
});
const cover: SlideSpec = { id: 'slide-1', title: '報告', layoutId: 'cover', items: [], notes: '', sources: [] };

test('citations: item markers, numbered footer and an appended source list', () => {
  assert.equal(citationMarker([1, 12]), '¹˒¹²');
  const deck: DeckSpec = { id: 'd', title: '報告', mode: 'reading', themeId: 'business', slides: [cover, slide()] };
  const scene = compileDeck(deck);
  const texts = scene.slides[1].elements.filter(e => e.kind === 'text').map(e => (e as any).text.replace(/\n/g, ''));
  assert.ok(
    texts.some(t => t.includes('東日本¹')),
    'marker after the label',
  );
  assert.ok(texts.some(t => t.includes('[1] 売上.xlsx Sheet1!行 2') && t.includes('[2] 売上.xlsx Sheet1!行 3')));
  assert.match(scene.slides[1].notes, /\[1\] 売上\.xlsx Sheet1!行 2/);
  assert.ok(texts.includes('2 / 2'));
  const withList = compileDeck({ ...deck, referencesSlide: true });
  assert.equal(withList.slides.length, 3);
  assert.equal(withList.slides[2].title, '出典一覧');
  assert.ok(withList.slides[2].elements.some(e => e.kind === 'text' && e.text.includes('スライド2 [2]')));
  const single = compileDeck({ ...deck, pageNumbers: false, slides: [slide()] });
  assert.ok(
    !single.slides[0].elements.some(e => e.kind === 'text' && /\d+ \/ \d+/.test(e.text)),
    'no page number on an inserted single slide',
  );
});

test('validation: citation numbers must exist; template decks need a valid copied theme', () => {
  assert.throws(() => validateSlide({ ...slide(), items: [{ label: 'A', refs: [3] }] }), /出典の数/);
  assert.throws(() => validateSlide({ ...slide(), items: [{ label: 'A', refs: [0] }] }), /出典番号/);
  assert.deepEqual(validateSlide(slide()).items[0].refs, [1]);
  const template = templateToTheme(parseThemeXml(themeXml, 'x'));
  const deck = validateDeck({
    id: 'd',
    title: '報告',
    mode: 'reading',
    themeId: 'template',
    customTheme: template,
    referencesSlide: true,
    slides: [cover, { ...slide(), sources: [], items: [{ label: 'A' }] }],
  });
  assert.equal(deck.themeId, 'template');
  assert.equal(deck.customTheme!.accent, template.accent);
  assert.equal(deck.referencesSlide, true);
  assert.throws(() => validateDeck({ ...deck, customTheme: { ...template, accent: 'red' } }), /色/);
  assert.throws(() => validateDeck({ ...deck, customTheme: { ...template, font: '<script>' } }), /書体/);
  assert.throws(() => validateDeck({ ...deck, customTheme: undefined }), /会社テンプレート/);
});

test('source check: numbers on the slide are matched exactly against the cited text', () => {
  assert.equal(canonicalNumber('1,200'), '1200');
  assert.equal(canonicalNumber('12.50%'), '12.5');
  assert.deepEqual(numbersIn('△3と1.2e3'), ['-3', '1200']);
  const documents = [
    {
      id: 'd1',
      name: '売上.xlsx',
      sources: [
        { locator: 'Sheet1!行 2', text: 'A2="東日本" | B2="1200" | C2="12.5%"' },
        { locator: 'Sheet1!行 3', text: 'A3="西日本" | B3="980"' },
        { locator: 'Sheet1!行 9', text: 'A9="合計" | B9="2180"' },
      ],
    },
  ];
  const report = auditSlide({ ...slide(), body: '合計2,180万円、目標は3,000万円。3つの地域で比較' }, documents);
  const status = Object.fromEntries(report.numbers.map(n => [n.value, n.status]));
  assert.equal(status['1,200'], 'matched');
  assert.equal(status['980'], 'matched');
  assert.equal(status['12.5%'], 'matched');
  assert.equal(status['2,180'], 'uncited', 'present in the document but not cited on this slide');
  assert.equal(status['3,000'], 'unmatched');
  assert.equal(status['3'], undefined, 'single-digit counts are not checked');
  assert.equal(report.sources[0].excerpt, documents[0].sources[0].text);
  assert.equal(
    auditSlide({ ...slide(), sources: [{ documentId: 'gone', locator: 'p.1' }], items: [{ label: 'A' }] }, documents)
      .sources[0].missing,
    true,
  );
  // Cell addresses are not data; an Excel percent format counts as the shown value.
  const excel = [
    {
      id: 'x',
      name: '売上.xlsx',
      sources: [
        { locator: '売上!行 2', text: 'A2="東日本" | B2="1200" | C2="0.125 (表示形式: 0.0%)"' },
        { locator: '売上!行 3', text: 'A3="西日本" | C3="0.02"' },
      ],
    },
  ];
  const cells = auditSlide(
    {
      ...slide(),
      items: [
        { label: '東日本', value: '12.5%' },
        { label: '西日本', value: '2%' },
      ],
      sources: [
        { documentId: 'x', locator: '売上!行 2' },
        { documentId: 'x', locator: '売上!行 3' },
      ],
    },
    excel,
  );
  assert.deepEqual(
    cells.numbers.map(n => [n.value, n.status]),
    [
      ['12.5%', 'matched'],
      ['2%', 'unmatched'],
    ],
  );
});

test('presentation prep: time split keeps the exact total and favors content-heavy slides', () => {
  const slides = [
    { id: 's1', title: '表紙', text: '' },
    { id: 's2', title: '背景', text: '短い' },
    { id: 's3', title: '詳細', text: '長い説明'.repeat(80) },
  ];
  const seconds = allocateTime(slides, 300);
  assert.equal(
    seconds.reduce((a, b) => a + b, 0),
    300,
  );
  assert.ok(seconds[0] < seconds[1] && seconds[1] < seconds[2]);
  assert.ok(seconds.every(s => s % 5 === 0));
  assert.equal(
    rescaleSeconds([1, 1, 1], 600).reduce((a, b) => a + b, 0),
    600,
  );
  const plan = localRehearsal(slides, 300);
  assert.equal(plan.generated, 'local');
  assert.equal(plan.slides.length, 3);
});

async function setup(provider: 'demo' | 'chat' | 'local', providerFactory?: () => Provider) {
  const directory = await mkdtemp(path.join(tmpdir(), 'designer-v012-'));
  const projects = await new ProjectStore(directory).load(),
    settings = await new SettingsStore(directory, '').load();
  await settings.update({
    provider,
    slideCount: 4,
    mode: 'reading',
    ...(provider === 'local' ? { endpoint: 'http://127.0.0.1:11434/v1', model: 'test' } : {}),
  });
  const rendered: DeckSpec[] = [];
  const render = async (deck: DeckSpec, id: string) => {
    rendered.push(deck);
    return {
      artifactId: id,
      pptxUrl: `/api/artifacts/${id}/presentation.pptx`,
      thumbnails: [],
      warnings: [],
      native: false,
    };
  };
  const factory =
    providerFactory ??
    (() => {
      throw new Error('no AI in this test');
    });
  const engine = new SessionEngine({ settings, projects, dataDir: directory, render, providerFactory: factory });
  const assist = new AssistService({ settings, projects, providerFactory: factory, render });
  return { directory, projects, settings, engine, assist, rendered };
}
const openSlide = {
  title: '導入の進め方',
  shapes: [
    { id: '10', name: 'Title', text: '導入の進め方' },
    {
      id: '11',
      name: 'Body',
      text: '現状を調査する。担当者に聞き取りを行う。\n試験導入を2拠点で行う。結果を比較する。\n全社に展開する。運用ルールを整える。\n売上 1,200\n費用 800',
    },
  ],
};

test('selected-slide actions (sample): diagram slide, chart slide, in-place summary; no AI call', async () => {
  const { directory, assist, rendered } = await setup('demo');
  try {
    const visual = await assist.start({ task: 'slide-visualize', slide: openSlide });
    assert.equal(visual.status, 'done');
    assert.equal(visual.result!.kind, 'slide');
    const render = await assist.render(visual.requestId);
    assert.match(render.pptxUrl, /presentation\.pptx$/);
    assert.equal(rendered[0].pageNumbers, false);
    assert.equal(rendered[0].slides.length, 1);
    const chart = await assist.start({ task: 'slide-chart', slide: openSlide });
    assert.deepEqual(chart.result!.kind === 'slide' && chart.result!.slide.chart!.series[0].values, [1200, 800]);
    const summary = await assist.start({ task: 'slide-summarize', slide: openSlide });
    assert.equal(summary.result!.kind, 'summary');
    if (summary.result!.kind === 'summary')
      for (const shape of summary.result!.shapes) assert.ok(shape.text.length < shape.before.length);
    await assert.rejects(
      assist.start({ task: 'slide-visualize', slide: { shapes: [{ id: '1', text: '  ' }] } }),
      /文章がありません/,
    );
    await assert.rejects(assist.start({ task: 'unknown', slide: openSlide }), /種類/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('selected-slide actions (chat handoff): the reply is validated and a corrected instruction is offered', async () => {
  const { directory, assist } = await setup('chat');
  try {
    const started = await assist.start({ task: 'slide-summarize', slide: openSlide });
    assert.equal(started.status, 'handoff');
    assert.match(started.handoff!.instruction, /配置・書式を変えずに短く要約/);
    assert.match(started.handoff!.instruction, /試験導入を2拠点/);
    const invented = await assist.respond(
      started.requestId,
      JSON.stringify({ shapes: [{ id: '11', text: '試験導入を5拠点で行う。' }] }),
    );
    assert.equal(invented.status, 'handoff');
    assert.match(invented.handoff!.validationIssues![0], /元の文章にない数値（5/);
    assert.match(invented.handoff!.instruction, /元の文章にない数値/);
    const longer = await assist.respond(
      started.requestId,
      JSON.stringify({ shapes: [{ id: '10', text: '導入の進め方について詳しく説明します' }] }),
    );
    assert.match(longer.handoff!.validationIssues![0], /元より長く/);
    const done = await assist.respond(
      started.requestId,
      '```json\n{"shapes":[{"id":"11","text":"調査→2拠点で試験→全社展開\\n売上 1,200\\n費用 800"}]}\n```',
    );
    assert.equal(done.status, 'done');
    const chart = await assist.start({ task: 'slide-chart', slide: openSlide });
    const fake = await assist.respond(
      chart.requestId,
      JSON.stringify({
        id: 'slide-2',
        title: '売上と費用',
        layoutId: 'chart_spacious',
        items: [],
        notes: '',
        sources: [],
        chart: { type: 'column', categories: ['売上', '費用'], series: [{ name: '金額', values: [1200, 900] }] },
      }),
    );
    assert.match(fake.handoff!.validationIssues![0], /元のスライドにない数値（900/);
    const table = await assist.respond(
      chart.requestId,
      JSON.stringify({
        id: 'slide-2',
        title: '売上と費用',
        layoutId: 'summary',
        items: [{ label: '売上' }],
        notes: '',
        sources: [],
      }),
    );
    assert.match(table.handoff!.validationIssues![0], /使えない構図/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('presentation prep (local LLM): one automatic correction, exact total, notes applied to the deck', async () => {
  const replies = [
    {
      slides: [
        { id: 'slide-1', seconds: 30, notes: 'はじめに。' },
        { id: 'slide-2', seconds: 90, notes: '売上は5,000万円です。' },
      ],
      questions: [],
    },
    {
      slides: [
        { id: 'slide-1', seconds: 30, notes: 'はじめに、目的を話します。' },
        { id: 'slide-2', seconds: 90, notes: '東日本は1,200万円で、約30秒で説明します。' },
      ],
      questions: [{ question: '前年との比較は？', answer: '資料に記載がないため確認が必要です。' }],
    },
  ];
  const requests: string[] = [];
  const provider: Provider = {
    complete: async request => {
      requests.push(request.content);
      return {
        text: JSON.stringify(replies.shift()),
        usage: { calls: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const { directory, assist, engine, settings } = await setup('local', () => provider);
  try {
    const result = await assist.start({
      task: 'rehearsal',
      minutes: 2,
      slides: [
        { id: 'slide-1', title: '報告', text: '' },
        { id: 'slide-2', title: '売上', text: '東日本 1,200万円' },
      ],
    });
    assert.equal(requests.length, 2);
    assert.match(requests[1], /スライドにない数値（5,000/);
    assert.equal(result.result!.kind, 'rehearsal');
    if (result.result!.kind !== 'rehearsal') return;
    const plan = result.result!.plan;
    assert.equal(plan.generated, 'ai');
    assert.equal(
      plan.slides.reduce((sum, s) => sum + s.seconds, 0),
      120,
    );
    assert.ok(plan.slides[1].seconds > plan.slides[0].seconds);
    assert.equal(plan.questions.length, 1);
    await assert.rejects(
      assist.start({ task: 'rehearsal', minutes: 0, slides: [{ id: 'a', title: 'x', text: '' }] }),
      /発表時間/,
    );

    await settings.update({ provider: 'demo' });
    const session = await engine.create({ prompt: 'ノート反映の確認' }, []);
    await engine.message(session.id, 'おまかせ');
    await engine.generate(session.id);
    const deck = engine.get(session.id).variants[0].deck;
    const updated = await engine.applyNotes(session.id, {
      notes: [{ slideId: deck.slides[1].id, notes: 'ここで要点を話します。' }],
    });
    const notes = updated.variants[0].deck.slides[1].notes;
    assert.match(notes, /^【話す内容】\nここで要点を話します。/);
    assert.match(notes, /【補足】/, 'earlier notes are kept');
    const again = await engine.applyNotes(session.id, {
      notes: [{ slideId: deck.slides[1].id, notes: '言い直します。' }],
    });
    assert.equal(
      (again.variants[0].deck.slides[1].notes.match(/【話す内容】/g) ?? []).length,
      1,
      're-applying replaces the script',
    );
    await assert.rejects(engine.applyNotes(session.id, { notes: [{ slideId: 'nope', notes: 'x' }] }), /見つかりません/);
    const withList = await engine.setReferencesSlide(session.id, { enabled: true });
    assert.equal(withList.variants[0].deck.referencesSlide, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('company template per project: generation, theme switch, favorites and team sharing', async () => {
  const { directory, projects, settings, engine } = await setup('demo');
  try {
    const template = parseThemeXml(themeXml, 'contoso.potx');
    const project = projects.list()[0];
    await engine.setProjectTemplate(project.id, template);
    await assert.rejects(
      engine.setProjectTemplate(project.id, { ...template, colors: { ...template.colors, accent1: 'red' } }),
      /accent1/,
    );
    await settings.update({ themeId: 'template' });
    const session = await engine.create({ prompt: 'テンプレート適用の確認' }, []);
    await engine.message(session.id, 'おまかせ');
    const ready = await engine.generate(session.id);
    const deck = ready.variants[0].deck;
    assert.equal(deck.themeId, 'template');
    assert.equal(deck.customTheme!.font, 'Meiryo');
    assert.equal(compileDeck(deck).theme.accent, '#C00000');
    const switched = await engine.changeTheme(session.id, { variantId: ready.variants[0].id, themeId: 'paper' });
    assert.equal(switched.variants[0].deck.customTheme, undefined);
    const back = await engine.changeTheme(session.id, { variantId: ready.variants[0].id, themeId: 'template' });
    assert.equal(back.variants[0].deck.themeId, 'template');
    await engine.saveDesign(session.id, { variantId: ready.variants[0].id, name: '会社の見た目' });
    const pack = (await engine.exportDesignPack(project.id)) as any;
    assert.deepEqual(pack.template.colors, template.colors);
    assert.equal(pack.designs[0].themeId, 'template');
    assert.doesNotMatch(JSON.stringify(pack), /テンプレート適用の確認/);
    const team = await engine.createProject({ name: 'チーム' });
    assert.deepEqual(await engine.importDesignPack(team.id, pack), { imported: 1, template: true });
    assert.equal(projects.get(team.id).template!.name, 'Contoso & Co');
    const onlyTemplate = await engine.createProject({ name: 'テンプレートだけ' });
    assert.deepEqual(await engine.importDesignPack(onlyTemplate.id, { ...pack, designs: [] }), {
      imported: 0,
      template: true,
    });
    await engine.setProjectTemplate(project.id, null);
    await assert.rejects(
      engine.changeTheme(session.id, { variantId: ready.variants[0].id, themeId: 'template' }),
      /会社テンプレート/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('route table: assist and template endpoints are reachable without Express', async () => {
  const { directory, projects, settings, engine, assist } = await setup('demo');
  try {
    const routes = apiRoutes({
      engine,
      settings,
      projects,
      assist,
      documents: new Map(),
      nativeAvailable: () => false,
      hosted: true,
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const match = matchRoute(routes, method, url);
      assert.ok(match, `${method} ${url}`);
      return match.route.handler({ params: match.params, query: {}, body });
    };
    assert.equal(((await call('GET', '/status')) as any).hosted, true);
    const subscriptions = (await call('GET', '/subscriptions')) as any;
    assert.equal(subscriptions.services[0].canConnect, false);
    await assert.rejects(
      Promise.resolve().then(() => call('PUT', '/settings', { provider: 'subscription' })),
      /ブラウザ版/,
    );
    const started = (await call('POST', '/assist', { task: 'slide-visualize', slide: openSlide })) as any;
    assert.equal(started.status, 'done');
    assert.ok(matchRoute(routes, 'POST', `/assist/${started.requestId}/render`));
    assert.equal(matchRoute(routes, 'GET', '/sessions/abc/sources')?.params.id, 'abc');
    assert.equal(matchRoute(routes, 'GET', '/sessions/abc/unknown'), undefined);
    const project = projects.list()[0];
    const saved = (await call('PUT', `/projects/${project.id}/template`, {
      template: parseThemeXml(themeXml, 'x'),
    })) as any;
    assert.equal(saved.template.name, 'Contoso & Co');
    assert.equal(((await call('DELETE', `/projects/${project.id}/template`)) as any).template, undefined);
    assert.throws(
      () =>
        validateAssistInput(
          {
            task: 'slide-summarize',
            slide: { shapes: Array.from({ length: 41 }, (_, i) => ({ id: String(i), text: 'x' })) },
          },
          settings.get(),
          projects,
        ),
      /図形が多すぎます/,
    );
    assert.throws(
      () =>
        acceptAssistResponse(
          validateAssistInput({ task: 'slide-summarize', slide: openSlide }, settings.get(), projects),
          { shapes: [{ id: '99', text: 'x' }] },
        ),
      /存在しない図形ID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
