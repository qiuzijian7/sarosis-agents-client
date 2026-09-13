/*---------------------------------------------------------------------------------------------
 *  发布前的「本地态剥离」（2026-09-13 修发布泄露面）。
 *
 *  问题：`WorkflowInstaller.preparePack` 此前 `JSON.stringify(workflow)` **整份上传** ✗ ——
 *  节点属性里的**本地生成物**会一起进包：
 *    · `data:` 大图（`comfytv_image_refs` / 快照 ref，单张数百 KB~数 MB ✗）——对下载方
 *      **无意义**（那是本机生成的 ✓），纯属泄露 + 撑爆包体 ✗；
 *    · **本机绝对路径**（媒体库根目录 `E:\…`、`/Users/…` ✗）——泄露本机目录结构 ✗。
 *
 *  本模块只做「**无歧义的剥离**」✓：`data:` 前缀与绝对路径模式**不可能**是跨机有效的
 *  内容 ✓，剥掉它们不会误伤合法配置 ✓。**完整白名单**是产品决策 ✗（哪些字段算内容），
 *  不在本模块范围内。
 *
 *  纯函数（无 IO），可单测 ✓。
 *--------------------------------------------------------------------------------------------*/

/** 发布包体上限（字节）。超过它几乎必然是「把本地生成物打进去了」✗。 */
export const MAX_PUBLISH_BYTES = 5 * 1024 * 1024;

/** 是否 `data:` 内联资源（本地生成物，跨机无意义 ✗）。 */
export function isInlineDataUrl(v: unknown): boolean {
	return typeof v === 'string' && /^data:[^,]*,/i.test(v);
}

/**
 * 是否**本机绝对路径**。只认明确形态，避免误伤相对路径 / URL ✓：
 *  · `C:\…` / `C:/…`（盘符）
 *  · `\\server\share`（UNC）
 *  · `/Users/…`、`/home/…`、`/root/…`（Unix 家目录 —— 刻意**不**匹配任意 `/…`，
 *    因为那会把 `/api/v1` 这类**合法配置**也剥掉 ✗）
 */
export function isLocalAbsolutePath(v: unknown): boolean {
	if (typeof v !== 'string' || v.length === 0) { return false; }
	return /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v) || /^\/(Users|home|root)\//.test(v);
}

export interface ISanitizeResult<T> {
	/** 剥离后的副本（**不改原对象** ✓ —— 调用方可能还要用原件）。 */
	value: T;
	/** 被剥离的字段路径（如 `nodes[3].data.image`），供日志 / 用户提示 ✓。 */
	stripped: string[];
}

/**
 * 递归剥离「本地态」字段。剥离策略：
 *  · `data:` 字符串 → 整个值删除（对象属性 `delete`、数组元素置 `''` 保留下标 ✓ ——
 *    置 `''` 而非 splice：数组下标常与语义绑定（如按格序 ✓），删元素会**错位** ✗）；
 *  · 本机绝对路径 → 置 `''`（保留键，避免"字段缺失"引发下游解析异常 ✗）。
 */
export function sanitizeForPublish<T>(input: T): ISanitizeResult<T> {
	const stripped: string[] = [];

	const walk = (node: unknown, path: string): unknown => {
		if (Array.isArray(node)) {
			return node.map((item, i) => {
				const childPath = `${path}[${i}]`;
				// ★ 数组元素**本身**就是本地态（如 `refs: ['data:…', 'keep.png']`）→ 置 `''` 保下标 ✓。
				//   （对象属性里的本地态走下方 `delete` ✓ —— 那条路不改变数组长度 ✓。）
				//   置 `''` 而非 splice：数组下标常与语义绑定（按格序 ✓），删元素会**错位** ✗。
				if (isInlineDataUrl(item) || isLocalAbsolutePath(item)) { stripped.push(childPath); return ''; }
				return walk(item, childPath);
			});
		}
		if (node && typeof node === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
				const childPath = path ? `${path}.${k}` : k;
				if (isInlineDataUrl(v)) { stripped.push(childPath); continue; }        // 删除键
				if (isLocalAbsolutePath(v)) { stripped.push(childPath); out[k] = ''; continue; }
				out[k] = walk(v, childPath);
			}
			return out;
		}
		return node;
	};

	// 顶层数组元素若被剥离，walk 返回 '' ✓（保下标）；顶层对象属性直接删除 ✓。
	return { value: walk(input, '') as T, stripped };
}
