import React from 'react';
import type {
  Rect,
  RenderDocument,
  SceneElement,
  ShapeElement,
  SmartArtElement,
  TextElement,
} from '../shared/contracts';
import { tableParts, wrapText } from '../shared/layouts';
import { BLANK } from '../shared/free-design';
import { presetOutline } from '../shared/shape-outline';
import { ChartPreview } from './ChartPreview';

/** The picture's place in its box as SVG has it, from the shares cut off its left, top, right and bottom. */
function photoFit([left, top, right, bottom]: number[] = [0, 0, 0, 0]) {
  const x = left < right ? 'xMin' : left > right ? 'xMax' : 'xMid',
    y = top < bottom ? 'YMin' : top > bottom ? 'YMax' : 'YMid';
  return `${x}${y} slice`;
}
type Part = { text: string; color?: string; bold?: boolean };
/** One drawn line in parts: the coloured or bold parts of a measured text (start: where the line begins in
 * the text), and the blanks still to fill (［実施日］) in their colour. */
function lineParts(element: TextElement, line: string, start?: number): Part[] {
  const styles: { color?: string; bold?: boolean }[] = Array.from({ length: line.length }, () => ({}));
  if (start !== undefined)
    for (const run of element.runs ?? [])
      for (let i = Math.max(run.start, start); i < Math.min(run.start + run.length, start + line.length); i++)
        styles[i - start] = {
          ...styles[i - start],
          ...(run.color ? { color: run.color } : {}),
          ...(run.bold !== undefined ? { bold: run.bold } : {}),
        };
  if (element.blankColor)
    for (const m of line.matchAll(BLANK))
      for (let i = m.index!; i < m.index! + m[0].length; i++) styles[i] = { ...styles[i], color: element.blankColor };
  const parts: Part[] = [];
  for (let i = 0; i < line.length; i++) {
    const style = styles[i],
      last = parts[parts.length - 1];
    if (last && last.color === style.color && last.bold === style.bold) last.text += line[i];
    else parts.push({ text: line[i], ...style });
  }
  return parts;
}

function Text({ element }: { element: TextElement }) {
  const lines = element.noWrap ? element.text.split('\n') : wrapText(element.text, element.w - 8, element.fontSize);
  const starts = element.noWrap
    ? lines.map((_, i) => lines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0))
    : undefined;
  const anchor = element.align === 'center' ? 'middle' : element.align === 'right' ? 'end' : 'start';
  const x = element.x + (anchor === 'middle' ? element.w / 2 : anchor === 'end' ? element.w : 0);
  const used = lines.length * element.fontSize * 1.35,
    offset =
      element.verticalAlign === 'middle'
        ? Math.max(0, (element.h - used) / 2)
        : element.verticalAlign === 'bottom'
          ? Math.max(0, element.h - used)
          : 0;
  return (
    <text
      x={x}
      y={element.y + offset + element.fontSize * 0.91}
      fontStyle={element.italic ? 'italic' : undefined}
      fontSize={element.fontSize}
      fill={element.color}
      fontFamily={
        element.font
          ? `"${element.font}", "${element.fontFarEast ?? element.font}", "Yu Gothic", sans-serif`
          : undefined
      }
      fontWeight={element.bold ? 700 : 400}
      letterSpacing={element.spacing}
      textAnchor={anchor}
    >
      {lines.map((line, i) => (
        <tspan x={x} dy={i ? (element.lineHeight ?? element.fontSize * 1.35) : 0} key={i}>
          {element.runs?.length
            ? lineParts(element, line, starts?.[i]).map((part, j) =>
                part.color || part.bold !== undefined ? (
                  <tspan
                    key={j}
                    fill={part.color}
                    fontWeight={part.bold === undefined ? undefined : part.bold ? 700 : 400}
                  >
                    {part.text}
                  </tspan>
                ) : (
                  part.text
                ),
              )
            : line}
        </tspan>
      ))}
    </text>
  );
}

function SmartArt({ element: e }: { element: SmartArtElement }) {
  const count = e.items.length;
  if (!count) return null;
  const item = (index: number, x: number, y: number, w: number, h: number) => (
    <g key={`item${index}`}>
      <rect x={x} y={y} width={w} height={h} rx="5" fill={e.accent} />
      <Text
        element={{
          kind: 'text',
          x: x + 10,
          y: y + 13,
          w: w - 20,
          h: h - 20,
          text: e.items[index].label,
          fontSize: e.fontSize,
          color: e.color,
          bold: true,
          align: 'center',
        }}
      />
      {e.items[index].description && (
        <Text
          element={{
            kind: 'text',
            x: x + 10,
            y: y + h * 0.53,
            w: w - 20,
            h: h * 0.44,
            text: e.items[index].description!,
            fontSize: Math.max(11, e.fontSize - 4),
            color: e.color,
            align: 'center',
          }}
        />
      )}
    </g>
  );
  if (e.layout === 'cycle') {
    const radius = Math.min(e.w * 0.3, e.h * 0.32),
      cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      w = Math.min(150, e.w * 0.27),
      h = 70;
    const points = e.items.map((_, i) => ({
      x: cx + Math.cos((i / count) * Math.PI * 2 - Math.PI / 2) * radius,
      y: cy + Math.sin((i / count) * Math.PI * 2 - Math.PI / 2) * radius,
    }));
    return (
      <g>
        {points.map((p, i) => (
          <line
            key={`line${i}`}
            x1={p.x}
            y1={p.y}
            x2={points[(i + 1) % count].x}
            y2={points[(i + 1) % count].y}
            stroke={e.accent}
            strokeWidth="2"
          />
        ))}
        {points.map((p, i) => item(i, p.x - w / 2, p.y - h / 2, w, h))}
      </g>
    );
  }
  if (e.layout === 'hierarchy') {
    const rootW = Math.min(230, e.w * 0.38),
      childW = Math.min(190, (e.w - 12 * (count - 2)) / Math.max(1, count - 1));
    const topX = e.x + (e.w - rootW) / 2,
      topY = e.y + 12,
      childY = e.y + e.h * 0.55,
      childH = Math.min(100, e.h * 0.38);
    return (
      <g>
        <line x1={e.x + e.w / 2} y1={topY + 75} x2={e.x + e.w / 2} y2={childY - 20} stroke={e.accent} />
        {e.items.slice(1).map((_, i) => {
          const x = e.x + (e.w * (i + 0.5)) / (count - 1) - childW / 2;
          return (
            <g key={i}>
              <path
                d={`M${e.x + e.w / 2} ${childY - 20} H${x + childW / 2} V${childY}`}
                fill="none"
                stroke={e.accent}
              />
              {item(i + 1, x, childY, childW, childH)}
            </g>
          );
        })}
        {item(0, topX, topY, rootW, 75)}
      </g>
    );
  }
  const columns = e.layout === 'list' ? Math.min(count, 3) : count;
  const rows = Math.ceil(count / columns),
    gap = e.layout === 'list' ? 18 : 25,
    w = (e.w - gap * (columns - 1)) / columns,
    h = Math.min(e.layout === 'list' ? 115 : 145, (e.h - gap * (rows - 1)) / rows),
    startY = e.y + (e.h - (h * rows + gap * (rows - 1))) / 2;
  return (
    <g>
      {e.items.map((_, i) => {
        const x = e.x + (i % columns) * (w + gap),
          y = startY + Math.floor(i / columns) * (h + gap);
        return (
          <g key={i}>
            {e.layout === 'process' && i < count - 1 && (
              <path d={`M${x + w + 5} ${y + h / 2 - 5} l8 5 -8 5`} stroke={e.accent} strokeWidth="2" fill="none" />
            )}
            {item(i, x, y, w, h)}
          </g>
        );
      })}
    </g>
  );
}

function Element({ element: e, textColor }: { element: SceneElement; textColor: string }) {
  const id = `de-grad-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (e.kind === 'text') return <Text element={e} />;
  if (e.kind === 'line')
    return (
      <line
        x1={e.x}
        y1={e.y + (e.flipY ? e.h : 0)}
        x2={e.x + e.w}
        y2={e.y + (e.flipY ? 0 : e.h)}
        stroke={e.stroke}
        strokeWidth={e.strokeWidth ?? 1}
        strokeDasharray={e.dash ? '6 4' : undefined}
        markerEnd={e.arrow ? 'url(#de-arrow)' : undefined}
        markerStart={e.arrowStart ? 'url(#de-arrow-start)' : undefined}
      />
    );
  if (e.kind === 'chart') return <ChartPreview element={e} textColor={textColor} />;
  if (e.kind === 'smartart') return <SmartArt element={e} />;
  if (e.kind === 'table')
    return (
      <g>
        {tableParts(e).map((part, i) => (
          <Element key={i} element={part} textColor={textColor} />
        ))}
      </g>
    );
  if (e.kind === 'image')
    return (
      <image
        x={e.x}
        y={e.y}
        width={e.w}
        height={e.h}
        // A photo of the app's image store fills its box, cut where PowerPoint cuts it.
        preserveAspectRatio={e.src ? photoFit(e.crop) : undefined}
        href={
          e.src
            ? `/api/images/${e.src}`
            : e.svg
              ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(e.svg)}`
              : `data:image/png;base64,${e.png}`
        }
      />
    );
  const gradient = e.gradient && e.fill !== 'none' ? e.gradient : undefined,
    shadow = e.shadow;
  const paint: Paint = {
    fill: gradient ? `url(#${id})` : e.fill === 'none' ? 'none' : e.fill,
    fillOpacity: e.opacity,
    stroke: e.stroke,
    strokeWidth: e.strokeWidth,
    strokeDasharray: e.dash ? '6 4' : undefined,
    transform: e.rotation ? `rotate(${e.rotation} ${e.x + e.w / 2} ${e.y + e.h / 2})` : undefined,
    style: shadow
      ? {
          filter: `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur / 2}px ${shadow.color}${Math.round(
            shadow.opacity * 255,
          )
            .toString(16)
            .padStart(2, '0')})`,
        }
      : undefined,
  };
  return (
    <>
      {gradient && (
        <defs>
          {/* The angle as in CSS (0 upwards, 90 to the right); SVG's own direction is to the right. */}
          <linearGradient id={id} gradientTransform={`rotate(${gradient.angle - 90} .5 .5)`}>
            {gradient.stops.map((stop, i) => (
              <stop key={i} offset={stop.at} stopColor={stop.color} stopOpacity={stop.op} />
            ))}
          </linearGradient>
        </defs>
      )}
      <Shape element={e} paint={paint} />
    </>
  );
}
type Paint = Pick<
  React.SVGAttributes<SVGElement>,
  'fill' | 'fillOpacity' | 'stroke' | 'strokeWidth' | 'strokeDasharray' | 'transform' | 'style'
>;
function Shape({ element: e, paint }: { element: ShapeElement; paint: Paint }) {
  if (e.path)
    return (
      <path
        d={e.path}
        {...paint}
        markerEnd={e.arrow ? 'url(#de-arrow)' : undefined}
        markerStart={e.arrowStart ? 'url(#de-arrow-start)' : undefined}
      />
    );
  if (e.shape === 'ellipse')
    return <ellipse cx={e.x + e.w / 2} cy={e.y + e.h / 2} rx={e.w / 2} ry={e.h / 2} {...paint} />;
  if (e.shape === 'donut')
    return (
      <g {...paint}>
        <ellipse
          cx={e.x + e.w / 2}
          cy={e.y + e.h / 2}
          rx={e.w * 0.375}
          ry={e.h * 0.375}
          fill="none"
          stroke={e.fill}
          strokeWidth={Math.min(e.w, e.h) * 0.25}
        />
      </g>
    );
  const points = presetOutline(e.shape, e.w, e.h);
  if (points) return <polygon points={points.map((v, i) => v + (i % 2 ? e.y : e.x)).join(' ')} {...paint} />;
  return (
    <rect
      x={e.x}
      y={e.y}
      width={e.w}
      height={e.h}
      rx={e.shape === 'roundRect' ? (e.radius ?? 0.12) * Math.min(e.w, e.h) : 0}
      {...paint}
    />
  );
}

/** Outlines around changed places (refreshed numbers). Drawn only in the app, never exported. */
function Marks({ marks }: { marks: Rect[] }) {
  return (
    <g className="refresh-marks" aria-hidden="true">
      {marks.map((r, i) => (
        <rect
          key={i}
          x={r.x - 4}
          y={r.y - 4}
          width={r.w + 8}
          height={r.h + 8}
          rx="5"
          fill="#f2b33d22"
          stroke="#d9901a"
          strokeWidth="3"
          strokeDasharray="7 4"
        />
      ))}
    </g>
  );
}

export function SlidePreview({
  document,
  index,
  nativeUrl,
  marks,
}: {
  document: RenderDocument;
  index: number;
  nativeUrl?: string;
  marks?: Rect[];
}) {
  const slide = document.slides[index];
  if (!slide) return null;
  if (nativeUrl)
    return marks?.length ? (
      <>
        <img src={nativeUrl} alt={slide.title} loading="lazy" />
        <svg className="mark-layer" viewBox={`0 0 ${document.width} ${document.height}`} aria-hidden="true">
          <Marks marks={marks} />
        </svg>
      </>
    ) : (
      <img src={nativeUrl} alt={slide.title} loading="lazy" />
    );
  return (
    <svg
      viewBox={`0 0 ${document.width} ${document.height}`}
      role="img"
      aria-label={slide.title}
      style={{
        background: slide.background ?? document.theme.background,
        fontFamily: `"${document.theme.font}", "Yu Gothic UI", sans-serif`,
      }}
    >
      <title>{slide.title}</title>
      <defs>
        <marker id="de-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
        </marker>
        <marker
          id="de-arrow-start"
          viewBox="0 0 10 10"
          refX="1"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      {slide.elements.map((element, i) => (
        <Element key={i} element={element} textColor={document.theme.muted} />
      ))}
      {marks?.length ? <Marks marks={marks} /> : null}
    </svg>
  );
}
