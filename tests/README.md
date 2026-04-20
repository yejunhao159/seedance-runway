# 测试

Chrome 扩展 MV3 · 单元测试套件 · Vitest + fake-indexeddb + happy-dom

## 跑起来

```bash
cd ShopLoopAI-v1.0.9
npm install          # 只装 devDeps（vitest / fake-indexeddb / happy-dom），不影响扩展运行
npm test             # 单次跑
npm run test:watch   # 监听模式
npm run coverage     # 覆盖率报告（开 coverage/index.html）
```

## 覆盖范围

| 模块 | 测试文件 | 重点 |
|---|---|---|
| `core/error-classifier.js` | `tests/unit/error-classifier.test.js` | 错误分 6 类，每类命中条件 |
| `core/moderation.js` | `tests/unit/moderation.test.js` | 敏感词 + 用户自定义词 + 图片预检 |
| `core/error-log.js` | `tests/unit/error-log.test.js` | IndexedDB 写/读/过滤/导出/脱敏 |
| `platforms/runway/transport.js` | `tests/unit/transport-retry.test.js` | S3 上传退避重试 |

## 不在单元测试里的（手动 smoke）

- 图片压缩（需要真 Canvas / OffscreenCanvas，Node 里 polyfill 不稳）
- UI 渲染（sidepanel 错误卡片 / add_task 预审面板）
- Worker 生命周期
- 真实 Runway / 即梦交互

装进 Chrome 后走一遍这个清单：

1. 选 `tests/fixtures/large-image.png`（5.5MB）→ DevTools 看到 `[compress] xxx: 5.2MB → <800KB`
2. prompt 写 "Elon Musk 在舞台上表演魔术" → 提交时弹预审面板
3. 故意断网后提交 → 任务卡片显示"图片上传失败"+三个按钮
4. 点"查看错误日志"→ 跳 settings.html 看到这条记录
5. 设置页 → 敏感词预审 → 自定义分类加一个"玛莎拉蒂"→ prompt 含此词被拦
6. 设置页 → 错误日志 → 导出 JSON → 检查是否可打开

## 设计原则

- **只测纯函数和 IndexedDB 逻辑**，不测 UI（ROI 低）
- **chrome API 最小 mock**（`tests/setup.js`），只 mock 真用到的 `storage.local`
- **时间快进**：`vi.useFakeTimers()` 跳过 1s/3s/7s 退避等待
- **每个测试独立**：`beforeEach` 清 storage / clearLogs
