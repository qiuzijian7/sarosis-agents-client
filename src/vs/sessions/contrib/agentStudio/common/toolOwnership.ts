/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 两侧**同名工具**登记表（2026-10-12 建立）。
 *
 * ## 为什么会有同名工具（先纠正一个错误前提）
 *
 * 起初以为这是"模型会在同一个会话里看到两套同名工具 ⇒ 混淆"。**不是** ✗：两者属于
 * **不同引擎、不同会话** ——
 *   · IDE 侧（本仓 `browser/providers/tool/*.ts`）：VsSaros 内置 agent 会话用；
 *   · Host 侧（本仓 `dsh-plugins/<pkg>/lib/index.js`）：dsh 会话（含 dsh 聊天框）用。
 * 任一会话里只会出现其中一套，模型不会撞名。
 *
 * ## 那为什么还要登记
 *
 * 因为它们**写同一份数据**：`kanban_*` 两侧都改同一个 `taskboard.json`
 * （Host 侧描述原话：「写入与 IDE 同一个 taskboard.json」）、`kb_*` 同一个知识库、
 * `memory_*` 同一套记忆文件、`workflow_*` 同一批工作流定义。Host 侧源码注释也写着
 * 「逐条按 `kanbanTools.ts` 的语义与**文案格式**移植」。
 * ⇒ 真正要防的是**语义/文案漂移**（一侧改了动词含义或用户可见文案、另一侧没跟），
 *   而不是撞名。本表就是那条漂移防线的登记面：**新增同名动词必须来登记**（守卫在
 *   `test/common/toolOwnership.test.ts`）。
 *
 * ## 分工口径（如实记录，不做"谁高谁低"的判断）
 *
 * 同族能力**两侧都完整可用**（各自引擎里必须自洽），重叠是**刻意的对齐**，不是重复
 * 实现的历史包袱；Host 侧另有 IDE 侧没有的编排动词（`kanban_update`、
 * `workflow_update`、`workflow_engine_status`、`kb_list`/`kb_read`、`memory_stats`/
 * `memory_refresh`）。**不合并**：合并需要跨进程 RPC，而两个引擎的会话本就只见自己那套，
 * 收益为零。
 *
 * ⚠ 2026-10-20 更正：上一版这里写着"IDE 侧另有 Host 侧没有的分解/并行动词
 *   （`kanban_decompose`/`kanban_swarm`/`kanban_specify`/`web_recipe_*`）"—— **已不成立** ✗：
 *   Host 侧 `vssaros-kanban` 也注册了这 7 个同名动词（守卫反向核对抓出来的），所以它们现在是
 *   **两侧同名**、按本表用途必须登记（见下方看板族 2026-10-20 那批）。
 *
 * ⚠ 别把本表当成"要合并的清单" ✗；它是**对齐契约**。
 */

/** 一条同名工具：两侧各在哪个实现里（用于守卫双向核对）。 */
export interface ISharedToolVerb {
	/** 模型可见的工具名（两侧一字不差，否则不叫同名）。 */
	readonly name: string;
	/** Host 侧插件目录名（`dsh-plugins/<plugin>/lib/index.js`）。 */
	readonly hostPlugin: string;
	/** IDE 侧实现文件（相对 `src/vs/sessions/contrib/agentStudio/`）。 */
	readonly ideFile: string;
	/**
	 * 两侧共同作用的**数据面**（漂移的代价就落在这里）。写清"改一侧必须同时看另一侧"的对象。
	 */
	readonly sharedStore: string;
}

/**
 * 已登记的同名动词（**20 条**）。
 *
 * 条数变迁（别只看数字，看理由）：
 *   · 2026-10-14：21 → 33（补进记忆族 12 个）；
 *   · 2026-10-20：33 → **14**（`0f01ef10a43`「legacy 工具整体下线」删了 7 个 `providers/tool/*.ts`，
 *     记忆族与工作流族在 IDE 侧随之退役 ⇒ 不再是"两侧同名"）；
 *   · 2026-10-20 同日后补：14 → **20**（`kanbanTools.ts` 里 6 个仍注册、Host 侧也在注册）。
 *
 * 新增同名动词请**同时**在本表登记两侧实现位置与共享数据面；守卫会核对"表里每条两侧都存在"
 * 与"两侧新出现的同名必须已登记"。
 */
export const SHARED_TOOL_VERBS: readonly ISharedToolVerb[] = [
	// ─── 看板（同一份 taskboard.json；Host 侧 10 个动词里 9 个与 IDE 同名）───
	{ name: 'kanban_create', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_show', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_list', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_complete', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_block', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_unblock', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_heartbeat', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_comment', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_link', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },

	// ─── 2026-10-20 补登记：看板族 6 个（同样是守卫反向核对抓出来的 ✗）───
	// 现场：提交 `0f01ef10a43`「legacy 工具整体下线」删掉 7 个 `providers/tool/*.ts`
	// （workflowTools / memoryTools / unifiedMemoryTools / advancedMemoryTools 等），登记表因此从 33 条
	// 瘦到 14 条；但 `kanbanTools.ts` 里这 6 个**仍注册着**，而 Host 侧 `vssaros-kanban` 也注册了同名 6 个
	// ⇒ 真的成了"两侧同名"，按本表用途（防语义/文案漂移）必须登记。
	// ⚠ 与本文件 2026-10-14 那条注释同口径：**只登记名字/位置/数据面**，动作集合是否逐字一致未核对。
	{ name: 'kanban_decompose', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板；拆出的子任务同样落盘）' },
	{ name: 'kanban_specify', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'kanban_swarm', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（默认看板）' },
	{ name: 'web_scrape_to_board', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: 'taskboard.json（抓取结果落看板）' },
	{ name: 'web_recipe_create', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: '<dataRoot>/web-recipes.json' },
	{ name: 'web_recipe_list', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: '<dataRoot>/web-recipes.json' },
	{ name: 'web_recipe_remove', hostPlugin: 'vssaros-kanban', ideFile: 'browser/providers/tool/kanbanTools.ts', sharedStore: '<dataRoot>/web-recipes.json' },

	// ─── 知识库（同一个 vault + 同一套飞书同步脚本副本）───
	// ⚠ `kb_search` 两侧**同名但口径不同**（登记在册，别被"同名"骗了 ✗）：IDE 侧是 **BM25 全文 + 向量语义**
	//（`mode: hybrid | fulltext | semantic` ✓），Host 侧是"**索引字段**匹配 + 正文 BM25"
	//（`mode: index【缺省】| fulltext` ✓，`semantic` 明确报错不实现 ✓）。⇒ 同一句话在两个引擎里结果可能不同，
	// 但**两侧都如实写在自己的工具描述里** ✓（Host 侧 2026-10-12 补的 `mode=fulltext` 与 IDE 侧 BM25
	// 已对齐到逐条同分，见 `poc/dsh-p0/scripts/p3-38-kb-fulltext.mjs` 的黄金表 ✓）。
	{ name: 'kb_search', hostPlugin: 'vssaros-kb', ideFile: 'browser/providers/tool/kbVaultRecallTools.ts', sharedStore: '知识库 vault 索引（检索口径两侧不同，见上注）' },
	// ⚠ `kb_build`（2026-10-12 登记 → 2026-10-17 **IDE 侧退役**）：原先两侧同名，共享 `.kb-build-cache.json`
	//   与同一套待构建判据；IDE 侧那次下线把 `kbBuildTools.ts` 删了（`builtinToolProvider.ts` 里的
	//   `_registerKbBuildTools()` 也被注释）⇒ 现在只有 Host 插件还提供 `kb_build` ⇒ **不再是"两侧同名"** ✓。
	//   ⇒ 登记项已移除（保留它能过守卫的唯一办法是造一个不存在的 ideFile ⇒ 那是自欺 ✗）。
	//   若 IDE 侧恢复该工具，必须把这一项加回来。
	{ name: 'kb_topic_overviews', hostPlugin: 'vssaros-kb', ideFile: 'browser/providers/tool/kbVaultRecallTools.ts', sharedStore: '库/<分类>/.overview.md' },
	{ name: 'kb_feishu_sync', hostPlugin: 'vssaros-kb', ideFile: 'browser/providers/tool/kbFeishuSyncTools.ts', sharedStore: '库/raw + 飞书同步脚本副本' },

	// ─── 记忆（同一套记忆文件）───

	// ─── 2026-10-14 补登记：记忆族 12 个（**守卫反向核对抓出来的** ✗，两批）───
	// 现场：两侧都已实现、且都在改**同一套记忆**（IDE 侧经 `AgentMemoryProviderV2` 代理，Host 侧
	// 插件直接读同一份记忆文件 ✓），但一直没进本表 ⇒ 一侧改语义/文案时另一侧无从知道 ✗（本表存在的唯一理由）。
	// ⚠ 本轮**只补登记**（名字 / 两侧实现位置 / 数据面）；**动作集合是否逐字一致未核对** —— 别在注释里
	//   假装已对齐 ✗（`kb_search` 那种"同名但口径不同"就是先例 ⇒ 真要用某条时逐条对着看 ✓）。
	// 批 1（6 个）：写入口 + 结晶/切面/级联/治理。
	// 批 2（6 个）：**首轮只补了 6 个、这 6 个仍在红** ⇒ 教训：反向核对的输出要一次看完（首轮我把
	//   `AssertionError` 的列表读成 6 条就动手了，实际是 12 条 ✗）。判据同批 1 ✓。

	// ─── 工作流（同一批工作流定义）───

	// ─── Unreal：**本表里已无条目** ✓（2026-10-13）───
	// 本表的语义是"**两侧**同名动词的对齐契约"。unreal 族（七个）现在**只有 dsh 侧一份实现** ✓
	// （`dsh-plugins/vssaros-unreal` 0.2.0 ✓，Host 直连本机 bridge ✓），IDE 侧 `unrealTools.ts`
	// **已整体删除** ✗ ⇒ 不再有"两侧同名"，也就没有可对齐的对象 ✓。
	// ⚠ 别把"只在一侧"的工具塞进本表 ✗：守卫会按 `ideFile` 去找字面量，找不到就红（那是**正确**的红 ✓
	// —— 它正是"这张表必须反映现实"的判据 ✓）。unreal 侧的契约现在由 `dshUnrealPlugin.test.ts` 的
	// **黄金表**独立钉住（七个工具名 / 端点 / 超时 / 必填参数 ✓）。

	// ─── 2026-10-13 补登记：此前"两侧同名但未登记"的 11 个（守卫反向核对抓出来的 ✗）───
	// 之所以要登记：它们写**同一份数据面** ⇒ 一侧改语义/文案而另一侧没跟，就是最难解释的那类差异 ✓。
	{ name: 'kb_organize', hostPlugin: 'vssaros-kb', ideFile: 'browser/providers/tool/kbOrganizeTools.ts', sharedStore: '知识库「笔记」区目录结构（＋ vault 外备份目录）' },
	{ name: 'kb_feishu_spaces', hostPlugin: 'vssaros-kb', ideFile: 'browser/providers/tool/kbFeishuSyncTools.ts', sharedStore: '飞书知识库远端列表（wiki space）+ 本地 `.feishu-space-map.json`' },
];

/** 表里的名字集合（守卫与调用方共用，避免各处 `new Set(map(...))` 漂移）。 */
export const SHARED_TOOL_VERB_NAMES: ReadonlySet<string> = new Set(SHARED_TOOL_VERBS.map(v => v.name));

/** 某名字是否已登记的"两侧同名动词"。 */
export function isSharedToolVerb(name: string): boolean {
	return SHARED_TOOL_VERB_NAMES.has(name);
}

/**
 * 按名查一条登记；未登记返回 `undefined`。
 *
 * ⚠ 未登记**不等于**该名字有问题 —— 只表示它不两侧同名（例如 Host 独有的
 * `kanban_update`、IDE 独有的 `kanban_swarm`）。判据见守卫里的并集核对。
 */
export function sharedToolVerbOf(name: string): ISharedToolVerb | undefined {
	return SHARED_TOOL_VERBS.find(v => v.name === name);
}
