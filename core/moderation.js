/**
 * 客户端前置预审（Pre-flight moderation）
 *
 * 职责：
 *   1. Prompt 词命中检查（内置词表 + 用户自定义词表）
 *   2. 图片格式/尺寸预检（过小、过大、无法解码）
 *   3. 返回结构化命中结果 + 分类改写建议
 *
 * 不做：
 *   - 不做自动 prompt 重写（用户明确要求）
 *   - 不阻塞提交（用户可以无视建议"强行提交"；只记录到错误日志）
 */

import { DEFAULT_WORDS, CATEGORY_LABEL, CATEGORY_ADVICE } from './sensitive-words.js';

const STORAGE_KEY_USER_WORDS = 'moderation.userWords';
// userWords 形态：{ nsfw: [], violence: [], political: [], celebrity: [], brand: [], custom: [] }

const MIN_IMAGE_EDGE = 320;          // 短边 < 320 过小
const MIN_IMAGE_BYTES = 5 * 1024;    // < 5KB 疑似损坏
const MAX_IMAGE_BYTES = 40 * 1024 * 1024; // 40MB 超出 Runway 单 part 上限
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

// ─── 用户词表管理 ───────────────────────────────────────

export async function getUserWords() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return emptyUserWords();
  const stored = await chrome.storage.local.get(STORAGE_KEY_USER_WORDS);
  const val = stored[STORAGE_KEY_USER_WORDS];
  if (!val || typeof val !== 'object') return emptyUserWords();
  // 补齐缺失 category
  const base = emptyUserWords();
  for (const k of Object.keys(base)) {
    if (Array.isArray(val[k])) base[k] = val[k].slice();
  }
  return base;
}

export async function saveUserWords(userWords) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.set({ [STORAGE_KEY_USER_WORDS]: userWords });
}

export async function addUserWord(category, word) {
  const w = String(word || '').trim();
  if (!w) return;
  const cat = Object.keys(emptyUserWords()).includes(category) ? category : 'custom';
  const userWords = await getUserWords();
  if (!userWords[cat].includes(w)) userWords[cat].push(w);
  await saveUserWords(userWords);
}

export async function removeUserWord(category, word) {
  const userWords = await getUserWords();
  if (!userWords[category]) return;
  userWords[category] = userWords[category].filter((w) => w !== word);
  await saveUserWords(userWords);
}

export async function resetUserWords() {
  await saveUserWords(emptyUserWords());
}

function emptyUserWords() {
  return { nsfw: [], violence: [], political: [], celebrity: [], brand: [], custom: [] };
}

// ─── Prompt 预审 ────────────────────────────────────────

/**
 * 合并内置 + 用户词表，返回 { category: [word...] }
 */
async function getMergedWords() {
  const user = await getUserWords();
  const merged = {};
  for (const cat of Object.keys(DEFAULT_WORDS)) {
    merged[cat] = [...DEFAULT_WORDS[cat]];
  }
  for (const cat of Object.keys(user)) {
    if (!merged[cat]) merged[cat] = [];
    for (const w of user[cat]) {
      if (!merged[cat].includes(w)) merged[cat].push(w);
    }
  }
  return merged;
}

/**
 * 检查 prompt 是否命中敏感词
 * @param {string} text
 * @returns {Promise<{ ok, hits: Array<{word, category, label, advice}>, hitCount }>}
 */
export async function checkPrompt(text) {
  const s = String(text || '');
  if (!s.trim()) return { ok: true, hits: [], hitCount: 0 };

  const words = await getMergedWords();
  const lower = s.toLowerCase();
  const hits = [];

  for (const cat of Object.keys(words)) {
    for (const w of words[cat]) {
      if (!w) continue;
      const needle = w.toLowerCase();
      if (lower.includes(needle)) {
        hits.push({
          word: w,
          category: cat,
          label: CATEGORY_LABEL[cat] || cat,
          advice: CATEGORY_ADVICE[cat] || '建议修改或移除。'
        });
      }
    }
  }

  return { ok: hits.length === 0, hits, hitCount: hits.length };
}

// ─── 图片预检 ────────────────────────────────────────────

/**
 * 检查单张图片的基础质量
 * @param {File|Blob} file
 * @returns {Promise<{ ok, issues: Array<{level, message}> }>}
 */
export async function checkImage(file) {
  const issues = [];
  if (!file || !(file instanceof Blob)) {
    return { ok: false, issues: [{ level: 'error', message: '图片不是有效的文件对象' }] };
  }

  if (file.size < MIN_IMAGE_BYTES) {
    issues.push({ level: 'error', message: `文件过小（${file.size} 字节），可能已损坏` });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    issues.push({ level: 'error', message: `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），超过 40MB 上限` });
  }
  if (file.type && !ACCEPTED_MIME.includes(file.type)) {
    issues.push({ level: 'warning', message: `格式 ${file.type} 可能不被 Runway 接受，建议转 JPEG/PNG` });
  }

  // 尺寸检测
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const shortEdge = Math.min(bitmap.width, bitmap.height);
      if (shortEdge < MIN_IMAGE_EDGE) {
        issues.push({ level: 'warning', message: `短边 ${shortEdge}px 过小（建议 ≥${MIN_IMAGE_EDGE}px），生成质量会受影响` });
      }
      if (typeof bitmap.close === 'function') bitmap.close();
    } catch {
      issues.push({ level: 'error', message: '图片无法解码，可能已损坏' });
    }
  }

  const hasError = issues.some((i) => i.level === 'error');
  return { ok: !hasError, issues };
}

/**
 * 综合检查（prompt + 图片数组）
 * @param {{ prompt: string, images?: Array<File|Blob> }} input
 */
export async function preflightCheck({ prompt, images = [] }) {
  const promptResult = await checkPrompt(prompt);
  const imageResults = [];
  for (let i = 0; i < images.length; i++) {
    const r = await checkImage(images[i]);
    imageResults.push({ index: i, ...r });
  }
  const imageOk = imageResults.every((r) => r.ok);
  return {
    ok: promptResult.ok && imageOk,
    prompt: promptResult,
    images: imageResults,
    summary: buildSummary(promptResult, imageResults)
  };
}

function buildSummary(promptResult, imageResults) {
  const parts = [];
  if (promptResult.hitCount > 0) {
    const byCat = {};
    for (const h of promptResult.hits) byCat[h.label] = (byCat[h.label] || 0) + 1;
    parts.push('描述词命中：' + Object.entries(byCat).map(([k, v]) => `${k}×${v}`).join('、'));
  }
  const imgProblems = imageResults.flatMap((r) => r.issues.map((i) => ({ ...i, idx: r.index })));
  if (imgProblems.length > 0) {
    parts.push(`图片问题 ${imgProblems.length} 项`);
  }
  return parts.length === 0 ? '全部通过' : parts.join('；');
}
