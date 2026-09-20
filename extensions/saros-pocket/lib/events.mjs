// Saros Pocket — 事件总线（VsSaros → Pocket App 的单向实时推送）
//
// 为什么需要它：HTTP 请求只能「问一次答一次」，而手机 App 需要感知 VsSaros 侧的变化
// （聊天流式增量、编辑器切换、文件保存、代理/隧道状态）。所有订阅者共享一条总线，
// 由 lib/rpc.mjs 的 SSE 端点把事件推给浏览器（EventSource），断线自动重连。
//
// 与 dsh-pocket 的差异：dsh 有插件框架自带的 RPC 双向通道；VsSaros 扩展只能自己起
// HTTP 端点，所以这里把「请求-响应」与「服务端推送」拆成两条：POST 走命令，SSE 走事件。

/**
 * @param {{ maxRecent?: number }} [opts]
 */
export function createEventBus({ maxRecent = 100 } = {}) {
  const clients = new Set();
  const recent = [];
  let seq = 0;
  let disposed = false;

  return {
    /**
     * 广播一个事件。
     * @param {string} type 事件类型（如 'chat.delta' / 'editor.change'）
     * @param {unknown} [data] 事件负载（必须可 JSON 序列化）
     */
    emit(type, data) {
      if (disposed) return null;
      const event = { id: ++seq, type, data: data ?? null, at: Date.now() };
      recent.push(event);
      if (recent.length > maxRecent) recent.splice(0, recent.length - maxRecent);
      for (const fn of Array.from(clients)) {
        try { fn(event); } catch { /* 单个订阅者出错不影响其他订阅者 */ }
      }
      return event;
    },
    subscribe(fn) {
      if (disposed) return () => { };
      clients.add(fn);
      return () => clients.delete(fn);
    },
    recent() {
      return recent.slice();
    },
    clientCount() {
      return clients.size;
    },
    dispose() {
      disposed = true;
      clients.clear();
    },
  };
}
