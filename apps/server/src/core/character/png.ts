import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PNG 文本块（tEXt / zTXt / iTXt）读写。
 *
 * 为什么需要它：社区的「角色卡」本质上就是一张 PNG 头像，
 * 角色设定以 base64(JSON) 塞在 PNG 的文本块里（关键字 chara / ccv3）。
 * 想支持「拖一张图进来就多一个角色」，就必须自己解析 PNG 结构。
 *
 * PNG 结构：8 字节签名 + 若干 chunk，每个 chunk 是
 *   [4 字节长度 BE][4 字节类型][length 字节数据][4 字节 CRC32]
 */

/** PNG 文件签名。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 单个 chunk 长度上限（防御畸形文件把内存打爆）。 */
const MAX_CHUNK_LENGTH = 64 * 1024 * 1024;

export type PngErrorCode = 'NOT_PNG' | 'TRUNCATED' | 'CHUNK_TOO_LARGE' | 'BAD_ZLIB';

export class PngError extends Error {
  readonly code: PngErrorCode;

  constructor(code: PngErrorCode, message: string) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

export interface PngTextChunk {
  /** 块类型。角色卡常见于 zTXt（压缩）与 tEXt */
  type: 'tEXt' | 'zTXt' | 'iTXt';
  /** 关键字，例如 chara / ccv3 */
  keyword: string;
  /** 解码后的文本内容 */
  text: string;
}

export function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 标准 CRC32（PNG 每个 chunk 都要校验）。 */
export function crc32(buffer: Buffer, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface RawChunk {
  type: string;
  data: Buffer;
  /** 整个 chunk（含长度与类型字段）在文件里的起始偏移，导出时用来插入新块 */
  offset: number;
}

/** 遍历所有 chunk，只做边界检查，不解析语义。 */
function* iterateChunks(buffer: Buffer): Generator<RawChunk> {
  if (!isPng(buffer)) {
    throw new PngError('NOT_PNG', '不是 PNG 文件（文件头不匹配）');
  }

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_CHUNK_LENGTH) {
      throw new PngError('CHUNK_TOO_LARGE', `PNG 块长度异常：${length} 字节`);
    }

    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new PngError('TRUNCATED', `PNG 在块 ${type} 处被截断`);
    }

    yield { type, data: buffer.subarray(dataStart, dataEnd), offset };

    offset = dataEnd + 4; // 跳过 CRC
    if (type === 'IEND') return;
  }
}

/** 安全解压：坏数据抛可读错误而不是让 zlib 抛裸异常。 */
function inflate(data: Buffer): Buffer {
  try {
    return inflateSync(data);
  } catch {
    throw new PngError('BAD_ZLIB', 'PNG 压缩文本块解压失败（数据可能已损坏）');
  }
}

/** 解析一个字节串里的 tEXt / zTXt / iTXt 块内容。 */
function decodeTextChunk(chunk: RawChunk): PngTextChunk | null {
  const { type, data } = chunk;
  if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') return null;

  const keywordEnd = data.indexOf(0);
  if (keywordEnd <= 0) return null;
  const keyword = data.toString('latin1', 0, keywordEnd);
  const rest = data.subarray(keywordEnd + 1);

  if (type === 'tEXt') {
    // tEXt 按规范是 latin1，但社区工具普遍直接写 UTF-8，用 utf8 解码更实用
    return { type, keyword, text: rest.toString('utf8') };
  }

  if (type === 'zTXt') {
    const compressionMethod = rest[0];
    if (compressionMethod !== 0) return null; // 规范里目前只有 0=zlib
    return { type, keyword, text: inflate(rest.subarray(1)).toString('utf8') };
  }

  // iTXt: [compFlag 1][compMethod 1][langTag\0][translatedKeyword\0][text]
  const compressionFlag = rest[0];
  const compressionMethod = rest[1];
  let cursor = 2;

  const langEnd = rest.indexOf(0, cursor);
  if (langEnd === -1) return null;
  cursor = langEnd + 1;

  const translatedEnd = rest.indexOf(0, cursor);
  if (translatedEnd === -1) return null;
  cursor = translatedEnd + 1;

  const textBytes = rest.subarray(cursor);
  const text =
    compressionFlag === 1 && compressionMethod === 0
      ? inflate(textBytes).toString('utf8')
      : textBytes.toString('utf8');

  return { type, keyword, text };
}

/** 读出全部文本块。 */
export function readTextChunks(buffer: Buffer): PngTextChunk[] {
  const chunks: PngTextChunk[] = [];
  for (const chunk of iterateChunks(buffer)) {
    const decoded = decodeTextChunk(chunk);
    if (decoded) chunks.push(decoded);
  }
  return chunks;
}

/** 角色卡文本块的关键字，按优先级排列：V3 优先于 V2/V1。 */
export const CARD_KEYWORDS = ['ccv3', 'chara'] as const;

export interface ExtractedCard {
  /** 命中的关键字 */
  keyword: string;
  /** base64 解码 + JSON.parse 之后的对象 */
  json: unknown;
}

/**
 * 从 PNG 里提取角色卡 JSON。
 *
 * 找不到就返回 null（普通头像图也会走到这里，不是错误）。
 * base64 或 JSON 坏掉时抛错，因为那说明文件确实有问题，静默忽略会让人以为导入成功。
 */
export function extractCardFromPng(buffer: Buffer): ExtractedCard | null {
  const chunks = readTextChunks(buffer);

  for (const keyword of CARD_KEYWORDS) {
    const matched = chunks.find((chunk) => chunk.keyword === keyword);
    if (!matched) continue;

    const base64 = matched.text.trim();
    if (base64.length === 0) continue;

    let decoded: string;
    try {
      decoded = Buffer.from(base64, 'base64').toString('utf8');
    } catch {
      throw new PngError('BAD_ZLIB', '角色卡数据不是合法 base64');
    }

    try {
      return { keyword, json: JSON.parse(decoded) as unknown };
    } catch {
      throw new PngError('BAD_ZLIB', '角色卡数据解码后不是合法 JSON');
    }
  }

  return null;
}

/** 构造任意类型的 PNG 块（长度 + 类型 + 数据 + CRC）。 */
export function buildChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1');
  const typeAndData = Buffer.concat([typeBytes, data]);

  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/** 构造一个 tEXt 块（导出角色卡时用）。 */
export function buildTextChunk(keyword: string, text: string): Buffer {
  return buildChunk(
    'tEXt',
    Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'utf8')]),
  );
}

/** 从文本块数据里取出关键字（NUL 之前的部分）。 */
function chunkKeyword(data: Buffer): string | null {
  const end = data.indexOf(0);
  if (end <= 0) return null;
  return data.toString('latin1', 0, end);
}

/**
 * 去掉若干文本块。
 *
 * 导出前必须调用：否则头像里原有的 chara 块还留着，我们又在后面追加新的，
 * 再导入时解析器命中第一个（旧的），就会出现「导回去还是旧设定」的怪事。
 */
export function stripTextChunks(png: Buffer, keywords: readonly string[]): Buffer {
  if (!isPng(png)) throw new PngError('NOT_PNG', '不是 PNG 文件');

  const targets = new Set(keywords);
  const parts: Buffer[] = [PNG_SIGNATURE];

  for (const chunk of iterateChunks(png)) {
    const end = chunk.offset + 12 + chunk.data.length;
    const isText = chunk.type === 'tEXt' || chunk.type === 'zTXt' || chunk.type === 'iTXt';

    if (isText) {
      const keyword = chunkKeyword(chunk.data);
      if (keyword && targets.has(keyword)) continue;
    }

    parts.push(png.subarray(chunk.offset, end));
  }

  return Buffer.concat(parts);
}

/** 在 IEND 之前插入若干块，得到「带头像 + 角色卡数据」的 PNG。 */
export function appendChunksBeforeEnd(png: Buffer, extraChunks: readonly Buffer[]): Buffer {
  if (!isPng(png)) {
    throw new PngError('NOT_PNG', '不是 PNG 文件，无法写入角色卡数据');
  }

  let insertAt = -1;
  for (const chunk of iterateChunks(png)) {
    if (chunk.type === 'IEND') {
      insertAt = chunk.offset;
    }
  }

  if (insertAt < 0) throw new PngError('TRUNCATED', 'PNG 缺少 IEND 块');

  return Buffer.concat([png.subarray(0, insertAt), ...extraChunks, png.subarray(insertAt)]);
}

/**
 * 生成一张纯色占位头像。
 *
 * 手动创建的角色没有头像，但「导出角色卡」必须给出一张合法 PNG，
 * 否则用户会拿到一个只有 JSON 的半成品。颜色由名字散列决定，
 * 同一个角色每次导出的颜色一致，看起来不像随机噪音。
 */
export function createPlaceholderPng(seed: string, size = 256): Buffer {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.codePointAt(0)!) % 360;
  }
  // 深色底 + 一点琥珀色倾向，跟界面风格一致
  const hue = hash;
  const [red, green, blue] = hslToRgb(hue / 360, 0.32, 0.18);

  const rowLength = 1 + size * 4;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', deflateSync(raw)),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** HSL → RGB（只用于占位图，取整即可）。 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue2rgb = (p: number, q: number, t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  if (s === 0) {
    const grey = Math.round(l * 255);
    return [grey, grey, grey];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}
