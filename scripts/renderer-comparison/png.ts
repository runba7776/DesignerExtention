/** Just enough PNG to compare two slide pictures PowerPoint exported: 8-bit RGB/RGBA, not interlaced. */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Picture {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(file: Uint8Array): Picture {
  const buffer = Buffer.from(file);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNGではありません。');
  let width = 0,
    height = 0,
    channels = 0;
  const chunks: Buffer[] = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at),
      type = buffer.toString('latin1', at + 4, at + 8),
      body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8],
        colorType = body[9],
        interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6))
        throw new Error('8ビットRGB/RGBAで非インターレースのPNGだけ読めます。');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') chunks.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * channels,
    rows = new Uint8Array(stride * height),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
      row = rows.subarray(y * stride, (y + 1) * stride),
      previous = y ? rows.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0,
        up = previous[i],
        upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft,
          pa = Math.abs(p - left),
          pb = Math.abs(p - up),
          pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = row[x * channels];
      data[o + 1] = row[x * channels + 1];
      data[o + 2] = row[x * channels + 2];
      data[o + 3] = channels === 4 ? row[x * channels + 3] : 255;
    }
  }
  return { width, height, data };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng(picture: Picture): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(picture.width, 0);
  header.writeUInt32BE(picture.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = picture.width * 4,
    raw = Buffer.alloc((stride + 1) * picture.height);
  for (let y = 0; y < picture.height; y++)
    Buffer.from(picture.data.buffer, picture.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The share of pixels that clearly differ (any channel by more than threshold), and a picture of them: the native
 * slide faded to grey, with what only differs in red. */
export function diffPictures(a: Picture, b: Picture, threshold = 48) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`画像の大きさが違います: ${a.width}×${a.height} / ${b.width}×${b.height}`);
  const out = new Uint8Array(a.data.length);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (delta > threshold) {
      changed++;
      out.set([220, 30, 40, 255], i);
    } else {
      const grey = Math.round((a.data[i] * 0.3 + a.data[i + 1] * 0.59 + a.data[i + 2] * 0.11) * 0.25 + 191);
      out.set([grey, grey, grey, 255], i);
    }
  }
  return { share: changed / (a.width * a.height), picture: { width: a.width, height: a.height, data: out } };
}

/** Half the width and height (each pixel the mean of four), to keep the report small. */
export function halve(picture: Picture): Picture {
  const width = Math.floor(picture.width / 2),
    height = Math.floor(picture.height / 2),
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) {
        const at = (dx: number, dy: number) => picture.data[((y * 2 + dy) * picture.width + x * 2 + dx) * 4 + c];
        data[(y * width + x) * 4 + c] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) >> 2;
      }
  return { width, height, data };
}
