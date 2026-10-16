/**
 * Host 侧的**通道实现**：把 `BrowserCdpRequest` 协议的请求直接落到本进程的 CDP 宿主上。
 *
 * 为什么保留这一层：VsSaros 那份把协议与实现分在两边（renderer 发请求 / **主进程**
 * `browserCdpChannel.ts` 执行），客户端 `BrowserCdpClient` 只依赖 `IBrowserCdpInvoker`。
 * 这里**照同一份协议**实现 Host 版 ⇒ 客户端那份逻辑可以逐条搬过来、且以后与 IDE 侧 diff 得动
 * （"哪边多了一个 op"一眼可见）。
 */

/** 请求 → `{ ok, result | error }`（与 IDE 侧通道的返回形态一致；失败不抛，由客户端转成异常）。 */
export function createHostInvoker(host) {
	return async req => {
		try {
			switch (req?.op) {
				case 'status':
					return { ok: true, result: await host.status() };
				case 'list':
					return { ok: true, result: await host.list() };
				case 'ensurePage':
					// `req.key` = 会话标识（多会话隔离的归属键）；缺省为空 ⇒ host 走旧行为。
					return { ok: true, result: await host.ensurePage(req.key, req.url) };
				case 'closePage':
					return { ok: true, result: await host.closeOwned(String(req.targetId), req.key) };
				case 'command':
					return {
						ok: true,
						result: await host.command(String(req.method), req.params, req.sessionId, req.timeoutMs),
					};
				case 'reset':
					host.dispose();
					return { ok: true, result: { reset: true } };
				default:
					return { ok: false, error: `不认识的 browser CDP op：${String(req?.op)}` };
			}
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
}
