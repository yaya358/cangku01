import { deflateSync } from 'node:zlib';
import { buildTextChunk, crc32 } from '../core/character/png.js';

/**
 * 测试用的 PNG 构造器。
 *
 * 生成「签名 + IHDR + 文本块 + IEND」的最小合法 PNG：
 * 既够解析器跑，也不必往仓库里塞二进制样例文件。
 */

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 图片边长（像素）。 */
const SIZE = 64;

/**
 * 生成真正可解码的图像数据（IDAT）。
 *
 * 只有 IHDR + 文本块 + IEND 的 PNG 结构合法但**没有像素**，
 * 浏览器会显示成裂图。测试里要断言头像能被浏览器渲染，就得给真像素：
 * 每行 = 1 字节过滤标记(0) + SIZE 个 RGBA 像素。
 */
function makeImageData(): Buffer {
  const rowLength = 1 + SIZE * 4;
  const raw = Buffer.alloc(rowLength * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < SIZE; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = 0x2a; // R
      raw[offset + 1] = 0x21; // G
      raw[offset + 2] = 0x18; // B
      raw[offset + 3] = 0xff; // A
    }
  }
  return deflateSync(raw);
}

function makeBasePng(textChunks: Buffer[] = []): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(SIZE, 0);
  ihdrData.writeUInt32BE(SIZE, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  return Buffer.concat([
    SIGNATURE,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', makeImageData()),
    ...textChunks,
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 普通头像：没有任何角色卡数据。 */
export function makePlainPng(): Buffer {
  return makeBasePng([buildTextChunk('Comment', '普通头像')]);
}

/** 带角色卡的 PNG：把 JSON 以 base64 放进 chara（或 ccv3）文本块。 */
export function makeCardPng(json: unknown, keyword: 'chara' | 'ccv3' = 'chara'): Buffer {
  const base64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
  return makeBasePng([buildTextChunk('Software', '酒馆 AI 测试'), buildTextChunk(keyword, base64)]);
}

/**
 * 压缩文本块版本，验证 zTXt 路径。
 *
 * 注意内容仍然是 base64（社区约定：chara 块里放的是 base64 文本，
 * 压缩只是给这段文本套一层 zlib），不是裸 JSON。
 */
export function makeCompressedCardPng(json: unknown): Buffer {
  const base64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
  const payload = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0, 0]),
    deflateSync(Buffer.from(base64, 'latin1')),
  ]);
  return makeBasePng([makeChunk('zTXt', payload)]);
}

/** 一张典型的 V2 角色卡。 */
export function sampleCardV2(name = '月灯老板'): Record<string, unknown> {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '守着一间只在夜里开门的小酒馆。',
      personality: '话痨、心软',
      scenario: '深夜的酒馆',
      first_mes: '（擦着杯子）哟，这个点还来？',
      mes_example: '<START>\n{{user}}: 有酒吗？\n{{char}}: 有，也有故事。',
      tags: ['酒馆', '日常'],
      alternate_greetings: ['（打了个哈欠）来啦？'],
    },
  };
}
