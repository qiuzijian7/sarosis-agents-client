// @vssaros/dsh-kb — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源 = **本机真实 vault 的形态**（不是文档推测）：
//   <数据根>/knowledge-base/<vaultId>/
//     ├── 笔记/                      笔记（markdown）
//     ├── 库/<分类>/<标题>.md        资料库正文（分类目录是中文，如 概念/对比）
//     └── .kbkernel.json             索引：{ v, docs: [{ uri, title, type, created, tags, length, size, mtime }], avgLen, totalDocs }
//   另见 `src/vs/.../knowledge/knowledgeStorage.ts`（`<root>/<id>/…`）与 `kbSchema.ts`（每个 vault 的 `kb-schema.json` 类型体系，默认目录名 `库/raw`、`笔记`）。
//
// 本模块 v0 **只读**：索引读 `.kbkernel.json`，正文按 uri 读文件（带路径围栏）。
// 不猜字段：kernel 里没有的键一律不假设（缺 docs 就按空 vault 处理并记一条 note）。

import { fileNameOf } from './kbFulltext.js';

/** 每个 vault 的索引文件名。 */
export const KERNEL_FILE = '.kbkernel.json';

/**
 * 同一份序列化的**另一处落盘**（市场包导入路径会复制一份：`knowledgeBaseView.ts:4867`）。
 * 本轮实测：dev 库里它与同库的 `.kbkernel.json` **同样大小**（内容相同）⇒ 读不到 kernel 时它是
 * 合理的第二候选（不是"另一个格式"，就是同一份 ✓）。
 */
export const FTINDEX_FILE = '.ftindex.json';

/** 单个正文文件的最大读取字节数（防止一刀切把巨型文档塞进上下文）。 */
export const MAX_DOC_BYTES = 200_000;

/** 搜索时最多扫描的 doc 条数（索引很大时的保护）。 */
export const MAX_SCAN = 20_000;

/** vault 目录名形态：`yyyyMMddHHmmss-<随机>`（`_archive` / `favorites` / `notes` 等非 vault 目录会被排除）。 */
const VAULT_ID_RE = /^\d{8,14}-[a-z0-9]+$/i;

/** HTML 转义（页面是服务端渲染；库里的标题/路径都可能带尖括号）。 */
export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function isVaultId(name) {
	return VAULT_ID_RE.test(String(name ?? ''));
}

/**
 * 解析一个 vault 的 kernel 索引。
 * 返回 `{ docs, totalDocs, notes[] }`；坏文件**不静默**（带 note），但不影响其它 vault。
 *
 * `withText: true` ⇒ 把 `text`（正文）一并带出（**只给正文检索用**；页面不读它：
 * 大库的 text 是几 MB，页面根本用不上，白占内存 ✗）。
 */
export function parseKernel(text, { withText = false } = {}) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { docs: [], totalDocs: 0, notes: [`kernel 不是合法 JSON：${String(e?.message ?? e)}`] };
	}
	if (!raw || typeof raw !== 'object') {
		return { docs: [], totalDocs: 0, notes: [`kernel 顶层不是对象：${typeof raw}`] };
	}
	const notes = [];
	if (raw.v !== undefined && raw.v !== 1) {
		notes.push(`kernel 版本 v=${String(raw.v)}（本模块按 v1 解析）`);
	}
	const docsRaw = Array.isArray(raw.docs) ? raw.docs : [];
	if (raw.docs !== undefined && !Array.isArray(raw.docs)) {
		notes.push(`kernel.docs 不是数组（${typeof raw.docs}）→ 按空处理`);
	}
	const docs = docsRaw.slice(0, MAX_SCAN).map(doc => normalizeDoc(doc, { withText })).filter(Boolean);
	const totalDocs = typeof raw.totalDocs === 'number' && Number.isFinite(raw.totalDocs) ? raw.totalDocs : docs.length;
	return { docs, totalDocs, notes, avgLen: typeof raw.avgLen === 'number' ? raw.avgLen : undefined };
}

/** 去掉 `.md` / `.markdown` 扩展名（**只去这两个**：其它扩展名去掉会让人认不出文件类型）。 */
function stripMarkdownExt(name) {
	return String(name).replace(/\.(md|markdown)$/i, '');
}

/**
 * 索引里的一条文档（只取真实存在的键；`uri` 是主键）。
 *
 * ★ 2026-10-12（订正一处既有缺陷）：`.kbkernel.json` 在真实机器上有**两种形态** ——
 *   元数据形态（`uri/title/type/created/tags/length/size/mtime/text`，生产库是这种 ✓）与
 *   FTS 形态（`uri/name/path/section/mtime/size/length/tags/text`，dev 库是这种 ✓，实测）。
 *   原先这里只认 `title` ⇒ 在 FTS 形态的库上**标题退回整条 uri 的末段（含 .md）**、`type` 全无 ✗。
 *   现在：`title` 缺失时用 `name`（去掉 md 扩展名）兜底 ✓ —— 兜底的是**同一件事的另一个字段名**，
 *   不是猜（`name` 就是文件名，IDE 的索引条目里它叫 `name` ✓）。
 *   `section` 如实带出（`library` / `notes`）；**不把它硬塞进 `type`** ✗（那是另一个概念，猜就是编）。
 */
export function normalizeDoc(raw, { withText = false } = {}) {
	if (!raw || typeof raw !== 'object' || typeof raw.uri !== 'string' || !raw.uri) {
		return undefined;
	}
	const fileName = typeof raw.name === 'string' && raw.name ? raw.name : fileNameOf(raw.uri);
	return {
		uri: raw.uri,
		name: fileName,
		title: typeof raw.title === 'string' && raw.title ? raw.title : stripMarkdownExt(fileName),
		type: typeof raw.type === 'string' ? raw.type : undefined,
		created: typeof raw.created === 'string' ? raw.created : undefined,
		section: typeof raw.section === 'string' ? raw.section : undefined,
		tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string') : [],
		length: typeof raw.length === 'number' ? raw.length : undefined,
		size: typeof raw.size === 'number' ? raw.size : undefined,
		mtime: typeof raw.mtime === 'number' ? raw.mtime : undefined,
		...(withText && typeof raw.text === 'string' ? { text: raw.text } : {}),
	};
}

/**
 * 索引内检索：匹配 title / tags / type / uri 路径。
 * 纯函数、结果稳定（先按命中字段权重、再按 mtime 倒序、最后按 title，保证同输入同输出——护 KV cache）。
 */
/**
 * 目录摘要的文件名（与 IDE 侧 `knowledge/topicOverviews.ts` 的常量同值；产物由「构建笔记」生成）。
 */
export const TOPIC_OVERVIEW_FILE = '.overview.md';
/** 单条目录摘要的**字符上限**（300 也是 IDE 那份实现定的）。 */
export const OVERVIEW_SUMMARY_LIMIT = 300;
/** library 区目录名（IDE `KB_SECTION_LABEL.library`）：目录摘要在它的**直接子目录**里。 */
export const LIBRARY_DIR = '库';
/** 「笔记」区目录名（2026-10-13 补：构建缓存登记要扫它 ⇒ 与 LIBRARY_DIR 一样收进 core 常量 ✓）。 */
export const NOTES_DIR = '笔记';

/** 随包内置的同步脚本在包内的相对路径（真源是 `resources/.agents/kb/feishu-sync.mjs`；有守卫钉住字节一致）。 */
export const FEISHU_SYNC_SCRIPT = 'scripts/feishu-sync.mjs';

/**
 * 组装 `feishu-sync.mjs` 的命令行参数——**纯函数**（这是本工具唯一"被设计成什么样"的地方，值得单测）。
 *
 * 两条硬口径：
 *  1. **默认 dry-run**：与脚本自身"不显式 `--apply` 一律 dry-run"的安全默认**同向**，但这里**显式写**
 *     `--dry-run`——将来脚本默认值若改了，我们不会跟着悄悄变成"真写远端"；
 *  2. `--plan-file` **必带**：脚本会写一份**本次**报告（dry-run 也写），工具读它回报。不带就只能读日志尾部，
 *     而 dry-run **从不写日志**（脚本注释里记着这个坑：预览时只能拿到旧日志）。
 */
export function buildFeishuSyncArgs({ vault, src = [], apply = false, limit = 0, onConflict = '', planFile = '', cliPath = '' } = {}) {
	const args = ['--vault', String(vault ?? '')];
	if (cliPath) {
		// 与 IDE 的 `sessions.agentStudio.kb.feishu.cliPath` 同一个语义（装在非标准位置时用）
		args.push('--cli', String(cliPath));
	}
	for (const dir of src) {
		const trimmed = String(dir ?? '').trim();
		if (trimmed) {
			args.push('--src', trimmed);
		}
	}
	args.push(apply === true ? '--apply' : '--dry-run');
	if (Number.isFinite(limit) && limit > 0) {
		args.push('--limit', String(Math.floor(limit)));
	}
	if (onConflict) {
		args.push('--on-conflict', String(onConflict));
	}
	if (planFile) {
		args.push('--plan-file', String(planFile));
	}
	return args;
}

/**
 * 目录摘要正文的规范化——**与 IDE 的 `_readOverviewBody` 逐字符一致**：
 * 逐行 trim → 丢掉空行 / `#` 标题行 / `>` 引用说明行 → **用空格连成一行** → 去首尾 → 截到 300 字。
 *
 * 为什么照抄而不是"写得好看一点"：同一个 `.overview.md` 在 IDE 与 dsh 两侧都会被展示，
 * 口径不同就会变成"同一个库两套摘要"；连 300 这个数字与"用空格而不是换行"都是那份实现定的。
 * 返回空串表示"这个目录没有有效摘要"（调用方按"没有摘要"处理，不要当成错误）。
 */
export function normalizeOverview(raw) {
	return String(raw ?? '')
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && !line.startsWith('#') && !line.startsWith('>'))
		.join(' ')
		.trim()
		.slice(0, OVERVIEW_SUMMARY_LIMIT);
}

export function searchDocs(docs, { query = '', type = '', tag = '', limit = 20 } = {}) {
	const q = String(query ?? '').trim().toLowerCase();
	const wantedType = String(type ?? '').trim().toLowerCase();
	const wantedTag = String(tag ?? '').trim().toLowerCase();
	const scored = [];
	for (const doc of docs) {
		if (wantedType && (doc.type ?? '').toLowerCase() !== wantedType) {
			continue;
		}
		if (wantedTag && !doc.tags.some(t => t.toLowerCase() === wantedTag)) {
			continue;
		}
		let score = 0;
		const title = doc.title.toLowerCase();
		const uri = doc.uri.toLowerCase();
		if (q) {
			if (title === q) {
				score += 100;
			} else if (title.includes(q)) {
				score += 50;
			}
			if (doc.tags.some(t => t.toLowerCase().includes(q))) {
				score += 30;
			}
			if (uri.includes(q)) {
				score += 10;
			}
			if (score === 0) {
				continue;
			}
		}
		scored.push({ doc, score });
	}
	scored.sort((a, b) => (b.score - a.score) || ((b.doc.mtime ?? 0) - (a.doc.mtime ?? 0)) || a.doc.title.localeCompare(b.doc.title));
	const capped = Math.min(MAX_SCAN, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 20));
	return scored.slice(0, capped).map(entry => entry.doc);
}
