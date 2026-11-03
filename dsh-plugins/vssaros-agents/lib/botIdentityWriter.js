// @vssaros/dsh-agents — 把 Bot 身份写进会话日志（plugin record）。2026-11-03。判据与数据形状见 core/botIdentity.js。
//
// ★ 为什么要绕一下才拿得到 `appendPluginRecord`：
//   · 插件装在 profile 的 node_modules 里，**解析不到** `@deepseek-ai/dsh-session`（实测 MODULE_NOT_FOUND；
//     同理 index.js 里 `import('@deepseek-ai/dsh-llm')` 一直静默落到兜底）。
//   · 而 `appendPluginRecord` 内部走 `Session` 的私有方法 ⇒ 必须是**与 Host 同一份模块实例**，否则
//     私有字段品牌检查直接抛 TypeError。
//   ⇒ 以 Host 入口（`process.argv[1]` = `<dsh-runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js`）为锚点解析，
//     拿到的就是 Host 自己加载的那份；任何一步失败 ⇒ 返回 null（调用方退回 presetId 推断，不报错）。
//   · 自校验：写入若因实例不一致而抛，`writeBotIdentity` 捕获并返回 reason；不会把会话弄坏（失败的记录不进日志）。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BOT_IDENTITY_RECORD_TYPE, BOT_PROJECTION_KEY, identityRecordData } from './core/botIdentity.js';

/** @type {Promise<Function | null> | undefined} */
let appendLoader;

/** 取 Host 那份 `appendPluginRecord`（缓存；拿不到 ⇒ null）。 */
export function loadAppendPluginRecord() {
	if (!appendLoader) {
		appendLoader = (async () => {
			const anchors = [process.argv[1]].filter(p => typeof p === 'string' && p);
			for (const anchor of anchors) {
				try {
					const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-session');
					const mod = await import(pathToFileURL(resolved).href);
					if (typeof mod?.appendPluginRecord === 'function') {
						return mod.appendPluginRecord;
					}
				} catch {
					/* 换下一个锚点 */
				}
			}
			try {
				const mod = await import('@deepseek-ai/dsh-session');
				if (typeof mod?.appendPluginRecord === 'function') {
					return mod.appendPluginRecord;
				}
			} catch {
				/* 解析不到 */
			}
			return null;
		})();
	}
	return appendLoader;
}

/**
 * 给会话写一条身份记录（已有同口径记录 ⇒ 不重复写）。
 * @param deps.projections `sessionProjections`（判"已写过"用；拿不到也照写）
 * @param deps.append 可注入（测试用）；缺省走 `loadAppendPluginRecord()`
 * @param agent 活 agent（要 `agent.session`）
 * @param ident `{ botId, presetId }`
 * @returns `{ ok, reason?, seq? }` —— 永不抛
 */
export async function writeBotIdentity(deps, agent, ident) {
	try {
		const session = agent?.session;
		if (!session || !ident?.botId || !ident?.presetId) {
			return { ok: false, reason: 'no-session-or-identity' };
		}
		let current;
		try { current = deps?.projections?.stateOf?.(session, BOT_PROJECTION_KEY); } catch { current = undefined; }
		if (current && current.botId === ident.botId && current.presetId === ident.presetId) {
			return { ok: false, reason: 'already' };
		}
		const append = typeof deps?.append === 'function' ? deps.append : await loadAppendPluginRecord();
		if (typeof append !== 'function') {
			return { ok: false, reason: 'no-append-api' };
		}
		const seq = append(session, BOT_IDENTITY_RECORD_TYPE, identityRecordData(ident));
		return { ok: true, seq };
	} catch (error) {
		return { ok: false, reason: `error: ${String(error?.message ?? error).slice(0, 200)}` };
	}
}
