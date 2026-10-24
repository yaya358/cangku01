import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  appendChunksBeforeEnd,
  buildTextChunk,
  crc32,
  extractCardFromPng,
  isPng,
  PngError,
  readTextChunks,
} from './png.js';

/**
 * 造一个最小可用的 PNG。
 *
 * 只包含签名 + IHDR + 若干文本块 + IEND，
 * 足够覆盖解析逻辑，又不必在仓库里放二进制样例。
 */
function makePng(
  textChunks: Array<{ keyword: string; text: string; type?: 'tEXt' | 'zTXt' }> = [],
): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(64, 0); // width
  ihdrData.writeUInt32BE(64, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  const ihdr = makeChunk('IHDR', ihdrData);

  const text = textChunks.map((chunk) => {
    if (chunk.type === 'zTXt') {
      const payload = Buffer.concat([
        Buffer.from(chunk.keyword, 'latin1'),
        Buffer.from([0, 0]), // 分隔符 + 压缩方法 0
        deflateSync(Buffer.from(chunk.text, 'utf8')),
      ]);
      return makeChunk('zTXt', payload);
    }
    return buildTextChunk(chunk.keyword, chunk.text);
  });

  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, ...text, iend]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 把对象塞进 PNG 的 chara 关键字（base64）。 */
function withCard(json: unknown, keyword = 'chara'): Buffer {
  return makePng([{ keyword, text: Buffer.from(JSON.stringify(json), 'utf8').toString('base64') }]);
}

describe('PNG 文本块解析', () => {
  it('识别 PNG 签名', () => {
    expect(isPng(makePng())).toBe(true);
    expect(isPng(Buffer.from('GIF89a'))).toBe(false);
    expect(isPng(Buffer.alloc(4))).toBe(false);
  });

  it('读取 tEXt 块', () => {
    const png = makePng([{ keyword: 'Comment', text: '画师：月灯' }]);
    const chunks = readTextChunks(png);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'tEXt', keyword: 'Comment', text: '画师：月灯' });
  });

  it('读取 zTXt 压缩块', () => {
    const png = makePng([{ keyword: 'chara', text: '压缩过的内容'.repeat(20), type: 'zTXt' }]);
    const chunks = readTextChunks(png);

    expect(chunks[0]?.type).toBe('zTXt');
    expect(chunks[0]?.text).toBe('压缩过的内容'.repeat(20));
  });

  it('多个文本块都能读到，顺序保持', () => {
    const png = makePng([
      { keyword: 'Software', text: 'Tavern' },
      { keyword: 'Comment', text: '备注' },
    ]);
    expect(readTextChunks(png).map((chunk) => chunk.keyword)).toEqual(['Software', 'Comment']);
  });

  it('非 PNG 直接报错', () => {
    expect(() => readTextChunks(Buffer.from('not a png'))).toThrow(PngError);
  });

  it('被截断的文件报错而不是越界读', () => {
    const broken = makePng().subarray(0, 20);
    expect(() => readTextChunks(broken)).toThrow(/截断|NOT_PNG/);
  });
});

describe('从 PNG 提取角色卡', () => {
  it('chara 关键字里是 base64 的 JSON', () => {
    const card = { name: '月灯老板', description: '守夜的小酒馆老板', first_mes: '哟，来了？' };
    const extracted = extractCardFromPng(withCard(card));

    expect(extracted?.keyword).toBe('chara');
    expect(extracted?.json).toEqual(card);
  });

  it('ccv3 优先于 chara', () => {
    const png = makePng([
      { keyword: 'chara', text: Buffer.from(JSON.stringify({ name: '旧卡' })).toString('base64') },
      { keyword: 'ccv3', text: Buffer.from(JSON.stringify({ name: '新卡' })).toString('base64') },
    ]);

    const extracted = extractCardFromPng(png);
    expect(extracted?.keyword).toBe('ccv3');
    expect((extracted?.json as { name: string }).name).toBe('新卡');
  });

  it('普通头像（没有角色卡数据）返回 null，不报错', () => {
    expect(extractCardFromPng(makePng([{ keyword: 'Comment', text: '普通图' }]))).toBeNull();
    expect(extractCardFromPng(makePng())).toBeNull();
  });

  it('base64 解出来不是 JSON 时报错，而不是静默忽略', () => {
    const png = makePng([{ keyword: 'chara', text: Buffer.from('不是 JSON').toString('base64') }]);
    expect(() => extractCardFromPng(png)).toThrow(PngError);
  });
});

describe('导出用的 PNG 写入', () => {
  it('buildTextChunk 生成的块能被自己读回来', () => {
    const png = appendChunksBeforeEnd(makePng(), [buildTextChunk('chara', '测试内容')]);
    const chunks = readTextChunks(png);

    expect(chunks.find((chunk) => chunk.keyword === 'chara')?.text).toBe('测试内容');
  });

  it('插入后 IEND 仍然是最后一块，文件依然被识别为 PNG', () => {
    const png = appendChunksBeforeEnd(makePng(), [buildTextChunk('chara', 'x')]);
    expect(isPng(png)).toBe(true);
    // IEND 是最后 12 字节（长度 0 + 类型 + CRC）
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
  });

  it('对非 PNG 写入会报错', () => {
    expect(() => appendChunksBeforeEnd(Buffer.from('nope'), [])).toThrow(PngError);
  });

  it('CRC32 与已知值一致', () => {
    // "123456789" 的标准 CRC32 是 0xCBF43926
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
