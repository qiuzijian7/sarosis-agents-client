// @vssaros/dsh-local-agents — P1-9（2026-11-10）：dsh sessionId ↔ ACP cliSessionId 持久映射。
//
// 为什么需要：进程内 `lives` Map 在 Host 重启后清空 ⇒ 同一 dsh 会话只能重新 `session/new`，
// CLI 侧历史丢失。这里把 id 对落盘，让 `ensureLive` 能带 `resumeId` 走 `session/resume`。
//
// ⚠ 只存 id，**不作授权**：根集、cwd、mcpServers 仍由调用方在 resume 时显式重传
//   （P1-5 / P1-8 / ACP v2 要求），不隐式复活任何旧作用域 ✓。
// ⚠ 不存凭证 / 消息 / 路径；畸形条目一律丢弃（fail-closed）。
// ⚠ 不 import cordis、不直接碰 fs（readText / writeText 由插件入口注入）⇒ 守卫可纯内存断言 ✓。

/** 映射条数上限（防止历史会话把文件撑大）。 */
export const MAX_ACP_SESSION_MAP_ENTRIES = 512;
const NUL = String.fromCharCode(0);

function validId(value) {
	return typeof value === 'string'
		&& value.length > 0 && value.length <= 256
		&& value.trim() === value && !value.includes(NUL);
}

/** 解析落盘 JSON：只保留合法 id 对；畸形 / 非对象 / 超额一律丢。 */
export function parseAcpSessionMap(text) {
	const out = {};
	if (typeof text !== 'string' || !text.trim()) { return out; }
	let raw;
	try { raw = JSON.parse(text); } catch { return out; }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return out; }
	for (const [key, value] of Object.entries(raw)) {
		if (validId(key) && validId(value)) { out[key] = value; }
		if (Object.keys(out).length >= MAX_ACP_SESSION_MAP_ENTRIES) { break; }
	}
	return out;
}

/** 稳定序列化（键序固定 ⇒ diff 只反映真变化 ✓）。 */
export function serializeAcpSessionMap(entries) {
	const sorted = Object.fromEntries(
		Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b)),
	);
	return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * @param deps.readText `() => Promise<string>`（文件不存在时 reject 也安全）
 * @param deps.writeText `(text) => Promise<void>`（调用方负责原子写）
 */
export function createAcpSessionMap({ readText, writeText } = {}) {
	let entries;
	const load = async () => {
		if (entries) { return entries; }
		try { entries = parseAcpSessionMap(await readText?.()); }
		catch { entries = {}; }
		return entries;
	};
	const flush = async () => {
		if (typeof writeText !== 'function') { return; }
		try { await writeText(serializeAcpSessionMap(entries)); }
		catch { /* 落盘失败不拖垮会话：进程内映射仍然有效 ✓ */ }
	};
	return {
		get(sessionId) {
			if (!validId(sessionId)) { return Promise.resolve(undefined); }
			return load().then(map => map[sessionId]);
		},
		async set(sessionId, cliSessionId) {
			if (!validId(sessionId) || !validId(cliSessionId)) { return false; }
			const map = await load();
			if (map[sessionId] === cliSessionId) { return true; }
			map[sessionId] = cliSessionId;
			await flush();
			return true;
		},
		async delete(sessionId) {
			if (!validId(sessionId)) { return; }
			const map = await load();
			if (!(sessionId in map)) { return; }
			delete map[sessionId];
			await flush();
		},
		async size() { return Object.keys(await load()).length; },
	};
}
