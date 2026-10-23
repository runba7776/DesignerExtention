import type { Theme } from './contracts';
export function mixColor(foreground: string, background: string, weight: number): string {
  const channel = (color: string, i: number) => parseInt(color.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    '#' +
    [0, 1, 2]
      .map(i =>
        Math.round(channel(foreground, i) * weight + channel(background, i) * (1 - weight))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}
export function luminance(color: string) {
  const rgb = [0, 1, 2]
    .map(i => parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function readableColor(color: string, background: string) {
  if (contrast(color, background) >= 4.5) return color;
  return contrast('#18232F', background) > contrast('#FFFFFF', background) ? '#18232F' : '#FFFFFF';
}
const isDark = (theme: Theme) => luminance(theme.background) < 0.15;
/** A quiet neutral surface shared by every card. Cards are separated by space and
 * position, not by a rotating rainbow of tints. */
export function panelFill(theme: Theme, _index = 0) {
  return mixColor(theme.foreground, theme.background, isDark(theme) ? 0.1 : 0.045);
}
/** Every item uses the one brand colour: colour marks emphasis and sign, never an
 * arbitrary category that the content does not have. */
export function itemColor(theme: Theme, _index = 0) {
  return readableColor(readableColor(theme.accent, theme.background), panelFill(theme));
}
/** Colour for a decrease or loss (△1,900億円, -8.8%), readable on cards and background. */
export function negativeColor(theme: Theme) {
  const color = isDark(theme) ? '#FF9E94' : '#B3261E';
  return contrast(color, panelFill(theme)) >= 4.5 ? color : readableColor(color, theme.background);
}
/** Hairline for separators that should structure, not decorate. */
export function ruleColor(theme: Theme) {
  return mixColor(theme.foreground, theme.background, isDark(theme) ? 0.28 : 0.16);
}
