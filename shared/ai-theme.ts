import type { AiPalette, Theme } from './contracts';
import { contrast, mixColor } from './color';
import { resolveFont, withTypography } from './typography';

/** Theme id of a deck coloured with the palette its AI chose (DeckSpec.aiTheme). */
export const AI_THEME_ID = 'ai';

/** Moves a colour toward black or white (away from the background) only as far as
 * needed to reach the contrast, so the AI's hue is kept. */
function readable(color: string, background: string, minimum: number) {
  if (contrast(color, background) >= minimum) return color;
  const target = contrast('#000000', background) >= contrast('#FFFFFF', background) ? '#000000' : '#FFFFFF';
  for (let weight = 0.1; weight < 1; weight += 0.1) {
    const mixed = mixColor(target, color, weight);
    if (contrast(mixed, background) >= minimum) return mixed;
  }
  return target;
}

/** The AI's palette as a deck theme. Text is kept readable on the background (4.5:1
 * for text and supporting text, 3:1 for the accents used in large type and shapes).
 * Fonts are the AI's own (mapped to fonts Windows/Office provide) unless the user
 * chose a typography profile. */
export function paletteTheme(palette: AiPalette, typographyId?: string): Theme {
  const theme = paletteColors(palette, typographyId);
  if (typographyId || !(palette.headingFont || palette.bodyFont)) return theme;
  const body = resolveFont(palette.bodyFont ?? palette.headingFont, 'Yu Gothic Medium'),
    heading = resolveFont(palette.headingFont ?? palette.bodyFont, 'Yu Gothic');
  return { ...theme, font: body, headingFont: heading, numberFont: heading };
}
function paletteColors(palette: AiPalette, typographyId?: string): Theme {
  const background = palette.background.toUpperCase(),
    foreground = readable(palette.text, background, 4.5);
  const accent = readable(palette.accent, background, 3),
    secondary = readable(palette.accent2, background, 3);
  return withTypography(
    {
      name: palette.name ? `AIの配色（${palette.name}）` : 'AIの配色',
      description: '内容と読み手に合わせてAIが決めた配色',
      background,
      foreground,
      muted: readable(palette.muted, background, 4.5),
      accent,
      secondary,
      pale:
        palette.surface && contrast(foreground, palette.surface) >= 4.5
          ? palette.surface.toUpperCase()
          : mixColor(accent, background, 0.1),
      font: 'Yu Gothic Medium',
      itemColors: [accent, secondary, readable(mixColor(accent, secondary, 0.5), background, 3)],
      panelStyle: 'tint',
      coverStyle: 'band',
      headingStyle: 'rule',
      tableStyle: 'striped',
    },
    typographyId,
  );
}
