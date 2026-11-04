import type { SceneElement } from './contracts';

// PowerPoint's connection sites in the middles of a shape's top, left, bottom and right sides.
const SITES: Record<string, number[]> = { rect: [1, 2, 3, 4], roundRect: [1, 2, 3, 4], ellipse: [1, 3, 5, 7] };
const iconPart = (group = '') => /(^|\/)i\d+$/.test(group);

/** A line that runs square into the middle of a box's side is glued to that box as a PowerPoint connector, so it
 * stays on the box when the box is moved, and drawn up to the side. An arrow may stop short of the box by a gap. */
export function glueLines(elements: SceneElement[]) {
  const boxes = elements.filter(e => e.kind === 'shape');
  for (const line of elements) {
    if (line.kind !== 'line' || iconPart(line.group)) continue;
    const ends = [
        [line.x, line.flipY ? line.y + line.h : line.y],
        [line.x + line.w, line.flipY ? line.y : line.y + line.h],
      ],
      length = Math.hypot(line.w, line.h),
      reach = line.arrow || line.arrowStart ? 24 : 2;
    if (length < 4) continue;
    ends.forEach((at, i) => {
      // Out of the line at this end.
      const ux = ((i ? 1 : -1) * line.w) / length,
        uy = ((i ? 1 : -1) * (line.flipY ? -line.h : line.h)) / length;
      let best: { shape: number; site: number; gap: number } | undefined;
      boxes.forEach((s, n) => {
        if (s.kind !== 'shape' || !SITES[s.shape] || s.path || s.rotation || iconPart(s.group)) return;
        const sides = [
          [s.x + s.w / 2, s.y, 0, -1],
          [s.x, s.y + s.h / 2, -1, 0],
          [s.x + s.w / 2, s.y + s.h, 0, 1],
          [s.x + s.w, s.y + s.h / 2, 1, 0],
        ];
        sides.forEach(([x, y, nx, ny], k) => {
          const gap = (x - at[0]) * ux + (y - at[1]) * uy;
          if (
            ux * nx + uy * ny < -0.99 &&
            Math.abs((y - at[1]) * ux - (x - at[0]) * uy) <= 1 &&
            gap >= -1 &&
            gap <= reach &&
            (!best || Math.abs(gap) < Math.abs(best.gap))
          )
            best = { shape: n, site: SITES[s.shape][k], gap };
        });
      });
      if (!best) return;
      at[0] += best.gap * ux;
      at[1] += best.gap * uy;
      line[i ? 'to' : 'from'] = { shape: best.shape, site: best.site };
    });
    line.x = Math.min(ends[0][0], ends[1][0]);
    line.y = Math.min(ends[0][1], ends[1][1]);
    line.w = Math.abs(ends[1][0] - ends[0][0]);
    line.h = Math.abs(ends[1][1] - ends[0][1]);
  }
}
