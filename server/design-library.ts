import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DeckSpec, DesignEntry } from '../shared/contracts.js';
import { MAX_SLIDES } from '../shared/contracts.js';
import { listLayouts } from '../shared/layouts.js';
import { themes, TEMPLATE_THEME_ID } from '../shared/themes.js';
import { AI_THEME_ID } from '../shared/ai-theme.js';
import { validateCustomTheme } from './validation.js';
import { typographyProfiles } from '../shared/typography.js';
import { AppError, requireText } from './errors.js';
import { DEFAULT_PROJECT_ID } from './projects.js';

export type DesignRecord = DesignEntry;
export interface SaveDesignOptions {
  name?: string;
  thumbnail?: string;
  slideId?: string;
  projectId?: string;
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const MAX_ENTRIES = 500,
  MAX_BYTES = 32 * 1024,
  MAX_VOTES = 10_000;
const supportedLayouts = new Set(listLayouts().map(layout => layout.id));
function thumbnail(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\/api\/artifacts\/[a-zA-Z0-9-]{1,100}\/slide-[1-9]\d{0,2}\.png$/.test(value))
    throw new AppError(422, 'デザインのプレビュー参照が正しくありません。', 'INVALID_DESIGN');
  return value;
}
function checked(value: any): DesignRecord {
  if (
    !value ||
    !validId(value.id) ||
    !['presentation', 'reading'].includes(value.mode) ||
    typeof value.themeId !== 'string' ||
    (value.themeId !== TEMPLATE_THEME_ID &&
      !(value.themeId === AI_THEME_ID && value.palette) &&
      !Object.hasOwn(themes, value.themeId)) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Number.isInteger(value.votes) ||
    value.votes < 0 ||
    value.votes > MAX_VOTES
  )
    throw new AppError(422, '保存デザインの形式を読み取れません。', 'INVALID_DESIGN');
  if (
    value.typographyId !== undefined &&
    (typeof value.typographyId !== 'string' || !Object.hasOwn(typographyProfiles, value.typographyId))
  )
    throw new AppError(422, '保存デザインの書体が登録されていません。', 'INVALID_DESIGN');
  if (
    !Array.isArray(value.layoutIds) ||
    !value.layoutIds.length ||
    value.layoutIds.length > MAX_SLIDES ||
    value.layoutIds.some((id: unknown) => typeof id !== 'string' || !supportedLayouts.has(id))
  )
    throw new AppError(422, '保存デザインの構図が登録されていません。', 'INVALID_DESIGN');
  const preview = thumbnail(value.thumbnail);
  // Construct an allowlist record. Slide text, data, source files and credentials never enter this store.
  const projectId = value.projectId ?? DEFAULT_PROJECT_ID;
  if (!validId(projectId))
    throw new AppError(422, '保存デザインのプロジェクト情報が正しくありません。', 'INVALID_DESIGN');
  return {
    id: value.id,
    name: requireText(value.name, 'デザイン名', 100),
    mode: value.mode,
    themeId: value.themeId,
    ...(value.themeId === AI_THEME_ID ? { palette: validateCustomTheme(value.palette) } : {}),
    ...(value.typographyId !== undefined ? { typographyId: value.typographyId } : {}),
    layoutIds: [...value.layoutIds],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    votes: value.votes,
    projectId,
    ...(preview ? { thumbnail: preview } : {}),
  };
}
const fingerprint = (
  record: Pick<DesignRecord, 'projectId' | 'mode' | 'themeId' | 'typographyId' | 'layoutIds' | 'palette'>,
) =>
  JSON.stringify([
    record.projectId,
    record.mode,
    record.themeId,
    record.typographyId ?? null,
    record.layoutIds,
    record.palette
      ? [record.palette.background, record.palette.foreground, record.palette.accent, record.palette.secondary]
      : null,
  ]);

/** Local preferences only. Votes are reusable guidance, not model training. */
export class DesignLibraryStore {
  private directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) {
    this.directory = path.resolve(dataDir, 'designs');
  }
  private file(id: string) {
    if (!validId(id)) throw new AppError(400, 'デザインIDが正しくありません。', 'INVALID_DESIGN');
    return path.join(this.directory, id + '.json');
  }
  private async directoryExists(create = false) {
    let stat;
    try {
      stat = await lstat(this.directory);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(this.directory, { recursive: true });
      stat = await lstat(this.directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AppError(422, 'デザインの保存先を読み取れません。', 'INVALID_DESIGN');
    return true;
  }
  async load(id: string): Promise<DesignRecord> {
    const name = this.file(id);
    if (!(await this.directoryExists())) throw new AppError(404, '保存したデザインが見つかりません。');
    let stat;
    try {
      stat = await lstat(name);
    } catch (error: any) {
      if (error.code === 'ENOENT') throw new AppError(404, '保存したデザインが見つかりません。');
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
      throw new AppError(422, '保存デザインを読み取れません。', 'INVALID_DESIGN');
    try {
      const record = checked(JSON.parse(await readFile(name, 'utf8')));
      if (record.id !== id) throw new Error('ID');
      return record;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(422, '保存デザインが破損しています。', 'INVALID_DESIGN');
    }
  }
  async list(projectId?: string) {
    if (!(await this.directoryExists())) return { entries: [] as DesignEntry[], warnings: [] as string[] };
    const names = (await readdir(this.directory))
      .filter(name => validId(name.slice(0, -5)) && name.endsWith('.json'))
      .slice(0, MAX_ENTRIES);
    const entries: DesignEntry[] = [],
      warnings: string[] = [];
    for (const name of names) {
      try {
        entries.push(await this.load(name.slice(0, -5)));
      } catch {
        warnings.push('読み取れない保存デザインがあります。');
      }
    }
    return {
      entries: entries
        .filter(entry => !projectId || entry.projectId === projectId)
        .sort((a, b) => b.votes - a.votes || b.updatedAt.localeCompare(a.updatedAt)),
      warnings: [...new Set(warnings)],
    };
  }
  save(deck: DeckSpec, options: SaveDesignOptions = {}) {
    return this.serial(async () => {
      if (!deck || !Array.isArray(deck.slides) || !deck.slides.length || deck.slides.length > MAX_SLIDES)
        throw new AppError(422, '保存するデザインのスライドを確認できません。', 'INVALID_DESIGN');
      const selected =
        options.slideId === undefined ? deck.slides : deck.slides.filter(slide => slide.id === options.slideId);
      if (!selected.length || (options.slideId !== undefined && selected.length !== 1))
        throw new AppError(404, '保存するスライドが見つかりません。');
      const now = new Date().toISOString(),
        record = checked({
          id: randomUUID(),
          name:
            options.name ??
            `${deck.themeId === TEMPLATE_THEME_ID ? '会社テンプレート' : deck.themeId === AI_THEME_ID ? 'AIの配色' : (themes[deck.themeId]?.name ?? 'デザイン')} · ${selected.length}枚`,
          mode: deck.mode,
          themeId: deck.themeId,
          ...(deck.themeId === AI_THEME_ID && deck.aiTheme ? { palette: deck.aiTheme } : {}),
          typographyId: deck.typographyId,
          layoutIds: selected.map(slide => slide.layoutId),
          projectId: options.projectId ?? DEFAULT_PROJECT_ID,
          createdAt: now,
          updatedAt: now,
          votes: 1,
          thumbnail: options.thumbnail,
        });
      await this.directoryExists(true);
      const existing = (await this.list(record.projectId)).entries.find(
        entry => fingerprint(entry) === fingerprint(record),
      );
      if (existing) {
        const updated = checked({
          ...existing,
          ...(options.name !== undefined ? { name: record.name } : {}),
          ...(record.thumbnail ? { thumbnail: record.thumbnail } : {}),
          votes: Math.min(MAX_VOTES, existing.votes + 1),
          updatedAt: now,
        });
        await this.write(updated);
        return updated;
      }
      if ((await readdir(this.directory)).filter(name => name.endsWith('.json')).length >= MAX_ENTRIES)
        throw new AppError(413, '保存デザインは500件までです。不要なデザインを削除してください。');
      await this.write(record);
      return record;
    });
  }
  vote(id: string, delta = 1) {
    return this.serial(async () => {
      if (delta !== 1 && delta !== -1) throw new AppError(400, '投票は1回ずつ変更してください。');
      const prior = await this.load(id),
        record = checked({
          ...prior,
          votes: Math.max(0, Math.min(MAX_VOTES, prior.votes + delta)),
          updatedAt: new Date().toISOString(),
        });
      await this.write(record);
      return record;
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      const name = this.file(id);
      if (!(await this.directoryExists())) return;
      let stat;
      try {
        stat = await lstat(name);
      } catch (error: any) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AppError(422, '保存デザインを削除できません。', 'INVALID_DESIGN');
      await unlink(name);
    });
  }
  async exportPack(projectId: string) {
    const entries = (await this.list(projectId)).entries;
    return {
      format: 'designer-extension-design-set',
      schemaVersion: 1,
      designs: entries.map(({ name, mode, themeId, palette, typographyId, layoutIds, votes }) => ({
        name,
        mode,
        themeId,
        ...(palette ? { palette } : {}),
        ...(typographyId ? { typographyId } : {}),
        layoutIds,
        votes,
      })),
    };
  }
  importPack(projectId: string, input: unknown) {
    return this.serial(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new AppError(400, 'デザイン設定ファイルの形式が正しくありません。');
      const pack = input as Record<string, unknown>;
      if (
        pack.format !== 'designer-extension-design-set' ||
        pack.schemaVersion !== 1 ||
        !Array.isArray(pack.designs) ||
        !pack.designs.length ||
        pack.designs.length > 100
      )
        throw new AppError(400, 'このファイルは読み込めないデザイン設定です。');
      if (!validId(projectId)) throw new AppError(400, '保存先プロジェクトを選択してください。');
      const now = new Date().toISOString(),
        records = pack.designs.map((design: any) =>
          checked({
            id: randomUUID(),
            name: design?.name,
            mode: design?.mode,
            themeId: design?.themeId,
            palette: design?.palette,
            typographyId: design?.typographyId,
            layoutIds: design?.layoutIds,
            projectId,
            createdAt: now,
            updatedAt: now,
            votes: design?.votes ?? 0,
          }),
        );
      if (!(await this.directoryExists())) await this.directoryExists(true);
      if ((await readdir(this.directory)).filter(name => name.endsWith('.json')).length + records.length > MAX_ENTRIES)
        throw new AppError(413, '保存デザインは500件までです。不要なデザインを削除してください。');
      for (const record of records) await this.write(record);
      return { imported: records.length };
    });
  }
  private async write(record: DesignRecord) {
    await this.directoryExists(true);
    const name = this.file(record.id);
    try {
      const stat = await lstat(name);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AppError(422, 'デザインの保存先が正しくありません。', 'INVALID_DESIGN');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    const data = JSON.stringify(checked(record));
    if (Buffer.byteLength(data) > MAX_BYTES) throw new AppError(413, '保存するデザイン情報が大きすぎます。');
    const temporary = path.join(this.directory, record.id + '.' + randomUUID() + '.tmp');
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, name);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
