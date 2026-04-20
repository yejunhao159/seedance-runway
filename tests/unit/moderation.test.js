import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkPrompt,
  checkImage,
  addUserWord,
  removeUserWord,
  resetUserWords,
  getUserWords
} from '../../core/moderation.js';

beforeEach(() => {
  globalThis.__resetChromeStorage();
});

describe('checkPrompt — 默认词表', () => {
  it('命中 celebrity（Elon Musk）', async () => {
    const r = await checkPrompt('Elon Musk 在舞台上表演魔术');
    expect(r.ok).toBe(false);
    expect(r.hits.some(h => h.word === 'Elon Musk' && h.category === 'celebrity')).toBe(true);
  });

  it('大小写不敏感（taylor swift）', async () => {
    const r = await checkPrompt('taylor swift 演唱会画面');
    expect(r.ok).toBe(false);
    expect(r.hits[0].category).toBe('celebrity');
  });

  it('中英文混合命中多分类', async () => {
    const r = await checkPrompt('一个裸体的 Nike 运动员');
    expect(r.hitCount).toBeGreaterThanOrEqual(2);
    const cats = r.hits.map(h => h.category);
    expect(cats).toContain('nsfw');
    expect(cats).toContain('brand');
  });

  it('空字符串 → ok: true', async () => {
    const r = await checkPrompt('');
    expect(r.ok).toBe(true);
    expect(r.hits).toHaveLength(0);
  });

  it('无命中 → ok: true', async () => {
    const r = await checkPrompt('夜晚的街道上有一只橘色的小猫');
    expect(r.ok).toBe(true);
  });
});

describe('用户自定义词', () => {
  it('addUserWord 后 checkPrompt 能命中', async () => {
    await addUserWord('custom', '玛莎拉蒂');
    const r = await checkPrompt('一辆玛莎拉蒂停在门口');
    expect(r.ok).toBe(false);
    expect(r.hits.some(h => h.word === '玛莎拉蒂' && h.category === 'custom')).toBe(true);
  });

  it('addUserWord 未知分类时 fallback 到 custom', async () => {
    await addUserWord('unknown-category', '特殊词');
    const words = await getUserWords();
    expect(words.custom).toContain('特殊词');
  });

  it('removeUserWord 后不再命中', async () => {
    await addUserWord('brand', '玛莎拉蒂');
    expect((await checkPrompt('玛莎拉蒂')).ok).toBe(false);
    await removeUserWord('brand', '玛莎拉蒂');
    expect((await checkPrompt('玛莎拉蒂')).ok).toBe(true);
  });

  it('resetUserWords 后内置词仍命中（防线不变）', async () => {
    await addUserWord('brand', '玛莎拉蒂');
    await resetUserWords();
    const r = await checkPrompt('玛莎拉蒂 Nike 的球鞋');
    expect(r.hits.some(h => h.word === '玛莎拉蒂')).toBe(false);
    expect(r.hits.some(h => h.word === 'Nike')).toBe(true);
  });
});

describe('checkImage — 图片预检', () => {
  it('小于 5KB 文件报 error', async () => {
    const tiny = new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });
    const r = await checkImage(tiny);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.level === 'error' && i.message.includes('过小'))).toBe(true);
  });

  it('超过 40MB 报 error', async () => {
    // 构造一个 41MB 的 Blob 头（不用真分配，只要 size 对）
    const fake = { size: 41 * 1024 * 1024, type: 'image/png' };
    Object.setPrototypeOf(fake, Blob.prototype);
    const r = await checkImage(fake);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.message.includes('过大'))).toBe(true);
  });

  it('不是 Blob → error', async () => {
    const r = await checkImage(null);
    expect(r.ok).toBe(false);
  });
});
