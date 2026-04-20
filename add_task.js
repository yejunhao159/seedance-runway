import { putImageRecord, getImageRecord } from './image-store.js';
import { compressImage, formatBytes } from './core/image-compress.js';
import { preflightCheck } from './core/moderation.js';
import { logError } from './core/error-log.js';

// 预审"用户已知晓并坚持提交"标记
let moderationAcknowledged = false;

let editTaskId = null;
let duplicateTaskId = null;
let selectedImages = [];
let lastFocusedInput = null;
const DEFAULT_BATCH_CONFIG = {
  model: 'seedance_2_fast',
  referenceMode: 'all_reference',
  aspectRatio: '9:16',
  durationMode: 'auto',
  durationSeconds: 4
};
const DEFAULT_SPLIT_MODE = 'line';
const MIN_DURATION_SECONDS = 4;
const MAX_DURATION_SECONDS = 15;

// Stage 3 引入：平台切换。null 表示未初始化（fallback 到即梦）
let currentPlatform = 'jimeng';

function getCurrentPlatform() {
  const sel = document.getElementById('taskPlatform');
  return sel?.value || currentPlatform;
}

function applyPlatformVisibility(platform) {
  currentPlatform = platform;
  document.querySelectorAll('[data-platform-fields]').forEach((el) => {
    el.hidden = el.dataset.platformFields !== platform;
  });
  document.querySelectorAll('[data-platform-only]').forEach((el) => {
    el.hidden = el.dataset.platformOnly !== platform;
  });
}

function init() {
  const urlParams = new URLSearchParams(window.location.search);
  editTaskId = urlParams.get('edit');
  duplicateTaskId = urlParams.get('duplicate');

  if (editTaskId) {
    const titleEl = document.getElementById('modalTitle');
    const saveBtn = document.getElementById('saveTaskBtn');
    if (titleEl) titleEl.textContent = '编辑任务';
    if (saveBtn) saveBtn.textContent = '保存更改';
    loadTaskIntoForm(editTaskId);
  } else if (duplicateTaskId) {
    const titleEl = document.getElementById('modalTitle');
    const saveBtn = document.getElementById('saveTaskBtn');
    if (titleEl) titleEl.textContent = '基于任务新建';
    if (saveBtn) saveBtn.textContent = '创建任务';
    loadTaskIntoForm(duplicateTaskId);
  } else {
    restoreFormCache();
  }

  // 预审面板"我已了解"按钮
  const moderationDismissBtn = document.getElementById('moderationDismissBtn');
  if (moderationDismissBtn) {
    moderationDismissBtn.addEventListener('click', () => {
      moderationAcknowledged = true;
      document.getElementById('moderationPanel').hidden = true;
      saveTask();
    });
  }

  const globalPrompt = document.getElementById('globalPrompt');
  const taskPrompt = document.getElementById('taskPrompt');
  
  // 记录最后聚焦的输入框，默认为局部提示词
  lastFocusedInput = taskPrompt;
  globalPrompt.addEventListener('focus', () => { lastFocusedInput = globalPrompt; });
  taskPrompt.addEventListener('focus', () => { lastFocusedInput = taskPrompt; });

  document.getElementById('cancelTaskBtn').addEventListener('click', () => {
    closeTaskWindow();
  });
  document.getElementById('saveTaskBtn').addEventListener('click', saveTask);
  
  // 图片选择现在通过 label + input[type=file] 原生触发，不再需要手动 .click()
  document.getElementById('taskImages').addEventListener('change', handleImageSelect);
  
  // 平台切换
  const platformSel = document.getElementById('taskPlatform');
  if (platformSel) {
    platformSel.addEventListener('change', (e) => applyPlatformVisibility(e.target.value));
    applyPlatformVisibility(platformSel.value || 'jimeng');
  }

  document.getElementById('taskReferenceMode').addEventListener('change', updateTaskImagesHint);
  document.getElementById('globalPrompt').addEventListener('input', () => { updateBatchPreview(); saveFormCache(); });
  document.getElementById('taskName').addEventListener('input', saveFormCache);
  document.getElementById('taskPrompt').addEventListener('input', updateBatchPreview);
  document.getElementById('taskPrompt').addEventListener('change', updateBatchPreview);
  document.getElementById('taskComposeMode').addEventListener('change', updateBatchPreview);
  document.getElementById('taskSplitMode').addEventListener('change', () => {
    updateSplitModeHint();
    updateBatchPreview();
  });
  document.getElementById('taskDuration').addEventListener('change', () => {
    updateDurationHint();
    updateBatchPreview();
  });
  document.getElementById('openBatchPreviewBtn').addEventListener('click', openBatchModal);
  document.getElementById('closeBatchModalBtn').addEventListener('click', closeBatchModal);
  document.getElementById('batchModalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('batchModalOverlay')) closeBatchModal();
  });
  
  updateTaskImagesHint();
  updateSplitModeHint();
  updateDurationHint();
  updateBatchPreview();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function loadTaskIntoForm(taskId) {
  try {
    const { batchTasks } = await chrome.storage.local.get(['batchTasks']);
    const task = batchTasks?.find(t => t.id === taskId);

    if (!task) {
      alert('未找到任务');
      return;
    }

    const promptMeta = task.promptMeta || {};
    document.getElementById('taskName').value = task.name || '';
    document.getElementById('globalPrompt').value = promptMeta.globalPromptText || '';
    document.getElementById('taskPrompt').value = promptMeta.localPromptText || task.promptText || '';
    document.getElementById('taskComposeMode').value = promptMeta.composeMode || 'prepend';
    document.getElementById('taskSplitMode').value = promptMeta.splitMode || DEFAULT_SPLIT_MODE;

    const platformId = task.platform || 'jimeng';
    const platformSel = document.getElementById('taskPlatform');
    if (platformSel) {
      platformSel.value = platformId;
      applyPlatformVisibility(platformId);
    }

    if (platformId === 'runway') {
      document.getElementById('runwayModel').value = task.config?.model || 'seedance_2';
      document.getElementById('runwayDuration').value = String(task.config?.duration || 5);
      document.getElementById('runwayResolution').value = task.config?.resolution || '480p';
      document.getElementById('runwayAspectRatio').value = task.config?.aspectRatio || '16:9';
      document.getElementById('runwayGenerateAudio').checked = task.config?.generateAudio !== false;
      document.getElementById('runwayExploreMode').checked = task.config?.exploreMode !== false;
    } else {
      document.getElementById('taskModel').value = task.config?.model || 'seedance_2_fast';
      document.getElementById('taskReferenceMode').value = task.config?.referenceMode || 'all_reference';
      document.getElementById('taskAspectRatio').value = task.config?.aspectRatio || '16:9';
      document.getElementById('taskDuration').value = task.config?.durationMode === 'auto'
        ? 'auto'
        : String(task.config?.durationSeconds || DEFAULT_BATCH_CONFIG.durationSeconds);
    }

    if (task.images && task.images.length > 0) {
      const previewList = document.getElementById('imagePreviewList');
      const isFirstLastFrames = task.config?.referenceMode === 'first_last_frames';

      task.images.forEach((img, index) => {
        selectedImages.push({
          name: img.fileName,
          preview: img.preview,
          imageId: img.imageId || null,
          uri: img.uri,
          isExisting: true
        });

        const item = document.createElement('div');
        item.className = 'image-preview-item';
        item.innerHTML = `
          <img src="${img.preview}" alt="${escapeHtml(img.fileName)}">
          <div class="image-index" style="display: ${isFirstLastFrames ? 'none' : 'block'}">{${index}}</div>
          <button class="image-preview-insert" style="display: ${isFirstLastFrames ? 'none' : 'inline-block'}">插入引用</button>
          <button class="image-preview-remove">&times;</button>
        `;
        previewList.appendChild(item);
        bindImagePreviewEvents(item, previewList);
      });
    }

    updateTaskImagesHint();
    updateSplitModeHint();
    updateDurationHint();
    updateBatchPreview();
  } catch (error) {
    console.error('加载任务失败:', error);
  }
}

function bindImagePreviewEvents(item, previewList) {
  item.querySelector('.image-preview-insert').addEventListener('click', (e) => {
    e.preventDefault();
    const actualIndex = Array.from(previewList.children).indexOf(item);
    const promptInput = lastFocusedInput || document.getElementById('taskPrompt');
    const cursorPos = promptInput.selectionStart ?? promptInput.value.length;
    const placeholder = `{${actualIndex}}`;
    promptInput.value = promptInput.value.slice(0, cursorPos) + placeholder + promptInput.value.slice(cursorPos);
    promptInput.focus();
    promptInput.setSelectionRange(cursorPos + placeholder.length, cursorPos + placeholder.length);
    // 插入后触发可能存在的预览更新
    const event = new Event('input', { bubbles: true });
    promptInput.dispatchEvent(event);
  });

  item.querySelector('.image-preview-remove').addEventListener('click', () => {
    const actualIndex = Array.from(previewList.children).indexOf(item);
    const [removedImage] = selectedImages.splice(actualIndex, 1);
    releasePreviewResource(removedImage);
    item.remove();

    Array.from(previewList.children).forEach((child, newIndex) => {
      const indexEl = child.querySelector('.image-index');
      if (indexEl) indexEl.textContent = `{${newIndex}}`;
    });
  });
}

function handleImageSelect(event) {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  const previewList = document.getElementById('imagePreviewList');
  const startIndex = selectedImages.length;

  files.forEach((file, relativeIndex) => {
    const index = startIndex + relativeIndex;
    const objectUrl = URL.createObjectURL(file);
    selectedImages.push({
      file,
      name: file.name,
      previewUrl: objectUrl,
      objectUrl,
      isExisting: false
    });

    const item = document.createElement('div');
    item.className = 'image-preview-item';
    const isFirstLastFrames = document.getElementById('taskReferenceMode').value === 'first_last_frames';
    item.innerHTML = `
      <img src="${objectUrl}" alt="${escapeHtml(file.name)}">
      <div class="image-index" style="display: ${isFirstLastFrames ? 'none' : 'block'}">{${index}}</div>
      <button class="image-preview-insert" style="display: ${isFirstLastFrames ? 'none' : 'inline-block'}">插入引用</button>
      <button class="image-preview-remove">&times;</button>
    `;
    previewList.appendChild(item);
    bindImagePreviewEvents(item, previewList);
  });

  event.target.value = '';
}

function updateTaskImagesHint() {
  const mode = document.getElementById('taskReferenceMode')?.value || DEFAULT_BATCH_CONFIG.referenceMode;
  const hint = document.getElementById('taskImagesHint');

  if (hint) {
    hint.textContent = mode === 'first_last_frames'
      ? '首尾帧可以只传 1 张图，也支持按首帧、尾帧顺序连续上传添加；超过 2 张时将取首尾两张。'
      : '全能参考支持使用 {0}、{1} 占位符映射到图片引用；当前支持 Seedance 2.0 和 Seedance 2.0 Fast。';
  }

  document.querySelectorAll('.image-index').forEach(el => {
    el.style.display = mode === 'first_last_frames' ? 'none' : 'block';
  });
  document.querySelectorAll('.image-preview-insert').forEach(el => {
    el.style.display = mode === 'first_last_frames' ? 'none' : 'inline-block';
  });
}

async function generateThumbnail(file, maxSize) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return {
        thumbnail: canvas.toDataURL('image/jpeg', 0.72),
        width: bitmap.width || null,
        height: bitmap.height || null
      };
    } finally {
      if (typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(objectUrl);
    const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return {
      thumbnail: canvas.toDataURL('image/jpeg', 0.72),
      width: img.naturalWidth || img.width || null,
      height: img.naturalHeight || img.height || null
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function releasePreviewResource(image) {
  if (image?.objectUrl) {
    URL.revokeObjectURL(image.objectUrl);
    image.objectUrl = null;
  }
}

function releaseAllPreviewResources() {
  selectedImages.forEach(releasePreviewResource);
}

function validateFirstLastFrameImageRatios(images, config) {
  if (config?.referenceMode !== 'first_last_frames') {
    return;
  }

  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imageList.length < 2) {
    return;
  }

  const [firstImage, lastImage] = imageList;
  const firstWidth = Number(firstImage?.width || 0);
  const firstHeight = Number(firstImage?.height || 0);
  const lastWidth = Number(lastImage?.width || 0);
  const lastHeight = Number(lastImage?.height || 0);

  if (!firstWidth || !firstHeight || !lastWidth || !lastHeight) {
    return;
  }

  const firstRatio = firstWidth / firstHeight;
  const lastRatio = lastWidth / lastHeight;
  const ratioDelta = Math.abs(firstRatio - lastRatio);
  const tolerance = 0.01;

  if (ratioDelta <= tolerance) {
    return;
  }

  throw new Error(`首尾帧图片比例不一致：首帧 ${firstWidth}x${firstHeight}，尾帧 ${lastWidth}x${lastHeight}。请使用相同比例的两张图片。`);
}

async function saveTask() {
  const platformId = getCurrentPlatform();
  const taskName = document.getElementById('taskName').value.trim();
  const globalPrompt = document.getElementById('globalPrompt').value.trim();
  const raw = document.getElementById('taskPrompt').value.trim();
  const composeMode = document.getElementById('taskComposeMode').value;
  const splitMode = document.getElementById('taskSplitMode').value;

  let baseConfig;
  let durationMode;
  if (platformId === 'runway') {
    // Runway 表单：固定时长（5/10），不支持 auto，没有 referenceMode
    durationMode = 'manual';
    baseConfig = {
      model: document.getElementById('runwayModel').value,
      duration: Number(document.getElementById('runwayDuration').value),
      resolution: document.getElementById('runwayResolution').value,
      aspectRatio: document.getElementById('runwayAspectRatio').value,
      generateAudio: document.getElementById('runwayGenerateAudio').checked,
      exploreMode: document.getElementById('runwayExploreMode').checked
    };
  } else {
    const durationValue = document.getElementById('taskDuration').value;
    durationMode = durationValue === 'auto' ? 'auto' : 'manual';
    baseConfig = {
      model: document.getElementById('taskModel').value,
      referenceMode: document.getElementById('taskReferenceMode').value,
      aspectRatio: document.getElementById('taskAspectRatio').value,
      durationMode,
      durationSeconds: durationMode === 'auto' ? DEFAULT_BATCH_CONFIG.durationSeconds : Number(durationValue)
    };
  }

  if (!raw) {
    alert('请输入提示词');
    return;
  }

  const segments = parsePromptSegments(raw, splitMode);
  if (editTaskId && segments.length > 1) {
    alert('编辑单个任务时，只能保留一段提示词');
    return;
  }

  let drafts;
  try {
    drafts = buildTaskDrafts({
      segments,
      globalPrompt,
      composeMode,
      durationMode,
      manualDurationSeconds: platformId === 'runway' ? baseConfig.duration : baseConfig.durationSeconds,
      strict: true
    });

    const mustConfirmWarnings = drafts
      .filter(d => d.warnings.some(w => w.includes('范围')))
      .map(d => `第 ${d.index + 1} 条任务：${d.warnings.find(w => w.includes('范围'))}`);

    if (mustConfirmWarnings.length > 0) {
      const msg = `自动时长解析到部分任务超出范围（支持 ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS} 秒）：\n\n${mustConfirmWarnings.join('\n')}\n\n是否统一修正为最接近的有效值？`;
      if (!confirm(msg)) {
        return;
      }
    }
  } catch (error) {
    alert(error.message);
    return;
  }

  // ─── 客户端前置预审（prompt 敏感词 + 图片格式）───────────
  // 若命中且用户未点"我已了解"，展示面板并中止本次保存
  if (!moderationAcknowledged) {
    try {
      const combined = [globalPrompt, raw].filter(Boolean).join(' ');
      const imageBlobs = selectedImages.filter(i => i.file).map(i => i.file);
      const pre = await preflightCheck({ prompt: combined, images: imageBlobs });
      if (!pre.ok) {
        showModerationPanel(pre);
        return;
      }
    } catch (e) {
      console.warn('[moderation] 预审失败（跳过，不阻塞）:', e);
    }
  }
  moderationAcknowledged = false; // 重置，下次保存仍需预审

  const btn = document.getElementById('saveTaskBtn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = drafts.length > 1 ? `处理中 (0/${drafts.length})...` : '处理中...';

  const imagePromises = selectedImages.map((file) => {
    if (file.isExisting) {
      return Promise.resolve({
        fileName: file.name,
        preview: file.preview,
        imageId: file.imageId || null,
        uri: file.uri,
        width: file.width || null,
        height: file.height || null
      });
    }

    return (async () => {
      const { blob, thumbnail, width, height, originalSize, compressedSize, wasCompressed } = await compressImage(file.file);
      const imageId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      await putImageRecord({ id: imageId, blob, fileName: file.name });
      if (wasCompressed) {
        console.info(`[compress] ${file.name}: ${formatBytes(originalSize)} → ${formatBytes(compressedSize)}`);
      }
      return {
        fileName: file.name,
        preview: thumbnail,
        imageId,
        width,
        height,
        originalSize,
        compressedSize,
        wasCompressed
      };
    })();
  });

  Promise.all(imagePromises)
    .then(async (images) => {
      // 即梦专属验证：首尾帧模式要求图片比例匹配。Runway 没有这个概念，跳过。
      if (platformId === 'jimeng') {
        validateFirstLastFrameImageRatios(images, baseConfig);
      }

      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        if (drafts.length > 1) {
          btn.textContent = `处理中 (${i + 1}/${drafts.length})...`;
        }

        // 按平台构造 task config
        const taskConfig = platformId === 'runway'
          ? { ...baseConfig, prompt: draft.promptText }
          : { ...baseConfig, durationSeconds: draft.durationSeconds };

        const taskPayload = {
          platform: platformId,
          name: taskName
            ? (drafts.length > 1 ? `${taskName}_${String(i + 1).padStart(2, '0')}` : taskName)
            : '',
          promptText: draft.promptText,
          images,
          config: taskConfig,
          promptMeta: {
            localPromptText: draft.localPromptText,
            globalPromptText: globalPrompt,
            composeMode,
            splitMode
          }
        };

        const message = editTaskId
          ? { type: 'UPDATE_BATCH_TASK', taskId: editTaskId, task: taskPayload }
          : { type: 'ADD_BATCH_TASK', task: taskPayload };

        const response = await sendMessage(message);
        if (response && response.success === false) {
          throw new Error(response.error || '后台拒绝了请求');
        }
        if (editTaskId) break;
      }
      chrome.runtime.sendMessage({ type: 'TASK_ADDED_SUCCESSFULLY' });
      releaseAllPreviewResources();
      chrome.storage.local.remove('formCache').catch(() => {});
      closeTaskWindow();
    })
    .catch((error) => {
      console.error('保存任务失败:', error);
      logError({
        error,
        platform: platformId,
        promptText: raw,
        imageIds: selectedImages.filter(i => i.imageId).map(i => i.imageId),
        context: { phase: 'saveTask' }
      }).catch(() => {});
      alert(`保存任务失败: ${error.message}`);
      btn.disabled = false;
      btn.textContent = originalText;
    });
}

function showModerationPanel(pre) {
  const panel = document.getElementById('moderationPanel');
  const result = document.getElementById('moderationResult');
  if (!panel || !result) return;

  const lines = [];
  if (pre.prompt.hitCount > 0) {
    lines.push(`⚠ 描述词命中 ${pre.prompt.hitCount} 项敏感词：`);
    const byCat = {};
    for (const h of pre.prompt.hits) {
      if (!byCat[h.label]) byCat[h.label] = { words: [], advice: h.advice };
      byCat[h.label].words.push(h.word);
    }
    for (const [label, info] of Object.entries(byCat)) {
      lines.push(`  · [${label}] ${info.words.join('、')}`);
      lines.push(`    建议：${info.advice}`);
    }
  }
  const imgIssues = pre.images.filter(r => !r.ok || r.issues.length > 0);
  if (imgIssues.length > 0) {
    lines.push('');
    lines.push(`⚠ 图片预检发现 ${imgIssues.length} 张有问题：`);
    for (const r of imgIssues) {
      for (const issue of r.issues) {
        const tag = issue.level === 'error' ? '✗' : '!';
        lines.push(`  ${tag} 第 ${r.index + 1} 张：${issue.message}`);
      }
    }
  }
  lines.push('');
  lines.push('这些命中是基于本地词表的前置检查，不代表 Runway 一定拒绝。');
  lines.push('你可以：① 点"编辑"修改后再保存；② 或点右上角"我已了解，继续提交"强行保存。');

  result.textContent = lines.join('\n');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── 表单缓存（全局提示词 + 任务名 + 参考图） ──────────────
async function saveFormCache() {
  const globalPrompt = document.getElementById('globalPrompt').value;
  const taskName = document.getElementById('taskName').value;
  const images = selectedImages.map(img => ({
    fileName: img.name,
    preview: img.previewUrl || img.preview,
    imageId: img.imageId || null,
    width: img.width || null,
    height: img.height || null
  }));
  try {
    await chrome.storage.local.set({ formCache: { globalPrompt, taskName, images } });
  } catch {}
}

async function restoreFormCache() {
  try {
    const { formCache } = await chrome.storage.local.get('formCache');
    if (!formCache) return;
    if (formCache.globalPrompt) document.getElementById('globalPrompt').value = formCache.globalPrompt;
    if (formCache.taskName) document.getElementById('taskName').value = formCache.taskName;
    updateBatchPreview();
  } catch (e) {
    console.warn('恢复表单缓存失败:', e);
  }
}

function parsePromptSegments(raw, splitMode = DEFAULT_SPLIT_MODE) {
  const normalized = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!normalized) {
    return [];
  }

  // 编辑模式：视为一个整体任务，不进行任何拆分
  if (editTaskId) {
    return [normalized];
  }

  if (splitMode === 'shot') {
    return parseShotSegments(normalized);
  }

  if (splitMode === 'block') {
    // 按空行分割：匹配连续两个或更多换行符
    return normalized
      .split(/\n\s*\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  // 默认：逐行分割 (line)
  // 严格按换行拆分每一行
  return normalized
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function parseShotSegments(normalized) {
  const headingPattern = /^(?:镜头|场景|分镜|shot|scene)\s*[A-Za-z0-9一二三四五六七八九十百零]*\s*[：:]/im;
  const headingSplitPattern = /(?=^(?:镜头|场景|分镜|shot|scene)\s*[A-Za-z0-9一二三四五六七八九十百零]*\s*[：:])/im;

  if (headingPattern.test(normalized)) {
    const headingSegments = normalized
      .split(headingSplitPattern)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (headingSegments.length > 1) {
      return headingSegments;
    }
  }

  // 如果没有匹配到镜头标题，回退到空行分割逻辑
  return normalized
    .split(/\n\s*\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function composePrompt(globalPrompt, localPrompt, composeMode) {
  const orderedParts = composeMode === 'append'
    ? [localPrompt, globalPrompt]
    : [globalPrompt, localPrompt];

  return orderedParts
    .map(part => (part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function extractAutoDuration(localPromptText) {
  // 使用更通用的全局匹配找出所有的 "x秒"
  const regex = /(\d+(?:\.\d+)?)\s*秒/g;
  const matches = [...localPromptText.matchAll(regex)];

  if (matches.length === 0) {
    return { error: '未识别到“x秒”' };
  }

  let totalRawDuration = 0;
  let matchedTexts = [];

  for (const match of matches) {
    const val = Number(match[1]);
    if (Number.isFinite(val)) {
      totalRawDuration += val;
      matchedTexts.push(match[0].trim());
    }
  }

  if (totalRawDuration === 0) {
    return { error: '未识别到有效时长' };
  }

  const originalSeconds = Math.round(totalRawDuration);
  let durationSeconds = originalSeconds;
  let isOutOfRange = false;

  if (durationSeconds < MIN_DURATION_SECONDS) {
    durationSeconds = MIN_DURATION_SECONDS;
    isOutOfRange = true;
  } else if (durationSeconds > MAX_DURATION_SECONDS) {
    durationSeconds = MAX_DURATION_SECONDS;
    isOutOfRange = true;
  }

  return {
    durationSeconds,
    originalSeconds,
    matchedText: matchedTexts.join(' + '),
    isOutOfRange,
    suggestion: isOutOfRange ? `${originalSeconds}秒 -> ${durationSeconds}秒` : null,
    isSummed: matches.length > 1
  };
}

function buildTaskDrafts({
  segments,
  globalPrompt,
  composeMode,
  durationMode,
  manualDurationSeconds,
  strict = false
}) {
  const drafts = segments.map((segment, index) => {
    const promptText = composePrompt(globalPrompt, segment, composeMode);
    const draft = {
      index,
      localPromptText: segment,
      promptText,
      durationMode,
      durationSeconds: manualDurationSeconds,
      errors: [],
      warnings: []
    };

    if (durationMode === 'auto') {
      const detected = extractAutoDuration(segment);
      if (detected.error) {
        draft.errors.push(detected.error);
      } else {
        draft.durationMode = 'manual'; // 识别成功后，直接设为手动固定时长模式
        draft.durationSeconds = detected.durationSeconds;
        draft.durationSourceText = detected.matchedText;
        if (detected.isOutOfRange) {
          draft.warnings.push(`${detected.isSummed ? '总' : ''}时长 ${detected.originalSeconds}秒超出范围（仅支持 ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}秒），建议修正为 ${detected.durationSeconds}秒`);
        } else if (detected.isSummed) {
          // 如果只是累加但没越界，仅记录信息，不一定触发保存时的 confirm (取决于 saveTask 逻辑)
          // 我们可以给它加一个特殊的标记，让 saveTask 跳过它，或者直接加在 warnings 里让用户确认一下也更稳
          draft.warnings.push(`检测到多镜头时长，已自动累加：${detected.matchedText} = ${detected.originalSeconds}秒`);
        }
      }
    }

    return draft;
  });

  if (strict) {
    const criticalErrors = drafts
      .filter(draft => draft.errors.length > 0)
      .map(draft => `第 ${draft.index + 1} 条任务：${draft.errors.join('，')}`);

    if (criticalErrors.length > 0) {
      throw new Error(`自动时长识别失败：\n${criticalErrors.join('\n')}`);
    }
  }

  return drafts;
}

function updateDurationHint() {
  const durationValue = document.getElementById('taskDuration')?.value;
  const hint = document.getElementById('taskDurationHint');
  if (!hint) return;

  hint.textContent = durationValue === 'auto'
    ? `自动时长会读取每段任务提示词里的第一组 x秒，支持 ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS} 秒，也支持 |4秒 或 ｜4秒。`
    : '手动时长会统一应用到所有任务。';
}

function updateSplitModeHint() {
  const splitMode = document.getElementById('taskSplitMode')?.value || DEFAULT_SPLIT_MODE;
  const hint = document.getElementById('taskSplitModeHint');
  if (!hint) return;

  const labels = {
    line: '逐行分割会把每一条非空行视为一个任务。',
    block: '空行分割会按空行或双换行符对任务进行拆分。',
    shot: '镜头序号分割会按“镜头一：”“镜头二：”这类标题自动拆成多条任务。'
  };

  hint.textContent = labels[splitMode] || '';
}

function updateBatchPreview() {
  const raw = document.getElementById('taskPrompt').value;
  const splitMode = document.getElementById('taskSplitMode')?.value || DEFAULT_SPLIT_MODE;
  const segments = parsePromptSegments(raw, splitMode);
  const countEl = document.getElementById('batchTaskCount');
  const triggerEl = document.getElementById('batchPreviewTrigger');
  const btn = document.getElementById('openBatchPreviewBtn');

  if (segments.length <= 1) {
    countEl.textContent = '';
    triggerEl.style.display = 'none';
    return;
  }

  countEl.textContent = `共 ${segments.length} 个任务`;
  btn.textContent = `预览全部 ${segments.length} 个任务`;
  triggerEl.style.display = 'block';
}

function openBatchModal() {
  const raw = document.getElementById('taskPrompt').value;
  const splitMode = document.getElementById('taskSplitMode')?.value || DEFAULT_SPLIT_MODE;
  const segments = parsePromptSegments(raw, splitMode);
  const globalPrompt = document.getElementById('globalPrompt').value.trim();
  const composeMode = document.getElementById('taskComposeMode').value;
  const durationValue = document.getElementById('taskDuration').value;
  const durationMode = durationValue === 'auto' ? 'auto' : 'manual';
  const imgEls = Array.from(document.querySelectorAll('#imagePreviewList .image-preview-item img'));
  const drafts = buildTaskDrafts({
    segments,
    globalPrompt,
    composeMode,
    durationMode,
    manualDurationSeconds: durationMode === 'auto' ? DEFAULT_BATCH_CONFIG.durationSeconds : Number(durationValue),
    strict: false
  });

  const thumbsHtml = imgEls.map(img =>
    `<img src="${img.src}" alt="">`
  ).join('');

  const cardsHtml = drafts.map((draft, i) => `
    <div class="batch-task-card">
      <div class="batch-task-card-header">
        <span class="batch-task-index">#${i + 1}</span>
        <div class="batch-task-meta">
          <span class="batch-task-chip" title="${draft.durationSourceText || ''}">${draft.durationSourceText && draft.durationSourceText.includes('+') ? 'Σ ' : ''}${draft.durationSeconds} 秒</span>
          <span class="batch-task-chip">${composeMode === 'append' ? '全局在后' : '全局在前'}</span>
          <span class="batch-task-chip">${splitMode === 'shot' ? '镜头序号分割' : (splitMode === 'block' ? '空行分割' : '逐行分割')}</span>
          ${draft.errors.length ? `<span class="batch-task-chip warning" title="${escapeHtml(draft.errors[0])}">识别失败</span>` : ''}
          ${draft.warnings.length ? `<span class="batch-task-chip warning" title="${escapeHtml(draft.warnings.join('\n'))}">${draft.warnings.some(w => w.includes('范围')) ? '时长建议' : '时长累加'}</span>` : ''}
        </div>
      </div>
      ${imgEls.length > 0 ? `<div class="batch-task-thumbs">${thumbsHtml}</div>` : ''}
      <div class="batch-task-prompt">${escapeHtml(draft.promptText)}</div>
    </div>
  `).join('');

  document.getElementById('batchModalTitle').textContent = `批量任务预览（共 ${segments.length} 个）`;
  document.getElementById('batchModalBody').innerHTML = cardsHtml;
  document.getElementById('batchModalOverlay').classList.remove('hidden');
}

function closeBatchModal() {
  document.getElementById('batchModalOverlay').classList.add('hidden');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function closeTaskWindow() {
  releaseAllPreviewResources();
  try {
    // 优先尝试通知父页面关闭 iframe
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'CLOSE_ADD_TASK_IFRAME' }, '*');
    }
  } catch (err) {
    console.error('通知父页面关闭失败:', err);
  }
  
  // 同时也尝试关闭窗口本身（如果是独立窗口打开的话）
  try {
    window.close();
  } catch (err) {
    // 如果是 iframe，window.close() 无效，忽略即可
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}
