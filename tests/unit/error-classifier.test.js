import { describe, it, expect } from 'vitest';
import { classifyError, formatShortError, ERROR_CATEGORIES } from '../../core/error-classifier.js';

describe('classifyError', () => {
  it('识别 Runway SAFETY.INPUT.THIRD_PARTY（图2 实测 reason）', () => {
    const err = { reason: 'SAFETY.INPUT.THIRD_PARTY', message: 'blocked by moderation' };
    const r = classifyError(err);
    expect(r.category).toBe(ERROR_CATEGORIES.SAFETY_THIRD_PARTY);
    expect(r.severity).toBe('warning');
    expect(r.title).toContain('第三方审核');
    expect(r.actions.some(a => a.id === 'edit-retry')).toBe(true);
  });

  it('识别 SAFETY.OUTPUT.THIRD_PARTY（生成结果被拦）', () => {
    const r = classifyError({ reason: 'SAFETY.OUTPUT.THIRD_PARTY', message: 'x' });
    expect(r.category).toBe(ERROR_CATEGORIES.SAFETY_THIRD_PARTY);
    expect(r.title).toContain('生成结果被审核拦截');
  });

  it('识别 SAFETY.ASIMOV', () => {
    const r = classifyError({ reason: 'SAFETY.INPUT.ASIMOV', message: 'x' });
    expect(r.category).toBe(ERROR_CATEGORIES.SAFETY_ASIMOV);
  });

  it('识别 code=S3_TIMEOUT（我们自己打的标记）', () => {
    const err = new Error('upload timed out');
    err.code = 'S3_TIMEOUT';
    const r = classifyError(err);
    expect(r.category).toBe(ERROR_CATEGORIES.S3_UPLOAD);
    expect(r.suggestion).toContain('网络');
  });

  it('识别 400 + body 含 RequestTimeout（图1 实测）', () => {
    const err = new Error('S3 上传失败 400: <RequestTimeout>');
    expect(classifyError(err).category).toBe(ERROR_CATEGORIES.S3_UPLOAD);
  });

  it('status 401 → AUTH', () => {
    const err = new Error('unauthorized');
    err.status = 401;
    const r = classifyError(err);
    expect(r.category).toBe(ERROR_CATEGORIES.AUTH);
    expect(r.actions.some(a => a.id === 'relogin')).toBe(true);
  });

  it('status 429 → QUOTA', () => {
    const err = new Error('too many'); err.status = 429;
    expect(classifyError(err).category).toBe(ERROR_CATEGORIES.QUOTA);
  });

  it('status 503 → NETWORK', () => {
    const err = new Error('bad gateway'); err.status = 503;
    expect(classifyError(err).category).toBe(ERROR_CATEGORIES.NETWORK);
  });

  it('NetworkError 关键词 → NETWORK', () => {
    expect(classifyError(new Error('NetworkError when fetching')).category).toBe(ERROR_CATEGORIES.NETWORK);
  });

  it('无法识别 → UNKNOWN + 建议查日志', () => {
    const r = classifyError(new Error('something weird'));
    expect(r.category).toBe(ERROR_CATEGORIES.UNKNOWN);
    expect(r.actions.some(a => a.id === 'view-log')).toBe(true);
  });

  it('Runway task error 对象能正确路由到 classifyTaskError', () => {
    const taskErr = { reason: 'SAFETY.INPUT.THIRD_PARTY', code: 'SAFETY', message: 'x', raw: {} };
    const r = classifyError(taskErr);
    expect(r.code).toBe('SAFETY.INPUT.THIRD_PARTY');
  });

  it('字符串输入（直接塞 error message）', () => {
    const r = classifyError('Runway 服务端：SAFETY.INPUT.THIRD_PARTY');
    expect(r.category).toBe(ERROR_CATEGORIES.SAFETY_THIRD_PARTY);
  });
});

describe('formatShortError', () => {
  it('返回 "标题 · 消息" 格式', () => {
    const s = formatShortError({ reason: 'SAFETY.INPUT.THIRD_PARTY', message: 'x' });
    expect(s).toContain('·');
    expect(s.split('·').length).toBe(2);
  });
});
