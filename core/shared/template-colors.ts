/** Theme color slots read from a PowerPoint theme (a:clrScheme). */
export const templateColorKeys = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
] as const;
export function isTemplateColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9A-F]{6}$/.test(value);
}
