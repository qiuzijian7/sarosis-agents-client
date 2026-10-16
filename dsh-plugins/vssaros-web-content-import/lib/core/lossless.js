/**
 * 返回值 → **lossless JSON** 归一（2026-10-15）。
 *
 * ## 为什么需要
 *
 * dsh 的工具输出校验器（`@deepseek-ai/dsh-tools` 的 `validateJsonSchemaValue` + `isJsonValue`）会**拒绝**
 * 含 `undefined` 属性 / 稀疏数组 / 非有限数（NaN、±∞、-0）/ bigint / 循环引用 的返回值，报
 * `tool "…" returned invalid output: value is not lossless JSON`。
 * 真机现场（2026-10-15）：本插件的 record 里 `meta.*`（title/author/date/description/cover/durationSec/…）
 * 与 `subtitles` 都可能是 `undefined` ⇒ 整条调用被判失败 ✗ —— 内容其实抓到了，只是形状不合法。
 *
 * ## 纪律
 *
 * · 这里是**唯一**归一点（`lib/index.js` 在注册前包住 `execute`，所有返回路径都过它）；
 * · **修值的形态，不改 schema**：缺的键本来就在 schema 里是可选 ⇒ 丢键 = 合法 ✓；
 * · 纯函数 ⇒ 可单测（`test/run-content-import-check.mjs`）。
 */

/** 内部哨兵：对象里遇到它就**丢键**；数组里遇到它压成 `null`（数组必须稠密 ✓）。 */
const DROP = Symbol('lossless-drop');

function normalize(value, seen) {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') { return value; }
	if (typeof value === 'number') {
		return Number.isFinite(value) && !Object.is(value, -0) ? value : null;
	}
	if (typeof value === 'bigint' || typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
		return DROP;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) { return null; }   // 循环引用 ⇒ 如实降级为 null（record 按构造不该有环；有环也比判死强 ✓）
		seen.add(value);
		const out = value.map(item => {
			const v = normalize(item, seen);
			return v === DROP ? null : v;
		});
		seen.delete(value);
		return out;
	}
	if (typeof value === 'object') {
		if (seen.has(value)) { return null; }
		seen.add(value);
		const out = {};
		for (const [key, child] of Object.entries(value)) {
			const nv = normalize(child, seen);
			if (nv !== DROP) { out[key] = nv; }
		}
		seen.delete(value);
		return out;
	}
	return DROP;
}

/**
 * 把任意返回值压成 lossless JSON（对象里 `undefined`/`function`/`symbol`/`bigint` ⇒ 丢键；
 * 数组里的同类 ⇒ `null`；NaN/±∞/-0 ⇒ `null`；循环引用 ⇒ `null`）。根值不可表示时返回 `null`。
 */
export function toLosslessJsonValue(value) {
	const out = normalize(value, new Set());
	return out === DROP ? null : out;
}
