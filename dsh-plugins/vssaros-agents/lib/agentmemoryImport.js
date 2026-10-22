// @vssaros/dsh-agents — 从 AgentMemory 网关库**生成 MEMORY.md 草稿**（只读；落盘仍由人按「保存」）。
//
// 为什么只做"草稿"而不是直接写：
//   本页签的纪律是「模型没有记忆写口、提交只能人按」（见 memory.js 头注释 ③）。从检索库拉来的条目
//   是**未经审阅**的内容，直接写进常驻前缀等于让库自己改自己的小抄 —— 人必须能先看一眼再决定。
//
// 为什么这里要一个网关客户端（而不是复用 vssaros-memory 插件）：
//   两个插件是**同级的独立包**，彼此没有依赖；为了一次只读查询引入服务定位/事件总线不划算。
//   契约只有一条（`POST {base}/provider/searchMemory`，信封 `{args:[agentId, query, limit]}`），
//   与 `dsh-plugins/vssaros-memory/lib/gateway.js` 的 `search()` 逐字一致（那边有真机钉死的注释）。
//
// ⚠ **不猜端口**：地址只从这四处来 —— config.agentMemoryGatewayUrl → VSSAROS_MEMORY_GATEWAY_URL
//   → AGENTMEMORY_URL → AGENTMEMORY_PORT。全缺 ⇒ 明确报"未配置"，绝不试 3111/3112
//   （猜错会读到**别人的库**，那比"这次没导入"严重得多）。
import { MEMORY_CHARS_MAX } from './core/memoryLimits.js';

/** 网关是本地进程：超过这个时间就是它坏了（与 memory 插件的 5s 同口径）。 */
const TIMEOUT_MS = 5000;
/** 草稿默认取多少条（常驻前缀很小，40 条已经足够让人挑）。 */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

/**
 * 解析记忆网关地址：`config.agentMemoryGatewayUrl` → `VSSAROS_MEMORY_GATEWAY_URL`
 * → `AGENTMEMORY_URL` → `http://127.0.0.1:<AGENTMEMORY_PORT>`。都缺 ⇒ `null`。
 *
 * 后两个名字来自 IDE 主进程（`app.ts._initAgentMemoryEndpoint()` 写进环境，Host 作为子进程继承）；
 * 前两个是我们自己/记忆插件的口径。**只读，不重算端口规则**（真源在 IDE 侧）。
 */
export function agentMemoryGatewayUrl(config, env = process.env) {
	const configured = typeof config?.agentMemoryGatewayUrl === 'string' ? config.agentMemoryGatewayUrl.trim() : '';
	if (configured) {
		return configured.replace(/\/+$/, '');
	}
	for (const key of ['VSSAROS_MEMORY_GATEWAY_URL', 'AGENTMEMORY_URL']) {
		const value = typeof env?.[key] === 'string' ? env[key].trim() : '';
		if (value) {
			return value.replace(/\/+$/, '');
		}
	}
	const port = Number.parseInt(String(env?.AGENTMEMORY_PORT ?? '').trim(), 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : null;
}

/** 归一化条数（缺省 40，夹到 (0, 100]）。 */
export function clampImportLimit(value) {
	const n = typeof value === 'string' ? Number(value.trim()) : value;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(MAX_LIMIT, Math.trunc(n));
}

async function providerCall(base, method, args) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${base}/provider/${encodeURIComponent(method)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ args: Array.isArray(args) ? args : [args] }),
			signal: ctrl.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}：${text.slice(0, 200)}`);
		}
		return text ? JSON.parse(text) : null;
	} catch (e) {
		if (e?.name === 'AbortError') {
			throw new Error(`记忆网关 ${TIMEOUT_MS}ms 未响应（${base}）`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/** 把一条记忆压成一行 Markdown（内容里的换行/连续空白折叠，避免一条记忆占一整屏）。 */
function lineOf(entry, index) {
	const type = String(entry?.type ?? 'note').trim() || 'note';
	const content = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
	if (!content) {
		return '';
	}
	const id = String(entry?.id ?? '').slice(0, 8);
	return `${index + 1}. [${type}] ${content}${id ? `（${id}）` : ''}`;
}

/**
 * 拉一批条目并拼成 `MEMORY.md` 草稿（**不落盘**）。
 *
 * @returns `{ draft, count, truncated, gateway }`
 * @throws 网关未配置 / 不可达 / 返回形状不认识 —— 一律如实报错（不返回空草稿冒充成功）
 */
export async function importMemoryDraft(config, agentId, options = {}) {
	// `options.env` 只为可测：不给就按 process.env（生产路径），测试传 `{}` 排除本机环境干扰
	const base = agentMemoryGatewayUrl(config, options?.env);
	if (!base) {
		throw Object.assign(
			new Error('记忆网关未配置：找不到 AGENTMEMORY_URL / AGENTMEMORY_PORT / VSSAROS_MEMORY_GATEWAY_URL'
				+ '（不猜端口 —— 猜错会读到另一个网关的库）。若是独立部署，可给本插件配 agentMemoryGatewayUrl。'),
			{ httpStatus: 400 },
		);
	}
	const limit = clampImportLimit(options?.limit);
	// 空 query ⇒ searchMemory **全量列出**（与 memory 插件的 memory_list 同一条真机结论：
	// 宿主路由 /search/<agentId> 空查询会回 []，且没有 content ⇒ 不能用）
	const reply = await providerCall(base, 'searchMemory', [String(agentId ?? ''), '', limit]);
	if (reply !== null && !Array.isArray(reply)) {
		throw new Error(`记忆网关返回的形状不认识（期望数组，收到 ${typeof reply}）—— 拒绝拼一份可能骗人的草稿`);
	}
	const items = (reply ?? []).filter(entry => entry && typeof entry === 'object');
	const lines = [];
	for (const entry of items) {
		const line = lineOf(entry, lines.length);
		if (line) {
			lines.push(line);
		}
	}
	if (!lines.length) {
		// 空库是合法状态，但**不是**"导入成功"：如实说，让页面提示用户
		return { draft: '', count: 0, truncated: false, gateway: base, empty: true };
	}
	const header = [
		'# 记忆索引',
		'',
		`> 草稿：从 AgentMemory 检索库导入 ${lines.length} 条（**未保存**）。请删改后按「保存」；`
			+ '保存后要留版本再按「提交快照」。',
		'',
	].join('\n');
	let draft = `${header}${lines.join('\n')}\n`;
	let truncated = false;
	if (draft.length > MEMORY_CHARS_MAX) {
		draft = `${draft.slice(0, MEMORY_CHARS_MAX)}\n…（已截断：上限 ${MEMORY_CHARS_MAX} 字符）`;
		truncated = true;
	}
	return { draft, count: lines.length, truncated, gateway: base };
}
