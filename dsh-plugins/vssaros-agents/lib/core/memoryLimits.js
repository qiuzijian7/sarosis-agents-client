// @vssaros/dsh-agents — 记忆注入口径的**单一真源**（2026-10-20 抽自 lib/memory.js）。
//
// 为什么单独一个叶子模块：
//   同一套口径原先分散在**三处**解析（`core/agents.js` 读 frontmatter、`core/create.js` 校验草稿、
//   `lib/memory.js` 夹值）⇒ 改一处忘一处时，页面显示的上限与实际注入的上限会静默分叉（这类
//   "看起来配好了"的失败最难查 ✗）。放叶子模块（零依赖）还有一个硬约束：`core/agents.js` 被
//   `store.js` 依赖 ⇒ 它**不能**回头 import `memory.js`（会成环），所以真源必须是叶子。

/** `memory-chars` 缺省值（= 原先的 SNAPSHOT_CHARS；单位是**字符**，不是字节）。 */
export const MEMORY_CHARS_DEFAULT = 2048;
/** `memory-chars` 的取值范围（0 = 关闭注入，单独允许）。 */
export const MEMORY_CHARS_MIN = 512;
export const MEMORY_CHARS_MAX = 20000;

/**
 * 归一化 `memory-chars`：非法/缺省 → 默认值；`<= 0` → 0（关闭）；其余夹到 [MIN, MAX]。
 *
 * ⚠ 这里**只归一化，不报错**：读 frontmatter 的场景（`agentFromFile`）必须容错 —— 一个手写笔误
 *   不该让 agent 整个消失。要报错的是**写入口**（`setAgentMemoryLimits` / 向导校验），它们用
 *   MIN/MAX 自己做范围检查。
 */
export function clampMemoryChars(value) {
	const text = typeof value === 'string' ? value.trim() : value;
	// 空串 / null / undefined 一律当「没写」⇒ 用默认值。
	// ⚠ 别让它们落到 `Number('') === 0`：那会把一个裸写的 `memory-chars:` 变成「关闭注入」，
	//   而用户的意思是"用默认"（零配置的 agent 就这么被静默关掉了）。
	if (text === '' || text === undefined || text === null) {
		return MEMORY_CHARS_DEFAULT;
	}
	const n = typeof text === 'string' ? Number(text) : text;
	if (typeof n !== 'number' || !Number.isFinite(n)) {
		return MEMORY_CHARS_DEFAULT;
	}
	if (n <= 0) {
		return 0;
	}
	return Math.min(MEMORY_CHARS_MAX, Math.max(MEMORY_CHARS_MIN, Math.trunc(n)));
}

/** 归一化 `memory-mode`：只认 `live`，其余一律 `session`（缺省 = 会话内冻结）。 */
export function normalizeMemoryMode(value) {
	return String(value ?? '').trim().toLowerCase() === 'live' ? 'live' : 'session';
}

/**
 * 归一化**用户输入**的 mode：空 → `''`（= 没写这一行），`live`/`session` 原样，其它 → `''`。
 * 与 {@link normalizeMemoryMode} 的区别是保留"没写"这个状态（向导/CLI 不写这一行用）。
 */
export function parseMemoryModeInput(value) {
	const m = String(value ?? '').trim().toLowerCase();
	return m === 'live' || m === 'session' ? m : '';
}

/**
 * 从 `.agent.md` 的 frontmatter（键值对）解析记忆口径。
 *
 * 返回 `{ chars, mode }`：
 *   · `chars` = `undefined` 表示**没写**（下游按默认 2048 处理，与"写了 2048"可区分 ——
 *     `toPresetDefinition` 只在写了的情况下才把值塞进 preset config）；
 *   · `mode` 已归一，恒为 `'session' | 'live'`。
 */
export function parseMemoryLimits(meta) {
	const charsText = String(meta?.['memory-chars'] ?? '').trim();
	const charsNum = charsText === '' ? NaN : Number(charsText);
	return {
		chars: Number.isFinite(charsNum) ? charsNum : undefined,
		mode: normalizeMemoryMode(meta?.['memory-mode']),
	};
}
