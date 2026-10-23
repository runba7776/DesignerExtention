import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/projects.js';
import { DesignLibraryStore } from '../server/design-library.js';
import { SettingsStore } from '../server/settings.js';
import { SessionEngine } from '../server/engine.js';
import { demoDeck, demoOutline } from '../server/demo.js';

test('projects keep guidance local and design sharing exports only reusable visual settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'designer-project-sharing-'));
  try {
    const projects = await new ProjectStore(directory).load(),
      settings = await new SettingsStore(directory, '').load();
    const source = await projects.create({
      name: 'Quarterly Review',
      audience: 'SENSITIVE_AUDIENCE',
      guidance: 'SENSITIVE_PROJECT_GUIDANCE',
    });
    await settings.update({ activeProjectId: source.id });
    const library = new DesignLibraryStore(directory),
      deck = demoDeck(demoOutline('PRIVATE_PRESENTATION_TITLE', 'presentation', [], 6));
    await library.save(deck, {
      name: 'Clean comparison',
      projectId: source.id,
      thumbnail: '/api/artifacts/private-preview/slide-1.png',
    });
    const pack = await library.exportPack(source.id),
      serialized = JSON.stringify(pack);
    assert.equal(pack.format, 'designer-extension-design-set');
    assert.doesNotMatch(
      serialized,
      /SENSITIVE_AUDIENCE|SENSITIVE_PROJECT_GUIDANCE|PRIVATE_PRESENTATION_TITLE|private-preview|thumbnail/,
    );
    assert.deepEqual(Object.keys(pack.designs[0] as object).sort(), ['layoutIds', 'mode', 'name', 'themeId', 'votes']);

    const target = await projects.create({ name: 'Seminar', audience: '別の読者', guidance: '別の方針' });
    assert.deepEqual(await library.importPack(target.id, pack), { imported: 1 });
    const imported = (await library.list(target.id)).entries;
    assert.equal(imported.length, 1);
    assert.notEqual(imported[0].id, (await library.list(source.id)).entries[0].id);
    assert.equal(imported[0].thumbnail, undefined);
    assert.equal((await library.list(source.id)).entries.length, 1);
    await assert.rejects(
      library.importPack(target.id, {
        ...pack,
        designs: [pack.designs[0], { ...pack.designs[0], layoutIds: ['not-a-layout'] }],
      }),
      /構図/,
    );
    assert.equal((await library.list(target.id)).entries.length, 1, 'invalid packs do not partially import');
    assert.equal((await new SettingsStore(directory, '').load()).get().activeProjectId, source.id);
    const profile = JSON.parse(await readFile(path.join(directory, 'projects.json'), 'utf8'));
    assert.equal(profile.projects.find((p: any) => p.id === source.id).guidance, 'SENSITIVE_PROJECT_GUIDANCE');

    await settings.update({ provider: 'demo', activeProjectId: source.id, slideCount: 3 });
    const engine = new SessionEngine({
      settings,
      projects,
      dataDir: directory,
      providerFactory: () => {
        throw new Error('Project tests must not call an AI provider');
      },
      render: async () => ({
        artifactId: 'project-test',
        pptxUrl: '/api/artifacts/project-test/presentation.pptx',
        thumbnails: [],
        native: false,
        warnings: [],
      }),
    });
    async function makePresentation() {
      const session = await engine.create({ prompt: 'プロジェクト分離を確認' }, []);
      await engine.message(session.id, 'おまかせ');
      await engine.generate(session.id);
      return session;
    }
    const sourcePresentation = await makePresentation();
    assert.equal(sourcePresentation.projectId, source.id);
    await settings.update({ activeProjectId: target.id });
    const targetPresentation = await makePresentation();
    assert.equal(targetPresentation.projectId, target.id);
    assert.equal((await engine.listHistory(source.id)).entries.length, 1);
    assert.equal((await engine.listHistory(target.id)).entries.length, 1);
    assert.equal((await engine.listDesigns(source.id)).entries.length, 1);
    assert.equal((await engine.listDesigns(target.id)).entries.length, 1);
    await settings.update({ provider: 'chat' });
    const chatSession = await engine.create({ prompt: '方針の継承を確認' }, []);
    assert.match(chatSession.chatHandoff!.instruction, /別の読者/);
    assert.match(chatSession.chatHandoff!.instruction, /別の方針/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
