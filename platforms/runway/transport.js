import { RUNWAY_HOST } from './config.js';

/**
 * Runway 网络传输层
 *
 * Runway 鉴权方式：所有 api.runwayml.com 请求需要带 Authorization: Bearer <JWT>。
 * JWT 来自用户登录态，存在页面 localStorage 或类似位置。
 *
 * 取 JWT 的策略（Stage 1 阶段先用前两个，自动 harvest 留给 Stage 1 验收）：
 *   1. 显式注入：调用方通过 setJwt() 主动设置（用于 popup 调试输入框）
 *   2. 从 chrome.storage.local 读：每次成功调用后会缓存到 storage
 *   3. 自动 harvest（TODO）：通过 content.js 注入页脚本读 localStorage
 *
 * 设计原则：transport 只关心"我有 token"——不关心 token 怎么来。
 * 这样 Stage 1 后续接 auto-harvest 时改动局限在 setJwt 调用方。
 */

const STORAGE_KEY_JWT = 'runway.jwt';
const STORAGE_KEY_CONTEXT = 'runway.context';
const STORAGE_KEY_FINGERPRINT = 'runway.fingerprint';

let cachedJwt = null;
let cachedContext = null;   // { teamId, assetGroupId, sessionId? }
let cachedFingerprint = null; // { clientId, version }

/**
 * Runway 官方 web 端发起的请求会带这些头：
 *   X-Runway-Source-Application: web
 *   X-Runway-Source-Application-Version: <commit hash>
 *   X-Runway-Client-Id: <UUID — 浏览器指纹>
 *   X-Runway-Workspace: <teamId>
 * 不带这些头 = 后端能一眼看出是脚本调用。
 * harvester 抓到 clientId / version 后写入 storage，这里读出复用。
 */
const HARDCODED_SOURCE_APPLICATION = 'web';

/**
 * 抖动 / 随机延迟工具
 *   jitter(8000, 0.2) → 6400~9600 之间随机
 *   randSleep(3000, 8000) → Promise resolve 后已睡 3-8s
 */
export const jitter = (baseMs, pct = 0.2) => {
  const range = baseMs * pct;
  return Math.round(baseMs - range + Math.random() * range * 2);
};

export const randSleep = (minMs, maxMs) =>
  new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));

/**
 * JWT 必须是 ASCII 安全的 base64 + dots（标准 JWT 格式）
 * 防御：用户可能把 UI 占位符文本/带中文的字符串误存为 JWT
 */
function isValidJwt(s) {
  if (typeof s !== 'string' || !s) return false;
  // 必须全 ASCII（HTTP header 不允许 ISO-8859-1 之外的字符）
  if (!/^[\x21-\x7e]+$/.test(s)) return false;
  // 必须像 JWT：三段 base64-url 用 dot 分隔
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  return parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p) && p.length > 0);
}

/**
 * 设置 JWT（手动或自动 harvest 都走这里）
 */
export async function setJwt(jwt) {
  if (jwt != null && jwt !== '' && !isValidJwt(jwt)) {
    console.warn('[Runway transport] 拒绝设置非法 JWT（含非 ASCII 或格式不对）:',
      typeof jwt === 'string' ? jwt.slice(0, 40) + '…' : typeof jwt);
    return;
  }
  cachedJwt = jwt;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_JWT]: jwt });
  }
}

/**
 * 获取 JWT（优先内存，回退 storage）
 * 自动剔除存储里残留的非法 JWT
 */
export async function getJwt() {
  if (cachedJwt && isValidJwt(cachedJwt)) return cachedJwt;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const stored = await chrome.storage.local.get(STORAGE_KEY_JWT);
    const val = stored[STORAGE_KEY_JWT] || null;
    if (val && !isValidJwt(val)) {
      console.warn('[Runway transport] storage 里发现非法 JWT，已清空，请重新登录 Runway 触发自动抓取');
      await chrome.storage.local.remove(STORAGE_KEY_JWT);
      cachedJwt = null;
      return null;
    }
    cachedJwt = val;
  }
  return cachedJwt;
}

/**
 * 设置/获取 Runway 上下文（teamId / assetGroupId 等用户专属常量）
 * 这些值通常一次发现、长期复用
 */
export async function setContext(ctx) {
  cachedContext = { ...(cachedContext || {}), ...ctx };
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_CONTEXT]: cachedContext });
  }
}

export async function getContext() {
  if (cachedContext) return cachedContext;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const stored = await chrome.storage.local.get(STORAGE_KEY_CONTEXT);
    cachedContext = stored[STORAGE_KEY_CONTEXT] || {};
  }
  return cachedContext;
}

/**
 * 设置/获取浏览器指纹（X-Runway-Client-Id + Source-Application-Version）
 * 由 webRequest 监听器从 Runway 官方页面请求里抓取。
 */
export async function setFingerprint(patch) {
  if (!patch) return;
  const next = { ...(cachedFingerprint || {}) };
  // 只接受 ASCII 字符串，杜绝把任何中文/带壳值塞 header
  const sanitize = (v) => (typeof v === 'string' && /^[\x21-\x7e]+$/.test(v)) ? v : null;
  if (patch.clientId) {
    const c = sanitize(patch.clientId);
    if (c) next.clientId = c;
  }
  if (patch.version) {
    const v = sanitize(patch.version);
    if (v) next.version = v;
  }
  cachedFingerprint = next;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_FINGERPRINT]: cachedFingerprint });
  }
}

export async function getFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const stored = await chrome.storage.local.get(STORAGE_KEY_FINGERPRINT);
    cachedFingerprint = stored[STORAGE_KEY_FINGERPRINT] || {};
  }
  return cachedFingerprint;
}

/**
 * 调用 Runway JSON API
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path - 以 / 开头的路径，例如 '/v1/tasks'
 * @param {object} [body] - JSON 请求体
 * @param {object} [opts] - { jwt?, query? }
 */
export async function callRunway(method, path, body = null, opts = {}) {
  const jwt = opts.jwt || await getJwt();
  if (!jwt) {
    const err = new Error('Runway JWT 未设置——请先在 popup 调试入口粘贴 token，或运行 token harvest');
    err.code = 'NO_JWT';
    throw err;
  }

  let url = `${RUNWAY_HOST}${path}`;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json'
  };

  // 伪装成官方 web 端请求 —— 缺这几个头时后端能直接识别为脚本调用
  const fp = await getFingerprint();
  if (fp?.clientId) headers['X-Runway-Client-Id'] = fp.clientId;
  if (fp?.version) headers['X-Runway-Source-Application-Version'] = fp.version;
  headers['X-Runway-Source-Application'] = HARDCODED_SOURCE_APPLICATION;

  const ctx = await getContext();
  if (ctx?.teamId && Number(ctx.teamId) > 0) {
    headers['X-Runway-Workspace'] = String(ctx.teamId);
  }

  const init = { method, headers };
  if (body != null && method !== 'GET') {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const err = new Error(
      `Runway ${method} ${path} 返回 ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`
    );
    err.status = response.status;
    err.body = parsed;
    if (response.status === 401 || response.status === 403) {
      err.code = 'AUTH_FAILED';
      cachedJwt = null;   // 强制下次重新拿
    }
    throw err;
  }

  return parsed;
}

/**
 * 上传二进制到 Runway 预签名 S3 URL（带 AbortController + 指数退避重试）
 * 不需要 JWT（URL 自带签名）
 *
 * 重试策略：
 *   - 最多 3 次重试（1s/3s/7s 退避）
 *   - 仅对幂等错误重试：400 RequestTimeout / 408 / 5xx / 网络错误 / Abort
 *   - 403/404/413 立即放弃（签名错/体积错，重试无意义）
 *
 * 动态 timeout：`max(30s, size_MB × 8s, capped 120s)`
 * 应对 S3 "idle socket closed" —— 弱网 + 大图时，应用层兜底
 */
const RETRY_BACKOFF_MS = [1000, 3000, 7000];
const RETRYABLE_STATUS = new Set([0, 408, 500, 502, 503, 504]);

function isRetryableError(err, status) {
  if (err?.name === 'AbortError') return true;
  if (status != null) {
    if (RETRYABLE_STATUS.has(status)) return true;
    // S3 特定：400 RequestTimeout 是 idle socket close，可重试
    if (status === 400 && /RequestTimeout/i.test(err?.body || '')) return true;
    return false;
  }
  // 无 status = fetch 本身抛错（网络错）
  return true;
}

function computeUploadTimeoutMs(byteSize) {
  const sizeMb = byteSize / (1024 * 1024);
  const dynamic = Math.max(30000, Math.round(sizeMb * 8000));
  return Math.min(dynamic, 120000);
}

async function attemptPut(signedUrl, blob, extraHeaders, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(signedUrl, {
      method: 'PUT',
      headers: { ...extraHeaders },
      body: blob,
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`S3 上传失败 ${response.status}: ${text}`);
      err.status = response.status;
      err.body = text;
      throw err;
    }
    const etag = response.headers.get('etag') || response.headers.get('ETag');
    return { etag: etag ? etag.replace(/^"|"$/g, '') : null };
  } finally {
    clearTimeout(timer);
  }
}

export async function putToPresignedUrl(signedUrl, blob, extraHeaders = {}) {
  const timeoutMs = computeUploadTimeoutMs(blob.size);
  let lastErr = null;

  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await attemptPut(signedUrl, blob, extraHeaders, timeoutMs);
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retryable = isRetryableError(err, status);
      const isLast = attempt === RETRY_BACKOFF_MS.length;
      if (!retryable || isLast) {
        // 附加一个稳定的错误码，给错误分层模块用
        if (err?.name === 'AbortError') lastErr.code = 'S3_TIMEOUT';
        else if (status === 400 && /RequestTimeout/i.test(err?.body || '')) lastErr.code = 'S3_IDLE_TIMEOUT';
        else if (status >= 500) lastErr.code = 'S3_SERVER_ERROR';
        else lastErr.code = 'S3_UPLOAD_FAILED';
        throw lastErr;
      }
      const wait = RETRY_BACKOFF_MS[attempt];
      console.warn(`[putToPresignedUrl] attempt ${attempt + 1} failed (${err?.message || err}), retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
