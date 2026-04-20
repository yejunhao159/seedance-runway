/**
 * 本地错误日志（IndexedDB）
 *
 * 用途：
 *   1. 排查线上问题（用户反馈时可导出 JSON）
 *   2. 统计错误 pattern（哪些 prompt 高频被审核拒）
 *   3. 不依赖远程服务，离线可用
 *
 * 设计原则：
 *   - 不存完整 prompt 原文（存前 80 字符摘要 + hash）
 *   - 不存图片二进制（只存 imageId）
 *   - 自动修剪：超过 500 条开始淘汰最早的
 */

import { classifyError } from './error-classifier.js';

const DB_NAME = 'seedance-error-log';
const DB_VERSION = 1;
const STORE = 'errors';
const MAX_LOG_ENTRIES = 500;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('taskId', 'taskId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打开错误日志数据库失败'));
  });
  return dbPromise;
}

function tx(mode, handler) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try { result = handler(store, transaction); } catch (e) { reject(e); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('错误日志事务失败'));
  }));
}

async function simpleHash(s) {
  if (!s) return '';
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buf = new TextEncoder().encode(s);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {/* fall through */}
  }
  // 兜底：简单哈希
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * 记一条错误
 * @param {{ error, taskId?, platform?, promptText?, imageIds?, context? }} input
 */
export async function logError({ error, taskId = null, platform = null, promptText = '', imageIds = [], context = null }) {
  const classified = classifyError(error);
  const promptHash = await simpleHash(promptText || '');
  const entry = {
    timestamp: Date.now(),
    taskId,
    platform,
    category: classified.category,
    code: classified.code || null,
    title: classified.title,
    message: classified.message,
    rawMessage: classified.rawMessage,
    promptPreview: String(promptText || '').slice(0, 80),
    promptHash,
    imageCount: Array.isArray(imageIds) ? imageIds.length : 0,
    imageIds: Array.isArray(imageIds) ? imageIds.slice(0, 10) : [],  // 最多记 10 个
    stack: (error instanceof Error && error.stack) ? String(error.stack).slice(0, 800) : null,
    context: context ? safeStringify(context) : null
  };

  try {
    await tx('readwrite', (store) => store.add(entry));
    await trimIfOverflow();
  } catch (e) {
    console.warn('[error-log] 写入失败:', e);
  }
  return entry;
}

function safeStringify(obj) {
  try { return JSON.stringify(obj).slice(0, 400); } catch { return null; }
}

async function trimIfOverflow() {
  const count = await tx('readonly', (store) => new Promise((resolve) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
  }));
  if (count <= MAX_LOG_ENTRIES) return;
  const toDelete = count - MAX_LOG_ENTRIES;
  await tx('readwrite', (store) => new Promise((resolve) => {
    const idx = store.index('timestamp');
    let deleted = 0;
    const cursorReq = idx.openCursor();
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || deleted >= toDelete) return resolve();
      cursor.delete();
      deleted++;
      cursor.continue();
    };
  }));
}

/**
 * 列出最近 N 条错误
 * @param {{ limit?, category?, taskId? }} filter
 */
export async function listLogs(filter = {}) {
  const limit = filter.limit || 100;
  return tx('readonly', (store) => new Promise((resolve) => {
    const idx = store.index('timestamp');
    const results = [];
    const req = idx.openCursor(null, 'prev'); // 最新在前
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || results.length >= limit) return resolve(results);
      const v = cursor.value;
      if (filter.category && v.category !== filter.category) { cursor.continue(); return; }
      if (filter.taskId && v.taskId !== filter.taskId) { cursor.continue(); return; }
      results.push(v);
      cursor.continue();
    };
  }));
}

export async function clearLogs() {
  await tx('readwrite', (store) => store.clear());
}

export async function exportLogsAsJson() {
  const logs = await listLogs({ limit: MAX_LOG_ENTRIES });
  const payload = {
    exportedAt: new Date().toISOString(),
    total: logs.length,
    logs
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/**
 * 简短统计：按 category 分类计数
 */
export async function getLogStats() {
  const logs = await listLogs({ limit: MAX_LOG_ENTRIES });
  const byCategory = {};
  for (const l of logs) {
    byCategory[l.category] = (byCategory[l.category] || 0) + 1;
  }
  return { total: logs.length, byCategory };
}
