// @vssaros/dsh-kb — host half：知识库（vault）自托管页面 + 只读工具。
//
// 本模块是 `agentStudio.knowledgeBase` 容器的**宿主**（容器显示名「知识库」）：
//   - 自己声明 activityBar 与页面路由（`/x/kb`），`legacyCounterpart: agentStudio.knowledgeBase`；
//   - **只提供知识库自己的界面**（文件 / 索引浏览，只读）。
//
// ★ 2026-10-12（「资料库」拆分）：本页原先还内嵌 memory 模块的片段（`view.kind=section` +
//   `/x/memory/section`，即"决议① kb / memory 共容器"）—— 记忆升为独立工作台后
//   （`agentStudio.memory`，页面 `/x/memory/`），**内嵌与那条片段路由一并删除**：
//   现在四个工作台各自一个宿主页，不再有跨模块内嵌，`view.kind=section` 只剩 mcp 一处（寄居 skills）。
//
// 数据：`~/.vssaros/knowledge-base/<vaultId>/`（`笔记/`、`库/<分类>/*.md`、`.kbkernel.json` 索引）。**只读**。

import { spawn } from 'node:child_process';
import { bindFoundation } from './foundationRef.js';
// ★ codicon 子集（2026-10-19）：页面原本用 emoji 当图标（彩色、不吃 color、字号随系统 emoji 字体飘），
//   与原资料库（IDE 侧 kbView 用 codicon 字体）对不上 ⇒ 把 24 个字形子集化成 woff2 并 base64 内联随包
//   （`scripts/build-codicon-subset.py` 生成，约 3 KB）。页面 CSS 里拼 `CODICON_FONT_CSS`，
//   图标位一律用 codicon(字形名) 出 span（scripts/check-codicon-subset.mjs 守着"引用 ⊆ 子集" ✓）。
//   详见 lib/codiconSubset.js 头部的许可说明（含 CC BY 署名）。
import { CODICON_FONT_CSS, codicon } from './codiconSubset.js';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename as renameFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
// ★ 2026-10-20：**同步**读 roots overlay（见 readKbVaultsFromOverlay 的注释 ——
//   `externalVaultRecords` 是同步函数、被 20+ 处调用 ⇒ 不能改成 async）。
import { readFileSync, readdirSync, statSync } from 'node:fs';

// `.cmd`/`.bat` shim 的**同步**探测（见 `runLarkCli` 的 error 处理：那里不能 await ✗）
import { existsSync } from 'node:fs';

import { createHash } from 'node:crypto';

import { homedir, tmpdir } from 'node:os';

import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { fileURLToPath } from 'node:url';


// ★ 复刻（§15.38）：分区改成「库」/「笔记」两节 ⇒ 两边的目录名都要（`NOTES_DIR` 是这轮补进 import 的 ✓，
//   漏了它会在渲染期 `ReferenceError` ⇒ 页面直接 500 ✗）。
import { escapeHtml, isVaultId, searchDocs, FEISHU_SYNC_SCRIPT, LIBRARY_DIR, NOTES_DIR, MAX_DOC_BYTES, TOPIC_OVERVIEW_FILE, buildFeishuSyncArgs } from './core/kb.js';

// ★ 2026-10-25：服务端 Markdown 渲染（markdown-it + Obsidian 方言；vendor 已随包）
import { renderMarkdownHtml } from './md/render.js';
// 2026-10-26：mermaid 改用仓库已有的 **pele** 引擎（同步、零 DOM ⇒ 服务端可渲染）。
// 与 IDE 侧 `peleDiagramRenderer.ts`、dsh Host 的 `render_diagram` 同一份产物。
// 拿不到引擎时 `renderMermaidSvg` 返回空串 ⇒ 渲染器保留源码块（不吞内容）。
import { renderMermaidSvg } from './md/pele.js';

// 正文检索（`kb_search mode=fulltext`）：口径逐字照 IDE 侧 `kbIndex.ts`，见 core/kbFulltext.js 文件头。
import { searchFulltext } from './core/kbFulltext.js';
// 重构 4：语义检索（读壳侧落盘的 .kvindex + cosine 线性扫描）+ 建半（分块 + 序列化）。
import { chunkMarkdown, deserializeVectorIndexBinary, searchVectorIndex, serializeVectorIndexBinary } from './core/kbVectorStore.js';

// 构建预览（`kb_build mode=preview`）：口径照 IDE 侧 `collectPendingSources`，见 core/kbIngest.js 文件头。
import { MAX_PREVIEW_LISTED } from './core/kbIngest.js';

// 批授权（`kb_build mode=build` 那张唯一的审批卡）：三条不变式见 core/kbBatchGrant.js 文件头。
import { DEFAULT_BATCH_LIMIT, GRANT_TTL_MS, clampBatch, consumeGrant, describeGrant, grantAllows, openGrant } from './core/kbBatchGrant.js';

import { DEFAULT_LARK_CLI, LARK_CLI_MISSING_HINT, SPACE_LIST_ARGS, findSameNameSpace, parseCreatedSpaceId, parseSpaceList, sanitizeSpaceName, spaceCreateArgs } from './core/feishuSpaces.js';

// ★ 页面那唯一一条写路由（§15.33）**复用工具同款围栏** ✓：`resolveOrganizePath` 早就把
//   "只能在「笔记」区内"判死了（真源 `kbOrganizeTools.ts` 的口径 ✓）⇒ 不另写一套判断 ✓。
import { MAX_OPS, planCounts, resolveOrganizePath } from './core/kbOrganize.js';

// 飞书**云文档（读侧）**（§R.7 第 ⑤ 项的落地 ✓）：与 `kb_feishu_sync` 共用同一个 lark-cli 依赖 ✓，
// 方向相反（本地资料库 ↔ 飞书文档 ✓）。真源 `feishuDriveTools.ts`，此处只做**只读三件** ✓。
import { buildAddCommentArgs, buildAddReplyArgs, buildDocReadArgs, buildListCommentsArgs, buildListRepliesArgs, buildReplyElements, describeCliFailure, isCliFailure, parseDocFetch, parseLarkItems, parseDocTarget, summarizeEntry } from './core/feishuDocs.js';

// 写路径**单独一个文件** ✓（`store.js` 的不变量是"只读" ✗，把写操作混进去那条就不作数了 ✓）
import { MAX_NOTE_CHARS, applyGating, enrichNotes, maintainNavigation, readNotesForGraph, makeDir, restoreFromBackup, runOrganize, uniqueChildName, writeNote } from './organize.js';

// FTS 内核缓存重建（§16.6）：写完之后让检索/页面立刻看到新数据 ✓（写点都在 refreshDerived 里 ✓）
import { kernelStaleCheck, rebuildKernelCache } from './core/kbKernelBuild.js';

// P2 素材转文本（§16.12）：PDF → 同名 .md（python ＋ 随包脚本 ✓），挂在 kb_build 的枚举之前 ✓
import { resolvePythonPath, stageDocSourcesToText } from './core/kbDocExtract.js';

// P4 思维导图（§16.14）：确定性半逐字照真源（黄金表 p3-83 ✓）；LLM 那半走 subagent（提示词逐字 ✓）
import {

	deriveMindmapTitle, extractGraphPrompt, listMindmaps, mergeAndSaveMindmap, mergeMindmapFiles, mergeRefined,
	parseExtractedGraph, parseRefinedGraph, pickMindmapForOpen, readMindmap, refineGraphPrompt, relayoutMindmap, suggestTitlePrompt,
	titleFromSuggestion, uniqueCanvasPath, writeMindmap,
} from './core/kbMindmap.js';
import { SYS_INDEX_FILES } from './core/kbIngest.js';

import { MIN_DISTINCT_SOURCES } from './core/kbGating.js';

// 跨进程写锁（协议 v2，与 workflow / kanban / IDE 同一套 ✓；实现是**逐字复制**的一份副本 ——
// 插件之间不能互相 import ✓，包各自独立 ✓）。互通性由 `dshWorkflowWriteLock.test.ts` 拿**真文件互抢**验证 ✓。
import { acquireFileLock, lockFileFor } from './lock.js';

// 页面外壳（标题 / 工具条 / 分区 / 空态 / 诊断行）逐条移植自 VsSaros 原容器 Pane，
// 见 `lib/pageShell.js` 顶部注释（真源行号 + 分发约定）。
import { renderShell } from './pageShell.js';
// ★ 2026-10-19：关系图谱页面（从 IDE 侧迁来；`/x/kb/graph`）
import { renderGraphPage } from './graphPage.js';
// ★ 2026-10-19：「当前目录」的持久化 + 写笔记路径兜底（见 core/kbActiveDir.js 文件头）
import { applyActiveDir, readActiveDir, readActiveVault, writeActiveDir } from './core/kbActiveDir.js';
// ★ 2026-10-19：图数据构建（纯函数，节点 id = vault 相对路径）。**漏过这一行** ⇒ `/api/graph` 会
//   `buildGraphData is not defined`（由新守卫 `scripts/check-plugin-scope.mjs` 抓到，不是靠人眼）。
import { buildGraphData } from './core/kbGraphData.js';

import { MAX_TOPIC_OVERVIEWS, catalogDescriptions, countFiles, dataRootOf, fulltextIndexes, kbRootOf, listTopicOverviews, listVaults, listVaultTree, noteCatalog, pageSnapshotOf, previewBuild, readDoc, registerBuildCacheEntries } from './store.js';


/** 随包内置的同步脚本绝对路径（真源 `resources/.agents/kb/feishu-sync.mjs`，副本由守卫钉住字节一致）。 */
const FEISHU_SCRIPT_PATH = fileURLToPath(new URL(`../${FEISHU_SYNC_SCRIPT}`, import.meta.url));
/** 一次同步最多回多少字符（报告可能很长；截断要如实标记）。 */
const FEISHU_REPORT_LIMIT = 20_000;
/** 同步的等待上限：dry-run 也要读远端，慢起来没边。 */
const FEISHU_SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 跑同步脚本。**用 Host 自己的 node**（`process.execPath`）——不假设 PATH 里有 node（Host 可能装在别处）。
 * 返回 `{code, output}`：`code` 是退出码（脚本对"部分失败"可能仍然 0，逐篇结果在报告里），
 * `output` 是合并后的 stdout+stderr（报告文件缺失时兜底用）。
 */
function runFeishuSync(args, cwd, timeout = FEISHU_SYNC_TIMEOUT_MS) {
	return new Promise(resolve => {
		let output = '';
		let done = false;
		const finish = value => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		const child = spawn(process.execPath, [FEISHU_SCRIPT_PATH, ...args], { cwd, windowsHide: true });
		const timer = setTimeout(() => {
			output += `\n[超时] 超过 ${Math.round(timeout / 1000)}s 仍未结束，已终止（同步是逐篇串行的，可以用 limit 分批）。\n`;
			try {
				child.kill();
			} catch { /* 已经退出 */ }
		}, timeout);
		child.stdout?.on('data', chunk => { output += String(chunk); });
		child.stderr?.on('data', chunk => { output += String(chunk); });
		child.on('error', e => finish({ code: -1, output: `${output}\n[启动失败] ${String(e?.message ?? e)}` }));
		child.on('close', code => finish({ code: code ?? -1, output }));
	});
}

/** 列表 / 新建飞书知识库的等待上限（照 IDE 真源 ✓：20s / 30s）。 */
const SPACE_LIST_TIMEOUT_MS = 20_000;
const SPACE_CREATE_TIMEOUT_MS = 30_000;
/** 飞书**文档读侧**（读正文 / 列评论 / 列回复）的等待上限：文档可能很大（照真源 120s ✓）。 */
const FEISHU_READ_TIMEOUT_MS = 120_000;
/** 飞书**写评论**的等待上限：评论很短，但网络抖动要留余量（照真源 60s ✓）。 */
const FEISHU_WRITE_TIMEOUT_MS = 60_000;

/**
 * 跑 `lark-cli`（`kb_feishu_spaces` 用 ✓）。与上面 `runFeishuSync` 的两点不同：
 *   · 可执行**由调用方给**（`cliPath` ✓ —— CLI 装在非标准位置时能指路 ✓），缺省走 PATH ✓；
 *   · **不经 shell**（`spawn(exe, args[])` ✓）：名称里就算有引号也不会被拆开 ✓（我们仍照真源净化 ✓）。
 * `missing: true` ＝ **压根起不来**（ENOENT 之类 ✓）⇒ 调用方要给"安装 + 登录"指引 ✓，
 * 不许当"命令失败"糊过去 ✗（那正是用户最需要指路的一刻 ✓）。
 */
function runLarkCli(exe, args, timeout) {
	return new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let done = false;
		const finish = value => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		// ★★ 2026-10-24（真机：`✗ [启动失败] spawn lark-cli ENOENT`）：
		//   用户机器上 `lark-cli` **装了**，位置是 `%APPDATA%\npm\lark-cli.cmd`（npm 的 .cmd shim）。
		//   而 Node 的 `spawn('lark-cli')`：
		//     · 不会按 PATHEXT 补 `.cmd` ⇒ 报 ENOENT（读起来像"没装"）
		//     · 即便给了 `.cmd` 全路径，**不经 shell 也起不来**（ENOENT/EINVAL）
		//   ⇒ 这里先按 PATH + PATHEXT **自己解析**一次，`.cmd/.bat` 则走 shell 启动。
		//   ⚠ 走 shell 时对含空格的参数加引号（版本查询/列库/升级这三处参数都是简单 token，
		//     不含用户正文；正文类调用仍走原来的无 shell 路径 ✓）。
		let resolved = exe;
		if (process.platform === 'win32' && !(/[\\/]/.test(exe))) {
			const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
			for (const dir of dirs) {
				for (const ext of ['.cmd', '.exe', '.bat', '']) {
					const cand = join(dir, exe + ext);
					if (existsSync(cand)) { resolved = cand; break; }
				}
				if (resolved !== exe) { break; }
			}
		}
		const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
		const spawnArgs = useShell ? args.map(a => (/\s/.test(String(a)) ? '"' + String(a) + '"' : String(a))) : args;
		const child = spawn(resolved, spawnArgs, useShell ? { windowsHide: true, shell: true } : { windowsHide: true });
		const timer = setTimeout(() => {
			stderr += `\n[超时] 超过 ${Math.round(timeout / 1000)}s 仍未结束，已终止。\n`;
			try {
				child.kill();
			} catch { /* 已经退出 */ }
		}, timeout);
		child.stdout?.on('data', chunk => { stdout += String(chunk); });
		child.stderr?.on('data', chunk => { stderr += String(chunk); });
		child.on('error', e => {
			// ⚠ Windows 分型：npm 装的 `lark-cli` 是 **`.cmd` shim**，而 **Node 不经 shell 不能直接执行 `.cmd`** ✗
			//   ⇒ 报出来的是 ENOENT（读起来像"没装"），但真相是"装了、这种方式起不来" ✓ —— 两者**对策完全不同** ✗
			//   （一个去装、一个去换入口 ✓）⇒ 先同步探一下同名 `.cmd`/`.bat` 再决定怎么报 ✓。
			//   本模块**刻意不走 shell**：参数里可能有引号与 `&`（评论正文 / URL 查询串）⇒ 经 shell 会被拆坏 ✗（真源在 cmd 下踩过 ✓）。
			// ⚠ **探测必须同步** ✗✗：`close` 事件可能紧接着 `error` 就到，而 `finish` 只认第一次调用 ✓ ⇒
			//   若在这里 `await`，`close` 会先落一把"没有 missing 的结果" ⇒ **"缺 CLI"被静默当成"没有内容/没有评论"** ✗
			//   （最误导的一类"成功" ✓；2026-10-12 实测：`async` 版把三个读工具与两个写工具的指引全吞掉了 ✓）。
			if (process.platform === 'win32' && e?.code === 'ENOENT'
				&& (existsSync(`${exe}.cmd`) || existsSync(`${exe}.bat`))) {
				finish({
					code: -1, stdout,
					stderr: `${stderr}\n[启动失败] "${exe}" 看起来是 npm 的 .cmd/.bat shim：本模块**不经 shell** 执行（参数里可能有引号与 & ⇒ 经 shell 会被拆坏 ✗），而 Node 不能直接 spawn .cmd ⇒ 请用 cliPath 指向**真实可执行文件**，或改装原生二进制版 lark-cli ✓`,
					missing: false,
				});
				return;
			}
			finish({ code: -1, stdout, stderr: `${stderr}\n[启动失败] ${String(e?.message ?? e)}`, missing: e?.code === 'ENOENT' });
		});
		child.on('close', code => finish({ code: code ?? -1, stdout, stderr }));
	});
}

/**
 * 把 `reply_elements` JSON 落到**临时文件**，跑一次 CLI，然后**无论如何**清掉它 ✓。
 *
 * 为什么走文件（照真源 ✓）：`--content` 收 `@<路径>` ⇒ argv 里只出现一个路径 ✓ ⇒ 引号 / `&` 那一整类坑消失 ✓。
 * 本模块**本来就不经 shell**（内联 JSON 其实是安全的 ✓），但这条让"将来谁改了 spawn 方式"也不至于踩 ✓ ——
 * 真源正是在 cmd + `.cmd` shim 那条路上被 `--content` 里的引号咬过 ✓。
 */
async function withContentFile(contentJson, run) {
	const dir = await mkdtemp(join(tmpdir(), 'vssaros-feishu-'));
	const file = join(dir, 'content.json');
	try {
		await writeFile(file, contentJson, 'utf8');
		return await run(file);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => { /* 清理失败不影响结果 ✓ */ });
	}
}

export const name = 'vssaros-kb';

// 只依赖 tools：工具在任何模板里都该可用。`webServer` / `connection` 只在 web 模板里存在，
// 写进静态 `inject` 会让整个插件在 headless / tui profile 里**永久 pending**，连工具一起失效
//（2026-10-12 照 kanban / skills / workflow 的现成写法收窄 ✓，见 `doc/dsh-modules-conformance.html` §5-9）。
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/kb';

/**
 * 自带页面的 CSP（2026-10-26，P4）。
 *
 * 为什么现在才能加：之前 `/x/kb/` 与 `/x/kb/doc` 都含**内联脚本**，要放行就得写
 * `script-src 'unsafe-inline'` —— 那等于没有防护。现在两处脚本都已外置
 * （`/x/kb/web/page-boot.js`、`/x/kb/web/doc-boot.js`）⇒ 这里要求 `script-src 'self'`。
 *
 * `style-src 'unsafe-inline'` 仍然需要：视图把主题样式作为 <style> 注入，正文里也有
 * `style="…"` 属性（表格对齐、Callout 色条）。样式注入的危害面远小于脚本注入。
 */
const KB_PAGE_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"media-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'none'",
].join('; ');
/**
 * 上一次 `/api/page` 渲染时用到的**库根目录**（含外挂库，如 `E:\VsSarosVault`）。
 *
 * ★★ 2026-10-23（真机：点击「库」区笔记 ⇒ `拒绝读取库外文件：e:\VsSarosVault\库\方法\…`）：
 *   根因不是围栏太严，而是 **`/api/doc` 从来没把 extraRoots 传下去**（`readDoc(root, uri)`
 *   只带数据根）⇒ 页面**列得出**外挂库的文件，却**读不了**它 —— 典型的"能看见不能碰" ✗。
 *   ⇒ 这里记住"页面上一次列过哪些库"，读取时把它们一并当作允许根：
 *   **判据仍是段边界**（`root + sep`，见 store.js:406-408）⇒ 不放松任何越权读取 ✓。
 */
let LAST_VAULT_DIRS = [];

/**
 * 页面「关系图谱」的图数据缓存（★ 2026-10-19：图谱从 IDE 侧迁到 dsh 页面）。
 *
 * 为什么必须缓存：`/api/graph` 要**读全库正文**才能解析 `[[双链]]`（550 篇 ≈ 200+ KB 文件 IO），
 * 页面每次打开/刷新都重扫会明显卡 ⇒ 按 `notesDir` 缓存 60 秒；`?refresh=1` 强制重扫
 * （页面上的「重新构建」按钮用它）。
 * ⚠ 不在写盘路径里主动失效（`kb_write_note` 等）—— 60 秒的窗口对"看图"足够，
 *   为它给所有写工具挂回调不划算；真要最新数据点「重新构建」即可。
 */
const GRAPH_CACHE_TTL_MS = 60_000;
const graphCache = new Map();

/**
 * 渲染结果磁盘缓存（2026-10-25）。
 *
 * 为什么缓存：`/api/doc` 每次打开都要跑一遍 markdown-it（82 篇里最长的一篇约 10ms），
 * 而笔记内容在两次打开之间通常**完全没变**。键取 `路径(小写) 的 sha1`，值里存
 * `mtime + bytes` 做失效判定 —— 文件一改，mtime/大小就变，缓存自动失效，不需要手动清。
 *
 * 落点 `<库根>/.kb-html-cache/`：`.kb` 前缀会被视图的 isNoise 过滤掉，不会出现在树里。
 * 任何异常（只读盘、权限）都只让缓存失效，**不阻断**正文返回。
 */
const HTML_CACHE_DIR = '.kb-html-cache';
/**
 * 渲染管线版本（2026-10-26 引入）。
 *
 * 为什么必须有：缓存键是「路径 + mtime + 字节数」，**换个渲染器不会改变这两者** ⇒
 *   mermaid 从「客户端脚本渲染」改成「服务端 pele 出 SVG」后，旧缓存里的 HTML
 *   仍被判为命中，页面继续显示“源码块”（真机实测踩到：/api/doc 无 SVG，
 *   而独立文档页 /x/kb/doc 是新的、有 SVG —— 两者的唯一差别就是走了缓存）。
 * ⇒ 任何改变输出形状的渲染改动（规则/主题/引擎）都要把这个数字 +1。
 */
const HTML_CACHE_VERSION = 3;
function htmlCacheFileOf(vaultDir, absPath) {
	const h = createHash('sha1').update(String(absPath).toLowerCase()).digest('hex').slice(0, 20);
	return join(vaultDir, HTML_CACHE_DIR, h + '.json');
}

/**
 * `[[双链]]` 解析索引（2026-10-25，供 `/api/doc` 的服务端渲染用）。
 * 键：`笔记名（去扩展名、小写）` 与 `区/相对路径（去扩展名、小写）` → 值：文件绝对路径。
 * 60s 缓存：一次目录扫描即可覆盖整库，比每篇文档都扫一次划算得多。
 */
const wikiIndexCache = new Map();
async function wikiResolverFor(vaultDir) {
	if (!vaultDir) { return () => undefined; }
	const now = Date.now();
	const hit = wikiIndexCache.get(vaultDir);
	let map = hit && (now - hit.at) < GRAPH_CACHE_TTL_MS ? hit.map : null;
	if (!map) {
		map = new Map();
		for (const section of [NOTES_DIR, LIBRARY_DIR]) {
			let nodes = [];
			try { nodes = (await listVaultTree(vaultDir, { section })).nodes ?? []; } catch { nodes = []; }
			const walk = (list) => {
				for (const n of list ?? []) {
					if (n.isDirectory) { walk(n.children); continue; }
					const abs = join(vaultDir, section, ...String(n.rel).split('/'));
					map.set(String(n.name).replace(/\.md$/i, '').toLowerCase(), abs);
					map.set(`${section}/${String(n.rel)}`.replace(/\.md$/i, '').toLowerCase(), abs);
				}
			};
			walk(nodes);
		}
		wikiIndexCache.set(vaultDir, { at: now, map });
	}
	return (target) => {
		const t = String(target ?? '').replace(/\\/g, '/').trim();
		if (!t) { return undefined; }
		const noExt = t.replace(/\.md$/i, '').toLowerCase();
		return map.get(noExt) ?? map.get(t.toLowerCase()) ?? map.get(noExt.split('/').pop() ?? '');
	};
}

/**
 * 库的显示名（**模块级**版本，供路由 handler 使用）。
 *
 * ⚠⚠ 2026-10-19 真机事故：`/x/kb/graph` 直接调了 `vaultDisplayName(vault.id)` ⇒
 *   **服务端 500 `vaultDisplayName is not defined`**（用户点图谱按钮就报这个）。
 *   原因：那个名字是 `renderPage()` **函数体内**的局部 `const`（:2864），依赖它自己的
 *   局部变量 `injectedVaults` ⇒ handler 作用域里根本没有。
 *
 * 口径必须与渲染侧保持一致：**注入名优先，拿不到退回 uid**（不编造 ✓）。
 * 两处注释互指（渲染侧 :2862-2864、这里）；将来若要合并成一份，得给渲染函数整体传参
 * （改动面大）⇒ 暂按两份维护，但**口径不许分叉**。
 */
function vaultDisplayNameFrom(config, id) {
	const injected = parseInjectedVaults(config?.kbVaults) ?? [];
	return injected.find(item => item.id === id)?.name || id;
}
/**
 * 二进制资源读取（2026-10-24 新增，供 React 页的「图片内嵌」用）。
 *
 * 为什么要单独一条路由：页面里的 `<img>` 由浏览器直接发请求，拿不到 React 侧的数据；
 * 而 `/api/doc` 只回文本 ⇒ 图片 / pdf / 音视频在 dsh 侧**永远显示不出来**（真机表现：
 * 只看到一个坏图标或空行）。⇒ 新增 `GET /api/asset?uri=<绝对路径>` 直接回字节流。
 *
 * 围栏口径**与 `/api/doc` 完全一致**：只允许「库根 + 页面列过的库根」之内的文件，
 * 按**段边界**比较（`root + sep`）⇒ `/vault-other` 不会被 `/vault` 放行 ✓。fail-closed：
 * 任何异常都返回 `{ error }`，绝不回退到"读数据根下同名文件"。
 *
 * ⚠ 只白名单几种展示型 MIME：不认识的扩展名一律拒绝 —— 这条路由是"渲染素材"用的，
 *   不是通用文件下载器（否则一个 `.env` 都能被页面请求走）。
 */
const ASSET_MIME = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
	pdf: 'application/pdf',
	mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
/** 单文件上限：超过就当"不是素材"处理（避免页面误请求一个 500MB 的视频把内存打满）。 */
const ASSET_MAX_BYTES = 32 * 1024 * 1024;

async function readAsset(root, uri, extraRoots = []) {
	const raw = String(uri || '').trim();
	if (!raw) {
		return { error: '缺少 uri' };
	}
	let p;
	try {
		p = resolve(decodeURIComponent(raw));
	} catch (e) {
		return { error: '路径不合法：' + String(e?.message ?? e) };
	}
	const roots = [root, ...extraRoots].filter(Boolean).map(r => resolve(String(r)));
	const inside = roots.some(r => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
	if (!inside) {
		return { error: '拒绝读取库外文件：' + p };
	}
	const ext = extname(p).slice(1).toLowerCase();
	const mime = ASSET_MIME[ext];
	if (!mime) {
		return { error: '不支持的类型：.' + ext };
	}
	try {
		const st = await stat(p);
		if (!st.isFile()) {
			return { error: '不是文件：' + p };
		}
		if (st.size > ASSET_MAX_BYTES) {
			return { error: '文件过大（>' + Math.round(ASSET_MAX_BYTES / 1024 / 1024) + 'MB）：' + p };
		}
		return { bytes: await readFile(p), mime, size: st.size };
	} catch (e) {
		return { error: '读取失败：' + String(e?.message ?? e) };
	}
}

// ⚠ 这是**声明**的工具名清单（页面自诊断那一栏用它 ✓，且被跨模块探针拿去对账 ✓）。
// 它必须与 `toolDefinitions()` 里真正注册的名字**集合相同** ✗ —— 2026-10-12 加 `kb_feishu_spaces`
// 时正是靠 `p3-08` 的"页面 == 注册 == 声明"三方对账抓到的（同 workflow 那次 ✓：两处名单各写一份，
// 只改一处 ⇒ 页面说 5 个、注册表里 6 个 ✗）。
export const TOOL_NAMES = ['kb_list', 'kb_search', 'kb_read', 'kb_topic_overviews', 'kb_organize', 'kb_build', 'kb_write_note', 'kb_mkdir', 'kb_mindmap', 'feishu_doc_read', 'feishu_drive_list_comments', 'feishu_drive_list_comment_replies', 'feishu_drive_reply_comment', 'feishu_drive_add_comment', 'kb_feishu_spaces', 'kb_feishu_sync'];
/** 页面最多列出的文档条数（页面是给人看的，工具才是给模型的）。 */
const PAGE_DOC_LIMIT = 40;

/**
 * 文档行 —— `data-doc-row` / `data-vault` / `data-search` 供**页内筛选**用（与看板页同一做法：
 * 状态∩关键字那套换成 vault∩关键字）。`data-search` 覆盖面＝标题 / 类型 / 标签 / uri，
 * 与原 `KnowledgeBaseViewPane` 的搜索口径一致（那边也是文件级索引字段，不读正文）。
 */
/**
 * 该行是不是"库分区里还没建成笔记的素材"（真源 `_isBuiltSource` 的口径 ✓，见 §15.10）。
 * 判据只有一条：它的**库内相对路径**出现在 pending 集合里 ✓ ——
 * ⚠ 因此「笔记」分区的行**永远**不可能是 pending（没有「库」这一段前缀 ✓），与真源"非库分区不参与"一致 ✓。
 */
/**
 * 该行的 **vault 内相对路径**（形如 `笔记/子/甲.md` ✓）；不是这个 vault 的 uri ⇒ undefined ✓。
 * 与 `libraryRelativeOf` 同一手法，只是不剥「库」那一段 ✓（两处都按 `/<vaultId>/` 定位 ✓）。
 */
function vaultRelativeOf(doc, vaultId) {
	const uri = String(doc.uri ?? '').replace(/\\/g, '/');
	const marker = '/' + vaultId + '/';
	const at = uri.indexOf(marker);
	return at < 0 ? undefined : uri.slice(at + marker.length);
}

/**
 * 这一行**能不能改**（§15.33）：只有「笔记」区的行可以 ✓。
 * 判据照真源用 `section`（索引条目里就有 ✓），不用路径前缀再猜一次 ✓；
 * 服务端那条路由还会用 `resolveOrganizePath` 独立再判一遍 ✓（两侧都不省 ✓）。
 */
function renamableOf(doc) {
	return String(doc.section ?? '') === 'notes';
}
function libraryRelativeOf(doc, vaultId) {
	const uri = String(doc.uri ?? '').replace(/\\/g, '/');
	const marker = '/' + vaultId + '/' + LIBRARY_DIR + '/';
	const at = uri.indexOf(marker);
	return at < 0 ? undefined : uri.slice(at + marker.length);
}
/** 紧凑容量（照真源 `kbViewUtils.ts:18` 的 `formatSizeCompact` ✓：无空格、一位小数 ✓）。 */
function formatSizeCompact(bytes) {
	const value = Number(bytes);
	if (!Number.isFinite(value) || value < 0) { return ''; }
	if (value < 1024) { return `${value}B`; }
	if (value < 1024 * 1024) { return `${(value / 1024).toFixed(1)}KB`; }
	return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

/** 算不算"参与索引的笔记" —— 真源 `isRawLib` 用的就是这一条（库分区里的非 md 视为「未索引」素材 ✓）。 */
function isMarkdownName(name) { return /\.(md|markdown)$/i.test(String(name)); }

/**
 * 文件行的图标 —— **现在是真 codicon** ✓（2026-10-19 换掉 emoji）。
 *
 * ★ 变更：原先按扩展名派 emoji（📄🖼️📕📘🧾🎨）—— 那是"页面拿不到图标字体"时期的权宜 ✗。
 *   现在与真源 `_fileIconEl`（`knowledgeBaseView.ts:1959-1966`）**同口径**：基类就是 codicon-file，
 *   不再按扩展名分叉 ⇒ 图标变成单色、吃 `color`、16px 网格，与原资料库一致 ✓。
 * ⚠ 仍然不同的那一半**如实记** ✗：真源在此之上还叠加 `getIconClasses()` 产出的**文件图标主题**
 *   （每个扩展名一枚彩色图标）；那是 IDE 侧产物，页面拿不到 ⇒ 我们停在"只有基类"这一档
 *   —— 而真源在**没有**文件图标主题时也正是这一档 ⇒ 与真源的**兜底形态**一致 ✓。
 */
function fileGlyphOf() {
	return codicon('file');
}

/**
 * 树节点 —— **目录**（真源 `.kb-node.dir` ✓：可折叠 ＋ twist ＋ 文件夹色图标 ＋ 计数徽标 ✓）。
 *
 * ⚠ 折叠钩子仍用 `data-dir-toggle` ＋ `.dsh-dir` ✓（页内脚本早就在用这两个 ✓）⇒
 *   换结构**不换钩子** ✓，免得脚本与样式各自认一套 ✗。
 */
/**
 * 行的缩进（inline style，服务端算 ✓）—— 照真源 knowledgeBaseView.ts:2000 的 paddingLeft = 6 + depth*16 ✓。
 *
 * ⚠ 为什么**连负的 margin-left 一起给**（这是本轮的关键一招）：
 *   我们的树是**嵌套**的（子树的 ul 在目录行的 li 里面 ✗），而真源是**扁平**的（行是兄弟、子树是行的兄弟容器）。
 *   嵌套下子行的**包含块**会跟着父行的 padding 右移 ⇒ 只写 padding-left 的话，
 *   内容缩进对了（16px/层 ✓），但**行盒子本身也右移** ⇒ hover / 选中的底色（背景条）逐层内缩
 *   （首层 +6px、之后每层 +16px，右侧同理变短）✗ —— 与真源"所有行背景条左对齐"不符。
 *   ⇒ 用**等量的负 margin-left** 把行盒子拉回容器左边界：内容缩进仍是精确的 16px/层，
 *     而背景条左右边界与层级无关 ✓（视觉与真源一致）。
 *   数值推导（depth N，N>0）：内容目标 = 6+16N；盒子要回到父盒子左边界 ⇒ margin-left = -(父的 padding-left)
 *     = -(6+16(N-1)) = -(16N-10)。实测校准过：N=1 ⇒ -6、N=2 ⇒ -22、N=3 ⇒ -38 ✓。
 *   ⚠ **右边界也要补**（第一版漏了，浏览器量出来才发现 ✗）：只补左边的话右边界会逐层短 14px
 *     （实测 L0/L1/L2 右边界 = 1504 / 1490 / 1476 ✗）。
 *     ⇒ 补 margin-right: **-6px，与层数无关** ✓：每层的内容区右边界恒为 W-14（父盒子右恒 W-8、
 *     再减行自己的 padding-right 6）⇒ 减 -6 恰好回到 W-8 ✓。
 * ⚠ 排序安全：页内排序只在同一层 ul 内搬节点（depth 不变）⇒ inline 值无需重算 ✓。
 */
function indentStyle(depth) {
	const d = Math.max(0, depth | 0);
	const pad = 6 + d * 16;
	if (d === 0) { return `padding-left:${pad}px;`; }
	return `padding-left:${pad}px;margin-left:-${d * 16 - 10}px;margin-right:-6px;`;
}

function treeDirHtml(node, ctx, depth = 0) {
	const childCount = (node.children ?? []).length;
	// ⚠ `data-dir-rel` = 这一级目录的 vault 相对路径（2026-10-14 §16.18 **加法** ✓）：
	//   页面右键「新建」要知道"建到哪个目录"（真源 targetDir：目录行 ⇒ 建进它里面 ✓）——
	//   文件行能靠 data-rel 推，目录行**推不出来**（它的后代可能为空 ✓）⇒ 直接给它带上 ✓。
	// ⚠ `data-vault` 也得有 ✗（2026-10-14 被 p3-87 咬出来的真缺口 ✓）：拖到目录行要发 `/api/rename`，
	//   而它**必收 vaultId** ✓ —— 文件行一直带着 ✓，目录行当初没带 ⇒ 空 vaultId ⇒ 服务端 400
	//   （"vaultId 形态不合法" ✓）⇒ 拖拽在**目录行**上永远失败、在**分区体**上却能成 ✗（同一功能两种命运 ✓）。
	// ★ 目录**默认折叠**（2026-10-14 §16.24，照真源 ✓）：真源 `_expandedFolders` 初始是**空集** ✓
	//   （`knowledgeBaseView.ts:211` ✓，`:2047` 的 twist 按集合显示 ▾/▸ ✓），展开态按 vault+分区持久化
	//   （`agentStudio.kb.expanded.<vaultId>.<section>` ✓ `:161,575-577` ✓）。
	//   我们同样默认收起 ✓；页内脚本按 localStorage 里的**路径集合**恢复展开 ✓（粒度与真源一致 ✓）。
	//   ⚠ 代价如实记 ✗：真源是**懒加载**（展开才 listChildren ✓），我们是服务端**一次渲完**、只靠 hidden 收起
	//     ⇒ 树大时首屏 HTML 仍不小 ✓（换来"零新 API、零扫描"这条既有性质 ✓，见 renderVaultTree 的注释 ✓）。
	//   ⚠ 而"JS 不在时仍全量可见"这条既有性质**不能丢** ✗ ⇒ 由页面注入一条 noscript 样式兜底 ✓
	//     （见 renderPage 里那段 ✓ —— 它把 [hidden] 重新显示 ✓）。
	// ★ 排序键（2026-10-14 §16.26，照真源 `sortNodes` `:1966-1988` 的 `dirs` 分支 ✓）：
	//   真源把**目录与文件分成两组各自排、目录恒在前** ✓（`dirs.sort(cmp); files.sort(cmp);
	//   return [...dirs, ...files]` ✓）⇒ 目录行**也得有**这些键 ✗ —— 但目录行原先一个都没有
	//   （只有 data-dir-rel ✓）⇒ 补上（`data-child-count` 就是真源的 `childCount` ✓ :135-136 ✓）。
	//   ⚠ 索引条目那类行（`docRowHtml`）**没有** fs 尺寸 ✗ ⇒ `data-size` 缺席 ⇒ 比较器按 0 算 ✓
	//    （与"缺字段沉底"同一条既有约定 ✓）。
	return `<li class="dsh-node dir" draggable="true" data-dir-node data-depth="${depth}" style="${indentStyle(depth)}" data-vault="${escapeHtml(ctx.vaultId)}" data-dir-rel="${escapeHtml(ctx.section + '/' + node.rel)}" data-order="${escapeHtml(String(ctx.orderOf ? ctx.orderOf(node) : ''))}" data-title="${escapeHtml(String(node.name).toLowerCase())}" data-created="${escapeHtml(String(ctx.createdOf ? ctx.createdOf(node) : ''))}" data-mtime="${node.mtime !== undefined ? String(node.mtime) : ''}" data-size="${node.size !== undefined ? String(node.size) : ''}" data-child-count="${String(childCount)}">
<button type="button" class="dsh-node-button dsh-dir" data-dir-toggle aria-expanded="false">
<span class="dsh-twist">▸</span>
<span class="dsh-ficon">${codicon('folder')}</span>
<span class="dsh-name">${escapeHtml(node.name)}</span>
<span class="dsh-count-badge">${childCount}</span>
</button>
${rowActionsHtml({
			dirRel: ctx.section === NOTES_DIR ? `${ctx.section}/${node.rel}` : '',
			// ⚠ 目录行**不给 renamePath** ✗（服务端 moves 的还原点用 copyFile ⇒ 目录必抛 ✓，见 rowActionsHtml 的注释 ✓）
			deletePath: ctx.section === NOTES_DIR ? `${ctx.section}/${node.rel}` : '',
		})}
<ul class="dsh-node-children" hidden>${treeHtml(node.children ?? [], ctx, depth + 1)}</ul>
</li>`;
}

/**
 * 树节点 —— **文件**。
 *
 * 判据两条都照真源（`knowledgeBaseView.ts:2056-2072` ✓）：
 *   · `isRawLib` ＝ **库分区**里的**非 md** ⇒ meta 写「未索引」（它本来就不进索引 ✓）；
 *   · `built` ＝ 库分区看**真实构建缓存**（`_isBuiltSource` ✓，我们用同一份 pending ✓）、非库分区**恒 true** ✓
 *     ⇒ 状态点 `indexed`（绿）/ `raw`（蓝）✓，title 「已建笔记」/「待构建为笔记」✓。
 *
 * ⚠ 行上仍然带 `data-doc-row` ✓：页内筛选 / 排序 / 预览 / 重命名那几段脚本都认它 ✓（换结构不换钩子 ✓）。
 */
/**
 * 行内动作（2026-10-14 §16.27）—— 照真源 `knowledgeBaseView.ts:2079-2090` 的 hover 四件
 * （**新建文件 / 新建文件夹 / 重命名 / 删除** ✓）＋ `.kb-actions` 的"hover 才显"（`kbView.css:282-283` ✓）。
 *
 * ⚠ **按围栏给子集** ✗（不许摆"点了必然 400"的按钮 ✓ —— 与"库区行的菜单不摆写项"同一条纪律 ✓）：
 *   · 有 `dirRel` 且落在「笔记」区 ⇒ 「新建笔记 / 新建文件夹」（**建进这个目录** ✓，与真源 targetDir 同口径 ✓）
 *     ＋「重命名」＋「删除」✓；
 *   · 只给 `renamePath`（文件行）⇒ 「重命名」＋「删除」✓（真源的"新建"是对**节点**的 ✓；往一个文件里建东西没有意义 ✗）；
 *   · 库区的行 ⇒ **一个都不给** ✗（服务端围栏只在「笔记」区 ✓）。
 * ⚠ **目录行不给「重命名」** ✗：服务端 `moves` 的还原点那一步用 `copyFile`（`organize.js:96` ✓）⇒
 *   对**目录**会抛 ⇒ 点了必然失败 ✓（真源能改目录名 ✓ —— 差异如实记 ✗）。
 * ⚠ 目录的「删除」**可以** ✓：`deletes` 走 `moveFile` ⇒ `rename`（`organize.js:158` ＋ `:38-41` ✓）目录也吃得下 ✓；
 *   只有"跨盘"那条兜底路（EXDEV ⇒ 复制 ＋ 删源 ✗）对目录不成立 ✓（备份目录是 vault 的兄弟 ⇒ 通常同盘 ✓）。
 */
function rowActionsHtml({ renamePath = '', deletePath = '', dirRel = '' } = {}) {
	const inNotes = !!dirRel && (dirRel === NOTES_DIR || dirRel.indexOf(NOTES_DIR + '/') === 0);
	// ⇐ 真源 .kb-act 用的是 codicon（new-file / new-folder / ✎ / trash ✓ knowledgeBaseView.ts:2039-2046 ✓）
	//   2026-10-19 把 emoji 换回 codicon（重命名那枚原先是 ✎ 文本 ⇒ 换成 codicon-pencil，与真源"重命名"语义同源 ✓）。
	const newBits = inNotes
		? `<button type="button" class="dsh-act" data-row-new="file" data-row-new-dir="${escapeHtml(dirRel)}" title="新建笔记（建在 ${escapeHtml(dirRel)} 里）">${codicon('new-file')}</button>`
			+ `<button type="button" class="dsh-act" data-row-new="folder" data-row-new-dir="${escapeHtml(dirRel)}" title="新建文件夹（建在 ${escapeHtml(dirRel)} 里）">${codicon('new-folder')}</button>`
		: '';
	const renameBit = renamePath
		? `<button type="button" class="dsh-act dsh-rename" data-rename data-rename-path="${escapeHtml(renamePath)}" title="重命名 / 移动（只能在「笔记」区）">${codicon('pencil')}</button>`
		: '';
	const deleteBit = deletePath
		? `<button type="button" class="dsh-act" data-row-delete data-row-delete-path="${escapeHtml(deletePath)}" title="删除（移入备份，可撤销）">${codicon('trash')}</button>`
		: '';
	if (!newBits && !renameBit && !deleteBit) { return ''; }
	return `<span class="dsh-actions">${newBits}${renameBit}${deleteBit}</span>`;
}

function treeFileHtml(node, ctx, depth = 0) {
	const rel = ctx.section + '/' + node.rel;
	const isRawLib = ctx.section === LIBRARY_DIR && !isMarkdownName(node.name);
	const built = ctx.section === LIBRARY_DIR ? !ctx.pendingSet.has(String(node.rel).toLowerCase()) : true;
	const meta = isRawLib ? '未索引' : formatSizeCompact(node.size);
	const renamable = ctx.section === NOTES_DIR;
	const title = String(node.name).replace(/\.(md|markdown)$/i, '');
	// ⚠ 标签要从**索引条目**里取（按 uri 对上 ✓）—— 树是文件系统的，索引才有 tags ✓。
	//   第一版把 `data-tags` 写死了空串 ✗ ⇒ 页内"标签"筛选对新行失效（p3-08 当场抓到 ✓），
	//   这是**真回归**、不是探针形状问题 ✓（真源的行本来就带标签语义 ✓）。
	const tags = (ctx.tagsOf ? ctx.tagsOf(node) : []).map(tag => String(tag));
	const created = ctx.createdOf ? ctx.createdOf(node) : '';
	// ⚠ 文件行**必须**带 dsh-node ✗：原来只有「待构建」那一支才写 class ⇒ 非待构建的文件行拿不到
	//   .dsh-node 那套（flex / 内边距 / 行高 / 圆角 / 光标 ✓）⇒ 它们其实一直没上样式 ✗。
	//   （这正是「规则在 p3-76 里被判成活、而文件行没吃到它」的那类盲区 ✓。）
	// ★ `draggable="true"`（2026-10-14 §16.19）：真源给**每个**节点都开了拖拽（`:2105-2107` ✓）——
	//   放置目标另有约定（只有目录行与分区体拦截 ✓，见页内脚本那段注释 ✓）。
	//   ⚠ 模板串里注释不许出现反引号 ✗。
	return `<li class="dsh-node${ctx.pendingSet.has(String(node.rel).toLowerCase()) && ctx.section === LIBRARY_DIR ? ' dsh-pending' : ''}" draggable="true"${ctx.pendingSet.has(String(node.rel).toLowerCase()) && ctx.section === LIBRARY_DIR ? ' data-pending="1"' : ''} data-doc-row data-node data-depth="${depth}" style="${indentStyle(depth)}" data-vault="${escapeHtml(ctx.vaultId)}" data-uri="${escapeHtml(ctx.uriOf(node))}" data-order="${escapeHtml(String(ctx.orderOf(node)))}" data-title="${escapeHtml(title.toLowerCase())}" data-created="${escapeHtml(created)}" data-mtime="${node.mtime !== undefined ? String(node.mtime) : ''}" data-size="${node.size !== undefined ? String(node.size) : ''}" data-child-count="0" data-tags="${escapeHtml(tags.map(tag => tag.toLowerCase()).join('|'))}" data-search="${escapeHtml([node.name, rel, title, ...tags].join(' ').toLowerCase())}" data-rel="${escapeHtml(rel)}">
<button type="button" class="dsh-node-button" data-node-open>
<span class="dsh-twist empty">▸</span>
<span class="dsh-ficon">${fileGlyphOf(node.name)}</span>
<span class="dsh-name t">${escapeHtml(title)}</span>
</button>
${isRawLib ? `<span class="dsh-meta">未索引</span>` : (meta ? `<span class="dsh-meta">${escapeHtml(meta)}</span>` : '')}
<span class="dsh-status ${built ? 'indexed' : 'raw'}" title="${built ? '已建笔记' : '待构建为笔记'}"></span>
${ctx.pendingSet.has(String(node.rel).toLowerCase()) && ctx.section === LIBRARY_DIR ? ' <span class="dsh-pending-badge" title="该素材还没构建成笔记（构建缓存里没有它的记录）">⏳</span>' : ''}
${rowActionsHtml({ renamePath: renamable ? rel : '', deletePath: renamable ? rel : '' })}
</li>`;
}

/** 递归渲染一层（目录在前、各自按名称 —— 顺序在 `store.listVaultTree` 里定死 ✓）。 */
function treeHtml(nodes, ctx, depth = 0) {
	if (!nodes.length) { return ''; }
	return nodes.map(node => (node.isDirectory ? treeDirHtml(node, ctx, depth) : treeFileHtml(node, ctx, depth))).join('');
}

/**
 * 分区（真源 `.kb-section` ＋ `.kb-section-header` ✓：箭头 ＋ 类图标 ＋ 名称 ＋ **计数徽标** ✓）。
 * 类图标按分区着色（`.sec-library` 蓝 / `.sec-notes` 紫 ✓，`kbView.css:214-215` ✓）。
 */
/**
 * 分区头右侧工具栏（2026-10-14 §16.28）—— 照真源 `.kb-section-toolbar` ＋ `.kb-tool-btn`
 * （`kbView.css:217` / `:902-908` ✓；真源 header 的挂载顺序是 arrow, title, count, processing, spacer, **toolbar**
 * `:1728-1730` ✓，且**工具栏为空就整块不挂** ✓ —— 我们也照这条 ✓）。
 *
 * ⚠ 真源这儿原有四件（批量构建库 / 导入 URL / 思维导图 / 同步飞书 ✓ `:1698-1726` ✓），我们的裁决逐件写在这里
 *   （照 §16.23 清单的口径 ✓）：
 *   · **批量构建库** ✗：长任务（几十次写 ✓）—— 页面里没有进度/取消/重试，挂 HTTP 会半途 ✓；
 *     它在会话里走 `kb_build` 有闸有状态 ✓；
 *   · **导入链接 / URL** ✗：本侧**没有**这个能力 ✓（摆了就是"点了必然失败" ✓）；
 *   · **同步飞书** ✓（2026-10-19 改判 ✓，用户明确要求补上）：原先不摆的理由是"真源未配置时跳设置页，
 *     而我们没有那个页" —— 这个理由**已经不成立**了（桥 7 有 `openKbSettings` ✓）。
 *     ⚠ 但仍**不假装能同步** ✗：真源在已启用时直接跑 `feishuSync('apply')`（写 ＋ 分钟级 ✓），
 *     页面这侧是**只读**通道、也没有进度/取消 ⇒ 点它只做**短动作**：打开 IDE 的知识库设置
 *     （「飞书同步」分组就在那页），同步本身在面板里或会话里的 `kb_feishu_sync` 执行 ✓。
 *     title 必须**说实话**（写清"打开设置"，不写"立即同步" ✗）✓。
 *   · **思维导图** ✓：四件里唯一的短动作 ✓ ⇒ 摆 —— ⚠ 但**只做"打开"那一半** ✗：
 *     真源 title 是「思维导图（打开或生成 .canvas）」✓，而"生成"在我们侧要起子代理 ⇒ 页面点不出来 ✓
 *     ⇒ title 必须**说实话**（不写"或生成" ✓），生成那半由回执/提示指路到会话里的 `kb_mindmap` ✓。
 *   ⚠ 另一条**有意不同** ✗（上一轮讨论定下的）：真源工具栏的动作直接在**宿主**里执行 ✓；
 *     我们这条走**页面 → 只读路由**（`/api/mindmap` ✓ 只 readdir ✓），"打开"由页面桥 `openFile` 做 ✓
 *     —— 桥是协议明文允许的低风险界面命令 ✓，**不新增任何写通道** ✓。
 */
function notesToolbarHtml() {
	const mindmapTitle = '打开思维导图（.canvas）；从笔记生成请在会话里用 kb_mindmap';
	// ★ 2026-10-19 晚：按钮语义改为**真的开始同步**（桥 12 的 kbFeishuSync ⇒ 宿主转 agentStudio.kb.feishuSync）。
	//   未启用时那条命令会自己通知 + 定位「飞书同步」分组 ⇒ 标题不再写"只是打开设置" ✓。
	const feishuTitle = '同步飞书（未启用会打开知识库设置的「飞书同步」分组；已启用则直接在集成终端里开始同步）';
	return `<div class="dsh-section-toolbar" data-section-toolbar>
<span class="dsh-tool-btn" data-mindmap-open role="button" tabindex="0" title="${escapeHtml(mindmapTitle)}" aria-label="思维导图">${codicon('type-hierarchy')}</span>
<span class="dsh-tool-btn" data-feishu-sync role="button" tabindex="0" title="${escapeHtml(feishuTitle)}" aria-label="同步飞书">${codicon('cloud-upload')}</span>
</div>`;
}

function sectionHtml({ section, vaultId, count, body, missing, toolbar = '' }) {
	const isLibrary = section === LIBRARY_DIR;
	const label = isLibrary ? '库' : '笔记';
	// ⇐ 真源分区头图标是 codicon-library / codicon-note（`knowledgeBaseView.ts:1627` ✓）——
	//   2026-10-19 用真 codicon 替掉 📚 / 📝（那两个是彩色 emoji，且不跟着分区色走 ✗）。
	const glyph = codicon(isLibrary ? 'book' : 'note');
	// ⚠ `open` 是**初始展开态** ✓（真源 renderSection 之后 `sec.classList.add('open')` ✓，
	//   库/笔记初始都展开 ✓）；折叠箭头靠 CSS 旋转 ✓，与手风琴/solo 共用同一个 `.open` 语义 ✓。
	return `<section class="dsh-section open ${isLibrary ? 'sec-library' : 'sec-notes'}" data-section="${escapeHtml(section)}" data-vault="${escapeHtml(vaultId)}" data-kb-region="${escapeHtml(vaultId + ':' + section)}">
<div class="dsh-section-header" data-section-toggle role="button" tabindex="0" aria-expanded="true">
<span class="dsh-arrow">${codicon('chevron-right')}</span>
<span class="dsh-title"><span class="dsh-cat ${isLibrary ? 'lib' : 'notes'}">${glyph}</span>${label}<span class="dsh-count-badge" data-section-count>${count}</span></span>
${toolbar}
</div>
<!-- ★ 空态（2026-10-14 §16.27）：文案**逐字照真源** _createEmptyInline（:1835 / :4662 / :4710 三处都是「暂无内容」✓）；
     两个说法的分工要分清 ✗：**「暂无内容」= 这一节没有节点**（真源那条 ✓），
     而「这个分区还没有目录」是**我们这边**的情况（vault 目录本身不存在 ✓）⇒ 两件事不混用 ✓。
     ⚠ 空态元素**常驻**（靠 hidden 切换 ✓）：页内筛选把某节筛空时也要显示它 ✓
     （真源 _refreshCountForBody 同口径 ✓ :4660-4663 ✓）—— 只靠服务端渲染那次判断就漏了筛选这条路 ✗。 -->
<div class="dsh-section-body"><p class="dsh-empty-inline" data-section-empty${count && !missing ? ' hidden' : ''}>暂无内容</p>${missing ? '<p class="dsh-empty">这个分区还没有目录。</p>' : body}</div>
</section>`;
}

/**
 * 「标签分类」分区（2026-10-14 §16.23）—— **逐项照真源** `knowledgeBaseView.ts:1148-1287` ＋
 * `kbView.css:402-455` ✓：
 *   · 头 = 箭头 ＋ 🏷 ＋ 「标签分类」＋ **「交集 AND」徽标** ＋ **计数徽标** ✓；
 *     ⚠ 真源那个 AND 徽标是**静态说明**（全文件没有 onclick ✓，我核过 ✓）⇒ 照抄成静态 ✓，
 *     **不假装能切换** ✗（摆一个点不动的开关比不摆更坏 ✓）。
 *   · 体 = 标签搜索（placeholder `搜索标签…` ✓）＋ 标签分组（组头 `#标签` ＋ `N 篇` ✓、组头可折叠 ✓、
 *     **初始折叠** ✓ —— 真源 `.kb-tag-group-body { display:none }` ✓）＋ `#无标签` 兜底组 ✓。
 *   · 空态文案**逐字照真源**（`:1205` ✓）：`暂无标签（在笔记中使用 #标签# 格式即可创建标签）`
 *     ⚠ 注意是**两个 #** ✓（用户截图 OCR 成了一个，别照抄错 ✗）；搜索无命中时是 `无匹配标签` ✓。
 *   · 排序照真源（`:1200` ✓）：条数倒序、同条数按 `localeCompare('zh')` ✓。
 * 数据只能来自**索引条目**（`vault.docs[].tags` ✓ —— 树是文件系统的、没有标签 ✓），
 * 所以这个分区**只在有索引的库**里非空 ✓（没索引的库如实显示空态 ✓，不假装有标签 ✗）。
 * ⚠ 如实记一处**有意不同** ✗：真源只显示**当前库**（单库视图 ✓），我们多库并列 ⇒ **每个 vault 一份** ✓。
 */
function tagClassHtml({ vaultId, tags, untagged }) {
	const total = tags.length + (untagged.length ? 1 : 0);
	const group = item => `<div class="dsh-tag-group" data-tag-name="${escapeHtml(String(item.tag).toLowerCase())}">
<div class="dsh-tag-group-head" data-tag-toggle role="button" tabindex="0" aria-expanded="false">
<span class="dsh-arrow">${codicon('chevron-right')}</span>
<span class="dsh-tag-group-name">${escapeHtml(item.label)}</span>
<span class="dsh-count">${item.count} 篇</span>
</div>
<div class="dsh-tag-group-body">${item.names.map(name => `<div class="dsh-tag-doc" title="${escapeHtml(name)}">${escapeHtml(name)}</div>`).join('')}</div>
</div>`;
	const list = tags.map(item => group({ tag: item.tag, label: `#${item.tag}`, count: item.count, names: item.names }))
		.concat(untagged.length ? [group({ tag: '__untagged__', label: '#无标签', count: untagged.length, names: untagged })] : []);
	const body = total === 0
		? `<div class="dsh-tag-search"><div class="dsh-search-box"><span class="dsh-search-ico">${codicon('search')}</span><input type="text" data-tag-input placeholder="搜索标签…" aria-label="搜索标签" autocomplete="off"><span class="dsh-search-clear" data-tag-clear hidden>${codicon('close')}</span></div></div>
<div class="dsh-tag-groups" data-tag-groups data-tag-total="0"><p class="dsh-empty" data-tag-empty>暂无标签（在笔记中使用 #标签# 格式即可创建标签）</p></div>`
		: `<div class="dsh-tag-search"><div class="dsh-search-box"><span class="dsh-search-ico">${codicon('search')}</span><input type="text" data-tag-input placeholder="搜索标签…" aria-label="搜索标签" autocomplete="off"><span class="dsh-search-clear" data-tag-clear hidden>${codicon('close')}</span></div></div>
<div class="dsh-tag-groups" data-tag-groups data-tag-total="${total}">${list.join('')}<p class="dsh-empty" data-tag-empty hidden>无匹配标签</p></div>`;
	return `<section class="dsh-section sec-tagclass" data-section="tagclass" data-vault="${escapeHtml(vaultId)}" data-kb-region="${escapeHtml(vaultId + ':tagclass')}">
<div class="dsh-section-header" data-section-toggle role="button" tabindex="0" aria-expanded="false">
<span class="dsh-arrow">${codicon('chevron-right')}</span>
<span class="dsh-title"><span class="dsh-cat tag">${codicon('tag')}</span>标签分类<span class="dsh-and-badge">交集 AND</span><span class="dsh-count-badge" data-tag-count>${total}</span></span>
</div>
<div class="dsh-section-body">${body}</div>
</section>`;
}

function docRow(doc, vaultId, order, pendingSet) {
	const bits = [doc.type, ...doc.tags].filter(Boolean).join(' · ');
	const haystack = [doc.title, doc.type, ...doc.tags, doc.uri].filter(Boolean).join(' ').toLowerCase();
	// `data-order` 用**补零字符串**：排序时按字符串比较即等于按数值比较（"0010" < "0009" 不可能发生），
	// 省掉一个数字比较器；它也是"切回索引顺序"时的复原键 ✓。
	const orderKey = String(order).padStart(4, '0');
	const fileName = relativeSegments(doc, vaultId).slice(-1)[0] ?? doc.uri;
	// ★ 门控可视化（§15.10，照真源 `_isBuiltSource` ✓）：库分区里"还没建成笔记"的素材 ⇒ 灰显 ＋ ⏳ 徽标。
	//   判据 = 查**真实构建缓存**（就是 P1 那份 `previewBuild` 的 pending ✓），**不按扩展名猜** ✗。
	//   ⚠ 如实标注：我们侧 pending 只统计 `.md` ⇒ **非 md 素材在本页不会被标** ✗（不是"都建好了" ✓）。
	const libRel = libraryRelativeOf(doc, vaultId);
	const isPending = !!pendingSet && libRel !== undefined && pendingSet.has(libRel.toLowerCase());
	// ★ 状态点（§15.14）：真源 `built = 库分区 ? _isBuiltSource : true`（:2064 ✓）
	//   ⇒ **非库分区恒 indexed**（绿 ✓，与 pending 那条"非库分区不参与"是同一句话的两面 ✓）。
	const isLibrary = libRel !== undefined;
	const statusBuilt = isLibrary ? !isPending : true;
	const statusHtml = '<span class="dsh-status ' + (statusBuilt ? 'indexed' : 'raw') + '" title="'
		+ (statusBuilt ? '已建笔记' : '待构建为笔记') + '"></span>';
	// ★ 重命名入口（§15.33）：只给「笔记」区的行 ✓ —— 库区那半边在 dsh 侧**没有**对应写路径
	//   （`kb_organize` 明令只能在「笔记」区 ✓），所以按钮**不出现**在库区行上 ✓（不做一个点了会报错的按钮 ✗）。
	//   ⚠⚠ 2026-10-13 这里踩过一次（两个渲染探针一起红 ✓）：我插这几行时把**上面那条 `statusHtml` 语句从中间劈开了** ✗
	//   ⇒ 行标记成了半截 HTML ⇒ DOM 结构变样 ⇒ 拖拽里那句 `upper.classList.contains('dsh-vault')` 守卫
	//   **静默 return** ✓（现象只是"拖不动"，一点错都不报 ✗）。教训：**插到"上一条语句结束"之后，别插进它内部** ✓。
	const vaultRel = vaultRelativeOf(doc, vaultId);
	const renamable = renamableOf(doc) && !!vaultRel;
	const actionsHtml = rowActionsHtml({ renamePath: renamable ? vaultRel : '', deletePath: renamable ? vaultRel : '' });
	return `<li${isPending ? ' class="dsh-pending" data-pending="1"' : ''} data-doc-row data-vault="${escapeHtml(vaultId)}" data-uri="${escapeHtml(String(doc.uri ?? ''))}" data-order="${orderKey}" data-title="${escapeHtml(String(doc.title ?? '').toLowerCase())}" data-created="${escapeHtml(String(doc.created ?? ''))}" data-mtime="${doc.mtime !== undefined ? String(doc.mtime) : ''}" data-tags="${escapeHtml((doc.tags ?? []).map(tag => String(tag).toLowerCase()).join('|'))}" data-search="${escapeHtml(haystack)}"><span class="t">${escapeHtml(doc.title)}</span>${isPending ? ' <span class="dsh-pending-badge" title="该素材还没构建成笔记（构建缓存里没有它的记录）">⏳</span>' : ''}${bits ? ` <small>${escapeHtml(bits)}</small>` : ''}<br><small><code>${escapeHtml(fileName)}</code>${doc.length !== undefined ? ` · ${doc.length} 字` : ''}</small>${statusHtml}${actionsHtml}</li>`;
}

/**
 * 索引条目的 uri → **相对 vault** 的路径段（页面上的目录分组就按它来）。
 *
 * 索引里的 uri 形如 `file:///…/<vaultId>/<分类>/<文件>.md` ⇒ 从 vaultId 段之后开始即相对路径；
 * 找不到 vaultId 段（索引里写的是别的挂载路径 / 老数据）就**只取最后一段** —— 宁可把条目放到
 * "（未分目录）"下，也不显示一棵**编出来**的目录树（不猜）。
 */
function relativeSegments(doc, vaultId) {
	const path = String(doc.uri ?? '').replace(/^file:\/\//i, '').replace(/\\/g, '/');
	const segments = path.split('/').filter(Boolean);
	if (segments.length && segments[0].endsWith(':')) {
		segments[0] = segments[0].slice(0, -1); // Windows 盘符：G: → G（纯显示用，不参与分组语义）
	}
	const at = segments.lastIndexOf(String(vaultId ?? ''));
	if (at >= 0) {
		return segments.slice(at + 1);
	}
	return segments.length ? [segments[segments.length - 1]] : [];
}

/**
 * 把一组索引条目按**目录**分组（只读展示；目录名＝相对 vault 的路径段去掉文件名那一段）。
 * 返回按目录名排好序的分组；同一目录内**保持索引原顺序**（`data-order` 连续 ⇒ "切回索引顺序"仍可复原）。
 */
function buildDirGroups(docs, vaultId, orderBase) {
	const groups = new Map();
	docs.forEach((doc, index) => {
		const segments = relativeSegments(doc, vaultId);
		const dir = segments.length > 1 ? segments.slice(0, -1) : [];
		const key = dir.join('/');
		if (!groups.has(key)) {
			groups.set(key, { dir, items: [] });
		}
		groups.get(key).items.push({ doc, order: orderBase + index });
	});
	return [...groups.values()].sort((a, b) => a.dir.join('/').localeCompare(b.dir.join('/'), 'zh'));
}

/**
 * 一个 vault 的**文档树**：目录可折叠（原 `KnowledgeBaseViewPane` 的文件树那套的只读部分），
 * 树本身完全由索引里的 uri 推出来 ⇒ **零新 API、零文件系统扫描**。
 *
 * ⚠ 排序与筛选的口径：行仍是 `data-doc-row`（带 order/title/created/mtime/search）⇒ 页内筛选照旧；
 * 排序改成**逐个目录内排序**（树里"顺序"天然就是目录内顺序）。
 */
function renderVaultTree(docs, vaultId, pendingSet) {
	const groups = buildDirGroups(docs, vaultId, 0);
	return `<ul class="dsh-tree">${groups.map(group => {
		const rows = group.items.map(item => docRow(item.doc, vaultId, item.order, pendingSet)).join('');
		const label = group.dir.length ? group.dir.join(' / ') : '（未分目录）';
		return `<li class="dsh-dir" data-dir="${escapeHtml(group.dir.join('/'))}">
	<button type="button" class="dsh-dir-head" data-dir-toggle aria-expanded="true">▾ ${escapeHtml(label)} <small>${group.items.length}</small></button>
	<ul>${rows}</ul>
</li>`;
	}).join('')}</ul>`;
}

/** 页面专属样式（vault 分区里的文档列表）；骨架与主题变量由 `pageShell.js` 给。 */
/*
 * 页面专属样式（vault 分区里的文档列表）。骨架与主题变量由 pageShell.js 给。
 *
 * ★ 本块**逐值移植自 IDE 侧「资料库」view 的真源样式表**：
 *   src/vs/sessions/contrib/agentStudio/browser/views/media/kbView.css（1095 行 / 304 选择器 ✓
 *   2026-10-13 抽出对应组件的规则原文对过一遍 ✓）。每处都标了真源选择器 ⇒
 *   **改样式时两边一起改** ✓，且守卫 poc/dsh-p0/scripts/p3-68-kb-page-style-parity.mjs
 *   会对"声明值"逐条比（只比与真源同名的那些属性 ✓）。
 *
 * ⚠ 与真源的**取舍**（如实记，不假装全等 ✗）：
 *   · 真源的分区是「库 / 笔记 / 双链 / 最近编辑」多段手风琴 + 可拖拽 resizer；
 *     我们这页是「每个 vault 一段」⇒ 只移植**.kb-section / .kb-section-header** 那两个盒子的视觉 ✓，
 *     不移植 resizer（拖拽调整高度属交互增强，另开一轮 ✓）。
 *   · 真源 pending 灰显 + ⏳ 徽标**已落地**（`.dsh-pending` ✓，见 §15.10 ✓）；
 *    而 2026-10-13 起**页面已带上状态点**（`.dsh-status`：库分区 built ? indexed : raw ✓），
 */
const PAGE_CSS = `
${CODICON_FONT_CSS}
/* ── codicon 尺寸校准（⇐ 真源 kbView.css:891-908 那一节 ✓） ──────────────────────────────────
   .dsh-cod 基类写的是 16px/1（与 codicon.css 的 .codicon[class*='codicon-'] 同值 ✓）；
   各位置的实际字号由下面这些覆盖给出，取值逐条照真源：
     行内图标 14（kbView.css:894 ✓）／行内动作 13（:893 ✓）／节头箭头 12（:204 ✓）
     ／节头工具钮 13（:906 ✓）／vault 图标 14（:611 同值 ✓）／vault caret 12（:897 ✓）。
   ⚠ 图标颜色一律走 currentColor（继承父级）⇒ 行内图标再按 symbolIcon-* 上色（下面 .dsh-ficon 那条 ✓），
     与真源 .kb-ficon 的口径一致 ✓（选中行时图标**不会**跟着变白 ✓ —— 那是 emoji 版本的老毛病 ✗）。 */
.dsh-node .dsh-cod { font-size: 14px; }
.dsh-act .dsh-cod { font-size: 13px; }
.dsh-section-header .dsh-cod, .dsh-tag-group-head .dsh-cod { font-size: 12px; }
.dsh-abtn .dsh-cod { font-size: 14px; }
.dsh-tool-btn .dsh-cod { font-size: 13px; }
.dsh-search-ico .dsh-cod { font-size: 12px; }
.dsh-opt-ico .dsh-cod { font-size: 13px; }
.dsh-caret .dsh-cod { font-size: 12px; }
.t { font-weight: 600; }
/* ⇐ .kb-scroll, .kb-panel-content（滚动区：去掉聚焦框 + 允许收缩 ✓） */
.dsh-scroll { outline: none; min-height: 0; }
/* ★★ hidden 必须真的隐藏（2026-10-15，真机截图咬出来的 ✗）———————————————————————————
   UA 给 [hidden] 的 display:none 是**作者样式可以盖掉的** ✗ —— 本页的过滤全靠 el.hidden = true
   （搜索行、目录行、vault 块 ✓），而 .dsh-vault-group / .dsh-node 都带 display: flex ✗
   ⇒ 属性挂上了、**画面照旧** ✗（用户第 ② 条"仅显示当前库"就这么看着像修了、其实没修 ✓）。
   ⚠ 这也是**断言最容易假绿**的地方 ✗：读 el.hidden（或 !b.hidden）永远是对的 ✓，
   只有**计算样式/像素**才看得出没隐藏 ✓ ⇒ 一条全局规则收口 ✓，探针也要按计算样式判 ✓。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
[data-vssaros-page="kb"] [hidden] { display: none !important; }
/* ── 库选择器（2026-10-14 §16.25；逐条照真源 kbView.css:48-111 ✓）────────────────────────────
   ⚠ 模板串里注释不许出现反引号 ✗（这条坑今天踩了多次 ✓）。 */
.dsh-vault-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.25))); flex-shrink: 0; position: relative; }
.dsh-vault-select { flex: 1; display: flex; align-items: center; gap: 6px; background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 5px 8px; cursor: pointer; color: var(--vscode-foreground, inherit); font-size: 12px; min-width: 0; }
.dsh-vault-select:hover { border-color: var(--vscode-focusBorder, #007fd4); }
.dsh-vault-select .dsh-vname { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ⇐ 真源 .kb-vault-select .kb-caret 是 12px（kbView.css:897 ✓）；原先这里写 10px ✗ ⇒ 与真源差 2px。 */
.dsh-vault-select .dsh-caret { color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
.dsh-vault-icon { font-size: 14px; }
.dsh-abtn { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; color: var(--vscode-icon-foreground, #ccc); opacity: .8; border: 1px solid transparent; }
.dsh-abtn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,.15))); opacity: 1; }
/* ⚠ 菜单必须留在 .dsh-vault-bar 内 ✗（真源 :621-628 那条教训 ✓）：它是唯一的 position: relative
   ⇒ topology 定了 top: 100% 的落点；挂到面板上会被 overflow 裁掉 ⇒ 「点了没反应」✓。 */
.dsh-vault-menu { position: absolute; top: 100%; left: 8px; right: 8px; background: var(--vscode-dropdown-background, var(--vscode-sideBar-background, #252526)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, rgba(128,128,128,.35))); border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.5); z-index: 50; margin-top: 2px; display: none; overflow: hidden; }
.dsh-vault-menu.show { display: block; }
.dsh-vault-menu .dsh-grp { font-size: 10px; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); padding: 6px 10px 3px; letter-spacing: .5px; }
.dsh-vault-menu .dsh-opt { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
.dsh-vault-menu .dsh-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-vault-menu .dsh-opt .dsh-path { font-family: var(--vscode-font-family, inherit); font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
.dsh-vault-menu .dsh-opt .dsh-check { color: var(--vscode-button-background, #0e639c); font-size: 11px; width: 14px; flex-shrink: 0; }
.dsh-vault-menu .dsh-opt[aria-current="true"] .dsh-check::before { content: '✓'; }
/* ★ 库下拉的增删入口（2026-10-15 §16.32；值逐条照真源 kbView.css:110-111 ✓ —— .kb-opt.add /
   .kb-divider 同款 ✓；fallback 是因为 dsh 外壳不注入 --vscode-* ✓）。 */
.dsh-vault-menu .dsh-divider { height: 1px; background: var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.35))); margin: 4px 0; }
.dsh-vault-menu .dsh-opt-add { color: var(--vscode-button-background, #0e639c); }
.dsh-vault-menu .dsh-opt-ico { font-size: 13px; flex-shrink: 0; }
.dsh-vault-menu .dsh-opt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ⇐ .kb-search-row / .kb-search-box（搜索：内边距 6px 8px / 圆角 4px / 输入框无边框 ✓） */
.dsh-search { flex-wrap: wrap; gap: 6px; padding: 6px 8px; }
.dsh-search input { font-size: 12px; border-radius: 4px; padding: 4px 8px; }
.dsh-search select {
	flex: 0 0 auto;
	max-width: 45%;
	font-size: 11px;
	padding: 3px 4px;
	border-radius: 4px;
	border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,.35)));
	background: var(--vscode-dropdown-background, var(--vscode-input-background, transparent));
	color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground, #ccc));
}
/* .dsh-embed（内嵌记忆区块的虚线框）已于 2026-10-12 随内嵌一起删除。
   ⚠ 本行在模板字符串里，注释里**不能出现反引号**，否则会提前闭合 PAGE_CSS ✗（真踩过一次）。 */
/* ⇐ .kb-search-mode-btn（全文 ⇄ 文件名：10.5px / 600 / 内边距 2px 7px / 圆角 3px / badge 底色 ✓） */
.dsh-search-mode-btn {
	flex-shrink: 0;
	font-size: 10.5px;
	font-weight: 600;
	padding: 2px 7px;
	border-radius: 3px;
	cursor: pointer;
	/* ⚠ 两个 badge 变量这里**带**回退（与计数徽标那条**相反** ✗ —— 真源就是这么不一致的，
	   只能逐个选择器照抄 ✓；p3-68 会按值咬住这种"想当然统一"的做法 ✓）。
	   ⚠ 注释里不许出现反引号 ✗：本块在模板串里，反引号会把它提前闭合（今天因此翻车 4 次 ✓）。 */
	background: var(--vscode-badge-background, #4d4d4d);
	color: var(--vscode-badge-foreground, #fff);
	user-select: none;
	white-space: nowrap;
}
.dsh-search-mode-btn:hover { opacity: 0.85; }
/* ⇐ .kb-search-mode-btn.filename（文件名档：蓝底蓝字 ✓） */
.dsh-search-mode-btn.filename { background: rgba(77,163,255,.2); color: #4da3ff; }
/* ⇐ .kb-search-sort-btn（2026-10-14 §16.26：24x22 / 圆角 3px / 13px 描述色 / hover 白 8% ✓） */
.dsh-search-sort-btn {
	flex-shrink: 0;
	width: 24px;
	height: 22px;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 3px;
	cursor: pointer;
	color: var(--vscode-descriptionForeground, #999);
	font-size: 13px;
	user-select: none;
}
.dsh-search-sort-btn:hover { background: rgba(255,255,255,.08); color: var(--vscode-foreground, #ccc); }
/* ★ 排序下拉（2026-10-14 §16.26；值逐条照真源 kbView.css:308-358 ✓ 的 .kb-dropdown / .kb-sort-*）——————
   ⚠ 定位机制**有意不同** ✗：真源是 position: absolute ＋ 页内算坐标（它挂在面板内 ✓），我们跟右键菜单
   同一套（position: fixed ＋ JS 给坐标 ✓，见 .dsh-menu 那条注释 ✓）—— 值照抄、机制我们自己的 ✓。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-dropdown {
	position: fixed;
	z-index: 45;
	min-width: 220px;
	overflow: hidden;
	background: var(--vscode-dropdown-background, #252526);
	color: var(--vscode-foreground, #cccccc);
	border: 1px solid var(--vscode-dropdown-border, #454545);
	border-radius: 6px;
	box-shadow: 0 6px 24px rgba(0,0,0,.6);
}
.dsh-dropdown[hidden] { display: none; }
.dsh-dropdown.show { display: block; }
.dsh-sort-group { padding: 4px 8px; }
.dsh-sort-label { font-size: 11px; font-weight: 600; padding: 2px 6px; color: var(--vscode-descriptionForeground, #999); }
.dsh-sort-opt { display: flex; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px; border-radius: 3px; }
.dsh-sort-opt:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-sort-opt .dsh-ck { color: var(--vscode-button-background, #0e639c); font-size: 11px; width: 16px; flex-shrink: 0; }
.dsh-sort-opt[aria-checked="true"] .dsh-ck::before { content: '✓'; }
/* ⇐ .kb-search-results / .show（结果面板默认隐藏，.show 才出现 ✓） */
.dsh-search-results { padding: 4px 0 8px; display: none; }
.dsh-search-results.show { display: block; }
/* ⇐ .kb-search-head（11px / 描述色 / 不大写 / 不加粗 ✓） */
.dsh-search-head {
	padding: 6px 14px;
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	text-transform: none;
	letter-spacing: 0;
	font-weight: 400;
}
.dsh-search-hit { padding: 4px 14px 6px; cursor: pointer; }
.dsh-search-hit:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-search-hit small { color: var(--vscode-descriptionForeground); }
/* ⇐ .kb-section-header .kb-arrow（12px / 描述色 / 过渡 .15s ✓） */
.dsh-arrow { font-size: 12px; color: var(--vscode-descriptionForeground); transition: transform .15s; flex-shrink: 0; }
/* ═══════════════════════════════════════════════════════════════════════════
   ★ §15.38 复刻：**「库」/「笔记」分区** ＋ **真文件树**（值逐条照 kbView.css:196-305 ✓）
   ⚠ 这一段是**先加的空壳** ✓（此刻页面还没用这些类 ✗）—— 分两步走是为了"任何一步都能干净回退" ✓；
     接线那一步（renderPage 换成节结构）在下一处 ✓。
   ═══════════════════════════════════════════════════════════════════════════ */
/* ⇐ .kb-section（纵向 flex ＋ 底边线；展开占满、折叠只占 header 高 ✓） */
.dsh-section { display: flex; flex-direction: column; min-height: 0; padding: 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.25))); }
.dsh-section:last-of-type { border-bottom: 0; }
.dsh-section.open { flex: 1 1 0; }
/* ⚠ 我们加的偏离 ✗（照 p3-71 那套：偏离要**摆到台面上**，不许悄悄多写 ✓）：
   真源的 .kb-section.open { flex: 1 1 0 } 依赖**祖先有界高度**（.kb-scroll 是 flex:1; min-height:0; overflow-y:auto ✓）；
   我们这页的外壳容器高度是 auto ⇒ flex-basis: 0 会把节**压成 0 高** ✗ ——
   实测（几何诊断）：节高 2px、而其头部 27px 溢出 ⇒ **分隔条正好压在表头中间 ⇒ 点不到** ✗✗
   （p3-72 报的 "dsh-resizer intercepts pointer events" 就是它 ✓）。
   ⇒ 补一条 min-height：节的**头**（27px）＋ 底边线（1px）——让"节至少能显示自己的头"成为硬约束 ✓；
   "唯一展开时占满剩余空间"（solo ✓）在有剩余空间时照旧成立 ✓。 */
.dsh-section.open { min-height: 28px; }
.dsh-section:not(.open) { flex: 0 0 auto; }
.dsh-section:not(.open) .dsh-section-body { display: none; }
/* ⇐ .kb-section-header（11px / 大写 / 字距 .5px / 600 / 内边距 5px 8px / 间距 6px / 手型 ✓） */
.dsh-section-header { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; color: var(--vscode-foreground); user-select: none; cursor: pointer; }
/* ⇐ .kb-section-header .kb-arrow 与 .kb-section.open 的 rotate(90deg)（值同旧的那两条 ✓） */
.dsh-section-header .dsh-arrow { font-size: 12px; color: var(--vscode-descriptionForeground); transition: transform .15s; flex-shrink: 0; }
.dsh-section.open .dsh-section-header .dsh-arrow { transform: rotate(90deg); }
.dsh-section-header .dsh-title { flex: 1; display: flex; align-items: center; gap: 6px; }
/* ⇐ .kb-section-header .kb-count（计数徽标：10px / badge 底 / 圆角 10px / 内边距 0 6px ✓） */
.dsh-section-header .dsh-count-badge { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 0 6px; }
/* ⇐ .kb-section-header .kb-count（目录行的计数徽标：与节头同一条来源 ✓ —— 旧规则挂在已死的 .dsh-dir-head 上，复刻后目录行改发 .dsh-count-badge ✓） */
.dsh-node .dsh-count-badge { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 0 6px; }
/* ★ 分区头右侧工具栏（2026-10-14 §16.28）：值逐条照真源 kbView.css:217（容器 flex + gap 1px + margin-left 4px ✓）
   与 :902-908（.kb-tool-btn 20x20 / 圆角 3px / 13px / 图标色 / opacity .8；hover 底色 + opacity 1 ✓）。
   ⚠ 位置靠 .dsh-section-header .dsh-title 的 flex:1 顶到右侧 ✓（真源那边是 spacer ✓）。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-section-toolbar { display: flex; align-items: center; gap: 1px; margin-left: 4px; }
.dsh-section-toolbar .dsh-tool-btn {
	width: 20px; height: 20px;
	display: flex; align-items: center; justify-content: center;
	border-radius: 3px; cursor: pointer;
	color: var(--vscode-icon-foreground, #ccc); opacity: .8; font-size: 13px;
}
.dsh-section-toolbar .dsh-tool-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,.15))); opacity: 1; }
/* ⇐ .kb-section-header .kb-cat 与 .sec-library / .sec-notes 的着色 ✓ */
.dsh-section-header .dsh-cat { font-size: 13px; }
.dsh-section.sec-library .dsh-cat { color: var(--vscode-textLink-foreground, #569cd6); }
.dsh-section.sec-notes .dsh-cat { color: var(--vscode-symbolIcon-structForeground, #c586c0); }
/* ⇐ .kb-section-body（展开时占满并自滚 ✓） */
.dsh-section-body { padding-bottom: 4px; min-height: 0; }
.dsh-section.open .dsh-section-body { flex: 1 1 auto; overflow-y: auto; }
/* ⇐ .kb-node（树行：13px/28px ＋ 外边距 1px 8px ＋ 圆角 ＋ 手型 ✓） */
.dsh-node { display: flex; align-items: center; gap: 4px; padding: 0 6px; cursor: pointer; font-size: 13px; line-height: 28px; min-height: 28px; border-radius: var(--vscode-border-radius, 4px); margin: 1px 8px; white-space: nowrap; list-style: none; }
.dsh-node:hover { background: var(--vscode-list-hoverBackground); }
/* ⇐ .kb-node.selected（选中行：activeSelection 底/字色 ✓） */
.dsh-node.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
/* ⇐ .kb-node.selected:not(:only-of-type)（多选时用 inactiveSelection，与单选区分 ✓） */
.dsh-node.selected:not(:only-of-type) { background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-activeSelectionBackground)); }
/* ⚠ 我们加的偏离（与状态点那条同一个手法 ✓）：真源 .kb-node.selected 的两个变量**不带回退** ✓，
   而本页没有主题（外壳不注入 --vscode-* ✓，p3-73 ① 实测 ✓）⇒ 选中行会**完全看不出来** ✗。
   这里**另立一条更高优先级**的规则补回退（上面的照抄规则一个字不动 ✓ ⇒ p3-68 比到的仍是真源的原值 ✓，
   这条偏离由 p3-72 ⑫ 单独钉住 ✓）。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-scroll .dsh-node.selected { background: var(--vscode-list-activeSelectionBackground, rgba(77,163,255,.25)); }
.dsh-scroll .dsh-node.selected:not(:only-of-type) { background: var(--vscode-list-inactiveSelectionBackground, rgba(77,163,255,.12)); }
/* ★ 拖拽移动（2026-10-14 §16.19）：三条规则逐字照真源 kbView.css:230 / 249-251 ✓ ——
   · 目录行作为放置目标：outline 2px dashed focusBorder、offset -2px、淡蓝底 ✓；
   · 可拖行的光标（grab / grabbing ✓）；
   · 分区体作为放置目标（拖到**分区空白**⇒ 移到分区根 ✓ 真源 :1750-1763 ✓）：淡蓝底 ＋ 圆角 ✓。
   ⚠ 我们只在「笔记」区挂放置目标（写围栏 ✓，见页内脚本那段注释 ✓）—— 真源两区都能放 ✗。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-node.dsh-drop-target { outline: 2px dashed var(--vscode-focusBorder, #4da3ff); outline-offset: -2px; background: rgba(77,163,255,.08); }
.dsh-node[draggable="true"] { cursor: grab; }
.dsh-node[draggable="true"]:active { cursor: grabbing; }
.dsh-section-body.dsh-drop-target { background: rgba(77,163,255,.08); border-radius: 4px; }
/* ★ 行右键菜单（**自定件** ✗：真源走编辑器原生菜单、CSS 里没有菜单样式 ✓ ⇒ 不是复刻，不映射进 p3-68 ✗）。
   配色只用 menu.* 主题变量 ＋ 回退（与 mockup 同一套值 ✓）。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-menu {
	position: fixed; z-index: 40; min-width: 208px; padding: 4px 0;
	background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, #ccc);
	border: 1px solid var(--vscode-menu-border, #454545); border-radius: 5px;
	box-shadow: 0 2px 12px rgba(0,0,0,.45); font-size: 12.5px;
	max-height: calc(100vh - 16px); overflow-y: auto;   /* D5：超出滚动 ✓ */
}
.dsh-menu[hidden] { display: none; }
.dsh-menu-item { display: flex; align-items: center; gap: 10px; padding: 3px 14px; cursor: pointer; white-space: nowrap; }
.dsh-menu-item:hover, .dsh-menu-item.active { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
.dsh-menu-item .dsh-menu-key { margin-left: auto; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px; }
.dsh-menu-item:hover .dsh-menu-key, .dsh-menu-item.active .dsh-menu-key { color: var(--vscode-menu-selectionForeground, #fff); }
/* 复制路径的回执（自定件 ✓；静默复制会让人不知道成没成 ✓） */
/* ★★ 2026-10-19：toast 改成 **fixed 悬浮**（真机"点了没反应"的元凶之一 ✗）。
   原因：它原先按普通流插在 .dsh-scroll 顶上 ⇒ 用户把页面滚到「笔记」区时，提示出现在**看不见的上方**
   ⇒ 一次点击（不管成功还是失败）看起来完全没反应 ✗。改 fixed 后任何滚动位置都看得见 ✓。
   位置贴顶部（left/right 10px）而不是底部 —— 与 IDE 的 notif 位置习惯一致，也不挡分区头的可点区太多。 */
.dsh-toast {
	position: fixed; left: 10px; right: 10px; top: 8px; z-index: 9999;
	margin: 0; padding: 6px 10px; border-radius: 4px; font-size: 11px;
	color: var(--vscode-editorWarning-foreground, #dcdcaa);
	background: var(--vscode-editorWidget-background, rgba(37,37,38,.97));
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
	box-shadow: 0 2px 8px rgba(0,0,0,.35);
	display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
/* ⇐ 撤销入口（自定件 ✓：原生菜单里"撤销"是系统级动作，网页里只能自己给一个可点的 ✓） */
.dsh-toast-act {
	margin-left: 6px; font: inherit; font-size: 11px; cursor: pointer;
	padding: 0 6px; border-radius: 3px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, rgba(128,128,128,.45)));
	background: var(--vscode-button-secondaryBackground, transparent);
	color: var(--vscode-textLink-foreground, #569cd6);
}
.dsh-toast.ok { color: var(--vscode-testing-iconPassed, #6a9955); }
/* 行里那个按钮只是"让整行可点"（清掉默认样式 ✓）；.dsh-node 的内边距/间距照旧在行上 ✓ */
.dsh-node-button { all: unset; display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; cursor: pointer; }
/* ⇐ .kb-node .kb-twist（折叠三角：宽 14px / 描述色 / 10px；空目录**不可见**仍占位 ✓） */
.dsh-node .dsh-twist { width: 14px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 10px; cursor: pointer; flex-shrink: 0; }
.dsh-node .dsh-twist.empty { visibility: hidden; }
/* ⇐ .kb-node .kb-ficon（16px；目录用文件夹色 ✓）。
   ★ 2026-10-19（换 codicon 后补齐两条）：
     ① 盒子改成 flex 居中 —— 照真源 kbView.css:894（.kb-node .kb-ficon.codicon 那条 ✓）；
        原来是 inline-block，字形靠基线排 ⇒ 换字体后上下会飘 ✗。
     ② 补**通用**图标色（.dsh-ficon 用 symbolIcon-fileForeground，真源 :261 ✓）——
        sideview 原先只有 .dir 那一条 ✗ ⇒ 文件图标跟着行色走、选中行里会变白 ✗。 */
.dsh-ficon { color: var(--vscode-symbolIcon-fileForeground, #cccccc); }
.dsh-node .dsh-ficon { width: 16px; height: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.dsh-node.dir .dsh-ficon { color: var(--vscode-symbolIcon-folderForeground, #dcb67a); }
/* ⇐ .kb-node .kb-name（占满 ＋ 省略号 ✓） */
.dsh-node .dsh-name { flex: 1; overflow: hidden; text-overflow: ellipsis; line-height: 22px; }
/* ⇐ .kb-node .kb-meta（10px / 描述色 / 左距 6px ✓）—— 内容＝大小 或「未索引」✓ */
.dsh-node .dsh-meta { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; font-family: var(--vscode-font-family); }
/* 子层缩进（真源是 padding-left 逐层加 ✓） */
/* ★★ 2026-10-19：子层缩进对齐真源（真源 knowledgeBaseView.ts:2000 的 paddingLeft = 6 + depth*16 ✓）。
   ⚠ 这里踩过一个**算错的坑**（本轮实测咬出来的 ✗）：第一版我直接把 ul 的 padding-left 从 12 改成 16，
     以为"每层步长 = ul 的 padding" —— **错** ✗：我们的树是**嵌套**的（ul 在 li 里面），
     每层实际缩进 = ul 的 padding ＋ 子行的 margin-left(8) ＋ 子行的 padding-left(6) = P + 14 ✗
     （真源是**扁平**的，行之间只是兄弟 ⇒ 步长就等于 padding 的增量 16 ✓）。
     实测：P=12 ⇒ 内容每层 +26；P=16 ⇒ +30（**越改越远** ✗）。
   ⇒ 第二版：ul 不再承担缩进（padding-left: 0），子行自己的 padding-left 就是那 16px 的增量
     ⇒ 内容步长对了（16px/层 ✓），但**行盒子跟着右移** ⇒ hover / 选中的**背景条逐层内缩**
     （首层 +6px、之后每层 +16px，右侧同理变短）✗，与真源"所有行背景条左对齐"不符 ✗。
   ⇒ **终版（现在这条）**：缩进**不再由 CSS 给**，改由行内 inline style（服务端 indentStyle() 逐层算）：
     同时给 padding-left（6+16N，管内容缩进）＋ **等量负 margin-left**（-(16N-10)，把行盒子拉回容器
     左边界，管背景条）⇒ 内容步长与背景条**同时**与真源重合 ✓，且**不动 DOM 结构**（零脚本改动 ✓）。
     实测（浏览器量过）：名字起点步长 16/层，各层行盒子的左右边界一致 ✓。
   ⚠ 与真源仍存的一处差异（如实记 ✗）：真源是**扁平**结构（行是兄弟、子树是行的兄弟容器）⇒
     它的 hover 可以直接写在行上；我们是嵌套结构 ⇒ 仍需下面那条"伪元素只画首行"的补丁
     （否则 li:hover 会把整棵子树一起涂掉 ✗）。要连 DOM 也同构，得改渲染 + 页内脚本取法 ⇒ 未做 ✗。 */
.dsh-node-children { list-style: none; margin: 0; padding-left: 0; }
/* ── 「标签分类」分区（2026-10-14 §16.23；逐条照真源 kbView.css:402-455 ✓）────────────────────
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-section.sec-tagclass { border-top: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128,128,128,.25))); margin-top: 4px; }
.dsh-and-badge { font-size: 9px; font-weight: 600; letter-spacing: .3px; padding: 1px 6px; border-radius: 8px; opacity: .85; margin-left: 2px; background: var(--vscode-badge-background, rgba(128,128,128,.35)); color: var(--vscode-badge-foreground, #fff); }
.dsh-tag-search { padding: 6px 8px; position: relative; }
.dsh-search-box { flex: 1; display: flex; align-items: center; gap: 6px; background: var(--vscode-input-background, transparent); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px; }
.dsh-search-box:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
.dsh-search-box input { flex: 1; background: none; border: none; outline: none; color: var(--vscode-foreground, inherit); font-size: 12px; }
.dsh-search-box input::placeholder { color: var(--vscode-input-placeholderForeground, #999); }
.dsh-search-ico { color: var(--vscode-descriptionForeground, #999); font-size: 11px; flex-shrink: 0; }
.dsh-search-clear { cursor: pointer; color: var(--vscode-input-placeholderForeground, #999); font-size: 11px; padding: 0 2px; flex-shrink: 0; }
.dsh-search-clear:hover { color: var(--vscode-foreground, #ccc); }
.dsh-tag-groups { padding: 0 0 6px; }
.dsh-tag-group-head { display: flex; align-items: center; gap: 6px; padding: 4px 10px; cursor: pointer; user-select: none; border-radius: 4px; margin: 1px 4px; }
.dsh-tag-group-head:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-tag-group-head .dsh-arrow { font-size: 12px; color: var(--vscode-descriptionForeground, #999); transition: transform .15s; width: 12px; flex-shrink: 0; }
.dsh-tag-group.open .dsh-arrow { transform: rotate(90deg); }
.dsh-tag-group-name { flex: 1; font-size: 12px; color: var(--vscode-textLink-foreground, #3794ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tag-group .dsh-count { font-size: 10px; color: var(--vscode-descriptionForeground, #999); flex-shrink: 0; }
.dsh-tag-group-body { display: none; }
.dsh-tag-group.open .dsh-tag-group-body { display: block; }
.dsh-tag-doc { display: flex; align-items: center; gap: 6px; padding: 3px 12px 3px 28px; font-size: 12px; cursor: pointer; color: var(--vscode-foreground, #ccc); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tag-doc:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-section.sec-tagclass .dsh-cat { font-size: 13px; color: var(--vscode-symbolIcon-structForeground, #c586c0); }
/* ★ 分区体不许横向滚（2026-10-14 用户截图里那条横向滚动条 ✗）：行是 nowrap ✓ 深目录会撑宽 ⇒
   不裁就会在体里长出一条横向滚动条 ✓（真源的分区体只有 overflow-y ✓ 由更外层承担横向裁切 ✓）。 */
.dsh-section-body { overflow-x: hidden; }
/* ★★ 2026-10-14 修（用户报"知识库 sideview 显示错误"的第二处 ✓）：
   .dsh-node 是**一行 flex** ✓，而目录 li 里**还装着**它自己的子树 <ul> ✗ ⇒ 那棵子树被当成
   **第二个 flex 项**排到右边 ✓ —— 实测：.obsidian/plugins/... 整条链横着铺开、名字全被推出视口 ✓
   （于是"库 106"那一格看着像空的 ✓）。真源的子容器是节点元素**之后**的兄弟 ✓
   （knowledgeBaseView.ts:2214 的 el.nextElementSibling ✓）⇒ 我们把子树放进 li 是**结构差异** ✗
   ⇒ 就地让目录行**可换行**、子树强制独占下一行 ✓；并把 hover / 选中的底色**只画在行上** ✓
   （否则底色会连整棵子树一起涂 ✓）。这一组是**加法** ✓：上面照抄的规则一个字没动 ✓。 */
.dsh-node.dir { flex-wrap: wrap; }
.dsh-node.dir > .dsh-node-children { flex: 1 0 100%; }
.dsh-node.dir:hover { background: transparent; }
.dsh-node.dir > .dsh-node-button:hover { background: var(--vscode-list-hoverBackground); }
.dsh-node.dir.selected { background: transparent; }
.dsh-node.dir.selected > .dsh-node-button { background: var(--vscode-list-activeSelectionBackground, rgba(77,163,255,.25)); }
.dsh-node.dir.selected:not(:only-of-type) > .dsh-node-button { background: var(--vscode-list-inactiveSelectionBackground, rgba(77,163,255,.12)); }
/* ★ 2026-10-19：目录行的**整行**高亮（照真源 .kb-node:hover / .kb-node.selected ✓）。
   ⚠ 为什么不能直接给 li 上底色（真源就是这么写的 ✓）：我们的子树 <ul> 是 li 的**子元素**
     （真源是**兄弟** ✗ 结构差异）—— li:hover 会把整棵子树一起涂掉 ✗，
     这正是当初改成"只画 button"的原因 ✓（那条注释在上面 §16 那段里 ✓）。
   ⇒ 改用伪元素**只画第一行那 28px**（子树被 flex 挤到第二行 ⇒ 天然不被涂 ✓），
     并用 :has() 排除"鼠标其实停在子树里"的情况（否则悬停**子行**时父行也亮 ✗ ——
     真源的扁平结构不会有这种事 ✓）。
   ⚠ 降级如实记：不支持 :has() 的浏览器这整条规则**不生效** ⇒ 退回上面"只画 button"的既有行为 ✓（不会更糟）。
   ⚠ 模板串里注释不许出现反引号 ✗（本轮已踩两次 ✓）。 */
.dsh-node.dir { position: relative; }
.dsh-node.dir:hover:not(:has(.dsh-node-children :hover))::before,
.dsh-node.dir.selected::before {
	content: ''; position: absolute; left: 0; right: 0; top: 0; height: 28px;
	border-radius: 4px; pointer-events: none;
	background: var(--vscode-list-hoverBackground);
}
.dsh-node.dir.selected::before { background: var(--vscode-list-activeSelectionBackground, rgba(77,163,255,.25)); }
.dsh-node.dir.selected:not(:only-of-type)::before { background: var(--vscode-list-inactiveSelectionBackground, rgba(77,163,255,.12)); }
/* 内容必须压在伪元素之上（伪元素 absolute、与 button 同层 ⇒ 靠 z-index 把内容抬起来 ✓） */
.dsh-node.dir > .dsh-node-button, .dsh-node.dir > .dsh-actions { position: relative; z-index: 1; }
/* ⇐ 复刻：每个 vault 给一组「库/笔记」分区（多于一个库时加一行小标题 —— 真源只显示当前库 ✗，
   静态页要能同时看到全部 ⇒ 这行是**我们的适配**，如实标注 ✓） */
/* ★★ 2026-10-14 修（用户报"知识库 sideview 显示错误" ✓）：分区全塌成一条头、**行一条都看不见** ✗
   两个原因叠在一起，都不是"样式写错了一个值"，而是**高度链断了两处** ✓：
     ① 真源 kbView.css:154 有 .kb-scroll 的 display:flex / flex-direction: column ✓，
        我们只在**共享外壳**里写了 flex:1; overflow-y:auto（没有 display:flex ✗）⇒ 本页下面那些
        .dsh-section.open 的 flex: 1 1 0 与 .dsh-section-body 的 flex: 1 1 auto 一直是**失效**的 ✓
        （声明摆在那儿、从不生效 ⇒ 按值对账的 p3-68 看不出来 ✗，要**渲染级**才看得见 ✓）；
     ② 本页自有的多库包装层 .dsh-vault-group 是 height:auto 的 flex 列 ✗ ⇒ 里面的分区按 flex-basis:0
        退到 min-height: 28px ✓ ⇒ 分区体拿到的高度 ≈ 0，只剩那 4px 内边距 ✓
        ⇒ 106 行全被这个 4px 的 overflow 裁掉（真实数据下 189KB 页面、117 行，一条看不到 ✓）。
   修法＝把高度链接回去 ✓：滚动区补上真源那条 flex 列 ✓（写在**本页 extraCss**，不动共享外壳 ✗），
   并让每个 vault 组**参与分配** ✓（多库时各组平分高度、组内两个分区再平分 ✓ = 真源单库语义的推广 ✓）。
   ⚠ 模板串里注释不许出现反引号 ✗ —— 这条注释第一版就又踩了一次 ✓（见 feedback 记忆 ✓）。 */
.dsh-scroll { display: flex; flex-direction: column; }
.dsh-vault-group { display: flex; flex-direction: column; min-height: 0; flex: 1 1 0; }
.dsh-vault-group-label { margin: 2px 8px; font-size: 10px; color: var(--vscode-descriptionForeground); }
/* ⇐ .kb-tree-node.kb-pending .kb-name（待构建素材：名字变淡 ＋ 斜体 ✓）
   ⚠ 真源同一节的第 2 条规则是 .kb-icon 变淡 —— 我们行里没有图标元素 ⇒ 跳过 ✓（不是等价实现 ✗）。
   ⚠ 本块是模板串：注释里不许出现反引号 ✗（今天翻车 4 次 ✓）。 */
.dsh-pending .t { opacity: 0.5; font-style: italic; }
/* ⇐ .kb-tree-node .kb-pending-badge（10px / 左距 4px / 不收缩 / .75 ✓） */
.dsh-pending-badge { font-size: 10px; margin-left: 4px; flex-shrink: 0; opacity: 0.75; }
/* ⇐ .kb-node .kb-status（状态点：7×7 / 圆形 / 不收缩 / 左距 4px ✓）
   ⚠ display: inline-block 是**我们加的** ✗ —— 真源那个 span 在 flex 行里（宽高天然生效 ✓）；
   我们的行是 li（非 flex）⇒ 不加这句，7×7 的点会按 inline 渲染成看不见 ✓（p3-71 专门断言 ✓）。 */
.dsh-status { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-left: 4px; display: inline-block; }
/* ⇐ .kb-status.raw（还没建成笔记：蓝 ✓） */
.dsh-status.raw { background: var(--vscode-textLink-foreground, #569cd6); }
/* ⇐ .kb-status.indexed（已建笔记：绿 ✓） */
.dsh-status.indexed { background: var(--vscode-testing-iconPassed, #6a9955); }
/* ⚠ 真源另有一条 .kb-status.modified（黄）—— 全仓只有 CSS、没有任何调用点 ✗（2026-10-13 核过 ✓）
   ⇒ 我们不做，免得造出一个永远不会出现的状态 ✓。 */
/* ⇐ .kb-resizer（分隔条：5px / 可拖拽光标 / 细线在 ::after 里 ✓） */
.dsh-resizer {
	flex: 0 0 auto;
	height: 5px;
	cursor: row-resize;
	position: relative;
	background: transparent;
}
.dsh-resizer::after {
	content: '';
	position: absolute;
	left: 0; right: 0; top: 2px;
	height: 1px;
	background: transparent;
}
.dsh-resizer:hover::after,
.dsh-resizer.dragging::after { background: var(--vscode-focusBorder, #007fd4); }
/* ⇐ .kb-scroll > [data-kb-region][data-kb-resized="1"]（被拖过的区域钉成固定像素高 ✓）
   ⚠ 复刻后的选择器：**区域本身就是那个节**（真源同理：.kb-section[data-kb-region] ✓）——
     第一版还写着 .dsh-section > .dsh-vault[...] ✗（旧结构留下的），实测症状是
     "拖了、变量也写了，**渲染高度纹丝不动**" ✓（p3-72 ⑩ 咬出来的 ✓）。 */
.dsh-section[data-kb-region][data-kb-resized="1"] { flex: 0 0 auto; height: var(--kb-region-h); min-height: 0; }
/* ⇐ 同上的 :not(.open)（折叠后自动回到 header 高，否则折叠了仍占着一片空白 ✓） */
.dsh-section[data-kb-region][data-kb-resized="1"]:not(.open) { height: auto; }
/* ⇐ .kb-section.kb-solo[data-kb-region][data-kb-resized="1"]（**唯一展开**时无视拖拽保存的高度 ✓
   真源注释：上面那条优先级 0,3,0 高于 .kb-section.open 的 0,2,0 ⇒ 不覆盖的话会"卡在固定像素高、下方留白" ✓） */
.dsh-section.dsh-solo[data-kb-region][data-kb-resized="1"] { flex: 1 1 0; height: auto; }
/* ★ 重命名入口（自定件 ✗）：真源是右键/F2 ＋ 点名字换输入框（.kb-rename-input ✓），
   我们是行尾 ✎ 按钮 ⇒ 这两类的样式**未逐条照抄** ⇒ 不映射进 p3-68 的按值对账 ✓（别当成同形 ✓）。 */
.dsh-rename {
	flex-shrink: 0;
	margin-left: 6px;
	padding: 0 4px;
	border: 0;
	border-radius: 3px;
	background: transparent;
	color: var(--vscode-descriptionForeground, #9d9d9d);
	cursor: pointer;
	font-size: 11px;
}
.dsh-rename:hover { color: var(--vscode-foreground, #ccc); background: rgba(128,128,128,.15); }
/* ★ 行内动作组（2026-10-14 §16.27）：值逐条照真源 kbView.css:282-290 ＋ :893 ✓
   （默认 display:none / hover 才 flex ✓ gap 1px / margin-left 4px ✓；.kb-act 20x20 / 圆角 3px /
   13px / 图标色 / opacity .8，hover 底色 ＋ opacity 1 ✓）。
   ⚠ 我们加的一处改进 ✓：:focus-within 也显示 —— 只靠 hover 的话**键盘用户永远够不到**这些按钮 ✗
   （真源有原生菜单兜底 ✓，我们的菜单也有 ✓，但按钮本身不该只认鼠标 ✓）。
   ⚠ 模板串里注释不许出现反引号 ✗。 */
.dsh-actions { display: none; align-items: center; gap: 1px; margin-left: 4px; }
.dsh-node:hover .dsh-actions, .dsh-node:focus-within .dsh-actions { display: flex; }
.dsh-act {
	width: 20px; height: 20px;
	display: flex; align-items: center; justify-content: center;
	border: 0; background: transparent; padding: 0;
	border-radius: 3px; cursor: pointer; font-size: 13px;
	color: var(--vscode-icon-foreground, #ccc); opacity: .8;
}
.dsh-act:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,.15))); opacity: 1; }
/* ★ 分区/目录空态（2026-10-14 §16.27）：文案逐字照真源 _createEmptyInline（:1835 ✓「暂无内容」），
   样式照 .kb-loading / .kb-empty-inline（kbView.css:361 ✓：内边距 8px 14px / 描述色 / 12px ✓）。 */
.dsh-empty-inline { padding: 8px 14px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
.dsh-empty-inline[hidden] { display: none; }
.dsh-rename-input {
	font-size: 12px;
	padding: 1px 4px;
	border-radius: 3px;
	border: 1px solid var(--vscode-focusBorder, #007fd4);
	background: var(--vscode-input-background, transparent);
	color: var(--vscode-input-foreground, inherit);
}
.dsh-rename-msg { margin-left: 6px; font-size: 11px; color: var(--vscode-editorWarning-foreground, #dcdcaa); }
.dsh-rename-msg.ok { color: var(--vscode-testing-iconPassed, #6a9955); }
/* ── 承载表面（2026-10-21）：同一页三形态 ────────────────────────────────
   surface=sideview ⇒ 目录页（列表吃满容器）；surface=editor ⇒ 正文页；缺省 ⇒ 完整页。
   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。 */
.dsh-doc { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.dsh-doc-head { flex: none; padding: 10px 16px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.dsh-doc-title { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
.dsh-doc-meta { font-size: 11px; color: var(--vscode-descriptionForeground, #999); margin: 0; word-break: break-all; }
.dsh-doc-body {
	flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 24px;
	white-space: pre-wrap; word-break: break-word;
	font-family: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
	font-size: 13px; line-height: 1.65; color: var(--vscode-foreground, inherit);
}
.dsh-doc-empty { color: var(--vscode-descriptionForeground, #999); font-family: inherit; }
/* 目录版（侧栏）：标题里那串统计让位给条目（窄栏里它会把标题挤成竖排 ✗） */
[data-vssaros-surface="sideview"] .dsh-header h1 small { display: none; }
[data-vssaros-surface="sideview"] .dsh-scroll { padding-bottom: 24px; }
`;

/**
 * 页内筛选 + 排序（与看板页同一套写法：`tasksView.ts:142-161` 的"状态 ∩ 关键字"在这里是
 * "vault ∩ 关键字"，再叠一个排序）。
 *
 * 为什么放页面而不是服务端：原 `KnowledgeBaseViewPane` 的搜索 / vault 切换 / 排序都是**本地状态**
 * （选中即重渲，不发请求）✓；走服务端要整页重载、还会丢输入焦点 ✗。JS 不可用时页面仍是
 * **全量只读列表**（按索引顺序）✓ —— 渐进增强：`hidden` 与 DOM 顺序从没被改过 ✓。
 *
 * 排序键在服务端渲染时就带上（`data-order` 补零串 / `data-title` 小写标题 ✓）：既省一次遍历，
 * 也让"切回索引顺序"有确定的复原依据 ✓（不靠 JS 记快照 ✗）。
 *
 * 如实记一档：筛选范围是**本页已渲染的行**（每库最多 `PAGE_DOC_LIMIT` 条）—— 全库检索是 `kb_search`
 * 工具的活（它走索引 ✓），页面不做假承诺 ✓。
 */
/**
 * 点条目 → **页内预览**正文（README 5.68）—— ⚠ 2026-10-15 起这块**只在没有页面桥时**才挂 ✓。
 *
 * ★ 为什么加这道闸（用户 2026-10-15 要求：“点击某个知识库的文件时，要求显示对应的 editorpane” ✓）：
 *   真源点条目走 editorService.openEditor（knowledgeBaseView.ts:2650-2652 ✓，同处还按类型分流
 *   .canvas / 图表 / 非文本 ✓）—— 落在**编辑器面板**；我们这页开不了编辑器 ⇒ 这一跳只能经页面桥
 *   （openFile ✓ 协议里早有、**不新增任何通道** ✓，与「思维导图」按钮同一条命令 ✓）。
 *   ⇒ 在宿主里**有桥就走桥** ✓：留着这块 sticky 面板会变成“永远不显示的 DOM” ✗，而“一次点击两条响应”
 *     正是最容易漂移的形态 ✗（本页既有纪律：同一个动作只有一份实现 ✓）。
 *   ⚠ 闸的判据必须与 KB_SCRIPT 段里的 hostCanOpenFiles() **同形**（改这条时**两边一起改** ✓）。
 *   ⚠ 真源那一步绑的是 ondblclick（:2101 ✓）、单击只选中（:2092-2100 ✓）—— 按用户的口径这里绑**单击** ✗→✓，
 *     且 Ctrl/Meta/Shift 按住时**只选中不开**（多选 ＋ 拖拽组织仍能用 ✓）；这条差异如实记 ✓。
 *
 * 为什么兜底走 /x/kb/api/doc 而不是把正文塞进页面：库可能很大 ✓（一次塞进去＝把整个库喂给浏览器 ✗）；
 * 而且 API 走的是**与 kb_read 同一条围栏** ✓ ⇒ 页面也读不到库外文件 ✓（只读、不改任何东西 ✓）。
 * 失败一律**如实显示原因**（路径围栏 / 文件被删 / 超大）✗ —— 不显示空白页 ✓。
 * （兜底会真正出场的场合：import 探针 ✓／手工用浏览器打开页面 ✓／老宿主 ✗ —— 那时**没有** window.vssarosDsh ✓。）
 */
const DOC_PREVIEW_SCRIPT = `
(function () {
	var root = document.querySelector('[data-vssaros-page="kb"]');
	if (!root || !window.fetch) { return; }
	// ⚠ 宿主能开文件 ⇒ 点条目由 KB_SCRIPT 段那条交给**编辑器** ✓ —— 本脚本整个不挂（连面板都不建 ✓）。
	//   判据与 KB_SCRIPT 段里的 hostCanOpenFiles() **同形** ✓（改这条时两边一起改 ✓）。
	var bridge = window.vssarosDsh;
	if (bridge && typeof bridge.openFile === 'function') { return; }
	var panel = document.createElement('div');
	panel.setAttribute('data-doc-preview', '');
	panel.hidden = true;
	panel.style.cssText = 'position:sticky;bottom:0;margin-top:10px;border-top:1px solid var(--vscode-panel-border, rgba(128,128,128,.35));padding:8px 10px;background:var(--vscode-sideBar-background, #1e1e1e);';
	panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px">'
		+ '<strong data-preview-title style="flex:1"></strong>'
		+ '<button type="button" data-preview-close style="cursor:pointer">关闭</button></div>'
		+ '<pre data-preview-body style="max-height:40vh;overflow:auto;white-space:pre-wrap;margin:6px 0 0"></pre>';
	root.appendChild(panel);
	var title = panel.querySelector('[data-preview-title]');
	var body = panel.querySelector('[data-preview-body]');
	function close() { panel.hidden = true; body.textContent = ''; }
	panel.querySelector('[data-preview-close]').addEventListener('click', close);
	document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { close(); } });
	Array.prototype.slice.call(root.querySelectorAll('[data-doc-row]')).forEach(function (row) {
		row.addEventListener('click', function () {
			var uri = row.getAttribute('data-uri');
			if (!uri) { return; }
			var nameEl = row.querySelector('.t');
			title.textContent = '读取中… ' + (nameEl ? nameEl.textContent : '');
			body.textContent = '';
			panel.hidden = false;
			window.fetch('/x/kb/api/doc?uri=' + encodeURIComponent(uri), { credentials: 'same-origin' })
				.then(function (res) { return res.json(); })
				.then(function (data) {
					if (!data || data.ok !== true) {
						body.textContent = '读不到正文：' + String((data && data.error) || '未知原因');
						return;
					}
					title.textContent = String(data.path || '');
					body.textContent = String(data.content || '') + (data.truncated ? '\\n…（已截断）' : '');
				})
				.catch(function (e) { body.textContent = '读不到正文：' + String(e && e.message ? e.message : e); });
		});
	});
})();
`;

/**
 * 正文版（`?surface=editor`，2026-10-21 新增）—— 编辑区承载「核心页」。
 *
 * 为什么正文由**这段脚本**取而不是服务端直出：选中项的唯一真源是**同源 localStorage**
 * （目录页与正文页是两个 webContents ⇒ 不能靠 DOM / React 通信；宿主只注入 `?surface=`，
 * 不传选中项 ⇒ 路由里带不了它 ✗）。⚠ 所以这一版**必须**有脚本；脚本没跑起来时如实显示
 * 「从左侧目录选一篇笔记」，不装死 ✓。
 *
 * 与 DOC_PREVIEW_SCRIPT 的区别：那个是**页内 sticky 面板**（只在没有页面桥时兜底），
 * 这个是**整页正文**（编辑区就这一块）⇒ 两者互斥，永不同时出现在同一份页面里 ✓。
 *
 * ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号，也不要写反斜杠 ✗（本仓已踩 6 次）。
 */
const DOC_SURFACE_SCRIPT = `
(function () {
	var root = document.querySelector('[data-vssaros-page="kb"]');
	if (!root || !window.fetch) { return; }
	var SEL_KEY = 'vssaros.wb.kb.sel';
	var body = root.querySelector('[data-doc-view-body]');
	var titleEl = root.querySelector('[data-doc-view-title]');
	var metaEl = root.querySelector('[data-doc-view-meta]');
	if (!body) { return; }
	function empty(text) {
		body.className = 'dsh-doc-body dsh-doc-empty';
		body.textContent = text;
	}
	function readSel() {
		// 显式深链优先（探针与手工核对用）：?doc=<uri>&title=<名字>
		try {
			var q = new URLSearchParams(window.location.search);
			var direct = q.get('doc');
			if (direct) { return { uri: direct, title: q.get('title') || '' }; }
		} catch (e) { /* 老浏览器没有 URLSearchParams ⇒ 继续走 localStorage */ }
		try {
			var raw = window.localStorage.getItem(SEL_KEY);
			var parsed = raw ? JSON.parse(raw) : null;
			return parsed && parsed.uri ? parsed : null;
		} catch (e) { return null; }
	}
	function show(sel) {
		if (!sel) {
			if (titleEl) { titleEl.textContent = '未选择'; }
			if (metaEl) { metaEl.textContent = ''; }
			empty('从左侧目录选一篇笔记（选中项会自动同步到这里）');
			return;
		}
		if (titleEl) { titleEl.textContent = sel.title || '（未命名）'; }
		if (metaEl) { metaEl.textContent = sel.uri || ''; }
		empty('正在读取…');
		window.fetch('/x/kb/api/doc?uri=' + encodeURIComponent(sel.uri), { credentials: 'same-origin' })
			.then(function (res) { return res.json(); })
			.then(function (data) {
				if (!data || data.ok !== true) {
					empty('读不到这篇笔记：' + String((data && data.error) || '未知原因'));
					return;
				}
				body.className = 'dsh-doc-body';
				body.textContent = String(data.content || '') + (data.truncated ? ' …（已截断）' : '');
			})
			.catch(function (e) { empty('请求失败：' + String(e && e.message ? e.message : e)); });
	}
	show(readSel());
	// 目录页改了选中项 ⇒ 同源 storage 事件（跨 webContents 也会派发）
	window.addEventListener('storage', function (ev) { if (ev && ev.key && ev.key !== SEL_KEY) { return; } show(readSel()); });
	// 从后台切回来时重读一次（个别宿主里 storage 事件不保证跨进程派发）
	document.addEventListener('visibilitychange', function () { if (!document.hidden) { show(readSel()); } });
})();
`;

const KB_SCRIPT = `
(function () {
	var root = document.querySelector('[data-vssaros-page="kb"]');
	if (!root) { return; }
	var rows = Array.prototype.slice.call(root.querySelectorAll('[data-doc-row]'));
	var blocks = Array.prototype.slice.call(root.querySelectorAll('[data-vault-block]'));
	var input = root.querySelector('[data-search-input]');
	// ── 承载表面（2026-10-21）：sideview = 目录页（点条目 ⇒ 编辑区的正文页）─────────────
	// 判据只有宿主注入的 data-vssaros-surface（renderShell 的 attrs 打在 body 上）；
	// **不看** window 尺寸、也不看 UA ✗（侧栏与编辑区同窗不同宽 ⇒ 尺寸判不出来 ✓）。
	var SURFACE = (function () {
		var b = document.body;
		var v = b ? String(b.getAttribute('data-vssaros-surface') || '') : '';
		return v === 'sideview' || v === 'editor' ? v : 'full';
	})();
	/** 选中项（同源 localStorage）：目录页写、正文页读（见 DOC_SURFACE_SCRIPT）。 */
	var KB_SEL_KEY = 'vssaros.wb.kb.sel';
	function rememberSelection(row) {
		try {
			var nameEl = row.querySelector('.t');
			window.localStorage.setItem(KB_SEL_KEY, JSON.stringify({
				uri: row.getAttribute('data-uri') || '',
				title: nameEl ? String(nameEl.textContent || '') : '',
				at: Date.now()
			}));
		} catch (e) { /* 隐私模式等：不记也能用（只是不跨载体同步）*/ }
	}
	/**
	 * 目录页点条目 ⇒ 请宿主把本模块页开在**编辑区**（core 版）。
	 * 走桥既有的 openModulePage（白名单只认模块页路由，不新增通道 ✓）；
	 * 没有这条能力（纯浏览器 / 老宿主）⇒ 返回 false，让既有路径接管 ✓。
	 */
	function openDocSurface() {
		var bridge = window.vssarosDsh;
		if (!bridge || typeof bridge.openModulePage !== 'function') { return false; }
		try {
			bridge.openModulePage('/x/kb/');
			return true;
		} catch (e) { return false; }
	}
	// ★ 库选择器（§16.25）：真源是**自定菜单** ✗（不是 select ✓）⇒ 当前筛选存在**状态变量**里 ✓
	//   （原先靠 <select data-vault-select> 的 value ✓ —— 那个元素已经搬走 ✓）。
	// ★ §16.29（用户第 ② 条）：默认**只显示当前库** —— 初值由服务端写在 vault bar 上
	//   （data-vault-default：IDE 注入的当前库 ✓，扫不到就退回第一个 ✓；空串 = 这个根下没有库 ✓）。
	//   ⚠ 页内脚本是**静态模板串** ⇒ 不能直接插服务端值 ⇒ 从 DOM 读 ✓（与其余"页面状态"同一手法 ✓）。
	var activeVault = (function () {
		var bar = root.querySelector("[data-vault-bar]");
		return bar ? String(bar.getAttribute("data-vault-default") || "") : "";
	})();
	var vaultMenu = root.querySelector('[data-vault-menu]');
	var vaultPick = root.querySelector('[data-vault-pick]');
	var vaultName = root.querySelector('[data-vault-name]');
	// ★ 排序（2026-10-14 §16.26）：<select> 换成"**搜索框内的按钮** ＋ 自定下拉"（真源 :663-670 / :3859-3885 ✓）
	//   ⇒ 状态存在变量里 ＋ localStorage ✓（真源按 vault 存 saveSort(vault.id, mode) ✓ :3875 ✓；
	//   我们的库选择器默认"全部库" ⇒ 用**单键** ✓ —— 差异如实记 ✗）。
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	function savedSortMode() {
		try { return window.localStorage.getItem('vssaros-kb-sort') || 'index'; } catch (e) { return 'index'; }
	}
	var sortMode = savedSortMode();
	var sortBtn = root.querySelector('[data-sort-btn]');
	var sortDD = root.querySelector('[data-sort-dropdown]');
	var count = root.querySelector('[data-count]');
	var empty = root.querySelector('[data-empty]');
	// ★ 交互（§15.5）：模式按钮 / 结果面板 / 分区折叠（真源 636-649 与 1765-1792 ✓）
	var modeBtn = root.querySelector('[data-search-mode]');
	var results = root.querySelector('[data-search-results]');
	var searchHead = root.querySelector('[data-search-head]');
	var searchList = root.querySelector('[data-search-list]');
	// 默认模式照真源：'_searchMode = 'fulltext''（knowledgeBaseView.ts:203 ✓）
	var searchMode = 'fulltext';
	var searchTimer = null;
	function setMode(next) {
		searchMode = next;
		var isFile = next === 'filename';
		if (modeBtn) {
			modeBtn.textContent = isFile ? '文件名' : '全文';
			modeBtn.title = isFile ? '当前：文件名筛选（点击切换为全文检索）' : '当前：全文检索（点击切换为文件名筛选）';
			if (isFile) { modeBtn.classList.add('filename'); } else { modeBtn.classList.remove('filename'); }
		}
		if (input) { input.placeholder = isFile ? '输入文件名筛选…' : '搜索资料库…'; }
		if (isFile && results) { hideResults(); }
	}
	function hideResults() {
		if (results) { results.classList.remove('show'); }
		if (searchList) { searchList.textContent = ''; }
	}
	function renderHits(headText, hits) {
		if (!results || !searchHead || !searchList) { return; }
		searchHead.textContent = headText;
		searchList.textContent = '';
		for (var i = 0; i < hits.length; i++) {
			var hit = hits[i];
			var li = document.createElement('li');
			li.className = 'dsh-search-hit';
			var strong = document.createElement('div');
			strong.textContent = String(hit.title || hit.path || '(无标题)');
			var small = document.createElement('small');
			small.textContent = String(hit.snippet || hit.path || '');
			li.appendChild(strong);
			li.appendChild(small);
			searchList.appendChild(li);
		}
		results.classList.add('show');
	}
	// 全文检索走服务端（本地索引在 IDE 侧建的 ✓）；**如实显示失败原因** ✗ 不显示成"没有结果" ✓
	function runFulltext(q) {
		if (!q) { hideResults(); return; }
		if (searchHead && results) { searchHead.textContent = '检索中…'; results.classList.add('show'); }
		window.fetch('/x/kb/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
			.then(function (res) { return res.json(); })
			.then(function (data) {
				if (!data || data.ok !== true) {
					renderHits('全文检索不可用：' + String((data && data.error) || '未知原因'), []);
					return;
				}
				var hits = Array.isArray(data.items) ? data.items : [];
				// ★ §16.11 的自动重建**要在页面上说** ✗（2026-10-14 补）：成功 ⇒ 说明用的是刚重建的索引 ✓；
				//   失败 ⇒ **明确说"本次用的是旧索引"＋原因** ✓（不许静默拿陈旧索引当结果 ✗ ——
				//   这条纪律 agent 侧的 kb_search 一直有 ✓，页面这条路由漏了 ✓）。
				var reindex = Array.isArray(data.reindex) ? data.reindex : [];
				var notes = reindex.map(function (entry) {
					return entry.error
						? ("库 " + entry.vaultId + " 索引重建失败（本次用的是旧索引）：" + String(entry.error))
						: ("库 " + entry.vaultId + " 索引已自动重建");
				});
				var head = hits.length ? ('全文命中 ' + hits.length + ' 条') : '全文没有命中';
				if (notes.length) { head += ' ｜ ' + notes.join('；'); }
				renderHits(head, hits.slice(0, 20));
			})
			.catch(function (e) { renderHits('全文检索请求失败：' + String(e && e.message ? e.message : e), []); });
	}
	// ★★ 排序（2026-10-14 §16.26）—— 形状照真源 sortNodes（knowledgeBaseView.ts:1966-1988 ✓）：
	//   · **目录与文件分成两组各自排、目录恒在前** ✓（真源 dirs.sort(cmp); files.sort(cmp);
	//     return [...dirs, ...files] ✓）。⚠ 旧版只排文档行 ✗，"目录在前"只是 appendChild（把每个
	//     文档行挪到末尾 ✓）的**副作用** ⇒ 语义隐式且脆（换个插入 API 就没了 ✓）⇒ 现在**显式**分组 ✓，
	//     顺带把"目录也吃这些维度"补上 ✓；
	//   · 键仍旧取行上的属性 ✓（值域与真源一致）：data-title（小写名 ✓）、data-created（ISO 串 ⇒
	//     字典序＝时间序 ✓）、data-mtime（epoch 秒 ✓）、data-size（字节 ✓）、data-child-count
	//     （目录的子项数 ✓ 真源 childCount :135-136 ✓）、data-order（索引顺序 ✓）。
	//   · ⚠ 真源 switch 里**没有** refCount 两项（落 default ⇒ 按名字排 ✗）⇒ 我们**不摆**（见服务端那段 ✓）。
	//   ⚠ 本文件是**模板串**：注释里不能出现反引号（会提前结束模板串 ⇒ SyntaxError ✓）。这条坑踩过多次。
	// 每个 vault 块各自排序（块之间不混排 —— 块是"哪个库"，行才是一个序）；树里的"顺序"是**目录内顺序**，
	// 逐个 ul 分别排 ✓。
	function sortBlock(block, mode) {
		Array.prototype.slice.call(block.querySelectorAll('ul')).forEach(function (list) {
			sortList(list, mode);
		});
	}
	function sortModeIsNumeric(mode) {
		return mode === 'modifiedASC' || mode === 'modifiedDESC'
			|| mode === 'docSizeASC' || mode === 'docSizeDESC'
			|| mode === 'subDocCountASC' || mode === 'subDocCountDESC';
	}
	function sortModeIsNatural(mode) { return mode === 'fileNameNatASC' || mode === 'fileNameNatDESC'; }
	function sortModeIsDesc(mode) { return /DESC$/.test(mode); }
	function sortKeyOf(row, mode) {
		if (mode === 'modifiedASC' || mode === 'modifiedDESC') { return String(row.getAttribute('data-mtime') || ''); }
		if (mode === 'createdASC' || mode === 'createdDESC') { return String(row.getAttribute('data-created') || ''); }
		if (mode === 'docSizeASC' || mode === 'docSizeDESC') { return String(row.getAttribute('data-size') || ''); }
		if (mode === 'subDocCountASC' || mode === 'subDocCountDESC') { return String(row.getAttribute('data-child-count') || ''); }
		if (mode === 'index') { return String(row.getAttribute('data-order') || ''); }
		return String(row.getAttribute('data-title') || '');
	}
	function sortList(list, mode) {
		// 只认**直接子元素**里的目录行与文档行：querySelectorAll 会深度匹配，顶层 ul 会把各目录的行一起抓来乱排。
		var kids = Array.prototype.slice.call(list.children).filter(function (child) {
			return child.hasAttribute && (child.hasAttribute('data-dir-node') || child.hasAttribute('data-doc-row'));
		});
		if (kids.length < 2) { return; }
		var numeric = sortModeIsNumeric(mode);
		var natural = sortModeIsNatural(mode);
		var desc = sortModeIsDesc(mode);
		var cmp = function (a, b) {
			var av = sortKeyOf(a, mode);
			var bv = sortKeyOf(b, mode);
			// 缺字段的沉底（"没有这个键"不该把行搅到最前）；⚠ 降序时 reverse 会把它翻到最前 ——
			// 可接受：那几行本来就没有可比的键，相对位置不承载信息。
			if (!av && bv) { return 1; }
			if (av && !bv) { return -1; }
			if (numeric) { return (Number(av) || 0) - (Number(bv) || 0); }
			// 自然序（真源的自写 naturalCompare ✓，语义等价："第 2 章" 排在 "第 10 章" 前 ✓）
			if (natural) { return av.localeCompare(bv, 'zh', { numeric: true }); }
			return av.localeCompare(bv);
		};
		var dirs = kids.filter(function (k) { return k.hasAttribute('data-dir-node'); });
		var docs = kids.filter(function (k) { return k.hasAttribute('data-doc-row'); });
		dirs.sort(cmp);
		docs.sort(cmp);
		if (desc) { dirs.reverse(); docs.reverse(); }
		dirs.concat(docs).forEach(function (item) { list.appendChild(item); });
	}
	function apply() {
		var q = input ? String(input.value || '').trim().toLowerCase() : '';
		var vault = activeVault;   // ★ §16.25：改由状态变量给（自定菜单 ✓）
		var mode = sortMode;   // ★ §16.26：自定下拉 ⇒ 由状态变量给
		// 标签元素每次现取（与其它下拉一致：不在顶部缓存引用，免得"页面重渲后引用变旧"）。
		var tagEl = root.querySelector('[data-tag-select]');
		var tag = tagEl ? String(tagEl.value || 'all') : 'all';
		var shown = 0;
		rows.forEach(function (row) {
			// 标签按"或"算（行上带选中的任一标签即命中）：data-tags 是竖线分隔的小写标签串。
			var tags = String(row.getAttribute('data-tags') || '').split('|');
			var hit = (vault === 'all' || row.getAttribute('data-vault') === vault)
				&& (tag === 'all' || tags.indexOf(tag) >= 0)
				&& (!q || String(row.getAttribute('data-search') || '').indexOf(q) >= 0);
			row.hidden = !hit;
			if (hit) { shown += 1; }
		});
		// ★ 2026-10-19（用户报「笔记里的子文件夹显示不全」）：
		//   **有没有筛选条件**决定"空目录要不要藏"——
		//   · 有筛选（搜索词 / 指定库 / 指定标签）⇒ 藏：筛完留一堆空壳目录头没意义 ✗；
		//   · 没筛选（默认视图）⇒ **照常显示**：目录是用户自己在磁盘上建的（02_工作 / 03_生活
		//     这种还没放文件的），藏掉就等于"页面上的库和资源管理器不一致"✗（真机报的就是这个）。
		// ⚠⚠ 2026-10-19 订正：**选中某个库不算筛选** ✗（vault 不等于 all 这条件已被移除）。
		//   第一版把它算进去了 ⇒ 用户只要在下拉里选了某个库（几乎所有人都会选 ✓），
		//   就被当成"有筛选" ⇒ 空目录继续被藏 ⇒ 用户报"还是缺文件夹"（真机 ✓）。
		//   只有**搜索词**和**标签**是真的筛选：它们会把行过滤掉，这时留空壳目录头才没意义 ✓。
		var filtering = !!q || (tag !== 'all');
		blocks.forEach(function (block) {
			sortBlock(block, mode);
			if (!filtering) { block.hidden = false; return; }
			var any = Array.prototype.some.call(block.querySelectorAll('[data-doc-row]'), function (row) { return !row.hidden; });
			block.hidden = !any;
		});
		// 目录层：内部一行可见都没有 ⇒ 连目录头一起藏（不留空目录头）。树只有一层目录，不必自底向上。
		// ⚠⚠ 2026-10-15 订正 ✗（§16.31，真机/file:// 两条探针同时咬出来）：这里原来选的是 .dsh-dir ✓ ——
		//   但在**真文件树**结构里那个类挂在**目录头按钮自己**上（<button class="dsh-node-button dsh-dir"
		//   data-dir-toggle> ✓ :282 ✓）⇒ 于是它给**按钮**挂 hidden ✗，而不是"把目录头所在的**那个行**藏起来" ✓。
		//   以前一直看不出来：作者样式 .dsh-node-button { display: flex } 盖掉了 UA 的 [hidden]{display:none}
		//   ✓（属性挂上、画面照旧 ✓）；加了那条全局规则之后就**真藏**了 ⇒ 行点不到 ✗（p3-72 ⑫ / p3-73 ⑧-b
		//   都崩在这 ✓）。⇒ 判据对象换成**目录行**（[data-dir-node] ✓），意图一字未改 ✓。
		Array.prototype.slice.call(root.querySelectorAll('[data-dir-node]')).forEach(function (dirRow) {
			// ★ 2026-10-19：无筛选时**不藏空目录**（见上面 filtering 的说明）。
			//   有筛选时才按"内部还有没有可见文件行"决定 —— 那才是这条规则原本的用途。
			if (!filtering) { dirRow.hidden = false; return; }
			var any = Array.prototype.some.call(dirRow.querySelectorAll('[data-doc-row]'), function (row) { return !row.hidden; });
			dirRow.hidden = !any;
		});
		// ★ 分区空态（2026-10-14 §16.27）：这一节里**一行可见的都没有** ⇒ 亮出「暂无内容」
		//   （真源 _refreshCountForBody :4660-4663 同口径 ✓ —— 筛选把它筛空了也要显示 ✓）。
		//   ⚠ 空态元素由服务端常驻渲出（本段只切 hidden ✓）—— 靠服务端那一次判断会漏掉筛选这条路 ✗。
		Array.prototype.slice.call(root.querySelectorAll('.dsh-section-body')).forEach(function (body) {
			var emptyEl = body.querySelector('[data-section-empty]');
			if (!emptyEl) { return; }
			emptyEl.hidden = Array.prototype.some.call(body.querySelectorAll('[data-doc-row]'), function (row) { return !row.hidden; });
		});
		if (count) { count.textContent = '共 ' + shown + ' 条文档'; }
		if (empty) { empty.hidden = shown !== 0; }
		// ★ 可见性刚变过 ⇒ 重算 solo（2026-10-15 §16.31 ✓）：切库（或搜索筛空一整个库 ✓）之后，
		//   "唯一展开的是哪一节"可能变了 ✓ —— 不重算就会把上一个库留下的 dsh-solo 带着走 ✗
		//   （它无视拖拽钉高 ✓，带错了就是"高度不听话" ✓）。⚠ updateSolo 里已含早退（vaults 未赋值）✓。
		updateSolo();
	// ★ 模式分流（真源 applyFilter ✓）：文件名档＝页内筛选（结果面板收起来）；
	//   全文档＝查服务端（防抖 250ms ⇒ 边打字边发请求会把进程问爆 ✗）
	var q = input ? String(input.value || '').trim() : '';
	if (searchMode === 'filename') {
		hideResults();
	} else {
		if (searchTimer) { clearTimeout(searchTimer); }
		if (!q) { hideResults(); }
		else { searchTimer = setTimeout(function () { runFulltext(q); }, 250); }
	}
	}
	if (input) { input.addEventListener('input', apply); }
	// ★★ 行内动作按钮（2026-10-14 §16.27）—— 与右键菜单**同一套通道** ✓（新建 → /api/new ✓、
	//   删除 → /api/delete ＋ 撤销回执 ✓；实现都取自 newInDir / deleteRow 那一份 ✓）。
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	Array.prototype.slice.call(root.querySelectorAll("[data-row-new]")).forEach(function (button) {
		button.addEventListener("click", function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			var row = button.closest("[data-doc-row],[data-dir-node]");
			if (!row) { return; }
			newInDir(row, button.getAttribute("data-row-new") || "file", button.getAttribute("data-row-new-dir") || "");
		});
	});
	Array.prototype.slice.call(root.querySelectorAll("[data-row-delete]")).forEach(function (button) {
		button.addEventListener("click", function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			var row = button.closest("[data-doc-row],[data-dir-node]");
			if (!row) { return; }
			// ⚠ 删除**两级确认** ✗（与菜单里那一项同一条纪律 ✓）：第一下只把按钮改编成"再点一次"，
			//   2.5 秒内不点 ⇒ 自己复位 ✓（这一下**不发任何请求** ✓，所以"误点一下不会删东西" ✓）。
			if (button.getAttribute("data-armed") !== "1") {
				button.setAttribute("data-armed", "1");
				button.setAttribute("data-act-old", button.textContent || "");
				button.setAttribute("data-title-old", button.getAttribute("title") || "");
				button.textContent = "✓";
				button.setAttribute("title", "再点一次确认删除（移入备份，可撤销）");
				toast("再点一次确认删除（移入备份，可撤销）", true);
				setTimeout(function () {
					if (button.getAttribute("data-armed") !== "1") { return; }
					button.removeAttribute("data-armed");
					button.textContent = button.getAttribute("data-act-old") || "🗑";
					button.setAttribute("title", button.getAttribute("data-title-old") || "删除（移入备份，可撤销）");
				}, 2500);
				return;
			}
			button.removeAttribute("data-armed");
			button.textContent = button.getAttribute("data-act-old") || "🗑";
			deleteRow(row, button.getAttribute("data-row-delete-path") || "");
		});
	});
	// ★★ 点**文件行** ⇒ 在编辑器里打开（2026-10-15，用户要求：真源点条目就是这个行为 ✓）——
	//   实现只有一份（openRowInHost ✓，与同页「思维导图」按钮同一条桥命令 ✓）。
	//   ⚠ **目录行不在内** ✗：它们没有 data-doc-row（点它是展开/折叠 ✓，真源亦然 ✓）。
	//   ⚠ 行内动作按钮（新建 / 重命名 / 删除）不会被误当成“打开” ✓：它们自己 stopPropagation ✓（见上面两段 ✓）。
	//   ⚠ Ctrl/Meta/Shift 按住 ⇒ **只选中不开** ✓（那是多选 / 拖拽组织的意图 ⇒ 不该顺手开一堆编辑器页签 ✗）。
	//   ⚠ 没有页面桥（纯浏览器 / 老宿主）⇒ 这一条**什么都不做** ✓，交给 DOC_PREVIEW_SCRIPT 的页内预览兜底 ✓
	//     （那边认同一条判据 ⇒ 不会两边都响 ✓）。⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	if (hostCanOpenFiles()) {
		Array.prototype.slice.call(root.querySelectorAll("[data-doc-row]")).forEach(function (row) {
			row.addEventListener("click", function (ev) {
				if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { return; }
				// ⚠ 只处理**最内层**那一行 ✗（树是嵌套的 ⇒ 否则点一个文件会把它每一层祖先都开一遍 ✓，
				//   与选中那段同一条纪律 ✓）。
				if (ev.target && ev.target.closest && ev.target.closest("[data-doc-row]") !== row) { return; }
				// ★ 2026-10-21：无论哪个表面都先记下选中项（正文页靠它同步，见 DOC_SURFACE_SCRIPT）
				rememberSelection(row);
				// 目录页（sideview）：这一跳的目标是**模块正文页**（编辑区承载），不是原始文件。
				// 只有"开不出正文页"时才退回原来的 openFile（老宿主 / 纯浏览器）✓。
				if (SURFACE === "sideview" && openDocSurface()) { return; }
				openRowInHost(row);
			});
		});
	}
	// ★★ 分区头工具栏「思维导图」（2026-10-14 §16.28）—— **只读**路由 ＋ 页面桥开文件 ✓
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	// ★ 2026-10-19：**每个分区都绑**（原先 querySelector 只绑第一个 ⇒ 多库时其余笔记区的按钮是死的 ✗；
	//   加上新加的「同步飞书」同理 ⇒ 统一改成 querySelectorAll ＋ forEach ✓）。
	Array.prototype.slice.call(root.querySelectorAll("[data-mindmap-open]")).forEach(function (mindmapBtn) {
		mindmapBtn.addEventListener("click", function (ev) {
			// ⚠ 必须拦下 ✗：它挂在分区头里，而分区头**自己**是可点的（折叠/手风琴 ✓）——
			//   不拦就会"点一下图、顺手把这一节折叠了" ✓（真源那句 e.stopPropagation() 同理 ✓）。
			ev.preventDefault();
			ev.stopPropagation();
			var section = mindmapBtn.closest(".dsh-section");
			var vaultId = section ? (section.getAttribute("data-vault") || "") : "";
			if (!vaultId) { toast("这一节没带 vault 标识 ⇒ 开不了", false); return; }
			// ★ 2026-10-19：**点下去先出回执** ✓ —— 原先只在 fetch 回来后才提示，
			//   一旦请求慢/静默失败，界面就是"没反应" ✗（toast 现在改 fixed 了，任何滚动位置可见 ✓）。
			toast("正在查找思维导图…", true);
			window.fetch("/x/kb/api/mindmap", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ vaultId: vaultId }),
			}).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
				.then(function (out) {
					if (!out.data || out.data.ok !== true) {
						// 失败**如实说** ✓ —— 包括"笔记区还没有 .canvas ⇒ 生成要去会话里调 kb_mindmap"那条指路 ✓
						toast("打不开思维导图：" + String((out.data && out.data.error) || ("HTTP " + out.status)), false);
						return;
					}
					var bridge = window.vssarosDsh;
					if (!bridge || typeof bridge.openFile !== "function") {
						// ⚠ 纯浏览器 / 老宿主 ⇒ **如实说** ✓（不许假装打开了 ✗），并把路径给出来让人自己能找 ✓
						toast("宿主不支持打开文件（需要页面桥）—— 思维导图在：" + String(out.data.path || ""), false);
						return;
					}
					try {
						// ⚠ 桥是**单向**的（invoke 只回 true ✓）⇒ 这里只能说"已请求" ✓；
						//   工作区之外的路径宿主会**先弹一次确认**（宿主既定的安全设计 ✓，我们不绕过也不隐藏 ✓）。
						bridge.openFile(String(out.data.path || ""));
						// ⚠ 桥是单向的 ⇒ 只能说到"已请求"这一步 ✓（不谎报"已打开" ✗）；
						//   并**预告**宿主会弹的那次确认（工作区之外的文件 ✓）—— 用户点了"取消"也不算没反应 ✓。
						toast("已请求宿主打开 " + String(out.data.name || "思维导图") + "（若弹出「工作区之外的文件」确认，请点允许）", true);
					} catch (e) {
						toast("打开失败：" + String(e && e.message ? e.message : e), false);
					}
				})
				.catch(function (e) { toast("请求失败：" + String(e && e.message ? e.message : e), false); });
		});
		mindmapBtn.addEventListener("keydown", function (ev) {
			if (ev.key !== "Enter" && ev.key !== " ") { return; }
			ev.preventDefault();
			mindmapBtn.click();
		});
	});
	// ★★ 库选择器 ＋ 同排两个按钮（2026-10-14 §16.25，照真源 :1321-1419 / :1339-1364 ✓）———————
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	function closeVaultMenu() {
		if (!vaultMenu) { return; }
		vaultMenu.classList.remove("show");
		vaultMenu.hidden = true;
		if (vaultPick) { vaultPick.setAttribute("aria-expanded", "false"); }
	}
	function openVaultMenu() {
		if (!vaultMenu) { return; }
		vaultMenu.hidden = false;
		vaultMenu.classList.add("show");
		if (vaultPick) { vaultPick.setAttribute("aria-expanded", "true"); }
	}
	function syncVaultChecks() {
		// 真源给选中项挂 codicon-check ✓（我们没图标字体 ⇒ 用 CSS 的 content 打勾 ✓）；顺带 aria-current ✓
		Array.prototype.slice.call(root.querySelectorAll("[data-vault-opt]")).forEach(function (opt) {
			opt.setAttribute("aria-current", opt.getAttribute("data-vault-opt") === activeVault ? "true" : "false");
		});
	}
	if (vaultPick && vaultMenu) {
		vaultPick.addEventListener("click", function (ev) {
			ev.stopPropagation();
			if (vaultMenu.classList.contains("show")) { closeVaultMenu(); } else { openVaultMenu(); }
		});
		vaultPick.addEventListener("keydown", function (ev) {
			if (ev.key !== "Enter" && ev.key !== " ") { return; }
			ev.preventDefault();
			if (vaultMenu.classList.contains("show")) { closeVaultMenu(); } else { openVaultMenu(); }
		});
		Array.prototype.slice.call(vaultMenu.querySelectorAll("[data-vault-opt]")).forEach(function (opt) {
			opt.addEventListener("click", function (ev) {
				ev.stopPropagation();
				activeVault = opt.getAttribute("data-vault-opt") || "all";
				var label = opt.querySelector(".dsh-opt-name");
				if (vaultName) { vaultName.textContent = label ? String(label.textContent || "") : "全部库"; }
				syncVaultChecks();
				closeVaultMenu();
				apply();
				// ★ 2026-10-19：**切库也要上报** —— 否则服务端只知道 IDE 启动时注入的那个库
				//   ⇒ "切完库立刻让模型写笔记"会写进上一个库 ✗（这条就是补这个缺口）。
				//   传 dir 空 ⇒ 该库的"当前目录"清空（用户切库后本来就要重新进目录，
				//   比留着上一个库的目录去兜底更安全 ✓）。
				reportActiveVault(activeVault);
			});
		});
		// 点别处 / Esc ⇒ 关（真源靠面板上的 click 收 ✓；这里挂在 document 上 ✓ —— 点页面任意处都收 ✓）
		document.addEventListener("click", function () { closeVaultMenu(); });
		document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closeVaultMenu(); } });
		syncVaultChecks();
		// ★ 2026-10-19：**首屏也报一次** —— 否则 sidecar 里没有 activeVaultId，
		//   第一次写笔记只能退回 IDE 注入值（那值可能是旧的 ✓）。这里报的是页面当前选中的库 ✓。
		reportActiveVault(activeVault);
	}
	// ★★ 库下拉里的**增删**（2026-10-15 §16.32，用户报"下拉框UI中没有增删入口" ✓；mockup 已审 ✓）——
	//   · 增：菜单底部那一项 ⇒ 桥 kbAddVault（桥 8 ✓）⇒ 宿主弹**原生选目录** ✓。
	//   · 删：**库项右键**（真源同形 ✓ —— 它的删除也藏在右键里 ✓）⇒ 「删除知识库…」：
	//       已登记 ⇒ 桥 kbRemoveVault（宿主 removeVault **自带原生确认框** ✓ ⇒ 页内**不**二次确认 ✗）；
	//       未登记 ⇒ 页内**两级确认**（既有手法：菜单项第一下只变问句、2.5s 复原 ✓）⇒ /api/vault-delete。
	//   ⚠ 库级删除＝**永久删除**（用户点头 ✓），与文件行的「移入备份」**不是一回事** ✗ —— 文案各自说清 ✓。
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	var vaultAddBtn = root.querySelector("[data-vault-add]");
	if (vaultAddBtn) {
		vaultAddBtn.addEventListener("click", function (ev) {
			ev.preventDefault(); ev.stopPropagation();
			closeVaultMenu();
			openHostPanel("kbAddVault", "添加知识库", 8);
		});
	}
	Array.prototype.slice.call(root.querySelectorAll("[data-vault-opt]")).forEach(function (opt) {
		opt.addEventListener("contextmenu", function (ev) {
			ev.preventDefault(); ev.stopPropagation();
			closeVaultMenu();
			var vaultId = opt.getAttribute("data-vault-opt") || "";
			if (!vaultId) { return; }
			var nameEl = opt.querySelector(".dsh-opt-name");
			var label = nameEl ? String(nameEl.textContent || "") : vaultId;
			var reg = opt.getAttribute("data-vault-registered");
			if (reg === "yes") {
				openMenuAt(ev.clientX, ev.clientY, [{ label: "删除知识库…", run: function () { openHostPanel("kbRemoveVault", "删除知识库", 8, vaultId); } }]);
				return;
			}
			// ⚠ 只有**确知未登记**（"no"）才给永久删除 ✓；不知道（没拿到 IDE 清单 ⇒ "unknown"）一律 fail-closed ✗
			//   （2026-10-15 §16.33 真机事故：注入挂错行 ⇒ 所有库都被当成"未登记" ⇒ 已登记的库也会被永久删 ✗）。
			if (reg !== "no") {
				openMenuAt(ev.clientX, ev.clientY, [{
					label: "删除知识库…（不可用：没拿到 IDE 的库清单）",
					run: function () { toast("本页没拿到 IDE 的库清单，判断不了这个库是否已登记 ⇒ 不提供永久删除；请在 IDE 的知识库视图里删，或重启 Host 后再试", false); },
				}]);
				return;
			}
			openMenuAt(ev.clientX, ev.clientY, [{
				label: "删除知识库…",
				confirmLabel: "确认删除「" + label + "」及其全部内容？（不可逆）",
				run: function () { deleteVault(vaultId, opt); },
			}]);
		});
	});
	function deleteVault(vaultId, optEl) {
		window.fetch("/x/kb/api/vault-delete", {
			method: "POST", credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: vaultId }),
		}).then(function (res) {
			return res.json().then(function (data) { return { status: res.status, data: data }; });
		}).then(function (out) {
			if (!out.data || !out.data.ok) { toast("删除失败：" + String(out.data && out.data.error ? out.data.error : out.status), false); return; }
			// ⚠ 不自动重载 ✗（§15.47 那条教训 ✓）：只把这个库的块与菜单项从 DOM 摘掉 ✓
			//   （删除结果我们已经知道 ⇒ 别为了它重扫整个库 ✓）。
			if (optEl && optEl.parentNode) { optEl.parentNode.removeChild(optEl); }
			Array.prototype.slice.call(root.querySelectorAll("[data-vault-block]")).forEach(function (block) {
				if (String(block.getAttribute("data-kb-region") || "") === vaultId) { block.parentNode.removeChild(block); }
			});
			toast("已删除该库及其全部内容（不可逆 ✓）", true);
		}).catch(function (e) { toast("删除失败：" + String(e && e.message ? e.message : e), false); });
	}
	// ★★ 初次装订：**开局跑一次筛选**（2026-10-15 真机截图咬出来的 ✗）——
	//   用户第 ② 条（"仅应该显示当前选择的库"）当时**只落了选择器的默认值** ✓：activeVault 的初值
	//   确实读的是服务端写的 data-vault-default（IDE 注入的当前库 ✓），但**没人调用 apply()** ✗
	//   ⇒ 页面上**两个库的块全都显示着** ✓（apply() 只在搜索输入与选中库时才跑 ✓）——
	//   这正是"看着像修了、其实没修"的那种差 ✗，机器断言也漏了（只钉了选择器的名字 ✓）。
	//   ⚠ 位置放在**全部装订之后** ✓：apply() 要读 expandedMap / sortMode / blocks ✓，
	//     早于它们会读到 undefined ✓（渐进增强那条性质不变 ✓：JS 不在 ⇒ 服务端渲染的全量仍在 ✓）。
	apply();
	// ⚠ 「文件树 ⇄ 最近编辑」**有意不同** ✗：真源 switch 到**另一套视图**（扁平的"最近编辑"列表 ✓
	//   :1798-1812 ✓），我们**不做第二套视图** ✗ ⇒ 落到「**展开全部目录 ＋ 同级按编辑时间倒序**」上 ✓
	//   （按钮名/图标/位置照真源 ✓；行为差异摆在这 ✓）。切回文件树 ⇒ 恢复**记住的**展开态 ＋ 回索引顺序 ✓
	//   ⚠ 最近编辑那次的展开**不落库** ✗（persist=false ✓）—— 否则"看一眼最近编辑"会把用户的折叠态改掉 ✓。
	// ★★ 排序按钮 ＋ 下拉（2026-10-14 §16.26；形状照真源 openSearchSortDropdown :3859-3885 ✓）————
	//   · 按钮在**搜索框内**（真源 :663-670 ✓）；下拉是**分组列表**（每组一个标题 ＋ 选项 ＋ 勾选位 ✓）；
	//   · 选中 ⇒ 换档 ＋ **落库**（真源 saveSort(vault.id, mode) :3875 ✓；我们单键 ✓ 见上面注释 ✗）；
	//   · ⚠ 按钮只有图标 ✗ ⇒ **当前档要能看出来**：写进 title / aria-label ✓，并把当前档挂到 root 上
	//     （data-sort-mode ✓）当机器可读态 ✓ —— 下拉收起后就没有别的痕迹了 ✓。
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	function persistSortMode() {
		try { window.localStorage.setItem('vssaros-kb-sort', sortMode); } catch (e) { /* 存不上就只在本次会话里生效 ✓ */ }
	}
	function sortLabelOf(mode) {
		var opt = root.querySelector('[data-sort-opt="' + mode + '"]');
		return opt ? String(opt.textContent || '').trim() : mode;
	}
	function syncSortChecks() {
		Array.prototype.slice.call(root.querySelectorAll("[data-sort-opt]")).forEach(function (opt) {
			opt.setAttribute("aria-checked", opt.getAttribute("data-sort-opt") === sortMode ? "true" : "false");
		});
		root.setAttribute("data-sort-mode", sortMode);
		if (sortBtn) {
			sortBtn.setAttribute("title", "排序：" + sortLabelOf(sortMode));
			sortBtn.setAttribute("aria-label", "排序：" + sortLabelOf(sortMode));
		}
	}
	function setSortMode(mode, persist) {
		sortMode = String(mode || "index");
		if (persist) { persistSortMode(); }
		syncSortChecks();
		apply();
	}
	function closeSortDD() {
		if (!sortDD) { return; }
		sortDD.classList.remove("show");
		sortDD.hidden = true;
		if (sortBtn) { sortBtn.setAttribute("aria-expanded", "false"); }
	}
	function openSortDD() {
		if (!sortDD || !sortBtn) { return; }
		sortDD.hidden = false;
		sortDD.classList.add("show");
		sortBtn.setAttribute("aria-expanded", "true");
		// 定位：与右键菜单同一套（position: fixed ＋ 按钮下沿 ✓）；右边出屏就往回收 ✓
		var rect = sortBtn.getBoundingClientRect();
		var width = sortDD.offsetWidth || 220;
		sortDD.style.left = String(Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))) + "px";
		sortDD.style.top = String(rect.bottom + 2) + "px";
	}
	if (sortBtn && sortDD) {
		sortBtn.addEventListener("click", function (ev) {
			ev.stopPropagation();
			if (sortDD.classList.contains("show")) { closeSortDD(); } else { openSortDD(); }
		});
		sortBtn.addEventListener("keydown", function (ev) {
			if (ev.key !== "Enter" && ev.key !== " ") { return; }
			ev.preventDefault();
			if (sortDD.classList.contains("show")) { closeSortDD(); } else { openSortDD(); }
		});
		Array.prototype.slice.call(sortDD.querySelectorAll("[data-sort-opt]")).forEach(function (opt) {
			opt.addEventListener("click", function (ev) {
				ev.stopPropagation();
				closeSortDD();
				setSortMode(opt.getAttribute("data-sort-opt") || "index", true);
			});
		});
		document.addEventListener("click", function () { closeSortDD(); });
		document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closeSortDD(); } });
		syncSortChecks();
	}
	var viewBtn = root.querySelector("[data-view-mode]");
	if (viewBtn) {
		viewBtn.addEventListener("click", function () {
			var recent = viewBtn.getAttribute("data-view-mode") !== "recent";
			viewBtn.setAttribute("data-view-mode", recent ? "recent" : "tree");
			viewBtn.setAttribute("title", recent ? "最近编辑（点回文件树）" : "文件树视图");
			viewBtn.textContent = recent ? "🕘" : "🌲";
			Array.prototype.slice.call(root.querySelectorAll("[data-dir-node]")).forEach(function (dirRow) {
				if (recent) { setDirOpen(dirRow, true, false); }
				else { setDirOpen(dirRow, !!expandedMap[dirRow.getAttribute("data-dir-rel") || ""], false); }
			});
			// ★ §16.26：档位名改用真源枚举（最近编辑 ＝ modifiedDESC ✓）
			setSortMode(recent ? "modifiedDESC" : "index", true);
		});
	}
	var refreshBtn = root.querySelector("[data-vault-refresh]");
	if (refreshBtn) {
		// 真源 refresh() 是"重新取一遍树" ✓；本页是**服务端渲染** ⇒ 重载就是刷新 ✓（拿到的就是服务端最新树 ✓）
		refreshBtn.addEventListener("click", function () { window.location.reload(); });
	}
	// ★★ 设置 ＋ 关系图谱（2026-10-15 §16.29 ④⑤）—— **只走页面桥** ✓：两个面板都是中间栏
	//   EditorPane（真源 :2775 / :5461 ✓），页面自己开不了 ✗ ⇒ 请宿主在编辑区打开 ✓
	//   （桥 7 的 openKbSettings / openKbGraph ✓）。
	//   ⚠ 旧宿主（没有这两条命令 / bridgeVersion < 7）⇒ **如实提示**，不静默、也不假装打开了 ✗。
	//   ⚠ 桥是**单向**的（invoke 只回 true ✓）⇒ 只能说"已请求" ✓；真开没开由宿主决定 ✓。
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	//   ⚠ 2026-10-15（增删，桥 8）：needVersion 与 arg 是**可选**的 ✓ —— ⚙/🕸 进桥时是 7、增删是 8 ✓，
	//     别用 7 去量 8 的命令 ✗；arg 只有 kbRemoveVault 用（库 id ✓），其余传 undefined ✓。
	function openHostPanel(method, label, needVersion, arg) {
		var bridge = window.vssarosDsh;
		var version = bridge && typeof bridge.bridgeVersion === "number" ? bridge.bridgeVersion : 0;
		var need = needVersion || 7;
		if (!bridge || typeof bridge[method] !== "function" || version < need) {
			toast("这个宿主还不支持" + label + "（需要页面桥 " + need + " ⇒ 在 IDE 里重装一次这个插件）", false);
			return;
		}
		try {
			bridge[method](arg);
			toast("已请求打开" + label, true);
		} catch (e) {
			toast(label + "请求失败：" + String(e && e.message ? e.message : e), false);
		}
	}
	var settingsBtn = root.querySelector("[data-kb-settings]");
	if (settingsBtn) { settingsBtn.addEventListener("click", function (ev) { ev.stopPropagation(); openHostPanel("openKbSettings", "知识库设置"); }); }
	// ★★ 分区头「同步飞书」（2026-10-19，用户要求补上）—— 与 ⚙ 走**同一条**宿主命令（openKbSettings ✓）：
	//   页面是只读通道、也没有进度/取消 ⇒ 不在页面跑同步（真源在已启用时是直接跑 apply ✓，那是写＋分钟级）。
	//   ⇒ 桥 12 起**直接开始同步**（宿主转 agentStudio.kb.feishuSync）；旧宿主退回"打开设置"并如实说明 ✓。
	//   ⚠ 每个分区都绑（多库时都有 ✓）；⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	Array.prototype.slice.call(root.querySelectorAll("[data-feishu-sync]")).forEach(function (feishuBtn) {
		feishuBtn.addEventListener("click", function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			// ★★ 2026-10-19 晚：**真的开始同步**（用户报"点了只打开设置、不开始同步" ✗ —— 他点的是"同步"按钮）。
			//   桥 12 的 kbFeishuSync ⇒ 宿主转 IDE 命令 agentStudio.kb.feishuSync ⇒
			//   照真源：未启用则通知 + 定位「飞书同步」分组；已启用则 feishuSync('apply')（集成终端里跑脚本，输出可见）。
			//   ⚠ 页面**不自己判断开关**（判据只在 IDE 侧一处 ✓），也不假装"已同步完成"（只能说"已请求" ✓）。
			var syncBridge = window.vssarosDsh;
			var syncVersion = syncBridge && typeof syncBridge.bridgeVersion === "number" ? syncBridge.bridgeVersion : 0;
			if (syncBridge && typeof syncBridge.kbFeishuSync === "function" && syncVersion >= 12) {
				try {
					syncBridge.kbFeishuSync();
					toast("已请求开始同步飞书 —— 进度与结果在 IDE 的集成终端里", true);
				} catch (e) {
					toast("同步请求失败：" + String(e && e.message ? e.message : e), false);
				}
				return;
			}
			// 旧宿主（桥 < 12 / 没有这条命令）⇒ 退回"打开设置"，并**如实说**为什么没有一键同步 ✗
			openHostPanel("openKbSettings", "知识库设置（飞书同步）");
			toast("当前宿主不支持一键同步（需要页面桥 12）—— 已打开设置里的「飞书同步」分组；或重装插件/IDE 后重试", false);
		});
		feishuBtn.addEventListener("keydown", function (ev) {
			if (ev.key !== "Enter" && ev.key !== " ") { return; }
			ev.preventDefault();
			feishuBtn.click();
		});
	});
	var graphBtn = root.querySelector("[data-kb-graph]");
	if (graphBtn) { graphBtn.addEventListener("click", function (ev) {
		ev.stopPropagation();
		// ★★ 2026-10-19：关系图谱**已迁到 dsh 侧独立页面**（/x/kb/graph）⇒ 直接**同源跳转**，
		//   不再切到 IDE 的编辑器 Tab（那条路是旧实现，阶段 3 会删掉 IDE 侧）。
		//   ⚠ 用 location.href 而不是页面桥命令：同源页面导航不需要任何宿主能力 ✓
		//     （openModulePage 还要把路由加进宿主白名单，多一处要同步的地方）。
		//   ⚠ activeVault 是页面上的"当前库"（'all' = 未指定）⇒ all 时传空，
		//     由服务端按 IDE 注入的 kbActiveVaultId 兜底（与其它路由同一口径 ✓）。
		// ★★ 2026-10-19（用户报「图谱应该开在编辑区、不是侧栏」）：优先**交宿主在编辑区打开**。
		//   同源跳转只会在**当前承载面**里换页 —— dsh 页若在侧栏，跳完还在侧栏（实测踩到 ✗）。
		//   openModulePage 先**精确匹配**、再按**前缀归属**（白名单里的 /x/kb/ ⇒ /x/kb/graph 归它）→
		//   编辑器页输入 → 编辑区 tab ✓。⚠ 白名单是**精确匹配** ⇒ 这里不带 query string。
		var graphBridge = window.vssarosDsh;
		if (graphBridge && typeof graphBridge.openModulePage === 'function') {
			graphBridge.openModulePage('/x/kb/graph');
			return;
		}
		// 旧宿主兜底（没有桥 / 桥版本过低）：同源跳转，至少能看到图（落在哪个承载面就哪个）
		window.location.href = '/x/kb/graph';
	}); }
	// ⚠ 这里原来挂着 sortSelect 的 change 监听 ✗ —— §16.26 把 select 换成自定下拉后**忘了删** ⇒
	//   sortSelect 已不存在 ⇒ 页面加载时 **ReferenceError** ⇒ 整段脚本死掉（筛选/折叠/拖拽全哑 ✓）。
	//   是"页面零脚本错误"那条探针该咬的洞 ✓（页内脚本**能解析** ✗ ≠ 能跑 ✓ —— 两者都要守 ✓）。
	var tagSelect = root.querySelector('[data-tag-select]');
	if (tagSelect) { tagSelect.addEventListener('change', apply); }

	// ★ 目录展开态（2026-10-14 §16.24，照真源 ✓）：**默认折叠** ＋ 展开态落 localStorage ✓
	//   · 真源：_expandedFolders 是内存里的路径集合 ✓、按 vault+分区持久化
	//     （agentStudio.kb.expanded 前缀 ＋ vaultId ＋ section ✓ :161,575-577 ✓），刷新后按集合逐级恢复
	//     （:1886-1892 ✓）—— 我们的粒度就取行的 data-dir-rel ✓（已含分区 ✓，等价 ✓）。
	//   · ⚠ 恢复时**不必**讲究自顶向下 ✗：所有行都在 DOM 里、各自 hidden ✓，一起设置即可 ✓
	//     （父没展开时子行本来就被父的 hidden 罩住 ✓）。
	//   · ⚠ 服务端渲染的默认态是"折叠"（aria-expanded=false ＋ 子树 hidden ✓）⇒ 本段只负责
	//     **恢复** 与 **持久化** ✓；没有 JS 时由 renderPage 注入的 noscript 样式兜底全量可见 ✓。
	//   ⚠ 本段在模板串里 ⇒ 注释不许出现反引号 ✗。
	var EXPAND_KEY = "vssaros-kb-expanded";
	function savedExpanded() {
		try { return JSON.parse(window.localStorage.getItem(EXPAND_KEY) || "{}") || {}; } catch (e) { return {}; }
	}
	function persistExpanded(map) {
		try { window.localStorage.setItem(EXPAND_KEY, JSON.stringify(map)); } catch (e) { /* 隐私模式：展开仍生效，只是不持久 ✓ */ }
	}
	var expandedMap = savedExpanded();
	function setDirOpen(dirRow, next, persist) {
		if (!dirRow) { return; }
		var head = dirRow.querySelector("[data-dir-toggle]");
		var list = dirRow.querySelector(".dsh-node-children") || dirRow.querySelector("ul");
		if (list) { list.hidden = !next; }
		if (head) {
			head.setAttribute("aria-expanded", next ? "true" : "false");
			// ⚠ 新结构里整行是「twist ＋ 图标 ＋ 名称 ＋ 计数徽标」⇒ **不能整块重写 textContent** ✗
			//   （那会把图标与徽标一起抹掉 ✓）⇒ 只改那个 twist 字形 ✓；旧结构仍走原来的整块重写法 ✓。
			var twist = head.querySelector(".dsh-twist");
			if (twist) { twist.textContent = next ? "▾" : "▸"; }
			else { var text = head.textContent || ""; head.textContent = (next ? "▾" : "▸") + text.slice(1); }
		}
		if (!persist) { return; }
		var key = dirRow.getAttribute("data-dir-rel") || "";
		if (!key) { return; }
		if (next) { expandedMap[key] = 1; } else { delete expandedMap[key]; }
		persistExpanded(expandedMap);
	}
	// 恢复（照真源 :1886-1892 "按集合恢复展开" ✓）—— ⚠ 必须在**挂点击之前**跑一遍 ✓
	Array.prototype.slice.call(root.querySelectorAll("[data-dir-node]")).forEach(function (dirRow) {
		if (expandedMap[dirRow.getAttribute("data-dir-rel") || ""]) { setDirOpen(dirRow, true, false); }
	});
	// ★ 2026-10-19（用户报「模型写笔记没落到我当前在看的目录」）：
	//   **「当前目录」= 我最后展开的那个目录** ⇒ 上报给服务端（它给 kb_write_note 兜底）。
	//   ⚠ 节流 800ms + 同值不重复发：展开是高频动作，每点一次就打一次请求没必要 ✗。
	//   ⚠ 失败**静默**：记不住当前目录不该打断用户（大不了写回笔记区根 ✓）。
	//   ⚠ 本段在模板串里 ⇒ 不许出现反引号 ✗。
	var activeDirTimer = null;
	var lastActiveDir = '';
	/**
	 * 上报「当前库」（切库时调）—— 服务端据此更新 sidecar 的 activeVaultId。
	 *
	 * ★ 2026-10-19：补的是这条缺口 —— config.kbActiveVaultId 是 IDE **启动时**注入的静态值，
	 *   用户中途在页面上切库，服务端毫不知情 ⇒ 写工具会把笔记写进**上一个**库 ✗。
	 *   传 dir 空串 ⇒ 该库的"当前目录"清空（切库后用户本来就要重新展开目录 ✓，
	 *   比留下上一个库的目录去兜底安全 ✓）。
	 *   ⚠ all（全部库）不是真实 vault ⇒ 不报（报了服务端会拒 ✓）。
	 *   ⚠ 失败静默：记不住当前库不该打断用户（写工具会退回 IDE 注入值 ✓）。
	 *   ⚠ 本段在模板串里 ⇒ 不许出现反引号 ✗。
	 */
	function reportActiveVault(vaultId) {
		if (!vaultId || vaultId === 'all') { return; }
		try {
			window.fetch('/x/kb/api/active-dir', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ vaultId: vaultId, dir: '' }),
			}).catch(function () { /* 静默 */ });
		} catch (e) { /* 静默 */ }
	}
	function reportActiveDir(dirRow) {
		var dirRel = dirRow.getAttribute('data-dir-rel') || '';
		var vaultId = dirRow.getAttribute('data-vault') || '';
		if (!dirRel || !vaultId || dirRel === lastActiveDir) { return; }
		lastActiveDir = dirRel;
		if (activeDirTimer) { clearTimeout(activeDirTimer); }
		activeDirTimer = setTimeout(function () {
			activeDirTimer = null;
			try {
				window.fetch('/x/kb/api/active-dir', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ vaultId: vaultId, dir: dirRel }),
				}).catch(function () { /* 静默：见上 */ });
			} catch (e) { /* 静默 */ }
		}, 800);
	}
	Array.prototype.slice.call(root.querySelectorAll('[data-dir-toggle]')).forEach(function (head) {
		head.addEventListener('click', function () {
			// ★ 复刻（§15.38）：目录行换成 .dsh-node.dir（钩子 data-dir-node ✓）—— **新旧都认** ✓。
			var dir = head.closest('[data-dir-node]') || head.closest('.dsh-dir');
			if (!dir) { return; }
			var opening = head.getAttribute('aria-expanded') === 'false';
			setDirOpen(dir, opening, true);
			// 只在**展开**时算"我进了这个目录"（收起不代表我去别处 ✓）
			if (opening) { reportActiveDir(dir); }
		});
	});

	// ★ 模式切换按钮（真源 636-649 ✓）：点一下换档 ＋ 立刻按新模式重筛一次 ✓
	if (modeBtn) {
		modeBtn.addEventListener('click', function () {
			setMode(searchMode === 'fulltext' ? 'filename' : 'fulltext');
			apply();
		});
	}
	setMode(searchMode);

	// ★ 分区折叠 ＋ 手风琴互斥 ＋ .dsh-solo（真源 _collapseOthers / _updateSoloSection ✓）
	//   初始：全部展开（与"JS 不在时仍全量可见"一致 ✓）⇒ open 数 ≠ 1 ⇒ 不打 solo ✓（照真源：0 或 2+ 个展开时清除标记 ✓）
	// ★ 复刻（§15.38）：分区从"vault 段"变成「库」/「笔记」**节** ⇒ 手风琴/solo 的作用对象跟着扩到 .dsh-section ✓
	//   （新旧都收 ✓ —— 切结构那一步之前/之后同一段代码都成立 ✓）。
	var vaults = Array.prototype.slice.call(root.querySelectorAll('.dsh-vault, .dsh-section'));

	// ★ 分区折叠 ＋ **手风琴互斥**（真源 .kb-section.open ＋ _collapseOthers ✓）——两者必须**同一处**做 ✗：
	//   第一版只在新钩子里折叠、互斥还留在旧钩子上 ⇒ 点节头"只折叠、不互斥" ✓（p3-72 ⑧ 咬出来的 ✓）。
	Array.prototype.slice.call(root.querySelectorAll('[data-section-toggle]')).forEach(function (head) {
		head.addEventListener('click', function () {
			var sec = head.closest('.dsh-section');
			if (!sec) { return; }
			var open = !sec.classList.contains('open');
			// 展开一个 ⇒ 把**其它分区**收起（真源 _collapseOthers ✓），随后重算 solo ✓
			// ⚠ 只收**可见**的那些（2026-10-15 §16.31 ✓）：隐藏库的节**收不动**（点不到 ✓）也不该被
			//   这一次点击改动 ⇒ 留着它的展开态，切回去时还是原样 ✓（与"可见区规则"同一条 ✓）。
			if (open) { visibleVaults().forEach(function (other) { if (other !== sec) { setOpen(other, false); } }); }
			setOpen(sec, open);
			updateSolo();
		});
	});
		// ★★ 行选中 ＋ F2 改名（复刻 knowledgeBaseView.ts:2279-2334 与 :679-704 ✓）
	//    语义逐条照真源：Ctrl 切换 / Shift **并入区间**（不清空其它 ✗ 别按习惯改）/ 单击清空后单选 ✓；
	//    选完把焦点给容器 ✓（F2/Delete 才收得到 ✓ —— 真源 :680 的 scroll.tabIndex = -1 ✓）。
	var selectedRows = [];
	var lastSelectedRel = null;
	var scrollEl = root.querySelector(".dsh-scroll") || root;
	if (scrollEl && scrollEl.setAttribute) { scrollEl.setAttribute("tabindex", "-1"); }
	function rowKeyOf(row) { return row.getAttribute("data-rel") || row.getAttribute("data-dir") || row.getAttribute("data-uri") || ""; }
	function allRows() { return Array.prototype.slice.call(root.querySelectorAll(".dsh-node")); }
	function clearSelection() {
		allRows().forEach(function (row) { row.classList.remove("selected"); });
		selectedRows = [];
	}
	function selectRowInto(row) {
		var key = rowKeyOf(row);
		if (!key) { return; }
		if (selectedRows.indexOf(key) < 0) { selectedRows.push(key); }
		row.classList.add("selected");
	}
	allRows().forEach(function (row) {
		row.addEventListener("click", function (ev) {
			// ⚠ 只处理**最内层**那一行 ✗：树是嵌套的，否则点一个文件会把它每一层祖先目录都选中 ✓
			//   （实测：菜单/选中都曾被最外层目录行覆盖 ✓）。
			if (ev.target && ev.target.closest && ev.target.closest(".dsh-node") !== row) { return; }
			var key = rowKeyOf(row);
			if (!key) { return; }
			if (ev.ctrlKey || ev.metaKey) {
				// Ctrl/Meta：切换这一行 ✓（真源 :2283-2294 ✓）
				if (selectedRows.indexOf(key) >= 0) {
					selectedRows = selectedRows.filter(function (item) { return item !== key; });
					row.classList.remove("selected");
				} else {
					selectRowInto(row);
				}
			} else if (ev.shiftKey && lastSelectedRel && lastSelectedRel !== key) {
				// Shift：在**全部行**里取「锚点 → 本节」的区间并入 ✓（真源 :2296-2311 ✓，不清空其它 ✓）
				var rows = allRows();
				var from = -1;
				var to = -1;
				for (var index = 0; index < rows.length; index++) {
					var item = rowKeyOf(rows[index]);
					if (item === lastSelectedRel) { from = index; }
					if (item === key) { to = index; }
				}
				if (from >= 0 && to >= 0) {
					var start = Math.min(from, to);
					var end = Math.max(from, to);
					for (var at = start; at <= end; at++) { selectRowInto(rows[at]); }
				}
			} else {
				// 单击：清空后单选 ✓（真源 :2314-2319 ✓）
				clearSelection();
				selectRowInto(row);
			}
			lastSelectedRel = key;
			if (scrollEl && scrollEl.focus) { scrollEl.focus(); }
		});
	});
	// ★★ 拖拽移动（2026-10-14 §16.19）：复刻真源 knowledgeBaseView.ts:2104-2167 的 DOM 层拖拽 ✓。
	//    · 拖源＝行；**多选就带全部选中项**（真源 :2112-2114 ✓）；
	//    · 放置目标＝「笔记」区的**目录行**与**分区体**（真源：文件行不拦截 dragover ⇒ 冒泡到分区体 ✓
	//      —— "拖到分区空白 ⇒ 移到分区根"那条路就是这么来的 ✓）；
	//    · 两处**有意不同**（都摆在这里 ✗）：① **只在「笔记」区**（写围栏 ✓ —— 真源"库 ⇄ 笔记"跨区也放行 ✗）；
	//      ② **撞名不覆盖**（真源弹"是否替换" :4077-4081 ✓，runOrganize 本来就拒覆盖 ⇒
	//      把服务端的**拒因如实说出来** ✓）—— ⚠ 这条只对**移动**成立 ✓，复制的撞名照真源
	//      **自动加 copy** ✓（甲 copy.md ✓）。
	//    · ★ **复制**（2026-10-14 §16.20）：Ctrl/Alt 拖 ⇒ mode:"copy" ✓（上一刀这里写的是
	//      "不做复制、如实说不支持" ✗ ⇒ **那句已作废** ✓，通道与命名规则都补齐了 ✓）。
	//    ⚠⚠ 本段在模板串里 ⇒ 注释里**不许出现反引号** ✗：我这次就是这么踩的（写着"甲 copy.md"
	//      时顺手加了反引号 ⇒ 整段脚本提前闭合 ⇒ 语法错 ✓）—— 第 8 次了 ✓。
	//    ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	function dirOfRel(rel) { var parts = String(rel || "").split("/"); parts.pop(); return parts.join("/"); }
	function baseOfRel(rel) { var parts = String(rel || "").split("/"); return parts[parts.length - 1] || ""; }
	function isNotesRel(rel) { return String(rel || "").indexOf("笔记/") === 0; }
	function readDragPayload(ev) {
		try { return JSON.parse((ev.dataTransfer && ev.dataTransfer.getData("application/x-kb-drag")) || "[]"); } catch (e) { return []; }
	}
	function transferInto(vaultId, fromList, targetDirRel, mode) {
		var copying = mode === "copy";
		var verb = copying ? "复制" : "移动";
		var todo = [];
		for (var i = 0; i < fromList.length; i++) {
			var from = String(fromList[i]);
			if (!isNotesRel(from)) {
				toast("只能在「笔记」区内" + verb + "（「库」是导入/构建产物，本侧不改 ✗）：" + from, false);
				continue;
			}
			// ⚠ "已经在同一个目录"只对**移动**是"没改任何东西" ✗；复制时它是**合法**的
			//   （原地复制 ⇒ 落点自动变 xxx copy.md ✓，真源 :4059-4069 ✓）⇒ 只对 move 拦 ✓。
			if (!copying && dirOfRel(from) === targetDirRel) {
				toast("已经在「" + targetDirRel + "」里了，没动：" + baseOfRel(from), false);
				continue;
			}
			todo.push({ from: from, to: targetDirRel + "/" + baseOfRel(from) });
		}
		if (!todo.length) { return; }
		var done = 0;
		// 复制的"撞名 ⇒ 自动加 copy"要**说给人听** ✓（落点与请求的名字不同时才有这条 ✓）
		var renamed = [];
		var problems = [];
		var step = function (index) {
			if (index >= todo.length) {
				// 逐项如实回报 ✓（成功几项、哪几项为什么没成 ✓ —— 与真源 :4046-4047 的 errors 汇总同口径 ✓）
				if (done) {
					toast("已" + verb + " " + done + " 项"
						+ (renamed.length ? "；撞名已自动改名：" + renamed.join("、") : "")
						+ (problems.length ? "；" + problems.length + " 项没成：" + problems.join("；") : ""), problems.length === 0);
					setTimeout(function () { window.location.reload(); }, 300);
				} else {
					toast("没有" + verb + "任何文件：" + problems.join("；"), false);
				}
				return;
			}
			var item = todo[index];
			window.fetch("/x/kb/api/rename", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ vaultId: vaultId, from: item.from, to: item.to, mode: copying ? "copy" : "move" }),
			}).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
				.then(function (out) {
					if (out.data && out.data.ok === true) {
						done++;
						var landed = out.data.copied && out.data.copied[0] ? String(out.data.copied[0].to || "") : "";
						if (landed && baseOfRel(landed) !== baseOfRel(item.to)) { renamed.push(baseOfRel(landed)); }
					} else { problems.push(baseOfRel(item.from) + "：" + String((out.data && out.data.error) || ("HTTP " + out.status))); }
					step(index + 1);
				})
				.catch(function (e) {
					problems.push(baseOfRel(item.from) + "：请求失败 " + String(e && e.message ? e.message : e));
					step(index + 1);
				});
		};
		step(0);
	}
	// 拖源：行（多选 ⇒ 全部选中项 ✓；库区的源也让拖 —— 放下时给**明确原因** ✓，比"拖不动也不说"好 ✓）
	allRows().forEach(function (row) {
		row.addEventListener("dragstart", function (ev) {
			var key = rowKeyOf(row);
			if (!key) { return; }
			var paths = selectedRows.length > 1 && selectedRows.indexOf(key) >= 0 ? selectedRows.slice() : [key];
			if (ev.dataTransfer) {
				ev.dataTransfer.setData("application/x-kb-drag", JSON.stringify(paths));
				ev.dataTransfer.effectAllowed = "copyMove";
			}
		});
	});
	// 放置目标 ①：笔记区的**目录行**（真源 :2125-2151 ✓）
	Array.prototype.slice.call(root.querySelectorAll(".dsh-section.sec-notes [data-dir-node]")).forEach(function (dirRow) {
		dirRow.addEventListener("dragover", function (ev) {
			ev.preventDefault();
			ev.stopPropagation();   // ⚠ 必须拦下 ✓：否则还会冒泡到分区体 ⇒ 变成"移到分区根" ✗（真源同 ✓）
			dirRow.classList.add("dsh-drop-target");
			// 光标照真源 ✓（Ctrl/Alt ⇒ copy，否则 move ✓ :2133 ✓）—— §16.20 起复制**真做得了** ✓
			//   （上一版这里恒为 move 并附了一句"显示 copy 再拒绝是误导"—— 那句话现在**作废** ✗→✓，如实订正 ✓）。
			if (ev.dataTransfer) { ev.dataTransfer.dropEffect = (ev.ctrlKey || ev.altKey) ? "copy" : "move"; }
		});
		dirRow.addEventListener("dragleave", function () { dirRow.classList.remove("dsh-drop-target"); });
		dirRow.addEventListener("drop", function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			dirRow.classList.remove("dsh-drop-target");
			var paths = readDragPayload(ev);
			if (!paths.length) { return; }
			var targetDirRel = dirRow.getAttribute("data-dir-rel") || "";
			if (!targetDirRel) { return; }
			if (paths.indexOf(targetDirRel) >= 0) { return; }   // 拖到自己身上（真源 :2146 ✓）
			transferInto(dirRow.getAttribute("data-vault") || "", paths, targetDirRel, (ev.ctrlKey || ev.altKey) ? "copy" : "move");
		});
	});
	// 放置目标 ②：笔记区的**分区体**（拖到空白 ⇒ 移到分区根 ✓ 真源 :1744-1763 ✓）
	Array.prototype.slice.call(root.querySelectorAll(".dsh-section.sec-notes .dsh-section-body")).forEach(function (body) {
		body.addEventListener("dragover", function (ev) {
			ev.preventDefault();
			body.classList.add("dsh-drop-target");
			if (ev.dataTransfer) { ev.dataTransfer.dropEffect = (ev.ctrlKey || ev.altKey) ? "copy" : "move"; }
		});
		body.addEventListener("dragleave", function () { body.classList.remove("dsh-drop-target"); });
		body.addEventListener("drop", function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			body.classList.remove("dsh-drop-target");
			var paths = readDragPayload(ev);
			if (!paths.length) { return; }
			var section = body.closest ? body.closest(".dsh-section") : null;
			transferInto(section ? (section.getAttribute("data-vault") || "") : "", paths, "笔记", (ev.ctrlKey || ev.altKey) ? "copy" : "move");
		});
	});
	// ★★ 右键菜单（§15.46；**自定件** ✗：真源走编辑器原生菜单 ✓ ⇒ 结构与项照它、样式我们自定 ✓）
	//    D1 只出现"能立刻做成"的项：重命名（已有路由 ✓）/ 复制路径 / 复制相对路径 ✓；
	//    删除**先不出现** ✗（写路由＋确认链是下一刀 ✓）；D2 做不了的**不出现** ✓（不摆灰的 ✗）。
	var menuEl = root.querySelector("[data-menu]");
	var menuItems = [];
	var activeIndex = -1;
	// ⚠ 开菜单的时刻：用来忽略"点击前那次 scrollIntoView 的**异步回声**" ✗ ——
	//   实测顺序是 contextmenu@1156 → scroll@1165 ⇒ 捕获相位的"滚动即关"会当场把刚开的菜单关掉 ✓。
	var menuOpenedAt = 0;
	function closeMenu() { if (!menuEl) { return; } menuEl.hidden = true; menuEl.textContent = ""; menuItems = []; activeIndex = -1; }
	// ⚠ 这里的 action 参数就是"撤销"入口 ✓（只有它能给我一个可点的动作 ✓）
	function toast(text, ok, action) {
		var host = root.querySelector(".dsh-scroll") || root;
		var old = root.querySelector(".dsh-toast");
		if (old) { old.remove(); }
		var line = document.createElement("p");
		line.className = "dsh-toast" + (ok ? " ok" : "");
		line.textContent = text;
		if (action) {
			var button = document.createElement("button");
			button.type = "button";
			button.className = "dsh-toast-act";
			button.textContent = String(action.label || "撤销");
			button.addEventListener("click", function () { action.run(); });
			line.appendChild(button);
		}
		host.insertBefore(line, host.firstChild);
		setTimeout(function () { if (line.parentNode) { line.remove(); } }, 2600);
	}
	function copyText(text) {
		// 优先 clipboard API ✓（file:// 与 http://127.0.0.1 都算安全上下文 ✓）；
		// 不可用时退回隐藏 textarea ＋ execCommand ✓（老办法，但能如实报告成败 ✓）。
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
		}
		try {
			var area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "readonly");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			var ok = document.execCommand("copy");
			area.remove();
			return Promise.resolve(!!ok);
		} catch (error) { return Promise.resolve(false); }
	}
	/** 撤销（§15.47）：把备份里那一项放回原位 ✓ —— 服务端会再判一次围栏与"备份目录自洽" ✓。 */
	function restore(info) {
		window.fetch("/x/kb/api/restore", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: info.vaultId, backupDir: info.backupDir, rel: info.rel }),
		}).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
			.then(function (out) {
				if (!out.data || out.data.ok !== true) { toast("撤不回：" + String((out.data && out.data.error) || ("HTTP " + out.status)), false); return; }
				toast("已撤销，文件回到原位 ✓", true);
				setTimeout(function () { window.location.reload(); }, 900);
			})
			.catch(function (e) { toast("请求失败：" + String(e && e.message ? e.message : e), false); });
	}
	/**
	 * 把行上的 data-uri 归一成**宿主认的绝对 fs 路径**（正斜杠、盘符大写）。
	 *
	 * ★ 实测（2026-10-14，拿真实 .kbkernel.json 对过）：data-uri 有**两种形态** ✗
	 *   · 在索引里的文件 ⇒ 生产形态（小写盘符 + 百分号编码的 file URI，例：file 三斜杠 c 百分号 3A 斜杠 Users …）；
	 *   · **不在索引里的文件与所有目录** ⇒ uriOf 回落 absOf(node) ⇒ **裸 fs 路径**（Windows 盘符那种）。
	 *     （见 renderPage 里的回退链：uriIndex 查不到就用 absOf ✓。）
	 *   ⇒ 只认前者会把**所有目录行 + 未索引文件**判成"不是本地文件"而拒发 ✗（真 bug，靠对真数据才发现）。
	 *   两种都要吃；非 file 协议、也非绝对路径的（如索引来源里的 http）一律返回空串，调用方**如实拒绝**（不硬凑 ✗）。
	 *
	 * ⚠ 本段活在**模板串**（KB_SCRIPT）里 ⇒ 源码里**反引号与反斜杠都不能写**：
	 *   · 反引号会**提前闭合整个模板串** ✗（第一版注释里把变量名加了反引号，当场被
	 *     「Host 入口必须能被加载」守卫咬住 ✓ —— 这就是那条守卫存在的理由）；
	 *   · 反斜杠会被吃掉一层 ⇒ 页面里成非法正则/错义 ✗（本仓已踩 6 次）。
	 *   ⇒ 反斜杠一律走 String.fromCharCode(92)，且不用带反斜杠的正则 ✓。
	 */
	function uriToFsPath(uri) {
		// ⚠ 用 trim() 而**不是**去空白正则：源码里写反斜杠 s 会被模板串吃掉一层（变成"匹配字母 s" ✗），
		//   而它是**合法转义** ⇒ 模块加载守卫**抓不到**这一类 ✗（只有页面行为会悄悄不对）✓。
		var s = String(uri || "").trim();
		if (!s) { return ""; }
		if (s.indexOf("file:///") === 0) {
			try { s = decodeURIComponent(s.slice(8)); } catch (e) { return ""; }
		} else if (s.indexOf("file:") === 0) {
			// file://host/… 这类宿主形态不认（Windows 上没有意义）⇒ 如实拒 ✓
			return "";
		}
		var parts = s.split(String.fromCharCode(92)).join("/");
		if (parts.charAt(1) === ":") { parts = parts.charAt(0).toUpperCase() + parts.slice(1); }
		var isAbs = parts.charAt(0) === "/" || (parts.charAt(1) === ":" && parts.charAt(2) === "/");
		return isAbs ? parts : "";
	}
	/** 宿主能开文件吗（页面桥 openFile ✓；纯浏览器 / 老宿主 ⇒ 没有 ✓）。判据与 DOC_PREVIEW_SCRIPT 那道闸同形 ✓。 */
	function hostCanOpenFiles() {
		var bridge = window.vssarosDsh;
		return !!(bridge && typeof bridge.openFile === "function");
	}
	/**
	 * 点一行**文件** ⇒ 交给宿主在**编辑器面板**里打开（页面桥 openFile ✓，桥 7 的既有命令 ✓）。
	 *
	 * ★ 2026-10-15（用户要求：点知识库的文件 ⇒ 显示对应的 editorpane ✓）：真源这一步是
	 *   editorService.openEditor（knowledgeBaseView.ts:2650-2652 ✓），.canvas 与图表另走 resolver
	 *   （:2630-2649 ✓）。⚠ 我们**不在这里按扩展名分流** ✗：IDE 侧的 resolver 链已经有 *.canvas
	 *   （agentStudio.contribution.ts:1925-1968 ✓）与 pdf/docx/媒体（kbMediaViewerPane.ts ✓），
	 *   把它抄一份到页面里 ＝ 同一口径两处实现（必然漂移 ✗）。
	 * ⚠ 桥是**单向**的（invoke 只回 true ✓）⇒ 这里不谎报“已打开” ✗；只在“发不出去”时出声 ✓。
	 * ⚠ 工作区之外的路径宿主会**先弹一次确认**（dshHarness.contribution.ts:758-765 的既定安全设计 ✓，
	 *   同页的「思维导图」那条也一样 ✓）—— 我们**不绕过也不隐藏** ✓（资料库默认就在工作区之外 ⇒ 这是常态 ✓）。
	 * ⚠ 路径拿不到（索引来源是 http 之类 ✗）就**如实说** ✓ —— “点了没反应”是最差的一种 ✓。
	 * ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗（上面那些名字都是平写的 ✓）。
	 */
	function openRowInHost(row) {
		var path = uriToFsPath(row.getAttribute("data-uri") || "");
		if (!path) {
			toast("这一行不是本地文件，交给不了编辑器：" + String(row.getAttribute("data-uri") || "（没有路径）"), false);
			return;
		}
		try {
			window.vssarosDsh.openFile(path);
		} catch (e) {
			toast("打开失败：" + String(e && e.message ? e.message : e), false);
		}
	}
	// ★★ 行内动作的两个**共用实现**（2026-10-14 §16.27）—— 右键菜单与 hover 按钮都调它们 ✓
	//   （多一个入口**不许多一份实现** ✗：否则两条路会各自漂移 ✓）。⚠ 本段在模板串里 ⇒ 不许出现反引号 ✗。
	function newInDir(row, kind, dirRelOverride) {
		var dirRel = dirRelOverride || row.getAttribute("data-dir-rel") || "";
		if (!dirRel) {
			// ⚠ 目录行有 data-dir-rel ✓；文件行推得出来（去掉最后一段 ✓）。尾斜杠用**切片**去 ✗ 不用正则
			//   （本段在模板串里，带反斜杠的正则会生成非法正则 ⇒ 整段脚本语法错 ✓ —— 见下面 itemsForRow 的注释 ✓）。
			var rel = row.getAttribute("data-rel") || "";
			if (rel) {
				dirRel = rel.replace(/[^/]+$/, "");
				if (dirRel.charAt(dirRel.length - 1) === "/") { dirRel = dirRel.slice(0, -1); }
			}
		}
		window.fetch("/x/kb/api/new", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: row.getAttribute("data-vault"), dir: dirRel, kind: kind }),
		}).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
			.then(function (out) {
				if (!out.data || out.data.ok !== true) {
					toast("建不了：" + String((out.data && out.data.error) || ("HTTP " + out.status)), false);
					return;
				}
				// ★ 与真源"建完**立刻进入改名**"的同名效果（真源是内联改名 ✓）：把新行的相对路径
				//   交给**重载之后**的页面（sessionStorage ✓），它自动点开那个 ✎ ✓。
				try { window.sessionStorage.setItem("dsh-kb-rename-after-new", out.data.rel || ""); } catch (e) { /* 无 storage 也能用 ✓ */ }
				toast("已新建：" + String(out.data.name || ""), true);
				setTimeout(function () { window.location.reload(); }, 300);
			})
			.catch(function (e) { toast("请求失败：" + String(e && e.message ? e.message : e), false); });
	}
	function deleteRow(row, relOverride) {
		var rel = relOverride || row.getAttribute("data-rel") || "";
		if (!rel) { toast("这一行没有可删的相对路径", false); return; }
		window.fetch("/x/kb/api/delete", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: row.getAttribute("data-vault"), from: rel }),
		}).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
			.then(function (out) {
				if (!out.data || out.data.ok !== true) {
					// 失败**如实显示原因** ✓（不许显示成"删除成功" ✗）
					toast("删不动：" + String((out.data && out.data.error) || ("HTTP " + out.status)), false);
					return;
				}
				var undo = { backupDir: out.data.backupDir, rel: out.data.rel, vaultId: row.getAttribute("data-vault") };
				toast("已移入备份（可撤销）", true, { label: "撤销", run: function () { restore(undo); } });
				// 盘上已经变了 ⇒ 如实反映：把这一行从树里摘掉 ✓（**不重载** ✗ —— 重载会把回执（与回执里的
				// 「撤销」按钮）一起冲掉 ⇒ 撤销永远点不到 ✓（p3-72 ⑱-b 咬出来的真 bug ✓））
				row.remove();
			})
			.catch(function (e) { toast("请求失败：" + String(e && e.message ? e.message : e), false); });
	}
	function itemsForRow(row) {
		var key = rowKeyOf(row);
		var uri = row.getAttribute("data-uri") || "";
		var rel = row.getAttribute("data-rel") || "";
		var items = [];
		// ★ 新建文件 / 新建文件夹（2026-10-14 §16.18）：落在**这一行所在的目录**里（目录行 ⇒ 建进它里面 ✓，
		//   与真源 targetDir 同口径 ✓）。围栏在服务端（**只在「笔记」区** ✓）—— 库里不出现这两项 ✓
		//   （往「库」造素材是导入那条路 ✓，不顺带开这个口子 ✗）。
		//   ⚠ 本段活在**模板串**里 ⇒ 注释里**不许出现反引号** ✗（会提前闭合整个脚本 —— 本仓已踩 7 次 ✓）。
		// ⚠ 这里**不许写带反斜杠的正则** ✗（本段在模板串里 ⇒ 反斜杠会被吃掉一层 ⇒ 生成非法正则 ⇒
		//   整段页内脚本**语法错** ⇒ 折叠/拖拽/改名/菜单全废 ✓ —— 2026-10-14 实测踩到一次 ✓，
		//   而它**只**会被"只解析不运行"那条断言（p3-69 的 ⓪-b）咬住 ✓）。
		//   ⇒ 尾斜杠用**切片**去掉，不用正则 ✓（写法本身也避开了这个坑 ✓）。
		var dirRel = row.getAttribute("data-dir-rel") || "";
		if (!dirRel && rel) {
			dirRel = rel.replace(/[^/]+$/, "");
			if (dirRel.charAt(dirRel.length - 1) === "/") { dirRel = dirRel.slice(0, -1); }
		}
		// ⚠ 只在**「笔记」区**出现这两项 ✗（围栏在服务端 ✓，但 UI 上摆一个"点了必然 400"的项违反本页纪律：
		//   见上面 ✎ 那条注释"不做一个点了会报错的按钮 ✓" —— 往「库」造素材是**导入**那条路 ✓）。
		if (dirRel === "笔记" || dirRel.indexOf("笔记/") === 0) {
			// ⚠ 实现搬到了 newInDir ✓（行内动作与菜单**共用一份** ✓ —— 见那个函数的注释 ✓）
			items.push({ label: "新建笔记", run: function () { newInDir(row, "file", dirRel); } });
			items.push({ label: "新建文件夹", run: function () { newInDir(row, "folder", dirRel); } });
		}
		var renameButton = row.querySelector("[data-rename]");
		if (renameButton) {
			items.push({ label: "重命名", key: "F2", run: function () { renameButton.click(); } });
		}
		// ★ 2026-10-19（用户要求：文档 item 右键菜单补四项之一）：
		//   **在文件资源管理器中显示** —— 走页面桥既有的 reveal 命令（bridge.reveal ✓，不是新命令）。
		//   ⚠ 与 openFile 同口径：只收**绝对路径**（相对路径的基准在页面里不可靠 ✓）⇒
		//     先用 uriToFsPath 把 data-uri 转成 fsPath，转不出来就如实说，不静默 ✗。
		//   ⚠ 本段在模板串里 ⇒ 注释与代码都**不许出现反引号** ✗（本仓已踩 9 次）。
		//   ⚠ 也不许写**带反斜杠的正则** ✗（会被模板串吃掉一层 ⇒ 生成非法正则 ⇒ 整段脚本语法错）。
		if (uri) {
			items.push({ label: "在文件资源管理器中显示", run: function () {
				var bridge = window.vssarosDsh;
				if (!bridge || typeof bridge.reveal !== "function") {
					toast("这个宿主还不支持定位文件（需要较新的页面桥）", false);
					return;
				}
				var fsPath = uriToFsPath(uri);
				if (!fsPath) {
					toast("这条记录不是本地文件路径，定位不了", false);
					return;
				}
				try {
					bridge.reveal(fsPath);
					toast("已在文件资源管理器中定位", true);
				} catch (e) {
					toast("定位失败：" + String(e && e.message ? e.message : e), false);
				}
			} });
			// ★ 2026-10-19：复制的是**原生 fsPath**（G:\... 或 /home/...），不是 data-uri（file:///G:/...）。
			//   理由：这个菜单项的用途是"贴到终端 / 资源管理器 / 另一个程序" ⇒ URI 形态粘过去用不了 ✗；
			//   转不出 fsPath（索引来源不是本地文件）时才退回 uri 原文，并在回执里说清是哪种 ✓。
			items.push({ label: "复制路径", run: function () {
				var fsPath = uriToFsPath(uri);
				copyText(fsPath || uri).then(function (ok) {
					toast(ok ? (fsPath ? "已复制路径" : "已复制（这条记录不是本地路径，复制的是原始 uri）") : "复制失败（浏览器未授权剪贴板）", ok);
				});
			} });
		}
		if (rel) {
			items.push({ label: "复制相对路径", run: function () {
				copyText(rel).then(function (ok) { toast(ok ? "已复制相对路径" : "复制失败（浏览器未授权剪贴板）", ok); });
			} });
		}
		// ★ 发送到聊天（2026-10-14，桥 4 → 5）：把这条笔记作为**引用**投进当前 dsh 聊天草稿。
		//   两条口径写清楚（不然就成了"看着像做了、其实口径不对" ✗）：
		//   ① **只投指针**（聊天框里是 @path 形态），**不附正文** —— 对齐 dsh 上游 dsh-file-reference 的语义
		//      （"选中候选绝不读取或附带文件内容；模型必须调用文件系统工具才能查看文件"）⇒ 模型要内容得自己调 kb_read ✓；
		//   ② **投给哪个聊天框由宿主决定**：插件页拿不到会话身份（创建时 sessionId 传 undefined），
		//      而页面桥是**单向**的（invoke 只回 true）⇒ 这里只能说"已请求"；没有聊天框时**宿主会明确提示** ✓。
		if (uri) {
			items.push({ label: "发送到聊天", run: function () {
				var bridge = window.vssarosDsh;
				if (!bridge || typeof bridge.insertChatReference !== "function") {
					toast("这个宿主还不支持发送到聊天（需要页面桥 5）", false);
					return;
				}
				var fsPath = uriToFsPath(uri);
				if (!fsPath) {
					toast("这条记录不是本地文件路径，发不了", false);
					return;
				}
				bridge.insertChatReference(fsPath);
				toast("已请求发送到聊天草稿", true);
			} });
		}
		// ★ 删除（§15.47）：**只有「笔记」区的行**才给（服务端围栏同一条 ✓ —— 库区不是"做不了"，
		//   而是**不该**由这条不进审计的通道去删 ✓）。两级确认：第一下**只是变成问句** ✓，
		//   2.5 秒不点第二下就复原 ✓（比改名重一档，与"删除比改名重"的语义一致 ✓）。
		if (renameButton) {
			// ⚠ 实现搬到了 deleteRow ✓（行内动作与菜单**共用一份** ✓ —— 见那个函数的注释 ✓）。
			//   ⚠ "不许自动重载"那条教训也随实现搬过去了 ✓（留在 deleteRow 里 ✓，别只留在菜单这条注释里 ✗）。
			items.push({ label: "删除", confirmLabel: "确认删除（可撤销）", run: function () { deleteRow(row, rel); } });
		}
		return items;
	}
	function renderMenu(items) {
		menuEl.textContent = "";
		menuItems = [];
		items.forEach(function (item) {
			var line = document.createElement("div");
			line.className = "dsh-menu-item";
			line.setAttribute("role", "menuitem");
			var label = document.createElement("span");
			label.textContent = item.label;
			line.appendChild(label);
			if (item.key) {
				var hint = document.createElement("span");
				hint.className = "dsh-menu-key";
				hint.textContent = item.key;
				line.appendChild(hint);
			}
			line.addEventListener("click", function () {
				// 两级确认 ✓：带 confirmLabel 的项**第一下只改成问句**，第二下才真执行 ✓
				if (item.confirmLabel && !item.armed) {
					item.armed = true;
					label.textContent = item.confirmLabel;
					setTimeout(function () { item.armed = false; label.textContent = item.label; }, 2500);
					return;
				}
				closeMenu();
				item.run(item);
			});
			menuEl.appendChild(line);
			menuItems.push({ node: line, run: item.run });
		});
		activeIndex = menuItems.length ? 0 : -1;
		markActive();
	}
	function markActive() {
		menuItems.forEach(function (item, index) { item.node.classList.toggle("active", index === activeIndex); });
	}
	function openMenuAt(x, y, items) {
		menuOpenedAt = Date.now();
		renderMenu(items);
		if (!menuItems.length) { return; }
		menuEl.hidden = false;
		menuEl.style.left = "0px";
		menuEl.style.top = "0px";
		var box = menuEl.getBoundingClientRect();
		// D5：靠近右/下边缘**向内翻转** ✓（原生菜单的既有行为 ✓）
		var left = x;
		var top = y;
		if (left + box.width > window.innerWidth - 4) { left = Math.max(4, x - box.width); }
		if (top + box.height > window.innerHeight - 4) { top = Math.max(4, y - box.height); }
		menuEl.style.left = Math.round(left) + "px";
		menuEl.style.top = Math.round(top) + "px";
	}
	Array.prototype.slice.call(root.querySelectorAll(".dsh-node")).forEach(function (row) {
		row.addEventListener("contextmenu", function (ev) {
			// 同点选那条：只让**最内层**那行处理 ✓（否则外层目录会用"它里面有 ✎"把菜单覆盖成只剩重命名 ✓）。
			if (ev.target && ev.target.closest && ev.target.closest(".dsh-node") !== row) { return; }
			var items = itemsForRow(row);
			if (!items.length) { return; }
			ev.preventDefault();
			ev.stopPropagation();
			// 与真源一致：右键**只选中、不打开**（selectNode(..., {suppressOpen:true}) ✓）
			clearSelection();
			selectRowInto(row);
			lastSelectedRel = rowKeyOf(row);
			openMenuAt(ev.clientX, ev.clientY, items);
		});
	});
	// D6 键盘：↑/↓ 移项、Enter 执行、Esc 关闭 ✓
	document.addEventListener("keydown", function (ev) {
		if (!menuEl || menuEl.hidden) { return; }
		if (ev.key === "Escape") { ev.preventDefault(); closeMenu(); return; }
		if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
			ev.preventDefault();
			if (!menuItems.length) { return; }
			activeIndex = (activeIndex + (ev.key === "ArrowDown" ? 1 : menuItems.length - 1)) % menuItems.length;
			markActive();
			return;
		}
		// ⚠ Enter 必须走**同一条点击路径**（node.click ✓）—— 旧实现直接调 run ⇒ 带 confirmLabel 的项
		//   被**跳过两级确认** ✗（右键库 ⇒ 回车 ⇒ 永久删除，零确认；2026-10-15 §16.33 审出来的 ✓）。
		if (ev.key === "Enter" && activeIndex >= 0 && menuItems[activeIndex]) {
			ev.preventDefault();
			menuItems[activeIndex].node.click();
		}
	});
	document.addEventListener("click", function (ev) { if (menuEl && !menuEl.hidden && !menuEl.contains(ev.target)) { closeMenu(); } });
	root.addEventListener("scroll", function () {
		// 回声窗口内不动它 ✓（否则菜单会"开了又立刻消失" ✓）；之后用户真滚动就关 ✓（原生观感 ✓）。
		if (Date.now() - menuOpenedAt < 150) { return; }
		closeMenu();
	}, true);
	// F2 ⇒ 对**最后选中**的那行触发改名（真源 :700-704 ✓）—— 我们复用行尾那个 ✎ 的既有流程 ✓
	//   （真源另有 Delete / Ctrl+X/C/V/Z —— 那些依赖"删除/剪贴板/撤销"能力，本刀不做 ✗，如实记 ✓）。
	if (scrollEl && scrollEl.addEventListener) {
		scrollEl.addEventListener("keydown", function (ev) {
			if (ev.key !== "F2") { return; }
			ev.preventDefault();
			var rows = allRows();
			for (var index = 0; index < rows.length; index++) {
				if (rowKeyOf(rows[index]) !== lastSelectedRel) { continue; }
				var button = rows[index].querySelector("[data-rename]");
				// ⚠ 只有「笔记」区的行才带 ✎（真源同理：库区不可改名 ✓）⇒ 没有按钮就什么都不做 ✓（不静默乱改 ✗）
				if (button) { button.click(); }
				return;
			}
		});
	}
// ⚠ 这里原先放着"新建之后自动进入改名"那段 ✗（2026-10-14 移走 ✓）：它**必须**在
//   所有 ✎ 处理器都挂完之后才能点得动 ✓ —— 详见**脚本最末**那一段的新注释 ✓。
// ★★ 手风琴/solo 只在**可见区**里算（2026-10-15 §16.31；用户第 ② 条"只显示当前选择的库"的必然推论 ✓）——
//   ② 之后，非当前库的块带 hidden ✓ 而它们的节**仍然是 open** ✓（服务端初始全开 ✓）⇒ 若照旧把
//   "全部 vaults"算进去 ⇒ 可见区里**永远凑不出"唯一展开"** ✗ ⇒ .dsh-solo（唯一展开时无视拖拽钉高 ✓）
//   在单库视图下**永远不生效** ✗ —— 真机 ⑦-c 就是这么红的 ✓（"收纳成一个展开 ⇒ solo" 到不了 ✓）。
//   ⇒ 判据换成"它不在任何被隐藏的 vault 块里" ✓（[hidden] 看属性 ✓；"真不可见"由那条全局规则保证 ✓）。
//   ⚠ 本段在模板串里 ⇒ 注释不许出现反引号 ✗。
function visibleVaults() {
	if (!vaults) { return []; }   // 开局的 apply() 早于 vaults 赋值 ⇒ 这里返回空 ✓（下面 updateSolo 会跳过 ✓）
	return vaults.filter(function (block) {
		var group = block.closest ? block.closest('[data-vault-block]') : null;
		return !(group && group.hasAttribute('hidden'));
	});
}
function updateSolo() {
	// ⚠ 开局 apply()（挂全部装订之后、vaults 赋值之前 ✓）也会走到这里 ⇒ **必须早退** ✗，
	//   否则 vaults.filter 抛 TypeError ⇒ **整段脚本死掉** ✓（比"少打一个 solo"严重得多 ✗）。
	if (!vaults) { return; }
	var open = visibleVaults().filter(function (block) { return block.classList.contains('open'); });
	var solo = open.length === 1 ? open[0] : null;
	vaults.forEach(function (block) { block.classList.toggle('dsh-solo', block === solo); });
}
	function setOpen(block, next) {
		if (next) { block.classList.add('open'); } else { block.classList.remove('open'); }
		// 折叠钩子两种都认 ✓（复刻后节头是 [data-section-toggle] ✓，旧的 [data-vault-toggle] 已经不存在 ✓）
		var btn = block.querySelector('[data-section-toggle]') || block.querySelector('[data-vault-toggle]');
		if (btn) { btn.setAttribute('aria-expanded', next ? 'true' : 'false'); }
	}
	// ⚠ 只把「库/笔记」打开 ✓：真源里「标签分类」**默认折叠** ✓（_tagClassOpen 初始 false ✓，
	//   头部只露出标题 ＋ 交集 AND ＋ 计数 ✓）—— 一行 setOpen(block, true) 会把它也撑开 ✗
	//   （第一版就是这么错的：真机上量到 open: true ✓）。sec-tagclass 由 tagClassHtml 渲染成无 open ✓。
	//   ⚠ 本段在模板串里 ⇒ 注释不许出现反引号 ✗。
	vaults.forEach(function (block) { setOpen(block, !block.classList.contains('sec-tagclass')); });
	Array.prototype.slice.call(root.querySelectorAll('[data-vault-toggle]')).forEach(function (btn) {
		btn.addEventListener('click', function () {
			var block = btn.closest('.dsh-vault');
			if (!block) { return; }
			var next = !block.classList.contains('open');
			// 手风琴：展开一个就把**其它**收起（真源 _collapseOthers ✓）
			if (next) { vaults.forEach(function (other) { if (other !== block) { setOpen(other, false); } }); }
			setOpen(block, next);
			updateSolo();
		});
	});
	updateSolo();

	// ★ 分区拖拽调高（真源 knowledgeBaseView.ts:535-568 ✓）：下移 = 上方区域变高 ✓
	//   ⚠ 落库用 localStorage（真源走 IDE 的 storageService ✓ —— 同一个作用：刷新后仍在 ✓；
	//     差别是换浏览器/清缓存即丢 ✓，如实标注 ✗）。
	var HB_KEY = 'vssaros-kb-region-heights';
	function savedHeights() {
		try { return JSON.parse(window.localStorage.getItem(HB_KEY) || '{}') || {}; } catch (e) { return {}; }
	}
	function saveHeight(id, px) {
		if (!id) { return; }
		var all = savedHeights();
		all[id] = px;
		try { window.localStorage.setItem(HB_KEY, JSON.stringify(all)); } catch (e) { /* 隐私模式等：拖拽仍生效，只是不持久 ✓ */ }
	}
	// 恢复：给拖过的段打 data-kb-resized ＋ --kb-region-h（与真源 _appendRegion 的恢复方式一致 ✓）
	var saved = savedHeights();
	vaults.forEach(function (block) {
		var id = block.getAttribute('data-kb-region');
		var h = id ? Number(saved[id]) : 0;
		if (h > 0) {
			block.setAttribute('data-kb-resized', '1');
			block.style.setProperty('--kb-region-h', Math.round(h) + 'px');
		}
	});
	updateSolo();
	(function () {
		var minH = 40; // 照真源：至少留一个标题行，避免被拖成 0 后无法再拖回来 ✓
		Array.prototype.slice.call(root.querySelectorAll('[data-resizer]')).forEach(function (bar) {
			bar.addEventListener('pointerdown', function (ev) {
				var upper = bar.previousElementSibling;
				// ★ 复刻（§15.38）：分隔条现在插在**相邻分区之间**（真源 _appendRegion ✓）⇒ 上邻是
				//   .dsh-section 而不是 .dsh-vault ✓ —— 两种都收 ✓（切结构前后同一段代码都成立 ✓）。
				if (!upper || !(upper.classList.contains('dsh-vault') || upper.classList.contains('dsh-section'))) { return; }
				ev.preventDefault();
				var startY = ev.clientY;
				var startH = upper.getBoundingClientRect().height;
				var current = Math.round(startH);
				function apply(px) {
					current = px;
					upper.setAttribute('data-kb-resized', '1');
					upper.style.setProperty('--kb-region-h', px + 'px');
				}
				apply(current);
				bar.classList.add('dragging');
				try { bar.setPointerCapture(ev.pointerId); } catch (e) { /* 不支持则退化为普通 move 监听 ✓ */ }
				function onMove(e) { apply(Math.max(minH, Math.round(startH + (e.clientY - startY)))); }
				function finish() {
					bar.classList.remove('dragging');
					bar.removeEventListener('pointermove', onMove);
					bar.removeEventListener('pointerup', finish);
					bar.removeEventListener('pointercancel', finish);
					saveHeight(upper.getAttribute('data-kb-region'), current);
				}
				bar.addEventListener('pointermove', onMove);
				bar.addEventListener('pointerup', finish);
				bar.addEventListener('pointercancel', finish);
			});
		});
	})();

	// ★ 内联重命名（§15.33）：Enter 提交 / Esc 取消 / 行内校验 ＋ 失败**显示原因** ✓
	//   ⚠ 客户端校验只是**早说**（照真源 _validateRename :2610-2611 的两条 ✓）；
	//     真正的权威在服务端：围栏（只认「笔记」区）＋ 不覆盖 ＋ vault 锁 ✓。
	function validateName(name) {
		if (!name) { return '名称不能为空'; }
		if (/[. ]$/.test(name)) { return '名称不能以「.」或空格结尾'; }
		if (name.length > 255) { return '名称过长'; }
		return null;
	}
	function pathDir(rel) {
		var at = String(rel).lastIndexOf('/');
		return at < 0 ? '' : String(rel).slice(0, at + 1);
	}
	function showMsg(row, text, ok) {
		var msg = row.querySelector('.dsh-rename-msg');
		if (!text) { if (msg) { msg.remove(); } return; }
		if (!msg) { msg = document.createElement('span'); msg.className = 'dsh-rename-msg'; row.appendChild(msg); }
		msg.textContent = text;
		if (ok) { msg.classList.add('ok'); } else { msg.classList.remove('ok'); }
	}
	Array.prototype.slice.call(root.querySelectorAll('[data-rename]')).forEach(function (button) {
		button.addEventListener('click', function (ev) {
			ev.preventDefault();
			ev.stopPropagation();
			var row = button.closest('[data-doc-row]');
			if (!row || row.querySelector('.dsh-rename-input')) { return; }
			var rel = button.getAttribute('data-rename-path') || '';
			var dir = pathDir(rel);
			var nameEl = row.querySelector('.t');
			var input = document.createElement('input');
			input.className = 'dsh-rename-input';
			input.value = rel.slice(dir.length);
			input.setAttribute('aria-label', '新文件名');
			if (nameEl) { nameEl.replaceWith(input); } else { row.insertBefore(input, row.firstChild); }
			input.focus();
			var dot = input.value.lastIndexOf('.');
			if (dot > 0) { input.setSelectionRange(0, dot); } else { input.select(); }
			var done = false;
			function restore() {
				var span = document.createElement('span');
				span.className = 't';
				span.textContent = (nameEl ? nameEl.textContent : '') || '';
				input.replaceWith(span);
			}
			function cancel() { if (done) { return; } done = true; showMsg(row, null); restore(); }
			input.addEventListener('keydown', function (event) {
				if (event.key === 'Escape') { event.preventDefault(); cancel(); }
				if (event.key !== 'Enter') { return; }
				event.preventDefault();
				var name = String(input.value || '').trim();
				var bad = validateName(name);
				if (bad) { showMsg(row, bad, false); return; }
				var target = dir + name;
				if (target === rel) { cancel(); return; }
				done = true;
				showMsg(row, '提交中…', true);
				window.fetch('/x/kb/api/rename', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ vaultId: row.getAttribute('data-vault'), from: rel, to: target }),
				}).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
					.then(function (out) {
						if (!out.data || out.data.ok !== true) {
							// 失败：**如实显示原因**（"目标已存在 ⇒ 不覆盖"最常见 ✓），输入框留着让人改 ✓
							done = false;
							showMsg(row, '改不动：' + String((out.data && out.data.error) || ('HTTP ' + out.status)), false);
							return;
						}
						var span = document.createElement('span');
						span.className = 't';
						span.textContent = target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
						input.replaceWith(span);
						button.setAttribute('data-rename-path', target);
						// ⚠ 行上的 rel / uri 也必须跟着改 ✗：只改按钮上的那个，会让"再预览 / 再改名"
						//   仍按**旧路径**去请求 ✓（改一半 = 埋一个只在第二次操作时才出现的坑 ✓）。
						row.setAttribute('data-rel', target);
						var oldUri = row.getAttribute('data-uri') || '';
						if (oldUri) {
							// ⚠ 这里**不许写正则** ✗：本段是**模板串里的字符串**，正则里的反斜杠会被提前吃一层
							//   （我第一版写 /[^/\\]*$/ ⇒ 页面里成了 /[^/\]*$/ ⇒ **整段脚本语法错** ✓，
							//    症状：真 Host 里 ⑥/⑦/⑧ 全红，而"页面脚本没跑"这一点要到 ⑧ 的诊断里才看得见 ✗）。
							//   ⇒ 用字符构造出反斜杠（0x5C ✓），并把"切掉文件名"写成 lastIndexOf 运算 ✓：
							//     既避开转义，也不用正则 ✓。
							var sep = String.fromCharCode(92);
							var cut = Math.max(oldUri.lastIndexOf('/'), oldUri.lastIndexOf(sep));
							if (cut >= 0) {
								row.setAttribute('data-uri', oldUri.slice(0, cut + 1) + target.slice(target.lastIndexOf('/') + 1));
							}
						}
						showMsg(row, '已重命名 ✓', true);
					})
					.catch(function (e) { done = false; showMsg(row, '请求失败：' + String(e && e.message ? e.message : e), false); });
			});
			input.addEventListener('blur', function () { if (!done) { cancel(); } });
		});
	});
	// ★★ 「标签分类」分区（2026-10-14 §16.23，照真源 knowledgeBaseView.ts:1196-1259 ✓）——————
	//   · 搜索是**标签名子串包含** ✓（真源 :1199 ✓ —— 不是前缀、不分词 ✓）；
	//   · 空态**分两种** ✓（真源 :1205 ✓）：一条标签都没有 ⇒ 教怎么写标签；有标签但没搜到 ⇒ 只说"无匹配标签" ✓
	//     （两种都写"暂无标签"会误导 ✓）；
	//   · 分组**初始折叠** ✓（真源 CSS 里 .kb-tag-group-body 默认 display:none ✓），点组头展开 ✓；
	//   · 计数徽标：无搜索词时显示总数 ✓、有搜索词时显示命中数 ✓。
	//   ⚠ 本段在模板串里 ⇒ 注释里不许出现反引号 ✗。
	(function () {
		var tagSection = root.querySelector(".dsh-section.sec-tagclass");
		if (!tagSection) { return; }
		var groupsEl = tagSection.querySelector("[data-tag-groups]");
		var tagInput = tagSection.querySelector("[data-tag-input]");
		var clearBtn = tagSection.querySelector("[data-tag-clear]");
		var emptyEl = tagSection.querySelector("[data-tag-empty]");
		var countBadge = tagSection.querySelector("[data-tag-count]");
		var total = groupsEl ? Number(groupsEl.getAttribute("data-tag-total") || "0") : 0;
		function renderTags() {
			if (!groupsEl) { return; }
			var q = tagInput ? String(tagInput.value || "").trim().toLowerCase() : "";
			var shown = 0;
			Array.prototype.slice.call(groupsEl.querySelectorAll(".dsh-tag-group")).forEach(function (group) {
				var hit = !q || String(group.getAttribute("data-tag-name") || "").indexOf(q) >= 0;
				group.hidden = !hit;
				if (hit) { shown += 1; }
			});
			if (emptyEl) {
				emptyEl.hidden = shown !== 0;
				emptyEl.textContent = (!q && total === 0) ? "暂无标签（在笔记中使用 #标签# 格式即可创建标签）" : "无匹配标签";
			}
			if (countBadge) { countBadge.textContent = String(q ? shown : total); }
		}
		function syncClear() { if (clearBtn) { clearBtn.hidden = !(tagInput && tagInput.value); } }
		if (tagInput) {
			tagInput.addEventListener("input", function () { syncClear(); renderTags(); });
			tagInput.addEventListener("keydown", function (ev) {
				if (ev.key !== "Escape") { return; }
				ev.preventDefault();
				tagInput.value = "";
				syncClear();
				renderTags();
			});
		}
		if (clearBtn) {
			clearBtn.addEventListener("click", function () {
				if (tagInput) { tagInput.value = ""; tagInput.focus(); }
				syncClear();
				renderTags();
			});
		}
		Array.prototype.slice.call(tagSection.querySelectorAll("[data-tag-toggle]")).forEach(function (head) {
			head.addEventListener("click", function () {
				var group = head.closest(".dsh-tag-group");
				if (!group) { return; }
				var open = !group.classList.contains("open");
				group.classList.toggle("open", open);
				head.setAttribute("aria-expanded", open ? "true" : "false");
			});
		});
		syncClear();
		renderTags();
	})();
	// ★★ 新建之后的"自动进入改名"（2026-10-14 §16.18）—— **必须放在脚本最末** ✗✗：
	//   真源是建完**直接 startRename** ✓；我们重载页面（树是服务端渲染的 ✓）⇒ 用 sessionStorage 把
	//   新行的相对路径带过来，在这里**点开它的 ✎** ⇒ 用户看到的是"新文件已经在改名输入框里" ✓。
	//   ⚠ 为什么非得在最末 ✗（2026-10-14 现场教训）：这一段原先是**写在 ✎ 处理器挂载之前**的 ✓ ⇒
	//     newBtn.click() 点在一个**还没挂监听**的按钮上 = 空点 ✓ ⇒ 表面上"什么都没发生" ✗，
	//     而且**页面零脚本错误**（不是抛错，是没接上 ✓）—— 靠读代码看不出来 ✓。
	//   谁咬出来的 ✓：真机探针 p3-73 ⑪（生产式外壳里真右键新建 ✓）。而当时唯一的守卫 p3-86 ⑨
	//     只断言"页面里有这个交接键" ✗ ⇒ **绿得假** ✓ ⇒ ⑨ 已补一条"**顺序**断言"（交接段必须在
	//     ✎ 挂载之后 ✓），与真机那条配成对 ✓。
	try {
		var pendingNew = window.sessionStorage.getItem("dsh-kb-rename-after-new");
		if (pendingNew) {
			window.sessionStorage.removeItem("dsh-kb-rename-after-new");
			var newRow = null;
			var candidates = allRows();
			for (var ci = 0; ci < candidates.length; ci++) {
				if (candidates[ci].getAttribute("data-rel") === pendingNew) { newRow = candidates[ci]; break; }
			}
			var newBtn = newRow && newRow.querySelector("[data-rename]");
			if (newBtn) { newBtn.click(); }
		}
	} catch (e) { /* 没 storage / 没那行 ⇒ 什么都不做（新建**已经成功了** ✓，只是没自动进改名 ✓） */ }
})();
`;

/**
 * 服务端渲染的只读知识库页 —— 外壳照 VsSaros 原容器 Pane 的规范（标题 / 工具条 / 分区 / 空态 /
 * 诊断行，样式在 `pageShell.js`）：原来是一张"平铺长页 + 16 行内联 CSS"，现在标题与诊断进头部、
 * 搜索框与 vault 下拉进**工具条**、「库」自成**分区**（分区名与原 `KnowledgeBaseViewPane` 的口径
 * 一致 ✓），列表侧再加**页内筛选**（vault ∩ 关键字，同看板页做法 ✓）。
 *
 * 机器可断言的锚点：`body[data-vssaros-page=kb]` 与 `data-vssaros-kb-*`
 * （vaults / docs / root / tools）—— ★ 2026-10-12 摘内嵌记忆区块时去掉的是
 * `data-vssaros-kb-memory-section`（它**被 `p3-08` 断言过** ⇒ 那条已同步改成**负断言**；
 * 端到端那半边由 `p3-07` 的整页断言接管）。
 *
 * 排序维度照原 Pane 的 `KB_SORT_GROUPS` 口径（文件名 / 创建时间 / 编辑时间 ✓），落到索引字段：标题 /
 * `created` / `mtime` —— **已确证** `core/kb.js` 的 `normalizeDoc` 保留这三者（README 5.44 记的
 * "created 是否透传未确证"就此结清 ✓）。
 *
 * 排序至此**凡索引条目能支撑的维度都齐**（索引顺序 / 标题 / 标题自然 / 创建时间 / 编辑时间 = 9 项 ✓，
 * 对应原 `KB_SORT_GROUPS` 的「文件名 / 创建时间 / 编辑时间」三组 ✓ —— 那边第 4 组是给文件树用的，
 * 索引里没有对应键）。
 *
 * ⚠ 与原 Pane 相比**仍缺**（如实记，见 README 5.46）：文件树的操作（重命名 / 右键菜单 / 双链 / 标签 ——
 * 要写路径或 IDE 侧的就地编辑能力）。
 */
/**
 * 解析 IDE **注入**的库记录（`config.kbVaults` —— JSON 字符串，见 `dshHarnessService` 的 `_kbVaultsSlim` ✓）。
 *
 * 为什么是"注入"而不是从盘上推 ✗：库的**名字与图标只存在 IDE storage 里**（`agentStudio.kb.vaults` ✓），
 * 盘上任何地方都没有 —— 真机核过：库目录里只有索引缓存（`.kbkernel.json` / `.ftindex.json` ✓）✗。
 *
 * ⚠ 容错口径（重要 ✓）：坏输入 / 空 / 不是数组 / 一条都没有 ⇒ **`undefined`** ⇒ 调用方**退回旧行为**
 * （uid 目录名当库名 ✓）并**如实标注** ✗ —— 绝不抛、也绝不编造名字 ✓。
 */
function parseInjectedVaults(raw) {
	if (typeof raw !== 'string' || !raw.trim()) { return undefined; }
	// ★★ 2026-10-20 真机（用户报「kb_list 少了外挂库」）：**YAML 单引号不处理转义**。
	//   `roots-*.yml` 里写的是 `kbVaults: '[{\"id\":\"...\"}]'` —— 那些 `\"` 是**字面反斜杠**
	//   ⇒ 插件拿到的字符串带 `\` ⇒ `JSON.parse` 直接抛 ⇒ 本函数返回 undefined
	//   ⇒ `externalVaultRecords` 为空 ⇒ `listVaults` 不过滤 ⇒ **只剩数据根下扫到的历史库**
	//   （实测：kb_list 只返回 20260709063858-azbh1at 等 3 个，注入的 e:/VsSarosVault 消失 ✗）
	//   ⇒ 连带 `kb_read` 的相对路径 `picked` 永远 miss ⇒ 回落到数据根 ⇒ ENOENT ✔ 同一条根因。
	//   修法：**逐个候选**尝试解析——先原样，再反转义 `\"`（不猜、不静默：都有解析不出就返回 undefined）。
	const candidates = [raw, raw.replace(/\\"/g, '"'), raw.replace(/\\\\/g, '\\')];
	for (const candidate of candidates) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) { continue; }
		const out = parsed
			.filter(item => item && typeof item.id === 'string' && item.id.trim())
			.map(item => ({
				id: String(item.id),
				name: typeof item.name === 'string' && item.name.trim() ? item.name : String(item.id),
				icon: typeof item.icon === 'string' && item.icon ? escapeHtml(item.icon) : codicon('book'),
				// path 也可能是「反转义后才能用」的形态 ⇒ 统一把 `\\` 收成 `\`（Windows 盘符路径）
				path: typeof item.path === 'string' ? item.path.replace(/\\\\/g, '\\') : '',
				closed: item.closed === true,
			}));
		if (out.length) { return out; }
	}
	return undefined;
}

async function renderPage({ config, state, surface = 'full' }) {
	const root = kbRootOf(config);
	// 快照缓存（报告 §5-4）：同一个根、且各 vault 目录与 kernel 都没变时，直接复用上一次扫描 ✓
	// （见 `store.js` 的 `pageSnapshotOf`：键 = 根形状 + vault 目录 mtime + kernel 的 size/mtime ✓）。
	// 命中与否**上页面**（`data-vssaros-kb-scan="cached|fresh"` ✓）—— 探针据此断言"第二次渲染真的没重扫" ✓，
	// 否则这条优化就只是"写完了就相信它" ✗。
	const snapshot = await pageSnapshotOf(root, { external: externalVaultRecords(config) });
	const { vaults, missing, docCounts } = snapshot;
	const totalDocs = vaults.reduce((sum, vault) => sum + vault.totalDocs, 0);
	/** 本页**实际渲染**的文档行数（每库切到 PAGE_DOC_LIMIT）—— 计数头要如实，不能用全库索引数。 */
	const renderedDocs = vaults.reduce((sum, vault) => sum + Math.min(vault.docs?.length ?? 0, PAGE_DOC_LIMIT), 0);
	// ⚠⚠ 2026-10-13（§15.38 复刻）**回退说明**：分区改成「库」/「笔记」两节 ＋ 真文件树的那一版
	//   我**做了一半就退回来了** ✗ —— 原因是**页面会停在"结构换了、样式与交互没跟上"的中间态** ✗：
	//   新类（`.dsh-node` / `.dsh-section` 等）还没有 CSS ✗、节级交互（手风琴 / solo / 拖拽锚点）
	//   还指着旧的 `.dsh-vault` ✗ ⇒ `p3-08` 会从 140/140 掉到 133/140 ✓。
	//   ⇒ 纪律：**这一次只落"加法"那部分**（`store.listVaultTree` ＋ `p3-75` ✓，独立可测且不影响页面 ✓），
	//     ②③（节结构 ＋ 树渲染 ＋ 样式 ＋ 交互 ＋ 探针）**下一次一次性做完** ✓ —— 不留半成品 ✓。
	// ★ 复刻（§15.38，2026-10-13 **已接线** ✓）：分区从"一个包住所有 vault 的大分区"换成
	//   **「库」/「笔记」两节**（真源 `.kb-section` ＋ `.sec-library`/`.sec-notes` ✓），树走**真文件树**
	//   （`store.listVaultTree` ✓ —— 目录、非 md、点文件都在 ✓，不再只列索引条目 ✗），
	//   分隔条插在**相邻分区之间**（真源 `_appendRegion` 就是按区域插 ✓）。
	//   ⚠ 每个 vault 各给一组分区（外层带 `data-vault-block` ✓）⇒ 顶部那个下拉仍按它过滤 ✓，
	//     于是"JS 不在时全量可见"这条渐进增强性质保持不变 ✓
	//     （真源是**切换即重取** ✗，静态页做不到 ⇒ 这条差异如实记在文档里 ✓）。
	// ⚠⚠ 两边形态必须**归一后**才能对上 ✗（2026-10-13 踩到，是**真 bug** ✓）：索引里的 `uri` 是
	//   `file:///…` 形态，而树里拼出来的是普通绝对路径 ⇒ 直接比就**一条也对不上** ⇒
	//   表现是"标签全空、顺序全 9999、点预览读不到正文" ✗（p3-08 当场抓到 ✓）。
	//   ⇒ 统一成"去 `file://` 前缀 ＋ 正斜杠 ＋ 小写"再比 ✓。
	const normUri = value => String(value ?? '').replace(/^file:\/*/i, '').replace(/\\/g, '/').toLowerCase();
	const sectionBlocksOf = async vault => {
		const pendingSet = snapshot.pending?.get(vault.id) ?? new Set();
		const orderIndex = new Map();
		const tagsIndex = new Map();
		const createdIndex = new Map();
		const uriIndex = new Map();
		(vault.docs ?? []).forEach((doc, index) => {
			const key = normUri(doc.uri);
			if (!key) { return; }
			orderIndex.set(key, String(index).padStart(4, '0'));
			// 标签 / 创建时间只有**索引**里有 ✓（树是文件系统的 ⇒ 必须在 uri 上对上才带得出来 ✓）
			tagsIndex.set(key, Array.isArray(doc.tags) ? doc.tags : []);
			createdIndex.set(key, String(doc.created ?? ''));
			// `data-uri` 用**索引里的原样形态**（`file:///…` ✓）—— 页面点预览要把它交给
			// `/x/kb/api/doc?uri=`，那条路由吃的就是这个形态 ✓（给普通路径也能解析，但不赌 ✓）。
			uriIndex.set(key, String(doc.uri));
		});
		const blocks = [];
		for (const section of [LIBRARY_DIR, NOTES_DIR]) {
			const tree = await listVaultTree(vault.dir, { section });
			const absOf = node => join(vault.dir, section, ...String(node.rel).split('/'));
			const keyOf = node => normUri(absOf(node));
			blocks.push(sectionHtml({
				section,
				vaultId: vault.id,
				count: tree.truncated ? `${tree.files}+` : tree.files,
				body: treeHtml(tree.nodes, {
					vaultId: vault.id,
					section,
					pendingSet,
					uriOf: node => uriIndex.get(keyOf(node)) ?? absOf(node),
					orderOf: node => orderIndex.get(keyOf(node)) ?? '9999',
					tagsOf: node => tagsIndex.get(keyOf(node)) ?? [],
					createdOf: node => createdIndex.get(keyOf(node)) ?? '',
				}),
				missing: !!tree.missing,
				// ⚠ 只有「笔记」区挂工具栏 ✗（真源两份都有 ✓，理由见 notesToolbarHtml 的注释 ✓）
				toolbar: section === NOTES_DIR ? notesToolbarHtml() : '',
			}));
		}
		// ★ 第三个分区「标签分类」（2026-10-14 §16.23，照真源 :1148-1287 ✓）：
		//   数据只能来自**索引条目**（树是文件系统的、没有标签 ✓）；排序口径照真源 :1200 ✓
		//   （条数倒序 ⇒ 同条数按中文 localeCompare ✓）；「#无标签」兜底组照真源 getUntaggedDocs ✓。
		{
			const tagMap = new Map();
			const untagged = [];
			for (const doc of vault.docs ?? []) {
				const names = (Array.isArray(doc.tags) ? doc.tags : []).filter(Boolean).map(String);
				const label = String(doc.name ?? doc.title ?? doc.uri ?? '');
				if (!names.length) { untagged.push(label); continue; }
				for (const tag of names) {
					const entry = tagMap.get(tag) ?? { count: 0, names: [] };
					entry.count += 1;
					entry.names.push(label);
					tagMap.set(tag, entry);
				}
			}
			const tagList = [...tagMap.entries()]
				.map(([tag, entry]) => ({ tag, count: entry.count, names: entry.names }))
				.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
			blocks.push(tagClassHtml({ vaultId: vault.id, tags: tagList, untagged }));
		}
		return blocks.join('<div class="dsh-resizer" data-resizer title="拖拽调整高度"></div>');
	};
	// ★★ 库的**显示名 / 图标**（2026-10-15，用户报"知识库目录可以选择，但不应该有 uid 式的根"）——
	//   优先用 IDE **注入**的库记录（`config.kbVaults` ✓，见 `parseInjectedVaults` 的注释 ✓）。
	//   ⚠ 拿不到注入（老 Host / 独立启动器 / 字段缺失）⇒ **退回 uid 目录名** ✓ 并在页面上**如实标注** ✗
	//     （`data-vssaros-kb-vaults-injected="no"` ✓：用户与探针都看得出"那不是库名、是目录名" ✓）。
	//   ⚠⚠ 位置**必须在 `vaultBlocks` 之前** ✗（2026-10-15 踩到，当场 500 ✓）：它们原在下面几行，
	//     而下面那个分区头模板要 `vaultIcon` / `vaultDisplayName` ⇒ `const` 箭头函数的 **TDZ** ✗
	//     ⇒ render 抛 `Cannot access … before initialization` ⇒ **整页 500** ✓（p3-73 ⓪ 当场咬住 ✓）。
	//     教训：把"给模板用的取值函数"放在**它被用到的模板之前** ✓（靠读代码顺序，不靠运气 ✓）。
	const injectedVaults = parseInjectedVaults(config?.kbVaults);
	const vaultMetaOf = id => (injectedVaults ?? []).find(item => item.id === id);
	/** 显示名：注入里有就用它 ✓，否则**退回 uid** ✓（不编造 ✓）。 */
	const vaultDisplayName = id => (vaultMetaOf(id)?.name) || id;
	// ⚠ 返回的是**已转义的 HTML 片段**（不是纯文本）⇒ 调用处**不要再 escapeHtml** ✗（会把 span 打成一串实体 ✗）。
//   注入的自定义图标（IDE 侧给的，纯文本 emoji 一类 ✓）照旧转义；没给 ⇒ 用 codicon 的库图标 ✓。
const vaultIcon = id => {
	const raw = vaultMetaOf(id)?.icon;
	return typeof raw === 'string' && raw ? escapeHtml(raw) : codicon('book');
};
	const vaultBlocks = (await Promise.all(vaults.map(async (vault, index) => `<div class="dsh-vault-group" data-vault-block data-kb-region="${escapeHtml(vault.id)}" data-vault-id="${escapeHtml(vault.id)}" data-vault="${escapeHtml(vault.id)}">
${vaults.length > 1 ? `<p class="dsh-vault-group-label" title="${escapeHtml(vault.id)}">${escapeHtml(vaultIcon(vault.id))} ${escapeHtml(vaultDisplayName(vault.id))} · ${docCounts.get(vault.id) ?? 0} 个文件${vault.kernelBytes ? ` · kernel ${vault.kernelBytes}B` : ' · 无 kernel'}</p>` : ''}
${vault.notes?.length ? `<p class="dsh-diag">${escapeHtml(vault.notes.join('；'))}</p>` : ''}
${await sectionBlocksOf(vault)}
</div>`))).join('');
	const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
	// ★ 2026-10-12：`data-vssaros-kb-memory-section` 已摘（不再内嵌记忆分区，见文件头注释）。
	// ★★ 2026-10-15（用户：「顶部不应该有这些信息：根目录：… · 工具：… · 扫描：…」✓）——
	//   **加 `hidden` 而不是删掉** ✗，理由两条：
	//     ① 那一行是**诊断事实**（根目录 / 注册到的工具 / 本次扫描是复用还是重扫 ✓），
	//        探针里有一批在**读它的属性**（`data-vssaros-kb-scan` / `-tools` / `-vaults` / `-pending` ✓
	//        p3-08 / p3-69 / p3-72 / p3-73 都在用 ✓）⇒ 删掉就等于把这些守卫一起废掉 ✗；
	//     ② `hidden` 是纯 HTML 能力 ✓（不靠样式 ✓）⇒ 用户可以看不见 ✓，机器照样读得到 ✓。
	//   ⚠ 与真源对照：真源那一栏**没有**这行 ✓（是我们自加的诊断 ✓）⇒ 这次是**朝真源靠** ✓。
	// ★★ 库的**显示名 / 图标**（2026-10-15，用户报"知识库目录可以选择，但不应该有 uid 式的根"）——
	//   优先用 IDE **注入**的库记录（`config.kbVaults` ✓，见 `parseInjectedVaults` 的注释 ✓）。
	//   ⚠ 拿不到注入（老 Host / 独立启动器 / 字段缺失）⇒ **退回 uid 目录名** ✓ 并在页面上**如实标注** ✗
	//     （`data-vssaros-kb-vaults-injected="no"` ✓：用户与探针都看得出"那不是库名、是目录名" ✓）。
	// ⚠ `injectedVaults` / `vaultMetaOf` / `vaultDisplayName` / `vaultIcon` **已上移到 `vaultBlocks`
	//   之前** ✗（否则 TDZ ⇒ 500 ✓，见那段注释 ✓）。
	const activeVaultId = typeof config?.kbActiveVaultId === 'string' ? config.kbActiveVaultId.trim() : '';
	const activeDisplay = activeVaultId ? vaultDisplayName(activeVaultId) : '';
	// ⚠ 当前库的内容**可能不在本侧的库根下** ✗：真源的 vault 可以走 `customPath`（内容在用户自己的目录 ✓，
	//   现场就是 `我的知识库 → e:\VsSarosVault` ✓）⇒ 那时本侧扫不到它 ✓ ⇒ **必须明说**，不能让用户
	//   对着一屏别的库猜"我的库去哪了" ✗（这正是"差异巨大"最容易误判成 bug 的一档 ✓）。
	const activeVaultScanned = activeVaultId ? vaults.some(vault => vault.id === activeVaultId) : false;
	const activeMeta = vaultMetaOf(activeVaultId);
	const activeElsewhere = activeVaultId && !activeVaultScanned && activeMeta?.path;
	const diag = `<p class="dsh-diag" hidden data-vssaros-kb-vaults="${vaults.length}" data-vssaros-kb-docs="${totalDocs}" data-vssaros-kb-root="${escapeHtml(root)}" data-vssaros-kb-tools="${escapeHtml(toolsRegistered)}" data-vssaros-kb-scan="${snapshot.cached ? 'cached' : 'fresh'}" data-vssaros-kb-pending="${snapshot.pending ? [...snapshot.pending.values()].reduce((sum, set) => sum + set.size, 0) : 0}" data-vssaros-kb-vaults-injected="${injectedVaults ? 'yes' : 'no'}" data-vssaros-kb-active-vault="${escapeHtml(activeVaultId)}"${snapshot.pendingNote ? ` data-vssaros-kb-pending-note="${escapeHtml(snapshot.pendingNote).slice(0, 200)}"` : ''}>根目录：<code>${escapeHtml(root)}</code> · 工具：<code>${escapeHtml(toolsRegistered)}</code> · 扫描：${snapshot.cached ? '复用上次' : '本次重扫'}</p>`;
	const notices = `${missing ? `<p class="dsh-empty">知识库根目录还不存在：<code>${escapeHtml(missing)}</code></p>` : ''}${activeElsewhere ? `<p class="dsh-empty">当前库「${escapeHtml(activeDisplay)}」的内容在<code>${escapeHtml(activeMeta.path)}</code>（自定义目录），**不在本侧的库根下** ⇒ 本侧看不到它的内容（要在这里看，请在 IDE 的知识库设置里把存储根指过去）。</p>` : ''}`;
	// ★★ 库选择器（2026-10-14 §16.25）—— 逐项照真源 `renderVaultBar` `:1321-1373` ＋ `renderVaultMenu` `:1375-1419` ✓：
	//   · **独立成行**（在标题之下、搜索行之上 ✓ —— 外壳没有单独的 vault-bar 槽位 ✗ ⇒ 挨着标题放 ✓，
	//     视觉顺序与真源一致 ✓）；
	//   · **自定下拉菜单**（真源是 div ＋ 绝对定位菜单 ✓，不是 select ✗）：分组标题「当前知识库」＋
	//     每库一项（勾选 ＋ 图标 ＋ 名字 ＋ **右侧小字** ✓ —— 真源放 v.path 绝对路径 ✓，我们放
	//     「N 条索引」✓：把**机器路径**印在侧栏里对读者没用 ✓，换成这一栏真正有用的数 ✓）；
	//   · 同排两个按钮：**文件树 ⇄ 最近编辑**（真源 `:1339-1350` ✓）与**刷新**（`:1357-1359` ✓）。
	//   ⚠ 三处**有意不同**（都摆在这里 ✗）：
	//     ① 真源还有「关系图谱」（`:1362-1364` ✓，在**中间栏**打开 ✗）—— **2026-10-15 改了** ✓：
	//        用户报"缺设置按钮 / 缺关系图谱按钮"，而我们这时有了页面桥 7 的两条命令
	//        （`openKbSettings` / `openKbGraph` ✓）⇒ 现在**摆** ✓（点了请宿主在编辑区打开 IDE
	//        自己的那两个面板 ✓）；⚠ **旧宿主（桥 < 7）点了会如实提示"这个宿主还不支持"** ✗
	//        —— 提示而不是静默、也不是假装打开了 ✓。
	//     ② 菜单底部「配置文件夹为知识库…」（`:1391-1396` ✓，要系统文件夹选择器 ✗）⇒ 同样**不摆** ✓；
	//     ③ 真源的「已关闭」分组（`:1384-1389` ✓，来自它自己的 vault 生命周期 ✗）⇒ 我们没有这个概念 ✓。
	//   · 另有一处**适配** ✓：真源的库选择器是**单库**语义（显示 `_activeVault` ✓），我们多库并列 ⇒
	//     默认「全部库（不筛选）」＋ 菜单里也给这一项 ✓（多库形态的必要补充 ✓）。
	// ⚠ 名字/图标**改由注入提供**（2026-10-15 ✓）：注入里没有的库（本侧扫到、IDE 记录里没有 ✗）
	//   ⇒ 名字**退回 uid** 并如实标出来 ✓ —— 不编造、"我的知识库"这种名字也不会凭空出现 ✓。
	//   ⚠ 自定义内容路径（`meta.path`）放 `title`（悬停可见 ✓）而不是右侧那 120px 的小字 ✗。
	// ★★ 默认只显示**当前库**（2026-10-15 用户第 ② 条："仅应该显示当前选择的库，不应有全部库"）——
	//   当前库 = IDE 注入的 `kbActiveVaultId`（**被本侧扫到**才用它 ✓）；拿不到注入 / 扫不到它
	//   （customPath 那种 ✓ 内容不在本根下 ✓）⇒ 退回**第一个** ✓ 并如实标记
	//   （`data-vssaros-kb-vaults-injected` ＋ 上面那条"内容在别处"的明说 ✓）。
	//   ⚠ 「全部库」这一项**去掉** ✓ —— 但**菜单保留** ✓（真源的下拉本来就能选库 ✓）：菜单里点某个库
	//     只是**本页切换显示** ✓（前端筛选 ✓），**不改 IDE 的当前库** ✗（页面桥明文不许写能力 ✓）
	//     ⇒ 这一点写进选择器的 `title` ✓（免得"选了却哪都没变"变成错觉 ✓）。
	const scannedIds = vaults.map(vault => vault.id);
	// ⚠⚠ 2026-10-15 订正 ✗（§16.31，真机/`file://` 两条探针同时咬出来）：**不再"退回第一个库"** ✗。
	//   原因：那是**猜**的 ✓ —— 没有注入时我们**不知道** IDE 的当前库是哪本 ✓，把第一本当它 ⇒
	//   ① 只显示一本、把其余藏起来 ⇒ 用户以为"我的库没了" ✗（现场正是"内容在别的路径"那种 ✓）；
	//   ② 连**探针**都被带偏 ✓（p3-72 的 ⑧/⑫ 崩在"点隐藏块里的行"✗ —— 它们本来取的是第一行 ✓）。
	//   ⇒ 规则改成：**知道才筛，不知道就全显示** ✓（`defaultVaultId` 为空 ⇒ 服务端把 `data-vault-default`
	//     写成 `all` ✓ ⇒ 页内筛选不筛 ✓）。这与"不编造"那条纪律同源 ✓（拿不准就如实多给，别假装知道 ✓）。
	const defaultVaultId = (activeVaultId && scannedIds.includes(activeVaultId)) ? activeVaultId : '';
	const pickerName = defaultVaultId
		? vaultDisplayName(defaultVaultId)
		: (scannedIds.length ? `当前库未知 · ${scannedIds.length} 个库都显示` : '（这个根下还没有库）');
	const pickerIcon = defaultVaultId ? vaultIcon(defaultVaultId) : codicon('book');
	const pickerTitle = defaultVaultId
		? `本页显示：${pickerName}；在这里切换只改**本页**显示；要改 IDE 的当前库，请去知识库设置（页面桥不允许写能力）`
		: '不知道 IDE 的当前库（页面没拿到库记录注入：老 Host / 独立启动器）⇒ 本页把扫到的库**都显示**出来，不猜是哪一本';
	// ★ 增删分流（2026-10-15 §16.32）：**登记**（在 IDE 清单里 ✓）⇒ 宿主删（原生确认 ✓）；
	//   **未登记**（只在盘上）⇒ 本页删（页内两级确认 ✓）。⚠ 没有注入时**不标「未登记」** ✗ ——
	//   那时根本不知道 IDE 的清单 ✓（不知道就不乱标 ✓，与"不猜当前库"同源 ✓）。
	const hasInjection = !!(injectedVaults && injectedVaults.length);
	// ⚠ 判据用**全量注入的 id 集** ✗ —— 别用"带 path 的子集"（默认布局的库在清单里、没有 customPath ✓，
	//   用子集会把它们误标「未登记」⇒ 删除分流走岔 ✗ —— 第一版正是这么错的 ✓，p3-08 的注入断言钉住 ✓）。
	const injectedIds = new Set((injectedVaults ?? []).map(v => String(v.id)));
	// ⚠ 三态（2026-10-15 §16.33）：yes＝在清单里 / no＝确知不在 / unknown＝**没拿到清单** ⇒ 页面据此 fail-closed ✓
	//   （二态时"没注入"被折成 no ⇒ 已登记的库也会走永久删除 ✗ —— 注入挂错行那次真机就是这个状态）。
	const vaultMenuItems = vaults.map(vault => {
		const registered = !hasInjection ? 'unknown' : (injectedIds.has(String(vault.id)) ? 'yes' : 'no');
		return {
			id: vault.id, name: vaultDisplayName(vault.id),
			note: `${vault.totalDocs} 条索引${vault.kernelBytes ? '' : ' · 无 kernel'}${registered === 'no' ? ' · 未登记' : ''}`,
			icon: vaultIcon(vault.id), registered,
			title: vaultMetaOf(vault.id)?.path ? `内容目录：${vaultMetaOf(vault.id).path}` : '',
		};
	}).map(item => `<div class="dsh-opt" data-vault-opt="${escapeHtml(item.id)}" data-vault-registered="${item.registered}" role="menuitem" tabindex="0"${item.title ? ` title="${escapeHtml(item.title)}"` : ''}>
<span class="dsh-check" data-vault-check></span><span class="dsh-opt-ico">${item.icon}</span><span class="dsh-opt-name">${escapeHtml(item.name)}</span><span class="dsh-path">${escapeHtml(item.note)}</span>
</div>`).join('');
	// ⚠ 选择器标签：有"当前库"（IDE 注入的 active ✓）就显示**它的名字与图标** ✓（真源 `_activeVault.name` 的口径 ✓）；
	//   拿不到就退回旧的「全部库（N）」✓（不假装"只有一个库" ✓）。
	const vaultBar = `<div class="dsh-vault-bar" data-vault-bar data-vault-default="${escapeHtml(defaultVaultId || 'all')}">
<div class="dsh-vault-select" data-vault-pick role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(pickerTitle)}">
<span class="dsh-vault-icon">${pickerIcon}</span><span class="dsh-vname" data-vault-name>${escapeHtml(pickerName)}</span><span class="dsh-caret">${codicon('chevron-down')}</span>
</div>
<span class="dsh-abtn" data-view-mode="tree" role="button" tabindex="0" title="文件树视图">${codicon('list-tree')}</span>
<span class="dsh-abtn" data-vault-refresh role="button" tabindex="0" title="刷新">${codicon('refresh')}</span>
<!-- ★ 设置 ＋ 关系图谱（2026-10-15 §16.29 ④⑤，位次照真源 :1353-1364 ✓：树 ⇄ 最近 / 刷新 / ⚙ / 🕸 ✓）。
     两者都要**中间栏 EditorPane**（真源 :2775 / :5461 ✓），而 dsh 侧没有中间栏 ⇒ 走页面桥
     openKbSettings / openKbGraph（桥 7 ✓）请宿主在编辑区打开**IDE 自己的**面板 ✓。
     ⚠ 旧宿主 ⇒ 点了**如实提示**"这个宿主还不支持"（不静默、不假装 ✓，见页内脚本 ✓）。
     注意：本行在模板串里 ⇒ 注释里不能出现反引号 ✗。 -->
<span class="dsh-abtn" data-kb-settings role="button" tabindex="0" title="知识库设置（在编辑区打开）">${codicon('gear')}</span>
<span class="dsh-abtn" data-kb-graph role="button" tabindex="0" title="关系图谱（在编辑区打开）">${codicon('graph')}</span>
<div class="dsh-vault-menu" data-vault-menu role="menu" hidden>
<div class="dsh-grp">当前知识库</div>
${vaultMenuItems}
<!-- ★ 增（2026-10-15 §16.32；mockup 就是这条 ✓）：分隔线 ＋ 「＋ 配置文件夹为知识库…」（真源 :1391-1396 ✓） -->
<div class="dsh-divider" aria-hidden="true"></div>
<div class="dsh-opt dsh-opt-add" data-vault-add role="menuitem" tabindex="0" title="把某个文件夹配置成知识库：走宿主的「选择文件夹」对话框（取消 ⇒ 什么都不做 ✓）；写入 IDE 清单后本页刷新可见">
<span class="dsh-check"></span><span class="dsh-opt-ico">${codicon('add')}</span><span class="dsh-opt-name">配置文件夹为知识库…</span>
</div>
</div>
</div>`;
	// 标签下拉：索引里出现过的标签汇总（带条数，按条数倒序）。标签可能有几十上百个，下拉太长反而不好用
	// ⇒ 只列前 30 个（如实标注总数）；要按"没列出来的"标签找，用 kb_search 的 tag 参数（工具侧无限）。
	const tagCounts = new Map();
	for (const vault of vaults) {
		for (const doc of vault.docs ?? []) {
			for (const tag of doc.tags ?? []) {
				const key = String(tag).toLowerCase();
				if (key) { tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1); }
			}
		}
	}
	const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
	const tagOptions = [`<option value="all">全部标签（${sortedTags.length}）</option>`]
		.concat(sortedTags.slice(0, 30).map(([tag, count]) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}（${count}）</option>`))
		.join('');
	// ★★ 排序维度（2026-10-14 §16.26）—— 逐项照真源 `KB_SORT_GROUPS`（`kbTypes.ts:88-122` ✓）
	//   **减掉三个摆不了/摆了没用的** ✗：
	//   · `refCountASC/DESC`（引用数）—— 真源的**比较器里根本没接** ✗（`knowledgeBaseView.ts:1969-1985`
	//     的 switch 没有这两个 case ⇒ 落到 `default: name.localeCompare` ✗）⇒ 摆了就是"选了没用还不说"
	//     ⇒ **不摆** ✓（这是真源自己的空壳项 ✓，别照抄 ✗）；
	//   · `custom`（自定义（拖拽））—— 真源比较器 `return 0`（＝不排 ✗）；本侧"拖拽"是**移动文件**
	//     （§16.19 ✓），不是手工排序 ⇒ 没有这个概念 ⇒ **不摆** ✓；
	//   · 「索引顺序」是真源**没有**的一项 ✓，但本页双侧列表（fs 树 ＋ 索引条目）都靠它当默认 ✓ ⇒ 保留 ✓。
	//   其余 12 项全落地 ✓（文件名 ×4 / 创建时间 ×2 / 编辑时间 ×2 / 文档大小 ×2 / 子文档数 ×2 ✓）。
	//   ⚠ 标签**逐字照真源** ✓（含"文档大小 (从小到大)"这类说法 ✓）。
	//   ⚠ value 也用真源的枚举名 ✗（`fileNameASC` … ✓）—— 页内比较器与真源同一个 switch 形状 ✓，
	//     以后对读两边代码不用再做一次心算 ✓。
	//   ⚠ 模板串里注释不许出现反引号 ✗。
	const sortGroups = [
		{ group: '索引', options: [['index', '索引顺序']] },
		{ group: '文件名', options: [['fileNameASC', '文件名 (A-Z)'], ['fileNameDESC', '文件名 (Z-A)'], ['fileNameNatASC', '文件名自然 (A-Z)'], ['fileNameNatDESC', '文件名自然 (Z-A)']] },
		{ group: '创建时间', options: [['createdASC', '创建时间 (从旧到新)'], ['createdDESC', '创建时间 (从新到旧)']] },
		{ group: '编辑时间', options: [['modifiedASC', '编辑时间 (从旧到新)'], ['modifiedDESC', '编辑时间 (从新到旧)']] },
		{ group: '其它', options: [['docSizeASC', '文档大小 (从小到大)'], ['docSizeDESC', '文档大小 (从大到小)'], ['subDocCountASC', '子文档数 (少到多)'], ['subDocCountDESC', '子文档数 (多到少)']] },
	];
	// 结构照真源 `openSearchSortDropdown`（`:3859-3885` ✓）：每组一个 `.kb-sort-group`（标题 ＋ 选项 ✓）、
	// 每项一个勾选位 ✓（真源挂 `codicon-check` ✓；我们没图标字体 ⇒ CSS 的 content 打勾 ✓）。
	const sortMenu = sortGroups.map(group => `<div class="dsh-sort-group" data-sort-group="${escapeHtml(group.group)}">
<div class="dsh-sort-label">${escapeHtml(group.group)}</div>
${group.options.map(([value, label]) => `<div class="dsh-sort-opt" data-sort-opt="${escapeHtml(value)}" role="menuitemradio" tabindex="0"><span class="dsh-ck" data-sort-ck></span><span>${escapeHtml(label)}</span></div>`).join('')}
</div>`).join('');
	// 工具条：搜索框 + 标签下拉 + 排序下拉（原 Pane 里这几件分处「vault 下拉 / 搜索行 / 排序」，
	// 这里合成一行省高度；侧栏窄时靠 `.dsh-search { flex-wrap: wrap; }` 自动换行）。
	// ⚠ 2026-10-14（§16.25）：**vault 下拉已从这里搬走** ✗ —— 真源里它是**独立一行**（`.kb-vault-bar` ✓，
	//   在标题之下、搜索行之上 ✓ `:617-628` ✓）＋ 一个自定菜单 ✗（不是 select ✓）⇒ 见上面 vaultBar ✓。
	const toolbar = `<div class="dsh-search">
		<!-- ★ 2026-10-19 顺手修一处真 bug ✗：这个 class 原先写成 dsh-search-icon，而 CSS 里只有
	     .dsh-search-ico（:839）⇒ 这枚图标**一直没吃到样式**。改名照 CSS 那侧来（不反过来加规则 ✓）。 -->
	<span class="dsh-search-ico">${codicon('search')}</span>
	<input type="search" data-search-input placeholder="搜索资料库…" aria-label="搜索文档">
	<!-- ⇐ .kb-search-mode-btn（真源在搜索框内、输入框之后 ✓；我们没包 box ⇒ 直接相邻 ✓；
	     注意：本行在模板串里 ⇒ 注释里**不能出现反引号** ✗ —— 真踩过：它把后面变成 JS，报 "search is not defined" ✓） -->
	<span class="dsh-search-mode-btn" data-search-mode role="button" tabindex="0" title="当前：全文检索（点击切换为文件名筛选）">全文</span>
	<!-- ★ 排序按钮（2026-10-14 §16.26）：真源把它放在**搜索框内**、模式按钮之后（:663-670 ✓）
	     —— 原先是个独立 <select> ✗，已换成按钮 ＋ 自定下拉（见 data-sort-dropdown ✓）。
	     注意：本行在模板串里 ⇒ 注释里不能出现反引号 ✗。 -->
	<span class="dsh-search-sort-btn" data-sort-btn role="button" tabindex="0" title="排序">${codicon('sort-precedence')}</span>
	<select data-tag-select aria-label="筛选标签">${tagOptions}</select>
</div>`;
	// ★ 2026-10-12（「资料库」拆分）：「记忆」分区已摘 —— 记忆升为独立工作台（`agentStudio.memory`
	// + `/x/memory/`），本页不再内嵌任何跨模块片段。
	// ★ 2026-10-13（§15.38 复刻）：「库」不再是"一个包住所有 vault 的大分区" ✗（那就与真源的
	//   「库 / 笔记 / 标签分类」三节对不上了 ✓）⇒ 这里只剩**容器**：结果面板 ＋ 计数行 ＋ 各 vault 的分区组 ✓。
	// ★ 复刻（§15.38）：「库」不再是"一个包住所有 vault 的大分区" ✗（那就与真源的
	//   「库 / 笔记 / 标签分类」三节对不上了 ✓）⇒ 这里只剩**容器**：结果面板 ＋ 计数行 ＋ 各 vault 的分区组 ✓。
	const sections = `<div class="dsh-search-results" data-search-results><div class="dsh-search-head" data-search-head></div><ul data-search-list></ul></div><div class="dsh-count" data-count>共 ${renderedDocs} 条文档</div>${vaultBlocks || '<p class="dsh-empty">还没有任何 vault。</p>'}<p class="dsh-empty" data-empty hidden>🔍 没有匹配的文档</p><div class="dsh-menu" data-menu role="menu" hidden></div><div class="dsh-dropdown" data-sort-dropdown role="menu" hidden>${sortMenu}</div>`;
	// ── 承载表面分派（2026-10-21）：同一份取数，三种外壳 ─────────────────────────────
	//   full（缺省）= 现在的完整页（目录 + 页内预览兜底）—— **既有探针全走这条** ✓（零行为改变）
	//   sideview    = 目录页（点条目 ⇒ 宿主把正文页开在编辑区，见 KB_SCRIPT 的 openDocSurface）
	//   editor      = 正文页（编辑区承载；选中项从同源 localStorage 读，见 DOC_SURFACE_SCRIPT）
	// ⚠ 三态的 kind 都保持 'kb'：两个既有页内脚本与探针都以 body[data-vssaros-page="kb"] 为锚点 ✓。
	const surfaceAttrs = `data-vssaros-surface="${surface}" data-vssaros-kb-surface="${surface}"`;
	if (surface === 'editor') {
		return renderShell({
			kind: 'kb',
			title: '知识库',
			subtitle: '正文 · 选中项由目录同步',
			// ⚠ diag 那行必须保留（探针读它上面的一串 data-vssaros-kb-* ✓，见上文 3027-3033 的理由）
			headerHtml: `<div class="dsh-header"><h1>知识库 <small>正文 · 只读</small></h1>${diag}</div>`,
			toolbarHtml: '',
			bodyHtml: `<div class="dsh-doc" data-doc-view><div class="dsh-doc-head"><p class="dsh-doc-title" data-doc-view-title>未选择</p><p class="dsh-doc-meta" data-doc-view-meta></p></div><div class="dsh-doc-body dsh-doc-empty" data-doc-view-body>从左侧目录选一篇笔记（选中项会自动同步到这里）</div></div>`,
			attrs: surfaceAttrs,
			extraCss: PAGE_CSS,
			// 这一版**只有**正文脚本（目录版的 KB_SCRIPT 在这里没有 DOM 可挂 ⇒ 不加载 ✓）
			script: DOC_SURFACE_SCRIPT,
		});
	}
	return renderShell({
		kind: 'kb',
		title: '知识库',
		subtitle: `${vaults.length} 个库 · ${totalDocs} 条索引 · 只读`,
		// ⚠ 库选择器（§16.25）**挂在标题之后** ✗：外壳只有「标题 / 工具条 / chips / 正文」四个槽位，
		//   没有独立的 vault-bar 槽 ⇒ 放这里，视觉顺序仍是「标题 → 库选择器 → 搜索行 ✓」＝ 真源 ✓。
		headerHtml: `<div class="dsh-header"><h1>知识库 <small>${vaults.length} 个库 · ${totalDocs} 条索引 · 只读</small></h1>${diag}</div>${vaultBar}`,
		toolbarHtml: toolbar,
		// ⚠ 目录现在**默认折叠**（§16.24 ✓）⇒ 没有 JS 时子树会整体看不见 ✗ —— 这会让本页丢掉
		//   "JS 不在也是全量只读列表"这条既有性质 ✓ ⇒ 用一条 noscript 样式把 [hidden] 还原成可见 ✓
		//   （纯 HTML 能力 ✓，不依赖任何脚本 ✓）。
		bodyHtml: `<noscript><style>.dsh-node-children[hidden] { display: block; }</style></noscript><div class="dsh-scroll">${notices}${sections}</div>`,
		attrs: surfaceAttrs,
		extraCss: PAGE_CSS,
		// 完整页：两段脚本顺序固定（先页内筛选，再挂预览兜底）；
		// 目录页（sideview）**不加载**预览兜底 —— 目录版不该有正文面板 ✓（正文在编辑区 ✓）。
		script: surface === 'sideview' ? KB_SCRIPT : KB_SCRIPT + DOC_PREVIEW_SCRIPT,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// kb_search 的两种检索模式（2026-10-12 新增 fulltext）
//
// 为什么是"同一个工具加一个 mode"而不是新开 `kb_grep`：IDE 侧的 `kb_search` 本来就有
// `mode: hybrid | fulltext | semantic`（`kbVaultRecallTools.ts:157-161`）—— 两边同名工具
// 已经登记在 `common/toolOwnership.ts` 的"同名工具"表里（共享同一个 vault），
// 再开一个新名字只会多一条漂移面 ✗。
// ⚠ 缺省必须是 `index`（= 从前的唯一行为）⇒ 加这个分支本身**零行为改变** ✓
//   （与 B1 那轮"缺省 = 现状"同一纪律：新能力只能在显式请求时生效 ✓）。
// ─────────────────────────────────────────────────────────────────────────────

/** 支持的检索模式（`index` = 索引字段匹配；`fulltext` = 正文 BM25；`semantic` = 向量 cosine）。 */
export const SEARCH_MODES = ['index', 'fulltext', 'semantic'];

/**
 * 规范化 `mode` 参数。
 *
 * ⚠ 不认识的取值**一律报错**。`semantic`：读壳侧落盘的 `.kvindex`（单 vault 时壳侧构建后落盘 ✓，
 * 见 `kbCommandService._rebuildVectorIndex`）——没有索引文件 ⇒ 如实报错（"还没建向量索引"），
 * **不静默退化成 fulltext** ✗（那会让模型以为"语义检索做过了" ✗）。`hybrid` 本侧没有（混合检索
 * 是另一套排序，不是"向量 + 全文各跑一遍拼起来" ✗）⇒ 明确报错 ✓。
 */
export function normalizeSearchMode(value) {
	if (value === undefined || value === null || value === '') {
		return 'index';
	}
	const mode = String(value).trim();
	if (SEARCH_MODES.includes(mode)) {
		return mode;
	}
	if (mode === 'hybrid') {
		throw new Error(`mode="hybrid" 本侧（dsh）没有混合检索（那是另一套排序，不是"向量+全文各跑一遍"）：请用 mode="semantic"（向量）或 mode="fulltext"（正文全文）。`);
	}
	throw new Error(`未知的 mode：${mode}（本侧支持 ${SEARCH_MODES.join(' / ')}）`);
}

/** fulltext 模式的回执：命中 + 片段 + 来源/索引时间/截断的**如实标注**。 */
export function renderFulltextResult(value) {
	const stamp = (value.sources ?? []).map(s => s.indexedAt).filter(Boolean)[0];
	if (!value.count) {
		return `正文检索没有命中（已索引 ${value.docsIndexed ?? 0} 篇${stamp ? ` · 索引于 ${stamp}` : ''}）。`;
	}
	const head = `${value.count} 条命中（正文 BM25 · 已索引 ${value.docsIndexed ?? 0} 篇${stamp ? ` · 索引于 ${stamp}` : ''}）：`;
	const lines = value.items.map((item, index) => {
		const label = item.matchedBy === 'name' ? '标题命中' : (item.matchedBy === 'tag' ? '标签命中' : '内容命中');
		const snippet = String(item.snippet ?? '').replace(/\s+/g, ' ').trim();
		return `${index + 1}. [${item.vaultId}] ${item.title} (${item.score} · ${label})\n   ${snippet.length > 240 ? `${snippet.slice(0, 240)}…` : snippet}`;
	});
	const notes = [];
	if (Number.isFinite(value.totalHits) && value.totalHits > value.count) {
		notes.push(`另有 ${value.totalHits - value.count} 条命中未列出（受 limit 限制）。`);
	}
	if (value.docsWithoutText) {
		notes.push(`${value.docsWithoutText} 篇索引条目没有正文（老索引），未参与检索。`);
	}
	const notKernel = (value.sources ?? []).filter(s => s.source !== '.kbkernel.json');
	if (notKernel.length) {
		notes.push(`来源不是 .kbkernel.json 的库：${notKernel.map(s => `${s.vaultId}=${s.source}`).join(', ')}。`);
	}
	// 跨库检索时分数**不可互相比较**（每库一份索引 ⇒ 各自语料不同）⇒ 如实说明，不假装可比 ✓
	// ⚠ 说的是"覆盖了几个库"（含没有命中的），不是"命中来自几个库" —— 后者会让人以为每个库都出结果 ✗
	if ((value.vaultsSearched ?? 0) > 1) {
		notes.push(`本次覆盖 ${value.vaultsSearched} 个库；分数是各库**库内**分数（不可跨库比较），要单库一致口径请用 vaultId 限定。`);
	}
	// ★ P3（§16.11）：本次检索前的自动重建**如实说** ✓（成功说"重建了"、失败说"没建成＋原因" ✗不许静默 ✓）
	for (const entry of value.reindex ?? []) {
		notes.push(entry.error
			? `库 ${entry.vaultId} 的索引重建失败（本次用的是旧索引）：${entry.error}`
			: `库 ${entry.vaultId} 的索引已自动重建（检测到磁盘变化 ✓）。`);
	}
	return [head, ...lines, ...notes].join('\n');
}

/**
 * fulltext 模式：读索引快照里的正文 → **每库一份**索引（缓存）→ BM25 检索 → 合并。
 *
 * `type` / `tag` **不支持**（那是索引字段的过滤条件；正文检索里"按类型过滤"没有对应物）
 * ⇒ 传了就**明确报错**（不静默忽略 ✗ —— 忽略会让调用方以为过滤生效了）。
 *
 * ⚠ `searchFulltext` 由插件自己实现的（非 dsh 官方 API）⇒ 它不是一个"服务调用"，
 *   而是本模块内的纯函数。（见 core/kbFulltext.js 文件头：口径逐字照 IDE 侧 kbIndex.ts ✓）
 */
/**
 * ★ P3 自动触发（2026-10-14，§16.11）："文件变 ⇒ 检索前重建"的 dsh 等价 ✓。
 * 真源是 `_searchDirty` 脏标记 ＋ 搜索/打开时 `rebuildSearchAssets`（进程内事件驱动 ✓）；
 * dsh 侧没有 IDE 的文件事件 ⇒ 用**脏检查**（`kernelStaleCheck`：盘上指纹 vs 内核条目 ✓）当判据 ✓。
 * ⚠ 这是**读路径上的写** ✗ ⇒ 三条纪律：① vault 锁（与其他写者互斥 ✓）＋ **锁内双检**（可能已被别人重建 ✓）；
 *   ② 重建失败**不打断检索**（内核可再生 ✓）但错误**如实带出** ✗（不许静默吞 ✓）；
 *   ③ `config.autoReindex === false` 可整体关掉（新行为要可回退 ✓，与 maintainNavigation 同一手法 ✓）。
 * @returns `{ vaultDir, reason }` / `{ vaultDir, error }` / `undefined`（没重建）
 */
async function ensureKernelFresh(vaultDir) {
	const stale = await kernelStaleCheck(vaultDir);
	if (!stale.stale) { return undefined; }
	const release = await acquireFileLock(lockFileFor(vaultDir), { label: '知识库索引重建' });
	try {
		const again = await kernelStaleCheck(vaultDir);   // ⚠ 锁内双检 ✓：等锁期间别人可能已重建 ✓
		if (!again.stale) { return undefined; }
		await rebuildKernelCache(vaultDir);
		return { vaultDir, reason: stale.reason };
	} catch (e) {
		return { vaultDir, error: String(e?.message ?? e) };
	} finally {
		await release();
	}
}

async function runFulltextSearch(rootValue, { wantedVault, query, limit, type, tag, config }) {
	const q = typeof query === 'string' ? query.trim() : '';
	if (!q) {
		throw new Error('mode="fulltext" 需要非空的 query（只想按类型/标签过滤请用缺省的 mode="index"）。');
	}
	if (type || tag) {
		throw new Error('mode="fulltext" 不支持 type / tag 过滤：这两项只作用于索引字段，请改用 mode="index"。');
	}
	const { vaults } = await listAllVaults(rootValue, config, { withDocs: false });
	const targets = wantedVault ? vaults.filter(vault => vault.id === wantedVault) : vaults;
	if (targets.length === 0) {
		throw new Error(wantedVault ? `资料库里没有这个 vault：${wantedVault}` : `资料库根下还没有任何 vault：${rootValue}`);
	}
	// ★ P3 自动触发（§16.11 ✓，见 ensureKernelFresh 的文件头注释）：脏 ⇒ 先重建再检索 ✓
	const reindex = [];
	if (config?.autoReindex !== false) {
		for (const vault of targets) {
			const outcome = await ensureKernelFresh(vault.dir);
			if (outcome) { reindex.push({ vaultId: vault.id, ...outcome }); }
		}
	}
	const perVault = await fulltextIndexes(rootValue, targets);
	const withDocs = perVault.filter(entry => entry.index.totalDocs > 0);
	if (withDocs.length === 0) {
		// ⚠ P3 之后这句要把"重建失败"如实带出来 ✗：否则"自动重建没建成（比如内核路径被占）"
		//   会被显示成"没索引过"——两个完全不同的问题 ✓（静默合并 = 指不到真因 ✗）。
		const failedReindex = reindex.filter(entry => entry.error);
		throw new Error('选中的 vault 里没有可检索的正文：'
			+ targets.map(vault => vault.id).join(', ')
			+ (failedReindex.length
				? `（已尝试自动重建但失败：${failedReindex.map(entry => `${entry.vaultId}：${entry.error}`).join('；')}）`
				: '（盘上确实没有可索引的文本文件，或重建被 config.autoReindex=false 关闭 ✓）'));
	}

	// 每库各自检索（分数与 IDE 侧一致 ✓），再按分数合并；跨库分数不可比 ⇒ 回执里如实说明
	const merged = [];
	let totalHits = 0;
	for (const entry of withDocs) {
		const result = searchFulltext(entry.index, q, { limit });
		totalHits += result.totalHits ?? result.hits.length;
		merged.push(...result.hits);
	}
	merged.sort((a, b) => b.score - a.score);
	const items = merged.slice(0, limit).map(hit => ({
		vaultId: hit.vaultId ?? '',
		uri: hit.uri,
		title: hit.title,
		score: Math.round(hit.score * 100) / 100,
		matchedBy: hit.matchedBy,
		snippet: hit.snippet,
	}));
	return {
		count: items.length,
		mode: 'fulltext',
		items,
		totalHits,
		docsIndexed: perVault.reduce((sum, entry) => sum + entry.docs, 0),
		docsWithoutText: perVault.reduce((sum, entry) => sum + entry.docsWithoutText, 0),
		vaultsSearched: withDocs.length,
		cached: perVault.every(entry => entry.cached === true),
		// 只列**真参与检索**的库（什么都没索引的库列出来只会误导 ✓）
		sources: withDocs.map(entry => ({ vaultId: entry.vaultId, source: entry.source, indexedAt: entry.indexedAt, docs: entry.docs })),
		// ★ P3：本次检索前**重建过/重建失败**的库（如实带出 ✗ 不许静默 ✓；renderFulltextResult 会译成一行 ✓）
		...(reindex.length ? { reindex } : {}),
	};
}

/**
 * 语义检索（重构 4，2026-10-16）：读壳侧落盘的 `.kvindex`（单 vault 时壳侧 `_rebuildVectorIndex`
 * 会写 ✓），经桥回 IDE 取 query 向量（embedding 模型在壳侧 ✓），cosine 线性扫描取 top-k。
 * 没有索引文件 / 没有桥 ⇒ 如实报错（不静默退化成 fulltext ✗——那会让模型以为"语义检索做过了" ✗）。
 */
async function runSemanticSearch(rootValue, { wantedVault, query, limit, bridge, config }) {
	const q = typeof query === 'string' ? query.trim() : '';
	if (!q) {
		throw new Error('mode="semantic" 需要非空的 query（只想按类型/标签过滤请用缺省的 mode="index"）。');
	}
	const { vaults } = await listAllVaults(rootValue, config, { withDocs: false });
	const targets = wantedVault ? vaults.filter(vault => vault.id === wantedVault) : vaults;
	if (targets.length === 0) {
		throw new Error(wantedVault ? `资料库里没有这个 vault：${wantedVault}` : `资料库根下还没有任何 vault：${rootValue}`);
	}
	// 读每个 vault 的 .kvindex（壳侧单 vault 时落盘 ✓；多 vault 壳侧没落 ⇒ 如实报"没建" ✓）。
	const { readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const perVault = [];
	for (const vault of targets) {
		const indexPath = join(vault.dir, '.kvindex');
		let data = null;
		try {
			const buf = await readFile(indexPath);
			data = deserializeVectorIndexBinary(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
		} catch { /* 没有索引文件 ⇒ 下面如实报 */ }
		if (data) { perVault.push({ vaultId: vault.id, data, indexPath }); }
	}
	if (perVault.length === 0) {
		throw new Error('选中的 vault 还没有向量索引：'
			+ targets.map(v => v.id).join(', ')
			+ '（壳侧在设置里「重建向量索引」后会写 .kvindex；本侧只读它，不自己建——建索引要 embedding 模型，那是壳侧的 ✓）。');
	}
	// 经桥回 IDE 取 query 向量（embedding 模型在壳侧 ✓）。
	if (!bridge || typeof bridge.callIDE !== 'function') {
		throw new Error('语义检索要经桥回 IDE 取 query 向量（embedding 模型在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
	}
	const reply = await bridge.callIDE('ide.request', {
		capability: 'kb',
		pluginId: 'vssaros-kb',
		params: { op: 'embed', text: q },
	}, { timeoutMs: 60 * 1000 });
	const queryVector = Array.isArray(reply?.vector) ? reply.vector : null;
	if (!queryVector) {
		throw new Error(`IDE 没回向量（embedding 没实现？）：${JSON.stringify(reply)?.slice(0, 120)}`);
	}
	// 每库各自检索（cosine），按分数合并；跨库分数不可比 ⇒ 回执里如实说明（与 fulltext 同口径 ✓）。
	const merged = [];
	for (const entry of perVault) {
		for (const hit of searchVectorIndex(entry.data, queryVector, { limit })) {
			merged.push({ vaultId: entry.vaultId, uri: hit.docId, title: hit.docName, score: Math.round(hit.score * 100) / 100, snippet: String(hit.text ?? '').slice(0, 240), matchedBy: 'semantic' });
		}
	}
	merged.sort((a, b) => b.score - a.score);
	const items = merged.slice(0, limit);
	return {
		count: items.length,
		mode: 'semantic',
		items,
		vaultsSearched: perVault.length,
		sources: perVault.map(entry => ({ vaultId: entry.vaultId, source: '.kvindex', chunks: entry.data.chunks?.length ?? 0 })),
	};
}

/**
 * 工具定义（都带 `output.render`——缺它会让**整个插件不挂载**）。
 * 前四个只读；最后一个是飞书同步（**默认只预览**，`apply:true` 才写远端）。
 */
/**
 * 注入里**内容在别处**的库（`customPath` ⇒ 库根不在知识库数据根下）—— ★ 2026-10-15（B 方案）。
 *
 * 用户真正的库是 `我的知识库 = e:\VsSarosVault`（IDE 的「配置文件夹为知识库」挂进来的 ✓），
 * 而本侧此前**只扫数据根** ⇒ 它一个都列不出来 ✗（页面上只有数据根下那些遗留 uid 目录 ✓）——
 * 而真源那套"库内 .md ⇒ 块编辑器富显示"的判据只认**已登记的库根** ⇒ 点遗留目录里的笔记只能是
 * 普通编辑器、内容也显示不出来 ✓（用户 2026-10-15 报"点击知识库中的文件无法显示内容" ✓）。
 *
 * ⚠ **模块级**（不是 `toolDefinitions` 里面 ✗ —— 页面渲染与页面路由都在这之外，放窄了就是
 *   `ReferenceError: externalVaultRecords is not defined` ⇒ 页面 500 ✓，2026-10-15 真踩过）。
 * ⚠ 容错口径同 `parseInjectedVaults`：拿不到 / 坏 JSON / 没有 path ⇒ 空数组 ⇒ 退回"只扫盘"✓（不猜 ✓）。
 */
/**
 * dsh 侧**自持**的库登记表（2026-10-24）。
 *
 * 为什么需要：IDE 的库清单是启动时注入的静态值，用户想在 dsh 页面里「新建知识库」或
 * 「打开本地文件夹作为知识库」时，没有地方可写 —— 又不能去改 IDE 的配置（那是宿主的）。
 * ⇒ 存一份自己的登记表 `<数据根>/.extra-vaults.json`，`externalVaultRecords` 把两份合并。
 * 这样：IDE 注入的库照旧、dsh 新增的库也照旧参与 listVaults / 读围栏 / 写工具。
 */
let EXTRA_VAULTS = [];
let EXTRA_VAULTS_ROOT = '';
function loadExtraVaults(root) {
	try {
		const p = join(root, '.extra-vaults.json');
		if (!existsSync(p)) { return []; }
		const arr = JSON.parse(readFileSync(p, 'utf8'));
		if (!Array.isArray(arr)) { return []; }
		return arr.filter(v => v && typeof v.id === 'string' && typeof v.path === 'string' && v.path.trim());
	} catch {
		return [];
	}
}
function ensureExtraVaults(root) {
	if (EXTRA_VAULTS_ROOT !== root) {
		EXTRA_VAULTS_ROOT = root;
		EXTRA_VAULTS = loadExtraVaults(root);
	}
	return EXTRA_VAULTS;
}

function externalVaultRecords(config) {
	const list = parseInjectedVaults(injectedRawOf(config)) ?? [];
	const injected = list
		.filter(item => typeof item?.path === 'string' && item.path.trim())
		.map(item => ({ id: String(item.id), dir: String(item.path).trim(), name: item.name, icon: item.icon }));
	// 合并 dsh 自持登记（按 id 去重，注入的优先 —— 那份是"真源"）
	let extras = [];
	try {
		const root = kbRootOf(config);
		extras = ensureExtraVaults(root).map(v => ({ id: String(v.id), dir: String(v.path).trim(), name: v.name, icon: 'codicon:library' }));
	} catch { /* 数据根不可用 ⇒ 只用注入清单 */ }
	const seen = new Set(injected.map(v => v.id));
	return injected.concat(extras.filter(v => v.dir && !seen.has(v.id)));
}

/**
 * 本插件拿到的 `kbVaults` 原始串：**config 优先，overlay 文件兜底**。
 *
 * ★★ 2026-10-20 真机（用户反复报「kb_list 少了外挂库」）：
 *   定性日志打出来是 `kb_list keys=[]` —— 插件的 **config 整个是空对象**，
 *   连 `cordis.patch.yml` 里的 `autoApprove` 都不在 ⇒ `apply(ctx, {})`。
 *   而 `roots-*.yml`（IDE 写的 overlay）里 `- id: vssaros-kb` + `kbVaults` **逐字节是对的**
 *   （我用 node 读原始字节核对过）⇒ 结论：**那一行没有合并进本插件**。
 *   疑因：`cordis.presets.yml` 里已经声明了 `- id: vssaros-kb`（无 config），
 *   patch 的 `insert` 因 id 已存在被跳过 ⇒ 它携带的 config 一并丢失（dsh 侧行为，非本仓可控）。
 *
 *   ⇒ 不跟 dsh 的 patch 语义较劲：**直接读那个已经写好的 overlay 文件**。
 *     IDE 侧不用改（文件本来就在），config 修好之后 `config.kbVaults` 会自动优先 ✓。
 *   ⚠ 只读**最新**的 `roots-*.yml`（按 mtime），且只在 apply 时读一次（结果缓存在模块变量里）。
 */
function readKbVaultsFromOverlay(dataRoot) {
	try {
		const dir = join(dataRoot, 'dsh-run');
		const newest = readdirSync(dir)
			.filter(name => /^roots-.*\.yml$/.test(name))
			.map(name => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0];
		if (!newest) { return ''; }
		const text = readFileSync(join(dir, newest.name), 'utf8');
		// 只抓 `kbVaults:` 那一行（值用 YAML 单引号包着；单引号内的 ' 会写成 ''，JSON 里不会出现）
		const match = /^\s*kbVaults:\s*'(.*)'\s*$/m.exec(text);
		return match ? match[1].trim() : '';
	} catch {
		return '';
	}
}

/** overlay 兜底值（apply 时填；空 = 没读到） */
let kbVaultsFromOverlay = '';

/** config 与 overlay 兜底的合并取值：config 有就用 config（将来 dsh 修好会自动优先）。 */
function injectedRawOf(config) {
	const raw = config?.kbVaults;
	// ★ 2026-10-24：**数组形态也接受**。真实注入是 JSON 字符串（YAML 单引号包着），但以代码方式
	//   装配 config（探针 / 将来的 API）时给的是数组；只认字符串会让「库根」为空 ⇒
	//   写接口把所有路径判成"库外" ⇒ 保存/上传全 403（本轮写护栏探针就是这样抓到的）。
	if (Array.isArray(raw)) { return JSON.stringify(raw); }
	const fromConfig = typeof raw === 'string' ? raw.trim() : '';
	return fromConfig || kbVaultsFromOverlay;
}
/**
 * 本侧认的**全部**库 = 扫盘 ＋ 注入里内容在别处的 ✓ —— 页面与工具**共用这一份口径**（别各拼一套 ✗）。
 * ⚠ 别把它写成 `listAllVaults` 调自己 ✗（第一刀就是，跑起来直接爆栈 ✓ —— 批量改写把定义体也改了 ✓）。
 */
function listAllVaults(rootValue, config, options = {}) {
	// ★ 2026-10-19：「注入了外部清单 ⇒ 只认注入的」这条口径已经下沉到 **`store.listVaults` 底层**
	//   （页面/工具/API 全经过它 ⇒ 只有一处判别 ✓）。这里保持"只负责拼 external"的单一职责，
	//   不再重复过滤（否则两处口径迟早漂移 ✗）。
	return listVaults(rootValue, { ...options, external: externalVaultRecords(config) });
}
function toolDefinitions(ctx, state, config) {
	const root = () => kbRootOf(config);
	return [{
		name: 'kb_list',
		description: '列出资料库里所有 vault（知识库），**带真实路径**（`path`）。'
			+ '⚠ 库不一定在数据根下：外挂库（用户把已有文件夹登记成库）的真实内容在 path 指向的位置，'
			+ '数据根下**不会有**同名 id 目录 ⇒ 判断"库是否存在"请以 path 为准，别去 `<数据根>/<id>` 找。'
			// ★ 2026-10-19（真机：模型判定"库不存在"后提议改 .active-dir.json / 建目录）：
			//   把职责边界写进**工具描述** —— 这是模型每次调用都会读到的位置，
			//   比塞进 agent 的 systemPrompt 更靠近行为点（且不会碰 builtinAgentSingleSource 的逐字对账 ✓）。
			+ '⚠ **职责边界**：你只负责库里的内容。发现工具/配置异常时**报告给用户并给证据**'
			+ '（失败的调用、期望 vs 实际、你查过哪里），**不要**自行修改工程源码（dsh-plugins / src / resources / 配置），'
			+ '**也不要**改 .active-dir.json 这类运行期文件 —— 那属于应用，不属于笔记。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					vaults: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, totalDocs: { type: 'integer' } },
							required: ['id', 'path'],
						},
					},
				},
				required: ['count', 'vaults'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `资料库有 ${value.count} 个 vault：\n${value.vaults.map(v => `- ${v.id}（${v.name ?? v.id}）：${v.path}`).join('\n')}`
					: '资料库还没有 vault。',
			}],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			// ★★ 2026-10-20：**定性日志**。已确认 overlay 里的值合法、`parseInjectedVaults` 也能解析，
			//   但 `kb_list` 仍只返回数据根下扫到的历史库 ⇒ 只剩一种可能：**`config.kbVaults` 没到插件**。
			//   这里把三件事一次打出来（下次一调 kb_list 就能判）：
			//     raw    = kbVaults 的 typeof / 长度（undefined ⇒ patch 没生效；string(0) ⇒ 传了空串）
			//     parsed = parseInjectedVaults 解析出几条
			//     ext    = externalVaultRecords 过滤后剩几条（它要求 path 非空）
			const rawInjected = injectedRawOf(config);
			const injected = parseInjectedVaults(rawInjected);
			// ★ 2026-10-20 加 keys + src：keys 里**没有 kbVaults**（甚至整个是空对象）就证明
			//   roots overlay 那一行**没合并进本插件**（overlay 文件本身已验证正确）；
			//   src 说明这次用的是哪份 —— config（dsh 修好后自动优先）还是 overlay 兜底。
			void logKbWrite(config, `kb_list keys=[${Object.keys(config ?? {}).join(',')}] src=${typeof config?.kbVaults === 'string' && config.kbVaults.trim() ? 'config' : (kbVaultsFromOverlay ? 'overlay' : 'none')} raw=${typeof rawInjected === 'string' ? 'string(' + rawInjected.length + ')' : typeof rawInjected} parsed=${injected ? injected.length : 0} ext=${externalVaultRecords(config).length} root=${root()}`);
			const { vaults } = await listAllVaults(root(), config, { withDocs: false });
			// ★★ 2026-10-19（真机：模型误判「库已不存在」并想改 .active-dir.json）：
			//   这里原先只返回 `{ id, totalDocs }` —— **没有 path**。而外挂库（`e:\VsSarosVault`）
			//   在数据根下**没有**同名目录 ⇒ 模型只能去 `<数据根>/<id>` 找 ⇒ 找不到 ⇒
			//   判定"库不存在" ⇒ 提议改 `.active-dir.json` 的 `__activeVaultId`、甚至"就地建目录" ✗
			//   ⇒ 把 **path**（和 name）给出去：判断库是否存在，看它，而不是猜目录布局 ✓。
			return {
				count: vaults.length,
				vaults: vaults.map(v => ({ id: v.id, name: v.name ?? v.id, path: v.dir, totalDocs: v.totalDocs })),
			};
		},
	}, {
		name: 'kb_search',
		description: '检索知识库。mode="index"（缺省）：在**索引字段**里匹配（标题 / 标签 / 类型 / 路径），不读正文；'
			+ 'mode="fulltext"：对**正文**做 BM25 全文检索（中文按单字 + 二元切分，回执带命中片段）。'
			+ '两者都返回 uri，可用 kb_read 读正文。'
			+ '⚠ 本侧不支持 mode="semantic"（需要向量索引，只有 IDE 侧有，传了会明确报错而不是退化）；'
			+ 'fulltext 在检索前会做**脏检查**：磁盘变了就**先自动重建索引**再检索（回执里如实标注哪些库重建过；'
			+ '重建失败则用旧索引并给出原因；config.autoReindex=false 可关掉这个行为）。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '检索词；mode="index" 时留空 = 按类型/标签过滤后按时间倒序；mode="fulltext" 时必填' },
				mode: { type: 'string', enum: ['index', 'fulltext'], description: '检索方式（缺省 index = 索引字段匹配；fulltext = 正文 BM25 全文）' },
				type: { type: 'string', description: '限定文档类型（如 concept / comparison；仅 mode="index" 支持）' },
				tag: { type: 'string', description: '限定标签（仅 mode="index" 支持）' },
				limit: { type: 'integer', description: '返回条数上限，1–100（默认 20；超出会被夹到边界）' },
				vaultId: { type: 'string', description: '限定某个 vault（留空 = 全部）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					mode: { type: 'string' },
					// ★ 2026-10-20：index 模式 0 命中时自动降级 fulltext ⇒ 标注从哪个模式降下来的
					fallbackFrom: { type: 'string' },
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								vaultId: { type: 'string' }, uri: { type: 'string' }, title: { type: 'string' },
								type: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
								score: { type: 'number' }, matchedBy: { type: 'string' }, snippet: { type: 'string' },
							},
							required: ['vaultId', 'uri', 'title'],
						},
					},
					// fulltext 模式的诚实计数（缺省模式不返回这些键）
					totalHits: { type: 'integer' },
					docsIndexed: { type: 'integer' },
					docsWithoutText: { type: 'integer' },
					sources: { type: 'array', items: { type: 'object' } },
				},
				required: ['count', 'items'],
			},
			render: (_args, value) => [{
				type: 'text',
				// ⚠ index 模式的那句**一字不改**（既有探针 p3-08 与模型见过的文案都按它写 ✓）
				text: value.mode === 'fulltext'
					? renderFulltextResult(value)
					: (value.count
						? `${value.count} 条命中：\n${value.items.map((item, index) => `${index + 1}. [${item.vaultId}] ${item.title}${item.type ? ` · ${item.type}` : ''}`).join('\n')}`
						: '没有命中资料库条目。'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const wantedVault = typeof params?.vaultId === 'string' ? params.vaultId.trim() : '';
			if (wantedVault && !isVaultId(wantedVault)) {
				throw new Error(`vaultId 形态不合法：${wantedVault}`);
			}
			const mode = normalizeSearchMode(params?.mode);
			const limit = Math.min(100, Math.max(1, Number.isFinite(params?.limit) ? Math.floor(params.limit) : 20));
			if (mode === 'fulltext') {
				return runFulltextSearch(root(), { wantedVault, query: params?.query, limit, type: params?.type, tag: params?.tag, config });
			}
			// 重构 4：semantic 模式（读壳侧落盘的 .kvindex + 经桥取向量 + cosine）。
			if (mode === 'semantic') {
				return runSemanticSearch(root(), { wantedVault, query: params?.query, limit, bridge: state.bridge, config });
			}
			const { vaults } = await listAllVaults(root(), config, { withDocs: true });
			const items = [];
			for (const vault of wantedVault ? vaults.filter(v => v.id === wantedVault) : vaults) {
				for (const doc of searchDocs(vault.docs, {
					query: params?.query ?? '',
					type: params?.type ?? '',
					tag: params?.tag ?? '',
					limit,
				})) {
					items.push({ vaultId: vault.id, uri: doc.uri, title: doc.title, ...(doc.type ? { type: doc.type } : {}), ...(doc.tags.length ? { tags: doc.tags } : {}) });
				}
			}
			// 跨库结果按标题稳定排序后夹到 limit（同输入同输出）
			items.sort((a, b) => a.title.localeCompare(b.title) || a.uri.localeCompare(b.uri));
			const picked = items.slice(0, limit);
			// ★★ 2026-10-20（用户报「kb_search 返回空」）：本工具此前**一行日志都不写** ⇒
			//   没法区分「库选错了 / 索引空 / 过滤条件把结果筛没了 / 查询词真的没命中」✗。
			//   这里每次调用都记一行（含各库文档数与命中数）。实测索引本身是好的
			//   （168 docs、带 text 字段、"框架原理" 能命中 1 条）⇒ 空结果一定出在参数或库选择上 ✓。
			void logKbWrite(config, `kb_search mode=${mode} q=${JSON.stringify(params?.query ?? '')} type=${params?.type ?? '-'} tag=${params?.tag ?? '-'} vaults=${vaults.length} docs=${vaults.reduce((sum, v) => sum + (Array.isArray(v?.docs) ? v.docs.length : 0), 0)} hits=${picked.length}`);
			// ★★ 2026-10-20（用户报「kb_search 返回空」）：**0 命中时自动降级 fulltext**。
			//   真机根因就是这里：`mode: "index"`（缺省）只在**元数据**（标题/标签/类型/路径）里匹配，
			//   **完全不读正文** —— 模型/用户搜正文里的词必然 0 命中，而它不会想到要显式传
			//   `mode: "fulltext"` ⇒ 体感就是"知识库搜不到东西" ✗（实测索引 168 篇、
			//   "框架原理" 在 index 模式能命中 1 条，但正文词命中率为 0）。
			//   ⇒ 只在**有查询词且 0 命中**时降级（有 type/tag 过滤时不降级：
			//     那多半是"过滤把结果筛没了"，换模式也帮不上，而且 fulltext 不认 type/tag ✗）。
			const queryText = String(params?.query ?? '').trim();
			if (picked.length === 0 && queryText && !params?.type && !params?.tag) {
				void logKbWrite(config, `kb_search fallback → fulltext（index 模式 0 命中，query=${JSON.stringify(queryText)}）`);
				const fulltext = await runFulltextSearch(root(), {
					wantedVault, query: queryText, limit, type: params?.type, tag: params?.tag, config,
				});
				// `fallbackFrom` 让调用方知道"这不是 index 模式的结果"（回执里也会说明 ✓）
				return { ...fulltext, fallbackFrom: 'index' };
			}
			return { count: picked.length, mode: 'index', items: picked };
		},
	}, {
		// ★★ 2026-10-20（用户报「为什么存到 讲懂/ 文件夹」）：新增**目录地图**工具。
		//   此前模型要决定「这篇放哪」时**没有任何依据**（只能看单个文件路径，看不到分类结构）
		//   ⇒ 就按任务名自造了 `笔记/讲懂/` ✗。
		//   `笔记/知识体系.md` 里本来有一份带说明的目录总览，但它是 `kb_build` 的产物、
		//   **可能过时**（实测文档写 UnrealEngine 46 篇、磁盘只有 1 篇）⇒ 这里**以磁盘为准**，
		//   只给"路径 + 篇数"（语义留给模型按目录名判断，或让它读体系文档补充）。
		name: 'kb_catalog',
		description: '笔记区的**目录地图**：列出 `笔记/` 下所有分类目录及其篇数（**以磁盘实际目录为准**）。'
			+ '⚠ 决定把笔记写到哪里之前，**先调本工具**看清既有分类；把笔记放进**领域分类**（如 `笔记/01_学习/AI_Agent`），'
			+ '**不要**用任务类型命名目录（`讲懂/`、`分析/`、`摘要/` 都是错的）。'
			+ '看不清该放哪就**直接问用户**（把这里的目录列给用户选）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					dirs: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								path: { type: 'string' }, name: { type: 'string' },
								depth: { type: 'integer' }, count: { type: 'integer' },
								// 语义说明（来自 笔记/知识体系.md，可能缺失；篇数**不**取自它 ✓）
								desc: { type: 'string' },
							},
							required: ['path'],
						},
					},
				},
				required: ['count', 'dirs'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `笔记区有 ${value.count} 个分类目录（路径与篇数**以磁盘为准**；说明来自知识体系.md，可能滞后）：\n`
						+ value.dirs.map(d => `- ${d.path}（${d.count} 篇）${d.desc ? `　← ${d.desc}` : ''}`).join('\n')
					: '笔记区还没有子目录（可以直接写 `笔记/xxx.md`，或问用户想怎么分类）。',
			}],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const { vaults } = await listAllVaults(root(), config, { withDocs: false });
			const target = vaults[0];
			if (!target) { return { count: 0, dirs: [] }; }
			// 目录与篇数来自**磁盘**（真实）；说明来自 `笔记/知识体系.md`（尽力匹配，可能过时/缺失）
			const [dirs, descMap] = await Promise.all([
				noteCatalog(target.dir),
				catalogDescriptions(target.dir),
			]);
			const enriched = dirs.map(d => ({ ...d, ...(descMap.get(d.name) ? { desc: descMap.get(d.name) } : {}) }));
			void logKbWrite(config, `kb_catalog vault=${target.id} dirs=${enriched.length} desc=${descMap.size}`);
			return { count: enriched.length, dirs: enriched };
		},
	}, {
		name: 'kb_read',
		description: `读取资料库里的某一篇文档正文（用 kb_search 得到的 uri）。单篇上限 ${MAX_DOC_BYTES} 字，超出会截断。`
			+ '传相对路径（如 库/概念/x.md）时按**当前库**解析（vaultId 缺省 = 页面上选的那个库）；'
			+ '要读别的库就显式传 vaultId，否则同名相对路径会在多个库里撞车、读到错的那一份。',
		parameters: {
			type: 'object',
			properties: {
				uri: { type: 'string', description: '文档 uri（kb_search 返回的那个）或 vault 内相对路径，如 库/概念/x.md' },
				vaultId: { type: 'string', description: '相对路径按哪个 vault 解析（留空 = 当前库）' },
			},
			required: ['uri'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					path: { type: 'string' }, bytes: { type: 'integer' }, truncated: { type: 'boolean' }, content: { type: 'string' },
				},
				required: ['path', 'bytes', 'content'],
			},
			render: (_args, value) => [{ type: 'text', text: value.content }],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const uri = typeof params?.uri === 'string' ? params.uri.trim() : '';
			if (!uri) {
				throw new Error('uri 不能为空');
			}
			// ★ B 方案：外挂库（内容在别处）里的正文也要读得到 ✓（多根围栏见 store.js 的 readDoc ✓）
			//
			// ★★ 2026-10-19 修（用户报「读取知识库根目录还是错误」）：
			//   `readDoc(root(), uri)` 里**相对路径是相对「数据根」解析的**（`resolve(rootAbs, uri)`）——
			//   而数据根是 `~/.vssaros-dev/knowledge-base`，真正的库在 `<数据根>/<vaultId>/` 或外挂路径
			//   （`E:/VsSarosVault`）⇒ `库/概念/x.md` 会被解析成一个**不存在的路径** ✗
			//   （description 却承诺"vault 内相对路径"，两者不符 ✓ 真机踩到）。
			//   而且数据根下**有多个库**（`20260709063858-azbh1at` 等）⇒ 同名相对路径天然歧义。
			//   ⇒ 相对路径一律按**当前库**解析（面板上选的那个 ✓）；要读别的库显式传 vaultId。
			//   ⚠ `file:` 形态的 uri（kb_search 返回的就是）**不受影响**：它自带绝对路径 ✓。
			// ★★ 2026-10-20 修回归（真机日志：`wanted=[object Object]` ⇒ `picked=NO` ⇒ 回落到数据根 ⇒ ENOENT）：
			//   0.5.10 把 vaultWantedOf 的返回值从「字符串」改成了「{ vaultId, overriddenFrom }」，
			//   6 个写工具都跟着改了解构，**唯独这里漏了** ⇒ 对象被拿去和 `item.id` 比较，永远不相等
			//   ⇒ `picked` 永远 undefined ⇒ `baseRoot` 停在数据根 ⇒ 相对路径全部解析到
			//   `<数据根>/笔记/...`（不存在）✗。这是"读取根目录错误"的直接原因。
			const readPick = await vaultWantedOf(params, config);
			const wantedVault = readPick.vaultId;
			const isFileUri = /^file:/i.test(uri);
			const extraRoots = externalVaultRecords(config).map(item => item.dir);
			let baseRoot = root();
			if (!isFileUri) {
				const { vaults } = await listAllVaults(root(), config, { withDocs: false });
				const picked = wantedVault ? vaults.find(item => item.id === wantedVault) : undefined;
				if (picked) {
					baseRoot = picked.dir;
					// 围栏放宽到**所有库根**（否则从 A 库解析出的路径会被 B 库的 extraRoots 漏掉 ✓）
					for (const item of vaults) { if (item.dir) { extraRoots.push(item.dir); } }
				}
			}
			// ★ 2026-10-19：**读失败也要留痕**。此前只有 `kb_write_note` 写日志 ⇒
			//   `kb_read` 报 ENOENT 时完全查不到"它到底用了哪个 baseRoot"（真机就此反复卡住 ✗）。
			//   只在失败时写（正常读很频繁，全记会刷屏）；成功不记。
			const result = await readDoc(baseRoot, uri, extraRoots);
			if (result && result.error) {
				// ★ 关键字段（缺一个就没法定性）：
				//   ext  = externalVaultRecords() 返回几个库（**0 ⇒ config.kbVaults 没传进来** ⇒ listVaults 不过滤
				//          ⇒ 只剩数据根下的历史库 ⇒ picked 必然 undefined ⇒ 相对路径回落到数据根 ✗）
				//   picked = 是否命中了当前库（undefined 时 base 会是数据根）
				//   wanted = sidecar / 注入解析出来的"当前库 id"
				void logKbWrite(config, `kb_read FAIL uri=${uri} base=${baseRoot} isFileUri=${isFileUri} wanted=${wantedVault || '(空)'} ext=${extraRoots.length} picked=${baseRoot === root() ? 'NO' : 'YES'} kbVaults=${typeof config?.kbVaults === 'string' ? 'string(' + config.kbVaults.length + ')' : String(typeof config?.kbVaults)} error=${String(result.error).slice(0, 200)}`);
			}
			if (result.error) {
				// ★★ 2026-10-20：**跨库提示**（不自动跨库读 ✗）。
				//   背景：相对路径只按「当前库」解析，文件在别的库时直接 ENOENT ⇒ 用户/模型不知道
				//   是"真没有"还是"在另一个库"。
				//   ⚠ 为什么**只提示不自动读**：同名路径在不同库里是**两份不同内容**
				//     （`README` 的注释里就写着"同名相对路径会在多个库里撞车、读到错的那一份"）。
				//     自动跨库会变成"静默读了另一个知识域的内容" ✗ —— 那和 kb_search 的
				//     "换检索方式"降级性质完全不同（那是同域，这是跨域）。
				//   ⇒ 只探测 + 把候选（库 id / 名 / 绝对路径）附在错误里，让调用方显式传 vaultId。
				//   ⚠ 只在**失败**时探测（正常读零开销），且各库 stat 失败一律忽略。
				let extra = '';
				if (!isFileUri) {
					try {
						const { vaults: all } = await listAllVaults(root(), config, { withDocs: false });
						const elsewhere = [];
						for (const other of all) {
							if (other.dir === baseRoot) { continue; }          // 跳过当前库
							const abs = join(other.dir, uri);
							try {
								await stat(abs);
								elsewhere.push({ id: other.id, name: other.name ?? other.id, path: abs });
							} catch { /* 该库也没有 ⇒ 忽略 */ }
						}
						if (elsewhere.length > 0) {
							extra = `\n\n⚠ 但**其它库**里有同名路径（要读它请显式传 vaultId，不要直接改 path）：\n`
								+ elsewhere.map(item => `- vaultId=${item.id}（${item.name}）：${item.path}`).join('\n');
							void logKbWrite(config, `kb_read CROSS-VAULT uri=${uri} candidates=${elsewhere.map(i => i.id).join(',')}`);
						}
					} catch { /* 探测失败不影响原始错误 */ }
				}
				// ★★ 2026-10-20 真机（日志：`kb_search` 刚返回路径、`kb_read` 立刻 ENOENT）：
				//   **索引与磁盘不一致**时会形成"搜得到、读不到"的循环 —— 文件被移动/删除后，
				//   `mode: "index"` 的搜索结果仍带着旧路径（脏检查只在 `fulltext` 模式做 ✗）。
				//   这里补一条**可操作**的提示，让调用方知道下一步该做什么，而不是反复重试同一个路径。
				const staleHint = /ENOENT|不存在|no such file/i.test(String(result.error))
					? '\n\n⚠ 如果这篇笔记确实存在（例如刚用 kb_search 搜到它），'
						+ '那说明**索引与磁盘已不一致**（文件被移动或删除过）⇒ 调 `kb_reindex` 重建索引；'
						+ '不要反复重试同一个路径。'
					: '';
				throw new Error(`${result.error}${extra}${staleHint}`);
			}
			return result;
		},
	}, {
		name: 'kb_topic_overviews',
		description: `列出资料库各**分类目录**的摘要（\`${LIBRARY_DIR}/<分类>/${TOPIC_OVERVIEW_FILE}\` 目录摘要中间层产物）。`
			+ '用于在深入检索前先了解库内容分布：先看目录摘要，再决定用 kb_search 对哪个主题深入。'
			+ '摘要在「构建笔记」时生成，没有时这里会说明（不是错误）。',
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '限定某个 vault（留空 = 全部）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' },
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: { vaultId: { type: 'string' }, dir: { type: 'string' }, summary: { type: 'string' } },
							required: ['vaultId', 'dir', 'summary'],
						},
					},
					note: { type: 'string' },
					omitted: { type: 'integer' },
				},
				required: ['count', 'items'],
			},
			// 格式照 IDE 的 `kb_topic_overviews`：`## <目录>` + 摘要；这里额外带上 vaultId（多库时不然分不清）
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `资料库目录摘要（${value.count} 个目录）：\n\n${value.items.map(item => `## [${item.vaultId}] ${item.dir}\n${item.summary}`).join('\n\n')}${value.omitted ? `\n\n（还有 ${value.omitted} 个目录未列出）` : ''}`
					: `暂无目录摘要。${value.note ?? ''}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async params => {
			const wantedVault = typeof params?.vaultId === 'string' ? params.vaultId.trim() : '';
			if (wantedVault && !isVaultId(wantedVault)) {
				throw new Error(`vaultId 形态不合法：${wantedVault}`);
			}
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) {
				return { count: 0, items: [], note: `资料库根目录还不存在：${missing}` };
			}
			const targets = wantedVault ? vaults.filter(vault => vault.id === wantedVault) : vaults;
			if (wantedVault && !targets.length) {
				throw new Error(`找不到 vault：${wantedVault}`);
			}
			const items = [];
			let missingLibrary = 0;
			let scannedDirs = 0;
			for (const vault of targets) {
				const result = await listTopicOverviews(vault.dir);
				scannedDirs += result.scannedDirs;
				if (result.libraryMissing) {
					missingLibrary++;
				}
				for (const overview of result.overviews) {
					items.push({ vaultId: vault.id, dir: overview.dir, summary: overview.summary });
				}
			}
			// 跨库按目录名稳定排序（同输入同输出），再夹到上限
			items.sort((a, b) => a.dir.localeCompare(b.dir) || a.vaultId.localeCompare(b.vaultId));
			const picked = items.slice(0, MAX_TOPIC_OVERVIEWS);
			// 空结果的两种成因分开说：是"没有 library 区"，还是"有分类目录但都没建过摘要"
			const note = picked.length
				? undefined
				: (missingLibrary === targets.length
					? `这些 vault 里没有 library 区（期望路径 <vault>/${LIBRARY_DIR}/<分类>/${TOPIC_OVERVIEW_FILE}）。`
					: `扫了 ${scannedDirs} 个分类目录，都没有 ${TOPIC_OVERVIEW_FILE}——它在「构建笔记」时生成。`);
			return {
				count: picked.length,
				items: picked,
				...(note ? { note } : {}),
				...(items.length > picked.length ? { omitted: items.length - picked.length } : {}),
			};
		},
	}, {
		// ── 笔记区目录整理（§R.7 第 ④ 项的**最后一项**；真源 IDE `kbOrganizeTools.ts` ✓）────────────
		// 语义照搬 ✓：只在 **`笔记/` 区内**动（资料库正文 `库/` 不许碰 ✓）；顺序 creates → moves →
		// deletes(移入备份) ✓；单次上限 `MAX_OPS` ✓；`from===to` / `from 不存在` / **`to` 已存在**（不覆盖 ✓）
		// ⇒ 逐项拒并如实列进 `skipped` ✓；备份落在 **vault 之外** ✓（vault 文件树会把 vault 内的一切列出来，
		// 备份放里面就成了"知识库内容" ✗）。
		// ⚠ **与 IDE 的差异（写进描述，不藏）** ✗：IDE 版还替每个文件写聊天页签 checkpoint（可 `undoAll` ✓），
		//   dsh 侧**没有**那套会话回滚 ⇒ 我们的还原点**只有备份目录** ✓ —— 这也正是"备份失败就不搬"的理由 ✓
		//   （没有还原点就不动手 ✓）。
		name: 'kb_organize',
		description: [
			'整理知识库**「笔记」区**的目录结构（**只能在 `笔记/` 区内操作** ✓，资料库正文区动不了 ✓）：',
			'- `creates`：新建目录（自动建父目录 ✓）；',
			'- `moves`：移动/重命名笔记（改目录名 = 对目录下每个文件各写一条 ✓）—— 目标已存在会**拒该项、不覆盖** ✓；',
			// 2026-10-14（§16.20）：`copies` 的规则与 `moves` **相反**（撞名改名而不是拒 ✗）—— 描述里必须说清，
			// 否则模型会以为它也会"拒"，从而自己拼增量名（拼错就是覆盖或撞名失败 ✓）。
			'- `copies`：复制笔记／目录（源**保持不动** ✓）—— 目标已存在时**不拒**，而是自动改增量名 `甲 copy.md` / `甲 copy 2.md` ✓（照真源 Ctrl 拖拽的命名 ✓）；复制不写备份（源没被动 ✓）；',
			'- `deletes`：**不是真删除** —— 移入 **vault 之外**的备份目录（可恢复 ✓）。',
			`一次最多 ${MAX_OPS} 项；路径给相对 vault 根（形如 \`笔记/01_学习/…\`）或绝对路径均可 ✓。`,
			'⚠ 结果里含一行 `KB_ORGANIZE_RESULT {json}`（含 `backupDir` ✓）；**还原只能靠那个备份目录**（dsh 侧没有聊天页签的 undoAll ✗）⇒ 被拒绝的项（`skipped`）要么改参数重试、要么别硬凑 ✓。',
			// 2026-10-12（报告 R.8.4）：dsh 原生 fs 工具**写**受沙箱围栏（`workspace-write` ＝ 会话工作区 ＋ 平台 temp），
			// 而 vault 与数据根都在围栏**外** ⇒ 模型若改用原生 `write`/`edit` 动笔记，会拿到 `FS_SANDBOX_DENIED` ✗。
			// 这句写进描述就是为了让模型**别绕**（它看不到我们这份文档，只看得到描述 ✓）。
			'⚠ **改知识库（vault）里的笔记请走本工具** ✗：dsh 原生 `write` / `edit` 受沙箱围栏限制（只允许**会话工作区**内与平台临时目录），vault 与数据根都在围栏外 ⇒ 用原生工具会吃 `FS_SANDBOX_DENIED`；同理，动别处路径也只该用对应的 VsSaros 工具 ✓。',
			'⚠ 会改盘 ⇒ 需要用户在审批里确认 ✓（被拒绝是正常的，别反复重试 ✗）。',
			'⚠ 另外会**顺带刷新导航文件** `笔记/index.md` 与 `笔记/overview.md`（与 IDE 同一套规则 ⇒ 两侧视图看到的目录一致 ✓）；`insights.md` **也由我们维护** ✓；只有各目录 `.overview.md`（目录摘要中间层，要模型）不在 dsh 侧 ⇒ 要它最新请在 IDE 侧刷一次 ✓。',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '整理哪个 vault（缺省 = 库里只有一个 vault 时用它）' },
				reason: { type: 'string', description: '本次整理的动机（写进结果，便于回看为什么这么挪）' },
				moves: {
					type: 'array',
					description: '移动/重命名',
					items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
				},
				creates: { type: 'array', items: { type: 'string' }, description: '新建的目录（相对 vault 根）' },
				copies: {
					type: 'array',
					description: '复制（源保持不动；目标已存在时自动改成「xxx copy.md」而不是拒绝）',
					items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
				},
				deletes: { type: 'array', items: { type: 'string' }, description: '要「删除」的笔记（实际移入备份目录，不是真删）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					vault: { type: 'string' },
					reason: { type: 'string' },
					moved: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
					copied: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
					created: { type: 'array', items: { type: 'string' } },
					deletedToBackup: { type: 'array', items: { type: 'string' } },
					skipped: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, why: { type: 'string' } }, required: ['item', 'why'] } },
					backupDir: { type: 'string' },
					message: { type: 'string' },
				},
				required: ['ok', 'message'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value.message ?? '') }],
		},
		execute: async params => {
			// 显式 vaultId → **当前库**（config.kbActiveVaultId，与页面渲染同一口径 ✓）
		const vaultPick = await vaultWantedOf(params, config);
		const wanted = vaultPick.vaultId;
			if (wanted && !isVaultId(wanted)) { throw new Error(`vaultId 形态不合法：${wanted}`); }
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) { throw new Error(`资料库根目录还不存在：${missing}`); }
			const targets = wanted ? vaults.filter(vault => vault.id === wanted) : vaults;
			if (wanted && !targets.length) { throw new Error(`找不到 vault：${wanted}`); }
			if (targets.length !== 1) {
				// 与 kb_feishu_sync 同口径 ✓：含混挑一个比报错更坏 ✗（整理错了要用户自己从备份捞回来 ✓）
				throw new Error(`请指明要整理哪个 vault（现在有 ${targets.length} 个）：${vaults.map(v => v.id).join(', ')}`);
			}
			const moves = Array.isArray(params?.moves) ? params.moves : [];
			const creates = Array.isArray(params?.creates) ? params.creates : [];
			const copies = Array.isArray(params?.copies) ? params.copies : [];
			const deletes = Array.isArray(params?.deletes) ? params.deletes : [];
			const reason = typeof params?.reason === 'string' ? params.reason : '';
			const plan = planCounts({ moves, creates, copies, deletes });
			// 空操作 / 超上限：**不动盘**，如实回报 ✓（照真源：这两条都不是"错误" ✓，是"这活儿没法干" ✓）
			if (plan.empty) {
				return { ok: true, vault: targets[0].id, reason, message: 'kb_organize：没有任何操作项（moves/creates/copies/deletes 全空）⇒ **没改任何东西** ✓。' };
			}
			if (plan.tooMany) {
				return { ok: false, vault: targets[0].id, reason, message: `kb_organize：一次最多 ${MAX_OPS} 项（本次 ${plan.total} 项）⇒ **一项都没执行** ✓，请分批。` };
			}
			// ★ 跨进程写锁（README 5.114）：整理是"**多步** rename/copy ＋ 备份"的复合写操作 ✗ ⇒
			// 与另一个 dsh 写者并发会交错（A 读到旧的目录状态、B 同时搬同一批文件 ⇒ 备份与结果对不上 ✓）。
			// 锁目标是**这个 vault**（操作级 ✓）：`lockFileFor(vaultRoot)` ⇒ 兄弟文件 `<vault>.lock` ✓，
			// 与 workflow / kanban / IDE 同一套协议 ✓（`targets[0].dir` 来自扫描结果、不是原始输入 ⇒ 安全 ✓）。
			// ⚠ 如实记边界 ✗：**IDE 侧的整理器不加锁**（`agentStudio/**` 里查不到 knowledge 的锁用法 ✓）
			// ⇒ 这把锁只能与"另一个 dsh 写者"互斥 ✓，**挡不住 IDE 同时整理** ✗（要彻底互斥得 IDE 侧也上锁 ✓）。
			const release = await acquireFileLock(lockFileFor(targets[0].dir), { label: '知识库整理' });
			let result;
			let nav;
			try {
				result = await runOrganize({ vaultRoot: targets[0].dir, moves, creates, copies, deletes });
				// 整理会挪/删笔记 ⇒ 导航必须跟着刷（真源在整理之后也是立刻 `maintainKbNavigation` ✓）
				nav = await refreshDerived(targets[0].dir, config);
			} finally {
				await release();
			}
			const summary = {
				reason,
				moved: result.moved,
				// ★ 复制用的是**实际落点**（撞名会自动改成 `xxx copy.md` ✓）⇒ 回执里给的必须是 `to` 的真值，
				//   不是调用方传进来的那个名字 ✗（否则调用方以为复制到了它要求的位置 ✓）。
				copied: result.copied,
				created: result.created,
				deletedToBackup: result.deletedToBackup,
				skipped: result.skipped,
				backupDir: result.backupDir,
			};
			return {
				ok: true,
				vault: targets[0].id,
				// ★ 库被纠正过（方案 A：当前库优先）⇒ 必须说，否则模型以为写进了它指定的库 ✗
				...(vaultPick.overriddenFrom ? { overriddenFrom: vaultPick.overriddenFrom } : {}),
				reason,
				...summary,
				...(nav && !nav.error ? { navigation: nav } : {}),
				message: [
					`kb_organize 完成：移动 ${result.moved.length} 项 / 复制 ${result.copied.length} 项 / 新建目录 ${result.created.length} 个 / 「删除」（移入备份）${result.deletedToBackup.length} 项 / 跳过 ${result.skipped.length} 项`,
					// 只在"落点名 ≠ 源名"（＝撞名自动加了 copy ✓）时多报一行 ⇒ 不撞名时不啰嗦 ✓
					...result.copied.filter(item => item.to.replace(/^.*\//, '') !== item.from.replace(/^.*\//, ''))
						.slice(0, 6).map(item => `复制落点：${item.from} → ${item.to}（撞名 ⇒ 自动加 copy ✓）`),
					result.backupUsed ? `备份目录（**还原用**）：${result.backupDir}` : '（本次没有任何"移动/删除" ⇒ 没建备份目录）',
					...result.skipped.slice(0, 6).map(s => `跳过：${s.item}（${s.why}）`),
					navLine(nav),
					`KB_ORGANIZE_RESULT ${JSON.stringify(summary)}`,
				].filter(Boolean).join('\n'),
			};
		},
	}, {
		// ── 构建预览（2026-10-12，方案 §4.4「第 3 期」的**只读那半边**）────────────────────────────
		// ★ 为什么只做 preview：`build` 的实质是**编排**（IDE 侧是"在「知识库专家」agent 里新建一个聊天
		//   会话，让 agent 自己读素材、写笔记，随后补链/门控/导航"，见 `kbBuildTools.ts` 文件头 ✓）——
		//   dsh 侧要做应换成 dsh 自己的原语（`subagent` + `kb_write_note`），那是**产品设计**而不是搬运 ✓。
		//   ⇒ 传 `mode:'build'` **明确报错并指路**（绝不静默降级成 preview ✗ —— 那会让调用方以为活儿干了 ✓）。
		// 口径真源 = IDE 的 `collectPendingSources`（本模块 `core/kbIngest.js` / `store.js::previewBuild` ✓）：
		//   跳过导航文件、跳过已知产出的笔记、**素材改过会重新计入** ✓。同名工具，登记在
		//   `common/toolOwnership.ts`（两侧共享同一个构建缓存 ⇒ 预览结果必须一致 ✓）。
		name: 'kb_build',
		description: [
			'看知识库「库」里**还有哪些素材没建成笔记**（把素材归纳进「笔记」区的那件事）。',
			'`mode:"preview"`（**缺省**，只读）：列出待构建素材与**拒因**（未构建 / 笔记不存在 / 素材被改过），不启动任何会话 ——',
			'在问用户"要不要构建"之前先用它拿到准确数量与清单 ✓。',
			'`mode:"build"`（真构建，**要用户批准**）：起一个子代理读这些素材、用 `kb_write_note` 把笔记写进「笔记」区，并在收尾时创建/完善 `笔记/知识体系.md` ✓。',
			'⚠ 它**立即返回** jobId（构建是分钟级后台任务）⇒ 进度/结果用 `job_output`（`wait:true` 会等它跑完）、`job_list`、`job_kill` ✓；',
			'⚠ 前置：组合里要有 `jobs` 与 `subagents` 服务（缺了会明确报错并指路 IDE 侧 ✓）；⚠ 子代理**没有自己的审批通道** （平台把它钉成 approvalPolicy=never）⇒ 批准这张卡时会同时开一份**有界批授权**，否则它一篇都写不出来 ✓；',
			'⚠ 跑完之后**宿主会刷新** `笔记/index.md` 与 `笔记/overview.md`（与 IDE 同一套规则 ✓）；`insights.md` **也由我们维护** ✓；只有各目录 `.overview.md`（要模型）不在 dsh 侧 ✓。',
			'⚠ 构建收尾会把本批**确实产出**的笔记登记进共享的 `.kb-build-cache.json`（**只增不删** ✓，与 IDE 同一份格式与口径 ✓）⇒ 下一次 preview 不会重复计数 ✓；⚠ 三处如实边界：① 本侧**只统计 `.md` 素材**（pdf/docx 等非 md 素材需要 IDE 侧先转成文本，那条原生转换链 dsh 侧没有 ✗）；',
			'② 待构建判据与 IDE 的「批量构建」**同一套**（含"素材改了会重新计入"✓），但**不含**导航文件与构建产出笔记 ✓。',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '看哪个 vault（缺省 = 库里只有一个 vault 时用它）' },
				mode: { type: 'string', enum: ['preview', 'build'], description: 'preview（缺省，只读）；build = 起子代理构建（需要 jobs + subagents 服务与你的批准）' },
				batch: { type: 'integer', description: `本批最多构建多少份（1–${DEFAULT_BATCH_LIMIT}，缺省 ${DEFAULT_BATCH_LIMIT}；照真源上限 ✓）` },
				provider: { type: 'string', description: `用哪个 subagent provider（缺省 ${DEFAULT_SUBAGENT_PROVIDER}；装在插件 config 里可换 ✓）` },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					vault: { type: 'string' },
					mode: { type: 'string' },
					pendingCount: { type: 'integer' },
					pending: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
					scanned: { type: 'integer' },
					skippedFresh: { type: 'integer' },
					skippedOutputs: { type: 'integer' },
					noteMissing: { type: 'integer' },
					sourceNewer: { type: 'integer' },
					libMissing: { type: 'boolean' },
					truncated: { type: 'boolean' },
					cacheNote: { type: 'string' },
					message: { type: 'string' },
				},
				required: ['ok', 'mode'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value.message ?? '') }],
		},
		isConcurrencySafe: () => true,
		// ⚠ 需要第二个参数 `exec`（官方 `ToolExecutionInput` ✓）：`build` 模式要用它的
		// `agent`（= jobs 的 owner ＋ 子代理的 parent）与 `signal`（取消）✓。
		execute: async (params, exec) => {
			// 显式 vaultId → **当前库**（config.kbActiveVaultId，与页面渲染同一口径 ✓）
		const vaultPick = await vaultWantedOf(params, config);
		const wanted = vaultPick.vaultId;
			if (wanted && !isVaultId(wanted)) { throw new Error(`vaultId 形态不合法：${wanted}`); }
			// 未知的 mode 一律**明确报错**（照 kb_search 的 `semantic` 口径 ✓）：静默降级最坏 ✓
			const mode = params?.mode === undefined || params?.mode === '' ? 'preview' : String(params.mode).trim();
			if (mode !== 'preview' && mode !== 'build') {
				throw new Error(`未知的 mode：${mode}（本侧支持 preview / build）`);
			}
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) { throw new Error(`资料库根目录还不存在：${missing}`); }
			const targets = wanted ? vaults.filter(vault => vault.id === wanted) : vaults;
			if (wanted && !targets.length) { throw new Error(`找不到 vault：${wanted}`); }
			if (targets.length !== 1) {
				// 与 kb_organize / kb_write_note 同口径 ✓：含混挑一个比报错更坏 ✗
				throw new Error(`请指明要看哪个 vault（现在有 ${targets.length} 个）：${vaults.map(v => v.id).join(', ')}`);
			}
			const vault = targets[0];
			// ★ P2 staging（2026-10-14，§16.12）：「非文本素材 → 同名 .md」必须在**枚举之前** ✓
			//   （真源 `collectPendingSources` 的第一步就是 `stageDocSourcesToText` ✓，`kbVaultFs.ts:103` ✓）。
			//   ⚠ 这一步是**写**（往 库/ 落 .md ＋ assets/ 图片 ✓）⇒ 拿 vault 锁 ✓；
			//     `config.stageDocSources === false` 可整体关掉（可回退 ✓，与 maintainNavigation/autoReindex 同一手法 ✓）。
			//   ⚠ preview 也照做 ✓：真源的两条批量路径共用 collectPendingSources ⇒ "预览"同样会先落 .md ✓
			//     （这不是我们加的行为，是真源本来的顺序 ✓ —— 如实记 ✓）。
			let staged;
			if (config?.stageDocSources !== false) {
				const releaseStage = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库素材转文本' });
				try {
					staged = await stageDocSourcesToText(join(vault.dir, LIBRARY_DIR), { python: resolvePythonPath(config) });
				} finally {
					await releaseStage();
				}
			}
			const result = await previewBuild(vault.dir);
			if (mode === 'build') {
				// ⚠ `batchGrantEnabled` 是 `apply()` 的局部量 ⇒ **工具闭包里看不到它** ✗（第一版就这么写的，
				// 当场被 p3-08 报"batchGrantEnabled is not defined" ✓）⇒ 这里从 `config` 重新判一次 ✓
				// （两处判据同一行代码 ⇒ 不会漂；真要抽就抽成一个纯函数，但目前只有这一处比较 ✓）。
				return startBuildJob({ ctx, state, config, vault, pending: result.pending, params, exec, batchGrantEnabled: config?.batchGrant !== false });
			}
			const listed = result.pending.slice(0, MAX_PREVIEW_LISTED).map(item => ({
				path: item.path,   // 绝对路径（页面/工具两侧口径一致 ✓）
				reason: item.reason,
			}));
			const head = result.pending.length
				? `待构建素材 ${result.pending.length} 份（已扫 ${result.scanned} 个 .md；跳过：已构建 ${result.counts.skippedFresh} / 构建产出 ${result.counts.skippedOutputs}）：`
				: `没有待构建素材（已扫 ${result.scanned} 个 .md；跳过：已构建 ${result.counts.skippedFresh} / 构建产出 ${result.counts.skippedOutputs}）✓`;
			const lines = listed.map((item, index) => `${index + 1}. ${item.path}（${item.reason}）`);
			const notes = [];
			if (result.pending.length > listed.length) { notes.push(`…（共 ${result.pending.length} 份，此处只列前 ${listed.length} 份）`); }
			if (result.libMissing) { notes.push(`该 vault 还没有「库」区（${result.libDir}）—— 先用 IDE 侧导入素材 ✓。`); }
			if (result.truncated) { notes.push(`扫描在 ${result.scanned} 个 .md 处截断 ⇒ 待构建数量可能被低估 ✗。`); }
			// ★ P2 staging 的结果**如实带出** ✓（真源是通知 ✓；我们是工具回执 ⇒ 进 notes ✓ —— 不许静默 ✗）
			if (staged && staged.sources > 0) {
				notes.push(`素材转文本：${staged.sources} 个 ⇒ 新转 ${staged.converted} / 已最新跳过 ${staged.skippedFresh}`
					+ (staged.noText.length ? ` / 无文字层 ${staged.noText.length}（疑似扫描件，需 OCR ✓）` : '')
					+ (staged.failed.length ? ` / 失败 ${staged.failed.length}：${staged.failed.slice(0, 3).join('；')}` : ''));
			}
			if (result.cacheNote) { notes.push(`⚠ ${result.cacheNote}。`); }
			// ★ P1：把'上次构建收尾登记了什么'说出来 ✓（我们要开始写这份共享缓存了 ⇒ 不能只说'读了什么' ✗）
			if (state.lastBuildCache) { notes.push(lastBuildCacheNote(state.lastBuildCache)); }
			// 派生维护（导航三件 / 门控 / 补链）若失败，同样要能看见 ✓（见收尾处那三段注释 ✓）
			if (state.lastDerivedError) { notes.push(`⚠ 上次构建收尾的**派生维护**（导航/门控/补链）失败：${state.lastDerivedError}`); }
			// ★ 上次构建收尾的**自动思维导图**（§16.17）也如实说 ✓（成功给 jobId、失败给原因；关掉时不出现 ✓）
			if (state.lastMindmap?.error) { notes.push(`⚠ 上次构建收尾的**自动生成思维导图**失败：${state.lastMindmap.error}`); }
			else if (state.lastMindmap?.jobId) { notes.push(`上次构建收尾**自动起了**思维导图生成任务（jobId=${state.lastMindmap.jobId}）⇒ 用 job_output 看它 ✓。`); }
			if (result.pending.length) { notes.push('⚠ 本侧只统计 `.md`；pdf/docx 等素材需 IDE 侧先转文本。真构建用 mode="build"（要批准；前置是组合里有 jobs + subagents ✓）。'); }
			return {
				ok: true,
				vault: vault.id,
				// ★ 库被纠正过（方案 A：当前库优先）⇒ 必须说（与其它写工具同口径）
				...(vaultPick.overriddenFrom ? { overriddenFrom: vaultPick.overriddenFrom } : {}),
				mode: 'preview',
				pendingCount: result.pending.length,
				pending: listed,
				scanned: result.scanned,
				skippedFresh: result.counts.skippedFresh,
				skippedOutputs: result.counts.skippedOutputs,
				noteMissing: result.counts.noteMissing,
				sourceNewer: result.counts.sourceNewer,
				...(result.libMissing ? { libMissing: true } : {}),
				...(result.truncated ? { truncated: true } : {}),
				...(result.cacheNote ? { cacheNote: result.cacheNote } : {}),
				message: [head, ...lines, ...notes].join('\n'),
			};
		},
	}, {
		// ── 写正文（2026-10-12，方案 doc/dsh-kb-port-design.html §4.3「第 2 期」）──────────────────
		// ★ 为什么需要它：dsh 原生 `write` / `edit` 受沙箱围栏（`workspace-write` = 会话工作区 ＋ 平台 temp，
		//   报告 R.8 的实测结论 ✓），而 vault 与数据根都在围栏**外** ⇒ 模型**没有任何办法**改知识库里的笔记 ✗
		//   （页面只读、原生写工具吃 `FS_SANDBOX_DENIED`）。这不是"移植"（IDE 侧也**没有**这个工具 ✓，
		//   那边走编辑器 UI / 构建流程 ✓）—— 是给 dsh 会话补一条**可控的**写路径 ✓。
		// 安全规则**沿用 `organize.js` 的同三条**（同一份 `resolveOrganizePath` / 同一套 vault 外备份 ✓）：
		//   围栏 `笔记/` 之外一律拒 ✓、缺省**不覆盖** ✓、覆盖前先把旧正文移入备份（dsh 侧唯一还原点 ✓）。
		name: 'kb_write_note',
		description: [
			'把**一篇笔记的正文**写进知识库的「笔记」区（`<vault>/笔记/…` ✓；资料库正文区 `库/` 动不了 ✓）。',
			'缺省 `mode: "create"` ⇒ **目标已存在就拒绝**（绝不静默覆盖 ✓）；确实要覆盖时显式传 `mode: "replace"` ⇒',
			'旧正文会**先**被复制进 vault 之外的备份目录（结果里给 `backupDir`，**还原只靠它** ✓）。',
			'`path` 给相对 vault 根（形如 `笔记/主题/标题.md` ✓）或绝对路径均可 ✓，**父目录会自动创建** ✓。',
			// ★★ 2026-10-20 真机（用户报「为什么笔记存到 讲懂 文件夹下」）：模型把**任务类型**
			//   （「讲懂」）当成了分类，自建 `笔记/讲懂/` 这种孤儿目录，而库里的既有分类是
			//   `01_学习` / `02_工作` / `03_生活` / `技术架构` 这类**领域**划分 ✗。
			//   根因：`path` 完全自由 + 描述里没有任何"该放哪"的引导 ⇒ 模型只能自己发明规则。
			//   ⇒ 把口径写进描述（模型每次写都会读到），并明确"不确定就落 笔记/ 根、别新建目录"。
			'⚠ **存放位置有规矩**：先看**既有分类**（**调 `kb_catalog`** 拿目录地图：路径 + 篇数），'
				+ '把笔记放进**领域分类**（如 `笔记/01_学习/AI_Agent/`、`笔记/技术架构/`）。'
				+ '**不要**用**任务类型**命名目录 —— `讲懂/`、`分析/`、`摘要/`、`问答/` 这类都是错的'
				+ '（同一篇笔记会因为换个任务被存成好几份）。'
				// ★ 2026-10-20（用户口径）：**不确定就问用户，不要自己挑、更不要新建目录**。
				+ '**不确定放哪就询问用户**（列出 `笔记/` 下现有目录供其选择）—— '
				+ '宁可多问一句，也不要留下一个孤儿目录。',
			`⚠ 单篇上限 ${MAX_NOTE_CHARS} 字；⚠ 空内容允许（= 建一篇空笔记），但**空内容也是一次写入** ⇒ 同样要过审批 ✓。`,
			'⚠ **改知识库（vault）里的笔记请走本工具** ✗：dsh 原生 `write` / `edit` 只允许会话工作区内与平台临时目录，vault 在围栏外 ⇒ 用原生工具会吃 `FS_SANDBOX_DENIED` ✓。',
			'⚠ 会改盘 ⇒ 需要用户在审批里确认 ✓（被拒绝是正常的，别反复重试 ✗）。',
			'⚠ 另外会**顺带刷新导航文件** `笔记/index.md` 与 `笔记/overview.md`（与 IDE 同一套规则 ⇒ 两侧视图看到的目录一致 ✓）；`insights.md` **也由我们维护** ✓；只有各目录 `.overview.md`（目录摘要中间层，要模型）不在 dsh 侧 ⇒ 要它最新请在 IDE 侧刷一次 ✓。',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '写哪个 vault（缺省 = 库里只有一个 vault 时用它）' },
				path: { type: 'string', description: '笔记路径（相对 vault 根，形如 笔记/主题/标题.md）' },
				content: { type: 'string', description: '正文（markdown；空字符串 = 建空笔记）' },
				mode: { type: 'string', enum: ['create', 'replace'], description: "create（缺省）= 已存在则拒绝；replace = 覆盖前先把旧正文移入备份" },
			},
			required: ['path', 'content'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					vault: { type: 'string' },
					path: { type: 'string' },
					created: { type: 'boolean' },
					mode: { type: 'string' },
					bytes: { type: 'integer' },
					backupDir: { type: 'string' },
					message: { type: 'string' },
				},
				required: ['ok', 'message'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value.message ?? '') }],
		},
		execute: async params => {
			// 显式 vaultId → **当前库**（config.kbActiveVaultId，与页面渲染同一口径 ✓）
		const vaultPick = await vaultWantedOf(params, config);
		const wanted = vaultPick.vaultId;
			if (wanted && !isVaultId(wanted)) { throw new Error(`vaultId 形态不合法：${wanted}`); }
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) { throw new Error(`资料库根目录还不存在：${missing}`); }
			const targets = wanted ? vaults.filter(vault => vault.id === wanted) : vaults;
			if (wanted && !targets.length) { throw new Error(`找不到 vault：${wanted}`); }
			if (targets.length !== 1) {
				// 与 kb_organize / kb_feishu_sync 同口径 ✓：**含混挑一个比报错更坏** ✗（写进了别的库最难查 ✓）
				throw new Error(`请指明要写哪个 vault（现在有 ${targets.length} 个）：${vaults.map(v => v.id).join(', ')}`);
			}
			const mode = params?.mode === 'replace' ? 'replace' : 'create';
			// ★★ 2026-10-19（用户报「模型写笔记没落到我当前在看的目录」）：
			//   模型不知道用户在页面上的「当前目录」⇒ 路径落在**笔记区根**时就按它兜底。
			//   规则与边界见 core/kbActiveDir.js 文件头（只在"模型没给子目录"时改写，给了就不动 ✓）。
			const activeDir = await readActiveDir({ readFile }, kbRootOf(config), targets[0].id);
			const redirect = applyActiveDir(params?.path, activeDir);
			const release = await acquireFileLock(lockFileFor(targets[0].dir), { label: '知识库写笔记' });
			let result;
			let nav;
			try {
				result = await writeNote({ vaultRoot: targets[0].dir, relPath: redirect.relPath, content: params?.content, mode });
				// ★ 写完刷导航（`笔记/index.md` / `笔记/overview.md`）—— 与真源同一批动作之后刷 ✓
				//（真源：构建/整理完后 `maintainKbNavigation` ✓；本仓最接近的挂点就是这里与构建任务 ✓）。
				//   放在**同一把 vault 锁之内**：导航也是往 `笔记/` 里写 ⇒ 不能与别的写者交错 ✓。
				if (result.ok) { nav = await refreshDerived(targets[0].dir, config, [result.path]); }
			} finally {
				await release();
			}
			// ★ 落盘留痕（见 logKbWrite 的注释）：请求的 vault / 实际用的 vault / 最终路径 / 是否被纠正
			void logKbWrite(config, `kb_write_note requested=${params?.vaultId ?? '(未给)'} used=${targets[0].id} dir=${targets[0].dir} relPath=${result.ok ? result.path : redirect.relPath} overriddenFrom=${vaultPick.overriddenFrom ?? '-'} ok=${result.ok}`);
			if (!result.ok) {
				// 拒因**原样带出**（含"要覆盖就传 replace"这类下一步指引 ✓）—— 不吞成一句"失败" ✗
				return { ok: false, vault: targets[0].id, message: `kb_write_note 未写入：${result.error}` };
			}
			return {
				ok: true,
				vault: targets[0].id,
				// ★ 库被纠正过（方案 A：当前库优先）⇒ 必须说，否则模型以为写进了它指定的库 ✗
				...(vaultPick.overriddenFrom ? { overriddenFrom: vaultPick.overriddenFrom } : {}),
				path: result.path,
				created: result.created,
				mode: result.mode,
				bytes: result.bytes,
				// ★ 落点被「当前目录」调整过 ⇒ **必须告诉模型**（否则它以为是 `笔记/xxx.md`，
				//   下次还按旧路径找，会"找不到刚写的笔记" ✗）。也放进工具结果，用户看回执能懂 ✓。
				...(redirect.redirected ? { redirectedFrom: redirect.from, activeDir } : {}),
				// ★ 库被纠正过（方案 A：当前库优先）⇒ **同样必须说**（否则模型以为写进了它指定的库，
				//   下次还去那边找 ✗）。用户看回执也能懂"为什么笔记不在我以为的地方" ✓。
				...(result.backupDir ? { backupDir: result.backupDir } : {}),
				...(nav && !nav.error ? { navigation: nav } : {}),
				message: [
					`kb_write_note：${result.created ? '新建' : '覆盖'} ${result.path}（${result.bytes} 字节）`,
					result.backupUsed ? `旧正文已移入备份（**还原用**）：${result.backupDir}` : '',
					navLine(nav),
				].filter(Boolean).join('\n'),
			};
		},
	}, {
		// 建目录：与 `kb_write_note` 同族（同一围栏 ✓）；单独一个工具是因为**目录重名不是错误**（`mkdir -p` 幂等 ✓）——
		// 混进写笔记会让"该不该报错"变得含混 ✓。
		name: 'kb_mkdir',
		description: [
			'在知识库「笔记」区建目录（递归建父目录 ✓；**目录已存在不算错** ✓）。',
			'`path` 给相对 vault 根（形如 `笔记/主题` ✓）或绝对路径均可 ✓；`笔记/` 之外一律拒绝 ✓。',
			'⚠ 会改盘 ⇒ 需要用户在审批里确认 ✓；⚠ 与写笔记同理：别用 dsh 原生工具去建 vault 里的目录（沙箱围栏外侧会吃 `FS_SANDBOX_DENIED` ✓）。',
			'⚠ 另外会**顺带刷新导航文件** `笔记/index.md` 与 `笔记/overview.md`（与 IDE 同一套规则 ⇒ 两侧视图看到的目录一致 ✓）；`insights.md` **也由我们维护** ✓；只有各目录 `.overview.md`（目录摘要中间层，要模型）不在 dsh 侧 ⇒ 要它最新请在 IDE 侧刷一次 ✓。',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '哪个 vault（缺省 = 库里只有一个 vault 时用它）' },
				path: { type: 'string', description: '目录路径（相对 vault 根，形如 笔记/主题）' },
			},
			required: ['path'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, vault: { type: 'string' }, path: { type: 'string' },
					created: { type: 'boolean' }, message: { type: 'string' },
				},
				required: ['ok', 'message'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value.message ?? '') }],
		},
		execute: async params => {
			// 显式 vaultId → **当前库**（config.kbActiveVaultId，与页面渲染同一口径 ✓）
		const vaultPick = await vaultWantedOf(params, config);
		const wanted = vaultPick.vaultId;
			if (wanted && !isVaultId(wanted)) { throw new Error(`vaultId 形态不合法：${wanted}`); }
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) { throw new Error(`资料库根目录还不存在：${missing}`); }
			const targets = wanted ? vaults.filter(vault => vault.id === wanted) : vaults;
			if (wanted && !targets.length) { throw new Error(`找不到 vault：${wanted}`); }
			if (targets.length !== 1) {
				throw new Error(`请指明要在哪个 vault 建目录（现在有 ${targets.length} 个）：${vaults.map(v => v.id).join(', ')}`);
			}
			const release = await acquireFileLock(lockFileFor(targets[0].dir), { label: '知识库建目录' });
			let result;
			let nav;
			try {
				result = await makeDir({ vaultRoot: targets[0].dir, relPath: params?.path });
				// 建目录本身不动笔记，但**新目录可能让导航的层级变化**（`主题` 从无到有 ✓）⇒ 照真源一并刷 ✓
				if (result.ok) { nav = await refreshDerived(targets[0].dir, config, [result.path]); }
			} finally {
				await release();
			}
			if (!result.ok) {
				return { ok: false, vault: targets[0].id, message: `kb_mkdir 未建目录：${result.error}` };
			}
			const navText = navLine(nav);
			return {
				ok: true, vault: targets[0].id, path: result.path, created: result.created,
				// ★ 库被纠正过（方案 A：当前库优先）⇒ 必须说（与其它写工具同口径）
				...(vaultPick.overriddenFrom ? { overriddenFrom: vaultPick.overriddenFrom } : {}),
				...(nav && !nav.error ? { navigation: nav } : {}),
				message: [
					`kb_mkdir：${result.created ? '新建' : '已存在（未改动）'} ${result.path}`,
					navText,
				].filter(Boolean).join('\n'),
			};
		},
	}, {
		// ── 思维导图（2026-10-14，P4 §16.14）────────────────────────────────────────────────
		// 两个 mode：**merge 是纯确定性**（合并多个 .canvas ⇒ 宿主直接写 ✓）；
		// **generate 起子代理**（只读笔记 ＋ 回 JSON ✓ ⇒ 子代理**不需要写授权** ✓ —— 比 kb_build 干净：
		// 那张卡就是唯一的一张 ✓），回文经真源同款清洗解析后由**宿主**合并/排版/落盘 ✓
		// （确定性半与真源**逐字节一致** ✓ —— 黄金表 p3-83 ✓）。
		name: 'kb_mindmap',
		description: [
			'思维导图（JSON Canvas，`.canvas`）。`mode:"merge"`：把「笔记」区里多个 .canvas 合并成一个（按内容去重 ＋ 重新排版 ⇒ 写回第一个、删掉其余 ✓；files 不给就合并全部）。',
			'`mode:"generate"`：起一个**只读**子代理读最近改动的笔记、产出结构化图谱 JSON，宿主把它**合并进**已有思维导图（没有就新建，名字从内容推导 ✓）——与 IDE 的「自动生成思维导图」同一套提示词与排版 ✓。',
			'⚠ generate 立即返回 jobId（后台任务 ⇒ 进度用 job_output / job_list ✓）；前置：组合里有 jobs + subagents ✓；子代理只读、不写盘 ⇒ **一张审批卡就够**（没有批授权那套 ✓）。',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '哪个 vault（缺省 = 只有一个时用它）' },
				mode: { type: 'string', enum: ['merge', 'generate', 'refine', 'rename'], description: 'merge = 合并多个 .canvas；generate = 从最近笔记生成（起子代理）；refine = 让子代理完善已有导图（保留原 id）；rename = 按内容重命名（有模型时用它的建议、没有就用推导名 ✓）' },
				files: { type: 'array', items: { type: 'string' }, description: '（merge）要合并的 .canvas 文件名（相对 笔记/，如 主题.canvas）；不给 = 全部' },
				count: { type: 'integer', description: '（generate）取最近改动的几篇笔记（1–20，缺省 5）' },
				file: { type: 'string', description: '（refine / rename）目标 .canvas 文件名（相对 笔记/）；不给 = mindmap.canvas 或第一个' },
				provider: { type: 'string', description: '（generate / refine / rename）subagent provider（缺省 fork ✓）' },
			},
			required: ['mode'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, vault: { type: 'string' }, mode: { type: 'string' },
					path: { type: 'string' }, nodes: { type: 'integer' }, edges: { type: 'integer' },
					jobId: { type: 'string' }, message: { type: 'string' },
				},
				required: ['ok', 'message'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value.message ?? '') }],
		},
		execute: async (params, exec) => {
			// 显式 vaultId → **当前库**（config.kbActiveVaultId，与页面渲染同一口径 ✓）
		const vaultPick = await vaultWantedOf(params, config);
		const wanted = vaultPick.vaultId;
			if (wanted && !isVaultId(wanted)) { throw new Error(`vaultId 形态不合法：${wanted}`); }
			const mode = String(params?.mode ?? '').trim();
			if (!['merge', 'generate', 'refine', 'rename'].includes(mode)) { throw new Error(`未知的 mode：${mode}（本侧支持 merge / generate / refine / rename）`); }
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) { throw new Error(`资料库根目录还不存在：${missing}`); }
			const targets = wanted ? vaults.filter(vault => vault.id === wanted) : vaults;
			if (targets.length !== 1) {
				throw new Error(`请指明要在哪个 vault 操作（现在有 ${targets.length} 个）：${vaults.map(v => v.id).join(', ')}`);
			}
			const vault = targets[0];
			const notesDir = join(vault.dir, NOTES_DIR);

			if (mode === 'merge') {
				// 纯确定性 ✓：锁内合并 ⇒ 刷新派生（导航/内核 ✓ —— .canvas 不进索引但导航会列 ✓）
				const wantedFiles = Array.isArray(params?.files) ? params.files.map(String) : undefined;
				const release = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库思维导图合并' });
				let merged;
				try {
					const all = await listMindmaps(notesDir);
					// ⚠ "不给 files ⇒ 全部"时**按名字排序** ✓：readdir 顺序不定 ⇒ 目标（=第一个，真源口径 ✓）
					//   会飘 ⇒ 排序让它确定 ✓（显式给了 files 就照调用方的顺序 —— 真源：选择顺序 ✓）。
					const paths = wantedFiles
						? wantedFiles.map(name => {
							// 围栏：只许是文件名（不许带路径 ✗ —— 画布就该在 笔记/ 根 ✓）
							if (/[\\/]/.test(name)) { throw new Error(`files 只收文件名（不带路径）：${name}`); }
							const found = all.get(name);
							if (!found) { throw new Error(`笔记区里没有这个思维导图：${name}`); }
							return found;
						})
						: [...all.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, p]) => p);
					if (paths.length < 2) { return { ok: false, vault: vault.id, mode, message: `笔记区里只有 ${paths.length} 个 .canvas ⇒ 没得合并（要 ≥2 个 ✓）。` }; }
					merged = await mergeMindmapFiles(paths);
					if (!merged) { return { ok: false, vault: vault.id, mode, message: '合并失败：至少需要 2 个**有效**（非空、可解析）的思维导图 ✓。' }; }
					await refreshDerived(vault.dir, config);
				} finally {
					await release();
				}
				return {
					ok: true, vault: vault.id, mode, path: merged.path, nodes: merged.nodes, edges: merged.edges,
				// ★ 库被纠正过（方案 A：当前库优先）⇒ 必须说（与其它写工具同口径）
				...(vaultPick.overriddenFrom ? { overriddenFrom: vaultPick.overriddenFrom } : {}),
					message: `已合并为 ${merged.path.split(/[\\/]/).pop()}（${merged.nodes} 节点 / ${merged.edges} 边 ✓；其余源文件已删 ✓）。`,
				};
			}

			// ── refine / rename 的公共前段：定位目标 .canvas（照真源：mindmap.canvas 优先 ✓）──────
			if (mode === 'refine' || mode === 'rename') {
				const wantedFile = typeof params?.file === 'string' && params.file.trim() ? params.file.trim() : '';
				if (wantedFile && /[\\/]/.test(wantedFile)) { throw new Error(`file 只收文件名（不带路径）：${wantedFile}`); }
				const all = await listMindmaps(notesDir);
				const targetName = wantedFile || (all.has('mindmap.canvas') ? 'mindmap.canvas' : [...all.keys()].sort()[0] ?? '');
				const canvasPath = targetName ? all.get(targetName) : undefined;
				if (!canvasPath) { return { ok: false, vault: vault.id, mode, message: `笔记区里没有${targetName ? `「${targetName}」` : '任何 .canvas'} ⇒ 先 generate 一张再来 ✓。` }; }

				if (mode === 'rename') {
					// ★ 与真源同构（视图 `:962-997` ✓）：**先用确定性推导**（deriveMindmapTitle ✓），
					//   有模型时再用它的建议覆盖 ✓ —— 所以"缺 subagents"**不是**降级 ✗，是真源本来的那一档 ✓。
					const data = await readMindmap(canvasPath);
					if (!data || data.nodes.length === 0) { return { ok: false, vault: vault.id, mode, message: '该思维导图为空（或解析失败）⇒ 不能按内容命名 ✓。' }; }
					let newName = deriveMindmapTitle(data);
					const jobsSvc = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined;
					const subSvc = typeof ctx?.get === 'function' ? ctx.get('subagents') : undefined;
					const parentAgent = exec?.agent;
					let usedModel = false;
					if (jobsSvc && subSvc && typeof subSvc.start === 'function' && parentAgent?.id) {
						// 提示词与真源逐字 ✓（`suggestTitlePrompt` ✓）；这一次**同步等**（一次问答，秒级 ✓ ——
						// 真源也是 `await suggestMindmapTitle` 内联 ✓；与 generate 那种分钟级任务不同 ✓）。
						try {
							const provider = (typeof params?.provider === 'string' && params.provider.trim())
								|| (typeof config?.subagentProvider === 'string' && config.subagentProvider.trim())
								|| DEFAULT_SUBAGENT_PROVIDER;
							const { system, user } = suggestTitlePrompt(data);
							const run = await subSvc.start(provider, {
								label: `kb-mindmap-title ${vault.id}`,
								prompt: [{ type: 'text', text: `${system}\n\n${user}\n\n⚠ 只输出标题本身（不要引号、不要解释 ✓）。` }],
								parent: parentAgent,
								toolFilter: { allow: ['kb_read'] },
								maxDepth: 1,
							});
							const result = await run.result;
							const reply = (Array.isArray(result?.output) ? result.output : []).map(block => String(block?.text ?? '')).join('\n');
							const suggested = titleFromSuggestion(reply);
							if (suggested) { newName = suggested; usedModel = true; }
						} catch (err) {
							// ⚠ 模型那半失败 ⇒ **用推导名**（真源同：`suggestMindmapTitle` 自己吞错返回 null ✓）
							//   —— 但如实把"没用上模型"说出来 ✓（不许假装是模型给的名字 ✗）。
							void err;
						}
					}
					if (newName === targetName) { return { ok: true, vault: vault.id, mode, path: canvasPath, message: `名称已符合内容：「${targetName}」（${usedModel ? '模型建议' : '确定性推导'} ✓）—— 没改名 ✓。` }; }
					const target = await uniqueCanvasPath(notesDir, newName);
					const release = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库思维导图改名' });
					try {
						await renameFile(canvasPath, target);
						await refreshDerived(vault.dir, config);
					} finally {
						await release();
					}
					return {
						ok: true, vault: vault.id, mode, path: target,
						message: `已按内容重命名：「${targetName}」→「${target.split(/[\\/]/).pop()}」（${usedModel ? '模型建议' : '确定性推导（没拿到模型 ✓）'} ✓）。`,
					};
				}

				// refine：起**只读**子代理（图谱 JSON 直接内联进 prompt ✓ —— 与真源把 existing 塞进 user ✓ 同构）
				const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined;
				const subagents = typeof ctx?.get === 'function' ? ctx.get('subagents') : undefined;
				if (!jobs || !subagents || typeof jobs?.start !== 'function' || typeof subagents?.start !== 'function') {
					throw new Error('本侧现在完善不了：这个组合里缺少 jobs / subagents 服务 ⇒ 请把它们装进 profile，或到 IDE 侧完善 ✓（不会静默退化 ✗）。');
				}
				const parent = exec?.agent;
				if (!parent || typeof parent.id !== 'string' || !parent.id) {
					throw new Error('拿不到当前会话身份（exec.agent）⇒ 无法把任务挂到会话名下 ✓。');
				}
				const existingData = await readMindmap(canvasPath);
				if (!existingData || existingData.nodes.length === 0) { return { ok: false, vault: vault.id, mode, message: '该思维导图为空（或解析失败）⇒ 没东西可完善 ✓。' }; }
				const provider = (typeof params?.provider === 'string' && params.provider.trim())
					|| (typeof config?.subagentProvider === 'string' && config.subagentProvider.trim())
					|| DEFAULT_SUBAGENT_PROVIDER;
				const { system, user } = refineGraphPrompt(existingData);
				const jobId = jobs.start({
					kind: 'kb-mindmap-refine',
					label: `kb-mindmap-refine ${vault.id}`,
					owner: parent.id,
					run: () => {
						const controller = new AbortController();
						return {
							cancel: reason => controller.abort(reason ?? 'kb-mindmap refine 被取消'),
							done: (async () => {
								const run = await subagents.start(provider, {
									label: `kb-mindmap-refine ${vault.id}`,
									prompt: [{ type: 'text', text: `${system}\n\n${user}\n\n⚠ 只输出 JSON 本体（不要 markdown 围栏 ✓）。` }],
									parent,
									signal: controller.signal,
									toolFilter: { allow: ['kb_read'] },
									maxDepth: 1,
								});
								const result = await run.result;
								const reply = (Array.isArray(result?.output) ? result.output : []).map(block => String(block?.text ?? '')).join('\n');
								const enriched = parseRefinedGraph(reply);
								if (!enriched) { return { ok: false, error: '子代理没给出可解析的图谱 JSON ⇒ **不写盘**（保留原图 ✓）。' }; }
								const release = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库思维导图完善' });
								let saved;
								try {
									// 与真源同序（`:242-245`）：mergeRefined（同 id 用模型版 ＋ 新节点并进来 ✓）→ relayout → 标记 → 写回**同一个文件** ✓
									const merged = mergeRefined(existingData, enriched);
									relayoutMindmap(merged);
									merged.mindmap = true;
									await writeMindmap(canvasPath, merged);
									await refreshDerived(vault.dir, config);
									saved = { path: canvasPath, nodes: merged.nodes.length, edges: merged.edges.length };
								} finally {
									await release();
								}
								return { ok: true, path: saved.path, nodes: saved.nodes, edges: saved.edges };
							})(),
						};
					},
				});
				return {
					ok: true, vault: vault.id, mode, jobId,
					message: `已起完善任务：jobId=${jobId}（子代理**保留原 id**、补充概念与边 ⇒ 宿主合并回 ${targetName} ✓）。进度用 job_output。`,
				};
			}

			// generate：起**只读**子代理（编排在 `startMindmapGenerateJob` ✓ —— 与"构建完成自动生成"共用一份 ✓）
			const outcome = await startMindmapGenerateJob({
				ctx, config, vault,
				parent: exec?.agent,
				provider: typeof params?.provider === 'string' ? params.provider : undefined,
				count: params?.count,
				// ⚠ 工具路径下"缺服务 / 缺会话身份"要**抛错**（调用方是模型，必须知道为什么没起 ✓）；
				//   而"笔记区空的"是"没活儿干" ⇒ 不抛（返回 ok:false ✓）。
				strict: true,
			});
			if (!outcome.ok) { return { ok: false, vault: vault.id, mode, message: outcome.message }; }
			return { ok: true, vault: vault.id, mode, jobId: outcome.jobId, message: outcome.message };
		},
	}, {
		// ── 飞书**云文档读侧**三件（§R.7 第 ⑤ 项：盘点后判为"可做且机制已核" ✓）────────────────────
		// 为什么放在 kb 模块：`kb_feishu_sync` 是"本地 → 飞书"，读文档/评论是"飞书 → 本地" ✓ —— 同一环 ✓、
		// 同一个 lark-cli 依赖 ✓、同一套"缺 CLI 就给安装+登录指引" ✓（族长大了再拆模块 ✓）。
		// ⚠ 三条照真源抄的关键点：① **参数名兼容**（`file_id`/`doc_id` 与 `file_token`/`doc_token` 都收 ✓ ——
		// 只收一边会让模型按另一种名字调时"参数缺失"，看起来像工具坏了 ✓）；② 列评论**默认含已解决** ✓
		// （真源原话：否则模型会因"没看到某条"得出"没人提过"的错误结论 ✓）；③ 评论正文在
		// **`reply_list.replies[0]`** ✓（不在评论对象自己的 `content` 里 ✗）—— 这条错了的症状正是
		// "列出了评论、每条都没内容" ✓。
		name: 'feishu_doc_read',
		description: '读取飞书/Lark **云文档正文**（转成 markdown ✓，含标题/列表/表格/链接 ✓）—— 适合"把这个飞书文档读进来看看/总结/落笔记" ✓。'
			+ ' 文档定位给 **URL 或 token** 都行 ✓（`doc_id` / `file_id` / `doc_token` … 几种名字都认 ✓）；'
			+ '裸 token 时会自动补 `--type`（缺省 docx ✓）。'
			+ ' ⚠ 底层是官方 `lark-cli`：没装/没登录时给出**安装 + 登录**指引 ✓（不假装读到了空文档 ✗）。',
		parameters: {
			type: 'object',
			properties: {
				doc_id: { type: 'string', description: '文档 URL 或 token（`file_id` / `doc_token` 等别名也都认 ✓）' },
				file_type: { type: 'string', description: '文档类型 doc/docx/sheet/file/slides/bitable（缺省 docx；给 URL 时由 CLI 自己识别 ✓）' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH ✓；装在非标准位置时给绝对路径 ✓）' },
			},
			required: ['doc_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, title: { type: 'string' }, content: { type: 'string' },
					bytes: { type: 'integer' }, chars: { type: 'integer' }, message: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message ?? `${value.title ? `${value.title}\n` : ''}${value.content}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async params => {
			const target = parseDocTarget(params);
			if (!target.url && !target.token) { throw new Error('feishu_doc_read 需要 doc_id：**文档 URL 或 token** ✓'); }
			const exe = (typeof params?.cliPath === 'string' ? params.cliPath : '').trim() || DEFAULT_LARK_CLI;
			const r = await runLarkCli(exe, buildDocReadArgs(params), FEISHU_READ_TIMEOUT_MS);
			if (r.missing) { return { ok: false, message: LARK_CLI_MISSING_HINT }; }
			const doc = parseDocFetch(r.stdout, r.stderr);
			if (!doc.ok) {
				// ⚠ 把 CLI 的原始输出**截尾附上** ✓（否则"为什么读不到"只能靠猜 ✓）
				return { ok: false, message: `读文档失败：${doc.error}\n${String(`${r.stdout}\n${r.stderr}`).trim().slice(-400) || '(CLI 没有任何输出)'}` };
			}
			return { ok: true, ...(doc.title ? { title: doc.title } : {}), content: doc.content, bytes: Buffer.byteLength(doc.content, 'utf8'), chars: doc.content.length };
		},
	}, {
		// 列评论（只读 ✓）。真源的"默认含已解决"见上面那段注释 ✓。
		name: 'feishu_drive_list_comments',
		description: '列出飞书云文档上的**评论**（**默认含"已解决"** ✓ —— 避免"没看到"被误当成"没人提过" ✗）。'
			+ ' 每条给出 comment_id（供 `feishu_drive_list_comment_replies` 展开讨论 ✓）、正文、作者、'
			+ '整篇/局部/已解决 标记与**回复数** ✓（回复数 > 1 说明这条线程有讨论 ✓）。',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: '文档 URL 或 token（别名都认 ✓）' },
				file_type: { type: 'string', description: '文档类型（缺省 docx ✓）' },
				comment_scope: { type: 'string', description: 'all（缺省）/ whole（整篇）/ partial（划词局部）' },
				solved_status: { type: 'string', description: 'all（缺省 ✓）/ true / false —— 缺省给全量，别静默漏读 ✓' },
				page_size: { type: 'integer', description: '每页条数（1–100，缺省 50 ✓）' },
				page_token: { type: 'string', description: '上一页返回的 pageToken ✓' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH ✓）' },
			},
			required: ['file_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, count: { type: 'integer' }, pageToken: { type: 'string' },
					comments: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' }, author: { type: 'string' }, text: { type: 'string' },
								isWhole: { type: 'boolean' }, isSolved: { type: 'boolean' }, replyCount: { type: 'integer' }, quote: { type: 'string' },
							},
							required: ['id'],
						},
					},
					message: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message ?? (value.count
					? `评论（${value.count} 条）：\n${value.comments.map(c => {
						const flags = [c.isWhole ? '整篇' : '局部', c.isSolved ? '已解决' : '未解决', c.replyCount > 1 ? `${c.replyCount} 条回复` : ''].filter(Boolean).join(' · ');
						return `- ${c.id}${c.author ? ` @${c.author}` : ''}（${flags}）：${c.text || '(正文为空)'}${c.quote ? ` 引用「${c.quote}」` : ''}`;
					}).join('\n')}${value.pageToken ? `\n（下一页 page_token：${value.pageToken}）` : ''}`
					: '这个文档上没有评论（或筛选条件把评论都排除了 ✓）。'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async params => {
			const target = parseDocTarget(params);
			if (!target.url && !target.token) { throw new Error('feishu_drive_list_comments 需要 file_id：**文档 URL 或 token** ✓'); }
			const exe = (typeof params?.cliPath === 'string' ? params.cliPath : '').trim() || DEFAULT_LARK_CLI;
			const r = await runLarkCli(exe, buildListCommentsArgs(params), FEISHU_READ_TIMEOUT_MS);
			if (r.missing) { return { ok: false, message: LARK_CLI_MISSING_HINT }; }
			const { items, parsed } = parseLarkItems(r.stdout);
			if (!items.length && String(`${r.stdout}${r.stderr}`).trim()) {
				return { ok: false, message: `列评论失败（CLI 输出里没有条目 ✓）：${String(`${r.stdout}\n${r.stderr}`).trim().slice(-400)}` };
			}
			const pageToken = String(parsed?.data?.page_token ?? parsed?.page_token ?? '').trim();
			return { ok: true, count: items.length, comments: items.map(item => summarizeEntry(item, 'comment')), ...(pageToken ? { pageToken } : {}) };
		},
	}, {
		// 列回复（只读 ✓）。首条即评论正文本身 ✓（照真源描述 ✓）。
		name: 'feishu_drive_list_comment_replies',
		description: '列出某条评论下的**回复**（首条就是评论正文本身 ✓）。`comment_id` 来自 `feishu_drive_list_comments` ✓。'
			+ ' 用途：评论的**回复数 > 1** 时值得展开看看讨论结论 ✓。',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: '文档 URL 或 token（别名都认 ✓）' },
				comment_id: { type: 'string', description: '评论 ID（来自 feishu_drive_list_comments ✓）' },
				file_type: { type: 'string', description: '文档类型（缺省 docx ✓）' },
				page_size: { type: 'integer', description: '每页条数（1–100 ✓）' },
				page_token: { type: 'string', description: '下一页 token ✓' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH ✓）' },
			},
			required: ['file_id', 'comment_id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, count: { type: 'integer' }, pageToken: { type: 'string' },
					replies: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'string' }, author: { type: 'string' }, text: { type: 'string' } },
							required: ['id'],
						},
					},
					message: { type: 'string' },
				},
				required: ['ok'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message ?? (value.count
					? `回复（${value.count} 条；第 1 条即评论正文 ✓）：\n${value.replies.map((reply, index) => `${index + 1}. ${reply.id}${reply.author ? ` @${reply.author}` : ''}：${reply.text || '(空)'}`).join('\n')}${value.pageToken ? `\n（下一页 page_token：${value.pageToken}）` : ''}`
					: '这条评论下没有回复 ✓。'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async params => {
			const commentId = String(params?.comment_id ?? '').trim();
			if (!commentId) { throw new Error('feishu_drive_list_comment_replies 需要 comment_id（先用 feishu_drive_list_comments 取 ✓）'); }
			const target = parseDocTarget(params);
			if (!target.url && !target.token) { throw new Error('feishu_drive_list_comment_replies 需要 file_id：**文档 URL 或 token** ✓'); }
			const exe = (typeof params?.cliPath === 'string' ? params.cliPath : '').trim() || DEFAULT_LARK_CLI;
			const r = await runLarkCli(exe, buildListRepliesArgs(params), FEISHU_READ_TIMEOUT_MS);
			if (r.missing) { return { ok: false, message: LARK_CLI_MISSING_HINT }; }
			const { items, parsed } = parseLarkItems(r.stdout);
			if (!items.length && String(`${r.stdout}${r.stderr}`).trim()) {
				return { ok: false, message: `列回复失败（CLI 输出里没有条目 ✓）：${String(`${r.stdout}\n${r.stderr}`).trim().slice(-400)}` };
			}
			const pageToken = String(parsed?.data?.page_token ?? parsed?.page_token ?? '').trim();
			return { ok: true, count: items.length, replies: items.map(item => summarizeEntry(item, 'reply')), ...(pageToken ? { pageToken } : {}) };
		},
	}, {
		// ── 飞书云文档**写侧**两件（§R.7 第 ⑤ 项）──────────────────────────────────────────────
		// 两条都**会在别人的文档上留下可见内容** ✓ ⇒ 必须过审批闸（真源也是 `Cautious` ✓）。
		// ⚠ 三条照真源抄的关键点：
		//   ① `--content` 走 **`@<文件>`** ✓（argv 里只有路径 ⇒ 引号/`&` 整类风险消失 ✓）；
		//   ② **不能只看退出码** ✓：CLI 有时把业务错误写进 JSON 却仍 `exit 0` ⇒ 还要看 `code != 0` ✓；
		//   ③ 整篇 / **已解决**评论**不接受回复** ✓（飞书错误码 `1069302` ✓）⇒ 失败要映射成**可执行**指引
		//      （改用 `feishu_drive_add_comment` ✓），而不是把裸错误码丢给模型 ✗。
		name: 'feishu_drive_reply_comment',
		description: '回复飞书文档上**已有的**评论线程 ✓（**只适用于局部 / 未解决**评论 —— 整篇或已解决评论不接受回复 ✓，'
			+ '那种情况改用 `feishu_drive_add_comment` ✓）。`content` 给纯文本即可 ✓（会自动转成 CLI 要的 reply_elements ✓；'
			+ '也可直接传 JSON 数组以用 mention/link 元素 ✓）。'
			+ ' ⚠ 会在**别人的文档**上留下可见内容 ⇒ 需要用户在审批里确认 ✓（被拒绝是正常的，别反复重试 ✗）。',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: '文档 URL 或 token（别名都认 ✓）' },
				comment_id: { type: 'string', description: '要回复的评论 ID（来自 feishu_drive_list_comments ✓）' },
				content: { type: 'string', description: '回复纯文本 ✓（或 reply_elements JSON 数组 ✓）' },
				file_type: { type: 'string', description: '文档类型（缺省 docx ✓）' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH ✓）' },
			},
			required: ['file_id', 'comment_id', 'content'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, commentId: { type: 'string' }, message: { type: 'string' } },
				required: ['ok'],
			},
			render: (_args, value) => [{ type: 'text', text: value.message ?? `已回复评论 ${value.commentId} ✓。` }],
		},
		execute: async params => {
			const commentId = String(params?.comment_id ?? '').trim();
			if (!commentId) { throw new Error('feishu_drive_reply_comment 需要 comment_id ✓（先用 feishu_drive_list_comments 取 ✓）'); }
			const target = parseDocTarget(params);
			if (!target.url && !target.token) { throw new Error('feishu_drive_reply_comment 需要 file_id：**文档 URL 或 token** ✓'); }
			const contentJson = buildReplyElements(params?.content);
			if (!contentJson) { throw new Error('feishu_drive_reply_comment 需要**非空** content ✓（空的会被拒绝，不喂空评论 ✗）'); }
			const exe = (typeof params?.cliPath === 'string' ? params.cliPath : '').trim() || DEFAULT_LARK_CLI;
			return withContentFile(contentJson, async ref => {
				const r = await runLarkCli(exe, buildAddReplyArgs(params, ref), FEISHU_WRITE_TIMEOUT_MS);
				if (r.missing) { return { ok: false, message: LARK_CLI_MISSING_HINT }; }
				const parsed = parseLarkItems(r.stdout).parsed;
				if (isCliFailure({ exitCode: r.code, parsed, items: parseLarkItems(r.stdout).items })) {
					return { ok: false, commentId, message: describeCliFailure('回复评论', r, parsed) };
				}
				return { ok: true, commentId, message: `已回复评论 ${commentId} ✓。` };
			});
		},
	}, {
		name: 'feishu_drive_add_comment',
		description: '在飞书文档上**新发**一条评论 ✓（缺省是**整篇**评论 ✓；给 `block_id` 可锚定到某个块 ✓）。'
			+ ' 用途：整篇 / 已解决评论**不接受回复** ⇒ 那是"回不了某条评论"时的**正确出口** ✓。`content` 给纯文本即可 ✓。'
			+ ' ⚠ 会在**别人的文档**上留下可见内容 ⇒ 需要用户在审批里确认 ✓。',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: '文档 URL 或 token（别名都认 ✓）' },
				content: { type: 'string', description: '评论纯文本 ✓（或 reply_elements JSON 数组 ✓）' },
				file_type: { type: 'string', description: '文档类型（缺省 docx ✓）' },
				block_id: { type: 'string', description: '可选：锚定到某个块（docx 的 block id ✓）' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH ✓）' },
			},
			required: ['file_id', 'content'],
		},
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
				required: ['ok'],
			},
			render: (_args, value) => [{ type: 'text', text: value.message ?? '已在该文档上新增评论 ✓。' }],
		},
		execute: async params => {
			const target = parseDocTarget(params);
			if (!target.url && !target.token) { throw new Error('feishu_drive_add_comment 需要 file_id：**文档 URL 或 token** ✓'); }
			const contentJson = buildReplyElements(params?.content);
			if (!contentJson) { throw new Error('feishu_drive_add_comment 需要**非空** content ✓'); }
			const exe = (typeof params?.cliPath === 'string' ? params.cliPath : '').trim() || DEFAULT_LARK_CLI;
			return withContentFile(contentJson, async ref => {
				const r = await runLarkCli(exe, buildAddCommentArgs(params, ref), FEISHU_WRITE_TIMEOUT_MS);
				if (r.missing) { return { ok: false, message: LARK_CLI_MISSING_HINT }; }
				const parsedParsed = parseLarkItems(r.stdout);
				if (isCliFailure({ exitCode: r.code, parsed: parsedParsed.parsed, items: parsedParsed.items })) {
					return { ok: false, message: describeCliFailure('发表评论', r, parsedParsed.parsed) };
				}
				return { ok: true, message: '已在该文档上新增评论 ✓。' };
			});
		},
	}, {
		// ── 飞书知识库：列出 / 新建（§R.7 第 ④ 项）─────────────────────────────────────────────
		// 为什么需要它 ✓：`kb_feishu_sync` 只解决"把笔记推上去" ✓，而用户的真实需求形态是
		// 「把某个笔记目录关联到飞书知识库，**没有则新建**」✗ —— 缺的正是"查远端真实列表 / 建库"这一步 ✓。
		// ⚠ 判据**不许**用本地 `.feishu-space-map.json` ✗：那是**本地映射**，不等于远端有没有同名库 ✓
		//   （IDE 侧注释记的正是这个"判据错位" ✓）⇒ `list` 必须问远端 ✓。
		// 契约照 IDE 真源（`browser/knowledge/feishuSyncCore.ts` ✓）：`wiki +space-list --page-all --format json`（20s ✓）、
		// `wiki +space-create --name … --as user`（30s ✓）、同名（忽略大小写与首尾空白）⇒ **复用不重建** ✓。
		name: 'kb_feishu_spaces',
		description: [
			'列出 / 新建**飞书知识库**（wiki space）——「把某个笔记目录关联到飞书知识库」的前置步骤。',
			'**先 `action: "list"`**（不要用本地 `.feishu-space-map.json` 判断远端有没有同名库 ✗ —— 那是本地映射，判据错位）；',
			'确认远端没有再 `action: "create"`；同名库已存在时会**直接复用**并返回它的 spaceId ✓（不会重复创建 ✓）。',
			`拿到 spaceId 后写进 vault 内的 \`.feishu-space-map.json\` 的 mappings（\`dir\` 用「笔记」区相对目录），再跑 kb_feishu_sync ✓。`,
			'底层跑 lark-cli（缺它/未登录时给出安装与登录指引 ✓）；`create` 会**写远端** ⇒ 需要用户在审批里确认 ✓（被拒绝是正常的，别反复重试 ✗）。',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', description: 'list（缺省）= 列出远端全部知识库；create = 新建（要给 name）' },
				name: { type: 'string', description: 'create 时的知识库名称（会净化引号/换行；远端已有同名 ⇒ 复用不重建 ✓）' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH；装在非标准位置时给绝对路径）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					action: { type: 'string' },
					count: { type: 'integer' },
					spaces: {
						type: 'array',
						items: {
							type: 'object',
							properties: { spaceId: { type: 'string' }, name: { type: 'string' } },
							required: ['spaceId', 'name'],
						},
					},
					created: { type: 'boolean' },
					duplicated: { type: 'boolean' },
					spaceId: { type: 'string' },
					message: { type: 'string' },
				},
				required: ['ok', 'action'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message
					?? (value.action === 'list'
						? `飞书知识库（远端实时，共 ${value.count} 个）：${(value.spaces ?? []).map(s => `${s.name}(${s.spaceId})`).join('、')}`
						: `飞书知识库：${value.spaceId}`),
			}],
		},
		// 会写远端 ⇒ **不声明**可并行（与 kb_feishu_sync 同口径 ✓）
		execute: async params => {
			const action = params?.action === 'create' ? 'create' : 'list';
			const exe = (typeof params?.cliPath === 'string' ? params.cliPath : '').trim() || DEFAULT_LARK_CLI;
			// ① **先校验输入**（在任何 I/O 之前 ✓）：输入就错的调用不该先跑一次 CLI ✓（而且这样
			//    "名称非法"这条拒绝路径**不依赖 CLI 是否装好** ⇒ 能被探针直测 ✓）。
			const name = action === 'create' ? sanitizeSpaceName(params?.name) : '';
			if (action === 'create' && !name) {
				// 空名称**明确报错** ✓（净化后为空 = 输入里只有引号/换行）：静默建个无名库最难收拾 ✗
				throw new Error('create 需要 name：知识库名称不能为空（净化引号与换行后仍为空 ⇒ 拒绝）。');
			}
			// ② 无论 list 还是 create，都问**远端真实列表** ✓（create 要靠它判重 ✓；不许用本地映射判 ✗）
			const listed = await runLarkCli(exe, SPACE_LIST_ARGS, SPACE_LIST_TIMEOUT_MS);
			if (listed.missing) { return { ok: false, action, message: LARK_CLI_MISSING_HINT }; }
			const spaces = parseSpaceList(`${listed.stdout}${listed.stderr}`);
			if (action === 'list') {
				return {
					ok: true, action, count: spaces.length, spaces,
					...(spaces.length ? {} : { message: '未取到飞书知识库列表：确认 lark-cli 已用**用户身份**登录（`lark-cli auth login --as user`）后重试。' }),
				};
			}
			const dup = findSameNameSpace(spaces, name);
			if (dup) {
				return {
					ok: true, action, duplicated: true, spaceId: dup.spaceId, count: spaces.length, spaces,
					message: `飞书侧**已存在**同名知识库「${dup.name}」（spaceId: ${dup.spaceId}）⇒ 不要重复创建 ✓。下一步：把该 spaceId 写进该 vault 的 .feishu-space-map.json 的 mappings（dir = 「笔记」区相对目录），再跑 kb_feishu_sync ✓。`,
				};
			}
			const created = await runLarkCli(exe, spaceCreateArgs(name), SPACE_CREATE_TIMEOUT_MS);
			if (created.missing) { return { ok: false, action, message: LARK_CLI_MISSING_HINT }; }
			const spaceId = parseCreatedSpaceId(`${created.stdout}${created.stderr}`);
			if (!spaceId) {
				return {
					ok: false, action,
					message: `新建知识库「${name}」没成功：检查 lark-cli 登录态与网络，稍后重试（**未创建任何东西** ✓）。原始输出尾部：${String(`${created.stdout}${created.stderr}`).slice(-300) || '(空)'}`,
				};
			}
			return {
				ok: true, action, created: true, spaceId,
				message: `已创建飞书知识库「${name}」（spaceId: ${spaceId}）✓。下一步：把该 spaceId 写进该 vault 的 .feishu-space-map.json 的 mappings（dir = 「笔记」区相对目录），再跑 kb_feishu_sync ✓。⚠ 只有映射目录里的内容会被同步；空目录不会产生任何文档（可先放一篇索引笔记）。`,
			};
		},
	}, {
		name: 'kb_feishu_sync',
		description: `把资料库笔记同步到飞书个人知识库（跑**随包内置**的 ${FEISHU_SYNC_SCRIPT}，底层用 lark-cli）。`
			+ '**默认只预览（dry-run）**：不写任何远端，报告里逐篇列出"会同步 / 会跳过"。'
			+ '`apply:true` 才真同步（写远端，需 lark-cli 已登录 user 身份）——**只有用户明确要求时才用它**。'
			+ 'lark-cli 没装/没登录时会给出安装与登录指引。同步是逐篇串行的，可用 limit 分批；vault 缺省 = 库里只有一个 vault 时用它。',
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '同步哪个 vault（缺省 = 库里只有一个 vault 时用它）' },
				src: { type: 'array', items: { type: 'string' }, description: '要同步的目录（vault 内相对路径；缺省 = 库）' },
				apply: { type: 'boolean', description: 'true = 真同步（写远端）；缺省 false = 只预览' },
				limit: { type: 'integer', description: '最多同步多少篇（0 = 不限）' },
				cliPath: { type: 'string', description: 'lark-cli 的可执行名或路径（缺省 = 走 PATH；装在非标准位置时给绝对路径）' },
				// ★ 2026-10-20：落点可配（此前写死脚本默认的 my_library = 飞书「个人知识库」）
				parent: {
					type: 'string',
					description: '同步落点：缺省 my_library（飞书「个人知识库」）；'
						+ '要给某个文件夹 / wiki 节点就传它的 token（folder token 或 wiki node token）。',
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					mode: { type: 'string' }, vault: { type: 'string' }, exitCode: { type: 'integer' },
					report: { type: 'string' }, reportTruncated: { type: 'boolean' },
				},
				required: ['mode', 'vault', 'exitCode', 'report'],
			},
			render: (_args, value) => [{ type: 'text', text: value.report }],
		},
		execute: async params => {
			// 显式 vaultId → **当前库**（config.kbActiveVaultId，与页面渲染同一口径 ✓）
		const vaultPick = await vaultWantedOf(params, config);
		const wanted = vaultPick.vaultId;
			if (wanted && !isVaultId(wanted)) {
				throw new Error(`vaultId 形态不合法：${wanted}`);
			}
			const { vaults, missing } = await listAllVaults(root(), config, { withDocs: false });
			if (missing) {
				throw new Error(`资料库根目录还不存在：${missing}`);
			}
			const targets = wanted ? vaults.filter(vault => vault.id === wanted) : vaults;
			if (wanted && !targets.length) {
				throw new Error(`找不到 vault：${wanted}`);
			}
			if (targets.length !== 1) {
				// 脚本一次只同步一个 vault（`--vault <vault根>`）；含混地挑一个比报错更坏
				throw new Error(`请指明要同步哪个 vault（现在有 ${targets.length} 个）：${vaults.map(v => v.id).join(', ')}`);
			}
			const apply = params?.apply === true;
			const src = Array.isArray(params?.src) ? params.src.filter(dir => typeof dir === 'string' && dir.trim()) : [];
			const limit = Number.isFinite(params?.limit) ? Number(params.limit) : 0;
			const cliPath = typeof params?.cliPath === 'string' ? params.cliPath.trim() : '';
			const runDir = await mkdtemp(join(tmpdir(), 'vssaros-feishu-sync-'));
			try {
				const planFile = join(runDir, 'report.txt');
				const parent = typeof params?.parent === 'string' ? params.parent.trim() : '';
			const args = buildFeishuSyncArgs({ vault: targets[0].dir, src, apply, limit, planFile, cliPath, parent });
				const result = await runFeishuSync(args, targets[0].dir);
				// 报告优先（脚本注释：工具读它即可准确回报"预览了什么/实际做了什么、有没有失败"）；
				// 拿不到报告才退回进程输出（例如脚本在写报告前就退出了）
				let report = '';
				try {
					report = await readFile(planFile, { encoding: 'utf8' });
				} catch {
					report = '';
				}
				// ★★ 2026-10-20（真机：同步后无法自证「哪几篇失败了」）：
			//   报告原先**只在返回值里**，而 `runDir`（存 report.txt 的临时目录）在 `finally` 里
			//   被整个删掉 ⇒ 事后完全查不到逐篇结果 ✗。而脚本对"部分失败"仍可能返回退出码 0
			//   （见 runFeishuSync 的注释）⇒ 光看 `status: success` 会误判"全都成了" ✗。
			//   ⇒ 把报告落盘（复用 logKbWrite：`<数据根>/kb-write.log`，三级兜底、失败不影响同步）。
			//   ⚠ 报告可能很长（脚本会逐篇列结果）⇒ 截到 FEISHU_REPORT_LIMIT，并如实标注被截断。
			if (report.trim()) {
				const logged = report.trim().length > FEISHU_REPORT_LIMIT
					? `${report.trim().slice(0, FEISHU_REPORT_LIMIT)}\n…（落盘时按 ${FEISHU_REPORT_LIMIT} 字符截断）`
					: report.trim();
				void logKbWrite(config, `=== feishu.sync 报告 vault=${targets[0].id} apply=${apply} src=${src.length} exit=${result.code} ===\n${logged}\n=== 报告结束 ===`);
			} else {
				void logKbWrite(config, `=== feishu.sync 无报告文件 vault=${targets[0].id} apply=${apply} exit=${result.code}，输出前 2000 字：${String(result.output ?? '').slice(0, 2000)} ===`);
			}
			const text = (report.trim() ? report : result.output).trim() || `（脚本没有输出）退出码 ${result.code}`;
				const truncated = text.length > FEISHU_REPORT_LIMIT;
				return {
					mode: apply ? 'apply' : 'dry-run',
					vault: targets[0].id,
					// ★ 库被纠正过（方案 A：当前库优先）⇒ 必须说，否则模型以为写进了它指定的库 ✗
					...(vaultPick.overriddenFrom ? { overriddenFrom: vaultPick.overriddenFrom } : {}),
					exitCode: result.code,
					report: truncated ? `${text.slice(0, FEISHU_REPORT_LIMIT)}\n…（报告已截断）` : text,
					...(truncated ? { reportTruncated: true } : {}),
				};
			} finally {
				await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
			}
		},
	}, {
		// 重构 4（2026-10-16）：`kb_reindex`——建向量索引（KB 语义检索的**建**半）：读 vault 的 .md
		// ⇒ 分块（chunkMarkdown，与 IDE 同口径 ✓）⇒ 经桥回 IDE 批量取向量（embedding 模型在壳侧 ✓）
		// ⇒ 写 `.kvindex`（与 IDE 同一份二进制契约 ✓）。写类 ⇒ 挂审批闸 ✓（WRITE_TOOLS 里有它 ✓）。
		// 与 kb_build 的 build 模式分开：那个建**笔记**（子代理写盘），这个建**向量索引**（读已有笔记 ✓）。
		name: 'kb_reindex',
		description: '重建知识库的向量索引（语义检索的建半）：读 vault 的 .md 笔记，分块后经 IDE 侧的 embedding 模型批量取向量，写成 .kvindex（与 IDE 同一份二进制格式）。写完 mode="semantic" 的检索就能用它。写类（写 .kvindex）。',
		parameters: {
			type: 'object',
			properties: {
				vaultId: { type: 'string', description: '重建哪个 vault（缺省 = 库里只有一个 vault 时用它）' },
				batchSize: { type: 'integer', description: '每批向量化多少块（默认 64，照 IDE 的 EMBED_BATCH ✓）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					vaultId: { type: 'string' },
					chunks: { type: 'integer' },
					dimensions: { type: 'integer' },
					tag: { type: 'string' },
					indexPath: { type: 'string' },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `已重建向量索引：${value.chunks} 块（${value.dimensions} 维 · ${value.tag}）→ ${value.indexPath}`
					: `重建失败：${value.error ?? '未知原因'}`,
			}],
		},
		// 写类 ⇒ 不声明 isConcurrencySafe（默认独占 ✓）。
		execute: async (params) => {
			const { vaults } = await listAllVaults(root(), config, { withDocs: true });
			const wantedVault = typeof params?.vaultId === 'string' ? params.vaultId.trim() : '';
			const targets = wantedVault ? vaults.filter(v => v.id === wantedVault) : vaults;
			if (targets.length === 0) {
				throw new Error(wantedVault ? `资料库里没有这个 vault：${wantedVault}` : '资料库根下还没有任何 vault。');
			}
			// ⚠ 单 vault 才建（与壳侧同口径 ✓：buildVectorIndex 是合并索引 ⇒ 多库拆不出来 ⇒ 写出来会是
			//   "合并态却假装是某库的" ✗——`kbCommandService._rebuildVectorIndex` 的注释写清了 ✓）。
			if (targets.length > 1) {
				throw new Error(`向量索引一次只建一个 vault（多库会合并拆不开 ✗）：请用 vaultId 指定一个（库里有 ${targets.map(v => v.id).join(', ')}）。`);
			}
			const vault = targets[0];
			// 读所有 .md 笔记
			const docs = [];
			const { readdir, readFile, stat } = await import('node:fs/promises');
			const { join } = await import('node:path');
			const walk = async (dir, rel = '') => {
				const entries = await readdir(dir, { withFileTypes: true });
				for (const e of entries) {
					const full = join(dir, e.name);
					const r = rel ? `${rel}/${e.name}` : e.name;
					if (e.isDirectory()) { await walk(full, r); }
					else if (e.name.endsWith('.md')) {
						const text = await readFile(full, 'utf8');
						const st = await stat(full);
						docs.push({ uri: r, name: e.name, text, mtime: st.mtimeMs, size: st.size });
					}
				}
			};
			await walk(vault.dir);
			if (docs.length === 0) { throw new Error(`vault ${vault.id} 里没有 .md 笔记（没有可索引的文本）。`); }
			// 分块（与 IDE 同口径 ✓）
			const chunks = [];
			for (const doc of docs) {
				for (const c of chunkMarkdown(doc.text)) {
					chunks.push({ docId: doc.uri, docName: doc.name, section: 'concept', text: c.text, start: c.start });
				}
			}
			// 经桥批量取向量（embedding 模型在壳侧 ✓）
			if (!state.bridge || typeof state.bridge.callIDE !== 'function') {
				throw new Error('建向量索引要经桥回 IDE 取向量（embedding 模型在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const batchSize = Math.min(64, Math.max(1, Number.isFinite(params?.batchSize) ? Math.floor(params.batchSize) : 64));
			const vectors = [];
			let tag = '';
			let dimensions = 0;
			for (let i = 0; i < chunks.length; i += batchSize) {
				const batch = chunks.slice(i, i + batchSize).map(c => c.text);
				const reply = await state.bridge.callIDE('ide.request', {
					capability: 'kb',
					pluginId: 'vssaros-kb',
					params: { op: 'embedBatch', texts: batch },
				}, { timeoutMs: 5 * 60 * 1000 });
				const batchVectors = Array.isArray(reply?.vectors) ? reply.vectors : null;
				if (!batchVectors || batchVectors.length !== batch.length) {
					throw new Error(`第 ${i / batchSize + 1} 批向量化失败（IDE 回了 ${batchVectors?.length ?? 0} 个向量，要 ${batch.length} 个）`);
				}
				vectors.push(...batchVectors);
				if (!tag && reply?.tag) { tag = String(reply.tag); }
				if (!dimensions && reply?.dimensions) { dimensions = Number(reply.dimensions); }
			}
			// 写 .kvindex（与 IDE 同一份二进制契约 ✓）
			const indexData = {
				v: 1, tag, dimensions, builtAt: Date.now(),
				roots: [{ uri: vault.dir, section: 'concept' }],
				chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i], tag })),
			};
			const indexPath = join(vault.dir, '.kvindex');
			const { writeFile } = await import('node:fs/promises');
			await writeFile(indexPath, Buffer.from(serializeVectorIndexBinary(indexData)));
			return { ok: true, vaultId: vault.id, chunks: chunks.length, dimensions, tag, indexPath };
		},
	}];
}

/**
 * 写入类工具（审批闸只拦这些 ✓，见 README 5.104）。
 *
 * 为什么导出：跨模块守卫（`dshPluginPackages.test.ts`）拿它**机器核对** —— 名单非空 ✓、
 * 每个名字都真的被注册 ✓（防"闸挂了但名单是空的" ✗ 这种最像修好了的坏法 ✓）。
 */
export const WRITE_TOOLS = ['kb_feishu_sync', 'kb_feishu_spaces', 'kb_organize', 'kb_write_note', 'kb_mkdir', 'kb_build', 'kb_mindmap', 'feishu_drive_reply_comment', 'feishu_drive_add_comment', 'kb_reindex'];

/**
 * 这次调用**到底写不写**（决定要不要弹窗 ✓）。本模块的写工具分成**两类判据** ✓：
 *   · **参数敏感**（有只读/预览形态的）✗：`kb_feishu_sync` 只有 `apply: true` 才真写 ✓（dry-run 只出计划 ✓）、
 *     `kb_feishu_spaces` 只有 `action: 'create'` 才真写 ✓（`list` 只读 ✓）、飞书评论两件**有内容才问** ✓、
 *     `kb_organize` **有操作项才问** ✓（全空时它连盘都不碰 ✓）；
 *   · **一律问**（没有预览形态的）✗：`kb_write_note` / `kb_mkdir` —— 它们任何一次调用都会真写盘 ✓
 *     （连"空内容的空笔记"也是一次写入 ✓）⇒ 按参数放行会开出一个绕过审批的口子 ✗。
 * ⇒ 两种判据都收在本函数里 ✓：写在闸里会变成"一长串 &&/||"，下一个写工具接进来时最容易漏掉其中一个 ✓。
 * @returns `{reason, en, zh}` 或 `undefined`（= 放行走 next ✓）
 */
/**
 * 工具侧 "写哪个 vault" 的解析：**显式参数 → IDE 注入的当前库**。
 *
 * ★★ 2026-10-19（用户报「知识库读写的笔记目录应该为当前选择的笔记根目录」）：
 *   此前这些写工具**只认显式 `vaultId`**，多库时直接抛
 *   「请指明要写哪个 vault（现在有 N 个）」—— 而用户在页面上明明已经选了当前库，
 *   那个选择就是 `config.kbActiveVaultId`（页面渲染 :2960、`/api/doc` :5891、`/api/graph` :5854
 *   **全都用它兜底** ✓）⇒ 只有写工具漏了这一层，于是模型只能瞎猜或反复问 ✗。
 *   ⇒ 统一收在这里，与其它路由**同一口径**（不另立一套"默认库"规则 ✓）。
 *   ⚠ 显式参数仍然优先（模型/用户明确指定时必须听它的 ✓）。
 */
/**
 * 写操作的**落盘日志**（`<数据根>/kb-write.log`）。
 *
 * ★★ 2026-10-19（用户反复报「工具里写了错误的知识库目录」）：`kb_write_note` 之前
 *   **一行日志都不留** —— `.op-log.jsonl` 里只有 `feishu.sync`（那是 IDE 侧记录的），
 *   于是"到底用了哪个 vault、落点被纠正没有"完全查不到，只能靠猜 ✗。
 *   ⇒ 每次写都把三件事记下来：**请求的 vaultId / 实际用的 / 最终路径**。
 *   ⚠ 落点不能走 `foundation`（apply 阶段可能未绑定，见 skills 插件同名坑）⇒ 这里用
 *     `config.dataRoot` → `dataRootOf()`（try）→ `~/.vssaros-dev` 三级兜底。
 */
async function logKbWrite(config, line) {
	try {
		let root = '';
		const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
		if (configured) { root = configured; }
		else {
			try { root = dataRootOf(config) || ''; } catch { root = ''; }
		}
		// ⚠ `dataRootOf` 也可能**返回空**（不是只抛）⇒ 不判空就会 `join(undefined, …)` 抛，
		//   再被外层 catch 吞掉 ⇒ 日志又变成"静默不写"（这正是排查时最怕的形态 ✗）。
		if (!root) { root = join(homedir(), '.vssaros-dev'); }
		await appendFile(join(root, 'kb-write.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
	} catch { /* 日志失败不影响写入 */ }
}

async function vaultWantedOf(params, config) {
	const explicit = typeof params?.vaultId === 'string' ? params.vaultId.trim() : '';
	// 页面最后上报的当前库 → IDE 注回值
	let current = '';
	try {
		current = await readActiveVault({ readFile }, kbRootOf(config));
	} catch { /* 读不到就退回注入值 */ }
	if (!current) {
		current = typeof config?.kbActiveVaultId === 'string' ? config.kbActiveVaultId.trim() : '';
	}
	// ★★ 2026-10-19（用户拍板方案 A）：**当前库优先于模型显式参数**。
	//
	// 真机事故：用户页面选的是 `20260922123131-827wo3k`（我的知识库 / E:/VsSarosVault），
	//   而模型调 `kb_write_note` 时显式传了 `20260709063858-azbh1at` —— 它刚才 `kb_search`（**跨库** ✓）
	//   在那个库的「库」区搜到了素材，于是判断"内容在那儿"，笔记就写进了那个库 ✗。
	//   ⇒ 用户看不到笔记、另一个库却多了一篇（`笔记/00-入门与导读/...` 实测）。
	//
	// 现在的口径：**用户当前所在的位置就是默认落点**。模型想写别的库会被纠正，
	//   并把被纠正的值放进返回值（调用方要写进工具结果 ⇒ 模型和用户都能看见"落点被改过" ✓，
	//   静默改库是本仓明令禁止的那种"最难查" ✗）。
	//   ⚠ 想往别的库写 ⇒ 先在页面上切库（切库会上报 ✓）。
	if (current && explicit && explicit !== current) {
		return { vaultId: current, overriddenFrom: explicit };
	}
	return { vaultId: explicit || current };
}

/**
 * 免审白名单的**代码内默认值**。
 *
 * ★★ 2026-10-19 真机踩到：`cordis.patch.yml` 里明明配了 `autoApprove`（6 项），
 *   但运行时 `config.autoApprove` 是 **undefined** ⇒ 审批卡照弹 ✗。
 *   原因：VsSaros 给 `vssaros-kb` 注入的 `roots-*.yml` overlay **整体替换了这一行的 config**
 *   （里面只有 `kbVaults` / `kbActiveVaultId`）⇒ `cordis.patch.yml` 里的 `autoApprove` 被覆盖掉。
 *   ⇒ 默认值**必须落在代码里**（配置只用于覆盖），否则"配了却不生效"这类问题永远查不出来 ✓。
 *
 * 口径：`config.autoApprove` 显式给了就听它的（含**空数组 = 全部恢复逐次询问**）；没给用这份默认。
 */
const DEFAULT_AUTO_APPROVE = ['kb_mkdir', 'kb_write_note', 'kb_mindmap', 'kb_build', 'kb_reindex', 'kb_organize'];

/** 解析免审清单：显式配置优先（空数组 = 全关），否则用代码内默认。 */
function autoApproveOf(config) {
	const fromConfig = config?.autoApprove;
	if (Array.isArray(fromConfig)) { return fromConfig; }
	return DEFAULT_AUTO_APPROVE;
}

function writeIntentOf(name, args, autoApprove) {
	// ★★ 2026-10-19（用户报「kb 工具为什么每次都要授权，想加白名单」）：
	//   **免审白名单**（配置 `autoApprove: ['kb_mkdir', ...]`）—— 命中的工具**一律不问**。
	//
	// 为什么这层是安全的（不是"把闸拆了"）：审批只是**两层防护里的外层**，
	//   **内层路径校验仍然照跑** —— 比如截图里 `kb_write_note` 指向只读的「库」区时，
	//   工具自己会拒绝（"写入被拒 …… 笔记必须写进「笔记」区"），那条跟审批无关 ✓。
	//   所以白名单的语义是"**信任模型在合法位置写盘**"，不是"允许它乱写"✓。
	//
	// 为什么不做成"按参数放行"：`kb_mkdir` / `kb_write_note` 没有只读形态（任何一次调用都真写盘）
	//   ⇒ 按参数放行必然开出口子（见本函数下方"一律问"的注释）。白名单是**按工具名**的显式信任，
	//   由用户在配置里点名，默认空（= 保持原来的每次询问 ✓）。
	if (Array.isArray(autoApprove) && autoApprove.includes(name)) { return undefined; }

	if (name === 'kb_feishu_sync' && args?.apply === true) {
		return {
			reason: `${name} 会把飞书文档真正写入资料库目录`,
			en: `Allow ${name} to write synced docs into the knowledge base?`,
			zh: `允许 ${name} 把同步的文档写入资料库？`,
		};
	}
	if (name === 'kb_feishu_spaces' && args?.action === 'create') {
		return {
			reason: `${name} 会在**远端**新建飞书知识库（写飞书侧，不是本地文件）`,
			en: `Allow ${name} to create a Feishu wiki space remotely?`,
			zh: `允许 ${name} 在远端新建飞书知识库？`,
		};
	}
	// 飞书**写评论**两件（§R.7 第 ⑤ 项）：都在**别人的文档**上留下可见内容（真源也是 `Cautious` ✓）
	// ⇒ 必须过闸 ✓。判据同 organize ✓：**有内容才问** ✓（空 content 会在工具里当场拒绝 ⇒ 不该为它弹窗 ✗）。
	if ((name === 'feishu_drive_reply_comment' || name === 'feishu_drive_add_comment')
		&& String(args?.content ?? '').trim()) {
		return {
			reason: `${name} 会在**飞书文档**上留下可见的评论（别人的文档也可能在被评论之列）`,
			en: `Allow ${name} to post a comment on a Feishu document?`,
			zh: `允许 ${name} 在该飞书文档上发评论？`,
		};
	}
	if (name === 'kb_organize' && planCounts(args).total > 0) {
		return {
			// ⚠ 判据是 `planCounts(...).total > 0`（**含 copies** ✓）—— 加动词时漏掉 planCounts ⇒
			//   带那个动词的调用会不弹窗就写盘 ✗✗（见 kbOrganize.js 里那条警告 ✓）。
			reason: `${name} 会移动 / 复制 / 新建 / 「删除」（移入 vault 外备份）笔记区的文件`,
			en: `Allow ${name} to reorganize files in the notes area (moves/copies/creates/deletes-to-backup)?`,
			zh: `允许 ${name} 整理笔记区（移动 / 复制 / 新建目录 / 移入备份）？`,
		};
	}
	// 写正文 / 建目录（第 2 期）：**一律问** ✓ —— 与 sync / spaces 那种"参数敏感、可 dry-run"不同 ✗：
	// 它们**没有**预览模式（连空内容的"建空笔记"也是一次真写入 ✓），按参数放行会开出一个
	// "用空内容绕过审批"的口子 ✗ ⇒ 判据不带参数、任何一次调用都过闸 ✓（fail-closed ✓）。
	if (name === 'kb_write_note') {
		return {
			reason: `${name} 会写入知识库「笔记」区（vault 内）；replace 模式下旧正文会先移入 vault 外备份`,
			en: `Allow ${name} to write a note into the knowledge-base notes area?`,
			zh: `允许 ${name} 写入知识库笔记区的笔记？`,
		};
	}
	// 思维导图（P4 §16.14）：**两个 mode 都写盘** ✓（merge 会**删掉**被合并的源文件 ✗；generate 由宿主落盘 ✓）
	// ⇒ 一律问 ✓。⚠ generate 的子代理是**只读**的（只给 kb_read ✓，图谱 JSON 走回文 ✓）⇒ **没有批授权那套**，
	//   这张卡就是唯一的一张 ✓ —— 文案如实写 ✓。
	if (name === 'kb_mindmap') {
		const isMerge = args?.mode === 'merge';
		return {
			reason: isMerge
				? `${name} 会把多个 .canvas 合并成一个（写回第一个、**删掉其余**）`
				: `${name} 会起一个**只读**子代理读笔记、由宿主把思维导图写进「笔记」区（会覆盖同名 .canvas）`,
			en: isMerge
				? `Allow ${name} to merge canvas files (writes one, deletes the rest)?`
				: `Allow ${name} to generate/update a mind-map canvas in the notes area?`,
			zh: isMerge
				? `允许 ${name} 合并思维导图（写回一个、删掉其余）？`
				: `允许 ${name} 在笔记区生成/更新思维导图？`,
		};
	}
	if (name === 'kb_mkdir') {
		// ⚠ 理由要**如实**（它不覆盖任何东西 ⇒ 别提"备份" ✗）：审批文案是用户唯一能看到的审计口径 ✓
		return {
			reason: `${name} 会在知识库「笔记」区（vault 内）新建目录`,
			en: `Allow ${name} to create a directory in the knowledge-base notes area?`,
			zh: `允许 ${name} 在知识库笔记区新建目录？`,
		};
	}
	// `kb_build mode="build"`（2026-10-12 P0）：它**自己**不写盘，但会起一个子代理去写 ⇒ 必须过闸 ✓。
	// ★ 这张卡是**本批唯一的卡** ✓：批准后打开一个有界授权（篇数上限 = `batch`、TTL、仅限本 vault + 本会话 ✓），
	//   子代理随后的写入用它放行 ⇒ 不再逐篇弹窗 ✓（否则 N 篇 = N 张卡 ⇒ 审批疲劳 ⇒ 闸形同虚设 ✗）。
	// ⇒ 文案必须**写明这一点**（用户看得到，才知道自己在批准什么 ✓）——这是整条设计的披露点 ✓。
	if (name === 'kb_build' && args?.mode === 'build') {
		const batch = clampBatch(Number(args?.batch));
		return {
			// ⚠ 文案必须写**完整真相**（2026-10-13 真机修正 ✓）：子代理**自己**没有审批通道 —— 真源把委派出去的孩子
			//   钉成 `approvalPolicy: 'never'`（`dsh-subagent/lib/types/child-agent.d.ts:116-121`：
			//   "its asks are rejected deterministically" ✓）⇒ 所以批准这张卡**不是**"少弹几次"，
			//   而是"**这份授权是子代理唯一能写成笔记的途径**" ✗✗。只写"不再逐篇询问"会让人以为
			//   不批准只是多问几次（其实是**一篇也写不出来** ✗）——那是本仓最忌讳的"看起来答了、其实答的是别的" ✓。
			reason: `${name} 会起一个子代理把「库」里的素材构建成笔记（最多 ${batch} 篇）：`
				+ `⚠ 子代理**没有自己的审批通道**（平台把委派出去的孩子钉成 approvalPolicy=never ⇒ 它的确认请求会被**确定性拒绝** ✗）`
				+ `⇒ 批准后，本批对**本 vault** 的笔记写入（含新建目录）由**这份批授权**放行、**不再逐篇询问**`
				+ `（篇数上限 ${batch}、${Math.round(GRANT_TTL_MS / 60000)} 分钟后自动失效 ✓）；不批准则本批一篇也写不出来 ✓`,
			en: `Allow ${name} to build up to ${batch} library sources into notes via a subagent? `
				+ `NOTE: a delegated subagent has NO approval channel (the platform pins it to approvalPolicy=never, so its asks are rejected deterministically) `
				+ `— this grant is the only way its note writes can happen. Once approved: up to ${batch} note writes in this vault, no further prompts, expiring in ${Math.round(GRANT_TTL_MS / 60000)} minutes.`,
			zh: `允许 ${name} 起子代理把最多 ${batch} 份素材构建成笔记？注意：子代理没有自己的审批通道（平台把它钉成 approvalPolicy=never，它的确认一律被拒）`
				+ `——这份授权是它唯一能写成笔记的途径；批准后本批写入本 vault 的笔记不再逐篇询问（上限 ${batch} 篇，${Math.round(GRANT_TTL_MS / 60000)} 分钟后失效）。`,
		};
	}
	return undefined;
}

/**
 * 这次写到底算**谁**在写 ⇒ 交给 `grantAllows` 的**归属集合**。
 *
 * ★ 为什么不能只看 `exec.agent.id`（2026-10-13 p3-45 真机抓到，本条是本轮最值钱的一个修正）：
 *   构建是**子代理**去写的，而子代理的工具调用带的是**孩子自己的** agent id ✗ ⇒ 只比批准者会话 id
 *   的话，授权对真正的写者**永不命中** ⇒ 子代理每次写都被拒（实测报 `the user rejected tool "kb_write_note"`）
 *   ⇒ 笔记一篇都写不出来 ✗✗。血缘取自**子会话 header**：真源 `childSessionMeta()`
 *   （`dsh-subagent/lib/index.js:470-480`）写明 `parentSession: parentHeader.id`、
 *   `origin: 'subagent'`、`delegationDepth: childDepth` ✓ ⇒ "孩子的 header.parentSession = 批准者会话 id" ✓。
 * ⚠ 只认**直接**父子：`maxDepth: 1` ⇒ 不会有孙子 ✓（真有也会因 parentSession 指向孩子而不匹配 ✓）。
 * @param agent `exec.agent`（可能拿不到 ⇒ 空集合 ⇒ fail-closed 不放行 ✓）
 * @returns 非空字符串数组（本会话 id[、派生它的父会话 id]）
 */
function writeActorIds(agent) {
	const ids = [];
	if (typeof agent?.id === 'string' && agent.id) {
		ids.push(agent.id);
	}
	const parentSession = agent?.session?.header?.parentSession;
	if (typeof parentSession === 'string' && parentSession) {
		ids.push(parentSession);
	}
	return ids;
}

/**
 * 写完盘之后刷新导航两件（`笔记/index.md`、`笔记/overview.md`）。
 *
 * 口径见 `core/kbNavigation.js` 文件头（**逐字**照真源 ✓，交叉校验在 IDE 侧测试
 * `kbNavigationParity.test.ts` ⇒ 两侧**逐字节**相同 ✓）。真源在每次构建/整理之后都会刷一次
 * （`kbImportController.ts` 里 `maintainKbNavigation` 的那些调用点 ✓），我们挂在同一批路径上 ✓。
 *
 * ⚠ 刷新**失败不该让写入失败** ✗：导航是"派生视图"，笔记正文才是用户的东西 ⇒ 真源那边也是
 *   `catch(() => undefined)` 照常返回 ✓（这里改成把错误带进回执，比静默吞掉更好 ✓）。
 * ⚠ `config.maintainNavigation === false` 可整体关掉（本仓纪律：新行为要**可回退** ✓）。
 * @returns `{ written, unchanged, scanned }` / `{ error }` / `undefined`（关掉了）
 */
async function refreshDerived(vaultRoot, config, targets = []) {
	if (config?.maintainNavigation === false) {
		return undefined;
	}
	try {
		const notesDir = join(vaultRoot, '笔记');
		// ★ 顺序照真源：先刷导航、再跑门控（`maintainKbNavigation` 之后才 `applyDeabstractionGating` ✓）
		// 真源顺序：来源注入（子代理写 frontmatter 时自带 ✓）→ **补链** → 导航 → 门控 ✓
		const enrichment = await enrichNotes(notesDir, targets);
		const navigation = await maintainNavigation(notesDir);
		const gating = await applyGating(notesDir, vaultRoot);
		// ★ 末尾重建 FTS 内核缓存（`.kbkernel.json` ✓ —— 2026-10-13 §16.8 纠偏：真源运行时就写它 ✓）：
		//   改了笔记 ⇒ 检索/页面要能立刻看到新数据 ⇒ 重建缓存是"写"的收尾 ✓。
		//   ⚠ **各自 try** ✗：缓存是**可再生**的（丢了重建即可 ✓）⇒ 它失败**不该**让写入失败 ✓
		//     （与上面那句"刷新失败不该让写入失败"同一条 ✓）—— 但要把失败**带进回执** ✓（不许静默吞 ✗）。
		let kernel;
		try {
			const rebuilt = await rebuildKernelCache(vaultRoot);
			kernel = { docs: rebuilt.docs.length, path: rebuilt.path };
		} catch (e) {
			kernel = { error: String(e?.message ?? e) };
		}
		return { ...navigation, gating, enrichment, kernel };
	} catch (e) {
		return { error: String(e?.message ?? e), written: [], unchanged: [], scanned: 0 };
	}
}

/** 回执行：如实写清刷了哪些、以及**哪些没刷**（没刷的要在 IDE 侧刷 ✓）。 */
function navLine(nav) {
	if (!nav) {
		return '';
	}
	if (nav.error) {
		return `⚠ 导航未刷新：${nav.error}（笔记本身已写入 ✓；可在 IDE 侧刷一次导航 ✓）`;
	}
	const what = nav.written.length ? nav.written.join('、') : `内容无变化（${nav.unchanged.join('、')}）`;
	// 门控那一格：派生类笔记按「同义归一后的 distinct 来源数」定 active / pending（与 IDE 同规则 ✓）
	// 补链那一格：只在真有新增链接时报（"0 篇"是噪音 ✓）
	const enrichTotal = (nav.enrichment?.enriched ?? []).reduce((sum, item) => sum + item.titles.length, 0);
	const enrichLine = enrichTotal > 0 ? `；补链：${nav.enrichment.enriched.length} 篇共新增 ${enrichTotal} 条 [[链接]]（知识图谱的边 ✓）` : '';
	// 图谱洞察那一格（导航三件里的一件 ✓：社区数 + 链接数，最能说明"图连通性" ✓）
	const insightsLine = nav.insights ? `；图谱洞察：${nav.insights.communities} 个社区（${nav.insights.nodes} 节点 / ${nav.insights.edges} 条链接 ✓）` : '';
	const gatingLine = nav.gating ? `；门控：${nav.gating.active} 篇正式 / ${nav.gating.pending} 篇候选（来源数 < ${MIN_DISTINCT_SOURCES} ⇒ 候选 ✓，与 IDE 同一套规则）` : '';
	// FTS 内核缓存那一格（§16.6 ✓）：失败要**说出来**（不静默吞 ✗ —— 缓存可再生，但"没刷"得让人知道 ✓）
	const kernelLine = nav.kernel
		? (nav.kernel.error ? `；⚠ FTS 缓存未重建：${nav.kernel.error}` : `；FTS 缓存：${nav.kernel.docs} 篇已重建 ✓`)
		: '';
	return `导航：${what}（扫到 ${nav.scanned} 篇 ✓）${enrichLine}${gatingLine}${insightsLine}${kernelLine}；⚠ 各目录 .overview.md（目录摘要中间层，**要模型**）不在 dsh 侧维护 ⇒ 要它最新请在 IDE 侧刷一次 ✓`;
}

/**
 * 构建子代理默认用哪个 provider（`config.subagentProvider` 可覆盖 ✓）。
 * 为什么默认 `fork`：进程内 fork 子代理**不额外起进程**（`dsh-subagent-fork-in-process` README ✓），
 * 而我们要它做的只是"读几篇素材、写几篇笔记" ⇒ 没有隔离诉求 ✓。
 */
const DEFAULT_SUBAGENT_PROVIDER = 'fork';

/**
 * 子代理**只能看见**这些工具（结构性限制，不是提示词请求 ✓）。
 *
 * 为什么这条比提示词重要一万倍：`ToolRestriction.allow` 的语义是"其余工具**从可见面移除**" ✓
 *（`@deepseek-ai/dsh-tools` 的 `ToolRestriction` 注释原话："Global tool names that stay visible; everything else is removed."），
 * 而 dsh 原生 `write` / `edit` 在 vault 上会吃 `FS_SANDBOX_DENIED`（vault 在会话工作区外 ✓）。
 * ⇒ 与其在提示词里求它别用（它可能试、可能绕 ✗），不如**直接不给它** ✓：
 * 剩下的只有我们的 kb_* 工具 ⇒ 写笔记只能经 `kb_write_note`（同一把锁 + 同一套备份 + 同一道闸 ✓）。
 * ⚠ 注意是**白名单**：dsh 以后新增的工具不会被自动放进来 ✓（孩子的能力面不会随基座升级而悄悄变宽 ✓）。
 */
export const KB_BUILD_CHILD_TOOLS = ['kb_read', 'kb_list', 'kb_search', 'kb_topic_overviews', 'kb_write_note', 'kb_mkdir'];

/**
 * 子代理的任务书（写死在这里，不在参数里让调用方拼 ✗ —— 编排的**契约**是模块自己的 ✓）。
 * 每条都对应一个已知的坑：vault 在沙箱外、导航文件归 IDE、已存在要 replace、失败要如实说 ✓。
 */
export function buildChildPrompt({ vaultId, files, batch, remaining }) {
	return [
		'你在把一个知识库 vault 的「库」区素材**归纳成笔记**（写进「笔记」区）。严格照下面做：',
		`1. 素材只有这些（用 kb_read 读，路径就是下面给的，别猜别的）：\n${files.map(file => `   - ${file.path}`).join('\n')}`,
		`2. 每份素材写/更新一篇笔记，**必须**用 kb_write_note（vaultId="${vaultId}"，path 形如 笔记/<分类>/<标题>.md）。`,
		'   · 目标笔记已存在时用 mode="replace" 覆盖（它会先把旧正文移入 vault 外备份 ✓）；不要试图用别的工具绕。',
		// ★ `sources` 必须写（2026-10-13 P2 第二刀）：门控按"这篇笔记被几个**不同来源**确认过"定 active/pending ——
		//   不写 sources 的派生笔记**永远停在候选**（等于白构建 ✓）。真源的构建路径是宿主**注入**来源
		//   （`_injectSourcesIntoFiles` ✓），我们这条路上笔记由子代理写 ⇒ 只能要求它自己写 ✓
		//   （真源的 agentic 路径也是这么要求的：Phase 1 "写笔记（带 sources frontmatter）" ✓）。
		'   · **frontmatter 必须写 `sources`**（这篇笔记用了哪几份素材 ✓），块序列写法即可：',
		'     `sources:` 换行后每行一条 `  - [[库/概念/素材甲.md]]`（就是上面素材清单里的路径 ✓）。',
		'     为什么较真：知识库按"**不同来源**数"决定这篇派生笔记算正式还是候选（≥2 才算正式 ✓）——',
		'     不写 `sources` 的笔记会被一直标成候选，等于这次构建白做 ✓。',
		// ★ `type` 也必须写（2026-10-13 真机 P1 收尾）：门控**只认**派生类四种 type
		//   （`core/kbGating.js` 的 GATED_TYPES ＝ concept / comparison / synthesis / entity ✓），其它一律跳过 ✗
		//   ⇒ 不写 type 的笔记**既不会被门控处理、也登记不进构建缓存**（缓存靠 sources 反查 ✓）
		//   ⇒ 现象是「建完了、看着都对，但 status 不落、下次 preview 又把这批算成待构建」✗✗（静默失效 ✓）。
		//   （真源由 schema 分类给出 type ✓；我们这条路上只能要求子代理自己写 ✓。）
		'   · **frontmatter 也要写 `type`**，取值四种之一：`concept` / `comparison` / `synthesis` / `entity`（按内容选 ✓）；',
		'     不写它就进不了门控（既不会被标成候选 / 正式，也登记不进构建缓存）✓。',
		// ★ `type` 也必须写（2026-10-13 真机 P1 收尾）：门控**只认**派生类四种 type
		//   （`core/kbGating.js` 的 GATED_TYPES ＝ concept / comparison / synthesis / entity ✓），其它一律跳过 ✗
		//   ⇒ 不写 type 的笔记**既不会被门控处理、也登记不进构建缓存**（缓存靠 sources 反查 ✓）
		//   ⇒ 现象是「建完了、看着都对，但 status 不落、下次 preview 又把这批算成待构建」✗✗（静默失效 ✓）。
		//   （真源由 schema 分类给出 type ✓；我们这条路上只能要求子代理自己写 ✓。）
		'   · **frontmatter 也要写 `type`**，取值四种之一：`concept` / `comparison` / `synthesis` / `entity`（按内容选 ✓）；',
		'     不写它就进不了门控（既不会被标成候选 / 正式，也登记不进构建缓存）✓。',
		// ★ 第 3 条 2026-10-13 按真源改准（P2）：
		//   · `index.md` / `overview.md` 现在由**宿主**（我们）在任务结束后刷新 ✓ ⇒ 子代理别动它们
		//     （它写了也会被覆盖 ⇒ 白白浪费一轮 ✓）；
		//   · 而 `知识体系.md` 在真源里**正是构建的一部分**：kb-build 手册 Phase 2 的原话是
		//     "依据笔记区当前真实的目录与文件，创建或完善 `知识体系.md`"（`kbImportController.ts:1665` ✓）
		//     ⇒ 原来那条"不许动知识体系.md"是**错的** ✗（照它做出来的库，在 IDE 侧看就是"缺了体系文档" ✓）。
		'3. 不许改「库」区素材，也不许动 `笔记/index.md` 与 `笔记/overview.md`（这两个导航文件由宿主在任务结束后自动重建 ⇒ 你写了也会被覆盖）。',
		'   但**要**收尾时创建/完善 `笔记/知识体系.md`（vaultId 同上，用 kb_write_note ✓）：它是「知识体系」文档本身 ——'
			+ '依据你这次看到的真实目录与笔记，写清各分类下有什么、彼此什么关系；已存在就 mode="replace" 更新它 ✓。',
		`4. 本批最多 ${batch} 份（这里给了 ${files.length} 份）；${remaining > 0 ? `另有 ${remaining} 份留给下一次调用 ✓` : '这批就是全部 ✓'}。`,
		'5. 收尾时如实回报：新建/更新了哪几篇、哪几份没做成、为什么（失败的照实说，不要假装成功）。',
	].join('\n');
}

/**
 * ★ 起一次"思维导图生成"任务（2026-10-14，§16.17）—— **两个调用方共用这一份** ✓：
 *   ① `kb_mindmap mode="generate"`（模型显式要求 ✓）；
 *   ② `kb_build` 构建收尾后的**自动生成**（真源"导入后防抖生成"的 dsh 等价 ✓，见下面那段注释 ✓）。
 *
 * ⚠ 导出只为**跨模块守卫/探针**核对（与 `WRITE_TOOLS` 同一手法 ✓）—— 不是给外部调用的 API ✓。
 * @param {object} o
 * @param {boolean} [o.strict] true ⇒ 缺服务/缺会话身份时**抛错**（工具路径：模型必须知道为什么 ✓）；
 *   false ⇒ 返回 `{ok:false,message}`（自动路径：不能让"顺带做的事"炸掉构建收尾 ✓）。
 */
export async function startMindmapGenerateJob({ ctx, config, vault, parent, provider, count, strict = false }) {
	const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined;
	const subagents = typeof ctx?.get === 'function' ? ctx.get('subagents') : undefined;
	if (!jobs || !subagents || typeof jobs?.start !== 'function' || typeof subagents?.start !== 'function') {
		const message = '本侧现在生成不了：这个组合里缺少 jobs / subagents 服务 ⇒ 请把它们装进 profile，或到 IDE 侧生成 ✓（不会静默退化 ✗）。';
		if (strict) { throw new Error(message); }
		return { ok: false, message };
	}
	if (!parent || typeof parent.id !== 'string' || !parent.id) {
		const message = '拿不到当前会话身份（exec.agent）⇒ 无法把任务挂到会话名下 ✓。';
		if (strict) { throw new Error(message); }
		return { ok: false, message };
	}
	const notesDir = join(vault.dir, NOTES_DIR);
	const n = Math.min(20, Math.max(1, Number.isFinite(count) ? Math.floor(count) : 5));
	// 最近改动的 N 篇笔记（跳过系统导航文件 ✓；.canvas 不是 md ⇒ 天然不在 ✓）
	const notes = [];
	const walkNotes = async (dir) => {
		let entries = [];
		try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.')) { continue; }
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) { await walkNotes(abs); continue; }
			if (!entry.name.endsWith('.md') || SYS_INDEX_FILES.includes(entry.name)) { continue; }
			let info;
			try { info = await stat(abs); } catch { continue; }
			notes.push({ abs, mtime: info.mtimeMs });
		}
	};
	await walkNotes(notesDir);
	notes.sort((a, b) => b.mtime - a.mtime);
	const chosen = notes.slice(0, n);
	if (!chosen.length) {
		return { ok: false, message: '笔记区里还没有笔记 ⇒ 没东西可提取 ⇒ **没有起任务**（没活儿干不是错误 ✓）。' };
	}
	const newContents = [];
	for (const note of chosen) {
		newContents.push({ fileName: note.abs.slice(notesDir.length + 1).replace(/\\/g, '/'), content: await readFile(note.abs, 'utf8') });
	}
	const chosenProvider = (typeof provider === 'string' && provider.trim())
		|| (typeof config?.subagentProvider === 'string' && config.subagentProvider.trim())
		|| DEFAULT_SUBAGENT_PROVIDER;
	const existing = await listMindmaps(notesDir);
	// ⚠ 已有导图的选择照真源"自动生成"那一路：优先 `mindmap.canvas`，否则第一个 ✓
	const existingPath = existing.get('mindmap.canvas') ?? [...existing.values()][0];
	const { system, user } = extractGraphPrompt(newContents);
	const jobId = jobs.start({
		kind: 'kb-mindmap',
		label: `kb-mindmap ${vault.id}（${chosen.length} 篇）`,
		owner: parent.id,
		run: () => {
			const controller = new AbortController();
			return {
				cancel: reason => controller.abort(reason ?? 'kb-mindmap 被取消'),
				done: (async () => {
					// ⚠ 与 kb_build 同一个坑 ✗：`subagents.start` 在"孩子被创建"时就 resolve ⇒
					//   必须再 await run.result 才算跑完 ✓（真机抓过 ✓）。
					const run = await subagents.start(chosenProvider, {
						label: `kb-mindmap ${vault.id}`,
						prompt: [{ type: 'text', text: `${system}\n\n${user}\n\n⚠ 只输出 JSON 本体（不要 markdown 围栏、不要任何解释 ✓）—— 你的最终回复会被宿主当 JSON 解析 ✓。` }],
						parent,
						signal: controller.signal,
						toolFilter: { allow: ['kb_read'] },   // 结构性只读 ✓（写由宿主做 ✓）
						maxDepth: 1,                         // 与 kb_build 同口径 ✓（0 = 一个回合都跑不了 ✗）
					});
					const result = await run.result;
					// ⚠ result.output = 最后一条非空 assistant 消息的 ContentBlock[]（真源 lifecycle ✓）
					const replyText = (Array.isArray(result?.output) ? result.output : []).map(block => String(block?.text ?? '')).join('\n');
					const extracted = parseExtractedGraph(replyText);
					if (!extracted) { return { ok: false, error: '子代理没给出可解析的图谱 JSON ⇒ **不写盘**（回文已丢弃 ✓，不硬凑 ✗）。' }; }
					const release = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库思维导图生成' });
					let saved;
					try {
						saved = await mergeAndSaveMindmap(notesDir, extracted, existingPath);
						await refreshDerived(vault.dir, config);
					} finally {
						await release();
					}
					if (!saved) { return { ok: false, error: '提取出的图谱是空的 ⇒ 没写盘 ✓。' }; }
					return { ok: true, path: saved.path, nodes: saved.nodes, edges: saved.edges };
				})(),
			};
		},
	});
	return {
		ok: true, jobId,
		message: `已起思维导图生成任务：jobId=${jobId}（读最近 ${chosen.length} 篇笔记 ⇒ 子代理只读提取 ⇒ 宿主合并落盘${existingPath ? `到 ${existingPath.split(/[\\/]/).pop()}` : '（新建，名字从内容推导）'} ✓）。进度用 job_output。`,
	};
}

/**
 * 起一次构建任务（`kb_build mode="build"` 的编排体）。
 *
 * 形状完全照 dsh 自己的 `dsh-tool-subagent`（本轮实测读过它的实现 ✓）：
 *   `jobs.start({ kind, label, owner, run: () => ({ cancel, done: subagents.start(provider, request) }) })`
 * ⇒ **立即返回 jobId**，进度/取消复用基座的 jobs 名册与 `job_output/job_list/job_kill` ✓（不自己写调度 ✓）。
 *
 * ★ 三处必须如实拒绝的情形（宁可报错，不静默退化 ✓）：
 *   ① 组合里没有 `jobs` / `subagents` 服务 ⇒ 报错并指路 IDE 侧；
 *   ② 拿不到会话身份（`exec.agent`）⇒ 报错（它同时是 jobs 的 `owner` 与子代理的 `parent` ⇒ 缺了就挂不上 ✓）；
 *   ③ 起任务抛错 ⇒ **不留授权**（否则"批被批准了、活儿没起、授权却挂着" ✗）。
 */
async function startBuildJob({ ctx, state, config, vault, pending, params, exec, batchGrantEnabled }) {
	const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined;
	const subagents = typeof ctx?.get === 'function' ? ctx.get('subagents') : undefined;
	if (!jobs || !subagents || typeof jobs?.start !== 'function' || typeof subagents?.start !== 'function') {
		const missing = [!jobs ? '`jobs`（后台任务服务，@deepseek-ai/dsh-jobs + dsh-jobs-local）' : '', !subagents ? '`subagents`（子代理服务，@deepseek-ai/dsh-subagent + 一个 provider）' : ''].filter(Boolean).join(' 与 ');
		throw new Error(`本侧现在构建不了：这个组合里缺少 ${missing} ⇒ 请把它们装进 profile，或到 IDE 的「知识库」视图里点「批量构建库」✓（本工具**不会**静默退回 preview ✗）。`);
	}
	const parent = exec?.agent;
	if (!parent || typeof parent.id !== 'string' || !parent.id) {
		throw new Error('拿不到当前会话身份（工具执行上下文的 `agent`）⇒ 无法把构建任务挂到会话名下（它同时是任务的 owner 与子代理的 parent）：请用 mode="preview" 看清单，或到 IDE 侧构建 ✓。');
	}
	if (!pending.length) {
		return { ok: true, mode: 'build', vault: vault.id, pendingCount: 0, message: '没有待构建素材 ⇒ **没有起任何任务**（没活儿干不是错误 ✓）。' };
	}
	const batch = clampBatch(Number(params?.batch));
	const chosen = pending.slice(0, batch);
	const provider = (typeof params?.provider === 'string' && params.provider.trim())
		|| (typeof config?.subagentProvider === 'string' && config.subagentProvider.trim())
		|| DEFAULT_SUBAGENT_PROVIDER;

	let jobId;
	try {
		jobId = jobs.start({
			kind: 'kb-build',
			label: `构建 ${chosen.length} 份素材为笔记`,
			owner: parent.id,
			run: () => {
				const controller = new AbortController();
				return {
					cancel: reason => controller.abort(reason ?? 'kb-build 被取消'),
					// ★ 子代理跑完之后刷新导航两件（`笔记/index.md`、`笔记/overview.md`）——
					//   真源在构建之后也是立刻 `maintainKbNavigation` ✓。放在 `done` 的收尾（**成功/失败都刷**：
					//   失败时也可能已经写了半批 ✓），且刷新失败**不影响任务结论**（`refreshNavigation` 自己吞错 ✓）。
					// ⚠ 必须是**同步调用** `subagents.start`（async IIFE 在第一个 await 之前是同步执行的 ✓）——
					//   否则 `p3-44` 那种"`run()` 一返回就查假服务的调用账本"的断言会查不到 ✗。
					done: (async () => {
						try {
							// ⚠⚠ **不要**直接 return `await subagents.start(...)` ✗（2026-10-13 真机定位的根因）：
							//   `subagents.start` 返回的是 **run 句柄**（真源 `dsh-subagent/lib/index.js:3142` 原话是
							//   "Post-publication turn and infrastructure failures **settle through the returned run**" ✓，
							//   实现就是 `return observeRun(...)` ✓）⇒ 它在"**孩子被创建**"时就 resolve ✗。
							//   ⇒ 原来我们把收尾（导航/门控/补链/缓存登记）挂在它后面 ⇒ 收尾跑在**落盘之前**：
							//     实测回执写着「登记 0 条；扫到 **0 篇笔记** / 2 份素材」✗，
							//     而真机上看得到的 index/status **全是子代理自己那次 `kb_write_note` 触发的派生维护**留下的 ✓
							//     （同一套代码 ⇒ 看起来一样，触发时机完全不同 ✗）。
							//   ⇒ 必须**再 await `run.result`** 才算"孩子跑完" ✓（假服务没有 result 时 `await undefined` 也安全 ✓）。
							const run = await subagents.start(provider, {
						label: `kb-build ${vault.id} × ${chosen.length}`,
						// ⚠ `prompt` 是 **ContentBlock[]**（不是字符串 ✗，本轮实测真源字段 ✓）
						prompt: [{ type: 'text', text: buildChildPrompt({ vaultId: vault.id, files: chosen, batch, remaining: pending.length - chosen.length }) }],
						// ⚠ `parent` 是**必填的 Agent 对象**（真源类型 ✓）—— 正是 exec.agent ✓
						parent,
						signal: controller.signal,
						// ★ 结构性限制：孩子只见这几件工具（原生 write/edit 不在里面 ✓）
						toolFilter: { allow: KB_BUILD_CHILD_TOOLS },
						// ⚠⚠ `maxDepth` 是**孩子深度的绝对上限**，不是"还能往下派几层" ✗✗ ——
						// 2026-10-13 真机抓到：原来写 `0`（我以为＝"孩子不许再派"）⇒ 真服务当场抛
						// `SubagentDepthError: subagent depth 1 exceeds maxDepth 0` ⇒ **任务起来就失败、子代理一个回合都没跑**
						//（而 p3-44 的假服务照单全收 ⇒ 那一轮"全绿"是假绿 ✗）。真源：
						// `dsh-subagent/lib/index.js:400-403` `resolveChildDepth()`（childDepth = 父 + 1，
						// `childDepth > maxDepth` 即抛 ✓）＋ 服务自己的 config schema 缺省就是 **1**（同文件 L2822 ✓）。
						// ⇒ 传 1：孩子本身可以有（深度 1 ✓），它再往下派（深度 2）会被拒 ✓ —— 正是我们要的意思 ✓。
						maxDepth: 1,
							});
							return await run?.result;
						} finally {
							// ★ 补链目标 = 本批**授权放行**时记下的那些笔记（见闸里那行 ⇒ 正是子代理写的 ✓）
							const writtenNotePaths = [...state.grantWrites].map(rel => join(vault.dir, rel));
							// ★ 三步**互相隔离**（2026-10-13 真机抓到 ✗）：原来这里直接 await refreshDerived ⇒
							//   它一抛（导航/门控/补链任一环），**后面的登记构建缓存整段就被跳过** ✗✗
							//   ⇒ 现象是「门控落了 status ✓、缓存却没有」—— 又一处「静默少做一件事」✓。
							//   ⇒ 各自 try + 各自记账，并在 preview 回执里说出来 ✓（失败不许被吞 ✗）。
							try {
								await refreshDerived(vault.dir, config, writtenNotePaths);
								state.lastDerivedError = undefined;
							} catch (e) {
								state.lastDerivedError = String(e?.message ?? e);
							}
							state.grantWrites.clear();
							// ★ P1（2026-10-13）：把本批**确实产出**的笔记登记进构建缓存 ✓
							//   不登记 ⇒ 下一次 preview 把同一批**再算成待构建** ✗（"越用越不准" ✓，见 doc §3 / D3）。
							//   三条协议在 core/kbBuildCache.js 文件头（**只增不删** / 锁内 read-modify-write / **有歧义就不登记** ✓）；
							//   残余风险**如实承认** ✗：IDE 侧整理器不加锁 ⇒ 同一瞬间并发写仍可能丢**一条**
							//   （丢的那条下次会被重新算成待构建 ✓，而真源的构建语义是**就地 patch** 那篇笔记 ⇒ 不是灾难 ✓）。
							//   ⚠ 登记目标 = **本批素材**（chosen ✓）＋ **扫「笔记」区得到的真实产出**（由读盘决定 ✓，与"谁写的"无关 ✓）——
							//     绝不按"我以为它写了"来记 ✗；失败也**不影响任务结论**（记进 state 让回执如实说 ✓）。
							try {
								const release = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库构建缓存' });
								try {
									// ⚠ `chosen` 的元素是 **`{ path, reason }` 对象**（`previewBuild` 的产物 ✓），不是路径字符串 ✗ ——
									//   2026-10-13 由 p3-66 抓到：直接把它当 `sources` 传 ⇒ 每条都变成 `"[object Object]"` ⇒
									//   basename 比较全不中 ⇒ **登记 0 条**（而它**一点错都不报** ✗，只是静默不登记 ✓）。
									state.lastBuildCache = await registerBuildCacheEntries(vault.dir, { sources: chosen.map(item => item.path) });
								} finally {
									release();
								}
							} catch (e) {
								state.lastBuildCache = { error: String(e?.message ?? e) };
							}
							// ★ 自动生成思维导图（2026-10-14 §16.17）：**真源"导入后防抖生成"的 dsh 等价** ✓ ——
							//   真源是"库有文件变化 ⇒ 30 秒防抖 ⇒ generateOrUpdate"（视图级事件 ✓）；
							//   dsh 侧**没有文件监听** ✗，但有"**我自己的构建真写完了**"这个真触发点 ✓
							//   ⇒ 挂在构建收尾（比真源更准：不是"目录动过"，是"笔记真的落地了"✓）。
							//   ⚠ 三条纪律：① 顺带做的事**不许炸收尾** ✗ ⇒ 非 strict（失败记账 ✓ 并进回执 ✓）；
							//     ② `config.autoMindmap === false` 可关（可回退 ✓）；③ 它是**另一个 job**（不阻塞本任务 ✓）。
							if (config?.autoMindmap !== false) {
								try {
									const mm = await startMindmapGenerateJob({ ctx, config, vault, parent, count: 5 });
									state.lastMindmap = mm.ok ? { jobId: mm.jobId } : { error: mm.message };
								} catch (e) {
									state.lastMindmap = { error: String(e?.message ?? e) };
								}
							}
						}
					// ★ 把**收尾结果**并进任务回执（2026-10-13，additive ✓：原来是子代理结果本身 ✓）——
					//   真机上"缓存没被登记"这种问题，光看产物反推很苦 ✗；让它出现在 job_output 里 ⇒ 一眼看到原因 ✓。
					})().then(result => {
						const finish = { cache: state.lastBuildCache ?? null, derivedError: state.lastDerivedError ?? null };
						return (result && typeof result === 'object' && !Array.isArray(result)) ? { ...result, kbBuildFinish: finish } : { result, kbBuildFinish: finish };
					}),
				};
			},
		});
	} catch (e) {
		state.grant = undefined;
		throw new Error(`起构建任务失败（**没有留下任何授权** ✓）：${String(e?.message ?? e)}`);
	}
	// ★ 顺序：**先起任务、后开授权** ✓ —— 反过来的话，起任务失败会留下一个没人用的空白授权 ✗
	state.grant = batchGrantEnabled ? openGrant({ vaultId: vault.id, ownerId: parent.id, writes: chosen.length }) : undefined;
	return {
		ok: true,
		mode: 'build',
		vault: vault.id,
		jobId,
		batch: chosen.length,
		pendingCount: pending.length,
		provider,
		childTools: KB_BUILD_CHILD_TOOLS,
		// ⚠ 关闭批授权的后果**不是**"多问几次"，而是"子代理一篇都写不出来"（它没有审批通道 ✓ 见 core/kbBatchGrant.js 文件头）⇒ 如实写 ✓
		...(state.grant ? { grant: describeGrant(state.grant) } : { grant: '（批授权已关闭 ⇒ 子代理没有审批通道，本批一篇都写不出来）' }),
		message: [
			`已起构建任务：jobId=${jobId}（kind=kb-build，owner=${parent.id}）✓`,
			`本批 ${chosen.length} 份（待构建共 ${pending.length} 份${pending.length > chosen.length ? `，另 ${pending.length - chosen.length} 份留给下次` : ''}）；provider=${provider}；子代理可用工具=${KB_BUILD_CHILD_TOOLS.join(',')}`,
			state.grant
				? `批授权：${describeGrant(state.grant)}（批准这张卡时已写明"本批不再逐篇询问" ✓）`
				// ★ 如实说清后果（2026-10-13 真机：子代理的确认请求被**确定性拒绝** ⇒ 没授权就写不出来 ✓）
				: '批授权已关闭（config.batchGrant=false）⇒ ⚠ 子代理**没有审批通道**（平台把它钉成 approvalPolicy=never）：本批的笔记写入会被确定性拒绝，**一篇也写不出来** ✓',
			// ★ P1：缓存写入要对用户可见 ✓（我们不写时如实说、开始写了也要如实说 ✓）
			'收尾（子代理跑完之后）会刷新导航三件、并把本批**确实产出**的笔记登记进 `.kb-build-cache.json`（素材绝对路径 → 笔记绝对路径 ✓，**只增不删** ✓）—— 登记后下一次 preview 不再把它们算成待构建 ✓；有歧义（同名素材 / 一素材被两篇笔记声明）的条目会**跳过并说明** ✓。',
			'⚠ 残余风险：IDE 侧整理器**不加锁** ⇒ 它与我们同一瞬间写这份缓存时仍可能丢**一条** ✗（丢的那条下次会被重新算成待构建，重建时**就地 patch** 那篇笔记 ✓）。',
			'进度与取消用 dsh 自己的任务面板，或 job_output / job_list / job_kill ✓（本工具**不 awaits** 构建 —— 它是分钟级长任务 ✓）。',
		].join('\n'),
	};
}


/**
 * 飞书设置读取（默认值兜底）。
 * 与 `/api/kb-settings` 用同一份文件，避免"页面改了但同步读不到"。
 */
async function readFeishuSettings(config) {
	const base = { enabled: false, schedule: false, scheduleMinutes: 60, intervalMs: 800, conflict: 'skip', deleteRemote: false, mappings: [], cliPath: '' };
	try {
		const obj = JSON.parse(await readFile(join(kbRootOf(config), '.kb-settings.json'), 'utf8'));
		return Object.assign(base, obj && obj.feishu);
	} catch {
		return base;
	}
}

/** 定时同步的运行状态（进程内；重启后重置，下一次到期即会重跑） */
const SYNC_STATE = { running: false, lastAt: 0, lastCode: null, lastError: '', lastDry: false };

/** 重建索引的运行状态（同上：进程内，够用且不需要落盘） */
const REINDEX_STATE = { running: false, lastAt: 0, docs: 0, lastError: '' };

/**
 * `/api/view-data` 的组装结果缓存（2026-10-25）。
 *
 * 为什么需要：面板每次挂载/切库都会打这条路由，而它要**扫两遍目录**（笔记 + 库）再读全库正文算双链，
 * 首次实测约 200ms。同一份内容在几秒内被反复请求是常态（面板打开 → 设置页 → 切回）。
 *
 * 失效判据（两道一起，缺一不可）：
 *   · `sig` = 笔记/库 两个目录的 mtime ⇒ **新增/删除/改名**会立刻变（这正是树变化的原因）
 *   · TTL 10s ⇒ 兜住"目录 mtime 不变但内容变了"的情况（如改某篇正文只影响双链，不影响树）
 * `?refresh=1` 无条件绕过。
 */
const VIEW_DATA_CACHE = new Map();
async function vaultSigOf(dir) {
	const a = await stat(join(dir, NOTES_DIR)).catch(() => null);
	const b = await stat(join(dir, LIBRARY_DIR)).catch(() => null);
	return `${a ? a.mtimeMs : 0}|${b ? b.mtimeMs : 0}`;
}

/**
 * **执行一次同步**（页面按钮与定时器走同一条路径）。
 *
 * 为什么抽出来：之前这段逻辑只存在于 HTTP 路由里，定时器要复用就得复制 40 行
 * （映射文件、冲突策略、间隔、prune、日志落盘），复制必然漂移。
 */
async function performFeishuSync(config, { dry = false } = {}) {
	const feishuCfg = await readFeishuSettings(config);
	if (!feishuCfg.enabled) {
		return { ok: false, code: null, error: '飞书同步未启用：请到「设置 → 📤 飞书同步」打开开关后重试。' };
	}
	const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
	const wanted = String(config?.kbActiveVaultId ?? '');
	const vault = vaults.find(v => v.id === wanted) ?? vaults[0];
	if (!vault) { return { ok: false, code: null, error: '还没有可用的知识库' }; }

	// 目录映射 → 脚本认的文件（`{ mappings: { 相对目录: spaceId } }`）
	try {
		const maps = (feishuCfg.mappings ?? []).filter(m => m && m.dir && m.spaceId);
		if (maps.length) {
			const obj = { mappings: {} };
			for (const m of maps) { obj.mappings[String(m.dir).replace(/\\/g, '/')] = String(m.spaceId); }
			await writeFile(join(vault.dir, '.feishu-space-map.json'), JSON.stringify(obj, null, 2), 'utf8');
		}
	} catch { /* 写不进去不阻断（脚本会退回"未映射类别自动建库"） */ }

	const args = buildFeishuSyncArgs({
		vault: vault.dir,
		/*
		 * ★★ 2026-10-28（真机：`[map] 已配置 6 条映射，但本次没有文档命中`）：
		 *   这里原先是 `src: NOTES_DIR` —— `NOTES_DIR` 是**字符串** `'笔记'`，
		 *   而 `buildFeishuSyncArgs` 里是 `for (const dir of src)` ⇒ 字符串按**字符**迭代
		 *   ⇒ 实际下发 `--src 笔 --src 记`（脚本头部就打印 `src: 笔, 记`）
		 *   ⇒ 两个不存在的目录 ⇒ 扫不到任何文档 ⇒ `create=0 update=0 skip=0` ✗。
		 *   必须是数组：`[NOTES_DIR]`。
		 */
		src: [NOTES_DIR],
		apply: !dry,
		onConflict: feishuCfg.conflict === 'skip' ? 'skip' : 'overwrite',
		cliPath: String(feishuCfg.cliPath ?? '').trim(),
	});
	const interval = Number(feishuCfg.intervalMs) || 0;
	if (interval > 0) { args.push('--interval', String(Math.floor(interval))); }
	if (feishuCfg.deleteRemote === true) { args.push('--prune'); }

	const { code, output } = await runFeishuSync(args, vault.dir);
	const text = String(output || '');
	let logFile = '';
	try {
		logFile = join(vault.dir, '.kb-feishu-sync.log');
		const head = `===== ${new Date().toISOString()} ${dry ? 'dry-run' : 'apply'} code=${code} =====\n`;
		await appendFile(logFile, head + text.slice(-200000) + '\n', 'utf8');
	} catch { logFile = ''; }
	return { ok: code === 0, code, dry: !!dry, output: text.slice(-4000), vault: { id: vault.id, name: vault.name, dir: vault.dir }, logFile: logFile || undefined };
}

/**
 * 定时同步：**每 60s 醒一次**，按 `scheduleMinutes` 判断是否到期。
 *
 * 三条保护（缺一条就会出事故）：
 *   · `enabled && schedule` 同时为真才跑（IDE 侧也是"与"关系）
 *   · 上一次还在跑就跳过（同步是分钟级长任务，叠加会互相踩）
 *   · 定时器 `unref()`，且 dispose 时 clearInterval —— 不能让插件拖住宿主退出
 */
function startFeishuScheduler(config) {
	const TICK_MS = 60 * 1000;
	const tick = async () => {
		try {
			const cfg = await readFeishuSettings(config);
			if (!cfg.enabled || !cfg.schedule) { return; }
			const everyMin = Math.max(5, Number(cfg.scheduleMinutes) || 60);
			if (Date.now() - SYNC_STATE.lastAt < everyMin * 60 * 1000) { return; }
			if (SYNC_STATE.running) { return; }
			SYNC_STATE.running = true;
			try {
				const r = await performFeishuSync(config, { dry: false });
				SYNC_STATE.lastCode = r.code ?? null;
				SYNC_STATE.lastError = r.ok ? '' : String(r.error || '');
			} catch (e) {
				SYNC_STATE.lastError = String(e?.message ?? e);
			} finally {
				SYNC_STATE.lastAt = Date.now();
				SYNC_STATE.running = false;
			}
		} catch { /* 单次失败不影响下一次 */ }
	};
	const timer = setInterval(() => { void tick(); }, TICK_MS);
	try { timer.unref?.(); } catch { /* 老内核无 unref */ }
	return () => { try { clearInterval(timer); } catch { /* 已清 */ } };
}

export function apply(ctx, config = {}) {
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		// ★ 2026-10-20：**config 拿不到 kbVaults 时，从 overlay 文件兜底读**（见 injectedRawOf 的注释）。
		//   放在 bindFoundation 之后：`dataRootOf` 依赖 foundation，未绑定时会抛 ⇒ 三级兜底到 home。
		{
			let dr = '';
			try {
				dr = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
			} catch { dr = ''; }
			if (!dr) {
				try { dr = dataRootOf(config) || ''; } catch { dr = ''; }
			}
			if (!dr) { dr = join(homedir(), '.vssaros-dev'); }
			kbVaultsFromOverlay = readKbVaultsFromOverlay(dr);
		}
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
	// ★ `state.grant` = **本批一次性授权**（2026-10-12 P0，见 core/kbBatchGrant.js 文件头）：
	//   由 `kb_build mode="build"` 在**被用户批准之后**打开（执行期 ⇒ 批准已成立 ✓），
	//   有界（篇数）/ 有时限（TTL）/ 有归属（vault + 会话 owner）✓ ⇒ 子代理写入不再逐篇弹窗 ✓。
	//   ⚠ 它在内存里（不落盘、不跨进程 ✓）；`config.batchGrant === false` 时**整个机制关闭**（每次都问 ✓）。
		// `grantWrites`：本批**授权放行**过的笔记路径（vault 相对 ✓）⇒ 构建收尾时用它当补链目标 ✓
	const state = { tools: null, grant: undefined, grantWrites: new Set(), lastBuildCache: undefined, lastDerivedError: undefined, lastMindmap: undefined, bridge: null };

	// 重构 4（2026-10-16）：semantic 检索要经桥回 IDE 取 query 向量（embedding 模型在壳侧 ✓）。
	// 可选注入：vssarosBridge 不在 ⇒ semantic 模式如实报错（与"没建索引"同口径 ✓），其余照常 ✓。
	// 防御：探针的假 ctx 不忠实模拟"依赖不齐不调回调"（直接调，scope 上没有 ⇒ 抛）⇒ 服务不齐时
	// 不启动不抛错（抛错会让整个插件 apply 失败 ✗，kb 工具陪葬 ✗——kanban 的 runner 踩过同型坑 ✓）。
	ctx.inject(['vssarosBridge'], scope => {
		let svc = null;
		try { svc = scope.vssarosBridge ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (svc && typeof svc.callIDE === 'function') {
			state.bridge = svc;
			return () => { state.bridge = null; };
		}
		return undefined;
	});
	/** 关掉批授权（改用逐篇询问）。为什么留这个开关：让"要不要批授权"这件事**可复核、可回退** ✓。 */
	const batchGrantEnabled = config.batchGrant !== false;
	// ★ 写入类工具的**审批闸**（报告 §5-1 / README 5.104）—— 与 kanban / workflow 同一把 ✓：
	// 官方派发前决策钩子 `tools/pre-execute`（waterfall ✓），返回 `{ kind: 'ask' }` ＝ "先问用户" ✓；
	// 契约：`ask` 只有审批服务返回 `allowed-once` 才执行 ✓、**没有审批支持的部署 degrade to deny** ✓。
	// ⚠ 本模块比另两个精细一点 ✓：`kb_feishu_sync` **只有 `apply: true` 才真写盘** ✗
	//（`buildFeishuSyncArgs({ …, apply, … })` ⇒ dry-run 只出计划 ✓）⇒ 判据带上**参数** ✓
	//（官方契约：`tools/pre-execute` 拿得到 name ＋ **已解析的参数** ✓）—— dry-run 不该弹窗 ✗。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		// 判据收进 `writeIntentOf` ✓（本模块是**两套**写语义：sync 看 `apply`、spaces 看 `action` ✓）——
		// 写在闸里会变成"一长串 &&/||"，下一个写工具接进来时最容易漏掉其中一个 ✓。
		// ⚠ 参数在 **`exec.arguments`**（官方 `ToolExecutionInput.arguments`，`@deepseek-ai/dsh-tools` 的
		// `lib/types/index.d.ts:226-227`："Losslessly JSON-serializable parsed arguments"），
		// **不是旧字段名 `args`** ✗ —— 2026-10-12 由 p3-26 抓出：那一步把探针里的假 exec 也一并修正后，
		// 本闸三个**参数敏感**判据全部恒假 ⇒ dry-run 与真写一律放行 ⇒ `kb_feishu_sync` 带 `apply: true`
		// **写远端不弹窗** ✗✗（本闸存在的唯一理由失效）。两边一起用错名 ⇒ 互相掩护，
		// 源码级守卫（`dshPluginPackages.test.ts`）与旧探针都看不出来 ✓。
		// ★ 本批授权（P0）：只对 `kb_write_note` / `kb_mkdir` 生效 ✓，且三条不变式由纯逻辑守着 ✓
		//（有界 / 有时限 / 有归属 —— 归属 = **同一个 vault + 同一个会话 owner** ✓）。
		// ⚠ 归属取自 `exec.agent?.id`（官方 `ToolExecutionInput.agent`："set by the agent loop" ✓）；
		//   拿不到身份 ⇒ `grantAllows` 一律 false ⇒ **退回逐篇询问** ✓（fail-closed：身份不明时宁可多问 ✓）。
		if (batchGrantEnabled && (exec?.name === 'kb_write_note' || exec?.name === 'kb_mkdir')) {
			// ★ 归属用**集合**（本会话 id ＋ 本会话派出去的子会话 id ✓）：构建是**子代理**去写的，而它带的是
			//   孩子自己的 agent id ⇒ 只看 `exec.agent.id` 会让授权对真正的写者永不命中（见 `writeActorIds` 注释 ✓）。
			const ownerIds = writeActorIds(exec?.agent);
			const wantedVault = typeof exec?.arguments?.vaultId === 'string' ? exec.arguments.vaultId.trim() : '';
			// vaultId 缺省（单库场景）⇒ 授权里那个 vault 就是它；为稳妥起见按"库里只有一个"来判会引入 I/O ✗
			// ⇒ 这里只按**显式给的 vaultId** 匹配（缺省时**不放行** ✓：多问一次总比放错库好 ✓）
			if (grantAllows(state.grant, { vaultId: wantedVault, ownerIds })) {
				// ★ 记下"本批授权放行的笔记"（vault **相对**路径 ✓ —— 闸不知道 vault 的绝对目录，收尾时再拼 ✓）
				//（真源那边笔记由宿主自己写 ⇒ 它本来就知道路径 ✓；我们这条路是子代理写的 ⇒ 只能在这收 ✓）
				if (exec?.name === 'kb_write_note' && typeof exec?.arguments?.path === 'string' && exec.arguments.path.trim()) {
					state.grantWrites.add(exec.arguments.path.trim().replace(/\\/g, '/'));
				}
				state.grant = consumeGrant(state.grant, { name: exec.name });
				return next();
			}
		}
		// 免审白名单：**代码内有默认值**（见 autoApproveOf 的注释 —— 配置会被 overlay 覆盖掉 ✗）
		const intent = exec ? writeIntentOf(exec.name, exec.arguments, autoApproveOf(config)) : undefined;
		if (intent) {
			return { kind: 'ask', reason: intent.reason, displayReason: { en: intent.en, zh: intent.zh } };
		}
		return next(); // 只读工具、以及**只出计划不写远端**的 dry-run / list ⇒ 默认 allow ✓
	}));

	ctx.effect(() => {
		// ── R13（preset plane）：同一个包会被挂**两次**（host plane 一行 + 我们的 preset 里一行 ✓）──
		// `hostHalf: true` ⇒ 这一次只注册页面/路由，**不注册工具**（工具交给 preset 里那次 ✓）；
		// 缺省（不写）⇒ **与从前完全一样**（页面 + 工具都注册 ✓）⇒ 加这个闸本身零行为改变 ✓。
		// 工具重名是**静默顶掉**（不报错 ✗），所以"半边注册"必须显式做，不能靠两边都注册去碰运气 ✓。
		if (config.hostHalf === true) { return undefined; }
		const disposers = toolDefinitions(ctx, state, config).map(definition => ctx.tools.register(definition));
		state.tools = ctx.tools;
		return () => {
			state.tools = null;
			for (const dispose of disposers) {
				dispose();
			}
		};
	});

	// ★ 2026-10-25：**定时同步执行器**（与页面按钮同一条实现）。
	//   `ctx.effect` 在宿主里负责生命周期：插件卸载/重载时调用我们返回的 stop，
	//   不会留下"重载后两个定时器同时跑"的隐患。宿主没有 effect 时静默跳过（手动同步仍可用）。
	try {
		ctx.effect(() => startFeishuScheduler(config));
	} catch { /* 无 effect 能力 ⇒ 只是没有定时同步 */ }

	// 页面路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在（见静态 `inject` 的注释）。
	// 不在 web 模板 ⇒ 只是**没有页面** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}

			// ★ 2026-10-21：**承载表面**（宿主注入 `?surface=sideview|editor`，见 dshPluginPage.ts:65-110）。
			//   缺省（浏览器直开 / dsh 官方页 / 全部既有探针）⇒ 'full' ⇒ **与改造前逐字相同** ✓。
			//   ⚠ 这里单独解析一次：下面那条 `let url` 活在 `if (page.connection && req.url)` 块里，
			//     到页面渲染那一行已经出作用域了（块在 6430 就闭合）⇒ 不能复用 ✗。
			let surface = 'full';
			try {
				const surfaceParam = new URL(req.url ?? '/', 'http://localhost').searchParams.get('surface');
				if (surfaceParam === 'sideview' || surfaceParam === 'editor') { surface = surfaceParam; }
			} catch { /* url 不可解析 ⇒ 当没给（完整页）✓ */ }
			// ★ 只读正文 API（README 5.68）：页面点条目 → 预览笔记正文。
			// 围栏与 `kb_read` 工具**同一套**（都在 `readDoc` 里：解析后的绝对路径必须落在库内 ✓）——
			// 页面与模型都只能读到**库内**文件 ✓。这条**只读**、不改任何东西 ✓；读不到就如实回 400 + 原因 ✓。
			// ⚠ 用子 ctx 的 `page.connection`（不是根 `ctx.connection`）：`connection` 已不在静态 inject 里，
			// 从根 ctx 读**未声明**的服务会抛（memory 的注释记着这个坑：真机 500
			// `cannot get required service "tools" in inactive context`）。
			if (page.connection && req.url) {
				let url;
				try {
					url = new URL(req.url, 'http://localhost');
				} catch {
					url = undefined;
				}
				// ★ 页面用全文检索（2026-10-13 §15.5）：与 `kb_search mode=fulltext` **同一套**（`runFulltextSearch` ✓）
				//   ⇒ 命中口径、跨库合并、以及"该库没在 IDE 侧建过索引 ⇒ 明确报错"全都一致 ✓。
				//   ⚠ 错误**如实回 400 ＋ 原因**（页面必须显示它 ✗ 不许显示成"没有结果" ✓）。
				// ★ 页面上**唯一**一条写路由（2026-10-13，§15.33）：把「笔记」区里的一篇改名/移动。
				//   · **闸的口径**（照 `vssaros-memory/lib/promote.js` 那条既有裁决 ✓，不自己发明）：
				//     `tools/pre-execute` 存在的理由是"模型可能不经确认就改用户数据" ✓；人在页面上按下按钮
				//     **本身就是那次确认** ✓，再弹一层只会养成盲点 ✗；且审批服务要求请求在 **open turn** 内 ✓，
				//     页面请求没有 turn ✗ ⇒ 技术上走不了 ✓。**代价如实记**：这条通道不进会话审计 ✗，
				//     所以它只做**最小、可逆**的一件事（改名/移动 ✓），删除类**不做** ✓。
				//   · **白名单复用**：`resolveOrganizePath`（真源 `kbOrganizeTools.ts` 的口径 ✓）已经把
				//     "只能在「笔记」区内"判死 ✓ ⇒ 不另写判断 ✓（规则只有一处 ✓）。
				//   · 与 `kb_organize` 同一套写入法：**vault 锁** ＋ `runOrganize` ＋ `refreshDerived` ✓。
				// ★ 页面「新建文件 / 新建文件夹」（2026-10-14 §16.18）：与 rename/delete **同一条通道** ✓
				//   （同一个围栏：**只在「笔记」区** ✓、同一把 vault 锁 ✓、同样的 405/413/400 口径 ✓）。
				//   ⚠ 与真源的两处**有意不同**，都摆在这里 ✗：
				//     ① 真源在**两个区**都能新建（库 / 笔记 ✓）；我们**只在笔记区** —— 因为这条通道的
				//        立项理由是"最小、可逆、不进审计"（§15.33 ✓），而往「库」里造素材那是**导入** territory ✓；
				//     ② 真源建完**立刻进入内联改名**；我们**建完由页面自动点开那个 ✎**（同名效果 ✓，
				//        见页面脚本里那段 `sessionStorage` 交接 ✓）。
				// ★★ 分区头工具栏的「思维导图」（2026-10-14 §16.28）—— 语义照真源 `_openMindmap`（`:5497-5526` ✓）：
				//   · **有 .canvas ⇒ 打开它**（优先 `mindmap.canvas`，否则第一个 ✓ —— 规则抽在
				//     `core/kbMindmap.js` 的 `pickMindmapForOpen` 里 ✓，那是**第三处**用到它，所以必须抽 ✗）；
				//   · 没有 ⇒ 真源会**先生成**（`_generateMindmapAfterImport` ✓，它那边是确定性生成 ✓）；
				//     我们侧"从笔记生成"要起子代理（`kb_mindmap mode=generate` ✓，前置 jobs + subagents ✗）
				//     ⇒ 页面按钮**不假装能生成** ✗ ⇒ 如实回原因 ＋ 指路（在会话里调 `kb_mindmap` ✓）。
				// ⚠ 这条路由是**只读**的 ✓（就一次 readdir ✓）：不取锁、不写盘 ⇒ 与 §15.33 那条"页面上的写通道
				//   只有 new/rename/delete/restore 四条"的既有口径**不冲突** ✓（这条不在其中 ✓）。
				// ⚠ **"打开"由页面用页面桥 `openFile` 做** ✓ —— 宿主侧这条路由只管"有没有、在哪" ✓，不碰编辑器 ✓。
				//   ⚠ 如实记：桥的 `openFile` 对"工作区之外"的路径会**先弹确认**（`dshHarness.contribution.ts:758-765` ✓
				//   原文"DSH 页面请求打开工作区之外的文件"✓）—— vault 常在会话工作区之外 ⇒ 用户会看到那一次确认 ✓
				//   （那是宿主的既定安全设计 ✓，我们不绕过也不隐藏 ✓）。
				// ★ 2026-10-23（用户：「窗口模式知识库要与 IDE sideview 一致」）：React 版知识库页。
		//   与 IDE 侧栏是**同一份 bundle**（`webview/media/kbSideview.js`，
		//   由 `scripts/sync-kb-sideview.mjs` 复制到 `lib/web/`）⇒ 两边 UI 不再分叉 ✓。
		//   `/sideview` 给页面、`/web/kbSideview.js` 给脚本（同源，避免 CORS）。
		// ★★ 2026-10-24（自动测试咬出来的**约束冲突**，此处只记录、不擅自破规）：
		//
		//   目标：让窗口模式的主页也用 React 侧栏（与 IDE 侧栏同一份 bundle）。
		//   但两条既有守卫互相顶住，**必须产品层面二选一**才能落地：
		//
		//   ① `dshPluginPackages.test.ts`：`vssaros.view.route` 必须等于规范默认路由 `/x/kb/`
		//      ⇒ 不能把清单路由改成 `/x/kb/sideview`（实测报红：view.route 与聚合表不一致）。
		//   ② `check-page-render-surfaces.mjs`（11 项）：`/x/kb/` **必须**返回带 `?surface=` 三态
		//      与探针锚点的 SSR 页（full/sideview/editor/diag）
		//      ⇒ 不能把 `/x/kb/` 直接改成吐静态 `sideview.html`（实测 11 项全红）。
		//
		//   ⇒ 现状：`/x/kb/` 保持旧 SSR 页；React 页挂在**追加路径** `/x/kb/sideview`。
		//     要去掉这条差异，只有两条路（都需要改守卫或改渲染，属于产品决策，不在“自动修复”范围）：
		//       A. 把 sideview 三态渲染改成「React 页外壳」——即 renderPage 里把 SSR 主体换成我们的
		//          bundle 宿主（保留 surface 语义与探针锚点）；
		//       B. 在 /x/kb/ 上按 `?surface=` 分流：无 surface 时 302 到 /x/kb/sideview，
		//          有 surface 时仍走 renderPage ——需同步调整 ②的判据。
		// ★★ 2026-10-24（产品决定：知识库 view 必须用新版）：**裸 `/x/kb/` 出 React 侧栏页**。
		//   与 IDE 侧栏是同一份 bundle ⇒ 两处 UI 一致 ✓。
		//   ⚠ 带 `?surface=` 的请求**不拦**：经典 SSR 三态（full/sideview/editor）仍由 renderPage 提供，
		//     因为它被 19 项守卫（`check-page-render-surfaces.mjs`）与既有探针按 URL 钉着。
		//   ⇒ 判据 = "是不是裸主页（没 surface 参数）"，不是"路径前缀"。
		// ⚠ 2026-10-24 第二次修正：**不能按 `surface` 参数分流**。
		//   宿主打开模块页时会自己注入 `?surface=sideview|editor`（`dshPluginPage.ts:65-110`）⇒
		//   用户点的「知识库」tab 进来的 URL 多半就带 surface ⇒ 按参数分流会让新版**永远轮不到** ✗
		//   （真机表现：改了代码、重启了进程，页面还是旧的那一份）。
		//   ⇒ 现在：`/x/kb/`（任何参数）一律出新版；经典三态页退到 `/x/kb/classic`（仍走 renderPage）。
		// ★ 2026-10-26（P4）：**静态前端资源白名单**。以前只服务 kbSideview.js，
		//   而页面里还有内联脚本 ⇒ CSP 只能写 unsafe-inline。现在三段脚本全部外置，
		//   这里按**精确文件名**放行（不做路径拼接 ⇒ 无穿越面）。
		if (url && url.pathname.startsWith(`${ROUTE_PREFIX}/web/`)) {
			const name = url.pathname.slice((ROUTE_PREFIX + '/web/').length);
			if (/^(kbSideview|page-boot|doc-boot|kbEditor)\.js$/.test(name)) {
				try {
					const body = readFileSync(fileURLToPath(new URL(`./web/${name}`, import.meta.url)));
					res.writeHead(200, {
						'content-type': 'application/javascript; charset=utf-8',
						'cache-control': 'no-store',
					});
					res.end(body);
				} catch (err) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(`未找到 ${name}：先跑 scripts/sync-kb-sideview.mjs（${String(err?.message ?? err)}）`);
				}
				return;
			}
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			res.end('not found');
			return;
		}
		const isKbHomePage = url?.pathname === `${ROUTE_PREFIX}/` || url?.pathname === `${ROUTE_PREFIX}`;
		if (url && (isKbHomePage || url.pathname === `${ROUTE_PREFIX}/sideview`)) {
			try {
				const body = readFileSync(fileURLToPath(new URL('./web/sideview.html', import.meta.url)));
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
					// 严格 CSP：脚本只允许同源文件（内联脚本已在 2026-10-26 外置）
					'content-security-policy': KB_PAGE_CSP,
				});
				res.end(body);
			} catch (err) {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(`未找到 sideview.html：先跑 scripts/sync-kb-sideview.mjs（${String(err?.message ?? err)}）`);
			}
			return;
		}

		if (url && url.pathname === `${ROUTE_PREFIX}/api/mindmap`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== 'POST') { send(405, { ok: false, error: '请用 POST' }); return; }
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大（本接口只收 JSON，几 KB 以内）' }); return; }
						}
						const payload = JSON.parse(raw || '{}');
						const vaultId = String(payload?.vaultId ?? '');
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						const vault = vaults.find(candidate => candidate.id === vaultId);
						if (!vault) { send(404, { ok: false, error: `找不到 vault：${vaultId}` }); return; }
						const found = await listMindmaps(join(vault.dir, NOTES_DIR));
						const picked = pickMindmapForOpen(found);
						if (!picked) {
							send(400, {
								ok: false,
								count: 0,
								error: '「笔记」区里还没有思维导图（.canvas）。从笔记**生成**需要起子代理 ⇒ 请在会话里让模型调 kb_mindmap（mode="generate"，前置是组合里有 jobs + subagents）。',
							});
							return;
						}
						send(200, {
							ok: true,
							vault: vaultId,
							name: picked.name,
							path: picked.path,
							count: found.size,
							message: `打开 ${picked.name}（本库共 ${found.size} 个 .canvas ✓）`,
						});
					} catch (e) {
						send(400, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-19（用户报「模型写笔记没落到我当前在看的目录」）：
				//   **记录「当前目录」** —— 页面点/展开目录时 POST 一条（页面侧节流）。
				//   存 `<资料库根>/.active-dir.json`（与各 vault 目录同级，属 kb 自己的数据 ✓），
				//   `kb_write_note` 在"模型没给子目录"时用它兜底（见 core/kbActiveDir.js ✓）。
				//   ⚠ 只支持「笔记」区：库区不可写 ⇒ 记了也没用，直接 400 让页面知道 ✓。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/active-dir`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== 'POST') { send(405, { ok: false, error: '请用 POST' }); return; }
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 4096) { send(413, { ok: false, error: '请求体太大（本接口只收几 KB 的 JSON）' }); return; }
						}
						const payload = JSON.parse(raw || '{}');
						const vaultId = String(payload?.vaultId ?? '');
						const dirRel = String(payload?.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						if (dirRel && dirRel !== NOTES_DIR && !dirRel.startsWith(NOTES_DIR + '/')) {
							send(400, { ok: false, error: `当前目录只支持「笔记」区：${dirRel}` });
							return;
						}
						const saved = await writeActiveDir({ readFile, writeFile }, kbRootOf(config), vaultId, dirRel);
						if (!saved) { send(500, { ok: false, error: `写 .active-dir.json 失败（${kbRootOf(config)}）` }); return; }
						return send(200, { ok: true, vaultId, dir: dirRel });
					} catch (e) {
						return send(500, { ok: false, error: String(e?.message ?? e) });
					}
				}
				if (url && url.pathname === `${ROUTE_PREFIX}/api/new`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== 'POST') { send(405, { ok: false, error: '请用 POST' }); return; }
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大（本接口只收 JSON，几 KB 以内）' }); return; }
						}
						const payload = JSON.parse(raw || '{}');
						const vaultId = String(payload?.vaultId ?? '');
						const kind = String(payload?.kind ?? '');
						const dirRel = String(payload?.dir ?? '').trim();
						const wanted = String(payload?.name ?? '').trim();
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						if (kind !== 'file' && kind !== 'folder') { send(400, { ok: false, error: `未知的 kind：${kind}（支持 file / folder）` }); return; }
						if (wanted && /[\\/:*?"<>|]/.test(wanted)) { send(400, { ok: false, error: `名字里不能有这些字符：\\ / : * ? " < > |` }); return; }
						const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						const vault = vaults.find(candidate => candidate.id === vaultId);
						if (!vault) { send(404, { ok: false, error: `找不到 vault：${vaultId}` }); return; }
						// 目标目录必须在「笔记」区内（空 = 笔记区根 ✓ —— resolveOrganizePath 认 `笔记` 本身 ✓）
						const dirPath = dirRel || NOTES_DIR;
						const dirResolved = resolveOrganizePath(vault.dir, dirPath);
						if (dirResolved.inside !== true && dirResolved.rel !== NOTES_DIR) {
							send(400, { ok: false, error: `只能在可写的「笔记」区内新建：${dirResolved.why ?? dirPath}` });
							return;
						}
						const baseDir = dirResolved.rel === NOTES_DIR ? join(vault.dir, NOTES_DIR) : dirResolved.abs;
						const release = await acquireFileLock(lockFileFor(vault.dir), { label: '知识库页面新建' });
						let created;
						let nav;
						try {
							if (kind === 'folder') {
								const name = await uniqueChildName(baseDir, wanted || '未命名文件夹');
								await mkdir(join(baseDir, name), { recursive: true });
								created = { name, rel: `${dirPath}/${name}` };
							} else {
								// 扩展名：照真源 —— `未命名` ＋ `.md` ✓（内容 `# <文件名>\n` ✓ —— **带扩展名** ✓，那是真源原样 ✓）
								const name = await uniqueChildName(baseDir, wanted || '未命名', '.md');
								await writeFile(join(baseDir, name), `# ${name}\n`, 'utf8');
								created = { name, rel: `${dirPath}/${name}` };
							}
							nav = await refreshDerived(vault.dir, config);
						} finally {
							await release();
						}
						send(200, { ok: true, vault: vaultId, kind, name: created.name, rel: created.rel, ...(nav && !nav.error ? { navigation: nav } : {}) });
					} catch (e) {
						send(400, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				if (url && url.pathname === `${ROUTE_PREFIX}/api/rename`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== 'POST') { send(405, { ok: false, error: '请用 POST' }); return; }
						let raw = "";
						for await (const chunk of req) {
							raw += chunk;
							// 上限：这是一个"改一个文件名"的请求 ⇒ 几 KB 足够（防被塞爆 ✓）
							if (raw.length > 8192) { send(413, { ok: false, error: "请求体太大（本接口只收 JSON，几 KB 以内）" }); return; }
						}
						const payload = JSON.parse(raw || "{}");
						const vaultId = String(payload?.vaultId ?? "");
						const from = String(payload?.from ?? "");
						const to = String(payload?.to ?? "");
						// ★ `mode`（2026-10-14 §16.20）：`'move'`（缺省 ✓）/ `'copy'`（Ctrl 拖拽 ✓）——
						//   同一把锁、同一处刷新、同一份围栏 ✓（不为复制另起一条通道 ✗）；未知值**当场拒** ✗。
						const mode = String(payload?.mode ?? "move");
						if (mode !== "move" && mode !== "copy") { send(400, { ok: false, error: `未知的 mode：${mode}（支持 move / copy）` }); return; }
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						if (!from || !to) { send(400, { ok: false, error: "缺少 from / to（vault 内相对路径，形如 笔记/甲.md）" }); return; }
						const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						const vault = vaults.find(candidate => candidate.id === vaultId);
						if (!vault) { send(404, { ok: false, error: `找不到 vault：${vaultId}` }); return; }
						// 白名单（复用工具的围栏 ✓）：两端都必须在「笔记」区内
						const fromResolved = resolveOrganizePath(vault.dir, from);
						const toResolved = resolveOrganizePath(vault.dir, to);
						if (!fromResolved.inside) { send(400, { ok: false, error: `源不在可写的「笔记」区内：${fromResolved.why ?? from}` }); return; }
						if (!toResolved.inside) { send(400, { ok: false, error: `目标不在可写的「笔记」区内：${toResolved.why ?? to}` }); return; }
						// ⚠ "源与目标相同"只在**移动**里是"没改任何东西" ✗；复制时它是**合法**的
						//   （原地复制 ⇒ 落点自动变成 `xxx copy.md` ✓，真源 :4059-4069 同 ✓）⇒ 只对 move 拒 ✓。
						if (mode === "move" && fromResolved.rel === toResolved.rel) { send(400, { ok: false, error: "源与目标相同 ⇒ 没改任何东西" }); return; }
						const release = await acquireFileLock(lockFileFor(vault.dir), { label: mode === "copy" ? "知识库页面复制" : "知识库页面重命名" });
						let result;
						let nav;
						try {
							result = await runOrganize(mode === "copy"
								? { vaultRoot: vault.dir, copies: [{ from, to }] }
								: { vaultRoot: vault.dir, moves: [{ from, to }] });
							nav = await refreshDerived(vault.dir, config);
						} finally {
							await release();
						}
						const done = (mode === "copy" ? result.copied : result.moved) ?? [];
						const skipped = result.skipped ?? [];
						if (done.length === 0) {
							// 逐项拒都**如实回原因** ✓（"目标已存在 ⇒ 不覆盖"是这里最常撞的一条 ✓）
							send(400, { ok: false, error: skipped.map(item => `${item.item}：${item.why}`).join("；") || "没有改动任何文件" });
							return;
						}
						send(200, {
							ok: true, vault: vaultId, mode, skipped,
							// ⚠ 复制的落点要给**实际值**（撞名会自动加 copy ✓）⇒ 键名与移动分开 ✓，调用方不会看错 ✗
							...(mode === "copy" ? { copied: done } : { moved: done }),
							...(nav && !nav.error ? { navigation: nav } : {}),
						});
					} catch (e) {
						send(400, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 删除＝**移入备份**（可逆 ✓）＋ 撤销（2026-10-13，§15.47）。
				//   ⚠ §15.34 那条裁决（"这一通道只做改名/移动，删除类不做"）**收窄**为：
				//     "只做**可逆**的写（改名/移动 ＋ **移入备份**），**永久删除**仍不做" ——
				//     收窄的理由：`kb_organize` 的 `deletes` 本来就不是真删除（vault 外的备份目录 ✓，
				//     是 dsh 侧唯一的还原点 ✓），配上撤销（/api/restore ✓）后它同样"最小、可逆" ✓；
				//     **代价照旧如实记**：这条通道不进会话审计 ✗（所以仍然只碰能一键还原的东西 ✓）。
				//   围栏、不覆盖、vault 锁、刷新衍生文件——与 rename 那条**同一套** ✓（不另写判断 ✗）。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/delete`) {
					const send = (code, payload) => {
						res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== "POST") { send(405, { ok: false, error: "请用 POST" }); return; }
						let raw = "";
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: "请求体太大" }); return; }
						}
						const payload = JSON.parse(raw || "{}");
						const vaultId = String(payload?.vaultId ?? "");
						const from = String(payload?.from ?? "");
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						if (!from) { send(400, { ok: false, error: "缺少 from（vault 内相对路径）" }); return; }
						const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						const vault = vaults.find(candidate => candidate.id === vaultId);
						if (!vault) { send(404, { ok: false, error: `找不到 vault：${vaultId}` }); return; }
						const fromResolved = resolveOrganizePath(vault.dir, from);
						if (!fromResolved.inside) { send(400, { ok: false, error: `只有「笔记」区里的文件可以删：${fromResolved.why ?? from}` }); return; }
						const release = await acquireFileLock(lockFileFor(vault.dir), { label: "知识库页面删除（移入备份）" });
						let result;
						let nav;
						try {
							result = await runOrganize({ vaultRoot: vault.dir, deletes: [from] });
							nav = await refreshDerived(vault.dir, config);
						} finally {
							await release();
						}
						const deleted = result.deletedToBackup ?? [];
						if (deleted.length === 0) {
							send(400, { ok: false, error: (result.skipped ?? []).map(item => `${item.item}：${item.why}`).join("；") || "没有删任何文件" });
							return;
						}
						// 回执里带上**还原必需**的两样：备份目录 ＋ vault 内相对路径 ✓（撤销按钮直接用它们 ✓）
						send(200, { ok: true, deleted, rel: fromResolved.rel, backupDir: result.backupDir, vault: vaultId, ...(nav && !nav.error ? { navigation: nav } : {}) });
					} catch (e) {
						send(400, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★★ 库级删除（2026-10-15 §16.32；页面下拉里「库项右键 ⇒ 删除知识库…」的落点之一 ✓）——
				//   语义与 /api/delete **不同** ✗：那条是"移入备份（可逆）"；这条是**永久删除**
				//   （用户 2026-10-15 明确点头：库级删除照真源＝不可逆 ✓）—— 两条并存，文案各自说清 ✓。
				// ⚠ **只管"未登记"的库**（只在盘上、IDE 清单里没有 ✓）：已登记的 ⇒ 400 并指路去页面桥
				//   （宿主 removeVault 会带原生确认框 ✓ —— 两条通道各管各的，不许页面借这条绕开确认 ✗）。
				// ⚠ 围栏：id 形态闸 ✓ ＋ 落点由 kbRoot/id **拼**出来（不接受外部路径 ✗）⇒ 只会删到根的直接子目录 ✓。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/vault-delete`) {
					const send = (code, payload) => {
						res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== "POST") { send(405, { ok: false, error: "请用 POST" }); return; }
						let raw = "";
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: "请求体太大" }); return; }
						}
						const payload = JSON.parse(raw || "{}");
						const vaultId = String(payload?.vaultId ?? "");
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						// 归属判定：IDE 清单里有没有它（注入即清单 ✓ —— 页面据此分流，路由侧**再核一次** ✓）
						// ⚠ **没拿到清单 ⇒ 拒** ✗（fail-closed，2026-10-15 §16.33）：空清单不等于"都未登记" ——
						//   注入挂错行那次，所有已登记的库在这里都会被当成"未登记"而放行永久删除 ✗。
						const injected = parseInjectedVaults(config?.kbVaults) ?? [];
						if (!injected.length) {
							send(409, { ok: false, error: `没拿到 IDE 的库清单 ⇒ 判断不了这个库是否已登记，不做永久删除：${vaultId}` });
							return;
						}
						const registered = injected.some(item => String(item?.id ?? "") === vaultId);
						if (registered) {
							send(400, { ok: false, error: `这个库在 IDE 的清单里 ⇒ 请走页面桥让宿主删（它会带原生确认框）：${vaultId}` });
							return;
						}
						const dir = join(kbRootOf(config), vaultId);
						const info = await stat(dir).catch(() => undefined);
						if (!info || !info.isDirectory()) { send(404, { ok: false, error: `盘上没有这个库目录：${dir}` }); return; }
						await rm(dir, { recursive: true, force: true });
						send(200, { ok: true, deleted: dir, vault: vaultId, note: "库级删除 = 永久删除（不可逆 ✓ —— 与文件行的「移入备份」不是一回事 ✗）" });
					} catch (e) {
						send(400, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 撤销：把备份里那一项**放回原位**（不覆盖 ✓，围栏与备份自洽性都在 restoreFromBackup 里 ✓）
				if (url && url.pathname === `${ROUTE_PREFIX}/api/restore`) {
					const send = (code, payload) => {
						res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== "POST") { send(405, { ok: false, error: "请用 POST" }); return; }
						let raw = "";
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: "请求体太大" }); return; }
						}
						const payload = JSON.parse(raw || "{}");
						const vaultId = String(payload?.vaultId ?? "");
						const backupDir = String(payload?.backupDir ?? "");
						const rel = String(payload?.rel ?? "");
						if (!isVaultId(vaultId)) { send(400, { ok: false, error: `vaultId 形态不合法：${vaultId}` }); return; }
						if (!backupDir || !rel) { send(400, { ok: false, error: "缺少 backupDir / rel（撤销要用删除时回执里给的那两个 ✓）" }); return; }
						const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						const vault = vaults.find(candidate => candidate.id === vaultId);
						if (!vault) { send(404, { ok: false, error: `找不到 vault：${vaultId}` }); return; }
						const release = await acquireFileLock(lockFileFor(vault.dir), { label: "知识库页面撤销删除" });
						let result;
						let nav;
						try {
							result = await restoreFromBackup({ vaultRoot: vault.dir, backupDir, relPath: rel });
							nav = result.ok ? await refreshDerived(vault.dir, config) : undefined;
						} finally {
							await release();
						}
						send(result.ok ? 200 : 400, result.ok ? { ok: true, path: result.path, rel: result.rel, vault: vaultId, ...(nav && !nav.error ? { navigation: nav } : {}) } : { ok: false, error: result.error });
					} catch (e) {
						send(400, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★★ 2026-10-19：**关系图谱页面**（从 IDE 侧迁来）。
				//   GET /x/kb/graph?vault=<id> ⇒ 整页；页面自己去 fetch /api/graph 取数据
				//   （不把图数据塞进 HTML：库大时那是几百 KB 的重复传输 ✗，与 `/api/doc` 同一条理由）。
				if (url && url.pathname === `${ROUTE_PREFIX}/graph`) {
					try {
						const { vaults, missing } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						if (missing) {
							res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
							res.end(`资料库根目录还不存在：${missing}`);
							return;
						}
						const wanted = (url.searchParams.get('vault') ?? '').trim()
							|| (typeof config?.kbActiveVaultId === 'string' ? config.kbActiveVaultId.trim() : '');
						const vault = wanted ? vaults.find(v => v.id === wanted) : vaults[0];
						if (!vault) {
							res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
							res.end('还没有可用的知识库（先「配置文件夹为知识库…」）');
							return;
						}
						const html = renderGraphPage({
							vaultId: vault.id,
							vaultName: vaultDisplayNameFrom(config, vault.id),
							notesDir: join(vault.dir, NOTES_DIR),
						});
						res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
						res.end(html);
					} catch (e) {
						res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
						res.end(String(e?.message ?? e));
					}
					return;
				}
				// ★★ 2026-10-19：页面「关系图谱」的图数据（**从 IDE 侧迁来**）。
				//   GET /x/kb/api/graph?vault=<id>[&refresh=1]
				//   · `nodes[].id` = **vault 内的相对路径**（如 `UE5/xxx.md`）⇒ 页面拼绝对路径交给页面桥
				//     `openFile` 就能打开笔记 ✓（这正是不能复用 `buildInsightGraph` 的原因：它用标题做 id，
				//     见 core/kbGraphData.js 文件头的说明）。
				//   · **只读**：`readNotesForGraph`（readdir + readFile）+ 纯函数 `buildGraphData`
				//     ⇒ 不取 vault 锁、不写盘 ⇒ 与"页面上的写通道只有 new/rename/delete/restore"不冲突 ✓。
				//   · ⚠ 全库读正文 ⇒ 进程内缓存 60s（GRAPH_CACHE_TTL_MS）；`refresh=1` 强制重扫。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/graph`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const { vaults, missing } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						if (missing) { return send(400, { ok: false, error: `资料库根目录还不存在：${missing}` }); }
						const wanted = (url.searchParams.get('vault') ?? '').trim()
							|| (typeof config?.kbActiveVaultId === 'string' ? config.kbActiveVaultId.trim() : '');
						const vault = wanted ? vaults.find(v => v.id === wanted) : vaults[0];
						if (!vault) {
							return send(400, {
								ok: false,
								error: wanted ? `找不到这个库：${wanted}` : '还没有可用的知识库（先「配置文件夹为知识库…」）',
							});
						}
						const notesDir = join(vault.dir, NOTES_DIR);
						const refresh = url.searchParams.get('refresh') === '1';
						const now = Date.now();
						const cached = graphCache.get(notesDir);
						const fresh = !refresh && !!cached && (now - cached.at) < GRAPH_CACHE_TTL_MS;
						let data = fresh ? cached.data : undefined;
						if (!data) {
							const notes = await readNotesForGraph(notesDir);
							data = buildGraphData(notes);
							graphCache.set(notesDir, { at: now, data });
						}
						return send(200, {
							ok: true,
							vaultId: vault.id,
							vaultName: vaultDisplayNameFrom(config, vault.id),
							notesDir,
							cached: !!fresh,
							nodes: data.nodes,
							edges: data.edges,
							stats: data.stats,
						});
					} catch (e) {
						return send(500, { ok: false, error: String(e?.message ?? e) });
					}
				}
				// ★ 2026-10-24：**知识库设置**（dsh 侧二级设置页使用）。
				//   GET  → 读 `<数据根>/.kb-settings.json`（缺省给一份默认值，页面不用写兜底逻辑）
				//   POST → 整体覆盖写回（页面每次改一个字段就发整份；小文件、无并发需求）
				//   ⚠ 只放 dsh 侧**真能生效**的项：构建方式 / 飞书开关与映射 / 同步参数。
				//     IDE 专有的（系统选目录、Embedding provider、全局索引）不在这里假装。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/kb-settings`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					const file = () => join(kbRootOf(config), '.kb-settings.json');
					const defaults = {
						agenticBuild: true,
						// `scheduleMinutes`：定时同步的间隔（分钟）；`cliPath`：lark-cli 的非标准路径
						feishu: { enabled: false, schedule: false, scheduleMinutes: 60, intervalMs: 800, conflict: 'skip', deleteRemote: false, mappings: [], cliPath: '' },
					};
					const readSettings = () => {
						try {
							const raw = readFileSync(file(), 'utf8');
							const obj = JSON.parse(raw);
							return Object.assign({}, defaults, obj, {
								feishu: Object.assign({}, defaults.feishu, obj && obj.feishu),
							});
						} catch {
							return defaults;
						}
					};
					try {
						if (req.method === 'GET') { send(200, { ok: true, settings: readSettings() }); return; }
						if (req.method !== 'POST') { send(405, { ok: false, error: '请用 GET 或 POST' }); return; }
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 65536) { send(413, { ok: false, error: '设置太大' }); return; }
						}
						const body = JSON.parse(raw || '{}');
						const next = Object.assign({}, defaults, body, {
							feishu: Object.assign({}, defaults.feishu, body && body.feishu),
						});
						await writeFile(file(), JSON.stringify(next, null, 2), 'utf8');
						send(200, { ok: true, settings: next });
						return;
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
						return;
					}
				}
				// ★ 2026-10-24：**新建知识库 / 本地载入文件夹**（标题行下拉里的两项，对齐 IDE 侧「＋ 配置文件夹为知识库…」）
				//   · `mode:'attach'`：把一个已有文件夹登记成库（**不移动、不复制**任何文件）
				//   · `mode:'create'`：在数据根下建一个新库（只建 `笔记/` 与 `库/` 两个空目录）
				//   落点是自己维护的 `<数据根>/.extra-vaults.json`（不碰 IDE 配置，见 externalVaultRecords 注释）
				if (url && url.pathname === `${ROUTE_PREFIX}/api/vault-add` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大' }); return; }
						}
						const payload = JSON.parse(raw || '{}');
						const mode = String(payload?.mode ?? 'attach');
						const name = String(payload?.name ?? '').trim();
						const root = kbRootOf(config);
						let dir = '';
						let id = '';
						if (mode === 'attach') {
							const wanted = String(payload?.path ?? '').trim();
							if (!wanted) { send(400, { ok: false, error: '请填写文件夹的绝对路径' }); return; }
							try { dir = resolve(decodeURIComponent(wanted)); } catch { dir = resolve(wanted); }
							const st = await stat(dir).catch(() => null);
							if (!st || !st.isDirectory()) { send(400, { ok: false, error: `路径不存在或不是文件夹：${dir}` }); return; }
							// 稳定短哈希：同一个文件夹重复登记不会产生两个库
							let h = 0;
							for (let i = 0; i < dir.length; i++) { h = (h * 31 + dir.charCodeAt(i)) >>> 0; }
							id = 'ext-' + h.toString(16);
						} else {
							// ★ 2026-10-24（用户要求）：新建知识库**允许指定文件夹路径**，
							//   并且**文件夹名就是知识库的名字**（不再由用户另取一个名字，避免"名字与目录对不上"）。
							//   与 attach 的差别只有一点：目录不存在时**建出来**（attach 要求已存在）。
							const wanted = String(payload?.path ?? '').trim();
							if (!wanted) {
								send(400, { ok: false, error: '请填写知识库文件夹的绝对路径（文件夹名就是知识库名字）' });
								return;
							}
							try { dir = resolve(decodeURIComponent(wanted)); } catch { dir = resolve(wanted); }
							// 必须是绝对路径：相对路径会按宿主进程的 cwd 解析，最终落在哪里不可控
							if (!isAbsolute(dir)) {
								send(400, { ok: false, error: '请填写绝对路径，例如 E:\\Notes\\MyVault' });
								return;
							}
							const st = await stat(dir).catch(() => null);
							if (st && !st.isDirectory()) {
								send(400, { ok: false, error: '同名文件已存在，不能当作文件夹：' + dir });
								return;
							}
							if (!st) { await mkdir(dir, { recursive: true }); }
							await mkdir(join(dir, NOTES_DIR), { recursive: true });
							await mkdir(join(dir, LIBRARY_DIR), { recursive: true });
							// id 用路径的稳定短哈希 ⇒ 同一文件夹重复"新建"不会长出两个库
							let h = 0;
							for (let i = 0; i < dir.length; i++) { h = (h * 31 + dir.charCodeAt(i)) >>> 0; }
							id = 'kb-' + h.toString(16);
						}
						// ⚠ 2026-10-24（探针抓到的真 bug）：全新安装时数据根可能**还不存在**
						//   （`knowledge-base/` 是懒创建的）。此前只有"库目录在数据根底下"这一种情况
						//   会顺带把根建出来；一旦用户把新库放在别处（如 `E:\Notes\MyVault`），
						//   写 `.extra-vaults.json` 就 ENOENT ⇒ 整个新建失败。
						await mkdir(root, { recursive: true });
						const list = loadExtraVaults(root).filter(v => v.id !== id);
						// 新建：**文件夹名即库名**（忽略调用方给的名字，避免两者不一致）；
						// 载入：优先调用方给的名字（用于给已有文件夹一个更友好的显示名），否则用文件夹名。
						const finalName = (mode === 'create' ? (basename(dir) || id) : (name || basename(dir) || id));
						list.push({ id, name: finalName, path: dir });
						await writeFile(join(root, '.extra-vaults.json'), JSON.stringify(list, null, 2), 'utf8');
						EXTRA_VAULTS_ROOT = root;
						EXTRA_VAULTS = list;
						send(200, { ok: true, vault: { id, name: finalName, path: dir } });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★★ 2026-10-24：**视图数据**（`KbSideviewData` 形状）—— 面板 / 插件页共用的**唯一组装点**。
				//   为什么要有这条路由：此前 `client.js`（工作台面板）与 `sync-kb-sideview.mjs`（插件页）
				//   各写一份 buildData/mapNodes/links 映射，字段一旦漂移就会出现「面板 101 篇、页面 102 篇」
				//   这种只能靠肉眼比才能发现的问题。把组装收回到服务端 ⇒ 两侧都只 `fetch` 一次，
				//   想改结构只改这里，不可能漂移。
				//   代价：`links` 要读全库正文（与 `/api/graph` 同一份 60s 缓存，`?refresh=1` 强制重扫）。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/view-data`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						LAST_VAULT_DIRS = (snapshot.vaults ?? []).map(v => v.dir).filter(Boolean);
						const vaults = snapshot.vaults ?? [];
						// ★ 2026-10-24：支持 `?vault=<id>` —— 面板/插件页的「设置 → 切换库」用它，
						//   否则只能改 IDE 注入的 `kbActiveVaultId`（那是启动时静态值，页面上切不了）。
						const active = String(url.searchParams.get('vault') ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (active && vaults.find(v => v.id === active)) || vaults[0];
						// ★ 2026-10-25：命中缓存就直接回（`sig` = 两个区的目录 mtime，10s TTL 兜底）
						const force = url.searchParams.get('refresh') === '1';
						let cacheKey = '';
						if (vault) {
							cacheKey = vault.id;
							const sig = await vaultSigOf(vault.dir);
							const hit = VIEW_DATA_CACHE.get(cacheKey);
							if (!force && hit && hit.sig === sig && (Date.now() - hit.at) < 10_000) {
								send(200, { ok: true, cached: true, data: hit.data });
								return;
							}
						}
						const out = {
							vaultName: '(未连接)', activeVaultId: '', vaults: [], noteCount: 0,
							tree: [], library: [], libraryCount: 0, tags: [], indexState: 'ready',
						};
						if (vault) {
							const countOf = (n) => (n.children ?? []).reduce((acc, c) => acc + (c.isDirectory ? countOf(c) : 1), 0);
							const mapNodes = (list) => (list ?? []).map((n) => n.isDirectory
								? { name: n.name, path: n.abs || n.rel, isFolder: true, count: countOf(n), children: mapNodes(n.children) }
								: { name: String(n.name).replace(/\.md$/i, ''), path: n.abs || n.rel, isFolder: false, size: n.size });
							// ⚠⚠ 2026-10-24（真机：面板一片空白、`索引就绪 · 0 篇`）：
							//   `pageSnapshotOf()` 返回的 vault **没有 `sections` 字段** —— `/api/page` 是
							//   用 `listVaultTree(vault.dir, { section })` **现扫**出来的。我这里一开始读
							//   `vault.sections.notes` ⇒ 永远 undefined ⇒ 树/篇数/标签全空，
							//   而状态栏仍然显示 `d10`（字段在、只是内容空），非常容易被误判成"数据没到"。
							//   ⇒ 必须与 /api/page 走同一条扫描路径。
							const scanSection = async (section) => {
								const tree = await listVaultTree(vault.dir, { section });
								const withAbs = (nodes) => (nodes ?? []).map((n) => (n.isDirectory
									// ★ 2026-10-24：**目录也要 abs**。之前只给文件拼了绝对路径 ⇒ 目录在页面上
									//   只剩 `01_学习/游戏设计` 这种「相对区目录」的形态：
									//   · 目录映射的键少掉 `笔记/` 前缀（写进 space-map 脚本对不上）
									//   · `relOf()` 无处可折，界面上显示的路径也就不完整
									? {
										name: n.name, rel: n.rel, isDirectory: true,
										abs: join(vault.dir, section, ...String(n.rel).split('/')),
										children: withAbs(n.children),
									}
									: {
										name: n.name, rel: n.rel, isDirectory: false, size: n.size, mtime: n.mtime,
										abs: join(vault.dir, section, ...String(n.rel).split('/')),
									}));
								return { nodes: withAbs(tree.nodes), files: tree.files ?? 0 };
							};
							const notesSection = await scanSection(NOTES_DIR);
							const libSection = await scanSection(LIBRARY_DIR);
							// 标签：与 /api/page 同口径（从 `vault.docs` 的 tags 聚合，不读 kernel 缓存）。
							// ★ 2026-10-24：**每条标签带上它的笔记绝对路径** —— 点标签要能筛选树，
							//   而视图手里只有节点 path（绝对），没有"哪篇有哪些标签"的信息。
							//   路径统一成「正斜杠 + 小写」再给出去，视图侧用同一个口径比较（避免 Windows 大小写差异）。
							const absOfDoc = (doc) => {
								let s = String(doc?.uri ?? doc?.path ?? '');
								if (!s) { return ''; }
								if (s.startsWith('file:///')) { s = s.slice(8); }
								else if (s.startsWith('file://')) { s = s.slice(7); }
								try { s = decodeURIComponent(s); } catch { /* 非法转义就按原样用 */ }
								s = s.replace(/\\/g, '/');
								if (/^\/[A-Za-z]:\//.test(s)) { s = s.slice(1); }
								return s.toLowerCase();
							};
							const tagMap = new Map();
							for (const doc of vault.docs ?? []) {
								const abs = absOfDoc(doc);
								for (const tag of (Array.isArray(doc.tags) ? doc.tags : []).filter(Boolean).map(String)) {
									const entry = tagMap.get(tag) ?? { count: 0, paths: new Set() };
									entry.count += 1;
									if (abs) { entry.paths.add(abs); }
									tagMap.set(tag, entry);
								}
							}
							const tags = [...tagMap.entries()]
								.map(([tag, entry]) => ({ tag, count: entry.count, paths: [...entry.paths] }))
								.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
								.slice(0, 300);
							Object.assign(out, {
								vaultName: vaultDisplayNameFrom(config, vault.id),
								activeVaultId: vault.id,
								vaults: vaults.map(v => ({
									id: v.id,
									name: vaultDisplayNameFrom(config, v.id),
									// 口径：当前库给**笔记篇数**（与状态栏 `N 篇` 同源，避免出现 239 这种混合计数）；
									// 其它库拿不到叶子计数 ⇒ 退回 totalDocs（仅用于下拉里的粗略提示）。
									count: v.id === vault.id ? notesSection.files : (v.totalDocs ?? 0),
									// 写操作要用库根做「绝对路径 → 库内相对路径」折算 ⇒ 一并给出
									dir: v.dir,
								})),
								noteCount: notesSection.files,
								tree: mapNodes(notesSection.nodes),
								library: mapNodes(libSection.nodes),
								libraryCount: libSection.files,
								tags,
							});
							// 双链（可缺）：失败只影响「双链」这一节，不影响主体
							try {
								const notesDir = join(vault.dir, NOTES_DIR);
								const now = Date.now();
								const cached = graphCache.get(notesDir);
								const fresh = url.searchParams.get('refresh') === '1' ? undefined
									: (cached && (now - cached.at) < GRAPH_CACHE_TTL_MS ? cached.data : undefined);
								const graphData = fresh ?? buildGraphData(await readNotesForGraph(notesDir));
								if (!fresh) { graphCache.set(notesDir, { at: now, data: graphData }); }
								const byId = new Map((graphData.nodes ?? []).map(n => [n.id, n]));
								const base = String(vault.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
								const absKey = id => (base ? base + '/' + String(id) : String(id));
								const labelOf = id => {
									const n = byId.get(id);
									return n && n.label ? String(n.label) : String(id).split('/').pop().replace(/\.md$/i, '');
								};
								const links = {};
								const slot = (id) => { const k = absKey(id); return links[k] || (links[k] = { out: [], in: [] }); };
								for (const e of graphData.edges ?? []) {
									if (!e || !e.source || !e.target) { continue; }
									slot(e.source).out.push({ title: labelOf(e.target), path: absKey(e.target) });
									slot(e.target).in.push({ title: labelOf(e.source), path: absKey(e.source) });
								}
								out.links = links;
							} catch { /* 图谱不可用 ⇒ 组件不显示双链节（如实降级） */ }
						}
						// 只在有库时缓存（未连接状态不值得缓存，也不该挡住"接上库之后立刻可见"）
						if (cacheKey) {
							try { VIEW_DATA_CACHE.set(cacheKey, { at: Date.now(), sig: await vaultSigOf(vault.dir), data: out }); } catch { /* 缓存失败不影响返回 */ }
						}
						send(200, { ok: true, cached: false, data: out });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-22（工作台重构 §5 步骤 2，知识库**第一刀：只读面**）：
				//   库 + 两个文件树（库 / 笔记）+ 标签分类 + 自诊断 ⇒ 一次取全，React 工作台照着画 ✓。
				//   ⚠ 正文**不塞进这里**（库大时是几百 KB 的重复传输 ✗，与 `/api/doc` 同一条理由）⇒
				//     点某个文件时再走现成的 `GET /api/doc?uri=` ✓；检索走现成的 `GET /api/search?q=` ✓。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/page`) {
					try {
						const root = kbRootOf(config);
						const snapshot = await pageSnapshotOf(root, { external: externalVaultRecords(config) });
			// ★ 2026-10-23：记下本次列出的库根（含外挂库）⇒ `/api/doc` 用它做围栏的允许根
			LAST_VAULT_DIRS = (snapshot.vaults ?? []).map(v => v.dir).filter(Boolean);
						const injected = parseInjectedVaults(config?.kbVaults);
						const nameOf = id => (injected ?? []).find(item => item.id === id)?.name || id;
						const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
						const vaults = [];
						for (const vault of snapshot.vaults ?? []) {
							const sections = {};
							// ⚠ 键用**稳定英文名**（`library` / `notes`），值才是那两节的中文目录名
							//   —— 直接把 `LIBRARY_DIR` 当键会让客户端读 `sections.library` 时拿到 undefined ✗（实测踩到）。
							for (const [key, section] of [['library', LIBRARY_DIR], ['notes', NOTES_DIR]]) {
								const tree = await listVaultTree(vault.dir, { section });
								// ⚠ 每个**文件**节点带 `abs`：组件拿它直接喂 `/api/doc?uri=`（普通绝对路径也认 ✓，
								//   不必赌索引里那份 `file:///…` 形态一定匹配得上 ✓）
								const withAbs = nodes => (nodes ?? []).map(node => (node.isDirectory
									? { name: node.name, rel: node.rel, isDirectory: true, children: withAbs(node.children) }
									: { name: node.name, rel: node.rel, isDirectory: false, size: node.size, mtime: node.mtime, abs: join(vault.dir, section, ...String(node.rel).split('/')) }));
								sections[key] = { label: section, nodes: withAbs(tree.nodes), files: tree.files ?? 0, dirs: tree.dirs ?? 0, truncated: !!tree.truncated, missing: !!tree.missing };
							}
							const tagMap = new Map();
							const untagged = [];
							for (const doc of vault.docs ?? []) {
								const names = (Array.isArray(doc.tags) ? doc.tags : []).filter(Boolean).map(String);
								const label = String(doc.name ?? doc.title ?? doc.uri ?? '');
								if (!names.length) { untagged.push({ label, uri: String(doc.uri ?? '') }); continue; }
								for (const tag of names) {
									const entry = tagMap.get(tag) ?? { count: 0, names: [] };
									entry.count += 1;
									entry.names.push({ label, uri: String(doc.uri ?? '') });
									tagMap.set(tag, entry);
								}
							}
							const tags = [...tagMap.entries()].map(([tag, e]) => ({ tag, count: e.count, names: e.names }))
								.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
							vaults.push({
								id: String(vault.id ?? ''),
								name: nameOf(vault.id),
								dir: String(vault.dir ?? ''),
								totalDocs: vault.totalDocs ?? 0,
								indexed: snapshot.docCounts?.get(vault.id) ?? 0,
								kernelBytes: vault.kernelBytes ?? null,
								notes: Array.isArray(vault.notes) ? vault.notes : [],
								sections,
								tags,
								untagged: untagged.slice(0, 50),
							});
						}
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({
							ok: true,
							root,
							missing: snapshot.missing ?? '',
							cached: !!snapshot.cached,
							totalDocs: (snapshot.vaults ?? []).reduce((sum, v) => sum + (v.totalDocs ?? 0), 0),
							activeVault: typeof config?.kbActiveVaultId === 'string' ? config.kbActiveVaultId.trim() : '',
							injectedNames: !!injected,
							tools: toolsRegistered,
							vaults,
						}));
					} catch (e) {
						res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
					}
					return;
				}
				if (url && url.pathname === `${ROUTE_PREFIX}/api/search`) {
					try {
						const query = url.searchParams.get('q') ?? '';
						const wantedVault = url.searchParams.get('vault') ?? '';
						const result = await runFulltextSearch(kbRootOf(config), {
							wantedVault: wantedVault || undefined, query, limit: 20, config,
						});
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						// ★ 把 §16.11 的**自动重建结果**也带回页面 ✗（2026-10-14 由 p3-73 ⑤-b 咬出来：
						//   这条路由原先只回 `count/totalHits/items` ⇒ 页面**用了旧索引也不说** ✗ ——
						//   "重建失败要如实标注"这条纪律在 agent 侧（`kb_search`）一直有 ✓，页面这条漏了 ✓）。
						res.end(JSON.stringify({
							ok: true, count: result.count, totalHits: result.totalHits, items: result.items,
							...(Array.isArray(result.reindex) && result.reindex.length ? { reindex: result.reindex } : {}),
						}));
					} catch (e) {
						res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
					}
					return;
				}
				// ★ 2026-10-24：**保存正文**（dsh 侧行内编辑 / 任务清单勾选都用这条）。
				//   围栏比读取更严一档 —— 只允许写「笔记」区里的 `.md`：
				//     · 库区（`库/`）是只读素材，任何写请求 403；
				//     · 路径必须落在「库根 + 页面列过的库根」之内（段边界比较）；
				//     · 只收 .md、单文件 ≤ 4MB（超出当异常，避免误把二进制当文本写坏）。
				//   ⚠ 必须放在 GET 那条**之前**：下面那条 `=== /api/doc` 没有方法判断，
				//     放在后面 POST 会被它当读请求吃掉 ✗。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/doc` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 4 * 1024 * 1024) { send(413, { ok: false, error: '正文超过 4MB' }); return; }
						}
						const payload = JSON.parse(raw || '{}');
						const uri = String(payload?.uri ?? '').trim();
						const text = payload?.text;
						if (!uri || typeof text !== 'string') { send(400, { ok: false, error: '需要 uri 与 text' }); return; }
						const p = resolve(decodeURIComponent(uri));
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS].filter(Boolean).map(r => resolve(String(r)));
						const inside = roots.some(r => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
						if (!inside) { send(403, { ok: false, error: '拒绝写入库外文件：' + p }); return; }
						const rel = p.replace(/\\/g, '/');
						if (!rel.includes('/' + NOTES_DIR + '/')) { send(403, { ok: false, error: '只允许写入「笔记」区（库区只读）：' + p }); return; }
						if (!/\.md$/i.test(p)) { send(400, { ok: false, error: '只支持 .md 文件' }); return; }
						// ★ 前置校验（2026-10-24）：客户端带上来"我读到时的 mtime"，若磁盘已变 ⇒ 409，
						//   让用户决定是否覆盖。容忍 1s 误差（不同文件系统 mtime 精度不同）。
						const expected = Number(payload?.expectedMtime ?? 0) || 0;
						let before = null;
						try { before = await stat(p); } catch { before = null; }
						if (expected > 0 && before && Math.abs(before.mtimeMs - expected) > 1000) {
							send(409, {
								ok: false,
								conflict: true,
								mtime: before.mtimeMs,
								error: '文件已被其他程序修改（磁盘 mtime 比读入时更新）。确认覆盖请重试，或先重新打开该笔记。',
							});
							return;
						}
						// 备份：写进 `笔记/.kb-backup/`（以 `.kb` 开头 ⇒ 树里被噪音过滤掉，不污染目录）
						let backup = '';
						if (before && before.isFile() && before.size > 0) {
							try {
								const notesRoot = join(dirname(p), '.kb-backup');
								await mkdir(notesRoot, { recursive: true });
								backup = join(notesRoot, `${basename(p)}.${new Date().toISOString().replace(/[:.]/g, '-')}.md.bak`);
								await writeFile(backup, await readFile(p));
								// 只保留最近 20 份（文件名带 ISO 时间戳 ⇒ 字典序≈时间序）。
								// 不清理的话，每保存一次留一份，长期会把 `.kb-backup` 撑到几百个文件。
								try {
									const dir = join(dirname(p), '.kb-backup');
									const prefix = `${basename(p)}.`;
									const olds = (await readdir(dir)).filter(f => f.startsWith(prefix) && f.endsWith('.md.bak')).sort();
									for (const f of olds.slice(0, Math.max(0, olds.length - 20))) {
										await rm(join(dir, f), { force: true });
									}
								} catch { /* 清理失败不影响本次保存 */ }
							} catch { backup = ''; }   // 备份失败不阻断保存（如实返回 backup 为空）
						}
						await writeFile(p, text, 'utf8');
						const after = await stat(p).catch(() => null);
						send(200, {
							ok: true, path: p,
							bytes: Buffer.byteLength(text, 'utf8'),
							mtime: after ? after.mtimeMs : 0,
							backup: backup || undefined,
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-24：**附件上传**（编辑器里粘贴 / 拖入图片）。
				//   协议：`POST /api/asset/upload?doc=<当前笔记绝对路径>&name=<文件名>`，body = **原始字节**。
				//   为什么不用 multipart：解析器要自己写一大坨，而这里只需要"一个文件 + 一个文件名"，
				//   直接把 Blob 当 body 发最省事（浏览器原生支持，服务端按 chunk 收）。
				//   落点：`<笔记根>/_assets/<时间戳>-<安全名>`（`_assets` 不是 `.kb*` ⇒ 会出现在树里，
				//   这是有意的：用户要能看到并整理自己的图片）。
				//   围栏：`doc` 必须落在库根内、且属「笔记」区（库区只读）；扩展名白名单同 `/api/asset`。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/asset/upload`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						if (req.method !== 'POST') { send(405, { ok: false, error: '请用 POST' }); return; }
						const docPath = resolve(decodeURIComponent(url.searchParams.get('doc') ?? '')).replace(/\\/g, '/');
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS].filter(Boolean).map(r => resolve(String(r)));
						// ⚠ 必须**两边都归一成正斜杠**再比：`docPath` 已在上面转成 `/`，
						//   而 roots 是 `resolve()` 出来的 Windows 反斜杠路径 ⇒ 直接 startsWith 永远 false
						//   （上一版就是这样：所有上传都判成"库外" ⇒ 403）。用段边界 `root + '/'` 防 `/vault-other`。
						const slash = (s) => String(s).replace(/\\/g, '/').replace(new RegExp('/+$'), '');
						const inside = roots.some(r => { const rr = slash(r); return docPath === rr || docPath.startsWith(rr + '/'); });
						if (!inside) { send(403, { ok: false, error: '拒绝写入库外文件：' + docPath }); return; }
						const cut = docPath.indexOf('/' + NOTES_DIR + '/');
						if (cut < 0) { send(403, { ok: false, error: '只能在「笔记」区插入附件' }); return; }
						const rawName = String(url.searchParams.get('name') ?? 'pasted.png');
						const ext = extname(rawName).slice(1).toLowerCase();
						if (!ASSET_MIME[ext]) { send(400, { ok: false, error: '不支持的附件类型：.' + ext }); return; }
						const safe = (basename(rawName) || 'file.' + ext).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
						const chunks = [];
						let total = 0;
						for await (const chunk of req) {
							total += chunk.length;
							if (total > ASSET_MAX_BYTES) { send(413, { ok: false, error: '附件超过 ' + Math.round(ASSET_MAX_BYTES / 1024 / 1024) + 'MB' }); return; }
							chunks.push(chunk);
						}
						const buf = Buffer.concat(chunks);
						if (!buf.length) { send(400, { ok: false, error: '空文件' }); return; }
						const notesRoot = docPath.slice(0, cut + 1 + NOTES_DIR.length);
						const assetsDir = notesRoot + '/_assets';
						await mkdir(assetsDir, { recursive: true });
						const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
						const abs = assetsDir + '/' + stamp + '-' + safe;
						await writeFile(abs, buf);
						const rel = relative(dirname(docPath), abs).replace(/\\/g, '/');
						send(200, { ok: true, abs, rel, bytes: buf.length });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-24：**飞书 CLI 状态 / 升级**（对齐 IDE 设置页的「重新检测 / ⬆️ 升级 lark-cli」）
				if (url && url.pathname === `${ROUTE_PREFIX}/api/feishu-cli`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let cliPath = String(url.searchParams.get('cli') ?? '').trim();
						let action = '';
						if (req.method === 'POST') {
							let raw = '';
							for await (const chunk of req) {
								raw += chunk;
								if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大' }); return; }
							}
							const body = JSON.parse(raw || '{}');
							action = String(body?.action ?? '');
							cliPath = String(body?.cliPath ?? cliPath).trim();
						}
						// 未显式给路径 ⇒ 用设置里保存的 `feishu.cliPath`（与 IDE 同一个键）
						if (!cliPath) {
							try {
								const obj = JSON.parse(readFileSync(join(kbRootOf(config), '.kb-settings.json'), 'utf8'));
								cliPath = String((obj && obj.feishu && obj.feishu.cliPath) || '').trim();
							} catch { /* 无设置文件 ⇒ 走 PATH */ }
						}
						const exe = cliPath || DEFAULT_LARK_CLI;
						if (action === 'upgrade') {
							const up = await runLarkCli(exe, ['update'], 180000);
							send(200, {
								ok: up.code === 0,
								code: up.code,
								output: String((up.stdout || '') + (up.stderr || '')).slice(-2000),
							});
							return;
						}
						const ver = await runLarkCli(exe, ['--version'], 15000);
						const text = String(ver.stdout || ver.stderr || '').trim();
						send(200, {
							ok: ver.code === 0,
							exe,
							version: text.split(/\r?\n/)[0] || '',
							// ★ 2026-10-24：失败时**必须带安装/配置指引**。
							//   原来只回 `spawn lark-cli ENOENT` —— 那句既可能是"没装"，也可能是
							//   "npm 装成了 lark-cli.cmd、这种启动方式找不到"，两种对策完全不同，
							//   只给原始错误等于把判断成本丢给用户。
							error: ver.code === 0 ? '' : (String(ver.stderr || '').slice(-400) + '\n' + LARK_CLI_MISSING_HINT).trim(),
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-24：**飞书知识库列表**（目录映射右侧下拉的数据源，对齐 IDE 的「🔄 刷新知识库列表」）
				if (url && url.pathname === `${ROUTE_PREFIX}/api/feishu-spaces`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						// 优先用设置里的 cliPath（IDE 侧同一个键：`…kb.feishu.cliPath`）
						let cli = String(url.searchParams.get('cli') ?? '').trim();
						if (!cli) {
							try {
								const obj = JSON.parse(readFileSync(join(kbRootOf(config), '.kb-settings.json'), 'utf8'));
								cli = String((obj && obj.feishu && obj.feishu.cliPath) || '').trim();
							} catch { /* 无设置文件 */ }
						}
						const r = await runLarkCli(cli || DEFAULT_LARK_CLI, SPACE_LIST_ARGS, 30000);
						if (r.code !== 0) {
							send(200, {
								ok: false,
								error: String((r.stderr || r.stdout || '')).slice(-800) || LARK_CLI_MISSING_HINT,
							});
							return;
						}
						// 不同 lark-cli 版本的字段名不一致 ⇒ 三种形态都试，拿不到就回空表（不猜）
						let spaces = [];
						try {
							const j = JSON.parse(String(r.stdout || '{}'));
							// ⚠ 2026-10-24（真机：点「刷新知识库列表」没反应）：lark-cli 的真实形态是
							//   `{ ok, identity, data: { spaces: [ { name, space_id, … } ] } }`，
							//   而这里原来只查 `items / data.items / spaces` ⇒ 永远拿到空数组
							//   ⇒ 接口回 ok:true + 0 条，界面看起来"什么都没发生"。
							const arr = Array.isArray(j?.data?.spaces) ? j.data.spaces
								: Array.isArray(j?.spaces) ? j.spaces
									: Array.isArray(j?.items) ? j.items
										: Array.isArray(j?.data?.items) ? j.data.items : [];
							spaces = arr.map(it => ({
								id: String(it?.space_id ?? it?.token ?? it?.id ?? ''),
								name: String(it?.name ?? it?.title ?? ''),
							})).filter(s => s.id);
						} catch { spaces = []; }
						send(200, { ok: true, spaces });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-24：**同步日志**（对齐 IDE 的「📄 查看同步日志」）—— 落盘 `<vault>/.kb-feishu-sync.log`
				if (url && url.pathname === `${ROUTE_PREFIX}/api/feishu-log`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const want = String(url.searchParams.get('vault') ?? '').trim();
						const { vaults } = await listAllVaults(kbRootOf(config), config, { withDocs: false });
						const vault = (want && vaults.find(v => v.id === want)) || vaults.find(v => v.id === config?.kbActiveVaultId) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						const file = join(vault.dir, '.kb-feishu-sync.log');
						let text = '';
						try { text = await readFile(file, 'utf8'); } catch { text = ''; }
						const n = Math.max(20, Math.min(2000, Number(url.searchParams.get('lines') ?? 200) || 200));
						const lines = text.split(/\r?\n/).filter(Boolean);
						send(200, { ok: true, exists: !!text, lines: lines.slice(-n), vault: { id: vault.id, dir: vault.dir } });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-24：**同步飞书**（面板 / 插件页的「☁」按钮）。
				//   复用随包脚本 `feishu-sync.mjs`（与 `kb_feishu_sync` 工具同一份实现，不重写逻辑）：
				//   同步本身是**逐篇串行**的长任务（上限 5 分钟），所以这里同步等待并回日志尾部，
				//   成功与否以**退出码**为准（脚本对"部分失败"也可能回 0 ⇒ 回里同时给 output 供人判断）。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/feishu-sync` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const dry = url.searchParams.get('dry') === '1';
						// 与定时器共用同一条实现（映射/冲突策略/间隔/prune/日志都在 performFeishuSync 里）
						const r = await performFeishuSync(config, { dry });
						if (r.error) { send(400, { ok: false, error: r.error }); return; }
						send(200, r);
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**定时同步状态**（设置页用来显示"下次运行 / 上次结果"）
				if (url && url.pathname === `${ROUTE_PREFIX}/api/feishu-schedule`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const cfg = await readFeishuSettings(config);
						const everyMin = Math.max(5, Number(cfg.scheduleMinutes) || 60);
						const active = !!(cfg.enabled && cfg.schedule);
						const nextRunAt = active
							? (SYNC_STATE.lastAt ? SYNC_STATE.lastAt + everyMin * 60000 : Date.now() + 60000)
							: 0;
						send(200, {
							ok: true,
							active,
							enabled: !!cfg.enabled,
							schedule: !!cfg.schedule,
							everyMinutes: everyMin,
							running: SYNC_STATE.running,
							lastRunAt: SYNC_STATE.lastAt,
							lastCode: SYNC_STATE.lastCode,
							lastError: SYNC_STATE.lastError,
							nextRunAt,
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**体检报告（只读）** —— 对应 IDE 侧的「体检」入口。
				//   为什么先做只读：它会给出"哪篇该修"的判断，改不改由用户决定；
				//   自动改（去重/迁移）属于写操作，风险完全不同，留到确认后再做。
				//   数据全部来自已有扫描（树 + 图谱缓存 + 双链解析器）⇒ 不额外解析正文。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/health`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						const vaults = snapshot.vaults ?? [];
						const want = String(url.searchParams.get('vault') ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (want && vaults.find(v => v.id === want)) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						LAST_VAULT_DIRS = vaults.map(v => v.dir).filter(Boolean);

						const tree = await listVaultTree(vault.dir, { section: NOTES_DIR });
						const files = [];
						const emptyDirs = [];
						const walk = (nodes, rel) => {
							for (const n of nodes ?? []) {
								const relPath = rel ? rel + '/' + n.rel : n.rel;
								if (n.isDirectory) {
									// 隐藏目录（`.module` 等）不算"空目录"，否则报告里全是噪音
									if (!(n.children ?? []).length && !String(n.name).startsWith('.')) { emptyDirs.push(relPath); }
									walk(n.children, rel);
								} else if (!String(n.name).startsWith('.')) {
									files.push({ rel: relPath, name: n.name, size: n.size });
								}
							}
						};
						walk(tree.nodes, '');

						// 双链：用与渲染同一套解析器，找出**指向不存在笔记**的链接
						const notesDir = join(vault.dir, NOTES_DIR);
						const now = Date.now();
						const cachedGraph = graphCache.get(notesDir);
						const graphData = (cachedGraph && (now - cachedGraph.at) < GRAPH_CACHE_TTL_MS)
							? cachedGraph.data
							: buildGraphData(await readNotesForGraph(notesDir));
						if (!cachedGraph || (now - cachedGraph.at) >= GRAPH_CACHE_TTL_MS) { graphCache.set(notesDir, { at: now, data: graphData }); }

						const resolveWiki = await wikiResolverFor(vault.dir);
						const fs2 = await readNotesForGraph(notesDir);
						// 候选目标（供"断链修复"用）：库里所有笔记名（去扩展名）
						const allNames = fs2.map(n => String(n.rel).replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, ''));
						const nameSet = new Set(allNames.map(s => s.toLowerCase()));
						const lev = (a, b) => {
							// 小编辑距离：只用于"这批断链里最像哪一个"，不上大算法
							const m = a.length; const n = b.length;
							if (Math.abs(m - n) > 3) { return 99; }
							let prev = Array.from({ length: n + 1 }, (_, j) => j);
							for (let i = 1; i <= m; i++) {
								const cur = [i];
								for (let j = 1; j <= n; j++) {
									cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
								}
								prev = cur;
							}
							return prev[n];
						};
						const suggestOf = (target) => {
							const t = String(target).toLowerCase();
							if (nameSet.has(t)) { return allNames.find(s => s.toLowerCase() === t) || ''; }
							// 包含关系（`05 DSH 框架原理` ⊂ `05a DSH 框架原理（讲懂版）`）
							const subset = allNames.filter(s => s.toLowerCase().includes(t) || t.includes(s.toLowerCase()));
							if (subset.length === 1) { return subset[0]; }
							let best = '';
							let bestD = 3;
							for (const s of allNames) {
								const d = lev(t, s.toLowerCase());
								if (d < bestD) { bestD = d; best = s; }
							}
							return bestD <= 2 ? best : '';
						};

						const broken = [];
						const seenBroken = new Set();
						for (const note of fs2) {
							const content = String(note.content ?? note.text ?? '');
							const rel = String(note.rel).replace(/\\/g, '/');
							const re = /\[\[([^\]\n]+)\]\]/g;
							let m;
							while ((m = re.exec(content)) !== null) {
								// 表格里的双链要写 `[[笔记\|别名]]` ⇒ 先还原转义竖线再拆，否则目标名带反斜杠必然"断链"
								const target = m[1].replace(/\\\|/g, '|').split('|')[0].split('#')[0].trim();
								if (!target) { continue; }
								if (resolveWiki(target)) { continue; }
								const key = rel + '->' + target;
								if (seenBroken.has(key)) { continue; }
								seenBroken.add(key);
								broken.push({
									from: rel,
									fromAbs: join(notesDir, ...rel.split('/')),
									target,
									suggest: suggestOf(target),
								});
								if (broken.length >= 200) { break; }
							}
						}

						// 孤立笔记：图谱里入度出度都为 0
						const degree = new Map();
						for (const n of graphData.nodes ?? []) { degree.set(n.id, 0); }
						for (const e of graphData.edges ?? []) {
							degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
							degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
						}
						const orphans = (graphData.nodes ?? [])
							.filter(n => (degree.get(n.id) ?? 0) === 0)
							.map(n => String(n.id))
							.slice(0, 200);

						// 无标签 / 无 frontmatter
						const noTags = [];
						const noFrontmatter = [];
						for (const doc of vault.docs ?? []) {
							const rel = String(doc.rel ?? doc.uri ?? '').replace(/\\/g, '/');
							if (!Array.isArray(doc.tags) || !doc.tags.length) { noTags.push(rel); }
						}
						for (const note of fs2) {
							if (!/^---\r?\n/.test(String(note.content ?? note.text ?? ''))) {
								noFrontmatter.push(String(note.rel).replace(/\\/g, '/'));
							}
						}

						// 同名笔记（双链 `[[名字]]` 会解析到其中一篇，容易指错）
						const byName = new Map();
						for (const f of files) {
							const base = String(f.name).replace(/\.md$/i, '');
							const list = byName.get(base) ?? [];
							list.push(f.rel);
							byName.set(base, list);
						}
						const dupNames = [...byName.entries()]
							.filter(([, list]) => list.length > 1)
							.map(([name, paths]) => ({ name, paths }))
							.slice(0, 50);

						send(200, {
							ok: true,
							vault: { id: vault.id, name: vaultDisplayNameFrom(config, vault.id), dir: vault.dir },
							report: {
								total: files.length,
								nodes: (graphData.nodes ?? []).length,
								edges: (graphData.edges ?? []).length,
								orphanCount: orphans.length,
								orphans: orphans.slice(0, 50),
								brokenCount: broken.length,
								broken: broken.slice(0, 50),
								noTagCount: noTags.length,
								noTags: noTags.slice(0, 50),
								noFrontmatterCount: noFrontmatter.length,
								noFrontmatter: noFrontmatter.slice(0, 50),
								emptyDirCount: emptyDirs.length,
								emptyDirs: emptyDirs.slice(0, 50),
								dupNameCount: dupNames.length,
								dupNames,
							},
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**清理空目录**（体检的"动手"第一项，风险最低）。
				//   安全基线：
				//     · 只在**当前库的「笔记」区**内操作（越界一律拒绝）
				//     · 删除前**重新 readdir**，只有真为 0 项才删（防止扫描后有人往里放了文件）
				//     · 非递归删除（`rm` 不带 recursive）⇒ 非空目录直接失败，不会连带删内容
				//     · 隐藏目录（`.kb-*` / `.module`）跳过
				if (url && url.pathname === `${ROUTE_PREFIX}/api/health/cleanup` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大' }); return; }
						}
						const body = JSON.parse(raw || '{}');
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						const vaults = snapshot.vaults ?? [];
						const want = String(body?.vault ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (want && vaults.find(v => v.id === want)) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						const notesRoot = join(vault.dir, NOTES_DIR);
						const deleted = [];
						const skipped = [];
						// 多轮扫描：删掉最内层空目录后，父目录可能也空了
						for (let round = 0; round < 5; round++) {
							const empties = [];
							const walk = async (dir) => {
								let ents = [];
								try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
								const subdirs = ents.filter(e => e.isDirectory() && !e.name.startsWith('.'));
								for (const d of subdirs) { await walk(join(dir, d.name)); }
								if (!ents.length) { empties.push(dir); }
							};
							await walk(notesRoot);
							if (!empties.length) { break; }
							let removed = 0;
							for (const dir of empties) {
								if (dir === notesRoot) { continue; }   // 笔记根永远保留
								try {
									const left = await readdir(dir);
									if (left.length) { skipped.push({ dir, reason: '已非空' }); continue; }
									// `rm(dir, { recursive: false })` 会 EISDIR（Node 的 rm 不接受目录）⇒ 用 `rmdir`：
									// 它**只删空目录**，非空时抛 ENOTEMPTY —— 正是我们要的"绝不会连带删内容"语义。
									await rmdir(dir);
									deleted.push(dir);
									removed += 1;
								} catch (e) {
									skipped.push({ dir, reason: String(e?.message ?? e) });
								}
							}
							if (!removed) { break; }
						}
						send(200, {
							ok: true,
							vault: { id: vault.id, name: vaultDisplayNameFrom(config, vault.id) },
							deletedCount: deleted.length,
							deleted: deleted.slice(0, 100).map(d => String(d).replace(/\\/g, '/').slice(String(vault.dir).replace(/\\/g, '/').length + 1)),
							skippedCount: skipped.length,
							skipped: skipped.slice(0, 20),
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**修一条断链**（体检的第二个写操作）。
				//   只做**最小改动**：把 `[[目标` 这个前缀替换成 `[[新目标`，别名与 `#段落` 原样保留。
				//   围栏与 `POST /api/doc` 同源（库内 + 笔记区 + .md），并同样做 mtime 前置校验 + 自动备份。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/health/fix-link` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 65536) { send(413, { ok: false, error: '请求体太大' }); return; }
						}
						const body = JSON.parse(raw || '{}');
						const target = String(body?.target ?? '').trim();
						const replacement = String(body?.replacement ?? '').trim();
						if (!target || !replacement) { send(400, { ok: false, error: '需要 target 与 replacement' }); return; }
						const p = resolve(String(body?.uri ?? ''));
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS]
							.filter(Boolean).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, ''));
						const abs = p.replace(/\\/g, '/');
						const inside = roots.some(r => abs.toLowerCase().startsWith(r.toLowerCase() + '/'));
						if (!inside) { send(403, { ok: false, error: '拒绝写入库外文件：' + p }); return; }
						if (!abs.includes('/' + NOTES_DIR + '/')) { send(403, { ok: false, error: '只允许修改「笔记」区' }); return; }
						if (!/\.md$/i.test(p)) { send(400, { ok: false, error: '只支持 .md 文件' }); return; }
						// 新目标必须**能解析到真实笔记**，否则等于把断链换成另一条断链
						const vaultDir2 = roots.filter(r => abs.toLowerCase().startsWith(r.toLowerCase() + '/')).sort((a, b) => b.length - a.length)[0] || '';
						const resolver = await wikiResolverFor(vaultDir2);
						if (!resolver(replacement)) { send(400, { ok: false, error: '新目标在库里找不到：' + replacement }); return; }

						const text = await readFile(p, 'utf8');
						const from = '[[' + target;
						const occur = text.split(from).length - 1;
						if (!occur) { send(400, { ok: false, error: '该文件里找不到 [[' + target + '（可能已修过）' }); return; }

						const expected = Number(body?.expectedMtime ?? 0) || 0;
						const before = await stat(p).catch(() => null);
						if (expected > 0 && before && Math.abs(before.mtimeMs - expected) > 1000) {
							send(409, { ok: false, conflict: true, mtime: before.mtimeMs, error: '文件已被其他程序修改，请重新打开该笔记后再修。' });
							return;
						}
						// 备份（与保存同一条路径：`.kb-backup/` 不进树）
						try {
							const dir = join(dirname(p), '.kb-backup');
							await mkdir(dir, { recursive: true });
							await writeFile(join(dir, `${basename(p)}.${new Date().toISOString().replace(/[:.]/g, '-')}.md.bak`), text, 'utf8');
						} catch { /* 备份失败不阻断（如实回 backup 省略） */ }

						const next = text.split(from).join('[[' + replacement);
						await writeFile(p, next, 'utf8');
						const after = await stat(p).catch(() => null);
						send(200, { ok: true, replaced: occur, mtime: after ? after.mtimeMs : 0 });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**重建索引**（对应 IDE 设置页的「🔄 重新构建向量索引」）。
				//   ⚠ 如实分界：
				//     · `kernel`（`.kbkernel.json`）与全文 BM25 都是**纯本地计算** ⇒ dsh 侧可以重建；
				//     · **向量索引（embedding）需要模型 provider**，那是 IDE 侧能力 ⇒ dsh 侧不做，
				//       路由里明确回 `vector: { supported: false, reason }`，页面也照实标注，不放假按钮。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/reindex`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					if (req.method === 'GET') {
						send(200, {
							ok: true,
							running: REINDEX_STATE.running,
							lastAt: REINDEX_STATE.lastAt,
							lastDocs: REINDEX_STATE.docs,
							lastError: REINDEX_STATE.lastError,
							vector: { supported: false, reason: '向量索引需要 embedding provider（IDE 侧全局配置），dsh 侧暂无该能力' },
						});
						return;
					}
					if (req.method !== 'POST') { send(405, { ok: false, error: '请用 GET 或 POST' }); return; }
					if (REINDEX_STATE.running) { send(409, { ok: false, error: '已有重建任务在进行' }); return; }
					REINDEX_STATE.running = true;
					REINDEX_STATE.lastError = '';
					try {
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						const vaults = snapshot.vaults ?? [];
						const want = String(url.searchParams.get('vault') ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (want && vaults.find(v => v.id === want)) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						// 重建内核缓存（含逐篇正文提取与标签），返回 docs 数组用于计数
						const r = await rebuildKernelCache(vault.dir);
						const docs = Array.isArray(r?.docs) ? r.docs.length : 0;
						REINDEX_STATE.lastAt = Date.now();
						REINDEX_STATE.docs = docs;
						send(200, {
							ok: true,
							vault: { id: vault.id, name: vaultDisplayNameFrom(config, vault.id), dir: vault.dir },
							docs,
							kernelFile: r?.path ? String(r.path).replace(/\\/g, '/').split('/').pop() : '',
							vector: { supported: false, reason: '向量索引需要 embedding provider（IDE 侧全局配置），dsh 侧暂无该能力' },
						});
					} catch (e) {
						REINDEX_STATE.lastError = String(e?.message ?? e);
						send(500, { ok: false, error: REINDEX_STATE.lastError });
					} finally {
						REINDEX_STATE.running = false;
					}
					return;
				}
				// ★ 2026-10-25：**导图（.canvas）**—— IDE 侧「思维导图」的等价入口。
				//   为什么不是"跳编辑器"：dsh 面板没有编辑器，`/api/mindmap` 那条只回"文件路径"，
				//   在面板里等于打不开。⇒ 这里**把 .canvas 解析成节点/边**回给前端自己画，
				//   点击带 `source.file` 的节点可以跳回对应笔记。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/canvas`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const uri = String(url.searchParams.get('uri') ?? '');
						if (!uri) { send(400, { ok: false, error: '缺少 uri' }); return; }
						const p = resolve(decodeURIComponent(uri));
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS]
							.filter(Boolean).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, ''));
						const abs = p.replace(/\\/g, '/');
						if (!roots.some(r => abs.toLowerCase().startsWith(r.toLowerCase() + '/'))) {
							send(403, { ok: false, error: '拒绝读取库外文件' });
							return;
						}
						if (!/\.canvas$/i.test(p)) { send(400, { ok: false, error: '只支持 .canvas' }); return; }
						const raw = await readFile(p, 'utf8');
						const j = JSON.parse(raw);
						const rawNodes = Array.isArray(j?.nodes) ? j.nodes : [];
						const rawEdges = Array.isArray(j?.edges) ? j.edges : [];
						// 上限保护：真实文件里见过 550 节点，留 4 倍余量
						const nodes = rawNodes.slice(0, 2000).map(n => ({
							id: String(n?.id ?? ''),
							x: Number(n?.x) || 0,
							y: Number(n?.y) || 0,
							w: Number(n?.width) || 240,
							h: Number(n?.height) || 80,
							type: String(n?.type ?? 'text'),
							color: String(n?.color ?? ''),
							text: String(n?.content ?? n?.text ?? '').slice(0, 2000),
							file: n?.source && n.source.file ? String(n.source.file).replace(/\\/g, '/') : '',
						})).filter(n => n.id);
						const ids = new Set(nodes.map(n => n.id));
						const edges = rawEdges.slice(0, 4000).map(e => ({
							from: String(e?.fromNode ?? ''),
							to: String(e?.toNode ?? ''),
							label: String(e?.label ?? ''),
						})).filter(e => ids.has(e.from) && ids.has(e.to));
						// ★ 2026-10-25：`notesRoot` —— 视图侧要把节点里的 `source.file`
						//   （相对「笔记」区）折算回绝对路径才能跳笔记。视图手里没有库根，
						//   所以由服务端直接给（这里有 roots，可以安全反推）。
						const notesRoot = roots
							.map(r => r + '/' + NOTES_DIR)
							.filter(nr => abs.toLowerCase().startsWith(nr.toLowerCase() + '/'))
							.sort((a, b) => b.length - a.length)[0] || '';
						send(200, {
							ok: true,
							name: basename(p).replace(/\.canvas$/i, ''),
							path: abs,
							notesRoot,
							nodes,
							edges,
							totalNodes: rawNodes.length,
							totalEdges: rawEdges.length,
						});
					} catch (e) {
						send(400, { ok: false, error: '解析 .canvas 失败：' + String(e?.message ?? e) });
					}
					return;
				}
				// 导图清单：`笔记` 区里所有 .canvas（面板里的选择器用它）
				if (url && url.pathname === `${ROUTE_PREFIX}/api/canvas-list`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						const vaults = snapshot.vaults ?? [];
						const want = String(url.searchParams.get('vault') ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (want && vaults.find(v => v.id === want)) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						LAST_VAULT_DIRS = vaults.map(v => v.dir).filter(Boolean);
						const notesRoot = join(vault.dir, NOTES_DIR);
						const out = [];
						const walk = async (dir, rel) => {
							let ents = [];
							try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
							for (const e of ents) {
								if (e.name.startsWith('.')) { continue; }
								const childRel = rel ? rel + '/' + e.name : e.name;
								if (e.isDirectory()) { await walk(join(dir, e.name), childRel); continue; }
								if (!/\.canvas$/i.test(e.name)) { continue; }
								const st = await stat(join(dir, e.name)).catch(() => null);
								out.push({
									name: e.name.replace(/\.canvas$/i, ''),
									rel: childRel,
									abs: join(dir, e.name).replace(/\\/g, '/'),
									size: st ? st.size : 0,
									mtime: st ? st.mtimeMs : 0,
								});
								if (out.length >= 200) { return; }
							}
						};
						await walk(notesRoot, '');
						send(200, { ok: true, vault: { id: vault.id, name: vaultDisplayNameFrom(config, vault.id) }, files: out });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**查重（只检测，不改文件）**。
				//   为什么只检测：合并/删除笔记属于不可逆写操作，判定标准因人而异
				//   （"两篇 70% 相似"到底该合还是该留，得人来定）。这里只给候选对 + 相似度，
				//   点开就能读原文自行决定 ⇒ 不会出现"工具把我的笔记改了"这种事。
				//   算法：MinHash(64) + LSH 分带取候选 → 再算真实 Jaccard（阈值 0.6）。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/dedupe`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						const vaults = snapshot.vaults ?? [];
						const want = String(url.searchParams.get('vault') ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (want && vaults.find(v => v.id === want)) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						LAST_VAULT_DIRS = vaults.map(v => v.dir).filter(Boolean);
						const notes = (await readNotesForGraph(join(vault.dir, NOTES_DIR))).slice(0, 500);

						const normalize = (s) => String(s ?? '')
							.replace(/^---\n[\s\S]*?\n---\n/, '')      // frontmatter
							.replace(/```[\s\S]*?```/g, '')            // 代码块（代码雷同不代表内容重复）
							.toLowerCase()
							.replace(/[\s\p{P}\p{S}]+/gu, '');         // 空白/标点/符号
						const hash32 = (s) => {
							let h = 2166136261;
							for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
							return h >>> 0;
						};
						const K = 5;          // 字符 5-gram
						const SIG = 64;       // 签名长度
						const MAXSH = 3000;   // 每篇最多取多少 shingle（控制成本）

						const items = [];
						const exactMap = new Map();
						for (const n of notes) {
							const text = normalize(n.content ?? n.text ?? '');
							if (text.length < 40) { continue; }   // 太短的不参与（噪声大）
							const key = text.slice(0, 400) + '|' + text.length;
							const bucket = exactMap.get(key) ?? [];
							bucket.push(String(n.rel));
							exactMap.set(key, bucket);
							const sh = new Set();
							for (let i = 0; i + K <= text.length && sh.size < MAXSH; i++) { sh.add(hash32(text.slice(i, i + K))); }
							if (sh.size < 8) { continue; }
							const sig = new Uint32Array(SIG);
							sig.fill(0xFFFFFFFF);
							for (const h of sh) {
								for (let s = 0; s < SIG; s++) {
									// 每个槽位一个不同的乘子 ⇒ 近似独立置换
									const v = (Math.imul(h ^ (s * 0x9E3779B1), 0x85EBCA6B + s) >>> 0);
									if (v < sig[s]) { sig[s] = v; }
								}
							}
							items.push({ rel: String(n.rel).replace(/\\/g, '/'), sig, sh });
						}

						// LSH：16 带 × 4 行
						const BANDS = 16;
						const ROWS = SIG / BANDS;
						const buckets = new Map();
						for (let i = 0; i < items.length; i++) {
							for (let b = 0; b < BANDS; b++) {
								const part = Array.from(items[i].sig.subarray(b * ROWS, (b + 1) * ROWS)).join(',');
								const key = b + '#' + hash32(part);
								const arr = buckets.get(key) ?? [];
								arr.push(i);
								buckets.set(key, arr);
							}
						}
						const cand = new Set();
						for (const arr of buckets.values()) {
							if (arr.length < 2 || arr.length > 40) { continue; }   // 超大桶多半是模板文本，跳过
							for (let i = 0; i < arr.length; i++) {
								for (let j = i + 1; j < arr.length; j++) {
									const a = Math.min(arr[i], arr[j]);
									const b = Math.max(arr[i], arr[j]);
									cand.add(a + ',' + b);
								}
							}
						}
						const pairs = [];
						for (const key of cand) {
							const [ai, bi] = key.split(',').map(Number);
							const A = items[ai]; const B = items[bi];
							let inter = 0;
							const [small, big] = A.sh.size <= B.sh.size ? [A.sh, B.sh] : [B.sh, A.sh];
							for (const h of small) { if (big.has(h)) { inter += 1; } }
							const uni = A.sh.size + B.sh.size - inter;
							const sim = uni ? inter / uni : 0;
							if (sim >= 0.6) { pairs.push({ a: A.rel, b: B.rel, similarity: Math.round(sim * 100) / 100 }); }
							if (pairs.length >= 100) { break; }
						}
						pairs.sort((x, y) => y.similarity - x.similarity);
						const exact = [...exactMap.values()].filter(list => list.length > 1).map(list => list.map(p => String(p).replace(/\\/g, '/')));

						send(200, {
							ok: true,
							scanned: items.length,
							threshold: 0.6,
							exactCount: exact.length,
							exact,
							pairCount: pairs.length,
							pairs,
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**审核（review）**—— IDE 侧「审核」入口的等价物。
				//   设计选择（可解释、可回滚）：
				//     · 状态只写在**笔记自己的 frontmatter**（`review: approved|rejected|pending`
				//       + `reviewedAt`）⇒ 不用另建索引文件，跟着笔记走、随 git 一起版本化；
				//     · 只提供**单篇标记**（不做批量），每次写前备份到 `.kb-backup/`，
				//       且只改这几个键，其它 frontmatter 原样保留。
				//   ⇒ "未审" 的定义：没有 `review` 键，或值不是 approved。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/review`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const snapshot = await pageSnapshotOf(kbRootOf(config), { external: externalVaultRecords(config) });
						const vaults = snapshot.vaults ?? [];
						const want = String(url.searchParams.get('vault') ?? config?.kbActiveVaultId ?? '').trim();
						const vault = (want && vaults.find(v => v.id === want)) || vaults[0];
						if (!vault) { send(400, { ok: false, error: '还没有可用的知识库' }); return; }
						LAST_VAULT_DIRS = vaults.map(v => v.dir).filter(Boolean);
						const notesDir = join(vault.dir, NOTES_DIR);
						const notes = await readNotesForGraph(notesDir);
						const statusOf = (text) => {
							const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
							if (!m) { return 'none'; }
							const line = m[1].split(/\r?\n/).find(l => /^review\s*:/.test(l.trim()));
							if (!line) { return 'none'; }
							return String(line.split(':')[1] ?? '').trim().replace(/^["']|["']$/g, '') || 'none';
						};
						const rows = notes.map((n) => {
							const rel = String(n.rel).replace(/\\/g, '/');
							return { rel, abs: join(notesDir, ...rel.split('/')).replace(/\\/g, '/'), status: statusOf(n.content ?? n.text) };
						});
						const unreviewed = rows.filter(r => r.status !== 'approved');
						send(200, {
							ok: true,
							vault: { id: vault.id, name: vaultDisplayNameFrom(config, vault.id) },
							total: rows.length,
							approvedCount: rows.length - unreviewed.length,
							unreviewedCount: unreviewed.length,
							unreviewed: unreviewed.slice(0, 200),
							rejectedCount: rows.filter(r => r.status === 'rejected').length,
						});
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// 单篇标记（approved / rejected / pending）—— 只改 frontmatter 的那几个键
				if (url && url.pathname === `${ROUTE_PREFIX}/api/review/mark` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大' }); return; }
						}
						const body = JSON.parse(raw || '{}');
						const status = String(body?.status ?? '').trim();
						if (!['approved', 'rejected', 'pending'].includes(status)) {
							send(400, { ok: false, error: 'status 只能是 approved / rejected / pending' });
							return;
						}
						const p = resolve(String(body?.uri ?? ''));
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS]
							.filter(Boolean).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, ''));
						const abs = p.replace(/\\/g, '/');
						if (!roots.some(r => abs.toLowerCase().startsWith(r.toLowerCase() + '/')) || !abs.includes('/' + NOTES_DIR + '/')) {
							send(403, { ok: false, error: '拒绝写入库外/非笔记区文件：' + p });
							return;
						}
						if (!/\.md$/i.test(p)) { send(400, { ok: false, error: '只支持 .md' }); return; }

						const text = await readFile(p, 'utf8');
						const stamp = new Date().toISOString().slice(0, 10);
						const patch = { review: status, reviewedAt: stamp };
						const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/.exec(text);
						let next = '';
						if (!fmMatch) {
							// 没有 frontmatter ⇒ 补一个（不吞掉原有第一行）
							next = `---\n${Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${text.replace(/^\uFEFF/, '')}`;
						} else {
							const keep = fmMatch[1].split(/\r?\n/).filter(line => !/^(review|reviewedAt)\s*:/.test(line.trim()));
							for (const [k, v] of Object.entries(patch)) { keep.push(`${k}: ${v}`); }
							next = `---\n${keep.join('\n')}\n---${fmMatch[2] ?? '\n'}` + text.slice(fmMatch[0].length);
						}
						// 备份（与保存同一条路径）
						try {
							const dir = join(dirname(p), '.kb-backup');
							await mkdir(dir, { recursive: true });
							await writeFile(join(dir, `${basename(p)}.${new Date().toISOString().replace(/[:.]/g, '-')}.md.bak`), text, 'utf8');
						} catch { /* 备份失败不阻断，但要如实回 backup:false */ }
						await writeFile(p, next, 'utf8');
						const after = await stat(p).catch(() => null);
						send(200, { ok: true, status, path: abs, mtime: after ? after.mtimeMs : 0 });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-26：**在系统文件管理器里定位**（右键菜单「在资源管理器中打开」）。
				//   为什么由服务端做：面板/页面都在渲染进程里，没有直接调系统外壳的能力；
				//   而插件跑在 Node 侧，`explorer /select,` 这种参数形态最可靠。
				//   围栏与读文件同源：只允许库内路径（不让人用它当任意文件探测器）。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/reveal` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大' }); return; }
						}
						const body = JSON.parse(raw || '{}');
						const p = resolve(String(body?.uri ?? ''));
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS]
							.filter(Boolean).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, ''));
						const abs = p.replace(/\\/g, '/');
						if (!roots.some(r => abs.toLowerCase().startsWith(r.toLowerCase() + '/'))) {
							send(403, { ok: false, error: '拒绝定位库外路径：' + p });
							return;
						}
						if (!existsSync(p)) { send(404, { ok: false, error: '路径不存在：' + p }); return; }
						const platform = process.platform;
						const args = platform === 'win32' ? ['/select,', p]
							: platform === 'darwin' ? ['-R', p]
								: [dirname(p)];
						const exe = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
						const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
						child.unref();
						child.on('error', () => { /* 打不开也不影响回包（下面如实回 exe） */ });
						send(200, { ok: true, exe, path: abs });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				// ★ 2026-10-25：**vendored 前端资产**（KaTeX 样式与字体）。
				//   为什么不走 CDN：三端都在离线环境，且 IDE webview 的 CSP 会拦外域。
				//   围栏：只放行两条精确形态（`katex/katex.min.css`、`katex/fonts/<file>.<ext>`），
				//   不拼接用户输入 ⇒ 不存在目录穿越面。
				if (url && url.pathname.startsWith(`${ROUTE_PREFIX}/vendor/`)) {
					const rel = decodeURIComponent(url.pathname.slice((ROUTE_PREFIX + '/vendor/').length)).replace(/\\/g, '/');
					// 2026-10-26：**mermaid 已改由服务端 pele 渲染**（同步、零 DOM）⇒ 不再需要
					//   客户端 3.4MB 引擎，`vendor/mermaid/*` 就从白名单里移除（目录也已删除）。
					const okPath = /^katex\/(katex\.min\.css|fonts\/[A-Za-z0-9._-]+\.(woff2|woff|ttf))$/.test(rel);
					if (!okPath) {
						res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
						res.end('not found');
						return;
					}
					const MIME = {
						css: 'text/css; charset=utf-8',
						woff2: 'font/woff2',
						woff: 'font/woff',
						ttf: 'font/ttf',
						js: 'application/javascript; charset=utf-8',
					};
					const ext = (rel.split('.').pop() ?? '').toLowerCase();
					try {
						const buf = await readFile(fileURLToPath(new URL(`../vendor/${rel}`, import.meta.url)));
						res.writeHead(200, {
							'content-type': MIME[ext] ?? 'application/octet-stream',
							'cache-control': 'public, max-age=31536000, immutable',
						});
						res.end(buf);
					} catch {
						res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
						res.end('not found');
					}
					return;
				}
				// ★ 2026-10-24：**备份历史**（先有备份、无法查看/恢复 = 半个功能）。
				//   `GET  /api/backup?doc=<笔记绝对路径>` → 该笔记的备份列表（时间倒序）
				//   `POST /api/backup/restore {doc, name}` → 恢复某个备份（**先给当前内容再备一份**）
				//   围栏与写接口一致：必须在库根内 + 「笔记」区；备份名只接受纯文件名（不许带路径）。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/backup`) {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						const docPath = resolve(decodeURIComponent(url.searchParams.get('doc') ?? '')).replace(/\\/g, '/');
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS].filter(Boolean).map(r => resolve(String(r)));
						const inside = roots.some(r => docPath === r || docPath.startsWith(r.replace(/\\/g, '/') + '/'));
						if (!inside) { send(403, { ok: false, error: '拒绝访问库外文件：' + docPath }); return; }
						if (docPath.indexOf('/' + NOTES_DIR + '/') < 0) { send(403, { ok: false, error: '只支持「笔记」区的文件' }); return; }
						const dir = join(dirname(docPath), '.kb-backup');
						const prefix = `${basename(docPath)}.`;
						let names = [];
						try { names = (await readdir(dir)).filter(f => f.startsWith(prefix) && f.endsWith('.md.bak')); } catch { names = []; }
						const items = [];
						for (const name of names.sort().reverse()) {
							try {
								const st = await stat(join(dir, name));
								items.push({ name, size: st.size, mtime: st.mtimeMs });
							} catch { /* 单个文件读不到就跳过 */ }
						}
						send(200, { ok: true, items });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				if (url && url.pathname === `${ROUTE_PREFIX}/api/backup/restore` && req.method === 'POST') {
					const send = (code, payload) => {
						res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(payload));
					};
					try {
						let raw = '';
						for await (const chunk of req) {
							raw += chunk;
							if (raw.length > 8192) { send(413, { ok: false, error: '请求体太大' }); return; }
						}
						const payload = JSON.parse(raw || '{}');
						const docPath = resolve(decodeURIComponent(String(payload?.doc ?? ''))).replace(/\\/g, '/');
						const name = String(payload?.name ?? '');
						const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS].filter(Boolean).map(r => resolve(String(r)));
						const inside = roots.some(r => docPath === r || docPath.startsWith(r.replace(/\\/g, '/') + '/'));
						if (!inside) { send(403, { ok: false, error: '拒绝访问库外文件：' + docPath }); return; }
						if (docPath.indexOf('/' + NOTES_DIR + '/') < 0) { send(403, { ok: false, error: '只支持「笔记」区的文件' }); return; }
						// 备份名只接受纯文件名（含分隔符 ⇒ 直接拒，防目录穿越）
						if (!name || name !== basename(name) || !name.endsWith('.md.bak')) { send(400, { ok: false, error: '备份名不合法' }); return; }
						const dir = join(dirname(docPath), '.kb-backup');
						const srcFile = join(dir, name);
						if (!existsSync(srcFile)) { send(404, { ok: false, error: '备份不存在：' + name }); return; }
						const old = await readFile(srcFile, 'utf8');
						// 恢复前先把**当前内容**再备一份（恢复本身也可撤销）
						try {
							const keep = join(dir, `${basename(docPath)}.${new Date().toISOString().replace(/[:.]/g, '-')}.pre-restore.md.bak`);
							await writeFile(keep, await readFile(docPath));
						} catch { /* 当前文件读不到（可能刚被删）仍允许恢复 */ }
						await writeFile(docPath, old, 'utf8');
						const after = await stat(docPath).catch(() => null);
						send(200, { ok: true, path: docPath, bytes: Buffer.byteLength(old, 'utf8'), mtime: after ? after.mtimeMs : 0 });
					} catch (e) {
						send(500, { ok: false, error: String(e?.message ?? e) });
					}
					return;
				}
				if (url && url.pathname === `${ROUTE_PREFIX}/api/doc`) {
					// ★ 2026-10-23：把"页面列过的库根"一并交给围栏 —— 否则外挂库的文件列得出、读不到
					const result = await readDoc(kbRootOf(config), url.searchParams.get('uri') ?? '', LAST_VAULT_DIRS);
					// ★ 2026-10-24：一并回 `mtime` —— 保存时用它做**前置校验**（防覆盖别人刚改的内容）
					let mtime = 0;
					if (!result.error && result.path) {
						try { mtime = (await stat(result.path)).mtimeMs; } catch { mtime = 0; }
					}
					// ★ 2026-10-25：**服务端渲染 HTML**（markdown-it + Obsidian 方言）。
					//   视图拿到 `html` 直接注入，无需在前端打包解析器（bundle 不增重）；
					//   IDE 侧不提供该字段 ⇒ 视图回落到原手写渲染器（能力差异可见）。
					let html = '';
					let math = false;
					let cached = false;
					if (!result.error && typeof result.content === 'string') {
						try {
							const abs = String(result.path).replace(/\\/g, '/');
							const rootsAll = [
								kbRootOf(config),
								...externalVaultRecords(config).map(it => it.dir || it.path || ''),
								...LAST_VAULT_DIRS,
							].filter(Boolean).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, ''));
							const vaultDir = rootsAll
								.filter(v => abs.toLowerCase().startsWith(v.toLowerCase() + '/'))
								.sort((a, b) => b.length - a.length)[0] || '';
							// ① 先查磁盘缓存（mtime + 字节数都对得上才算命中）
							const cacheFile = vaultDir ? htmlCacheFileOf(vaultDir, result.path) : '';
							if (cacheFile) {
								try {
									const j = JSON.parse(await readFile(cacheFile, 'utf8'));
									if (j && j.v === HTML_CACHE_VERSION && j.mtime === mtime && j.bytes === result.bytes && typeof j.html === 'string') {
										html = j.html;
										math = !!j.math;
										cached = true;
									}
								} catch { /* 无缓存 / 缓存损坏 ⇒ 下面重渲染 */ }
							}
							// ② 没命中就渲染，并把结果写回缓存（写失败不影响返回）
							if (!cached) {
								const r = renderMarkdownHtml(result.content, { resolveWiki: await wikiResolverFor(vaultDir), renderMermaid: renderMermaidSvg });
								html = r.html;
								math = r.math;
								if (cacheFile) {
									try {
										await mkdir(dirname(cacheFile), { recursive: true });
										const tmpFile = cacheFile + '.tmp';
										await writeFile(tmpFile, JSON.stringify({ v: HTML_CACHE_VERSION, mtime, bytes: result.bytes, math, html }), 'utf8');
										await renameFile(tmpFile, cacheFile);
										// 约 2% 概率顺手清理：只保留最近 400 份，避免长期堆积
										if (Math.random() < 0.02) {
											const dir = dirname(cacheFile);
											const olds = (await readdir(dir)).filter(f => f.endsWith('.json'));
											if (olds.length > 400) {
												const stats = [];
												for (const f of olds) {
													try { stats.push({ f, at: (await stat(join(dir, f))).mtimeMs }); } catch { /* 忽略 */ }
												}
												stats.sort((a, b) => b.at - a.at);
												for (const s of stats.slice(400)) { await rm(join(dir, s.f), { force: true }); }
											}
										}
									} catch { /* 缓存写失败：只影响下次是否重渲染 */ }
								}
							}
						} catch { html = ''; math = false; }   // 渲染失败 ⇒ 视图按纯文本降级
					}
					// ★ 2026-10-26（P2）：**ETag + 304**。
					//   判据用 `mtime + bytes`：内容一变必然变其中一个（与磁盘缓存同一套判据）。
					//   `If-None-Match` 命中 ⇒ 304 空体，客户端复用上次解析好的对象（省一份 ~4KB JSON 与一次解析）。
					const etag = result.error ? '' : '"' + Number(mtime).toString(16) + '-' + Number(result.bytes).toString(16) + '"';
					if (etag) {
						const inm = String(req?.headers?.['if-none-match'] ?? '').trim();
						if (inm && inm === etag) {
							res.writeHead(304, { etag, 'cache-control': 'no-store' });
							res.end();
							return;
						}
					}
					res.writeHead(result.error ? 400 : 200, {
						'content-type': 'application/json; charset=utf-8',
						'cache-control': 'no-store',
						...(etag ? { etag } : {}),
					});
					res.end(JSON.stringify(result.error
						? { ok: false, error: result.error }
						: { ok: true, path: result.path, bytes: result.bytes, truncated: result.truncated, content: result.content, mtime, html, math, cached, etag }));
					return;
				}
				// ★ 2026-10-24：图片 / pdf / 音视频的**字节流**（页面 `<img>` 直接请求这条）。
				//   围栏与 `/api/doc` 同源（库根 + 页面列过的库根，段边界比较）、只白名单展示型 MIME。
				if (url && url.pathname === `${ROUTE_PREFIX}/api/asset`) {
					const asset = await readAsset(kbRootOf(config), url.searchParams.get('uri') ?? '', [...LAST_VAULT_DIRS, ...externalVaultRecords(config).map(it => it.dir || it.path || '')]);
					if (asset.error) {
						res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ ok: false, error: asset.error }));
					} else {
						res.writeHead(200, {
							'content-type': asset.mime,
							'content-length': String(asset.bytes.length),
							// 素材可能被同名覆盖 ⇒ 只允许浏览器短缓存
							'cache-control': 'private, max-age=30',
						});
						res.end(asset.bytes);
					}
					return;
				}
			}
				// ★★ 2026-10-25（真机：知识库中的文档未渲染 —— 满屏 frontmatter 与 [!quote]）：
				//   `/x/kb/doc?uri=` **从来没有专门路由**，一路落到旧三态页 `renderPage`，
				//   而那条路径把正文当纯文本塞进 `<pre>` ⇒ 什么都没渲染。
				//   ⇒ 这里补一个真正的文档页：服务端 `renderMarkdownHtml` + 自带样式，只读。
				// ⚠ 这段在 `url` 的作用域之外（它在更早的 if 块里）⇒ 自己算一份
				const docUrl = (() => { try { return new URL(String(req.url ?? '/'), 'http://localhost'); } catch { return null; } })();
				if (docUrl && docUrl.pathname === `${ROUTE_PREFIX}/doc`) {
					const uri = docUrl.searchParams.get('uri') ?? '';
					const result = await readDoc(kbRootOf(config), uri, LAST_VAULT_DIRS);
					let body = '';
					let math = false;
					let title = '';
					if (result.error) {
						body = '<p class="kb-err">读不到正文：' + escapeHtml(result.error) + '</p>';
					} else {
						title = String(result.path || uri).split(/[\\/]/).pop() || '';
						try {
							const abs = String(result.path).replace(/\\/g, '/');
							const roots = [kbRootOf(config), ...externalVaultRecords(config).map(it => it.dir || it.path || ''), ...LAST_VAULT_DIRS]
								.filter(Boolean).map(s => String(s).replace(/\\/g, '/').replace(/\/+$/, ''));
							const vaultDir = roots.filter(v => abs.toLowerCase().startsWith(v.toLowerCase() + '/')).sort((a, b) => b.length - a.length)[0] || '';
							const r = renderMarkdownHtml(result.content, { resolveWiki: await wikiResolverFor(vaultDir), renderMermaid: renderMermaidSvg });
							body = r.html;
							math = r.math;
						} catch (e) {
							// 渲染失败就**如实退化成纯文本**（至少不会空白），并在页面上说明
							body = '<p class="kb-err">渲染失败（已退化为纯文本）：' + escapeHtml(String(e?.message ?? e)) + '</p>'
								+ '<pre>' + escapeHtml(String(result.content ?? '')) + '</pre>';
						}
					}
					const css = [
						':root { color-scheme: dark light; }',
						'html, body { margin: 0; height: 100%; background: var(--vscode-editor-background, #1e1e1e); }',
						'body { color: var(--vscode-editor-foreground, #ddd); font: 14px/1.75 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }',
						'#bar { position: sticky; top: 0; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 12px;',
						'  background: var(--vscode-sideBar-background, #252526); border-bottom: 1px solid rgba(127,127,127,.3); z-index: 5; }',
						'#bar a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; font-size: 12.5px; }',
						'#bar .t { font-size: 12.5px; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
						'#doc { max-width: 860px; margin: 0 auto; padding: 18px 22px 80px; }',
						// 长文档性能（P1）：屏外块跳过布局/绘制，首屏更快；块高给个估算值防止滚动条乱跳
						'#doc > *:not(:first-child) { content-visibility: auto; contain-intrinsic-size: auto 2.4em; }',
						'h1, h2, h3, h4 { line-height: 1.35; margin: 1.1em 0 .5em; }',
						'h1 { font-size: 1.7em; } h2 { font-size: 1.35em; border-bottom: 1px solid rgba(127,127,127,.3); padding-bottom: .25em; }',
						'h3 { font-size: 1.15em; } h4 { font-size: 1.02em; }',
						'p { margin: .65em 0; } ul, ol { padding-left: 1.8em; margin: .5em 0; } li { margin: .2em 0; }',
						'blockquote { margin: .8em 0; padding: .2em 0 .2em 12px; border-left: 3px solid rgba(127,127,127,.45); color: var(--vscode-descriptionForeground, #9d9d9d); }',
						'.kb-callout { margin: .9em 0; padding: 8px 12px; border-radius: 5px; border-left: 3px solid #3794ff; background: rgba(127,127,127,.08); }',
						'.kb-callout::before { content: attr(data-callout-title); display: block; font-size: 12px; font-weight: 600; color: #3794ff; margin-bottom: 4px; }',
						'.kb-callout[data-callout="tip"]::before, .kb-callout[data-callout="hint"]::before { color: #3fb950; }',
						'.kb-callout[data-callout="warning"]::before, .kb-callout[data-callout="caution"]::before { color: #d29922; }',
						'.kb-callout[data-callout="danger"]::before, .kb-callout[data-callout="error"]::before, .kb-callout[data-callout="bug"]::before { color: #f85149; }',
						'.kb-wiki { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; cursor: pointer; }',
						'.kb-wiki:hover { text-decoration: underline; }',
						'.kb-wiki-missing { border-bottom: 1px dashed rgba(127,127,127,.6); opacity: .72; }',
						'table.kb-table { border-collapse: collapse; margin: .9em 0; font-size: 13px; }',
						'.kb-table th, .kb-table td { border: 1px solid rgba(127,127,127,.35); padding: 5px 10px; }',
						'.kb-table th { background: rgba(127,127,127,.14); }',
						'pre.kb-code { margin: .9em 0; padding: 10px 12px; background: rgba(127,127,127,.13); border-radius: 5px; overflow: auto; font-size: 12.5px; line-height: 1.6; }',
						'code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,.15); padding: 1px 4px; border-radius: 3px; }',
						'pre.kb-code code { background: none; padding: 0; }',
						'.kb-tok-kw { color: #569cd6; } .kb-tok-str { color: #ce9178; } .kb-tok-num { color: #b5cea8; } .kb-tok-com { color: #6a9955; }',
						'img { max-width: 100%; border-radius: 4px; } hr { border: 0; border-top: 1px solid rgba(127,127,127,.35); margin: 1.4em 0; }',
						'a { color: var(--vscode-textLink-foreground, #3794ff); }',
						'.kb-err { color: #f85149; }',
					].join('\n');
					const back = `<div id="bar"><a href="${ROUTE_PREFIX}/">← 返回知识库</a><span class="t">${escapeHtml(title)}</span></div>`;
					res.writeHead(200, {
						'content-type': 'text/html; charset=utf-8',
						'cache-control': 'no-store',
						'content-security-policy': KB_PAGE_CSP,
					});
					res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
						+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
						+ `<title>${escapeHtml(title || '知识库文档')}</title>`
						// 内联样式仍需要（正文里有 style 属性）⇒ CSP 的 style-src 带 unsafe-inline，
						// 而脚本已外置（doc-boot.js）⇒ script-src 只允许 self。
						+ `<style>${css}</style>`
						+ (math ? `<link rel="stylesheet" href="${ROUTE_PREFIX}/vendor/katex/katex.min.css">` : '')
						+ `</head><body>${back}<div id="doc" data-kb-doc-page="1">${body}</div>`
						+ `<script src="${ROUTE_PREFIX}/web/doc-boot.js" defer></script>`
						+ '</body></html>');
					return;
				}

			try {
				// 先渲染再 writeHead（渲染抛错还能干净回 500，不切 socket）
				const html = await renderPage({ config, state, surface });
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}

/**
 * "上次构建收尾的缓存登记情况" ⇒ 一句人话（P1）。
 * 为什么要有它：我们**开始写**这份共享缓存了 ⇒ 回执不能只报"读到什么" ✗，
 * 必须能说出"写了什么 / 跳过了什么 / 为什么" ✓（"静默少记"是本仓最忌讳的一类 ✓）。
 * @param {{ registered?: number, total?: number, skipped?: { reason: string }[], error?: string }} info
 */
function lastBuildCacheNote(info) {
	if (info?.error) {
		return `⚠ 上次构建收尾**登记构建缓存失败**（${info.error}）⇒ 那批素材下次还会被算成待构建 ✗。`;
	}
	const skipped = Array.isArray(info?.skipped) ? info.skipped : [];
	if (!info || !info.registered) {
		return `⚠ 上次构建收尾**没有登记任何缓存条目**（登记 ${info?.registered ?? 0} 条；扫到 ${info?.notesScanned ?? '?'} 篇笔记 / ${info?.sourcesScanned ?? '?'} 份素材${skipped.length ? `；跳过 ${skipped.length} 条，例如：${skipped[0].reason}` : ''}）⇒ 那批素材下次仍会被算成待构建 ✓。`;
	}
	return `上次构建收尾已登记 ${info.registered} 条缓存（这份缓存现共 ${info.total} 条 ✓）${skipped.length ? `；跳过 ${skipped.length} 条（例如：${skipped[0].reason}）` : ''}。`;
}
