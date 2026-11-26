import JSZip from 'jszip';
import type { TemplateTheme } from './contracts';
export { templateToTheme } from './template-style';

export { TEMPLATE_THEME_ID } from './themes';
import { templateColorKeys as COLOR_KEYS } from './template-colors';
export { isTemplateColor, templateColorKeys } from './template-colors';

function element(xml: string, name: string) {
  return new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml)?.[1];
}
function attribute(xml: string, tag: string, name: string) {
  return new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml)?.[1];
}
function decode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function color(xml: string | undefined) {
  if (!xml) return undefined;
  const value = attribute(xml, 'srgbClr', 'val') ?? attribute(xml, 'sysClr', 'lastClr');
  return value && /^[0-9a-fA-F]{6}$/.test(value) ? '#' + value.toUpperCase() : undefined;
}
function fontSet(xml: string | undefined) {
  if (!xml) return { latin: undefined, ea: undefined };
  const latin = attribute(xml, 'latin', 'typeface'),
    ea = attribute(xml, 'ea', 'typeface');
  const japanese =
    /<(?:\w+:)?font\b[^>]*\sscript="Jpan"[^>]*\stypeface="([^"]*)"/.exec(xml)?.[1] ??
    /<(?:\w+:)?font\b[^>]*\stypeface="([^"]*)"[^>]*\sscript="Jpan"/.exec(xml)?.[1];
  const clean = (value?: string) =>
    value && value.trim() && !value.startsWith('+') ? decode(value.trim()).slice(0, 64) : undefined;
  return { latin: clean(latin), ea: clean(ea) ?? clean(japanese) };
}

/** Reads only the color and font scheme of the first slide master's theme. */
export function parseThemeXml(xml: string, source: string, now = new Date()): TemplateTheme {
  const scheme = element(xml, 'clrScheme');
  if (!scheme) throw new Error('テーマの配色が見つかりません。');
  const colors = {} as TemplateTheme['colors'];
  for (const key of COLOR_KEYS) {
    const value = color(element(scheme, key));
    if (!value) throw new Error(`テーマの色（${key}）を読み取れません。`);
    colors[key] = value;
  }
  const fonts = element(xml, 'fontScheme'),
    major = fontSet(element(fonts ?? '', 'majorFont')),
    minor = fontSet(element(fonts ?? '', 'minorFont'));
  const name =
    decode(attribute(xml, 'theme', 'name') ?? attribute(xml, 'clrScheme', 'name') ?? 'テンプレート').slice(0, 80) ||
    'テンプレート';
  return {
    name,
    source: source.slice(0, 120),
    colors,
    fonts: {
      major: major.latin ?? minor.latin ?? 'Yu Gothic',
      minor: minor.latin ?? major.latin ?? 'Yu Gothic',
      ...(major.ea ? { majorEa: major.ea } : {}),
      ...(minor.ea ? { minorEa: minor.ea } : {}),
    },
    importedAt: now.toISOString(),
  };
}

/** Accepts PPTX/POTX bytes (a file or Office.js getFileAsync). Nothing is executed. */
export async function extractTemplateTheme(bytes: Uint8Array | ArrayBuffer, source: string): Promise<TemplateTheme> {
  const zip = await JSZip.loadAsync(bytes);
  if (Object.keys(zip.files).some(name => /vbaProject\.bin$/i.test(name)))
    throw new Error('マクロを含むファイルは読み込みません。.pptx または .potx を使用してください。');
  const read = async (name: string) => {
    const file = zip.file(name);
    if (!file) return undefined;
    if (((file as any)._data?.uncompressedSize ?? 0) > 4 * 1024 * 1024) throw new Error('テーマの部品が大きすぎます。');
    return file.async('string');
  };
  let themeName = 'ppt/theme/theme1.xml';
  // Follow presentation -> first slide master -> theme, falling back to theme1.
  const presentation = await read('ppt/presentation.xml'),
    presentationRels = await read('ppt/_rels/presentation.xml.rels');
  const masterId = presentation ? /<(?:\w+:)?sldMasterId\b[^>]*\sr:id="([^"]+)"/.exec(presentation)?.[1] : undefined;
  const target = (rels: string | undefined, predicate: (attrs: string) => boolean) => {
    for (const match of rels?.matchAll(/<Relationship\b([^>]*)\/?>/g) ?? []) {
      if (predicate(match[1])) return /\sTarget="([^"]+)"/.exec(match[1])?.[1];
    }
    return undefined;
  };
  const masterTarget = masterId ? target(presentationRels, attrs => attrs.includes(`Id="${masterId}"`)) : undefined;
  if (masterTarget) {
    const masterPath = new URL(masterTarget, 'https://package/ppt/presentation.xml').pathname.slice(1);
    const masterRels = await read(masterPath.replace(/([^/]+)$/, '_rels/$1.rels'));
    const themeTarget = target(masterRels, attrs => /relationships\/theme"/.test(attrs));
    if (themeTarget) themeName = new URL(themeTarget, `https://package/${masterPath}`).pathname.slice(1);
  }
  const xml = (await read(themeName)) ?? (await read('ppt/theme/theme1.xml'));
  if (!xml) throw new Error('PowerPointのテーマが見つかりません。.pptx または .potx を選んでください。');
  return parseThemeXml(xml, source);
}
