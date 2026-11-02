/*
 * 知识库**元数据目录**的唯一真源（★ 2026-11-02，用户：「这些中间文件应该仿 obsidian 放到一个文件夹中」）。
 *
 * 以前这些文件全散在库根：
 *   .kbkernel.json / .feishu-sync.json / .feishu-space-map.json / .kb-layout.json
 *   .kb-build-cache.json / .kb-ingest-cache.json / .kb-html-cache/ …
 * 现在统一收进 `<vault>/.kb/`（点开头 ⇒ 视图的 `isNoise` 会过滤，不出现在树里 ✓）：
 *
 *   <vault>/.kb/
 *   ├── kernel.json              索引（FTS）
 *   ├── ftindex.json             旧版全文索引（只读兼容）
 *   ├── feishu-sync.json         飞书同步映射（**绝对不能丢**）
 *   ├── space-map.json           空间 id → 名字
 *   ├── layout.json              布局标记
 *   ├── build-cache.json         构建缓存
 *   ├── ingest-cache.json        导入去重
 *   ├── insights-cache.json      洞察摘要缓存
 *   ├── topic-overview-cache.json 主题概览缓存
 *   ├── schema.json              类型体系（可自定义）
 *   ├── op-log.jsonl             操作日志
 *   └── html-cache/              正文 HTML 渲染缓存
 *
 * 兼容策略（**双读**，避免"改了路径老库读不到"）：
 *   读：新位置存在 → 用新的；否则退回库根旧名（`LEGACY`）；都没有 ⇒ 返回新路径（供写入用）
 *   写：一律写新位置（写前 `ensureMetaDir`）
 *
 * ⚠ 别在业务代码里再写字面量路径 —— 一律用这里的常量 / 函数（真源只有这一份）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 元数据目录名（点开头：树里不显示，Obsidian 的 `.obsidian/` 同一思路） */
export const META_DIR = '.kb';

/** 目录内的标准文件名（相对 `.kb/`） */
export const META_NAME = {
	kernel: 'kernel.json',
	ftindex: 'ftindex.json',
	feishu: 'feishu-sync.json',
	spaceMap: 'space-map.json',
	layout: 'layout.json',
	buildCache: 'build-cache.json',
	ingestCache: 'ingest-cache.json',
	insightsCache: 'insights-cache.json',
	topicCache: 'topic-overview-cache.json',
	schema: 'schema.json',
	opLog: 'op-log.jsonl',
	htmlCache: 'html-cache',
	/** ★ 2026-11-02：自动生成的导航笔记（index/overview/insights/log）落在这里 */
	nav: 'nav',
};

/** 老位置（库根散件）——**只读兼容**用，写入一律走新位置 */
export const META_LEGACY_NAME = {
	kernel: '.kbkernel.json',
	ftindex: '.ftindex.json',
	feishu: '.feishu-sync.json',
	spaceMap: '.feishu-space-map.json',
	layout: '.kb-layout.json',
	buildCache: '.kb-build-cache.json',
	ingestCache: '.kb-ingest-cache.json',
	insightsCache: '.kb-insights-cache.json',
	topicCache: '.kb-topic-overview-cache.json',
	schema: 'kb-schema.json',            // 历史原因：一个在根下、没点前缀
	opLog: '.op-log.jsonl',
	htmlCache: '.kb-html-cache',
};

/**
 * 相对库根的**路径串**（如 `.kb/kernel.json`）。
 * 给那些需要"字符串常量"的地方用（例如 `export const KERNEL_FILE`），
 * 这样 `join(vaultDir, KERNEL_FILE)` 天然落到 `.kb/` 下。
 */
export const META_REL = Object.fromEntries(
	Object.keys(META_NAME).map((k) => [k, META_DIR + '/' + META_NAME[k]]),
);

/** `<vault>/.kb` 绝对路径 */
export function metaDir(vaultDir) {
	return join(String(vaultDir || ''), META_DIR);
}

/** `<vault>/.kb/<标准名>` 绝对路径（**不判断存在性**，用于写入） */
export function metaPath(vaultDir, key) {
	if (!META_NAME[key]) { throw new Error('未知的元数据键：' + key); }
	return join(String(vaultDir || ''), META_DIR, META_NAME[key]);
}

/** 老位置绝对路径（库根散件） */
export function metaLegacyPath(vaultDir, key) {
	if (!META_LEGACY_NAME[key]) { throw new Error('未知的元数据键：' + key); }
	return join(String(vaultDir || ''), META_LEGACY_NAME[key]);
}

/**
 * **读**用：新位置优先，其次老位置，都没有就返回新路径（调用方据此判断 existsSync=false）。
 */
export function resolveMetaPath(vaultDir, key) {
	const next = metaPath(vaultDir, key);
	if (existsSync(next)) { return next; }
	const old = metaLegacyPath(vaultDir, key);
	return existsSync(old) ? old : next;
}

/**
 * `<vault>/.kb/nav` —— 自动生成的导航笔记目录（★ 2026-11-02）。
 *
 * 为什么连这几个也搬进来：它们是**每次写入后重新生成**的派生物
 * （`index.md` / `overview.md` / `insights.md` / `log.md`），但以前落在
 * `知识库列表/` 根下 ⇒ 左侧树里看起来像"用户笔记"，还会被搜索/统计带上。
 * 搬进 `.kb/nav/` 后：树里不显示、扫描时天然跳过（点开头目录）、位置和其余元数据一致。
 *
 * @param {string} vaultDir 库根
 */
export function navDir(vaultDir) {
	return join(String(vaultDir || ''), META_DIR, META_NAME.nav);
}

/** 确保 `.kb/` 存在（**所有写入前必须调**：`writeFile` 不会自动建父目录） */
export function ensureMetaDir(vaultDir) {
	const d = metaDir(vaultDir);
	try { mkdirSync(d, { recursive: true }); } catch { /* 只读盘：让调用方的写入自己失败并给出可读错误 */ }
	return d;
}

/** 全部键（迁移脚本用） */
export const META_KEYS = Object.keys(META_NAME);
