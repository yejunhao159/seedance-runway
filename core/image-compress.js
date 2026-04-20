/**
 * 图片压缩与质量门禁
 *
 * 策略：
 *   - 最长边 > 2048 或 体积 > 1.5MB → 强制走 worker 压缩
 *   - 目标：最长边 2048、JPEG q=0.85（有 alpha 走 PNG）
 *   - 缩略图固定 320 边 JPEG q=0.72
 *
 * 入参：File/Blob
 * 返回：{ blob, thumbnail(dataURL), width, height, originalSize, compressedSize, wasCompressed }
 */

const COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;  // 1.5MB 以上强压
const COMPRESS_MAX_EDGE = 2048;
const COMPRESS_QUALITY = 0.85;
const THUMB_EDGE = 320;
const THUMB_QUALITY = 0.72;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

let workerSingleton = null;
let nextJobId = 1;
const pendingJobs = new Map();

function getWorker() {
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(chrome.runtime.getURL('image-processor.worker.js'), { type: 'classic' });
  workerSingleton.addEventListener('message', (event) => {
    const { id, success, storedBlob, thumbBlob, width, height, error } = event.data || {};
    const pending = pendingJobs.get(id);
    if (!pending) return;
    pendingJobs.delete(id);
    if (success) {
      pending.resolve({ storedBlob, thumbBlob, width, height });
    } else {
      pending.reject(new Error(error || '图片处理失败'));
    }
  });
  return workerSingleton;
}

function runWorkerJob(payload) {
  const id = nextJobId++;
  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...payload });
  });
}

async function hasAlphaChannel(file) {
  const header = await file.slice(0, 4).arrayBuffer();
  const bytes = new Uint8Array(header);
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取缩略图失败'));
    reader.readAsDataURL(blob);
  });
}

async function probeDimensions(file) {
  if (typeof createImageBitmap !== 'function') return { width: null, height: null };
  try {
    const bitmap = await createImageBitmap(file);
    const result = { width: bitmap.width, height: bitmap.height };
    if (typeof bitmap.close === 'function') bitmap.close();
    return result;
  } catch {
    return { width: null, height: null };
  }
}

/**
 * 判断是否需要压缩。暴露出去让 UI 可以提前提示用户"这张图太大要压了"
 */
export function shouldCompress({ size, width, height }) {
  if (size > COMPRESS_THRESHOLD_BYTES) return true;
  const longEdge = Math.max(width || 0, height || 0);
  if (longEdge > COMPRESS_MAX_EDGE) return true;
  return false;
}

/**
 * 核心入口：对一张图做压缩 + 生成缩略图
 * 小图（<1.5MB 且最长边<=2048）只生成缩略图，原图不动
 */
export async function compressImage(file) {
  const originalSize = file.size;
  const { width: rawW, height: rawH } = await probeDimensions(file);
  const needCompress = shouldCompress({ size: originalSize, width: rawW, height: rawH });
  const hasAlpha = await hasAlphaChannel(file);

  const storedType = hasAlpha ? 'image/png' : 'image/jpeg';

  const { storedBlob, thumbBlob, width, height } = await runWorkerJob({
    file,
    maxStoredEdge: needCompress ? COMPRESS_MAX_EDGE : Math.max(rawW || COMPRESS_MAX_EDGE, rawH || COMPRESS_MAX_EDGE),
    maxThumbEdge: THUMB_EDGE,
    storedType,
    storedQuality: COMPRESS_QUALITY,
    thumbType: 'image/jpeg',
    thumbQuality: THUMB_QUALITY
  });

  const thumbnail = await blobToDataUrl(thumbBlob);
  const finalBlob = needCompress ? storedBlob : file;

  return {
    blob: finalBlob,
    thumbnail,
    width: width || rawW,
    height: height || rawH,
    originalSize,
    compressedSize: finalBlob.size,
    wasCompressed: needCompress && finalBlob.size < originalSize
  };
}

/**
 * 格式化字节数，UI 用
 */
export function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
