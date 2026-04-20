/**
 * Background Service Worker
 * 管理任务状态、发送通知、处理后台轮询
 */

import { registry } from './platforms/registry.js';
import { deleteImageRecords, getImageBlob, putImageRecord } from './image-store.js';
import {
  setRunwayJwt,
  getRunwayJwt,
  setRunwayContext,
  getRunwayContext,
  setRunwayFingerprint,
  getRunwayFingerprint,
  jitter,
  randSleep,
  runwaySubmitter,
  parseRunwayTaskResponse
} from './platforms/runway/index.js';
import { RUNWAY_QUEUE } from './platforms/runway/config.js';
import { logError } from './core/error-log.js';

// Runway 日上限：账号风险缓解，单日累计提交不超过 80 条
const RUNWAY_DAILY_CAP = 80;

/**
 * 把 Runway 返回的 error 字段转成「Runway 服务端：xxx（CODE）」格式的可显示字符串。
 *
 * 设计原则：用户必须知道是 Runway 平台拒绝（区别于网络错误、客户端 bug），
 * 所以**强制带「Runway 服务端：」前缀 + 平台原文（reason/code）**，不翻译、不吞错。
 *
 * Runway 失败时常见 reason / code：
 *   SAFETY               — 内容审核（提示词/参考图触发安全策略）
 *   INTERNAL_ERROR       — 平台内部错
 *   INVALID_INPUT        — 参数格式不对
 *   ASSET_INVALID        — 参考图损坏 / 格式不支持
 *   THROTTLED_FOR_TOO_LONG — 排队太久被踢
 */
function formatRunwayError(err, status = 'failed', rawStatus = '') {
  const tag = status === 'cancelled' ? '任务已取消' : 'Runway 服务端';
  const fallback = status === 'cancelled' ? tag : `${tag}：任务失败`;

  if (err == null) {
    return rawStatus ? `${fallback}（${rawStatus}）` : fallback;
  }
  if (typeof err === 'string') {
    return `${tag}：${err}`;
  }
  if (typeof err === 'object') {
    const reason = (typeof err.reason === 'string' && err.reason)
                || (typeof err.message === 'string' && err.message)
                || (err.reason && typeof err.reason.message === 'string' && err.reason.message)
                || null;
    const code = (typeof err.code === 'string' && err.code) || null;

    if (reason && code) return `${tag}：${reason}（${code}）`;
    if (reason)         return `${tag}：${reason}`;
    if (code)           return `${tag}：${code}`;

    if (err.raw && typeof err.raw === 'object') {
      try { return `${tag}：${JSON.stringify(err.raw)}`; } catch { /* fall through */ }
    }
    try { return `${tag}：${JSON.stringify(err)}`; } catch { return fallback; }
  }
  return `${tag}：${String(err)}`;
}

const DEFAULT_IMAGEX_API_HOST = 'imagex.volcengineapi.com';
const DEFAULT_UPLOAD_HOST = 'tos-lf-x.snssdk.com';
const DEFAULT_MAX_CONCURRENT_TASKS = 3;
const MAX_JIMENG_ACTIVE_TASK_PAGES = 3;
const MAX_UPLOAD_RETRIES_PER_HOST = 2;
const MAX_IMAGEX_RETRIES_PER_HOST = 2;
const JIMENG_SYNC_MIN_INTERVAL_MS = 15000;
const JIMENG_PAGE_REFRESH_MIN_INTERVAL_MS = 60000;
const JIMENG_BRIDGE_READY_TIMEOUT_MS = 20000;
const JIMENG_BRIDGE_RECONNECT_WINDOW_MS = 12000;
const JIMENG_BRIDGE_POST_RELOAD_TIMEOUT_MS = 30000;
const JIMENG_BRIDGE_RECOVERY_ATTEMPTS = 2;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const AWS_ALGORITHM = 'AWS4-HMAC-SHA256';
const AWS_SERVICE = 'imagex';
const AWS_API_VERSION = '2018-08-01';
const DEFAULT_AWS_REGION = 'cn-north-1';
const JIMENG_AID = '513695';
const JIMENG_WEB_VERSION = '7.5.0';
const JIMENG_DA_VERSION = '3.3.12';
const JIMENG_AIGC_FEATURES = 'app_lip_sync';
const JIMENG_ROOT_MODEL = 'dreamina_seedance_40';
const JIMENG_BENEFIT_TYPE = 'dreamina_seedance_20_fast';
const JIMENG_DRAFT_VERSION = '3.3.12';
const JIMENG_DRAFT_MIN_VERSION = '3.0.5';
const JIMENG_COMPONENT_MIN_VERSION = '1.0.0';
const JIMENG_WORKBENCH_MIN_VERSION = '3.3.9';
const JIMENG_VIDEO_FPS = 24;
const JIMENG_ASSET_LIST_SCENES = [
  { scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' },
  { scene: 'loss', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' },
  { scene: 'loss', width: 900, height: 900, uniq_key: '900', format: 'webp' },
  { scene: 'loss', width: 720, height: 720, uniq_key: '720', format: 'webp' },
  { scene: 'loss', width: 480, height: 480, uniq_key: '480', format: 'webp' },
  { scene: 'loss', width: 360, height: 360, uniq_key: '360', format: 'webp' }
];
const DEFAULT_BATCH_CONFIG = {
  model: 'seedance_2_fast',
  referenceMode: 'all_reference',
  aspectRatio: '16:9',
  durationMode: 'manual',
  durationSeconds: 4
};
const DEFAULT_JIMENG_REQUEST_CONTEXT = {
  webId: '',
  os: 'mac',
  webComponentOpenFlag: '1',
  commerceWithInputVideo: '1',
  msToken: '',
  aBogus: ''
};
const MODEL_CONFIGS = {
  seedance_2_fast: {
    rootModel: 'dreamina_seedance_40',
    modelReqKey: 'dreamina_seedance_40',
    benefitType: 'dreamina_seedance_20_fast'
  },
  seedance_2: {
    rootModel: 'dreamina_seedance_40_pro',
    modelReqKey: 'dreamina_seedance_40_pro',
    benefitType: 'dreamina_video_seedance_20_pro'
  }
};
const REFERENCE_MODE_CONFIGS = {
  all_reference: {
    videoMode: 2
  },
  first_last_frames: {
    videoMode: 2
  }
};

class BatchManager {
  constructor() {
    this.tasks = [];
    this.runningTasks = new Map();
    this.defaultMaxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS;
    this.maxConcurrentTasks = DEFAULT_MAX_CONCURRENT_TASKS;
    // 分平台并发上限（Step 1a）。即梦走 maxConcurrentTasks（自适应学习），其他平台走静态值。
    this.platformMaxConcurrent = {
      runway: RUNWAY_QUEUE.maxConcurrentDefault
    };
    // 挂机模式（Step 2b）：addTask 时若开启则自动 startBatch
    this.autoRunEnabled = false;
    this.queueLimitLearned = false;
    this.limitRecoverTime = null;
    this.nextRetryAt = 0;
    this.queueCapacityProbePending = true;
    this.isRunning = false;
    this.isPaused = false;
    this.autoDispatchEnabled = false;
    this.submittedThisRun = false;
    this.jimengRequestContext = { ...DEFAULT_JIMENG_REQUEST_CONTEXT };
    this.lastJimengPageRefreshAt = 0;
    this.pendingPageDrivenSubmit = null;
    this.currentSubmitTabId = null;
    this.currentSubmitWindowId = null;
    this.currentSubmitPageUrl = '';
    this.offscreenCloseTimer = null;
  }

  async init() {
    const { batchTasks, jimengRequestContext, batchSubmitContext } = await chrome.storage.local.get([
      'batchTasks',
      'jimengRequestContext',
      'batchSubmitContext'
    ]);
    if (batchTasks) {
      this.tasks = batchTasks;
      // 一次性迁移：清理旧数据中残留的大 base64，避免 IPC 超限
      const hasLargePreview = this.tasks.some(t =>
        (t.images || []).some(img => img.preview && img.preview.length >= 51200)
      );
      if (hasLargePreview) {
        console.log('[后台] 检测到旧任务含大图 base64，开始迁移至 IndexedDB...');
        this.tasks = await Promise.all(this.tasks.map(async (t) => ({
          ...t,
          images: await this._sanitizeImages(t.images)
        })));
        await this.saveTasks();
        console.log('[后台] 旧任务图片迁移完成');
      }

      for (const task of this.tasks) {
        const platform = task.platform || 'jimeng';
        if (task.status === 'queued' && task.historyRecordId) {
          this.runningTasks.set(String(task.historyRecordId), {
            taskId: task.id,
            startTime: task.createdAt || Date.now(),
            restored: true,
            platform                      // Step 1a：恢复时也带上平台
          });
        }
        // Step 1a：恢复 Runway queued 任务的轮询
        if (task.status === 'queued' && task.runwayTaskId && platform === 'runway') {
          this.runningTasks.set(task.runwayTaskId, {
            taskId: task.id,
            startTime: task.createdAt || Date.now(),
            restored: true,
            platform: 'runway'
          });
          // 异步恢复轮询循环（不阻塞 init）
          this.pollRunwayTaskStatus(task.runwayTaskId);
        }
      }
    }
    if (jimengRequestContext) {
      this.jimengRequestContext = {
        ...DEFAULT_JIMENG_REQUEST_CONTEXT,
        ...jimengRequestContext
      };
    }
    if (batchSubmitContext?.tabId) {
      this.currentSubmitTabId = batchSubmitContext.tabId;
      this.currentSubmitWindowId = batchSubmitContext.windowId || null;
      this.currentSubmitPageUrl = batchSubmitContext.pageUrl || '';
    }

    // Step 2b：恢复挂机模式开关
    await this.loadAutoRunEnabled();
    if (this.autoRunEnabled && this.hasPendingTasks()) {
      console.log('[挂机模式] 恢复后发现有 pending 任务，自动开始批量');
      this.prepareBatchStart()
        .then(() => this.startBatch())
        .catch((err) => console.warn('[挂机模式] 启动失败:', err));
    }
  }

  async _sanitizeImages(images) {
    return Promise.all((images || []).map(async (img) => {
      const base = {
        fileName: img.fileName,
        imageId: img.imageId || null,
        uri: img.uri || null,
        width: img.width || null,
        height: img.height || null
      };
      // preview 小于 50KB（缩略图）直接保留
      if (img.preview && img.preview.length < 51200) {
        base.preview = img.preview;
      } else if (img.preview && !img.imageId) {
        // 兜底：大图 base64 存入 IndexedDB，storage 只存 id
        const imageId = `img-bg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const res = await fetch(img.preview);
        const blob = await res.blob();
        await putImageRecord({ id: imageId, blob, fileName: img.fileName });
        base.imageId = imageId;
      }
      return base;
    }));
  }

  async addTask(task) {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const safeImages = await this._sanitizeImages(task.images);
    const newTask = {
      id: taskId,
      platform: task.platform || 'jimeng',     // Step 1a：把平台显式存到任务上
      promptText: task.promptText,
      promptMeta: task.promptMeta || null,
      images: safeImages,
      config: this.normalizeTaskConfig(task.config),
      status: 'pending',
      historyRecordId: null,
      queueInfo: null,
      error: null,
      createdAt: Date.now()
    };
    this.tasks.push(newTask);
    await this.saveTasks();
    this.maybeResumeBatch('addTask');

    // Step 2b：挂机模式开启时，新任务进来自动开始批量
    if (this.autoRunEnabled && !this.isRunning) {
      this.prepareBatchStart()
        .then(() => this.startBatch())
        .catch((err) => console.warn('[挂机模式] 自动启动批量失败:', err));
    }

    return taskId;
  }

  // Step 1a helpers ──────────────────────────────────────────────

  getPlatformConcurrencyLimit(platformId) {
    if (platformId === 'runway') return this.platformMaxConcurrent.runway;
    // 即梦：保留自适应学习的 maxConcurrentTasks
    return this.maxConcurrentTasks;
  }

  getRunningCountByPlatform(platformId) {
    let count = 0;
    for (const entry of this.runningTasks.values()) {
      const p = entry?.platform || 'jimeng';
      if (p === platformId) count++;
    }
    return count;
  }

  /**
   * 找下一个可立即调度的 pending 任务
   * 规则：按队列顺序遍历 pending，第一个其平台未达上限的任务立即返回
   * 如果所有 pending 都因为各自平台满了而被卡，返回 null（外层 sleep 等待）
   */
  findNextDispatchableTask() {
    for (const task of this.tasks) {
      if (task.status !== 'pending') continue;
      const platformId = task.platform || 'jimeng';
      // 风控：Runway 单日已达 80 条，跳过其 pending 任务，让即梦继续跑
      if (platformId === 'runway' && this._runwayDailyCapReached) continue;
      const limit = this.getPlatformConcurrencyLimit(platformId);
      const running = this.getRunningCountByPlatform(platformId);
      if (running < limit) return task;
    }
    return null;
  }

  // ─── Runway 日上限（默认 80/天） ──────────────────────────
  // 简单本地计数，按"插件本地日期"重置。换账号或换电脑都会重新数。

  _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async getRunwayDailyCounter() {
    const today = this._todayKey();
    if (this._runwayDailyCounter && this._runwayDailyCounter.date === today) {
      return this._runwayDailyCounter;
    }
    const stored = await chrome.storage.local.get('runway.dailyCounter');
    const raw = stored['runway.dailyCounter'];
    if (raw && raw.date === today) {
      this._runwayDailyCounter = raw;
    } else {
      this._runwayDailyCounter = { date: today, count: 0, cap: RUNWAY_DAILY_CAP };
      await chrome.storage.local.set({ 'runway.dailyCounter': this._runwayDailyCounter });
      this._runwayDailyCapReached = false;
    }
    if (this._runwayDailyCounter.count >= RUNWAY_DAILY_CAP) {
      this._runwayDailyCapReached = true;
    }
    return this._runwayDailyCounter;
  }

  async incrementRunwayDailyCounter() {
    const c = await this.getRunwayDailyCounter();
    c.count += 1;
    c.cap = RUNWAY_DAILY_CAP;
    this._runwayDailyCounter = c;
    if (c.count >= RUNWAY_DAILY_CAP) {
      this._runwayDailyCapReached = true;
      console.warn(`[Runway 日上限] 已达 ${RUNWAY_DAILY_CAP} 条，今日 Runway 任务停止派发`);
    }
    await chrome.storage.local.set({ 'runway.dailyCounter': c });
    return c;
  }

  // Step 2b helpers ──────────────────────────────────────────────

  async setAutoRunEnabled(enabled) {
    this.autoRunEnabled = !!enabled;
    await chrome.storage.local.set({ autoRunEnabled: this.autoRunEnabled });
    if (this.autoRunEnabled && !this.isRunning && this.hasPendingTasks()) {
      // 立即吃掉积压
      this.prepareBatchStart()
        .then(() => this.startBatch())
        .catch((err) => console.warn('[挂机模式] 启动失败:', err));
    }
  }

  async loadAutoRunEnabled() {
    const stored = await chrome.storage.local.get('autoRunEnabled');
    this.autoRunEnabled = !!stored.autoRunEnabled;
  }

  async updateTask(taskId, taskUpdate) {
    const previousTasks = this.tasks.map(task => ({ ...task }));
    console.log(`[后台] 尝试更新任务 ${taskId}:`, taskUpdate);
    const index = this.tasks.findIndex(t => t.id === taskId);
    if (index === -1) {
      console.error(`[后台] 更新失败：找不到任务 ${taskId}`);
      throw new Error(`未找到任务: ${taskId}`);
    }

    const task = this.tasks[index];
    console.log(`[后台] 任务当前状态: ${task.status}`);

    // 放宽限制：允许编辑除正在处理中（uploading/submitting）以外的所有状态
    // 如果是 queued 或 completed，编辑后将作为新任务重新提交
    const EDITABLE_STATUSES = ['pending', 'failed', 'queued', 'cancelled', 'completed'];
    if (!EDITABLE_STATUSES.includes(task.status)) {
      console.warn(`[后台] 任务 ${taskId} 状态为 ${task.status}，当前不允许编辑`);
      throw new Error(`当前状态（${task.status}）暂不支持编辑，请稍后再试或等任务失败/完成后再编辑`);
    }

    // 如果任务正在排队中，停止监听旧任务
    if (task.historyRecordId) {
      console.log(`[后台] 任务 ${taskId} 存在旧历史记录 ${task.historyRecordId}，停止监控并更新`);
      this.runningTasks.delete(task.historyRecordId);
    }

    const oldHistoryIds = new Set(task.oldHistoryRecordIds || []);
    if (task.historyRecordId) {
      oldHistoryIds.add(task.historyRecordId);
    }

    this.tasks[index] = {
      ...task,
      promptText: taskUpdate.promptText !== undefined ? taskUpdate.promptText : task.promptText,
      promptMeta: taskUpdate.promptMeta !== undefined ? taskUpdate.promptMeta : task.promptMeta || null,
      images: taskUpdate.images !== undefined ? await this._sanitizeImages(taskUpdate.images) : task.images,
      config: taskUpdate.config ? this.normalizeTaskConfig(taskUpdate.config) : task.config,
      status: 'pending', // 统一重置为待提交
      historyRecordId: null, // 清空关联的历史记录，走新生成流程
      oldHistoryRecordIds: Array.from(oldHistoryIds), // 保存旧记录映射，防止分开成两张卡片
      error: null
    };

    await this.saveTasks();
    await this.cleanupOrphanedImages(previousTasks);
    this.maybeResumeBatch('updateTask');
    console.log(`[后台] 任务 ${taskId} 更新成功`);
    return true;
  }

  async removeTask(taskId) {
    const previousTasks = this.tasks.map(task => ({ ...task }));
    const task = this.tasks.find(t => t.id === taskId);
    if (task?.historyRecordId) {
      this.runningTasks.delete(task.historyRecordId);
    }
    this.tasks = this.tasks.filter(t => t.id !== taskId);
    await this.saveTasks();
    await this.cleanupOrphanedImages(previousTasks);
    this.maybeResumeBatch('removeTask');
  }

  async clearHistory() {
    const previousTasks = this.tasks.map(task => ({ ...task }));
    this.tasks = this.tasks.filter(task => !['completed', 'failed', 'cancelled'].includes(task.status));
    await this.saveTasks();
    await this.cleanupOrphanedImages(previousTasks);
  }

  getTasks() {
    return this.tasks.map(task => ({
      ...task,
      config: this.normalizeTaskConfig(task.config)
    }));
  }

  getState() {
    this.ensureAutoDispatchStoppedWhenIdle();
    const pendingCount = this.tasks.filter(task => task.status === 'pending').length;
    const dispatchingCount = this.tasks.filter(task => ['uploading', 'submitting'].includes(task.status)).length;
    const runningCount = this.tasks.filter(task => ['uploading', 'submitting', 'queued'].includes(task.status)).length;
    const isBusy = pendingCount > 0 || runningCount > 0;
    const isDispatchActive = this.autoDispatchEnabled && (pendingCount > 0 || dispatchingCount > 0 || this.isRunning);

    return {
      isActive: isDispatchActive,
      isRunning: this.isRunning,
      isPaused: this.isPaused && (pendingCount > 0 || dispatchingCount > 0 || isBusy),
      dispatchingCount,
      pendingCount,
      runningCount,
      maxConcurrentTasks: this.queueLimitLearned ? this.maxConcurrentTasks : null,
      nextRetryAt: this.nextRetryAt || 0
    };
  }

  isJimengBridgeUnavailableError(error) {
    const message = String(error?.message || error || '');
    return (
      message.includes('即梦页面桥接未连接') ||
      message.includes('页面自动提交链路已断开') ||
      message.includes('即梦页面连接已断开')
    );
  }

  isJimengDryRunStopError(error) {
    const message = String(error?.message || error || '');
    return message.includes('DRY_RUN_STOPPED_BEFORE_SUBMIT');
  }

  async prepareBatchStart() {
    const pendingTask = this.tasks.find(task => task.status === 'pending');
    if (!pendingTask) {
      return this.getState();
    }

    // Stage 2/3：只有当存在即梦任务时才绑定即梦 tab。纯 Runway 批量直接跑 headless。
    const hasJimengPending = this.tasks.some(t =>
      t.status === 'pending' && (t.platform || 'jimeng') === 'jimeng'
    );
    if (hasJimengPending) {
      await this.bindCurrentSubmitTab();
      await this.ensureJimengPageBridgeReady(JIMENG_BRIDGE_READY_TIMEOUT_MS, {
        allowRecovery: true,
        reason: 'prepare_batch_start'
      });
    }
    return this.getState();
  }

  async startBatch() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.autoDispatchEnabled = true;
    this.submittedThisRun = false;
    this.nextRetryAt = 0;
    this.queueCapacityProbePending = true;

    while (this.isRunning && !this.isPaused) {
      if (this.limitRecoverTime && Date.now() > this.limitRecoverTime) {
        console.log('[后台] 并发上限冷却时间结束，恢复并发数为:', this.defaultMaxConcurrentTasks);
        this.maxConcurrentTasks = this.defaultMaxConcurrentTasks;
        this.limitRecoverTime = null;
      }

      // Step 1a：按平台找下一个可调度任务（即梦满了不影响 Runway，反之亦然）
      const task = this.findNextDispatchableTask();
      if (!task) {
        // 没有可立即调度的任务：可能是 pending 全卡在某平台容量不够，或者 pending 为空
        if (!this.hasPendingTasks()) break;
        // 有 pending 但没空位 → 等已运行的腾出位置
        if (this.submittedThisRun) {
          this.refreshJimengPage();
          this.submittedThisRun = false;
        }
        await this.sleep(5000);
        if (this.isPaused || !this.isRunning) break;
        continue;
      }

      try {
        if (this.submittedThisRun) {
          await this.reloadJimengStateForNextTask('before_next_task');
        }

        await this.processTask(task);
        
        // 每个任务提交后，增加 5-15 秒的动态间隔时间防风控
        const randomSleepMs = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
        await this.sleep(randomSleepMs);

      } catch (error) {
        if (error.message === 'RUNWAY_DAILY_CAP_REACHED') {
          // 当日 Runway 上限已满：把任务退回 pending、留言、跳过 Runway 派发
          // findNextDispatchableTask 看到 _runwayDailyCapReached 会自动跳过 Runway 任务
          // 即梦任务继续正常派发
          console.warn(`[Runway 风控] 今日 ${RUNWAY_DAILY_CAP} 条已用满，任务 ${task.id} 退回 pending`);
          task.status = 'pending';
          task.error = `今日 Runway 上限 ${RUNWAY_DAILY_CAP} 条已达，请明天再试`;
          await this.saveTasks();
          continue;
        }
        if (error.message === 'QUEUE_LIMIT_REACHED') {
          console.warn(`[后台] 任务 ${task.id} 触发服务端排队限制，暂缓提交...`);
          const activeCount = await this.getJimengActiveTaskCount().catch(() => this.runningTasks.size);
          this.maxConcurrentTasks = Math.max(1, activeCount || this.runningTasks.size || this.defaultMaxConcurrentTasks);
          this.queueLimitLearned = true;
          this.limitRecoverTime = Date.now() + 30 * 60 * 1000;
          const retryDelayMs = this.scheduleQueueCapacityProbe(60000, 120000, 'queue_limit');
          task.status = 'pending';
          task.error = '当前处于使用高峰期，暂时无法提交更多任务，请等待其他任务完成后再尝试提交';
          await this.saveTasks();
          this.submittedThisRun = false;
          await this.reloadJimengStateForNextTask('queue_limit_reached');
          this.ensureAutoDispatchStoppedWhenIdle();
          await this.sleep(retryDelayMs);
        } else if (error.message === 'HIGH_PEAK_LIMIT_REACHED') {
          console.warn(`[后台] 任务 ${task.id} 命中高峰期页面限制，延后升级队列探测...`);
          this.queueLimitLearned = true;
          this.limitRecoverTime = Date.now() + 30 * 60 * 1000;
          this.scheduleQueueCapacityProbe(3 * 60 * 60 * 1000, 5 * 60 * 60 * 1000, 'high_peak_limit');
          task.status = 'pending';
          task.error = '当前处于使用高峰期，暂时无法提交更多任务，请等待其他任务完成后再尝试提交';
          await this.saveTasks();
          this.submittedThisRun = false;
          await this.reloadJimengStateForNextTask('high_peak_limit_reached');
          this.ensureAutoDispatchStoppedWhenIdle();
        } else if (this.isJimengBridgeUnavailableError(error)) {
          console.warn('[后台] 即梦页面桥接不可用，尝试恢复当前批量提交页:', error);
          const recovered = await this.handleBridgeUnavailableDuringSubmit(task, error);
          if (recovered) {
            continue;
          }
          break;
        } else if (this.isJimengDryRunStopError(error)) {
          console.warn('[后台] 调试模式已在提交前停止，暂停批量队列:', error);
          task.status = 'pending';
          task.error = error.userMessage || '调试模式：已完成参数设置，未点击生成';
          await this.saveTasks();
          this.isRunning = false;
          this.isPaused = true;
          this.autoDispatchEnabled = false;
          this.submittedThisRun = false;
          this.ensureAutoDispatchStoppedWhenIdle();
          break;
        } else {
          console.error('任务处理失败:', error);
          task.status = 'failed';
          // Runway 服务端错误（callRunway 抛出的 err 带 body / status）：
          // 走 formatRunwayError 加「Runway 服务端」前缀；其余错误用 error.message 兜底
          if (task.platform === 'runway' && (error.body || error.status)) {
            const wrapped = error.body && typeof error.body === 'object'
              ? error.body
              : { reason: error.message, code: error.status ? `HTTP ${error.status}` : null };
            task.error = formatRunwayError(wrapped, 'failed');
          } else {
            task.error = error.message || '任务失败';
          }
          await this.saveTasks();
          this.submittedThisRun = false;
          this.ensureAutoDispatchStoppedWhenIdle();
        }
      }
    }

    this.isRunning = false;

    if (this.submittedThisRun) {
      await this.refreshJimengPage();
    }

    this.ensureAutoDispatchStoppedWhenIdle();
  }

  pause() {
    this.isPaused = true;
    this.autoDispatchEnabled = false;
  }

  async processTask(task) {
    // Stage 2 minimal：按 platform 路由。即梦走原路径（下方代码不变），Runway 走 headless REST。
    const platformId = task.platform || task.platformId || 'jimeng';
    if (platformId === 'runway') {
      return this.processRunwayTask(task);
    }

    task.config = this.normalizeTaskConfig(task.config);
    this.validateJimengTaskImages(task);
    await this.ensureJimengPageBridgeReady(JIMENG_BRIDGE_READY_TIMEOUT_MS, {
      allowRecovery: true,
      reason: `process_task:${task.id}`
    });
    await this.ensureQueueCapacityBeforeUpload({
      allowProbe: this.consumeQueueCapacityProbe()
    });

    // 准备页面自动提交所需的图片数据
    task.status = 'uploading';
    task.error = null;
    await this.saveTasks();

    const domImages = await this.prepareJimengDomImages(task.images);
    const parsedPrompt = this.parsePromptReferences(task.promptText, domImages.length);

    // 通过网页原生 UI 提交任务
    task.status = 'submitting';
    task.submittedPromptText = parsedPrompt.displayPrompt;
    await this.saveTasks();

    const submitResult = await this.executeJimengDomSubmit({
      taskId: task.id,
      promptText: parsedPrompt.originalPrompt,
      displayPromptText: parsedPrompt.displayPrompt,
      config: task.config,
      images: domImages
    });

    if (submitResult?.dryRun) {
      const dryRunError = new Error('DRY_RUN_STOPPED_BEFORE_SUBMIT');
      dryRunError.userMessage = submitResult.message || '调试模式：已完成参数设置，未点击生成';
      throw dryRunError;
    }

    const responseData = submitResult?.interceptedResponseData || submitResult?.responseData;

    if (responseData?.ret === '1310') {
      throw new Error('QUEUE_LIMIT_REACHED');
    }

    if (!responseData || responseData.ret !== '0') {
      const details = [
        responseData?.errmsg || '页面自动提交失败',
        responseData?.logid ? `logid=${responseData.logid}` : null,
        responseData?.ret ? `ret=${responseData.ret}` : null
      ].filter(Boolean).join(' | ');
      throw new Error(details || '页面自动提交失败');
    }

    const historyId = this.extractJimengHistoryId(responseData);
    if (!historyId) {
      throw new Error('未从即梦页面提交结果中获取到 history_record_id');
    }

    task.historyRecordId = historyId;
    task.queueInfo = this.extractJimengQueueInfo(responseData, historyId);
    task.status = 'queued';
    this.submittedThisRun = true;

    this.runningTasks.set(historyId, { taskId: task.id, startTime: Date.now(), platform: 'jimeng' });
    const nextMaxConcurrent = Math.min(
      this.defaultMaxConcurrentTasks,
      Math.max(this.maxConcurrentTasks, this.runningTasks.size)
    );
    if (nextMaxConcurrent !== this.maxConcurrentTasks) {
      console.log('[后台] 队列探测成功，提升最大并发数为:', nextMaxConcurrent);
      this.maxConcurrentTasks = nextMaxConcurrent;
      this.queueLimitLearned = true;
      if (this.maxConcurrentTasks >= this.defaultMaxConcurrentTasks) {
        this.limitRecoverTime = null;
      }
    }
    this.nextRetryAt = 0;
    await this.saveTasks();

    this.pollTaskStatus(historyId);
  }

  async uploadImage(imageData) {
    const blob = await this.getUploadBlob(imageData);

    // Step 1: 获取上传凭证
    const tokenResp = await fetch(this.buildJimengApiUrl('/mweb/v1/get_upload_token'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 2 })
    });
    const tokenData = await tokenResp.json();

    if (tokenData.ret !== '0') {
      throw new Error('获取上传凭证失败');
    }

    const credentials = tokenData.data;
    const region = normalizeImagexRegion(credentials.region);

    // Step 2: 申请上传
    const applyUrl = this.buildImagexApiUrl(credentials);
    applyUrl.searchParams.set('Action', 'ApplyImageUpload');
    applyUrl.searchParams.set('Version', AWS_API_VERSION);
    applyUrl.searchParams.set('ServiceId', credentials.space_name);

    const applyResp = await this.fetchImagex(
      applyUrl,
      {
        method: 'GET'
      },
      credentials,
      region
    );
    const applyData = await this.parseJsonResponse(applyResp, '申请图片上传失败');
    const uploadAddress = this.getUploadAddress(applyData);
    const storeInfo = uploadAddress.StoreInfos[0];
    const storeUri = storeInfo.StoreUri;
    const uploadHeaders = await buildUploadHeaders(storeInfo.Auth, blob);

    // Step 3: 上传文件
    const uploadResp = await this.uploadToStore(
      uploadAddress.UploadHosts,
      storeUri,
      uploadHeaders,
      blob
    );
    await this.ensureSuccessfulResponse(uploadResp, '上传图片文件失败');

    // Step 4: 提交上传
    const commitUrl = this.buildImagexApiUrl(credentials);
    commitUrl.searchParams.set('Action', 'CommitImageUpload');
    commitUrl.searchParams.set('Version', AWS_API_VERSION);
    commitUrl.searchParams.set('ServiceId', credentials.space_name);

    const commitResp = await this.fetchImagex(
      commitUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          SessionKey: uploadAddress.SessionKey,
          ServiceId: credentials.space_name
        })
      },
      credentials,
      region
    );
    const commitData = await this.parseJsonResponse(commitResp, '提交图片上传失败');

    // Step 5: 提交审核
    const auditResp = await fetch(this.buildJimengApiUrl('/mweb/v1/imagex/submit_audit_job'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri_list: [storeUri] })
    });
    const auditData = await this.parseJsonResponse(auditResp, '提交图片审核失败');

    if (auditData.ret !== '0') {
      throw new Error(auditData.errmsg || '提交图片审核失败');
    }

    const imageMeta = this.getImageMetaFromCommitResult(commitData, storeUri, imageData);
    return imageMeta;
  }

  async getUploadBlob(imageData) {
    if (imageData?.imageId) {
      const blob = await getImageBlob(imageData.imageId);
      if (blob) {
        return blob;
      }
    }

    if (imageData?.preview) {
      const response = await fetch(imageData.preview);
      return response.blob();
    }

    throw new Error('缺少可上传的图片数据');
  }

  async prepareJimengDomImages(images = []) {
    return Promise.all((images || []).map(async (image, index) => {
      const blob = await this.getUploadBlob(image);
      const dataUrl = await this.blobToDataUrl(blob);
      return {
        fileName: image?.fileName || `image-${index + 1}.${this.guessImageExtension(blob, image)}`,
        mimeType: blob?.type || this.guessMimeTypeFromFileName(image?.fileName) || 'image/png',
        dataUrl
      };
    }));
  }

  blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取图片数据失败'));
      reader.readAsDataURL(blob);
    });
  }

  guessMimeTypeFromFileName(fileName = '') {
    const lowerName = String(fileName || '').toLowerCase();

    if (lowerName.endsWith('.png')) return 'image/png';
    if (lowerName.endsWith('.webp')) return 'image/webp';
    if (lowerName.endsWith('.bmp')) return 'image/bmp';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';

    return '';
  }

  guessImageExtension(blob, imageData = {}) {
    const mimeType = blob?.type || this.guessMimeTypeFromFileName(imageData?.fileName);

    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/bmp') return 'bmp';
    if (mimeType === 'image/jpeg') return 'jpg';

    return 'png';
  }

  async fetchImagex(url, init, credentials, region) {
    const candidates = [new URL(url.toString())];
    const officialUrl = new URL(url.toString());
    officialUrl.host = DEFAULT_IMAGEX_API_HOST;

    if (officialUrl.toString() !== url.toString()) {
      candidates.push(officialUrl);
    }

    let lastResponse = null;
    let lastError = null;

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];

      for (let attempt = 0; attempt < MAX_IMAGEX_RETRIES_PER_HOST; attempt += 1) {
        const signedInit = await this.createImagexSignedRequest(candidate, init, credentials, region);
        let response;

        try {
          response = await fetch(candidate.toString(), signedInit);
        } catch (error) {
          lastError = new Error(`请求图片上传接口失败：${candidate.toString()} - ${error.message}`);
          const hasMoreAttempts = attempt < MAX_IMAGEX_RETRIES_PER_HOST - 1 || candidateIndex < candidates.length - 1;
          if (!hasMoreAttempts) {
            if (lastResponse) {
              return lastResponse;
            }
            throw lastError;
          }
          await this.sleep(this.getRetryDelayMs(attempt));
          continue;
        }

        if (response.ok) {
          return response;
        }

        lastResponse = response;
        const responseClone = response.clone();
        let errorData = null;

        try {
          errorData = await responseClone.json();
        } catch (error) {
          errorData = null;
        }

        const errorCode = errorData?.ResponseMetadata?.Error?.Code || '';
        const shouldRetryWithOfficialHost = (
          candidate.host !== DEFAULT_IMAGEX_API_HOST &&
          response.status === 404 &&
          errorCode === 'InvalidActionOrVersion'
        );

        if (shouldRetryWithOfficialHost) {
          break;
        }

        if (!this.shouldRetryResponse(response)) {
          return response;
        }

        if (attempt >= MAX_IMAGEX_RETRIES_PER_HOST - 1) {
          if (candidateIndex < candidates.length - 1) {
            break;
          }
          return response;
        }

        await this.sleep(this.getRetryDelayMs(attempt));
      }
    }

    return lastResponse;
  }

  buildImagexApiUrl(credentials) {
    const host = credentials?.upload_domain || DEFAULT_IMAGEX_API_HOST;
    return new URL(`https://${host}/`);
  }

  async fetchWithContext(url, init, fallbackMessage) {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new Error(`${fallbackMessage}：${url} - ${error.message}`);
    }
  }

  async createImagexSignedRequest(url, init, credentials, region) {
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const body = init.body || '';
    const payloadHash = await sha256Hex(body);
    const amzDate = getAmzDate();
    const dateStamp = amzDate.slice(0, 8);
    const host = url.host;

    headers.set('X-Amz-Date', amzDate);
    headers.set('X-Amz-Security-Token', credentials.session_token);
    headers.set('X-Amz-Content-Sha256', payloadHash);

    const signingHeaders = new Headers(headers);
    signingHeaders.set('Host', host);

    const canonicalHeaders = buildCanonicalHeaders(signingHeaders);
    const signedHeaders = getSignedHeaders(signingHeaders);
    const canonicalRequest = [
      method,
      url.pathname || '/',
      buildCanonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');
    const credentialScope = `${dateStamp}/${region}/${AWS_SERVICE}/aws4_request`;
    const stringToSign = [
      AWS_ALGORITHM,
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest)
    ].join('\n');
    const signingKey = await getSignatureKey(credentials.secret_access_key, dateStamp, region, AWS_SERVICE);
    const signature = toHex(await hmac(signingKey, stringToSign));

    headers.set(
      'Authorization',
      `${AWS_ALGORITHM} Credential=${credentials.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    );

    return {
      ...init,
      method,
      headers
    };
  }

  async uploadToStore(uploadHosts, storeUri, uploadHeaders, blob) {
    const candidates = uniqueHosts([...(uploadHosts || []), DEFAULT_UPLOAD_HOST]);
    let lastResponse = null;
    let lastError = null;

    for (let hostIndex = 0; hostIndex < candidates.length; hostIndex += 1) {
      const uploadUrl = buildUploadUrl(candidates[hostIndex], storeUri);

      for (let attempt = 0; attempt < MAX_UPLOAD_RETRIES_PER_HOST; attempt += 1) {
        try {
          const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: new Headers(uploadHeaders),
            body: blob
          });

          if (response.ok) {
            return response;
          }

          lastResponse = response;
          if (!this.shouldRetryResponse(response) || attempt >= MAX_UPLOAD_RETRIES_PER_HOST - 1) {
            break;
          }
        } catch (error) {
          lastError = new Error(`上传图片文件失败：${uploadUrl} - ${error.message}`);
          const hasMoreAttempts = attempt < MAX_UPLOAD_RETRIES_PER_HOST - 1 || hostIndex < candidates.length - 1;
          if (!hasMoreAttempts) {
            throw lastError;
          }
        }

        await this.sleep(this.getRetryDelayMs(attempt));
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    throw lastError || new Error('上传图片文件失败');
  }

  async parseJsonResponse(response, fallbackMessage) {
    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      if (!response.ok) {
        throw new Error(`${fallbackMessage}（HTTP ${response.status}）`);
      }
      throw new Error(`${fallbackMessage}：接口返回了非 JSON 数据`);
    }

    if (!response.ok) {
      throw new Error(this.extractImagexError(data, `${fallbackMessage}（HTTP ${response.status}）`));
    }

    if (data?.ResponseMetadata?.Error) {
      throw new Error(this.extractImagexError(data, fallbackMessage));
    }

    return data;
  }

  async ensureSuccessfulResponse(response, fallbackMessage) {
    if (response.ok) {
      return;
    }

    const text = await response.text();
    const detail = text ? `：${text.slice(0, 200)}` : '';
    throw new Error(`${fallbackMessage}（HTTP ${response.status}）${detail}`);
  }

  getUploadAddress(applyData) {
    const uploadAddress = applyData?.Result?.UploadAddress;
    const storeInfos = uploadAddress?.StoreInfos;
    const uploadHosts = uploadAddress?.UploadHosts;
    const sessionKey = uploadAddress?.SessionKey;

    if (!Array.isArray(storeInfos) || storeInfos.length === 0 || !storeInfos[0]?.StoreUri) {
      throw new Error(this.extractImagexError(applyData, '申请图片上传失败：接口未返回 StoreUri'));
    }

    if (!Array.isArray(uploadHosts) || uploadHosts.length === 0) {
      throw new Error(this.extractImagexError(applyData, '申请图片上传失败：接口未返回 UploadHosts'));
    }

    if (!sessionKey) {
      throw new Error(this.extractImagexError(applyData, '申请图片上传失败：接口未返回 SessionKey'));
    }

    return uploadAddress;
  }

  extractImagexError(data, fallbackMessage) {
    const responseError = data?.ResponseMetadata?.Error;
    if (responseError) {
      const code = responseError.Code || 'UnknownCode';
      const message = responseError.Message || fallbackMessage;
      return `${fallbackMessage}：${code} - ${message}`;
    }

    if (data?.errmsg) {
      return `${fallbackMessage}：${data.errmsg}`;
    }

    return fallbackMessage;
  }

  shouldRetryResponse(response) {
    return TRANSIENT_HTTP_STATUSES.has(Number(response?.status || 0));
  }

  getRetryDelayMs(attempt) {
    return 800 * (attempt + 1);
  }

  consumeQueueCapacityProbe() {
    const allowProbe = Boolean(this.queueCapacityProbePending && (!this.nextRetryAt || Date.now() >= this.nextRetryAt));
    if (allowProbe) {
      this.queueCapacityProbePending = false;
      this.nextRetryAt = 0;
    }
    return allowProbe;
  }

  scheduleQueueCapacityProbe(minDelayMs, maxDelayMs, reason = 'unknown') {
    const min = Math.max(0, Number(minDelayMs) || 0);
    const max = Math.max(min, Number(maxDelayMs) || min);
    const delayMs = min + Math.floor(Math.random() * (max - min + 1));
    this.queueCapacityProbePending = true;
    this.nextRetryAt = Date.now() + delayMs;
    console.log('[后台] 已安排下次队列探测:', {
      reason,
      delayMs,
      nextRetryAt: this.nextRetryAt
    });
    return delayMs;
  }

  async ensureQueueCapacityBeforeUpload({ allowProbe = false } = {}) {
    const limit = Math.max(1, this.maxConcurrentTasks || this.defaultMaxConcurrentTasks);
    const remoteActiveCount = await this.getJimengActiveTaskCount();
    const localQueuedCount = this.tasks.filter(task => task.status === 'queued' && task.historyRecordId).length;
    const activeCount = Math.max(remoteActiveCount, localQueuedCount, this.runningTasks.size);

    if (allowProbe) {
      console.log('[后台] 允许一次队列探测提单:', {
        activeCount,
        limit
      });
      return;
    }

    if (activeCount >= limit) {
      throw new Error('QUEUE_LIMIT_REACHED');
    }
  }

  async getJimengActiveTaskCount() {
    const monitor = registry.getAllMonitors().find(item => item.name === '即梦');
    if (!monitor) {
      return this.runningTasks.size;
    }

    try {
      let endTimeStamp = 0;
      const activeTaskIds = new Set();

      for (let page = 0; page < MAX_JIMENG_ACTIVE_TASK_PAGES; page += 1) {
        const requestBody = this.buildJimengAssetListRequest(endTimeStamp);
        const responseData = await this.executeJimengPageRequest(
          '/mweb/v1/get_asset_list',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        const updates = await monitor.detectTaskUpdate(
          'https://jimeng.jianying.com/mweb/v1/get_asset_list',
          'POST',
          requestBody,
          responseData
        );
        const tasks = Array.isArray(updates) ? updates : (updates ? [updates] : []);

        tasks.forEach((task) => {
          if (task?.taskId && ['queuing', 'generating'].includes(task.status)) {
            activeTaskIds.add(String(task.taskId));
          }
        });

        if (activeTaskIds.size >= this.defaultMaxConcurrentTasks) {
          break;
        }

        const hasMore = Boolean(responseData?.data?.has_more);
        const nextOffset = Number(responseData?.data?.next_offset || 0);
        if (!hasMore || !nextOffset || nextOffset === endTimeStamp) {
          break;
        }

        endTimeStamp = nextOffset;
      }

      return activeTaskIds.size;
    } catch (error) {
      console.warn('[后台] 获取即梦活跃队列数失败，回退本地计数:', error);
      return this.runningTasks.size;
    }
  }

  async submitGenerateTask(parsedPrompt, uploadedImages, taskConfig) {
    const primaryImage = uploadedImages[0] || null;
    // 移除强制要求参考图的校验，允许纯文本生成

    if (!await this.waitForJimengSignedContext()) {
      console.warn('[后台] 即梦签名参数尚未同步到后台，将尝试由页面桥接层补齐');
    }

    const normalizedConfig = this.normalizeTaskConfig(taskConfig);
    const modelConfig = MODEL_CONFIGS[normalizedConfig.model] || MODEL_CONFIGS.seedance_2_fast;
    const referenceConfig = REFERENCE_MODE_CONFIGS[normalizedConfig.referenceMode] || REFERENCE_MODE_CONFIGS.all_reference;
    const lastImage = normalizedConfig.referenceMode === 'first_last_frames'
      ? uploadedImages[uploadedImages.length - 1]
      : null;

    const submitId = crypto.randomUUID();
    const metricsExtra = this.buildMetricsExtra(submitId, normalizedConfig, modelConfig);
    const draftContent = this.buildVideoDraftContent(
      parsedPrompt,
      primaryImage,
      lastImage,
      normalizedConfig,
      modelConfig,
      referenceConfig,
      uploadedImages,
      metricsExtra
    );

    const requestBody = {
      extend: {
        root_model: modelConfig.rootModel,
        m_video_commerce_info: {
          benefit_type: modelConfig.benefitType,
          resource_id: 'generate_video',
          resource_id_type: 'str',
          resource_sub_type: 'aigc'
        },
        workspace_id: 0,
        m_video_commerce_info_list: [{
          benefit_type: modelConfig.benefitType,
          resource_id: 'generate_video',
          resource_id_type: 'str',
          resource_sub_type: 'aigc'
        }]
      },
      submit_id: submitId,
      http_common_info: {
        aid: Number(JIMENG_AID)
      },
      metrics_extra: JSON.stringify(metricsExtra),
      draft_content: JSON.stringify(draftContent)
    };

    const result = await this.executeJimengPageRequest(
      '/mweb/v1/aigc_draft/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (result.ret === '1310') {
      const activeCount = await this.getJimengActiveTaskCount();
      this.maxConcurrentTasks = Math.max(1, activeCount || this.runningTasks.size || this.defaultMaxConcurrentTasks);
      this.limitRecoverTime = Date.now() + 30 * 60 * 1000;
      throw new Error('QUEUE_LIMIT_REACHED');
    }

    if (result.ret !== '0') {
      const details = [
        result.errmsg || '提交任务失败',
        result.logid ? `logid=${result.logid}` : null,
        result.ret ? `ret=${result.ret}` : null
      ].filter(Boolean).join(' | ');
      throw new Error(details);
    }

    return result.data.aigc_data.history_record_id;
  }

  normalizePromptText(promptText) {
    return promptText
      .replace(/\{\d+\}/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\s+([，。！？；：,.!?;:])/g, '$1')
      .replace(/([（(【\[])\s+/g, '$1')
      .replace(/\s+([）)】\]])/g, '$1')
      .trim();
  }

  parsePromptReferences(promptText, imageCount) {
    const parts = promptText.split(/(\{\d+\})/);
    const placeholderOrder = [];
    const displayParts = [];
    const segments = [];

    for (const part of parts) {
      const match = part.match(/^\{(\d+)\}$/);
      if (match) {
        const imageIndex = Number(match[1]);
        if (imageIndex >= 0 && imageIndex < imageCount) {
          placeholderOrder.push(imageIndex);
          displayParts.push(`[图片${imageIndex + 1}]`);
          segments.push({ type: 'image', imageIndex });
        }
      } else if (part) {
        displayParts.push(part);
        segments.push({ type: 'text', text: part });
      }
    }

    const displayPrompt = this.normalizePromptText(displayParts.join(''));
    const cleanedPrompt = this.normalizePromptText(promptText);

    return {
      originalPrompt: promptText,
      cleanedPrompt,
      displayPrompt: displayPrompt || cleanedPrompt,
      placeholderOrder,
      segments
    };
  }

  normalizeTaskConfig(taskConfig = {}) {
    const durationMode = taskConfig?.durationMode === 'auto' ? 'auto' : 'manual';
    const durationSeconds = Number(taskConfig?.durationSeconds || DEFAULT_BATCH_CONFIG.durationSeconds);

    return {
      ...DEFAULT_BATCH_CONFIG,
      ...(taskConfig || {}),
      durationMode,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : DEFAULT_BATCH_CONFIG.durationSeconds
    };
  }

  validateJimengTaskImages(task) {
    const config = this.normalizeTaskConfig(task?.config);
    if (config.referenceMode !== 'first_last_frames') {
      return;
    }

    const images = Array.isArray(task?.images) ? task.images.filter(Boolean) : [];
    if (images.length < 2) {
      return;
    }

    const [firstImage, lastImage] = images;
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

    const formatRatio = (width, height) => {
      const normalizedWidth = Number(width || 0);
      const normalizedHeight = Number(height || 0);
      if (!normalizedWidth || !normalizedHeight) {
        return '未知';
      }
      return `${normalizedWidth}:${normalizedHeight}`;
    };

    const error = new Error(`首尾帧图片比例不一致：首帧 ${formatRatio(firstWidth, firstHeight)}，尾帧 ${formatRatio(lastWidth, lastHeight)}`);
    error.userMessage = `首尾帧图片比例不一致：首帧 ${firstWidth}x${firstHeight}，尾帧 ${lastWidth}x${lastHeight}。请使用相同比例的两张图片。`;
    throw error;
  }

  cacheJimengRequestContext(url) {
    try {
      const parsedUrl = new URL(url);
      const nextContext = {
        ...this.jimengRequestContext,
        webId: parsedUrl.searchParams.get('webId') || this.jimengRequestContext.webId,
        os: parsedUrl.searchParams.get('os') || this.jimengRequestContext.os,
        webComponentOpenFlag: parsedUrl.searchParams.get('web_component_open_flag') || this.jimengRequestContext.webComponentOpenFlag,
        commerceWithInputVideo: parsedUrl.searchParams.get('commerce_with_input_video') || this.jimengRequestContext.commerceWithInputVideo,
        msToken: parsedUrl.searchParams.get('msToken') || this.jimengRequestContext.msToken,
        aBogus: parsedUrl.searchParams.get('a_bogus') || this.jimengRequestContext.aBogus
      };

      this.jimengRequestContext = nextContext;
      chrome.storage.local.set({ jimengRequestContext: nextContext });
    } catch (error) {
      console.warn('[即梦调试] 缓存请求上下文失败:', error);
    }
  }

  hasJimengSignedContext() {
    return Boolean(this.jimengRequestContext.msToken && this.jimengRequestContext.aBogus);
  }

  async waitForJimengSignedContext(timeoutMs = 8000) {
    if (this.hasJimengSignedContext()) {
      return true;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.sleep(250);
      if (this.hasJimengSignedContext()) {
        return true;
      }
    }

    return this.hasJimengSignedContext();
  }

  buildMetricsExtra(submitId, taskConfig, modelConfig) {
    return {
      isDefaultSeed: 1,
      originSubmitId: submitId,
      isRegenerate: false,
      enterFrom: 'click',
      position: 'page_bottom_box',
      functionMode: taskConfig.referenceMode === 'all_reference' ? 'omni_reference' : 'first_last_frames',
      sceneOptions: JSON.stringify([{
        type: 'video',
        scene: 'BasicVideoGenerateButton',
        resolution: '720p',
        modelReqKey: modelConfig.modelReqKey,
        videoDuration: taskConfig.durationSeconds,
        reportParams: {
          enterSource: 'generate',
          vipSource: 'generate',
          extraVipFunctionKey: `${modelConfig.modelReqKey}-720p`,
          useVipFunctionDetailsReporterHoc: true
        },
        materialTypes: [1]
      }])
    };
  }

  async pollTaskStatus(historyId) {
    while (this.runningTasks.has(historyId)) {
      await this.sleep(30000);

      try {
        const result = await this.executeJimengPageRequest(
          '/mweb/v1/get_history_queue_info',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history_ids: [historyId] })
          }
        );
        const queueInfo = result.data?.[historyId];

        // 任务在 API 中已消失（被取消或服务端删除）
        if (!queueInfo) {
          console.warn(`[批量] 任务 ${historyId} 在轮询响应中不存在，视为已取消`);
          this.runningTasks.delete(historyId);
          const task = this.tasks.find(t => t.historyRecordId === historyId);
          if (task) {
            task.status = 'cancelled';
            task.error = '任务已在网站取消';
            task.queueInfo = null;
            await this.saveTasks();
          }
          this.maybeResumeBatch('pollTaskStatus:cancelled');
          break;
        }

        const task = this.tasks.find(t => t.historyRecordId === historyId);
        if (task) {
          task.queueInfo = queueInfo;
          await this.saveTasks();
        }

        if (queueInfo.status !== 0) {
          this.runningTasks.delete(historyId);

          if (task) {
            if (queueInfo.status === 30 && queueInfo.fail_code === '4011') {
              task.status = 'failed';
              task.error = '人脸审核失败';
            } else if (queueInfo.status === 40) {
              task.status = 'completed';
            } else {
              task.status = 'failed';
              task.error = queueInfo.fail_msg || '任务失败';
            }
            task.queueInfo = null;
            await this.saveTasks();
          }
          this.maybeResumeBatch(`pollTaskStatus:status:${queueInfo.status}`);
          break;
        }
      } catch (error) {
        console.error('轮询失败:', error);
      }
    }
  }

  // ───────────── Runway 专用流程（Stage 2 引入，走 headless REST）─────────────

  /**
   * 处理一个 Runway 批量任务
   * 与即梦 processTask 的本质区别：完全不依赖页面 / DOM / page-bridge
   */
  async processRunwayTask(task) {
    const platform = registry.getPlatform('runway');
    if (!platform || !platform.submitter) {
      throw new Error('Runway Platform 未注册或缺少 submitter');
    }

    const config = task.config || {};
    if (!config.prompt && !task.promptText) {
      throw new Error('Runway 任务缺少 prompt');
    }

    // 日上限风控：单日 80 条满了就拒绝派发，task 留 pending 等明天
    const counter = await this.getRunwayDailyCounter();
    if (counter.count >= RUNWAY_DAILY_CAP) {
      const err = new Error('RUNWAY_DAILY_CAP_REACHED');
      err.code = 'RUNWAY_DAILY_CAP_REACHED';
      throw err;
    }

    // 提交节流：和上次 Runway submit 间隔不足 3-8s 时先睡一下，避免脚本化节奏
    const minGapMs = RUNWAY_QUEUE.submitIntervalMinMs ?? 3000;
    const maxGapMs = RUNWAY_QUEUE.submitIntervalMaxMs ?? 8000;
    if (this._lastRunwaySubmitAt) {
      const since = Date.now() - this._lastRunwaySubmitAt;
      const need = minGapMs + Math.random() * (maxGapMs - minGapMs);
      if (since < need) {
        const waitMs = Math.round(need - since);
        console.log(`[Runway 节流] 距上次 submit ${since}ms，再等 ${waitMs}ms`);
        await this.sleep(waitMs);
      }
    }
    this._lastRunwaySubmitAt = Date.now();

    task.status = 'uploading';
    task.error = null;
    await this.saveTasks();

    const referenceImages = [];
    for (const image of (task.images || [])) {
      const blob = await this.getUploadBlob(image);
      const filename = image?.fileName || `ref-${referenceImages.length + 1}.${this.guessImageExtension(blob, image)}`;
      referenceImages.push({ blob, filename });
    }

    task.status = 'submitting';
    task.submittedPromptText = config.prompt || task.promptText;
    await this.saveTasks();

    let submission;
    try {
      submission = await platform.submitter.submit({
        prompt: config.prompt || task.promptText,
        model: config.model,
        duration: config.duration,
        resolution: config.resolution,
        aspectRatio: config.aspectRatio,
        generateAudio: config.generateAudio,
        exploreMode: config.exploreMode,
        referenceImages
      });
    } catch (error) {
      if (error.status === 429 || /queue|throttle|rate/i.test(error.message || '')) {
        const queueErr = new Error('QUEUE_LIMIT_REACHED');
        queueErr.cause = error;
        throw queueErr;
      }
      // 上传/提交失败：记日志（S3 超时等）
      logError({
        error,
        taskId: task.id,
        platform: 'runway',
        promptText: task.promptText,
        imageIds: (task.images || []).map(i => i.imageId).filter(Boolean),
        context: { phase: 'submitRunwayTask' }
      }).catch(() => {});
      throw error;
    }

    task.runwayTaskId = submission.taskId;
    task.queueInfo = submission.estimatedTimeToStartSeconds != null
      ? { estimatedTimeToStartSeconds: submission.estimatedTimeToStartSeconds }
      : null;
    task.status = submission.status === 'completed' ? 'completed' : 'queued';
    this.submittedThisRun = true;

    this.runningTasks.set(submission.taskId, {
      taskId: task.id,
      startTime: Date.now(),
      platform: 'runway'
    });
    this.nextRetryAt = 0;
    await this.incrementRunwayDailyCounter();
    await this.saveTasks();

    this.pollRunwayTaskStatus(submission.taskId);
  }

  /**
   * 把一次 Runway 任务更新（来自我们自己 poll 或寄生抓取）应用到 task 上。
   * 返回 true 代表任务已终结（completed / failed / cancelled），调用方应停止轮询。
   */
  async applyRunwayUpdate(runwayTaskId, update, source = 'poll') {
    const task = this.tasks.find(t => t.runwayTaskId === runwayTaskId);
    if (!task) return false;

    task.queueInfo = update.estimatedTimeToStartSeconds != null
      ? { estimatedTimeToStartSeconds: update.estimatedTimeToStartSeconds, progress: update.progress }
      : (update.progress != null ? { progress: update.progress } : null);

    if (update.status === 'completed') {
      task.status = 'completed';
      task.videoUrl = update.videoUrl;
      task.thumbnailUrl = update.thumbnailUrl;
      task.queueInfo = null;
      this.runningTasks.delete(runwayTaskId);
      await this.saveTasks();
      this.maybeResumeBatch(`runwayUpdate:${source}:completed`);
      return true;
    }

    if (update.status === 'failed' || update.status === 'cancelled') {
      task.status = update.status;
      task.error = formatRunwayError(update.error, update.status, update.rawStatus);
      task.queueInfo = null;
      this.runningTasks.delete(runwayTaskId);
      await this.saveTasks();
      // 记录到本地错误日志（异步，不阻塞主流程）
      if (update.status === 'failed') {
        logError({
          error: update.error || { message: task.error, reason: update.error?.reason, code: update.error?.code },
          taskId: task.id,
          platform: 'runway',
          promptText: task.promptText,
          imageIds: (task.images || []).map(i => i.imageId).filter(Boolean),
          context: { runwayTaskId, source, rawStatus: update.rawStatus }
        }).catch(() => {});
      }
      this.maybeResumeBatch(`runwayUpdate:${source}:${update.status}`);
      return true;
    }

    await this.saveTasks();
    return false;
  }

  /**
   * 寄生入口：Runway 页面 fetch 钩子拦到的 GET /v1/tasks/{id} 响应直接喂进来。
   * 顺便记录 lastPassiveUpdateAt，让自己的 poll 循环看到最近有"白嫖更新"就跳过一轮。
   */
  async ingestRunwayPassiveUpdate(runwayTaskId, rawBody) {
    if (!this.runningTasks.has(runwayTaskId)) return;
    const update = parseRunwayTaskResponse(rawBody);
    if (!update) return;
    this._runwayPassiveAt = this._runwayPassiveAt || new Map();
    this._runwayPassiveAt.set(runwayTaskId, Date.now());
    console.log(`[Runway 寄生] ${runwayTaskId.slice(0, 8)} ← 页面白嫖 ${update.rawStatus}/${update.status} progress=${update.progress ?? '-'}%`);
    await this.applyRunwayUpdate(runwayTaskId, update, 'passive');
  }

  async pollRunwayTaskStatus(runwayTaskId) {
    const platform = registry.getPlatform('runway');
    if (!platform?.submitter) {
      console.warn('[Runway 轮询] platform 未注册，放弃');
      this.runningTasks.delete(runwayTaskId);
      return;
    }

    console.log(`[Runway 轮询] 开始轮询 ${runwayTaskId}`);

    // 基线间隔 + ±25% 抖动，避免整数节拍被识别
    const POLL_INTERVAL_BASE_MS = 8000;
    const POLL_INTERVAL_SLOW_BASE_MS = 20000;
    // 寄生新鲜度：上次被动更新若在这窗口内，本轮直接跳过自己发请求
    const PASSIVE_FRESH_WINDOW_MS = 15000;
    let consecutiveErrors = 0;
    let pollCount = 0;
    let lastLoggedStatus = null;

    while (this.runningTasks.has(runwayTaskId)) {
      try {
        // 寄生新鲜度判定：Runway 页面最近 15s 内已经更新过本任务，就不发请求
        const lastPassive = this._runwayPassiveAt?.get(runwayTaskId) || 0;
        const passiveAge = Date.now() - lastPassive;
        if (lastPassive && passiveAge < PASSIVE_FRESH_WINDOW_MS) {
          await this.sleep(jitter(POLL_INTERVAL_BASE_MS, 0.25));
          continue;
        }

        const update = await platform.submitter.poll(runwayTaskId);
        consecutiveErrors = 0;
        pollCount++;

        if (update.status !== lastLoggedStatus || pollCount % 10 === 0) {
          console.log(`[Runway 轮询 #${pollCount}] ${runwayTaskId.slice(0, 8)} → ${update.rawStatus}/${update.status} progress=${update.progress ?? '-'}%`);
          lastLoggedStatus = update.status;
        }

        const finished = await this.applyRunwayUpdate(runwayTaskId, update, 'poll');
        if (finished) break;

        const task = this.tasks.find(t => t.runwayTaskId === runwayTaskId);
        const baseMs = (task?.status === 'queued' || update.status === 'queuing')
          ? POLL_INTERVAL_SLOW_BASE_MS
          : POLL_INTERVAL_BASE_MS;
        await this.sleep(jitter(baseMs, 0.25));
      } catch (error) {
        consecutiveErrors += 1;
        console.error(`[Runway 轮询] ${runwayTaskId} 第 ${consecutiveErrors} 次失败:`, error.message);

        if (error.code === 'AUTH_FAILED' || error.code === 'NO_JWT') {
          const task = this.tasks.find(t => t.runwayTaskId === runwayTaskId);
          if (task) {
            task.status = 'failed';
            task.error = 'Runway JWT 已失效，请重新设置';
            await this.saveTasks();
          }
          this.runningTasks.delete(runwayTaskId);
          this.maybeResumeBatch('pollRunwayTaskStatus:auth-failed');
          break;
        }

        if (consecutiveErrors >= 5) {
          console.error(`[Runway 轮询] ${runwayTaskId} 连续失败 5 次，放弃`);
          this.runningTasks.delete(runwayTaskId);
          this.maybeResumeBatch('pollRunwayTaskStatus:exhausted');
          break;
        }
        await this.sleep(jitter(POLL_INTERVAL_SLOW_BASE_MS, 0.25));
      }
    }
  }

  hasPendingTasks() {
    return this.tasks.some(task => task.status === 'pending');
  }

  hasDispatchingTasks() {
    return this.tasks.some(task => ['uploading', 'submitting'].includes(task.status));
  }

  hasActiveBatchTasks() {
    return this.tasks.some(task => ['uploading', 'submitting', 'queued'].includes(task.status));
  }

  ensureAutoDispatchStoppedWhenIdle() {
    if (!this.hasPendingTasks() && !this.hasDispatchingTasks() && !this.isRunning) {
      this.autoDispatchEnabled = false;
      this.isPaused = false;
    }

    if (!this.hasPendingTasks() && !this.hasActiveBatchTasks() && this.runningTasks.size === 0) {
      this.autoDispatchEnabled = false;
      this.isRunning = false;
      this.isPaused = false;
    }
  }

  maybeResumeBatch(reason = 'unknown') {
    if (!this.autoDispatchEnabled || this.isPaused || this.isRunning || !this.hasPendingTasks()) {
      this.ensureAutoDispatchStoppedWhenIdle();
      return;
    }

    console.log(`[后台] 检测到可继续提交的待处理任务，尝试恢复批量队列: ${reason}`);
    this.startBatch().catch((error) => {
      console.error('[后台] 恢复批量队列失败:', error);
    });
  }

  async syncTaskFromMonitor(monitorTask) {
    const historyId = String(monitorTask?.taskId || '');
    if (!historyId) {
      return false;
    }

    const task = this.tasks.find(item => String(item.historyRecordId || '') === historyId);
    if (!task) {
      return false;
    }

    let changed = false;
    const normalizedStatus = this.mapMonitorStatusToBatchStatus(monitorTask.status);
    const nextQueueInfo = this.mergeQueueInfoFromMonitor(task.queueInfo, monitorTask);

    if (nextQueueInfo !== task.queueInfo) {
      task.queueInfo = nextQueueInfo;
      changed = true;
    }

    if (normalizedStatus && task.status !== normalizedStatus) {
      task.status = normalizedStatus;
      changed = true;
    }

    if (normalizedStatus === 'queued' && !this.runningTasks.has(historyId)) {
      this.runningTasks.set(historyId, {
        taskId: task.id,
        startTime: task.createdAt || Date.now(),
        synced: true
      });
      changed = true;
    }

    if (normalizedStatus === 'cancelled') {
      const nextError = monitorTask.error || task.error || '任务已在网站取消';
      if (task.error !== nextError) {
        task.error = nextError;
        changed = true;
      }
    } else if (normalizedStatus === 'failed') {
      const nextError = monitorTask.error || task.error || '任务失败';
      if (task.error !== nextError) {
        task.error = nextError;
        changed = true;
      }
    }

    if (['completed', 'failed', 'cancelled'].includes(normalizedStatus)) {
      if (task.queueInfo !== null) {
        task.queueInfo = null;
        changed = true;
      }
      if (this.runningTasks.delete(historyId)) {
        changed = true;
      }
    }

    if (!changed) {
      this.ensureAutoDispatchStoppedWhenIdle();
      return false;
    }

    await this.saveTasks();

    if (['completed', 'failed', 'cancelled'].includes(normalizedStatus)) {
      this.maybeResumeBatch(`monitor:${normalizedStatus}`);
    } else {
      this.ensureAutoDispatchStoppedWhenIdle();
    }

    return true;
  }

  mapMonitorStatusToBatchStatus(status) {
    const statusMap = {
      queuing: 'queued',
      generating: 'queued',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled'
    };

    return statusMap[status] || null;
  }

  mergeQueueInfoFromMonitor(queueInfo, monitorTask) {
    const nextQueuePosition = monitorTask?.queuePosition;
    const nextQueueTotal = monitorTask?.queueTotal;
    const nextEstimate = monitorTask?.estimatedQueueTime;
    const hasQueuePatch = nextQueuePosition !== undefined || nextQueueTotal !== undefined || nextEstimate !== undefined;

    if (!hasQueuePatch) {
      return queueInfo || null;
    }

    return {
      ...(queueInfo || {}),
      queue_info: {
        ...(queueInfo?.queue_info || {}),
        ...(nextQueuePosition !== undefined ? { queue_idx: nextQueuePosition } : {}),
        ...(nextQueueTotal !== undefined ? { queue_length: nextQueueTotal } : {})
      },
      forecast_cost_time: {
        ...(queueInfo?.forecast_cost_time || {}),
        ...(nextEstimate !== undefined ? { forecast_queue_cost: nextEstimate } : {})
      }
    };
  }

  buildJimengApiUrl(path) {
    const url = new URL(path, 'https://jimeng.jianying.com');
    url.searchParams.set('aid', JIMENG_AID);
    url.searchParams.set('device_platform', 'web');
    url.searchParams.set('region', 'cn');
    if (this.jimengRequestContext.webId) {
      url.searchParams.set('webId', this.jimengRequestContext.webId);
    }
    url.searchParams.set('web_version', JIMENG_WEB_VERSION);
    url.searchParams.set('da_version', JIMENG_DA_VERSION);
    if (this.jimengRequestContext.os) {
      url.searchParams.set('os', this.jimengRequestContext.os);
    }
    if (this.jimengRequestContext.webComponentOpenFlag) {
      url.searchParams.set('web_component_open_flag', this.jimengRequestContext.webComponentOpenFlag);
    }
    if (this.jimengRequestContext.commerceWithInputVideo) {
      url.searchParams.set('commerce_with_input_video', this.jimengRequestContext.commerceWithInputVideo);
    }
    url.searchParams.set('aigc_features', JIMENG_AIGC_FEATURES);
    if (this.jimengRequestContext.msToken) {
      url.searchParams.set('msToken', this.jimengRequestContext.msToken);
    }
    if (this.jimengRequestContext.aBogus) {
      url.searchParams.set('a_bogus', this.jimengRequestContext.aBogus);
    }
    return url.toString();
  }

  buildJimengAssetListRequest(endTimeStamp = 0) {
    return {
      count: 20,
      direction: 1,
      mode: 'workbench',
      option: {
        image_info: {
          width: 2048,
          height: 2048,
          format: 'webp',
          image_scene_list: JIMENG_ASSET_LIST_SCENES
        },
        origin_image_info: {
          width: 96,
          height: 2048,
          format: 'webp',
          image_scene_list: JIMENG_ASSET_LIST_SCENES
        },
        order_by: 0,
        only_favorited: false,
        end_time_stamp: endTimeStamp,
        hide_story_agent_result: true
      },
      asset_type_list: [1, 2, 5, 6, 7, 8, 9, 10],
      workspace_id: 0
    };
  }

  getImageMetaFromCommitResult(commitData, fallbackUri, imageData) {
    const pluginResult = commitData?.Result?.PluginResult?.[0];
    return {
      uri: pluginResult?.ImageUri || fallbackUri,
      width: pluginResult?.ImageWidth || imageData.width || null,
      height: pluginResult?.ImageHeight || imageData.height || null
    };
  }

  buildVideoDraftContent(parsedPrompt, image, lastImage, taskConfig, modelConfig, referenceConfig, uploadedImages, metricsExtra) {
    if (taskConfig.referenceMode === 'all_reference') {
      return this.buildWorkbenchOmniReferenceDraft(parsedPrompt, uploadedImages, taskConfig, modelConfig, metricsExtra);
    }

    const draftId = crypto.randomUUID();
    const componentId = crypto.randomUUID();
    const metadataId = crypto.randomUUID();
    const abilitiesId = crypto.randomUUID();
    const genVideoId = crypto.randomUUID();
    const textToVideoParamsId = crypto.randomUUID();
    const videoInputId = crypto.randomUUID();
    const firstFrameImageId = crypto.randomUUID();
    const createdTime = String(Date.now());
    const videoInput = {
      type: '',
      id: videoInputId,
      min_version: JIMENG_DRAFT_MIN_VERSION,
      prompt: parsedPrompt.cleanedPrompt,
      video_mode: referenceConfig.videoMode,
      fps: JIMENG_VIDEO_FPS,
      duration_ms: taskConfig.durationSeconds * 1000
    };
    const videoRefParams = this.buildVideoRefParams(uploadedImages, taskConfig, parsedPrompt);

    if (image) {
      videoInput.first_frame_image = {
        type: 'image',
        id: firstFrameImageId,
        source_from: 'upload',
        platform_type: 1,
        name: '',
        image_uri: image.uri,
        width: image.width || 0,
        height: image.height || 0,
        format: '',
        uri: image.uri
      };

      if (lastImage?.uri) {
        videoInput.last_frame_image = {
          type: 'image',
          id: crypto.randomUUID(),
          source_from: 'upload',
          platform_type: 1,
          name: '',
          image_uri: lastImage.uri,
          width: lastImage.width || 0,
          height: lastImage.height || 0,
          format: '',
          uri: lastImage.uri
        };
      }
    }

    return {
      type: 'draft',
      id: draftId,
      min_version: JIMENG_DRAFT_MIN_VERSION,
      min_features: [],
      is_from_tsn: true,
      version: JIMENG_DRAFT_VERSION,
      main_component_id: componentId,
      component_list: [{
        type: 'video_base_component',
        id: componentId,
        min_version: JIMENG_COMPONENT_MIN_VERSION,
        aigc_mode: 'workbench',
        metadata: {
          type: '',
          id: metadataId,
          created_platform: 3,
          created_platform_version: '',
          created_time_in_ms: createdTime,
          created_did: ''
        },
        generate_type: 'gen_video',
        abilities: {
          type: '',
          id: abilitiesId,
          gen_video: {
            type: '',
            id: genVideoId,
            ...(videoRefParams ? { video_ref_params: videoRefParams } : {}),
            text_to_video_params: {
              type: '',
              id: textToVideoParamsId,
              video_gen_inputs: [videoInput],
              video_aspect_ratio: taskConfig.aspectRatio,
              seed: this.generateSeed(),
              model_req_key: modelConfig.modelReqKey,
              priority: 0
            },
            video_task_extra: JSON.stringify(metricsExtra)
          }
        }
      }]
    };
  }

  buildVideoRefParams(uploadedImages, taskConfig, parsedPrompt) {
    const isFirstLastMode = taskConfig.referenceMode === 'first_last_frames';

    if (isFirstLastMode) {
      return {
        type: '',
        id: crypto.randomUUID(),
        generate_type: 1,
        item_id: 123456
      };
    }

    if (uploadedImages.length === 0) return null;

    const abilityList = uploadedImages.map((image, index) => ({
      type: '',
      id: crypto.randomUUID(),
      name: 'byte_edit',
      image_uri_list: [image.uri],
      image_list: [{
        type: 'image',
        id: crypto.randomUUID(),
        source_from: 'upload',
        platform_type: 1,
        name: `图片${index + 1}`,
        image_uri: image.uri,
        width: image.width || 0,
        height: image.height || 0,
        format: '',
        uri: image.uri
      }]
    }));

    const placeholderSource = parsedPrompt.placeholderOrder.length > 0
      ? parsedPrompt.placeholderOrder
      : (uploadedImages.length > 0 ? uploadedImages.map((_, index) => index) : []);

    const promptPlaceholderInfoList = placeholderSource.map((imageIndex) => ({
      type: '',
      id: crypto.randomUUID(),
      ability_index: imageIndex
    }));

    return {
      type: '',
      id: crypto.randomUUID(),
      generate_type: 0,
      item_id: 123456,
      ability_list: abilityList,
      prompt_placeholder_info_list: promptPlaceholderInfoList
    };
  }

  buildWorkbenchOmniReferenceDraft(parsedPrompt, uploadedImages, taskConfig, modelConfig, metricsExtra) {
    const draftId = crypto.randomUUID();
    const componentId = crypto.randomUUID();
    const metadataId = crypto.randomUUID();
    const abilitiesId = crypto.randomUUID();
    const genVideoId = crypto.randomUUID();
    const textToVideoParamsId = crypto.randomUUID();
    const videoInputId = crypto.randomUUID();
    const unifiedEditInputId = crypto.randomUUID();
    const createdTime = String(Date.now());
    const videoTaskExtra = JSON.stringify(metricsExtra);

    return {
      type: 'draft',
      id: draftId,
      min_version: JIMENG_WORKBENCH_MIN_VERSION,
      min_features: ['AIGC_Video_UnifiedEdit'],
      is_from_tsn: true,
      version: JIMENG_DRAFT_VERSION,
      main_component_id: componentId,
      component_list: [{
        type: 'video_base_component',
        id: componentId,
        min_version: JIMENG_COMPONENT_MIN_VERSION,
        aigc_mode: 'workbench',
        gen_type: 10,
        metadata: {
          type: '',
          id: metadataId,
          created_platform: 3,
          created_platform_version: '',
          created_time_in_ms: createdTime,
          created_did: ''
        },
        generate_type: 'gen_video',
        abilities: {
          type: '',
          id: abilitiesId,
          gen_video: {
            type: '',
            id: genVideoId,
            text_to_video_params: {
              type: '',
              id: textToVideoParamsId,
              video_gen_inputs: [{
                type: '',
                id: videoInputId,
                min_version: JIMENG_WORKBENCH_MIN_VERSION,
                prompt: '',
                video_mode: 2,
                fps: JIMENG_VIDEO_FPS,
                duration_ms: taskConfig.durationSeconds * 1000,
                idip_meta_list: [],
                unified_edit_input: {
                  type: '',
                  id: unifiedEditInputId,
                  material_list: this.buildWorkbenchMaterialList(uploadedImages),
                  meta_list: this.buildWorkbenchMetaList(parsedPrompt, uploadedImages.length)
                }
              }],
              video_aspect_ratio: taskConfig.aspectRatio,
              seed: this.generateSeed(),
              model_req_key: modelConfig.modelReqKey,
              priority: 0
            },
            video_task_extra: videoTaskExtra
          }
        },
        process_type: 1
      }]
    };
  }

  buildWorkbenchMaterialList(uploadedImages) {
    return uploadedImages.map((image) => ({
      type: '',
      id: crypto.randomUUID(),
      material_type: 'image',
      image_info: {
        type: 'image',
        id: crypto.randomUUID(),
        source_from: 'upload',
        platform_type: 1,
        name: '',
        image_uri: image.uri,
        aigc_image: {
          type: '',
          id: crypto.randomUUID()
        },
        width: image.width || 0,
        height: image.height || 0,
        format: '',
        uri: image.uri
      }
    }));
  }

  buildWorkbenchMetaList(parsedPrompt, imageCount) {
    const hasPlaceholders = parsedPrompt.segments.some(segment => segment.type === 'image');

    if (!hasPlaceholders) {
      return [
        ...Array.from({ length: imageCount }, (_, index) => this.createWorkbenchImageMeta(index)),
        this.createWorkbenchTextMeta(parsedPrompt.cleanedPrompt)
      ];
    }

    return parsedPrompt.segments
      .map((segment) => {
        if (segment.type === 'image') {
          return this.createWorkbenchImageMeta(segment.imageIndex);
        }
        if (segment.type === 'text' && segment.text) {
          return this.createWorkbenchTextMeta(segment.text);
        }
        return null;
      })
      .filter(Boolean);
  }

  createWorkbenchImageMeta(imageIndex) {
    return {
      type: '',
      id: crypto.randomUUID(),
      meta_type: 'image',
      text: '',
      material_ref: {
        type: '',
        id: crypto.randomUUID(),
        material_idx: imageIndex
      }
    };
  }

  createWorkbenchTextMeta(text) {
    return {
      type: '',
      id: crypto.randomUUID(),
      meta_type: 'text',
      text
    };
  }

  generateSeed() {
    return Math.floor(Math.random() * 2147483647);
  }

  async executeJimengPageRequest(path, init) {
    const jimengTab = await this.findJimengTab();
    if (!jimengTab?.id) {
      throw new Error('未找到当前批量提交绑定的即梦页面');
    }

    const url = this.buildJimengApiUrl(path);
    let response;

    try {
      response = await this.sendJimengPageRequest(jimengTab.id, url, init);
    } catch (error) {
      if (!this.isMissingReceiverError(error)) {
        throw error;
      }

      console.warn('[后台] 即梦页面通信接收端不存在，尝试恢复当前批量提交页后重试:', error);
      await this.recoverJimengPageBridge({
        reason: `page_request:${path}`,
        tabId: jimengTab.id
      });
      response = await this.sendJimengPageRequest(jimengTab.id, url, init);
    }

    if (!response?.success) {
      const responseError = new Error(response?.error || '页面请求失败');
      if (!this.isMissingReceiverError(responseError)) {
        throw responseError;
      }

      console.warn('[后台] 即梦页面通信中断，尝试恢复当前批量提交页后重试:', responseError);
      await this.recoverJimengPageBridge({
        reason: `page_request_response:${path}`,
        tabId: jimengTab.id
      });
      response = await this.sendJimengPageRequest(jimengTab.id, url, init);

      if (!response?.success) {
        throw new Error(response?.error || '页面请求失败');
      }
    }

    return response.responseData;
  }

  async executeJimengMonitorPageRequest(path, init) {
    const jimengTab = await this.findAnyJimengTab();
    if (!jimengTab?.id) {
      throw new Error('未找到已打开的即梦页面');
    }

    const url = this.buildJimengApiUrl(path);
    let response;

    try {
      response = await this.sendJimengPageRequest(jimengTab.id, url, init);
    } catch (error) {
      if (!this.isMissingReceiverError(error)) {
        throw error;
      }

      console.warn('[后台] 即梦监控页面通信接收端不存在，尝试刷新页面后重试:', error);
      await this.reloadJimengTabAndWait(jimengTab.id);
      response = await this.sendJimengPageRequest(jimengTab.id, url, init);
    }

    if (!response?.success) {
      const responseError = new Error(response?.error || '页面请求失败');
      if (!this.isMissingReceiverError(responseError)) {
        throw responseError;
      }

      console.warn('[后台] 即梦监控页面通信中断，尝试刷新页面后重试:', responseError);
      await this.reloadJimengTabAndWait(jimengTab.id);
      response = await this.sendJimengPageRequest(jimengTab.id, url, init);

      if (!response?.success) {
        throw new Error(response?.error || '页面请求失败');
      }
    }

    return response.responseData;
  }

  async executeJimengDomSubmit(payload) {
    const jimengTab = await this.findJimengTab();
    if (!jimengTab?.id) {
      throw new Error('未找到当前批量提交绑定的即梦页面');
    }

    let response;
    this.pendingPageDrivenSubmit = {
      taskId: payload.taskId,
      startedAt: Date.now(),
      expectedPromptText: payload.displayPromptText || payload.promptText || '',
      tabId: jimengTab.id
    };

    try {
      try {
        response = await this.sendJimengDomSubmit(jimengTab.id, payload);
      } catch (error) {
        if (!this.isMissingReceiverError(error)) {
          throw error;
        }

        await this.setTaskDomSubmitState(payload.taskId, 'reconnecting');
        console.warn('[后台] 即梦页面通信接收端不存在，尝试恢复当前批量提交页后重试 DOM 提交:', error);
        await this.recoverJimengPageBridge({
          reason: `dom_submit:${payload.taskId}`,
          tabId: jimengTab.id
        });
        await this.setTaskDomSubmitState(payload.taskId, 'recovering');
        response = await this.sendJimengDomSubmit(jimengTab.id, payload);
      }

      if (!response?.success) {
        throw new Error(response?.error || '页面自动提交失败');
      }

      return response;
    } finally {
      this.pendingPageDrivenSubmit = null;
    }
  }

  async sendJimengDomSubmit(tabId, payload) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_JIMENG_DOM_SUBMIT',
        requestId: `jimeng-dom-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...payload,
        timeout: 120000
      });
    } catch (error) {
      if (this.isMissingReceiverError(error)) {
        throw new Error('即梦页面连接已断开，请刷新页面后重试');
      }
      throw error;
    }
  }

  extractJimengHistoryId(responseData) {
    return String(
      responseData?.data?.aigc_data?.history_record_id ||
      responseData?.data?.aigc_data?.task?.task_id ||
      responseData?.data?.task_id ||
      ''
    );
  }

  extractJimengQueueInfo(responseData, historyId) {
    const aigcData = responseData?.data?.aigc_data;
    if (aigcData?.queue_info || aigcData?.forecast_queue_cost || aigcData?.forecast_generate_cost) {
      return {
        queue_info: aigcData.queue_info || null,
        forecast_cost_time: {
          forecast_queue_cost: aigcData.forecast_queue_cost,
          forecast_generate_cost: aigcData.forecast_generate_cost
        }
      };
    }

    const keyedData = historyId ? responseData?.data?.[historyId] : null;
    return keyedData || null;
  }

  async handleJimengDomSubmitProgress(msg) {
    const task = this.tasks.find(item => item.id === msg.taskId);
    if (!task) {
      return false;
    }

    task.domSubmitState = msg.state || null;
    if (msg.error) {
      task.error = msg.error;
    }

    await this.saveTasks();
    return true;
  }

  async setTaskDomSubmitState(taskId, state, extra = {}) {
    const task = this.tasks.find(item => item.id === taskId);
    if (!task) {
      return false;
    }

    task.domSubmitState = state || null;
    if (Object.prototype.hasOwnProperty.call(extra, 'error')) {
      task.error = extra.error;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'status')) {
      task.status = extra.status;
    }

    await this.saveTasks();
    return true;
  }

  async sendJimengPageRequest(tabId, url, init) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_PAGE_REQUEST',
        requestId: `jimeng-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        url,
        init: {
          ...init,
          credentials: 'include'
        },
        timeout: 30000
      });
    } catch (error) {
      if (this.isMissingReceiverError(error)) {
        throw new Error('即梦页面连接已断开，请刷新页面后重试');
      }
      throw error;
    }
  }

  isMissingReceiverError(error) {
    const message = String(error?.message || error || '');
    return (
      message.includes('Receiving end does not exist') ||
      message.includes('message channel closed before a response was received') ||
      message.includes('The message port closed before a response was received') ||
      message.includes('即梦页面连接已断开')
    );
  }

  async reloadJimengTabAndWait(tabId) {
    await chrome.tabs.reload(tabId);

    await new Promise((resolve) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        chrome.tabs.onUpdated.removeListener(handleUpdated);
        resolve();
      }, 10000);

      const handleUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete' || settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(handleUpdated);
        resolve();
      };

      chrome.tabs.onUpdated.addListener(handleUpdated);
    });

    await this.sleep(800);
  }

  async persistCurrentSubmitTab() {
    if (!this.currentSubmitTabId) {
      await chrome.storage.local.remove('batchSubmitContext');
      return;
    }

    await chrome.storage.local.set({
      batchSubmitContext: {
        tabId: this.currentSubmitTabId,
        windowId: this.currentSubmitWindowId,
        pageUrl: this.currentSubmitPageUrl
      }
    });
  }

  async clearCurrentSubmitTab() {
    this.currentSubmitTabId = null;
    this.currentSubmitWindowId = null;
    this.currentSubmitPageUrl = '';
    await chrome.storage.local.remove('batchSubmitContext');
  }

  isJimengPageUrl(url = '') {
    return typeof url === 'string' && url.startsWith('https://jimeng.jianying.com/');
  }

  async bindCurrentSubmitTab() {
    const currentWindowTabs = await chrome.tabs.query({
      url: ['https://jimeng.jianying.com/*'],
      currentWindow: true
    });

    if (currentWindowTabs.length > 1) {
      throw new Error('检测到当前窗口打开了多个即梦页面。为避免串页，请只保留一个即梦页面后再启动批量提交');
    }

    const jimengTab = await this.findVisibleJimengTab();
    if (!jimengTab?.id) {
      throw new Error('请先在当前窗口打开并切换到即梦页面，再启动批量提交');
    }

    this.currentSubmitTabId = jimengTab.id;
    this.currentSubmitWindowId = jimengTab.windowId || null;
    this.currentSubmitPageUrl = jimengTab.url || '';
    await this.persistCurrentSubmitTab();
    return jimengTab;
  }

  async getBoundJimengTab() {
    if (!this.currentSubmitTabId) {
      return null;
    }

    try {
      const tab = await chrome.tabs.get(this.currentSubmitTabId);
      if (!this.isJimengPageUrl(tab?.url || '')) {
        await this.clearCurrentSubmitTab();
        return null;
      }

      this.currentSubmitWindowId = tab.windowId || this.currentSubmitWindowId;
      this.currentSubmitPageUrl = tab.url || this.currentSubmitPageUrl;
      return tab;
    } catch (error) {
      console.warn('[后台] 当前批量提交页已失效:', error);
      await this.clearCurrentSubmitTab();
      return null;
    }
  }

  async findJimengTab() {
    return this.getBoundJimengTab();
  }

  async findAnyJimengTab() {
    const tabs = await chrome.tabs.query({ url: ['https://jimeng.jianying.com/*'] });
    return tabs.find(tab => tab.active) || tabs[0] || null;
  }

  async findVisibleJimengTab() {
    const tabs = await chrome.tabs.query({ url: ['https://jimeng.jianying.com/*'], active: true, currentWindow: true });
    return tabs[0] || null;
  }

  isJimengBridgeReadyResponse(response) {
    const documentReady = response?.documentReady;
    const documentInteractive = documentReady === 'interactive' || documentReady === 'complete';

    return Boolean(
      response?.ready &&
      response?.extensionActive &&
      response?.relayInstalled &&
      response?.hookReady &&
      documentInteractive &&
      this.isJimengPageUrl(response?.pageUrl || '')
    );
  }

  async pingJimengPageBridge(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, {
        type: 'PING_PAGE_BRIDGE'
      });
    } catch (error) {
      if (this.isMissingReceiverError(error)) {
        return null;
      }
      throw error;
    }
  }

  async waitForJimengPageBridge(tabId, timeoutMs) {
    const startedAt = Date.now();
    let lastResponse = null;

    while (Date.now() - startedAt < timeoutMs) {
      const response = await this.pingJimengPageBridge(tabId);
      if (response) {
        lastResponse = response;
      }

      if (this.isJimengBridgeReadyResponse(response)) {
        return response;
      }

      await this.sleep(250);
    }

    return lastResponse;
  }

  async ensureJimengPageBridgeReady(timeoutMs = JIMENG_BRIDGE_READY_TIMEOUT_MS, options = {}) {
    const {
      allowRecovery = true,
      reason = 'unknown'
    } = options;
    const jimengTab = await this.findJimengTab();
    if (!jimengTab?.id) {
      throw new Error('未找到当前批量提交绑定的即梦页面');
    }

    const response = await this.waitForJimengPageBridge(jimengTab.id, timeoutMs);
    if (this.isJimengBridgeReadyResponse(response)) {
      return true;
    }

    if (!allowRecovery) {
      throw new Error('即梦页面桥接未连接，请返回当前批量提交页面后重试');
    }

    await this.recoverJimengPageBridge({
      reason,
      tabId: jimengTab.id
    });
    return true;
  }

  async recoverJimengPageBridge({ reason = 'unknown', tabId = null } = {}) {
    const targetTabId = tabId || this.currentSubmitTabId;
    if (!targetTabId) {
      throw new Error('未找到当前批量提交绑定的即梦页面');
    }

    const warmResponse = await this.waitForJimengPageBridge(targetTabId, JIMENG_BRIDGE_RECONNECT_WINDOW_MS);
    if (this.isJimengBridgeReadyResponse(warmResponse)) {
      return true;
    }

    for (let attempt = 0; attempt < JIMENG_BRIDGE_RECOVERY_ATTEMPTS; attempt += 1) {
      console.warn('[后台] 尝试恢复当前批量提交页桥接:', { reason, attempt: attempt + 1 });
      await this.reloadJimengTabAndWait(targetTabId);
      const response = await this.waitForJimengPageBridge(targetTabId, JIMENG_BRIDGE_POST_RELOAD_TIMEOUT_MS);
      if (this.isJimengBridgeReadyResponse(response)) {
        return true;
      }
    }

    throw new Error('即梦页面桥接未连接，请返回当前批量提交页面后重试');
  }

  async handleBridgeUnavailableDuringSubmit(task, error) {
    if (!task) {
      this.isRunning = false;
      this.isPaused = true;
      this.autoDispatchEnabled = false;
      this.submittedThisRun = false;
      this.ensureAutoDispatchStoppedWhenIdle();
      return false;
    }

    const afterGenerateStates = new Set(['clicking_generate', 'waiting_generate_request']);
    const afterGenerate = afterGenerateStates.has(task.domSubmitState);

    await this.setTaskDomSubmitState(task.id, 'reconnecting');

    try {
      await this.recoverJimengPageBridge({
        reason: `bridge_unavailable:${task.id}`,
        tabId: this.currentSubmitTabId
      });
    } catch (recoveryError) {
      console.warn('[后台] 恢复当前批量提交页失败，暂停批量:', recoveryError);
      task.status = 'pending';
      task.error = null;
      task.domSubmitState = 'recovery_failed';
      await this.saveTasks();
      this.isRunning = false;
      this.isPaused = true;
      this.autoDispatchEnabled = false;
      this.submittedThisRun = false;
      this.ensureAutoDispatchStoppedWhenIdle();
      return false;
    }

    if (afterGenerate) {
      task.error = '当前页面连接已恢复，但无法确认任务是否已成功提交，请检查页面后再继续';
      task.domSubmitState = 'recovered_needs_check';
      await this.saveTasks();
      this.isRunning = false;
      this.isPaused = true;
      this.autoDispatchEnabled = false;
      this.submittedThisRun = false;
      this.ensureAutoDispatchStoppedWhenIdle();
      return false;
    }

    task.status = 'pending';
    task.error = '当前页面连接已恢复，准备重新提交当前任务';
    task.domSubmitState = 'recovered';
    await this.saveTasks();
    this.submittedThisRun = false;
    return true;
  }

  async refreshJimengPage({ force = false, reason = 'unknown' } = {}) {
    const jimengTab = await this.findJimengTab();
    if (!jimengTab?.id) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastJimengPageRefreshAt < JIMENG_PAGE_REFRESH_MIN_INTERVAL_MS) {
      return;
    }

    this.lastJimengPageRefreshAt = now;

    try {
      console.log(`[后台] 刷新即梦页面: ${reason}`);
      await chrome.tabs.reload(jimengTab.id);
    } catch (error) {
      console.warn('[后台] 刷新即梦页面失败:', error);
    }
  }

  async reloadJimengStateForNextTask(reason = 'unknown') {
    const jimengTab = await this.findJimengTab();
    if (!jimengTab?.id) {
      return;
    }

    console.log(`[后台] 下个任务前重置即梦页面: ${reason}`);
    await this.reloadJimengTabAndWait(jimengTab.id);
    await this.ensureJimengPageBridgeReady(15000);
    this.submittedThisRun = false;
  }

  async saveTasks() {
    const MAX_HISTORY_TASKS = 300;
    const activeStatuses = ['pending', 'uploading', 'submitting', 'queued'];
    
    // 自动清理：限制已完成、已失败、已取消的历史任务数量
    const historyTasks = this.tasks.filter(t => !activeStatuses.includes(t.status));
    
    if (historyTasks.length > MAX_HISTORY_TASKS) {
      const activeTasks = this.tasks.filter(t => activeStatuses.includes(t.status));
      // 保留最新的 MAX_HISTORY_TASKS 个
      const tasksToKeep = historyTasks.slice(-MAX_HISTORY_TASKS);
      
      const previousTasks = [...this.tasks];
      // 重组 tasks，保证顺序
      this.tasks = [...activeTasks, ...tasksToKeep];
      
      console.log(`[后台] 队列历史容量达到上限，已自动清理 ${historyTasks.length - MAX_HISTORY_TASKS} 条废弃任务并回收本地内存。`);
      // 不阻塞地异步清理 orphaned images
      this.cleanupOrphanedImages(previousTasks).catch(err => 
        console.warn('[后台] 自动清理历史废弃图片时出错:', err)
      );
    }

    await chrome.storage.local.set({ batchTasks: this.tasks });
  }

  collectReferencedImageIds(tasks = this.tasks) {
    const imageIds = new Set();
    tasks.forEach((task) => {
      (task.images || []).forEach((image) => {
        if (image?.imageId) {
          imageIds.add(image.imageId);
        }
      });
    });
    return imageIds;
  }

  async cleanupOrphanedImages(previousTasks = []) {
    const previousIds = this.collectReferencedImageIds(previousTasks);
    const currentIds = this.collectReferencedImageIds(this.tasks);
    const orphanIds = Array.from(previousIds).filter((id) => !currentIds.has(id));

    if (orphanIds.length === 0) {
      return;
    }

    try {
      await deleteImageRecords(orphanIds);
    } catch (error) {
      console.warn('[后台] 清理孤立图片失败:', error);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function getAmzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function buildCanonicalQuery(searchParams) {
  return Array.from(searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }
      return leftKey.localeCompare(rightKey);
    })
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
}

function buildCanonicalHeaders(headers) {
  return Array.from(headers.entries())
    .map(([key, value]) => [key.toLowerCase().trim(), value.toString().trim().replace(/\s+/g, ' ')])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}\n`)
    .join('');
}

function getSignedHeaders(headers) {
  return Array.from(headers.keys())
    .map(key => key.toLowerCase().trim())
    .sort()
    .join(';');
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function normalizeImagexRegion(region) {
  if (!region || region === 'cn') {
    return DEFAULT_AWS_REGION;
  }
  return region;
}

function buildUploadUrl(uploadHost, storeUri) {
  const normalizedHost = uploadHost.startsWith('http://') || uploadHost.startsWith('https://')
    ? uploadHost
    : `https://${uploadHost}`;
  const baseUrl = normalizedHost.endsWith('/') ? normalizedHost.slice(0, -1) : normalizedHost;
  return `${baseUrl}/upload/v1/${storeUri}`;
}

function uniqueHosts(hosts) {
  return Array.from(new Set(
    (hosts || [])
      .map(host => String(host || '').trim())
      .filter(Boolean)
  ));
}

async function buildUploadHeaders(auth, blob) {
  const headers = new Headers();
  if (auth) {
    headers.set('Authorization', auth);
  }
  headers.set('Content-CRC32', await crc32Hex(blob));
  if (blob.type) {
    headers.set('Content-Type', blob.type);
  }
  return headers;
}

async function sha256Hex(value) {
  const buffer = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Blob
      ? await value.arrayBuffer()
      : value;

  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(digest);
}

async function hmac(key, value) {
  const keyData = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
}

async function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = await hmac(dateKey, region);
  const dateRegionServiceKey = await hmac(dateRegionKey, service);
  return hmac(dateRegionServiceKey, 'aws4_request');
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function crc32Hex(blob) {
  const crcTable = getCrc32Table();
  let crc = 0 ^ -1;

  const buffer = blob instanceof Blob ? await blob.arrayBuffer() : blob;
  const bytes = new Uint8Array(buffer);

  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xFF];
  }

  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

function getCrc32Table() {
  if (globalThis.__aiVideoMonitorCrc32Table) {
    return globalThis.__aiVideoMonitorCrc32Table;
  }

  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }

  globalThis.__aiVideoMonitorCrc32Table = table;
  return table;
}

class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.lastHeartbeat = new Map();
    this.tabHeartbeat = new Map();
    this.batchManager = new BatchManager();
    this.jimengSyncPromise = null;
    this.lastJimengSyncAt = 0;
    this.defaultMonitorSettings = {
      autoRefreshEnabled: true,
      staleMinutes: 30,
      refreshCooldownMinutes: 30
    };
    this.init();
  }

  async init() {
    console.log('[后台] 任务管理器初始化中...');

    // 启用点击图标开启侧边栏
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));
    }

    await this.batchManager.init();

    const { tasks } = await chrome.storage.local.get(['tasks']);
    if (tasks) {
      this.tasks = new Map(Object.entries(tasks));
      console.log(`[后台] 已恢复 ${this.tasks.size} 个任务`);
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      return this.handleMessage(msg, sender, sendResponse);
    });

    chrome.notifications.onClicked.addListener((notificationId) => {
      this.handleNotificationClick(notificationId);
    });

    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      this.handleNotificationButtonClick(notificationId, buttonIndex);
    });

    this.startPeriodicCheck();

    console.log('[后台] 任务管理器初始化完成');
  }

  /**
   * 处理消息
   */
  handleMessage(msg, sender, sendResponse) {
    switch (msg.type) {
      case 'GET_PLATFORM_CONFIG':
        const monitor = registry.getMonitor(msg.url);
        sendResponse({
          platform: monitor ? {
            name: monitor.name,
            domain: monitor.domain,
            apis: monitor.apis
          } : null
        });
        return false;

      case 'API_INTERCEPTED':
        this.handleApiIntercepted(msg, sender);
        sendResponse({ success: true });
        return false;

      case 'HEARTBEAT':
        this.recordHeartbeat(msg, sender);
        sendResponse({ success: true });
        return false;

      case 'JIMENG_DOM_SUBMIT_PROGRESS':
        this.batchManager.handleJimengDomSubmitProgress(msg)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'JIMENG_DOM_SUBMIT_RESULT':
        this.batchManager.handleJimengDomSubmitProgress({
          ...msg,
          state: msg.success ? 'done' : 'error',
          error: msg.success ? null : (msg.error || '页面自动提交失败')
        }).then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'GET_TASKS':
        this.getVisibleTasks().then((tasks) => {
          sendResponse({ tasks });
        }).catch((error) => {
          console.warn('[后台] 获取可见任务失败:', error);
          sendResponse({ tasks: this.getTasksArray() });
        });

        this.scheduleJimengTaskSync({ force: Boolean(msg.forceSync) }).catch((error) => {
          console.warn('[后台] 同步即梦任务状态失败:', error);
        });
        return true;

      case 'CLEAR_COMPLETED':
        Promise.all([
          Promise.resolve(this.clearCompletedTasks()),
          this.batchManager.clearHistory()
        ]).then(() => {
          sendResponse({ success: true });
        });
        return true;

      case 'GET_BATCH_TASKS':
        sendResponse({
          tasks: this.batchManager.getTasks(),
          state: this.batchManager.getState()
        });
        return false;

      case 'UPDATE_BATCH_TASK':
        this.batchManager.updateTask(msg.taskId, msg.task)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'ADD_BATCH_TASK':
        this.batchManager.addTask(msg.task).then(() => {
          sendResponse({ success: true });
        }).catch((error) => {
          console.error('[后台] 添加任务失败:', error);
          sendResponse({ success: false, error: error.message });
        });
        return true; // 异步响应

      case 'DELETE_BATCH_TASK':
        this.batchManager.removeTask(msg.taskId).then(() => {
          sendResponse({ success: true });
        });
        return true; // 异步响应

      case 'START_BATCH_SUBMIT':
        this.batchManager.prepareBatchStart()
          .then((state) => {
            this.batchManager.startBatch().catch((error) => {
              console.error('[后台] 启动批量提交失败:', error);
            });
            sendResponse({ success: true, state });
          })
          .catch((error) => {
            sendResponse({
              success: false,
              error: error.message,
              state: this.batchManager.getState()
            });
          });
        return true;

      case 'PAUSE_BATCH_SUBMIT':
        this.batchManager.pause();
        sendResponse({ success: true, state: this.batchManager.getState() });
        return false;

      // ─── Step 2b：挂机模式开关 ───
      case 'GET_AUTO_RUN':
        sendResponse({ success: true, enabled: this.batchManager.autoRunEnabled });
        return false;

      case 'SET_AUTO_RUN':
        this.batchManager.setAutoRunEnabled(!!msg.enabled)
          .then(() => sendResponse({ success: true, enabled: this.batchManager.autoRunEnabled }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'GET_PLATFORM_HEALTH':
        // 返回各平台 in-progress / limit + Runway 日上限计数，供侧边栏渲染
        (async () => {
          const counter = await this.batchManager.getRunwayDailyCounter().catch(() => null);
          sendResponse({
            success: true,
            health: {
              jimeng: {
                running: this.batchManager.getRunningCountByPlatform('jimeng'),
                limit: this.batchManager.maxConcurrentTasks
              },
              runway: {
                running: this.batchManager.getRunningCountByPlatform('runway'),
                limit: this.batchManager.platformMaxConcurrent.runway,
                dailyCount: counter?.count ?? 0,
                dailyCap: counter?.cap ?? RUNWAY_DAILY_CAP,
                dailyCapReached: !!this.batchManager._runwayDailyCapReached
              }
            }
          });
        })();
        return true;

      case 'OPEN_SIDE_PANEL':
        // popup 触发打开侧边栏
        if (chrome.sidePanel && sender?.tab?.windowId != null) {
          chrome.sidePanel.open({ windowId: sender.tab.windowId })
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        } else if (chrome.sidePanel) {
          // sender 是 popup 时没 tab.windowId，用 currentWindow 兜底
          chrome.windows.getCurrent().then((win) => {
            return chrome.sidePanel.open({ windowId: win.id });
          })
            .then(() => sendResponse({ success: true }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        } else {
          sendResponse({ success: false, error: 'sidePanel API 不可用' });
        }
        return true;

      // ─── Runway 调试通道（Stage 1 验收用，Stage 3 后由 add_task UI 走正式流程）───
      case 'RUNWAY_SET_JWT':
        setRunwayJwt(msg.jwt)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'RUNWAY_GET_JWT':
        getRunwayJwt()
          .then((jwt) => sendResponse({ success: true, hasJwt: Boolean(jwt), preview: jwt ? jwt.slice(0, 24) + '…' : null }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'RUNWAY_SET_CONTEXT':
        setRunwayContext(msg.context || {})
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'RUNWAY_GET_CONTEXT':
        getRunwayContext()
          .then((context) => sendResponse({ success: true, context }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'RUNWAY_TEST_SUBMIT':
        runwaySubmitter.submit(msg.task || {}, msg.opts || {})
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message, code: error.code, status: error.status }));
        return true;

      case 'RUNWAY_POLL_TASK':
        runwaySubmitter.poll(msg.taskId)
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message, code: error.code }));
        return true;

      case 'RUNWAY_CAN_START':
        runwaySubmitter.canStart(msg.opts || {})
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message, code: error.code }));
        return true;

      case 'RUNWAY_ESTIMATE_COST':
        runwaySubmitter.estimateCost(msg.taskOptions || {}, msg.opts || {})
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message, code: error.code }));
        return true;

      case 'RUNWAY_PASSIVE_UPDATE':
        // 寄生模式：Runway 页面的 fetch 拦截把任务状态白嫖给我们，免去 SW 自己发请求
        (async () => {
          if (!msg.taskId || !msg.body) {
            sendResponse({ success: false, error: 'missing taskId or body' });
            return;
          }
          await this.batchManager.ingestRunwayPassiveUpdate(msg.taskId, msg.body);
          sendResponse({ success: true });
        })().catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'RUNWAY_AUTO_HARVEST':
        (async () => {
          const creds = msg.creds || {};
          const updated = {};

          if (creds.jwt) {
            const existing = await getRunwayJwt();
            if (existing !== creds.jwt) {
              await setRunwayJwt(creds.jwt);
              updated.jwt = creds.jwt.slice(0, 20) + '…';
            }
          }

          const ctxPatch = {};
          if (creds.teamId) ctxPatch.teamId = creds.teamId;
          if (creds.assetGroupId) ctxPatch.assetGroupId = creds.assetGroupId;
          if (Object.keys(ctxPatch).length > 0) {
            const existing = await getRunwayContext();
            const changed = Object.entries(ctxPatch).some(([k, v]) => existing[k] !== v);
            if (changed) {
              await setRunwayContext(ctxPatch);
              Object.assign(updated, ctxPatch);
            }
          }

          if (Object.keys(updated).length > 0) {
            console.log('[Runway 自动凭证] 已更新:', updated);
            sendResponse({ success: true, updated });
          } else {
            sendResponse({ success: true, updated: null });
          }
        })().catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'RUNWAY_TEST_UPLOAD':
        // 不花钱：只走 4 步上传链，不调 /v1/tasks。验证 S3 PUT + dataset 注册
        // 用一张 1x1 透明 PNG 做测试，避免污染你的 Runway 资产库
        (async () => {
          const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
          const bin = atob(tinyPngBase64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const blob = new Blob([arr], { type: 'image/png' });
          return runwaySubmitter.uploadAsset(blob, `test-${Date.now()}.png`);
        })()
          .then((result) => sendResponse({ success: true, result }))
          .catch((error) => sendResponse({ success: false, error: error.message, code: error.code, status: error.status }));
        return true;

      default:
        sendResponse({ error: 'Unknown message type' });
        return false;
    }
  }

  /**
   * 处理拦截到的 API
   */
  async handleApiIntercepted(msg, sender) {
    const { platform, url, method, requestData, responseData } = msg;
    const monitor = registry.getAllMonitors().find(m => m.name === platform);
    const context = this.getSenderContext(msg, sender);

    if (!monitor) {
      console.error(`[后台] 未找到平台: ${platform}`);
      return;
    }

    this.updateTabHeartbeat(context.tabId, {
      platform,
      url: context.pageUrl,
      lastHeartbeat: context.timestamp
    });

    if (platform === '即梦') {
      this.batchManager.cacheJimengRequestContext(url);
      const accountKey = this.extractJimengAccountKey(responseData);
      if (accountKey) {
        this.updateTabHeartbeat(context.tabId, { accountKey });
      }
    }

    if (platform === '即梦' && url.includes('/mweb/v1/aigc_draft/generate')) {
      this.logJimengGenerateDebug(requestData, responseData);
    }

    try {
      // 检测任务提交
      const submitTask = await monitor.detectTaskSubmit(url, method, requestData, responseData);
      if (submitTask) {
        this.addTask(this.attachTaskContext(submitTask, context));
        console.log(`[后台] 新任务: ${platform} - ${submitTask.taskId}`);
      }

      // 检测任务更新
      const updateTasks = await monitor.detectTaskUpdate(url, method, requestData, responseData);
      if (updateTasks) {
        const tasks = Array.isArray(updateTasks) ? updateTasks : [updateTasks];
        tasks.forEach(task => this.updateTask(this.attachTaskContext(task, context)));
      }
    } catch (error) {
      console.error(`[后台] 处理 ${platform} API 失败:`, error);
    }
  }

  logJimengGenerateDebug(requestData, responseData) {
    try {
      const draftContent = typeof requestData?.draft_content === 'string'
        ? JSON.parse(requestData.draft_content)
        : requestData?.draft_content;
      const component = draftContent?.component_list?.[0] || {};
      const genVideo = component?.abilities?.gen_video || {};
      const textParams = genVideo?.text_to_video_params || {};
      const firstInput = textParams?.video_gen_inputs?.[0] || {};
      const videoRefParams = genVideo?.video_ref_params || {};

      const summary = {
        extend: requestData?.extend || null,
        submitId: requestData?.submit_id || null,
        modelReqKey: textParams?.model_req_key || null,
        aspectRatio: textParams?.video_aspect_ratio || null,
        durationMs: firstInput?.duration_ms || null,
        videoMode: firstInput?.video_mode || null,
        hasFirstFrame: Boolean(firstInput?.first_frame_image?.image_uri),
        hasLastFrame: Boolean(firstInput?.last_frame_image?.image_uri),
        prompt: firstInput?.prompt || null,
        videoRefGenerateType: videoRefParams?.generate_type ?? null,
        abilityListCount: Array.isArray(videoRefParams?.ability_list) ? videoRefParams.ability_list.length : 0,
        placeholderCount: Array.isArray(videoRefParams?.prompt_placeholder_info_list) ? videoRefParams.prompt_placeholder_info_list.length : 0,
        response: responseData ? {
          ret: responseData.ret ?? null,
          errmsg: responseData.errmsg ?? null,
          logid: responseData.logid ?? null
        } : null
      };

      console.log('[即梦调试] generate request summary:', summary);
      chrome.storage.local.set({ lastJimengGenerateDebug: summary });
    } catch (error) {
      console.warn('[即梦调试] 解析 generate 请求失败:', error);
    }
  }

  getSenderContext(msg, sender) {
    return {
      tabId: sender?.tab?.id ?? null,
      pageUrl: sender?.tab?.url || msg.url || null,
      timestamp: msg.timestamp || Date.now()
    };
  }

  attachTaskContext(task, context) {
    const currentTabState = context.tabId !== null && context.tabId !== undefined
      ? this.tabHeartbeat.get(context.tabId)
      : null;

    return {
      ...task,
      accountKey: task.accountKey || currentTabState?.accountKey || '',
      monitorTabId: context.tabId ?? task.monitorTabId ?? null,
      monitorPageUrl: context.pageUrl || task.monitorPageUrl || null,
      lastSeenAt: context.timestamp
    };
  }

  recordHeartbeat(msg, sender) {
    this.lastHeartbeat.set(msg.platform, msg.timestamp);

    const context = this.getSenderContext(msg, sender);
    this.updateTabHeartbeat(context.tabId, {
      platform: msg.platform,
      url: msg.url || context.pageUrl,
      lastHeartbeat: msg.timestamp
    });
  }

  updateTabHeartbeat(tabId, updates) {
    if (tabId === null || tabId === undefined) {
      return;
    }

    const existing = this.tabHeartbeat.get(tabId) || {
      lastRefreshAt: 0
    };

    this.tabHeartbeat.set(tabId, {
      ...existing,
      ...updates
    });
  }

  async getVisibleTasks() {
    const allTasks = this.getTasksArray();
    const jimengTab = await this.batchManager.findVisibleJimengTab();
    if (!jimengTab?.id) {
      return allTasks;
    }

    const nonJimengTasks = allTasks.filter(task => task.platform !== '即梦');
    const jimengTasks = allTasks.filter(task => task.platform === '即梦');
    const sameTabTasks = jimengTasks.filter(task => task.monitorTabId === jimengTab.id);

    if (sameTabTasks.length > 0) {
      return [...sameTabTasks, ...nonJimengTasks].sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
    }

    const activeAccountKey = jimengTab?.id !== undefined
      ? this.tabHeartbeat.get(jimengTab.id)?.accountKey || ''
      : '';

    if (!activeAccountKey) {
      return [...jimengTasks, ...nonJimengTasks].sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
    }

    const matchedTasks = jimengTasks.filter((task) => task.accountKey === activeAccountKey);
    if (matchedTasks.length > 0) {
      return [...matchedTasks, ...nonJimengTasks].sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
    }

    return [...jimengTasks, ...nonJimengTasks].sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
  }

  extractJimengAccountKey(payload) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    const candidates = [
      payload.uid,
      payload.user_id,
      payload.userId,
      payload.account_id,
      payload.accountId,
      payload.data?.uid,
      payload.data?.user_id,
      payload.data?.userId,
      payload.data?.account_id,
      payload.data?.accountId,
      payload.data?.user_info?.uid,
      payload.data?.user_info?.user_id,
      payload.data?.account_info?.uid,
      payload.data?.account_info?.user_id
    ].filter(Boolean);

    return candidates.length > 0 ? String(candidates[0]) : '';
  }

  /**
   * 添加新任务
   */
  addTask(task) {
    const key = `${task.platform}_${task.taskId}`;
    const existingTask = this.tasks.get(key);

    if (existingTask) {
      // 任务已存在，更新信息
      this.updateTask(task);
      return;
    }

    this.tasks.set(key, {
      ...task,
      addedAt: Date.now(),
      lastUpdate: Date.now(),
      notified: false,
      staleNotifiedAt: 0,
      autoRefreshAttempts: task.autoRefreshAttempts || 0,
      lastAutoRefreshAt: task.lastAutoRefreshAt || 0
    });

    if (task.platform === '即梦' && task.monitorTabId !== null && task.monitorTabId !== undefined && task.accountKey) {
      this.updateTabHeartbeat(task.monitorTabId, {
        accountKey: task.accountKey
      });
    }

    this.saveTasks();
    this.updateBadge();

    // 显示任务添加通知
    chrome.notifications.create(key, {
      type: 'basic',
      iconUrl: 'assets/icon-128.png',
      title: `📝 ${task.platform} 新任务`,
      message: `任务已开始监控\n${task.queuePosition ? `排队位置: 第 ${task.queuePosition} 位` : ''}`,
      priority: 0
    });
  }

  /**
   * 更新任务
   */
  updateTask(task) {
    const key = `${task.platform}_${task.taskId}`;
    const existing = this.tasks.get(key);

    if (!existing) {
      // 任务不存在，可能是页面刷新前的任务，添加它
      this.addTask(task);
      return;
    }

    const previousStatus = existing.status;
    const incomingPriority = Number(task.statusPriority ?? 0);
    const existingPriority = Number(existing.statusPriority ?? 0);
    const shouldPreserveExistingStatus = (
      existing.platform === '即梦' &&
      existingPriority > incomingPriority
    );

    const mergedTask = shouldPreserveExistingStatus
      ? {
          ...task,
          status: existing.status,
          statusPriority: existing.statusPriority,
          error: existing.error || task.error,
          videoUrl: existing.videoUrl || task.videoUrl,
          thumbnailUrl: existing.thumbnailUrl || task.thumbnailUrl,
          finishTime: existing.finishTime || task.finishTime
        }
      : task;

    const newStatus = mergedTask.status;

    // 更新任务信息
    this.tasks.set(key, {
      ...existing,
      ...mergedTask,
      lastUpdate: Date.now(),
      addedAt: existing.addedAt, // 保留原始添加时间
      staleNotifiedAt: mergedTask.staleNotifiedAt ?? existing.staleNotifiedAt ?? 0,
      autoRefreshAttempts: mergedTask.autoRefreshAttempts ?? existing.autoRefreshAttempts ?? 0,
      lastAutoRefreshAt: mergedTask.lastAutoRefreshAt ?? existing.lastAutoRefreshAt ?? 0
    });

    if (mergedTask.platform === '即梦' && mergedTask.monitorTabId !== null && mergedTask.monitorTabId !== undefined && mergedTask.accountKey) {
      this.updateTabHeartbeat(mergedTask.monitorTabId, {
        accountKey: mergedTask.accountKey
      });
    }

    this.saveTasks();

    this.batchManager.syncTaskFromMonitor(mergedTask).catch((error) => {
      console.warn('[后台] 同步批量任务状态失败:', error);
    });

    // 检测状态变化
    if (previousStatus !== newStatus) {
      console.log(`[后台] 任务状态变化: ${key} ${previousStatus} -> ${newStatus}`);

      if (newStatus === 'completed' && !existing.notified) {
        this.notifyTaskComplete(task);
      } else if (newStatus === 'failed') {
        this.notifyTaskFailed(task);
      }
    }

    // 检测排队位置倒退
    if (task.queuePosition && existing.queuePosition) {
      const regression = task.queuePosition - existing.queuePosition;
      if (regression > 100) {
        this.notifyQueueRegression(task, existing.queuePosition, task.queuePosition);
      }
    }

    this.updateBadge();
  }

  /**
   * 通知任务完成
   */
  notifyTaskComplete(task) {
    const key = `${task.platform}_${task.taskId}`;
    const taskData = this.tasks.get(key);

    if (taskData) {
      taskData.notified = true;
      this.tasks.set(key, taskData);
      this.saveTasks();
    }

    chrome.notifications.create(key + '_complete', {
      type: 'basic',
      iconUrl: 'assets/icon-128.png',
      title: `🎬 ${task.platform} 视频生成完成！`,
      message: task.prompt || `任务 ${task.taskId} 已完成`,
      priority: 2,
      requireInteraction: true,
      buttons: [
        { title: '查看视频' },
        { title: '关闭' }
      ]
    });

    // 播放提示音
    this.playSound();

    console.log(`[后台] 任务完成通知: ${key}`);
  }

  /**
   * 通知任务失败
   */
  notifyTaskFailed(task) {
    chrome.notifications.create(`${task.platform}_${task.taskId}_failed`, {
      type: 'basic',
      iconUrl: 'assets/icon-128.png',
      title: `❌ ${task.platform} 任务失败`,
      message: `任务 ${task.taskId} 生成失败`,
      priority: 1
    });
  }

  /**
   * 通知排队位置倒退
   */
  notifyQueueRegression(task, oldPosition, newPosition) {
    chrome.notifications.create(`${task.platform}_${task.taskId}_regression`, {
      type: 'basic',
      iconUrl: 'assets/icon-128.png',
      title: `⚠️ ${task.platform} 排队位置倒退`,
      message: `从第 ${oldPosition} 位倒退到第 ${newPosition} 位`,
      priority: 1
    });
  }

  /**
   * 播放提示音
   */
  async playSound() {
    try {
      await this.ensureOffscreenAudioDocument();
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAY_SOUND' });
      this.scheduleOffscreenClose();
    } catch (error) {
      console.error('[后台] 播放声音失败:', error);
    }
  }

  async ensureOffscreenAudioDocument() {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
      });
      if (Array.isArray(contexts) && contexts.length > 0) {
        return;
      }
    }

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: '播放任务完成提示音'
      });
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!message.includes('Only a single offscreen document may be created')) {
        throw error;
      }
    }
  }

  scheduleOffscreenClose() {
    if (this.offscreenCloseTimer) {
      clearTimeout(this.offscreenCloseTimer);
    }

    this.offscreenCloseTimer = setTimeout(async () => {
      this.offscreenCloseTimer = null;
      try {
        await chrome.offscreen.closeDocument();
      } catch (error) {
        const message = String(error?.message || error || '');
        if (!message.includes('No current offscreen document')) {
          console.warn('[后台] 关闭 offscreen 文档失败:', error);
        }
      }
    }, 2500);
  }

  /**
   * 处理通知点击
   */
  handleNotificationClick(notificationId) {
    // 提取任务信息
    const [platform, taskId] = notificationId.split('_');
    const key = `${platform}_${taskId}`;
    const task = this.tasks.get(key);

    if (task && task.videoUrl) {
      chrome.tabs.create({ url: task.videoUrl });
    }
  }

  /**
   * 处理通知按钮点击
   */
  handleNotificationButtonClick(notificationId, buttonIndex) {
    if (buttonIndex === 0) {
      // "查看视频" 按钮
      this.handleNotificationClick(notificationId);
    }
    // buttonIndex === 1 是 "关闭" 按钮，不需要处理
  }

  /**
   * 更新扩展图标角标
   */
  updateBadge() {
    const pending = Array.from(this.tasks.values()).filter(
      t => !['completed', 'failed', 'cancelled'].includes(t.status)
    );

    if (pending.length > 0) {
      chrome.action.setBadgeText({ text: pending.length.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#FFA500' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  }

  /**
   * 保存任务到存储
   */
  async saveTasks() {
    const MAX_HISTORY = 300;
    if (this.tasks.size > MAX_HISTORY) {
      const activeStatuses = ['pending', 'preparing', 'queuing', 'generating'];
      const activeEntries = [];
      const historyEntries = [];
      
      for (const [id, task] of this.tasks.entries()) {
        if (activeStatuses.includes(task.status)) {
          activeEntries.push([id, task]);
        } else {
          historyEntries.push([id, task]);
        }
      }
      
      if (historyEntries.length > MAX_HISTORY) {
        historyEntries.sort((a, b) => (a[1].lastUpdate || 0) - (b[1].lastUpdate || 0));
        const entriesToKeep = historyEntries.slice(-MAX_HISTORY);
        this.tasks = new Map([...activeEntries, ...entriesToKeep]);
        console.log(`[后台] 监控任务数超出上限，已自动截断历史旧任务，回收本地内存。`);
      }
    }

    const tasksObj = Object.fromEntries(this.tasks);
    await chrome.storage.local.set({ tasks: tasksObj });
  }

  /**
   * 获取任务数组
   */
  getTasksArray() {
    return Array.from(this.tasks.values()).sort((a, b) => b.lastUpdate - a.lastUpdate);
  }

  scheduleJimengTaskSync({ force = false } = {}) {
    const now = Date.now();
    if (this.jimengSyncPromise) {
      return this.jimengSyncPromise;
    }

    if (!force && now - this.lastJimengSyncAt < JIMENG_SYNC_MIN_INTERVAL_MS) {
      return Promise.resolve(null);
    }

    this.jimengSyncPromise = (async () => {
      try {
        await this.syncJimengTaskStates();
      } finally {
        this.lastJimengSyncAt = Date.now();
        this.jimengSyncPromise = null;
      }
    })();

    return this.jimengSyncPromise;
  }

  async syncJimengTaskStates() {
    const jimengTasks = Array.from(this.tasks.values()).filter(task =>
      task.platform === '即梦' && task.taskId
    );

    if (jimengTasks.length === 0) {
      return;
    }

    const monitor = registry.getAllMonitors().find(item => item.name === '即梦');
    if (!monitor) {
      return;
    }

    const historyIds = [...new Set(jimengTasks.map(task => String(task.taskId)))];
    const syncedTaskIds = new Set();

    try {
      const assetUpdates = await this.fetchJimengAssetListUpdates(monitor, historyIds);
      assetUpdates.forEach((task) => {
        syncedTaskIds.add(String(task.taskId));
        this.updateTask(task);
      });
    } catch (error) {
      console.warn('[后台] 拉取即梦资产列表失败，回退旧接口:', error);
    }

    const missingIds = historyIds.filter(taskId => !syncedTaskIds.has(taskId));
    if (missingIds.length === 0) {
      return;
    }

    const responseData = await this.batchManager.executeJimengMonitorPageRequest(
      '/mweb/v1/get_history_by_ids',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history_ids: missingIds })
      }
    );

    const updates = await monitor.detectTaskUpdate(
      'https://jimeng.jianying.com/mweb/v1/get_history_by_ids',
      'POST',
      { history_ids: missingIds },
      responseData
    );

    if (!updates) {
      return;
    }

    const tasks = Array.isArray(updates) ? updates : [updates];
    tasks.forEach(task => this.updateTask(task));
  }

  async fetchJimengAssetListUpdates(monitor, historyIds) {
    const targetIds = new Set(historyIds.map(id => String(id)));
    const collected = new Map();
    let endTimeStamp = 0;

    for (let page = 0; page < 5 && collected.size < targetIds.size; page += 1) {
      const requestBody = this.batchManager.buildJimengAssetListRequest(endTimeStamp);
      const responseData = await this.batchManager.executeJimengMonitorPageRequest(
        '/mweb/v1/get_asset_list',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );

      const updates = await monitor.detectTaskUpdate(
        'https://jimeng.jianying.com/mweb/v1/get_asset_list',
        'POST',
        requestBody,
        responseData
      );

      const tasks = Array.isArray(updates) ? updates : (updates ? [updates] : []);
      tasks.forEach((task) => {
        if (targetIds.has(String(task.taskId))) {
          collected.set(String(task.taskId), task);
        }
      });

      const hasMore = Boolean(responseData?.data?.has_more);
      const nextOffset = Number(responseData?.data?.next_offset || 0);
      if (!hasMore || !nextOffset || nextOffset === endTimeStamp) {
        break;
      }
      endTimeStamp = nextOffset;
    }

    return Array.from(collected.values());
  }

  /**
   * 清理已完成的任务
   */
  clearCompletedTasks() {
    for (const [key, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(key);
      }
    }
    this.saveTasks();
    this.updateBadge();
    console.log('[后台] 已清理完成的任务');
  }

  /**
   * 启动定期检查
   */
  startPeriodicCheck() {
    // 每 5 分钟检查一次失联任务
    chrome.alarms.create('checkStaleTasks', {
      periodInMinutes: 5
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'checkStaleTasks') {
        this.checkStaleTasks().catch((error) => {
          console.error('[后台] 失联检查失败:', error);
        });
      }
    });
  }

  /**
   * 检查失联任务
   */
  async checkStaleTasks() {
    const now = Date.now();
    const settings = await this.getMonitorSettings();
    const staleThreshold = settings.staleMinutes * 60 * 1000;
    const handledTabs = new Set();
    const handledPlatformsWithoutTab = new Set();

    for (const [key, task] of this.tasks) {
      if (!this.isTaskActive(task) || now - task.lastUpdate <= staleThreshold) {
        continue;
      }

      const recoveryTab = await this.findRecoveryTab(task);
      const heartbeatAge = this.getHeartbeatAge(task, recoveryTab, now);

      if (heartbeatAge <= staleThreshold) {
        continue;
      }

      console.warn(`[后台] 任务可能失联: ${key}`);

      if (recoveryTab?.id && handledTabs.has(recoveryTab.id)) {
        continue;
      }

      if (!recoveryTab?.id && handledPlatformsWithoutTab.has(task.platform)) {
        continue;
      }

      const refreshed = settings.autoRefreshEnabled
        ? await this.tryAutoRefreshTab(task, recoveryTab, settings, now)
        : false;

      if (recoveryTab?.id && refreshed) {
        handledTabs.add(recoveryTab.id);
        continue;
      }

      await this.notifyStaleTask(task, settings, recoveryTab, now);
      if (recoveryTab?.id) {
        handledTabs.add(recoveryTab.id);
      } else {
        handledPlatformsWithoutTab.add(task.platform);
      }
    }
  }

  async getMonitorSettings() {
    const { monitorSettings } = await chrome.storage.local.get(['monitorSettings']);
    return {
      ...this.defaultMonitorSettings,
      ...(monitorSettings || {})
    };
  }

  isTaskActive(task) {
    return task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled';
  }

  async findRecoveryTab(task) {
    const monitor = registry.getAllMonitors().find(item => item.name === task.platform);
    const expectedDomain = monitor?.domain;

    if (task.monitorTabId !== null && task.monitorTabId !== undefined) {
      try {
        const tab = await chrome.tabs.get(task.monitorTabId);
        if (!expectedDomain || tab.url?.includes(expectedDomain)) {
          return tab;
        }
      } catch (error) {
        console.warn('[后台] 监控标签页不存在，尝试回退查找:', task.monitorTabId);
      }
    }

    if (!expectedDomain) {
      return null;
    }

    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url?.includes(expectedDomain)) || null;
  }

  getHeartbeatAge(task, tab, now) {
    const tabHeartbeat = tab?.id !== undefined ? this.tabHeartbeat.get(tab.id) : null;
    const lastHeartbeat = tabHeartbeat?.lastHeartbeat || (!tab ? this.lastHeartbeat.get(task.platform) : null);
    if (!lastHeartbeat) {
      return Number.POSITIVE_INFINITY;
    }

    return now - lastHeartbeat;
  }

  async tryAutoRefreshTab(task, tab, settings, now) {
    if (!tab?.id) {
      return false;
    }

    const tabState = this.tabHeartbeat.get(tab.id) || { lastRefreshAt: 0 };
    const cooldownMs = settings.refreshCooldownMinutes * 60 * 1000;

    if (tabState.lastRefreshAt && now - tabState.lastRefreshAt < cooldownMs) {
      return false;
    }

    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTabs.some(activeTab => activeTab.id === tab.id)) {
      return false;
    }

    try {
      await chrome.tabs.reload(tab.id);

      this.updateTabHeartbeat(tab.id, {
        platform: task.platform,
        url: tab.url,
        lastRefreshAt: now
      });

      this.markTasksForAutoRefresh(tab.id, now);

      chrome.notifications.create(`${task.platform}_${task.taskId}_auto_refresh`, {
        type: 'basic',
        iconUrl: 'assets/icon-128.png',
        title: `🔄 ${task.platform} 页面自动恢复`,
        message: '检测到监控页面失联，已尝试自动刷新恢复监控',
        priority: 1
      });

      return true;
    } catch (error) {
      console.error('[后台] 自动刷新失败:', error);
      return false;
    }
  }

  markTasksForAutoRefresh(tabId, timestamp) {
    for (const [key, task] of this.tasks) {
      if (task.monitorTabId !== tabId) {
        continue;
      }

      this.tasks.set(key, {
        ...task,
        autoRefreshAttempts: (task.autoRefreshAttempts || 0) + 1,
        lastAutoRefreshAt: timestamp,
        staleNotifiedAt: timestamp
      });
    }

    this.saveTasks();
  }

  async notifyStaleTask(task, settings, tab, now) {
    const key = `${task.platform}_${task.taskId}`;
    const taskData = this.tasks.get(key);
    const cooldownMs = settings.refreshCooldownMinutes * 60 * 1000;

    if (taskData?.staleNotifiedAt && now - taskData.staleNotifiedAt < cooldownMs) {
      return;
    }

    const autoRefreshLabel = settings.autoRefreshEnabled
      ? '自动恢复未执行，请检查页面是否前台打开或稍后手动刷新'
      : '请检查页面是否打开，或在弹窗中开启自动恢复';

    chrome.notifications.create(key + '_stale', {
      type: 'basic',
      iconUrl: 'assets/icon-128.png',
      title: `⚠️ ${task.platform} 监控异常`,
      message: `任务已 ${settings.staleMinutes} 分钟无更新，${autoRefreshLabel}`,
      priority: 1
    });

    if (taskData) {
      this.tasks.set(key, {
        ...taskData,
        staleNotifiedAt: now,
        monitorTabId: tab?.id ?? taskData.monitorTabId ?? null,
        monitorPageUrl: tab?.url || taskData.monitorPageUrl || null
      });
      await this.saveTasks();
    }
  }
}

// 启动任务管理器
const taskManager = new TaskManager();

console.log('[后台] Service Worker 已启动');

// ─── chrome.webRequest 凭证抓取（可靠版，绕过页面 CSP/wrapper） ───
// 监听所有 api.runwayml.com 出去的请求，从 Authorization 头抓 JWT，从 URL query 抓 teamId
// 这是 page-harvester 的双保险——只要 Runway 页面发任何 API 请求，就能拿到凭证
(() => {
  if (!chrome.webRequest?.onBeforeSendHeaders) {
    console.warn('[Runway WebRequest] webRequest API 不可用');
    return;
  }

  let lastJwt = null;
  let lastTeamId = null;
  let lastClientId = null;
  let lastVersion = null;
  let pendingDiscover = false;
  let pendingTeamDiscover = false;

  // 主动发现：调 /v1/teams 拿真正的 teamId（个人账号的 -1 占位符不能用）
  const discoverTeamId = async (jwt) => {
    if (pendingTeamDiscover) return null;
    pendingTeamDiscover = true;
    try {
      const ctx = await getRunwayContext();
      if (ctx.teamId && ctx.teamId > 0) return ctx.teamId;

      const resp = await fetch('https://api.runwayml.com/v1/teams', {
        headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
      });
      if (!resp.ok) {
        console.warn('[Runway 自动发现] /v1/teams 返回', resp.status);
        return null;
      }
      const data = await resp.json();
      const teams = Array.isArray(data) ? data : (data?.teams || data?.data || []);
      // 过滤掉无效 id（包括 -1）
      const valid = teams.filter(t => Number(t?.id) > 0);
      if (valid.length === 0) {
        console.warn('[Runway 自动发现] /v1/teams 返回空或全是 -1，账号可能没有团队');
        return null;
      }
      const teamId = Number(valid[0].id);
      // 团队变了：把旧的 assetGroupId 清掉，让它跟着新 team 重新发现
      const prev = await getRunwayContext();
      const teamChanged = prev.teamId !== teamId;
      await setRunwayContext({ teamId, ...(teamChanged ? { assetGroupId: null } : {}) });
      lastTeamId = teamId;
      console.log('[Runway 自动发现] teamId =', teamId, '(', valid[0].name || '?', ')',
        teamChanged ? '— 旧 assetGroupId 已清空待重新发现' : '');
      return teamId;
    } catch (err) {
      console.warn('[Runway 自动发现] /v1/teams 失败:', err.message);
      return null;
    } finally {
      pendingTeamDiscover = false;
    }
  };

  // 后台主动调 list 接口拿 assetGroupId
  const discoverAssetGroupId = async (jwt, teamId) => {
    if (pendingDiscover) return;
    pendingDiscover = true;
    try {
      const ctx = await getRunwayContext();
      if (ctx.assetGroupId) { pendingDiscover = false; return; }

      // 带 teamId 优先，没有则不带（兼容个人账号）
      const url = teamId && teamId > 0
        ? `https://api.runwayml.com/v1/asset_groups?asTeamId=${teamId}`
        : `https://api.runwayml.com/v1/asset_groups`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/json' }
      });
      if (!resp.ok) {
        // 401/403 是常见的——这个端点权限模型跟前端不一样。不致命，page-harvester 兜底从页面抓 assetGroupId
        if (resp.status !== 401 && resp.status !== 403) {
          console.warn('[Runway 自动发现] /v1/asset_groups 返回', resp.status);
        }
        return;
      }
      const data = await resp.json();
      const groups = Array.isArray(data) ? data : (data?.assetGroups || data?.data || []);
      if (groups.length === 0) {
        // 安静降级：page-harvester 会从页面 POST body / by_name 响应里抓 assetGroupId
        return;
      }
      const preferred = groups.find(g =>
        /user|library|default|my.?files|我的/i.test(g.name || '')
      ) || groups[0];
      if (preferred?.id) {
        await setRunwayContext({ assetGroupId: preferred.id });
        console.log('[Runway 自动发现] assetGroupId =', preferred.id, '(', preferred.name, ')');
      }
    } catch (err) {
      console.warn('[Runway 自动发现] 失败:', err.message);
    } finally {
      pendingDiscover = false;
    }
  };

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        // 抓 JWT
        const authHeader = details.requestHeaders?.find(
          h => h.name.toLowerCase() === 'authorization'
        );
        const auth = authHeader?.value;
        let newJwt = null;
        if (auth && auth.startsWith('Bearer ')) {
          newJwt = auth.slice(7).trim();
        }

        // 抓 teamId —— 过滤掉 Runway 的 -1 占位符（"个人无团队"，POST 时会被拒）
        let newTeamId = null;
        try {
          const u = new URL(details.url);
          const t = u.searchParams.get('asTeamId');
          const tNum = Number(t);
          if (t && tNum > 0) newTeamId = tNum;
        } catch {}

        // 抓官方 web 端的指纹头：X-Runway-Client-Id / X-Runway-Source-Application-Version
        // 我们脚本调用必须带这两个头，否则后端一眼能识别为 bot
        let newClientId = null;
        let newVersion = null;
        for (const h of (details.requestHeaders || [])) {
          const name = h.name.toLowerCase();
          if (name === 'x-runway-client-id' && h.value) newClientId = h.value;
          else if (name === 'x-runway-source-application-version' && h.value) newVersion = h.value;
        }

        // 有变化才落库
        const updates = {};
        if (newJwt && newJwt !== lastJwt) {
          lastJwt = newJwt;
          setRunwayJwt(newJwt).catch(() => {});
          updates.jwt = newJwt.slice(0, 20) + '…';
        }
        if (newTeamId && newTeamId !== lastTeamId) {
          lastTeamId = newTeamId;
          setRunwayContext({ teamId: newTeamId }).catch(() => {});
          updates.teamId = newTeamId;
        }
        const fpPatch = {};
        if (newClientId && newClientId !== lastClientId) {
          lastClientId = newClientId;
          fpPatch.clientId = newClientId;
          updates.clientId = newClientId.slice(0, 8) + '…';
        }
        if (newVersion && newVersion !== lastVersion) {
          lastVersion = newVersion;
          fpPatch.version = newVersion;
          updates.version = newVersion.slice(0, 10) + '…';
        }
        if (Object.keys(fpPatch).length > 0) {
          setRunwayFingerprint(fpPatch).catch(() => {});
        }
        if (Object.keys(updates).length > 0) {
          console.log('[Runway WebRequest] 凭证已更新:', updates);
        }

        // JWT 到位后，先主动发现 teamId（如果还没有有效的）
        if (lastJwt && !lastTeamId) {
          discoverTeamId(lastJwt).then((teamId) => {
            if (teamId && lastJwt) discoverAssetGroupId(lastJwt, teamId);
          });
        } else if (lastJwt) {
          // teamId 已有，发现 assetGroupId（如果还没）
          discoverAssetGroupId(lastJwt, lastTeamId);
        }
      } catch (err) {
        console.warn('[Runway WebRequest] 处理出错:', err);
      }
    },
    { urls: ['*://api.runwayml.com/*'] },
    ['requestHeaders']
  );

  console.log('[Runway WebRequest] 凭证监听器已就位');
})();
