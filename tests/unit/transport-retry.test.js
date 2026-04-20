import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { putToPresignedUrl } from '../../platforms/runway/transport.js';

/**
 * putToPresignedUrl 重试逻辑测试
 *
 * 不用 fake timers（对 setTimeout+Promise 组合不稳），
 * 直接替换 globalThis.setTimeout 让退避等待立即 resolve
 */

let originalSetTimeout;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout;
  // 退避等待立即完成；AbortController 的真 timeout 仍走 originalSetTimeout
  globalThis.setTimeout = (fn, ms) => {
    if (ms <= 100) return originalSetTimeout(fn, ms);
    // 退避等待（>100ms）立即触发
    Promise.resolve().then(() => fn());
    return 0;
  };
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockResponse({ ok, status, text = '', etag = '"abc123"' }) {
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    headers: { get: (k) => (k.toLowerCase() === 'etag' ? etag : null) }
  };
}

describe('putToPresignedUrl — 重试', () => {
  it('首次成功 → 返回 etag，不重试', async () => {
    fetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    const blob = new Blob(['hello'], { type: 'image/jpeg' });
    const r = await putToPresignedUrl('https://s3/abc', blob);
    expect(r.etag).toBe('abc123');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('400 RequestTimeout 最多重试 3 次（共 4 次调用）再抛 S3_IDLE_TIMEOUT', async () => {
    fetch.mockResolvedValue(mockResponse({
      ok: false,
      status: 400,
      text: '<Error><Code>RequestTimeout</Code></Error>'
    }));
    const blob = new Blob(['x'.repeat(1024)], { type: 'image/jpeg' });
    await expect(putToPresignedUrl('https://s3/abc', blob)).rejects.toMatchObject({
      code: 'S3_IDLE_TIMEOUT'
    });
    expect(fetch).toHaveBeenCalledTimes(4);  // 初次 + 3 重试
  });

  it('第 2 次重试成功 → 返回 etag', async () => {
    fetch
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 400, text: 'RequestTimeout' }))
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503, text: 'busy' }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, etag: '"final-etag"' }));
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    const r = await putToPresignedUrl('https://s3/abc', blob);
    expect(r.etag).toBe('final-etag');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('403 立即失败，不重试', async () => {
    fetch.mockResolvedValue(mockResponse({ ok: false, status: 403, text: 'access denied' }));
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await expect(putToPresignedUrl('https://s3/abc', blob)).rejects.toMatchObject({
      status: 403,
      code: 'S3_UPLOAD_FAILED'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('网络错误（fetch 抛错）会重试', async () => {
    fetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    const r = await putToPresignedUrl('https://s3/abc', blob);
    expect(r.etag).toBe('abc123');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('500 系列会重试', async () => {
    fetch
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 502, text: 'bad gw' }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    const r = await putToPresignedUrl('https://s3/abc', blob);
    expect(r.etag).toBe('abc123');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
