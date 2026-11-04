/** The outline of a PowerPoint preset shape with its default adjustments in its w×h box, as x, y pairs: the browser
 * clips an HTML element marked data-shape to it and the preview draws it, so both show what PowerPoint draws.
 * Self-contained: the browser runs this function's own source. */
export function presetOutline(shape: string, w: number, h: number): number[] | undefined {
  const s = Math.min(w, h),
    m = w / 2,
    c = h / 2,
    a = s / 2,
    q = s / 4,
    o = s * 0.29289;
  switch (shape) {
    case 'triangle':
      return [m, 0, w, h, 0, h];
    case 'diamond':
      return [m, 0, w, c, m, h, 0, c];
    case 'arrow':
      return [0, h / 4, w - a, h / 4, w - a, 0, w, c, w - a, h, w - a, (h * 3) / 4, 0, (h * 3) / 4];
    case 'leftArrow':
      return [w, h / 4, a, h / 4, a, 0, 0, c, a, h, a, (h * 3) / 4, w, (h * 3) / 4];
    case 'upArrow':
      return [w / 4, h, w / 4, a, 0, a, m, 0, w, a, (w * 3) / 4, a, (w * 3) / 4, h];
    case 'downArrow':
      return [w / 4, 0, w / 4, h - a, 0, h - a, m, h, w, h - a, (w * 3) / 4, h - a, (w * 3) / 4, 0];
    case 'chevron':
      return [0, 0, w - a, 0, w, c, w - a, h, 0, h, a, c];
    case 'pentagon':
      return [0, 0, w - a, 0, w, c, w - a, h, 0, h];
    case 'hexagon':
      return [0, c, q, 0, w - q, 0, w, c, w - q, h, q, h];
    case 'parallelogram':
      return [0, h, q, 0, w, 0, w - q, h];
    case 'trapezoid':
      return [0, h, q, 0, w - q, 0, w, h];
    case 'octagon':
      return [0, o, o, 0, w - o, 0, w, o, w, h - o, w - o, h, o, h, 0, h - o];
  }
}
