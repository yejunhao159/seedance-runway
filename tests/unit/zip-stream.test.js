import { describe, it, expect } from 'vitest';
import { createZip, parseZip } from '../../core/zip-stream.js';

describe('createZip + parseZip roundtrip', () => {
  it('往返：单个文本文件', async () => {
    const data = new TextEncoder().encode('hello, world');
    const zip = await createZip([{ name: 'a.txt', data }]);
    const entries = await parseZip(await zip.arrayBuffer());
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('a.txt');
    expect(new TextDecoder().decode(entries[0].data)).toBe('hello, world');
  });

  it('往返：多个文件 + 子目录', async () => {
    const files = [
      { name: 'tasks.json', data: new TextEncoder().encode('{"v":2}') },
      { name: 'images/a.png', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
      { name: 'images/b.png', data: new Uint8Array([9, 10, 11, 12]) }
    ];
    const zip = await createZip(files);
    const entries = await parseZip(await zip.arrayBuffer());
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.name).sort()).toEqual(['images/a.png', 'images/b.png', 'tasks.json']);
  });

  it('DEFLATE 压缩能省体积（大 JSON）', async () => {
    const big = JSON.stringify({ arr: Array.from({ length: 200 }, (_, i) => `item-${i}-repeat`.repeat(10)) });
    const bytes = new TextEncoder().encode(big);
    const zip = await createZip([{ name: 'big.json', data: bytes }]);
    // DEFLATE 后 zip 体积应小于原文件（ZIP 开销可忽略）
    expect(zip.size).toBeLessThan(bytes.length);
  });

  it('小文件（<64B）走 Store，不强制 deflate', async () => {
    const tiny = new Uint8Array([1, 2, 3]);
    const zip = await createZip([{ name: 't.bin', data: tiny }]);
    const entries = await parseZip(await zip.arrayBuffer());
    expect(entries[0].data).toEqual(tiny);
  });

  it('compress: false 走 Store 模式', async () => {
    const data = new TextEncoder().encode('a'.repeat(1000));
    const zip = await createZip([{ name: 'a.txt', data }], { compress: false });
    const entries = await parseZip(await zip.arrayBuffer());
    expect(new TextDecoder().decode(entries[0].data)).toBe('a'.repeat(1000));
  });

  it('Blob 输入（来自 IndexedDB）', async () => {
    const blob = new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef])], { type: 'image/png' });
    const zip = await createZip([{ name: 'img.png', data: blob }]);
    const entries = await parseZip(await zip.arrayBuffer());
    expect(entries[0].data).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('onProgress 每个文件回调一次', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`, data: new TextEncoder().encode(`${i}`)
    }));
    const seen = [];
    await createZip(files, { onProgress: (d, total) => seen.push([d, total]) });
    expect(seen).toHaveLength(5);
    expect(seen[4]).toEqual([5, 5]);
  });
});
