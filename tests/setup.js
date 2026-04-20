/**
 * 测试环境全局设置
 *
 * 1. fake-indexeddb 注入到 globalThis（error-log 模块需要）
 * 2. chrome API 极简 mock（只包含我们真正用到的 storage.local）
 * 3. crypto.subtle 默认 happy-dom 就有，不 mock
 */

import 'fake-indexeddb/auto';

// ─── chrome.storage.local 最小 mock ───────────────────────
class LocalStorageMock {
  constructor() { this._data = new Map(); }
  get(keys) {
    if (typeof keys === 'string') return Promise.resolve({ [keys]: this._data.get(keys) });
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) out[k] = this._data.get(k);
      return Promise.resolve(out);
    }
    const out = {};
    for (const [k, v] of this._data) out[k] = v;
    return Promise.resolve(out);
  }
  set(obj) {
    for (const [k, v] of Object.entries(obj)) this._data.set(k, v);
    return Promise.resolve();
  }
  remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this._data.delete(k);
    return Promise.resolve();
  }
  clear() { this._data.clear(); return Promise.resolve(); }
}

globalThis.chrome = {
  storage: {
    local: new LocalStorageMock(),
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    sendMessage: () => Promise.resolve({ success: true }),
    id: 'test-extension-id'
  }
};

// 让每个测试文件可以重置 storage
globalThis.__resetChromeStorage = () => {
  globalThis.chrome.storage.local = new LocalStorageMock();
};
