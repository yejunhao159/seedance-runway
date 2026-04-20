/**
 * 错误分层系统
 *
 * 把杂乱的错误（Error 对象 / Runway task error / HTTP 状态）归类成 6 种，
 * 每类带中文文案 + 建议 + 可操作按钮清单。UI 拿到直接渲染，不再裸展示英文原文。
 *
 * 类别：
 *   S3_UPLOAD          —— 上传链路失败（socket idle / 网络 / 服务端 5xx）
 *   SAFETY_THIRD_PARTY —— Runway 第三方审核拦截（输入侧）
 *   SAFETY_ASIMOV      —— Runway 自研审核拦截
 *   AUTH               —— JWT 过期 / 401 / 403
 *   QUOTA              —— 配额 / 并发 / 计费
 *   NETWORK            —— 其他纯网络错（离线 / DNS / CORS）
 *   UNKNOWN            —— 兜底
 */

export const ERROR_CATEGORIES = {
  S3_UPLOAD: 'S3_UPLOAD',
  SAFETY_THIRD_PARTY: 'SAFETY_THIRD_PARTY',
  SAFETY_ASIMOV: 'SAFETY_ASIMOV',
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN'
};

const ACTION = {
  EDIT_RETRY: { id: 'edit-retry', label: '编辑重试' },
  REPLACE_IMAGE: { id: 'replace-image', label: '更换参考图' },
  RELOGIN: { id: 'relogin', label: '重新登录 Runway' },
  VIEW_LOG: { id: 'view-log', label: '查看错误日志' },
  RETRY: { id: 'retry', label: '直接重试' },
  CONTACT: { id: 'contact', label: '联系支持' }
};

/**
 * @param {Error|object|string} input
 * @returns {{ category, severity, title, message, suggestion, actions, rawMessage, code }}
 */
export function classifyError(input) {
  const raw = normalizeInput(input);

  // 1. Runway 任务响应的 error 对象（最具体，优先判断）
  const taskCategory = classifyTaskError(raw);
  if (taskCategory) return taskCategory;

  // 2. 插件抛的带 code 的 Error
  if (raw.code) {
    if (raw.code === 'S3_TIMEOUT' || raw.code === 'S3_IDLE_TIMEOUT' || raw.code === 'S3_SERVER_ERROR' || raw.code === 'S3_UPLOAD_FAILED') {
      return buildS3UploadError(raw);
    }
    if (raw.code === 'AUTH_FAILED') {
      return buildAuthError(raw);
    }
  }

  // 3. HTTP 状态码
  if (raw.status === 401 || raw.status === 403) return buildAuthError(raw);
  if (raw.status === 429) return buildQuotaError(raw);
  if (raw.status >= 500) return buildNetworkError(raw);

  // 4. 消息关键词兜底
  const msg = raw.message || '';
  if (/SAFETY\.INPUT\.THIRD_PARTY/i.test(msg)) return buildSafetyThirdPartyError(raw);
  if (/asimov|SAFETY\.(INPUT|OUTPUT)\.ASIMOV/i.test(msg)) return buildSafetyAsimovError(raw);
  if (/RequestTimeout|socket connection/i.test(msg)) return buildS3UploadError(raw);
  if (/quota|limit|rate|并发|配额/i.test(msg)) return buildQuotaError(raw);
  if (/NetworkError|Failed to fetch|offline|ERR_/i.test(msg)) return buildNetworkError(raw);

  return {
    category: ERROR_CATEGORIES.UNKNOWN,
    severity: 'error',
    title: '任务失败',
    message: msg || '未知错误',
    suggestion: '如持续出现，请查看错误日志并反馈',
    actions: [ACTION.RETRY, ACTION.VIEW_LOG],
    rawMessage: msg,
    code: raw.code || null
  };
}

// ─── 规范化 ──────────────────────────────────────────────

function normalizeInput(input) {
  if (!input) return { message: '' };
  if (typeof input === 'string') return { message: input };

  // Runway task error 对象：{ reason, code, message, raw }
  if (input && (input.reason || input.code) && !(input instanceof Error) && typeof input.status !== 'number') {
    return {
      message: input.message || input.reason || '',
      reason: input.reason || null,
      code: input.code || null,
      taskError: true,
      raw: input.raw || null
    };
  }

  // Error 对象
  const out = {
    message: input.message || '',
    status: typeof input.status === 'number' ? input.status : null,
    code: input.code || null,
    body: input.body || null
  };
  // body 可能是个带 reason 的 JSON
  if (input.body && typeof input.body === 'object') {
    out.reason = input.body.reason || null;
    out.bodyMessage = input.body.errorMessage || input.body.message || null;
  }
  return out;
}

function classifyTaskError(raw) {
  const reason = raw.reason || '';
  if (!reason) return null;
  if (/SAFETY\.INPUT\.THIRD_PARTY/i.test(reason)) return buildSafetyThirdPartyError(raw);
  if (/SAFETY\.OUTPUT\.THIRD_PARTY/i.test(reason)) return buildSafetyOutputError(raw);
  if (/SAFETY\.(INPUT|OUTPUT)\.ASIMOV/i.test(reason) || /ASIMOV/i.test(reason)) return buildSafetyAsimovError(raw);
  if (/QUOTA|LIMIT|RATE/i.test(reason)) return buildQuotaError(raw);
  return null;
}

// ─── 各类错误文案 ────────────────────────────────────────

function buildS3UploadError(raw) {
  return {
    category: ERROR_CATEGORIES.S3_UPLOAD,
    severity: 'error',
    title: '图片上传失败',
    message: '上传参考图到 Runway 服务器超时。',
    suggestion: '通常是网络不稳定或图片过大。插件已经自动重试 3 次仍失败。建议：检查网络后直接重试；或换更小/更清晰的参考图。',
    actions: [ACTION.RETRY, ACTION.REPLACE_IMAGE, ACTION.VIEW_LOG],
    rawMessage: raw.message || '',
    code: raw.code || 'S3_UPLOAD_FAILED'
  };
}

function buildSafetyThirdPartyError(raw) {
  return {
    category: ERROR_CATEGORIES.SAFETY_THIRD_PARTY,
    severity: 'warning',
    title: '内容审核拦截（第三方审核）',
    message: '你的参考图或描述被 Runway 第三方内容审核拦截。',
    suggestion: '常见触发因素：真人近景人脸、品牌 Logo、暴露/血腥内容、敏感人物姓名。建议：① 更换参考图（避免明显人脸特写/品牌）；② 调整描述词（提交前已做本地预审，通过后仍被拒说明有模型无法识别的敏感点）。',
    actions: [ACTION.EDIT_RETRY, ACTION.REPLACE_IMAGE, ACTION.VIEW_LOG],
    rawMessage: raw.message || raw.reason || '',
    code: 'SAFETY.INPUT.THIRD_PARTY'
  };
}

function buildSafetyAsimovError(raw) {
  return {
    category: ERROR_CATEGORIES.SAFETY_ASIMOV,
    severity: 'warning',
    title: '内容审核拦截（Runway 自研）',
    message: 'Runway 自有审核模型 asimov 认为本次输入或输出违反使用政策。',
    suggestion: '请修改提示词（避免暴力/色情/政治/真实人物描述），或更换参考图后重试。',
    actions: [ACTION.EDIT_RETRY, ACTION.REPLACE_IMAGE, ACTION.VIEW_LOG],
    rawMessage: raw.message || raw.reason || '',
    code: 'SAFETY.ASIMOV'
  };
}

function buildSafetyOutputError(raw) {
  return {
    category: ERROR_CATEGORIES.SAFETY_THIRD_PARTY,
    severity: 'warning',
    title: '生成结果被审核拦截',
    message: '视频已生成但输出被 Runway 审核拦截，无法返回。',
    suggestion: '这种情况较少见，通常与模型生成了不合规画面有关。建议调整 prompt 后重试。',
    actions: [ACTION.EDIT_RETRY, ACTION.VIEW_LOG],
    rawMessage: raw.message || raw.reason || '',
    code: 'SAFETY.OUTPUT.THIRD_PARTY'
  };
}

function buildAuthError(raw) {
  return {
    category: ERROR_CATEGORIES.AUTH,
    severity: 'error',
    title: 'Runway 登录态失效',
    message: 'JWT 过期或权限不足。',
    suggestion: '请打开 Runway 网页重新登录，插件会自动捕获新的登录凭证。',
    actions: [ACTION.RELOGIN, ACTION.VIEW_LOG],
    rawMessage: raw.message || '',
    code: 'AUTH_FAILED'
  };
}

function buildQuotaError(raw) {
  return {
    category: ERROR_CATEGORIES.QUOTA,
    severity: 'warning',
    title: '配额或并发已达上限',
    message: '账号余额不足、达到并发上限，或触发日限流。',
    suggestion: '检查账号积分余额；等待当前任务跑完再提交下一批；若是团队账号，确认并发上限未被其他成员占满。',
    actions: [ACTION.VIEW_LOG],
    rawMessage: raw.message || '',
    code: 'QUOTA_EXCEEDED'
  };
}

function buildNetworkError(raw) {
  return {
    category: ERROR_CATEGORIES.NETWORK,
    severity: 'error',
    title: '网络异常',
    message: raw.status ? `服务器返回 ${raw.status}` : '无法连接到 Runway 服务器。',
    suggestion: '检查网络连接 / 代理设置；稍后直接重试即可。',
    actions: [ACTION.RETRY, ACTION.VIEW_LOG],
    rawMessage: raw.message || '',
    code: raw.code || 'NETWORK_ERROR'
  };
}

/**
 * 给历史任务一行简短错误文案（UI 任务卡片用），避免渲染大块
 */
export function formatShortError(input) {
  const cls = classifyError(input);
  return `${cls.title} · ${cls.message}`;
}
