// @vssaros/dsh-foundation — P0-2（2026-11-10）：让模型看见多根工作区。
//
// 本文件全是**纯函数 / 薄接线**，不 import cordis、不做 I/O ⇒ 守卫可直接 import 做行为断言 ✓：
//   · renderWorkspaceRootsText() —— systemPrompt.context 的 `text()` 用它；**只在 >= 2 根时**产出文本
//     （单根 / 没推过上下文 ⇒ '' ⇒ 绝大多数会话的 system prompt 逐字不变，prompt 前缀缓存不受影响 ✓）。
//   · parseRootQualifiedPath() —— `@<根名>:<相对路径>` 解析器（Cline 的同款消歧写法）。
//     ⚠ 本刀**只提供、不接工具** ⇒ 现有工具的路径行为不变；下一刀把工具参数接过来。
//     ⚠ 因此提示词里**不宣传**这个语法 —— 告诉模型一个会被工具当成普通路径的能力，
//       等于制造静默失败（本仓纪律：文案必须描述真正会发生的事 ✗）。接进工具后才写进文本。
//   · installWorkspaceRootsPrompt() —— 把上面那段挂到 Host 的 systemPrompt.context 上。
//
// ★ 为什么不在这里塞 git remote / HEAD：dsh 的 `text()` 是**同步**函数（vssaros-memory 的
//   memory:snapshot 同款），每次装配 system prompt 都调；在这里 execFileSync('git') 会卡住装配、
//   击穿 prompt 缓存 ✗ ⇒ 本刀只给路径/根名/主根，VCS 元数据留到有异步装配面时再说。

import path from 'node:path';
import { deriveWorkspaceRoots, MAX_WORKSPACE_ROOTS } from './workspaceContext.js';

/** 提示段总长度上限（畸形工作区不许把 system prompt 撑爆 ✓）。 */
export const MAX_WORKSPACE_PROMPT_TEXT = 8192;
/** 段名 / 顺序：排在 memory:snapshot(500) 之前 ⇒ 环境信息先于记忆快照。 */
export const WORKSPACE_ROOTS_SECTION_NAME = 'vssaros:workspace-roots';
export const WORKSPACE_ROOTS_SECTION_ORDER = 480;

/** Windows/Posix 的词法同路径判据（**只用于提示文案**，不是安全边界 ✓）。 */
function samePath(a, b) {
	const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return norm(a) === norm(b);
}

/**
 * 渲染多根工作区的模型上下文段。
 *
 * @param {unknown} context foundation 的运行期上下文（`store.get()` 的返回值，可能是 undefined）
 * @param {{cwd?: string}} [options] 当前会话 cwd（由 text() 从 promptContext 里尽力取）
 * @returns {string} '' = 单根 / 无上下文（不注入任何文本 ✓）
 */
export function renderWorkspaceRootsText(context, options = {}) {
	const roots = deriveWorkspaceRoots(context);
	if (roots.length < 2) {
		return '';
	}
	const lines = [
		'## Workspace roots (multi-root)',
		'This workspace has ' + roots.length + ' roots. Relative paths resolve ONLY against the primary root; '
			+ 'for a file under another root, always use its absolute path.',
	];
	for (const r of roots.slice(0, MAX_WORKSPACE_ROOTS)) {
		lines.push('- ' + (r.isPrimary ? 'primary' : 'additional') + '  ' + r.name + '  ' + r.path);
	}
	lines.push('If several roots contain files with the same name, disambiguate with the absolute path.');
	const cwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
	if (cwd && !samePath(cwd, roots[0].path)) {
		lines.push('This session\'s cwd is ' + cwd + ' (not the primary root) — pass an explicit cwd when the repository matters.');
	}
	const text = lines.join('\n');
	return text.length > MAX_WORKSPACE_PROMPT_TEXT ? text.slice(0, MAX_WORKSPACE_PROMPT_TEXT) : text;
}

/**
 * 解析 `@<根名>:<相对路径>`。
 *
 * @returns `undefined` = 不是这种语法（调用方按普通路径处理）；
 *          `{root, absolutePath, relativePath}` = 命中；
 *          `{error}` = 语法/根名/路径不合法（调用方应报错，**不许猜** ✗）。
 */
export function parseRootQualifiedPath(input, roots) {
	if (typeof input !== 'string' || !input.startsWith('@')) {
		return undefined;
	}
	const NUL = String.fromCharCode(0);
	const body = input.slice(1);
	const colon = body.indexOf(':');
	if (colon <= 0 || body.includes(NUL)) {
		return { error: 'root-qualified path must look like @<root-name>:<relative/path>' };
	}
	const name = body.slice(0, colon).trim();
	const rel = body.slice(colon + 1).trim();
	if (!name || !rel) {
		return { error: 'root-qualified path needs both a root name and a relative path' };
	}
	const list = Array.isArray(roots) ? roots : [];
	const exact = list.filter(r => r && r.name === name);
	const candidates = exact.length
		? exact
		: list.filter(r => r && typeof r.name === 'string' && r.name.toLowerCase() === name.toLowerCase());
	if (!candidates.length) {
		return { error: 'unknown workspace root: ' + name };
	}
	if (candidates.length > 1) {
		return { error: 'ambiguous workspace root name: ' + name };
	}
	const root = candidates[0];
	if (!root || typeof root.path !== 'string' || !root.path.trim()) {
		return { error: 'workspace root has no usable path: ' + name };
	}
	if (path.isAbsolute(rel) || rel.startsWith('/') || rel.startsWith('\\') || rel.split(/[\\/]/).includes('..')) {
		return { error: 'root-qualified path must be relative and must not escape its root' };
	}
	const absolutePath = path.resolve(root.path, rel);
	const back = path.relative(root.path, absolutePath);
	if (back.startsWith('..') || path.isAbsolute(back)) {
		return { error: 'root-qualified path escapes its root' };
	}
	return { root, absolutePath, relativePath: rel };
}

/** 从 systemPrompt 的装配上下文里尽力取会话 cwd（拿不到就不写，绝不猜 ✓）。 */
function cwdOf(promptContext) {
	const h = promptContext?.agent?.session?.header ?? promptContext?.session?.header;
	return typeof h?.cwd === 'string' ? h.cwd : undefined;
}

/**
 * 把根集段挂到 Host 的 `systemPrompt.context`。
 *
 * ★ 用 `text()` 的**函数形式**：每次装配都重读 foundation 的运行期真源 ⇒ 切工作区后不会说谎
 *   （`dshCli.ts` 的 personaSuffix 是启动期烘焙的字面量，那条路会永远停在旧根 ✗）。
 * ★ 通过 `ctx.inject(['systemPrompt'], …)` 的**子作用域**接入：不改插件级 `inject = []`，
 *   foundation 仍是最早加载、谁都不等的底座；服务缺席（老 Host / 离线 fake ctx）就静默跳过 ✓。
 *
 * @returns {boolean} 是否发起了注册（守卫据此断言接线，不表示 Host 一定接受）。
 */
export function installWorkspaceRootsPrompt(ctx, service) {
	if (!ctx || typeof ctx.inject !== 'function' || !service || typeof service.workspaceContext !== 'function') {
		return false;
	}
	try {
		ctx.inject(['systemPrompt'], child => child.effect(() => {
			try {
				return child.systemPrompt.context({
					name: WORKSPACE_ROOTS_SECTION_NAME,
					order: WORKSPACE_ROOTS_SECTION_ORDER,
					text: promptContext => renderWorkspaceRootsText(
						service.workspaceContext(), { cwd: cwdOf(promptContext) },
					),
				});
			} catch (e) {
				// 幂等保护：Host 重复装配时同名段会抛 already registered（vssaros-memory 的先例）。
				// 注册失败只影响"模型看不看得见根"，不能拖垮 foundation 这个底座 ✓。
				if (!String(e?.message ?? e).includes('already registered')) {
					console.warn('[vssaros-foundation] workspace roots prompt unavailable:', String(e?.message ?? e));
				}
				return () => { };
			}
		}));
		return true;
	} catch {
		// 老 Host / 假 ctx 没有 inject 或 systemPrompt ⇒ 与"这条能力不存在"时完全一致 ✓
		return false;
	}
}
