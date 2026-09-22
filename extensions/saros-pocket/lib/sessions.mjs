// Saros Pocket — 会话仓库（收件箱 / 当前会话两页的数据源）
//
// 为什么需要它：手机上看的是「一堆并发任务」，而不是「一次请求一个答案」。
// chat.send / sessions.send 只返回这一次的结果，刷新页面或断线重连后，
// 手机完全不知道曾经跑过什么、跑到哪一步了。会话仓库把「任务」提升为一等公民：
// 每个任务有 id、状态、预览、统计，收件箱页据此渲染列表 + 状态徽标。
//
// 为什么做成纯逻辑、不依赖 vscode：
// 1) 可以脱离 FakeVscode 直接单测 —— 项目无 lint 无类型检查，测试是唯一防线；
// 2) 不 import vscode 命名空间，意味着它也不会被 bridge 的活对象污染。
//
// 关键约束（design-spec 3.1）：
// - 会话里禁止存 CancellationTokenSource 等活对象，也禁止存消息全文，
//   只留 preview 与计数 —— 否则内存无界增长，且 JSON 序列化会踩坑；
// - maxRecent 默认 50，超出按 LRU 淘汰，且优先淘汰「已终态」的会话。

import { randomBytes } from 'node:crypto';

/** 会话的终态：进入终态后不再变化，可被 LRU 优先淘汰。 */
const TERMINAL_STATUS = new Set(['done', 'failed', 'cancelled']);

const ACTIVE_STATUS = new Set(['running', 'waiting']);

const ALL_KINDS = new Set(['chat', 'agent']);

const MAX_TITLE_LENGTH = 40;
const MAX_PREVIEW_LENGTH = 120;

function stampDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 生成会话 id：日期 + 随机串，便于日志里肉眼区分。 */
function createSessionId() {
  return `s-${stampDate()}-${randomBytes(3).toString('hex')}`;
}

function truncateText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function toPositiveInt(value, fallback) {
  const num = Math.floor(Number(value));
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * 把会话裁剪成「列表摘要」：与完整会话同构，只是去掉可能变大的字段。
 * @param {object} session
 */
function toSummary(session) {
  return { ...session };
}

/**
 * 创建会话仓库。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxRecent=50] 保留的最大会话数，超出按 LRU 淘汰
 * @param {{ emit?: (type: string, data?: unknown) => unknown }} [opts.events] 事件总线（可选）
 * @param {() => number} [opts.now] 时间源（测试用）
 */
export function createSessionStore({ maxRecent = 50, events = null, now = () => Date.now() } = {}) {
  const limit = toPositiveInt(maxRecent, 50);
  /** @type {Map<string, object>} id → 会话（Map 保证最近 set 的在末尾，天然 LRU 顺序） */
  const sessions = new Map();
  /** clientRunId → sessionId，用于幂等：同一 runId 重复 start 返回同一会话。 */
  const runIndex = new Map();
  /** sessionId → clientRunId，反向索引，便于淘汰时清理。 */
  const runReverse = new Map();

  let counter = 0;

  function emit(type, data) {
    if (events && typeof events.emit === 'function') {
      try { events.emit(type, data); } catch { /* 事件总线出错不影响主流程 */ }
    }
  }

  /** 重新插入以刷新 LRU 位置。 */
  function touch(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    sessions.set(id, session);
  }

  /**
   * 淘汰超出容量的会话。优先淘汰终态中最久未使用的；
   * 若全是活跃会话（不应发生，但保底），淘汰最久未使用的那个。
   */
  function evictIfNeeded() {
    while (sessions.size > limit) {
      let victimId = null;
      for (const [id, session] of sessions) {
        if (TERMINAL_STATUS.has(session.status)) { victimId = id; break; }
      }
      if (victimId === null) victimId = sessions.keys().next().value;
      sessions.delete(victimId);
      const runId = runReverse.get(victimId);
      if (runId) { runIndex.delete(runId); runReverse.delete(victimId); }
    }
  }

  /**
   * 新建或复用一个会话。
   *
   * @param {object} [input]
   * @param {'chat'|'agent'} [input.kind='chat'] 会话类型
   * @param {string} [input.title] 会话标题，缺省取首条消息前 40 字
   * @param {string} [input.clientRunId] 客户端 runId，作幂等键
   * @returns {object} 会话对象（JSON 可序列化）
   */
  function start(input = {}) {
    const clientRunId = String(input.clientRunId ?? '').trim();
    if (clientRunId && runIndex.has(clientRunId)) {
      const existingId = runIndex.get(clientRunId);
      const existing = sessions.get(existingId);
      if (existing) {
        touch(existingId);
        return toSummary(existing);
      }
      // 会话已被淘汰：清掉悬挂索引，走新建分支
      runIndex.delete(clientRunId);
      runReverse.delete(existingId);
    }

    const kind = ALL_KINDS.has(input.kind) ? input.kind : 'chat';
    const timestamp = now();
    const id = createSessionId();
    counter += 1;

    const session = {
      id,
      kind,
      title: truncateText(input.title, MAX_TITLE_LENGTH) || `会话 ${counter}`,
      status: 'running',
      startedAt: timestamp,
      updatedAt: timestamp,
      preview: '',
      stats: { messages: 0, additions: 0, deletions: 0 },
      pendingPermission: null,
      error: null,
    };

    sessions.set(id, session);
    if (clientRunId) {
      runIndex.set(clientRunId, id);
      runReverse.set(id, clientRunId);
    }
    evictIfNeeded();
    emit('session.start', { id, kind, title: session.title });
    return toSummary(session);
  }

  /**
   * 局部更新会话。只允许更新白名单内的字段，避免调用方塞进活对象。
   *
   * @param {string} id
   * @param {object} patch
   * @returns {object|null} 更新后的会话，不存在则返回 null
   */
  function update(id, patch = {}) {
    const session = sessions.get(id);
    if (!session) return null;

    if (typeof patch.title === 'string' && patch.title.trim()) {
      session.title = truncateText(patch.title, MAX_TITLE_LENGTH);
    }
    if (typeof patch.preview === 'string') {
      session.preview = truncateText(patch.preview, MAX_PREVIEW_LENGTH);
    }
    if (patch.status && (ACTIVE_STATUS.has(patch.status) || TERMINAL_STATUS.has(patch.status))) {
      session.status = patch.status;
    }
    if (patch.pendingPermission !== undefined) {
      session.pendingPermission = patch.pendingPermission === null ? null : String(patch.pendingPermission);
    }
    if (patch.error !== undefined) {
      session.error = patch.error === null ? null : String(patch.error);
    }
    if (patch.stats && typeof patch.stats === 'object') {
      const stats = patch.stats;
      if (Number.isFinite(Number(stats.messages))) session.stats.messages = Math.max(0, Math.floor(Number(stats.messages)));
      if (Number.isFinite(Number(stats.additions))) session.stats.additions = Math.max(0, Math.floor(Number(stats.additions)));
      if (Number.isFinite(Number(stats.deletions))) session.stats.deletions = Math.max(0, Math.floor(Number(stats.deletions)));
    }

    session.updatedAt = now();
    touch(id);
    emit('session.update', { id, status: session.status, preview: session.preview });
    return toSummary(session);
  }

  /**
   * 结束会话，进入终态。重复调用会被忽略（终态不可回退），
   * 避免「cancel 后 late 的 error 把状态覆盖成 failed」。
   *
   * @param {string} id
   * @param {object} [input]
   * @param {'done'|'failed'|'cancelled'} [input.status='done']
   * @param {string|null} [input.error]
   * @returns {object|null}
   */
  function finish(id, input = {}) {
    const session = sessions.get(id);
    if (!session) return null;
    if (TERMINAL_STATUS.has(session.status)) return toSummary(session);

    const status = TERMINAL_STATUS.has(input.status) ? input.status : 'done';
    session.status = status;
    session.error = input.error ? String(input.error) : null;
    session.pendingPermission = null;
    session.updatedAt = now();
    touch(id);
    emit('session.done', { id, status, error: session.error });
    return toSummary(session);
  }

  /**
   * 按 id 取会话。
   * @param {string} id
   */
  function get(id) {
    const session = sessions.get(String(id ?? ''));
    if (!session) return null;
    touch(session.id);
    return toSummary(session);
  }

  /**
   * 列出会话，按最近活跃在前排序。
   *
   * @param {object} [query]
   * @param {string} [query.status] 'running'|'waiting'|'done'|'failed'|'cancelled'|'all'
   * @param {'chat'|'agent'} [query.kind]
   * @param {number} [query.limit]
   */
  function list(query = {}) {
    const status = String(query.status ?? 'all').trim();
    const kind = String(query.kind ?? '').trim();
    const limitCount = toPositiveInt(query.limit, limit);

    const matched = [];
    // 倒序遍历 = 最近活跃的在前
    for (const session of Array.from(sessions.values()).reverse()) {
      if (status && status !== 'all' && session.status !== status) continue;
      if (kind && session.kind !== kind) continue;
      matched.push(toSummary(session));
      if (matched.length >= limitCount) break;
    }
    return matched;
  }

  /** 清空全部会话（供 dispose 或测试使用）。 */
  function clear() {
    sessions.clear();
    runIndex.clear();
    runReverse.clear();
  }

  return {
    start,
    update,
    finish,
    get,
    list,
    clear,
    /** 当前会话数（含活跃与终态）。 */
    size() { return sessions.size; },
  };
}

export const SESSION_TERMINAL_STATUS = Object.freeze(Array.from(TERMINAL_STATUS));
export const SESSION_ACTIVE_STATUS = Object.freeze(Array.from(ACTIVE_STATUS));
