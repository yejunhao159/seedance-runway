import {
  getUserWords,
  addUserWord,
  removeUserWord,
  resetUserWords
} from './core/moderation.js';
import { DEFAULT_WORDS, CATEGORY_LABEL, CATEGORY_ADVICE } from './core/sensitive-words.js';
import {
  listLogs,
  clearLogs,
  exportLogsAsJson,
  getLogStats
} from './core/error-log.js';

// ─── Tab 切换 ───────────────────────────────────────────

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(`panel-${t.dataset.tab}`).classList.add('active');
    if (t.dataset.tab === 'logs') loadLogsPanel();
  });
});

// ─── 敏感词面板 ─────────────────────────────────────────

async function renderCategories() {
  const container = document.getElementById('categoriesContainer');
  const userWords = await getUserWords();

  const cats = Object.keys(DEFAULT_WORDS);
  if (!cats.includes('custom')) cats.push('custom');

  container.innerHTML = cats.map(cat => {
    const builtIn = DEFAULT_WORDS[cat] || [];
    const custom = userWords[cat] || [];
    const label = CATEGORY_LABEL[cat] || cat;
    const advice = CATEGORY_ADVICE[cat] || '';

    const builtChips = builtIn.map(w =>
      `<span class="chip builtin" title="默认词（不可删除）">${escapeHtml(w)}</span>`
    ).join('');
    const userChips = custom.map(w =>
      `<span class="chip" data-cat="${cat}" data-word="${escapeHtml(w)}">
         ${escapeHtml(w)}<span class="remove" title="删除">×</span>
       </span>`
    ).join('');

    return `
      <div class="category-section">
        <div class="category-header">
          <div class="category-title">${label}</div>
          <div class="category-advice">${escapeHtml(advice)}</div>
        </div>
        <div class="word-chips">${builtChips}${userChips || ''}</div>
        <div class="add-row">
          <input type="text" placeholder="添加到「${label}」分类..." data-add-cat="${cat}">
          <button class="btn" data-add-cat-btn="${cat}">添加</button>
        </div>
      </div>
    `;
  }).join('');

  // 绑定
  container.querySelectorAll('[data-add-cat-btn]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = btn.dataset.addCatBtn;
      const input = container.querySelector(`[data-add-cat="${cat}"]`);
      const word = input.value.trim();
      if (!word) return;
      await addUserWord(cat, word);
      input.value = '';
      renderCategories();
    });
  });
  container.querySelectorAll('.chip .remove').forEach(x => {
    x.addEventListener('click', async () => {
      const chip = x.closest('.chip');
      await removeUserWord(chip.dataset.cat, chip.dataset.word);
      renderCategories();
    });
  });
  container.querySelectorAll('input[data-add-cat]').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const btn = container.querySelector(`[data-add-cat-btn="${input.dataset.addCat}"]`);
        btn?.click();
      }
    });
  });
}

document.getElementById('resetUserWordsBtn').addEventListener('click', async () => {
  if (!confirm('确认清空所有自定义敏感词？默认词表不受影响。')) return;
  await resetUserWords();
  renderCategories();
});

// ─── 错误日志面板 ────────────────────────────────────────

async function loadLogsPanel() {
  const stats = await getLogStats();
  const grid = document.getElementById('statGrid');
  const cats = ['S3_UPLOAD', 'SAFETY_THIRD_PARTY', 'AUTH', 'QUOTA'];
  grid.innerHTML = [
    `<div class="stat-item"><div class="stat-num">${stats.total}</div><div class="stat-label">总错误</div></div>`,
    ...cats.map(c => `<div class="stat-item"><div class="stat-num">${stats.byCategory[c] || 0}</div><div class="stat-label">${categoryShortLabel(c)}</div></div>`)
  ].join('');

  await renderLogs();
}

async function renderLogs() {
  const filter = document.getElementById('logFilter').value;
  const logs = await listLogs({ category: filter || undefined, limit: 200 });
  const list = document.getElementById('logList');
  if (logs.length === 0) {
    list.innerHTML = '<div class="empty">没有错误记录</div>';
    return;
  }

  list.innerHTML = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleString();
    const isWarn = l.category?.startsWith('SAFETY') || l.category === 'QUOTA';
    return `
      <div class="log-entry">
        <div class="log-title">
          <div>
            <span class="log-category ${isWarn ? 'warn' : ''}">${escapeHtml(categoryShortLabel(l.category))}</span>
            <strong>${escapeHtml(l.title)}</strong>
          </div>
          <span style="font-size:11px; color:#888;">${time}</span>
        </div>
        <div class="log-meta">
          平台：${escapeHtml(l.platform || '—')}　·　任务 ID：${escapeHtml(l.taskId || '—')}　·　图片数：${l.imageCount}　·　code：${escapeHtml(l.code || '—')}
        </div>
        ${l.promptPreview ? `<div class="log-preview">💬 ${escapeHtml(l.promptPreview)}${l.promptPreview.length >= 80 ? '...' : ''}</div>` : ''}
        ${l.rawMessage && l.rawMessage !== l.message ? `<div class="log-preview" style="color:#a33;">${escapeHtml(l.rawMessage).slice(0, 200)}</div>` : ''}
      </div>
    `;
  }).join('');
}

document.getElementById('logFilter').addEventListener('change', renderLogs);
document.getElementById('refreshLogsBtn').addEventListener('click', loadLogsPanel);

document.getElementById('exportLogsBtn').addEventListener('click', async () => {
  const blob = await exportLogsAsJson();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shoploop-error-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('clearLogsBtn').addEventListener('click', async () => {
  if (!confirm('确认清空所有错误日志？此操作不可恢复。')) return;
  await clearLogs();
  loadLogsPanel();
});

// ─── Helpers ─────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function categoryShortLabel(cat) {
  const map = {
    S3_UPLOAD: '上传失败',
    SAFETY_THIRD_PARTY: '第三方审核',
    SAFETY_ASIMOV: 'Asimov 审核',
    AUTH: '鉴权失败',
    QUOTA: '配额/并发',
    NETWORK: '网络',
    UNKNOWN: '未知'
  };
  return map[cat] || cat || '—';
}

// 启动
renderCategories();
