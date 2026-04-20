/**
 * 批量导入 / 导出 / 视频下载
 *
 * 导出 zip 结构：
 *   shoploop-export-YYYY-MM-DDTHH-MM-SS.zip
 *     ├── tasks.json         # 机器可恢复（含 schemaVersion）
 *     ├── tasks.csv          # 人工可读（prompt/时长/状态/视频URL）
 *     └── images/<id>.<ext>  # 保留原扩展名（通过 blob.type 推断）
 *
 * 视频批量下载：
 *   shoploop-videos-YYYY-MM-DDTHH-MM-SS.zip
 *     ├── 01_<taskName 或 promptHead>.<ext>
 *     ├── ...
 *     └── failed.txt  # 失败清单（url 过期/网络错等）
 */

import { createZip, parseZip } from './zip-stream.js';
import { logError } from './error-log.js';

export const EXPORT_SCHEMA_VERSION = 2;

// ─── 工具 ────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safeFileName(s) {
  return String(s || '').slice(0, 80).replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'unnamed';
}

function mimeToExt(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
  };
  return map[mime] || 'bin';
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function tasksToCsv(tasks) {
  const header = ['id', 'name', 'platform', 'status', 'prompt', 'duration', 'aspectRatio', 'resolution', 'videoUrl', 'createdAt', 'error'];
  const lines = [header.join(',')];
  for (const t of tasks) {
    lines.push([
      t.id,
      t.name || '',
      t.platform || '',
      t.status || '',
      t.promptText || '',
      t.config?.duration || t.config?.durationSeconds || '',
      t.config?.aspectRatio || '',
      t.config?.resolution || '',
      t.videoUrl || '',
      t.createdAt ? new Date(t.createdAt).toISOString() : '',
      typeof t.error === 'string' ? t.error : (t.error?.message || '')
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ─── 导出任务 ────────────────────────────────────────────

/**
 * @param {Array} tasks - 要导出的完整任务对象数组
 * @param {Function} getImageBlob - async (imageId) => Blob | null
 * @param {Function} [onProgress] - (done, total, phase) => void
 */
export async function exportTasks(tasks, getImageBlob, onProgress = () => {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('没有可导出的任务');
  }

  onProgress(0, 1, 'prepare');

  // 清理 runtime 字段，让 zip 可以跨账号/跨设备重放
  const cleaned = tasks.map(t => ({
    ...t,
    status: 'pending',
    error: null,
    runwayTaskId: null,
    historyRecordId: null,
    videoUrl: null,
    thumbnailUrl: null,
    queueInfo: null
  }));

  const payload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    taskCount: cleaned.length,
    tasks: cleaned
  };

  const files = [];
  files.push({ name: 'tasks.json', data: new TextEncoder().encode(JSON.stringify(payload, null, 2)) });
  files.push({ name: 'tasks.csv', data: new TextEncoder().encode('\ufeff' + tasksToCsv(tasks)) }); // BOM for Excel

  // 收集图片
  const imageIds = new Set();
  for (const t of cleaned) {
    for (const img of (t.images || [])) {
      if (img.imageId) imageIds.add(img.imageId);
    }
  }

  let done = 0;
  for (const id of imageIds) {
    try {
      const blob = await getImageBlob(id);
      if (blob) {
        const ext = mimeToExt(blob.type);
        files.push({ name: `images/${id}.${ext}`, data: blob });
      }
    } catch (e) {
      console.warn('[export] 读取图片失败:', id, e);
    }
    done++;
    onProgress(done, imageIds.size, 'images');
  }

  onProgress(0, files.length, 'zipping');
  const blob = await createZip(files, {
    onProgress: (d, total) => onProgress(d, total, 'zipping')
  });

  triggerBlobDownload(blob, `shoploop-export-${timestamp()}.zip`);
  return { taskCount: cleaned.length, imageCount: imageIds.size, zipSize: blob.size };
}

// ─── 导入任务 ────────────────────────────────────────────

/**
 * @param {File} file
 * @param {Function} putImageRecord - async ({id, blob, fileName}) => void
 * @param {Function} addTask - async (task) => void
 */
export async function importTasks(file, putImageRecord, addTask) {
  if (!file) throw new Error('未选择文件');
  const buffer = await file.arrayBuffer();
  const entries = await parseZip(buffer);

  const tasksEntry = entries.find(e => e.name === 'tasks.json');
  if (!tasksEntry) throw new Error('ZIP 中找不到 tasks.json');

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(tasksEntry.data));
  } catch {
    throw new Error('tasks.json 格式错误（非合法 JSON）');
  }

  // 兼容对手的旧格式（对手直接写数组，我们是 { schemaVersion, tasks }）
  const tasks = Array.isArray(payload) ? payload : payload?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('tasks.json 中没有任务');
  }

  // 还原图片
  const imageEntries = entries.filter(e => e.name.startsWith('images/'));
  const imageIdSet = new Set();
  for (const e of imageEntries) {
    // 取文件名（去掉 images/ 和扩展名）
    const base = e.name.replace(/^images\//, '').replace(/\.[^.]+$/, '');
    if (!base) continue;
    const ext = (e.name.split('.').pop() || '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' :
                 ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                 ext === 'webp' ? 'image/webp' :
                 ext === 'gif' ? 'image/gif' : '';
    const blob = new Blob([e.data], mime ? { type: mime } : undefined);
    await putImageRecord({ id: base, blob });
    imageIdSet.add(base);
  }

  // 验证并添加任务
  let imported = 0;
  let skipped = 0;
  for (const task of tasks) {
    // 校验引用的图片是否齐全
    const missingImage = (task.images || []).some(img => img.imageId && !imageIdSet.has(img.imageId));
    if (missingImage) {
      console.warn('[import] 跳过任务（引用图片不在 zip 内）:', task.id);
      skipped++;
      continue;
    }
    task.id = crypto.randomUUID();
    task.status = 'pending';
    task.error = null;
    task.runwayTaskId = null;
    task.historyRecordId = null;
    task.videoUrl = null;
    task.thumbnailUrl = null;
    task.queueInfo = null;
    task.createdAt = Date.now();
    await addTask(task);
    imported++;
  }

  return { imported, skipped, total: tasks.length };
}

// ─── 批量下载视频 ────────────────────────────────────────

/**
 * 并发 N 个 fetch + AbortController + 失败清单
 * 返回 ZIP（含 failed.txt）
 */
export async function batchDownloadVideos(tasks, opts = {}) {
  const concurrency = opts.concurrency || 3;
  const timeoutMs = opts.timeoutMs || 60000;
  const onProgress = opts.onProgress || (() => {});

  const completed = tasks.filter(t => t.status === 'completed' && t.videoUrl);
  if (completed.length === 0) throw new Error('没有已完成且带 videoUrl 的任务');

  const zipFiles = [];
  const failed = [];
  let done = 0;

  async function downloadOne(task, index) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(task.videoUrl, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const ext = (task.videoUrl.match(/\.(mp4|webm|mov)(\?|$)/i)?.[1]) || mimeToExt(blob.type) || 'mp4';
      const label = safeFileName(task.name || task.promptText || `video_${index + 1}`);
      zipFiles.push({
        name: `${String(index + 1).padStart(2, '0')}_${label}.${ext}`,
        data: blob
      });
    } catch (err) {
      failed.push({ taskId: task.id, name: task.name || '', url: task.videoUrl, error: err.message });
      logError({
        error: err,
        taskId: task.id,
        platform: task.platform,
        context: { phase: 'batchDownloadVideo' }
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
      done++;
      onProgress(done, completed.length);
    }
  }

  // 并发池
  const queue = completed.map((t, i) => ({ task: t, index: i }));
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      await downloadOne(item.task, item.index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, completed.length) }, worker));

  if (zipFiles.length === 0) throw new Error('所有视频下载失败');

  // 失败清单
  if (failed.length > 0) {
    const txt = ['taskId,name,url,error', ...failed.map(f =>
      [f.taskId, f.name, f.url, f.error].map(csvEscape).join(',')
    )].join('\n');
    zipFiles.push({ name: 'failed.csv', data: new TextEncoder().encode(txt) });
  }

  const blob = await createZip(zipFiles, { compress: false /* MP4 已压缩，无必要再 deflate */ });
  triggerBlobDownload(blob, `shoploop-videos-${timestamp()}.zip`);
  return { total: completed.length, downloaded: zipFiles.length - (failed.length > 0 ? 1 : 0), failed: failed.length };
}
