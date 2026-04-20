import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { logError, listLogs, clearLogs, getLogStats, exportLogsAsJson } from '../../core/error-log.js';

// 每个测试用独立 IndexedDB 会更纯，但 error-log 内部缓存了 dbPromise，
// 所以改用 clearLogs() 清空。
beforeEach(async () => {
  await clearLogs();
});

describe('logError + listLogs', () => {
  it('写入后能读到', async () => {
    await logError({
      error: new Error('x'),
      taskId: 't1',
      platform: 'runway',
      promptText: 'hello'
    });
    const logs = await listLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].taskId).toBe('t1');
    expect(logs[0].promptPreview).toBe('hello');
  });

  it('category 过滤', async () => {
    await logError({ error: { reason: 'SAFETY.INPUT.THIRD_PARTY', message: 'x' }, taskId: 'a' });
    await logError({ error: Object.assign(new Error('net'), { status: 503 }), taskId: 'b' });
    const onlySafety = await listLogs({ category: 'SAFETY_THIRD_PARTY' });
    expect(onlySafety).toHaveLength(1);
    expect(onlySafety[0].taskId).toBe('a');
  });
});

describe('统计 + 导出', () => {
  it('getLogStats 按 category 分组', async () => {
    await logError({ error: { reason: 'SAFETY.INPUT.THIRD_PARTY' } });
    await logError({ error: { reason: 'SAFETY.INPUT.THIRD_PARTY' } });
    await logError({ error: Object.assign(new Error(), { code: 'S3_TIMEOUT' }) });
    const stats = await getLogStats();
    expect(stats.total).toBe(3);
    expect(stats.byCategory.SAFETY_THIRD_PARTY).toBe(2);
    expect(stats.byCategory.S3_UPLOAD).toBe(1);
  });

  it('exportLogsAsJson 返回合法 JSON Blob', async () => {
    await logError({ error: new Error('boom'), taskId: 'x' });
    const blob = await exportLogsAsJson();
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(parsed.total).toBe(1);
    expect(parsed.logs[0].taskId).toBe('x');
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('prompt 脱敏', () => {
  it('长 prompt 截断到 80 字符 + 存 hash', async () => {
    const long = 'a'.repeat(200);
    await logError({ error: new Error(), promptText: long });
    const logs = await listLogs();
    expect(logs[0].promptPreview.length).toBe(80);
    expect(logs[0].promptHash).toMatch(/^[0-9a-f]+$/);
  });

  it('imageIds 最多存 10 个（防止撑爆）', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `img-${i}`);
    await logError({ error: new Error(), imageIds: ids });
    const logs = await listLogs();
    expect(logs[0].imageCount).toBe(30);
    expect(logs[0].imageIds).toHaveLength(10);
  });
});

describe('clearLogs', () => {
  it('清空后 listLogs 返回空', async () => {
    await logError({ error: new Error() });
    await clearLogs();
    expect(await listLogs()).toHaveLength(0);
  });
});
