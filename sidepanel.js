/**
 * ShopLoop AI 主控台（Side Panel） - Operations Terminal
 *
 * 职责：
 *   1. 显示双平台任务列表（即梦 + Runway）
 *   2. 显示平台健康（in-progress / 上限）
 *   3. 挂机模式开关 (Autopilot)
 *   4. 添加任务 / 启动 / 暂停 / 清空
 *
 * 数据流：
 *   - 主动每 2.5 秒轮询 GET_BATCH_TASKS + GET_PLATFORM_HEALTH
 *   - chrome.storage.onChanged 监听 batchTasks，立即刷新
 */

import { classifyError } from './core/error-classifier.js';

const STATE = {
  filterPlatform: 'all',
  filterStatusList: 'all',
  tasks: [],
  health: { jimeng: { running: 0, limit: 3 }, runway: { running: 0, limit: 2 } },
  autoRun: false,
  pollTimer: null
};

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

function toast(message, durationMs = 1800) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), durationMs);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad2(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  return v < 10 ? `0${v}` : String(v);
}

// ─── 渲染 ─────────────────────────────────────────────────

function renderHealth() {
  const j = STATE.health.jimeng || {};
  const r = STATE.health.runway || {};
  $('jimengStat').innerHTML = `${pad2(j.running)}<span class="sep">/</span><span class="limit">${pad2(j.limit)}</span>`;
  $('runwayStat').innerHTML = `${pad2(r.running)}<span class="sep">/</span><span class="limit">${pad2(r.limit)}</span>`;
  // Runway 当日计数（80/天风控）
  const dailyEl = $('runwayDaily');
  if (dailyEl && r.dailyCap) {
    dailyEl.textContent = `今日 ${r.dailyCount}/${r.dailyCap}`;
    dailyEl.classList.toggle('cap', !!r.dailyCapReached);
  }
}

function renderAutoRun() {
  $('autoRunToggle').checked = STATE.autoRun;
  const label = $('autoRunLabel');
  const text = $('autoRunText');
  if (STATE.autoRun) {
    label.classList.add('on');
    text.textContent = '运行中';
  } else {
    label.classList.remove('on');
    text.textContent = '待机';
  }
}

function statusLabel(status) {
  const map = {
    pending: '待提交',
    uploading: '上传中',
    submitting: '提交中',
    queued: '排队',
    generating: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消'
  };
  return map[status] || status;
}

function platformLabel(platformId) {
  return platformId === 'runway' ? 'Runway' : '即梦';
}

function isActiveStatus(status) {
  return status === 'generating' || status === 'queued' || status === 'uploading' || status === 'submitting';
}

function renderTasks() {
  const list = $('taskList');

  // 过滤
  const filtered = STATE.tasks.filter((t) => {
    const p = t.platform || 'jimeng';
    if (STATE.filterPlatform !== 'all' && p !== STATE.filterPlatform) return false;
    if (STATE.filterStatusList !== 'all') {
      const allowed = STATE.filterStatusList.split(',');
      if (!allowed.includes(t.status)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const msg = STATE.tasks.length === 0 ? '暂无任务' : '当前筛选条件下没有任务';
    list.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  // 排序：未完成在前，按 createdAt 倒序
  const sorted = [...filtered].sort((a, b) => {
    const ad = a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled' ? 1 : 0;
    const bd = b.status === 'completed' || b.status === 'failed' || b.status === 'cancelled' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  list.innerHTML = sorted.map((task) => renderTaskCard(task)).join('');

  // 绑定按钮
  list.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      const taskId = el.dataset.taskId;
      handleTaskAction(action, taskId);
    });
  });
}

function renderTaskCard(task) {
  const platformId = task.platform || 'jimeng';
  const status = task.status || 'pending';

  // 缩略图：如果有视频结果，用视频的 thumbnailUrl；否则用第一张参考图
  let thumbHtml = '<div class="placeholder">◇</div>';
  if (task.thumbnailUrl) {
    thumbHtml = `<img src="${escapeHtml(task.thumbnailUrl)}" alt="">`;
  } else if (task.images?.[0]?.preview) {
    thumbHtml = `<img src="${escapeHtml(task.images[0].preview)}" alt="">`;
  }

  // 进度 / ETA
  let progressHtml = '';
  if (status === 'generating' || status === 'queued') {
    const pct = task.queueInfo?.progress != null ? task.queueInfo.progress : 0;
    progressHtml = `
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-pct">${pct.toString().padStart(2, '0')}%</span>
    `;
  } else if (status === 'queued' && task.queueInfo?.estimatedTimeToStartSeconds) {
    progressHtml = `<span class="task-eta">预计 ${task.queueInfo.estimatedTimeToStartSeconds}s 后开始</span>`;
  }

  // 操作按钮
  const actions = [];
  if (status === 'completed' && task.videoUrl) {
    actions.push(`<a href="${escapeHtml(task.videoUrl)}" target="_blank" rel="noopener">↓ 下载</a>`);
  }
  if (status === 'failed' || status === 'cancelled') {
    actions.push(`<button data-action="retry" data-task-id="${task.id}">重试</button>`);
  }
  if (status === 'pending' || status === 'failed' || status === 'cancelled' || status === 'completed') {
    actions.push(`<button data-action="edit" data-task-id="${task.id}">编辑</button>`);
    actions.push(`<button data-action="delete" data-task-id="${task.id}">删除</button>`);
  }

  // 错误分层展示：用 classifyError 把原始错误转成 { title/message/suggestion/actions }
  let errorHtml = '';
  if (task.error) {
    const cls = classifyError(task.error);
    const severityClass = cls.severity === 'warning' ? 'task-error warn' : 'task-error';
    const actionBtns = cls.actions.map(a => {
      const taskAttr = a.id === 'edit-retry' ? `data-action="edit" data-task-id="${task.id}"` :
                        a.id === 'retry' ? `data-action="retry" data-task-id="${task.id}"` :
                        a.id === 'replace-image' ? `data-action="edit" data-task-id="${task.id}"` :
                        a.id === 'relogin' ? `data-action="open-runway"` :
                        a.id === 'view-log' ? `data-action="open-settings"` : '';
      return `<button class="err-action-btn" ${taskAttr}>${escapeHtml(a.label)}</button>`;
    }).join('');
    errorHtml = `
      <div class="${severityClass}">
        <div class="err-title"><strong>${escapeHtml(cls.title)}</strong></div>
        <div class="err-msg">${escapeHtml(cls.message)}</div>
        <div class="err-hint">${escapeHtml(cls.suggestion)}</div>
        <div class="err-actions">${actionBtns}</div>
      </div>
    `;
  }

  const promptText = task.promptText || task.config?.prompt || '(无提示词)';
  const aspectRatio = task.config?.aspectRatio || '';
  const duration = task.config?.duration || task.config?.durationSeconds || '—';

  const cardClasses = [
    'task-card',
    `platform-${platformId}`,
    isActiveStatus(status) ? 'is-active' : ''
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardClasses}">
      <div class="task-thumb">${thumbHtml}</div>
      <div class="task-body">
        <div class="task-row1">
          <span class="task-platform-tag ${platformId}">${platformLabel(platformId)}</span>
          ${aspectRatio ? `<span>${escapeHtml(aspectRatio)}</span>` : ''}
          <span class="task-meta-sep">·</span>
          <span>${duration}S</span>
        </div>
        <div class="task-prompt">${escapeHtml(promptText)}</div>
        <div class="task-status-row">
          <span class="status-badge status-${status}">${statusLabel(status)}</span>
          ${progressHtml}
        </div>
        ${errorHtml}
        ${actions.length > 0 ? `<div class="task-actions">${actions.join('')}</div>` : ''}
      </div>
    </div>
  `;
}

// ─── 数据加载 ────────────────────────────────────────────

async function loadAll() {
  const [tasksResp, healthResp, autoRunResp] = await Promise.all([
    send({ type: 'GET_BATCH_TASKS' }),
    send({ type: 'GET_PLATFORM_HEALTH' }),
    send({ type: 'GET_AUTO_RUN' })
  ]);

  if (tasksResp?.tasks) STATE.tasks = tasksResp.tasks;
  if (healthResp?.health) STATE.health = healthResp.health;
  if (typeof autoRunResp?.enabled === 'boolean') STATE.autoRun = autoRunResp.enabled;

  renderTasks();
  renderHealth();
  renderAutoRun();
}

function startPolling() {
  if (STATE.pollTimer) clearInterval(STATE.pollTimer);
  STATE.pollTimer = setInterval(loadAll, 2500);
}

// ─── 事件处理 ────────────────────────────────────────────

function handleTaskAction(action, taskId) {
  if (action === 'delete') {
    if (!confirm('确认删除此任务？')) return;
    send({ type: 'DELETE_BATCH_TASK', taskId }).then((r) => {
      if (r.success) { toast('已删除'); loadAll(); }
      else toast('删除失败：' + r.error);
    });
  } else if (action === 'edit' || action === 'retry') {
    chrome.windows.create({
      url: chrome.runtime.getURL(`add_task.html?${action === 'retry' ? 'duplicate' : 'edit'}=${encodeURIComponent(taskId)}`),
      type: 'popup', width: 760, height: 720
    });
  } else if (action === 'open-runway') {
    chrome.tabs.create({ url: 'https://runwayml.com/' });
  } else if (action === 'open-settings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  }
}

function bindEvents() {
  $('addTaskBtn').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('add_task.html'),
      type: 'popup', width: 760, height: 720
    });
  });

  $('refreshBtn').addEventListener('click', () => {
    loadAll().then(() => toast('已刷新'));
  });

  $('settingsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  });

  $('startBtn').addEventListener('click', async () => {
    const r = await send({ type: 'START_BATCH_SUBMIT' });
    if (r?.success) toast('批量任务已启动');
    else toast('启动失败：' + (r?.error || '未知错误'));
    loadAll();
  });

  $('pauseBtn').addEventListener('click', async () => {
    const r = await send({ type: 'PAUSE_BATCH_SUBMIT' });
    if (r?.success) toast('已暂停');
    loadAll();
  });

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('清空所有已完成任务？')) return;
    const r = await send({ type: 'CLEAR_COMPLETED' });
    if (r?.success) { toast('已清空'); loadAll(); }
  });

  $('autoRunToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    const r = await send({ type: 'SET_AUTO_RUN', enabled });
    if (r?.success) {
      STATE.autoRun = r.enabled;
      renderAutoRun();
      toast(enabled ? '挂机模式已开启' : '挂机模式已关闭');
    } else {
      e.target.checked = !enabled;  // 回滚
      toast('切换失败：' + (r?.error || '未知错误'));
    }
  });

  // 筛选
  document.querySelectorAll('[data-filter-platform]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-filter-platform]').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      STATE.filterPlatform = el.dataset.filterPlatform;
      renderTasks();
    });
  });
  document.querySelectorAll('[data-filter-status]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-filter-status]').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      STATE.filterStatusList = el.dataset.filterStatus;
      renderTasks();
    });
  });

  // chrome.storage 变化即时刷新（不依赖轮询）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.batchTasks || changes.autoRunEnabled)) {
      loadAll();
    }
  });
}

// ─── 启动 ────────────────────────────────────────────────

bindEvents();
loadAll();
startPolling();

// ─── Footer 交互（避开 MV3 CSP 对内联 <script> 的禁用） ───

// 风险 / 更新日志 折叠
document.getElementById('riskToggle')?.addEventListener('click', () => {
  document.getElementById('riskPanel')?.classList.toggle('open');
});
document.getElementById('changelogToggle')?.addEventListener('click', () => {
  document.getElementById('changelogPanel')?.classList.toggle('open');
});

// 微信号点击复制
document.querySelectorAll('.credit-copy').forEach((el) => {
  el.addEventListener('click', async () => {
    const wx = el.getAttribute('data-copy');
    if (!wx) return;
    try {
      await navigator.clipboard.writeText(wx);
      const orig = el.textContent;
      el.textContent = '已复制 ✓';
      el.style.color = 'var(--success)';
      setTimeout(() => {
        el.textContent = orig;
        el.style.color = '';
      }, 1200);
    } catch (e) {
      console.warn('复制失败', e);
    }
  });
});
