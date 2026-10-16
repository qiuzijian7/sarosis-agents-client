// @vssaros/dsh-kb — 构建（ingest）预览的**纯逻辑**：零 I/O、零 dsh 依赖。
//
// 契约真源 = IDE 侧的 `KbImportController.collectPendingSources`
//（`src/vs/.../browser/knowledge/kbVaultFs.ts:97-122`，2026-10-12 逐行读过 ✓）。
// 本文件只覆盖 `mode: 'preview'`（**只读**）那半边 —— 真构建（起 agent 会话、写笔记）在 dsh 侧
// 尚未实现（见 doc/dsh-kb-port-design.html §4.4），传 `mode: 'build'` 会**明确报错**，不静默降级 ✓。
//
// 待构建（pending）的三条判据（照真源 ✓，顺序也照它）：
//   ① **入口集合**：`<vault>/库/` 下递归的 `*.md`，跳过**点开头**的文件/目录 ✓、跳过系统导航文件名 ✓；
//   ② **排除构建产出**：缓存（`.kb-build-cache.json`）的 **value**（= 已生成笔记的路径）不算素材 ✗
//      —— 否则会出现"笔记 → 笔记"的递归 churn ✓；
//   ③ **新鲜度**（★ 2026-09-24 的真源语义）：缓存无此素材 ⇒ 待构建；有缓存但**笔记不存在** ⇒ 待构建；
//      笔记存在但 **笔记 mtime < 素材 mtime**（素材在构建后又被改过）⇒ 待构建 ✓；否则算已构建 ✓。

/** 系统导航文件名（**照真源逐项**；`p3-08` 会拿 IDE 源码文本对账，改了这边就会红 ✓）。 */
export const SYS_INDEX_FILES = ['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md', '知识体系.md'];

/** 构建缓存文件名（真源 `readBuildCache`：`<vault>/.kb-build-cache.json`，形如 `{ 素材绝对路径: 笔记绝对路径 }`）。 */
export const BUILD_CACHE_FILE = '.kb-build-cache.json';

/** 「库」区目录名（与 `core/kb.js` 的 `LIBRARY_DIR` 同值，这里显式复述以免跨文件误改）。 */
export const LIB_DIR = '库';

/** 预览一次最多列多少条（照真源 `MAX_LISTED = 20` ✓：多素材时不要把整张清单灌进上下文 ✓）。 */
export const MAX_PREVIEW_LISTED = 20;

/** 扫描上限（防御性：库大到离谱时不至于把内存吃光；命中上限会**如实标注** ✓）。 */
export const MAX_LIB_SCAN = 20_000;

/** 文件名是否是系统导航文件（**区分大小写**，照真源的 `Set.has` ✓ —— 别顺手 lowercase ✗）。 */
export function isSystemNavFile(name) {
	return SYS_INDEX_FILES.includes(String(name ?? ''));
}

/**
 * 解析构建缓存文本。宽容策略照真源（读不动一律当空缓存 ✓），但**坏 JSON 要能说出来** ✓
 * （真源是静默 `catch { return {} }`；我们多带一个 note，因为"缓存坏了"会让 pending 全量复活，
 *  用户看到"要重建 200 篇"时必须知道是缓存坏了、而不是素材真的都变过 ✓）。
 * @returns `{ cache, note? }`
 */
export function parseBuildCache(text) {
	let raw;
	try {
		raw = JSON.parse(String(text ?? ''));
	} catch (e) {
		return { cache: {}, note: `构建缓存不是合法 JSON（${String(e?.message ?? e)}）⇒ 已按空缓存处理` };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { cache: {}, note: `构建缓存不是对象（${Array.isArray(raw) ? 'array' : typeof raw}）⇒ 已按空缓存处理` };
	}
	const cache = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string' && value) {
			cache[key] = value;
		}
	}
	return { cache };
}

/**
 * 按真源口径分类候选素材。
 *
 * @param {{
 *   files: readonly { path: string, mtime?: number }[],
 *   cache: Record<string, string>,
 *   noteMtimeOf: (notePath: string) => number | undefined,
 * }} input
 *   `files` = 入口集合（已按"递归、跳过点开头、跳过系统导航文件"筛过 ✓）；
 *   `noteMtimeOf` 返回 `undefined` 表示**笔记不存在**（与"mtime=0"区分开 ✓）。
 * @returns `{ pending: {path, reason}[], counts }` —— `pending` 按 `path` 稳定排序（同输入同输出 ✓）
 */
export function classifyPending({ files, cache, noteMtimeOf }) {
	// ② 已产出的笔记集合：**大小写折叠**（照真源 `Object.values(cache).map(p => p.toLowerCase())` ✓）
	const outputs = new Set(Object.values(cache ?? {}).map(value => String(value).toLowerCase()));
	const pending = [];
	const counts = { candidates: files.length, skippedOutputs: 0, skippedFresh: 0, noteMissing: 0, sourceNewer: 0 };
	for (const file of files) {
		const path = String(file.path);
		if (outputs.has(path.toLowerCase())) {
			counts.skippedOutputs++;
			continue;
		}
		// ⚠ 缓存的 key 查找**不做大小写折叠**（照真源 `cache[f.fsPath]` ✓）—— 只折叠 outputs 那一处 ✓
		const notePath = cache?.[path];
		if (!notePath) {
			pending.push({ path, reason: '未构建' });
			continue;
		}
		const noteMtime = noteMtimeOf(notePath);
		if (noteMtime === undefined) {
			counts.noteMissing++;
			pending.push({ path, reason: '笔记不存在（缓存里还记着）' });
			continue;
		}
		if (noteMtime >= (Number.isFinite(file.mtime) ? file.mtime : 0)) {
			counts.skippedFresh++;
			continue;
		}
		counts.sourceNewer++;
		pending.push({ path, reason: '素材在构建后被改过' });
	}
	pending.sort((a, b) => a.path.localeCompare(b.path));
	return { pending, counts };
}
