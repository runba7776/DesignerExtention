import type { TemplateTheme, Theme } from './contracts';
import { contrast, mixColor, readableColor } from './color';

/** Builds a readable Designer theme from the company palette and fonts. */
export function templateToTheme(template: TemplateTheme): Theme {
  const c = template.colors,
    background = c.lt1;
  const foreground =
    [c.dk1, c.dk2, '#1F2933'].find(value => contrast(value, background) >= 7) ?? readableColor(c.dk1, background);
  const accents = [c.accent1, c.accent2, c.accent3, c.accent4, c.accent5, c.accent6];
  // Accent colors that vanish on the background are darkened toward the text color.
  const usable = accents.map(value => (contrast(value, background) >= 3 ? value : mixColor(value, foreground, 0.55)));
  const itemColors = [...new Set(usable)].slice(0, 4);
  const body = template.fonts.minorEa ?? template.fonts.minor,
    heading = template.fonts.majorEa ?? template.fonts.major;
  return {
    name: `会社テンプレート（${template.name}）`,
    description: `${template.source}から読み込んだ配色と書体`,
    background,
    foreground,
    muted: mixColor(foreground, background, 0.72),
    accent: usable[0],
    secondary: usable[1] ?? usable[0],
    pale: mixColor(usable[0], background, 0.1),
    font: body,
    headingFont: heading,
    numberFont: template.fonts.minor,
    equationFont: 'Cambria Math',
    itemColors: itemColors.length ? itemColors : [usable[0]],
    panelStyle: 'tint',
    coverStyle: 'band',
    headingStyle: 'rule',
    tableStyle: 'striped',
  };
}
