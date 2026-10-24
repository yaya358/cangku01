import type { Character } from '@tavern/shared';
import {
  appendChunksBeforeEnd,
  buildTextChunk,
  CARD_KEYWORDS,
  createPlaceholderPng,
  isPng,
  stripTextChunks,
} from './png.js';
import { toV2Card } from './card.js';

/**
 * 角色卡导出。
 *
 * 导出方向有两个：
 *   PNG —— 头像 + 嵌在文本块里的卡片数据，能和 SillyTavern 等工具无缝互换
 *   JSON —— 纯卡片数据，方便手改或进版本库
 */

/** 文件名里不能出现的字符（Windows 保留字符）。 */
const UNSAFE_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/** 按码点过滤：控制字符（换行/制表）与路径分隔符一并清掉。 */
function stripUnsafeChars(input: string): string {
  let result = '';
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || UNSAFE_CHARS.has(char)) continue;
    result += char;
  }
  return result;
}

/** 把角色名转成安全文件名；空白折叠、长度截断、空名兜底。 */
export function safeFileName(name: string, extension: string): string {
  const base = stripUnsafeChars(name).replace(/\s+/g, ' ').trim().slice(0, 60);

  return `${base.length > 0 ? base : 'character'}${extension}`;
}

/**
 * Content-Disposition。
 *
 * 中文文件名必须走 RFC 5987 的 `filename*`，否则 HTTP 头按 latin1 编码会变成乱码；
 * 同时保留一个 ASCII 的 `filename` 给老客户端兜底。
 */
export function contentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface BuildCardPngOptions {
  /** 头像原始字节；缺失或不是 PNG 时用占位图 */
  avatar?: Buffer | null;
  /** 角色（导出成 V2 结构） */
  character: Character;
  appVersion: string;
}

/**
 * 生成可直接分发的角色卡 PNG。
 *
 * 关键一步是先 stripTextChunks：头像里可能已经带着旧卡（比如它就是导入来的），
 * 不删掉的话我们再追加一个新 chara，导入方会命中第一个（旧的）。
 */
export function buildCardPng(options: BuildCardPngOptions): Buffer {
  const { avatar, character, appVersion } = options;

  const base = avatar && isPng(avatar) ? avatar : createPlaceholderPng(character.name);
  const cleaned = stripTextChunks(base, CARD_KEYWORDS);

  const card = toV2Card(character, appVersion);
  const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');

  return appendChunksBeforeEnd(cleaned, [buildTextChunk('chara', payload)]);
}
