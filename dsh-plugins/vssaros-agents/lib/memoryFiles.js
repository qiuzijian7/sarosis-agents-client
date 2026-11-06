// @vssaros/dsh-agents — 旧记忆目录的路径与文件名规则（2026-11-06「记忆收敛」S4）。
//
// Bot 记忆已并入 @vssaros/dsh-memory 的 bot 轨（本插件不再存、不再注入）。剩下的只有两件事要知道旧目录：
//   · **收件箱**：不经 Host 的入口（CLI `bin/agent.mjs`、Host 启动早期的团队步骤证据）拿不到统一存储的写入口，
//     就把内容写进旧目录；@vssaros/dsh-memory 启动时（lib/legacy-import.js）按正文去重并入 bot 轨，不会丢。
//   · **导出 / 导入包**里 MEMORY.md 以外的附加记忆文件，照旧放在旧目录。
// 规则与原 lib/memory.js 的 memoryDirOf / safeMemoryFileName 逐字相同（legacy-import.js 按同一口径找文件）。

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { agentsRootOf, dataRootOf } from './store.js';

/** Bot 的旧记忆目录：自定义 Bot 在 `<agents>/<id>/memory`，内置 / 预设 Bot 在 `<数据根>/agent-memory/<id>`。 */
export function legacyMemoryDirOf(config, agentId) {
	const id = String(agentId ?? '');
	const ownRoot = join(agentsRootOf(config), id);
	if (id && existsSync(ownRoot)) {
		return join(ownRoot, 'memory');
	}
	return join(dataRootOf(config), 'agent-memory', id);
}

/** 文件名白名单（防穿越：只要 basename 形状的 .md/.txt）。 */
export function safeMemoryFileName(name) {
	const base = basename(String(name ?? ''));
	if (!/^[A-Za-z0-9._一-龥-]{1,80}\.(md|txt)$/.test(base) || base.startsWith('.')) {
		return undefined;
	}
	return base;
}

/** 单条记忆的长度上限（与原工作区记忆同口径）。 */
export const ENTRY_MAX_CHARS = 400;

/** 统一记忆存储的写入口（@vssaros/dsh-memory 提供；`version >= min` 才算可用）。 */
export function unifiedMemoryStore(min = 1, root = globalThis) {
	const w = root[Symbol.for('vssaros.memory.store')];
	return w && Number(w.version) >= min ? w : null;
}

/** 往收件箱追加一条（Markdown 列表行；统一存储下次启动时导入）。同步：调用方 rememberStep 是同步的。 */
export function appendToInbox(config, agentId, text) {
	const dir = legacyMemoryDirOf(config, agentId);
	mkdirSync(dir, { recursive: true });
	const day = new Date().toISOString().slice(0, 10);
	const line = String(text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
	appendFileSync(join(dir, 'MEMORY.md'), `- [${day}] ${line}\n`, 'utf8');
	return { ok: true, message: '统一记忆未就绪，已暂存到收件箱（下次启动时并入）', inbox: true };
}
