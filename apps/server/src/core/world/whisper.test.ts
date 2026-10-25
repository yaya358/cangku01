import { describe, expect, it } from 'vitest';
import type { Message } from '@tavern/shared';
import { contentForSpeaker, INAUDIBLE_PLACEHOLDER, whisperAudience } from './whisper.js';

/** 造一条消息：只填判定需要的字段，其余补默认。 */
function msg(id: string, role: Message['role'], extra: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'conv',
    parentId: null,
    role,
    kind: 'speak',
    speakerId: null,
    whisper: false,
    eavesdrop: false,
    beat: null,
    content: id,
    swipes: [],
    swipeIndex: 0,
    model: null,
    provider: null,
    usage: null,
    finishReason: null,
    durationMs: null,
    firstTokenMs: null,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * 这一场：
 *   u1（低声，对 A 说） → a2（A 接了） → a3（C 听见了，反应）
 *   u4（正常说话） → a5（A 接了）
 */
function sampleThread(): Message[] {
  return [
    msg('u1', 'user', { whisper: true }),
    msg('a2', 'assistant', { speakerId: 'A', parentId: 'u1' }),
    msg('a3', 'assistant', { speakerId: 'C', parentId: 'a2', eavesdrop: true }),
    msg('u4', 'user', { parentId: 'a3' }),
    msg('a5', 'assistant', { speakerId: 'A', parentId: 'u4' }),
  ];
}

describe('低声话的知情人', () => {
  it('正主与听见的人知道，其余在场的人不知道', () => {
    const audience = whisperAudience(sampleThread());
    expect([...(audience.get('u1') ?? [])].sort()).toEqual(['A', 'C']);
  });

  it('没被听见时只有正主知道', () => {
    const thread = [
      msg('u1', 'user', { whisper: true }),
      msg('a2', 'assistant', { speakerId: 'A', parentId: 'u1' }),
      msg('u4', 'user', { parentId: 'a2' }),
    ];
    const audience = whisperAudience(thread);
    expect([...(audience.get('u1') ?? [])]).toEqual(['A']);
  });

  it('普通说话不进这张表（谁都能听见）', () => {
    const audience = whisperAudience([
      msg('u1', 'user'),
      msg('a2', 'assistant', { speakerId: 'A' }),
    ]);
    expect(audience.size).toBe(0);
  });
});

describe('按知情情况裁剪历史', () => {
  it('不知情的人看到的是占位文本，不是原话', () => {
    const thread = sampleThread();
    const audience = whisperAudience(thread);
    const whisper = thread[0]!;

    expect(contentForSpeaker(whisper, 'B', audience)).toBe(INAUDIBLE_PLACEHOLDER);
    expect(contentForSpeaker(whisper, 'A', audience)).toBe('u1');
    expect(contentForSpeaker(whisper, 'C', audience)).toBe('u1');
  });

  it('普通消息不裁剪', () => {
    const thread = sampleThread();
    const audience = whisperAudience(thread);
    expect(contentForSpeaker(thread[3]!, 'B', audience)).toBe('u4');
  });
});
