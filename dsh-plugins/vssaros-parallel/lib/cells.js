// 格位注册表（纯逻辑 + 可注入的 PTY 适配器）—— `@vssaros/dsh-parallel` 的后端核心。
//
// 设计要点（都是实测结论，见 doc/dsh-tui-ecosystem-research.md §7）：
//  ① **每格一个独立 dsh 进程**（社区 TUI 自带 core，不连 Host）⇒ 这里管的是"子进程 + 它的 PTY"。
//  ② **原始 ANSI 字节流**直接转发（不解析、不剥色）⇒ 颜色完整；渲染交给浏览器端 xterm.js。
//     官方 `remote.terminal` 的下行是"纯文本屏幕快照"（无样式）⇒ 承载不了彩色 TUI ⇒ 所以自管 PTY。
//  ③ ★ **Windows ConPTY 下 `pty.pid` 是 0** ⇒ 关格只能 `pty.kill()` / 关句柄，**绝不能**按 pid 杀。
//  ④ 写锁是**会话目录级**（`<会话目录>/session.lock`）⇒ 不同格并行无冲突；同一会话只有一个写者
//     ⇒ "接管"必须先关原格，再 `--resume <id>`。
//
// ⚠ PTY 工厂是**注入**的：真机用 node-pty，测试用假实现 ⇒ 状态机可以在不装原生模块的情况下验证。
//   真机探测放在 `probePty()`（见文件尾），失败时如实降级为 "unavailable"，不假装能起格。

import { existsSync, statSync } from 'node:fs';

/** 环缓冲：保留最近 N 个**字节**（按 UTF-8 边界安全截断由调用方保证只切在 chunk 边界）。 */
const DEFAULT_BACKLOG = 256 * 1024;

/** 状态机允许的迁移（只允许这些，别的一律拒绝并如实报错）。 */
const TRANSITIONS = {
	idle: ['starting'],
	starting: ['running', 'failed', 'closing'],
	running: ['closing', 'exited'],
	closing: ['exited'],
	exited: [],
	failed: [],
};

let seqCounter = 0;

/**
 * 建一个格位注册表。
 *
 * @param {object} options
 * @param {(spec: object) => object} options.spawnPty 起 PTY；返回 `{ pid, write(d), resize(c,r), kill(), onData(fn), onExit(fn) }`。
 * @param {number} [options.maxCells] 同屏上限（默认 12；实测每格 ≈ 71.6MB，12 格 ≈ 0.86GB）。
 * @param {number} [options.backlog] 每格保留的回放字节数。
 * @param {() => number} [options.now] 时钟（测试注入）。
 */
export function createCellRegistry(options) {
	const spawnPty = options && options.spawnPty;
	if (typeof spawnPty !== 'function') {
		throw new Error('createCellRegistry: 需要 options.spawnPty（PTY 工厂）');
	}
	const maxCells = Number.isFinite(options.maxCells) ? options.maxCells : 12;
	const backlogBytes = Number.isFinite(options.backlog) ? options.backlog : DEFAULT_BACKLOG;
	const now = typeof options.now === 'function' ? options.now : Date.now;

	/** @type {Map<string, any>} */
	const cells = new Map();

	const move = (cell, to) => {
		const from = cell.state;
		const allowed = TRANSITIONS[from] || [];
		if (allowed.indexOf(to) < 0) {
			return { ok: false, error: `格位 ${cell.id} 的状态不能从 ${from} 变成 ${to}` };
		}
		cell.state = to;
		cell.updatedAt = now();
		emit(cell, { type: 'state', state: to, exitCode: cell.exitCode });
		return { ok: true };
	};

	const emit = (cell, event) => {
		for (const listener of [...cell.listeners]) {
			try { listener(event); } catch { /* 单个订阅者出错不连坐 */ }
		}
	};

	const appendBacklog = (cell, chunk) => {
		cell.backlog += chunk;
		if (cell.backlog.length > backlogBytes) {
			// 只按字符切（Buffer 场景下由上层给 string）；宁可多留，不要切坏多字节字符。
			cell.backlog = cell.backlog.slice(cell.backlog.length - backlogBytes);
		}
	};

	/** 对外视图（不含 pty 句柄与监听器 ⇒ 可安全序列化）。 */
	const viewOf = (cell) => ({
		id: cell.id,
		title: cell.title,
		cwd: cell.cwd,
		preset: cell.preset,
		cols: cell.cols,
		rows: cell.rows,
		state: cell.state,
		exitCode: cell.exitCode,
		error: cell.error,
		startedAt: cell.startedAt,
		updatedAt: cell.updatedAt,
		bytes: cell.bytes,
		pid: cell.pid,
	});

	return {
		/** 全部格位（按创建顺序）。 */
		list() {
			return [...cells.values()].map(viewOf);
		},

		get(id) {
			const cell = cells.get(String(id || ''));
			return cell ? viewOf(cell) : undefined;
		},

		/**
		 * 起一格。
		 * @param {object} spec `{ id, title, cwd, preset, cols, rows, command, args }`。
		 * @returns {{ok: boolean, cell?: object, error?: string}}
		 */
		create(spec) {
			const id = String((spec && spec.id) || '').trim();
			if (!id) { return { ok: false, error: '缺 id' }; }
			if (cells.has(id)) { return { ok: false, error: `格位 ${id} 已存在` }; }
			if (cells.size >= maxCells) {
				return { ok: false, error: `已达上限 ${maxCells} 格（每格一个 dsh 进程，实测 ≈71.6MB/格）` };
			}
			const cols = clampInt(spec && spec.cols, 20, 400, 120);
			const rows = clampInt(spec && spec.rows, 5, 200, 40);
			const cell = {
				id,
				title: String((spec && spec.title) || id),
				cwd: String((spec && spec.cwd) || process.cwd()),
				preset: String((spec && spec.preset) || ''),
				cols, rows,
				state: 'idle',
				exitCode: null,
				error: undefined,
				startedAt: null,
				updatedAt: now(),
				bytes: 0,
				pid: null,
				backlog: '',
				listeners: new Set(),
				pty: null,
			};
			cells.set(id, cell);
			const started = move(cell, 'starting');
			if (!started.ok) { cells.delete(id); return { ok: false, error: started.error }; }

			let handle;
			try {
				handle = spawnPty({
					id, cwd: cell.cwd, cols, rows,
					preset: cell.preset,
					command: spec && spec.command,
					args: spec && spec.args,
				});
			} catch (e) {
				cell.error = String((e && e.message) || e);
				move(cell, 'failed');
				return { ok: false, cell: viewOf(cell), error: cell.error };
			}
			cell.pty = handle;
			// ⚠ ConPTY 下 pid 可能是 0 ⇒ 只作为信息展示，**绝不**用它来杀进程。
			cell.pid = typeof handle.pid === 'number' ? handle.pid : 0;
			cell.startedAt = now();
			if (typeof handle.onData === 'function') {
				handle.onData((chunk) => {
					if (cell.state !== 'running' && cell.state !== 'starting') { return; }
					if (cell.state === 'starting') { move(cell, 'running'); }
					const text = String(chunk == null ? '' : chunk);
					if (!text) { return; }
					cell.bytes += text.length;
					appendBacklog(cell, text);
					seqCounter += 1;
					emit(cell, { type: 'data', seq: seqCounter, data: text });
				});
			}
			if (typeof handle.onExit === 'function') {
				handle.onExit((e) => {
					cell.exitCode = e && typeof e.exitCode === 'number' ? e.exitCode : null;
					if (cell.state === 'running' || cell.state === 'starting') { move(cell, 'exited'); }
					else if (cell.state === 'closing') { move(cell, 'exited'); }
				});
			}
			return { ok: true, cell: viewOf(cell) };
		},

		/**
		 * 订阅某格的增量输出。
		 * @returns {{backlog: string, unsubscribe: () => void}}
		 */
		subscribe(id, listener) {
			const cell = cells.get(String(id || ''));
			if (!cell) { return undefined; }
			cell.listeners.add(listener);
			return {
				backlog: cell.backlog,
				unsubscribe: () => { cell.listeners.delete(listener); },
			};
		},

		/** 写入（键盘输入原样送进 PTY）。 */
		write(id, data) {
			const cell = cells.get(String(id || ''));
			if (!cell) { return { ok: false, error: '格位不存在' }; }
			if (cell.state !== 'running' && cell.state !== 'starting') {
				return { ok: false, error: `格位 ${id} 不在运行（${cell.state}）` };
			}
			try {
				cell.pty.write(String(data == null ? '' : data));
				return { ok: true };
			} catch (e) {
				return { ok: false, error: String((e && e.message) || e) };
			}
		},

		resize(id, cols, rows) {
			const cell = cells.get(String(id || ''));
			if (!cell) { return { ok: false, error: '格位不存在' }; }
			const c = clampInt(cols, 20, 400, cell.cols);
			const r = clampInt(rows, 5, 200, cell.rows);
			if (c === cell.cols && r === cell.rows) { return { ok: true, unchanged: true }; }
			cell.cols = c;
			cell.rows = r;
			try {
				if (typeof cell.pty.resize === 'function') { cell.pty.resize(c, r); }
				return { ok: true };
			} catch (e) {
				return { ok: false, error: String((e && e.message) || e) };
			}
		},

		/** 关一格（═ 用户的「关格」；也是「接管」的第一步）。 */
		close(id) {
			const cell = cells.get(String(id || ''));
			if (!cell) { return { ok: false, error: '格位不存在' }; }
			if (cell.state === 'exited' || cell.state === 'failed') {
				cells.delete(id);
				return { ok: true, alreadyGone: true };
			}
			move(cell, 'closing');
			try {
				// ⚠ 只走句柄；ConPTY 下 pid=0，按 pid 杀既杀不到也可能误杀。
				if (cell.pty && typeof cell.pty.kill === 'function') { cell.pty.kill(); }
			} catch (e) {
				cell.error = String((e && e.message) || e);
			}
			cells.delete(id);
			return { ok: true };
		},

		/** 关全部（Host 卸载 / 页面「收割全部」后的清理）。 */
		closeAll() {
			for (const id of [...cells.keys()]) { this.close(id); }
			return { ok: true, closed: true };
		},
	};
}

/**
 * 探测可用的 PTY 实现。
 *
 * ⚠ 插件装在 profile 里、node-pty 在 runtime 里 ⇒ 裸 `import('node-pty')` 多半解析不到。
 *   这里按"从近到远"试几个候选，全部失败就如实返回 unavailable（**不假装能起格**）。
 *
 * @param {(spec: string) => any} [resolve] 注入的解析器（测试用）。
 * @returns {Promise<{ok: boolean, spawn?: Function, via?: string, error?: string}>}
 */
export async function probePty(resolve) {
	const candidates = [];
	const tried = [];
	const push = (label, pick) => { candidates.push({ label, pick }); };
	if (typeof resolve === 'function') {
		push('injected', resolve);
	} else {
		// ① 裸 import（插件自己声明了 node-pty 依赖时可用）
		push('import node-pty', () => import('node-pty'));
		// ② 显式指定的 runtime
		const explicit = process.env.DSH_RUNTIME_DIR;
		if (explicit) {
			push('DSH_RUNTIME_DIR', () => importPtyAt(joinPath(explicit, 'node_modules', 'node-pty')));
		}
		// ③ ★ 从 Host 自己的入口推（`process.argv[1]` = runtime 里 dsh 的 bin 或 dsh-web-app 的入口）
		//    插件装在 profile 里、node-pty 在 runtime 里 ⇒ 裸 import 解析不到 ⇒ 这条最可能命中。
		for (const base of runtimeRoots()) {
			push('runtime@' + base, () => importPtyAt(joinPath(base, 'node_modules', 'node-pty')));
		}
	}
	const errors = [];
	for (const c of candidates) {
		try {
			const mod = await c.pick();
			const api = mod && (mod.default && mod.default.spawn ? mod.default : mod);
			if (api && typeof api.spawn === 'function') {
				return { ok: true, spawn: api.spawn.bind(api), via: c.label, tried };
			}
			errors.push(`${c.label}: 解析到了但没有 spawn`);
		} catch (e) {
			const msg = String((e && e.message) || e).split('\n')[0];
			tried.push(c.label);
			errors.push(`${c.label}: ${msg}`);
		}
	}
	return { ok: false, error: errors.join(' | '), tried };
}

/** 从几个"Host 进程自己"的位置倒推 runtime 根（去重、只留存在的）。 */
function runtimeRoots() {
	const roots = [];
	const add = (p) => {
		if (!p) { return; }
		let dir = String(p);
		try {
			if (!statSync(dir).isDirectory()) { dir = dirname(dir); }
		} catch { dir = dirname(dir); }
		// 最多往上找 8 层，命中含 node-pty 的 node_modules 就收
		for (let i = 0; i < 8; i += 1) {
			if (existsSync(joinPath(dir, 'node_modules', 'node-pty'))) { roots.push(dir); return; }
			const up = dirname(dir);
			if (!up || up === dir) { return; }
			dir = up;
		}
	};
	add(process.argv[1]);
	add(process.env.DSH_RUNTIME_DIR);
	return [...new Set(roots)];
}

function joinPath(...parts) {
	return parts.filter(Boolean).map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+/, ''))).join('/');
}
function dirname(p) {
	const s = String(p).replace(/[\\/]+$/, '');
	const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
	return i > 0 ? s.slice(0, i) : s;
}
function importPtyAt(dir) {
	return import('file:///' + String(dir).replace(/\\/g, '/') + '/lib/index.js');
}

function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) { return fallback; }
	return Math.min(max, Math.max(min, Math.round(n)));
}
