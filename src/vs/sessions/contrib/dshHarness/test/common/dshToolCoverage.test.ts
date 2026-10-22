/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具面覆盖守卫（`dsh-plugins/tools-snapshot.json` ↔ `poc/dsh-p0/scripts/`）。
 *
 * **为什么有这条**（2026-10-12 评估现场）：`dshProbeCoverage` 守的是"**探针文件**必须进 `run-all`" ✓，
 * 那是**文件级**的 ✓ —— 它证明不了"**每个工具都被某份探针提到过**" ✗。而现实是工具面涨得很快 ✓
 * （一小时内 48 → 55 个 ✓：`codebase` 5 → 11 ✓、`kb` 7 → 10 ✓、`workflow` 5 → 6 ✓）：新加一个工具、
 * 忘了在任何探针里钉它 ⇒ **没有任何东西会响** ✗，直到它在真机上以某种没人预料的方式坏掉 ✓。
 *
 * **判据**（与 `dshProbeCoverage` 的 `EXCLUDED` 同形 ✓）：每个工具名必须**要么**出现在该模块
 * **指定探针**的文本里 ✓、**要么**进下面的 `UNPINNED` 并写明理由 ✓ —— **没有理由的缺席就是"忘了钉"** ✓。
 *
 * **能力边界**（写清楚，别指望它干别的 ✓）：它**只读文本** ⇒ "出现在文本里"包含注释与字符串 ✓，
 * 也就是说它挡的是**遗漏**（新工具压根没被提到 ✗），**挡不住**"提到了但没真跑" ✗ —— 后者交给
 * `run-all --fast` / 完整跑 ✓（与 `dshProbeCoverage` 同一条分工 ✓）。
 *
 * ⚠ 指定探针是**手写映射**（不是自动猜 ✓）：自动猜（"哪个探针提到得最多" ✓）会在工具改名或新增时
 * 悄悄漂移 ✗，而手写映射改了就是改了 ✓（本仓风格：把判断写下来，让守卫只负责"它没腐烂" ✓）。
 */
import assert from 'assert';
import * as fs from 'fs';
import { join } from '../../../../../base/common/path.js';

/** 相对仓库根的关键路径；`repoRoot()` 的判据就是"它在 `process.cwd()` 里存在吗"。 */
const SNAPSHOT_REL = join('dsh-plugins', 'tools-snapshot.json');
const SCRIPTS_REL = join('poc', 'dsh-p0', 'scripts');

/** 仓库根，或 `undefined`（不在仓库里跑 ⇒ 跳过）。 */
function repoRoot(): string | undefined {
	for (const candidate of [process.cwd(), join(process.cwd(), '..'), join(process.cwd(), '..', '..')]) {
		if (fs.existsSync(join(candidate, SNAPSHOT_REL))) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * 每个"注册了工具的模块" → **指定探针**（相对 `poc/dsh-p0/scripts` ✓）。
 *
 * 为什么允许两份：写工具**同时**被"工具面探针"（它怎么用 ✓）与 `p3-26`（它的闸拦不拦 ✓）钉着 ✓ ——
 * 两边都要出现在文本里才算数 ✓，漏一边就可能出现"闸改了、行为探针还在绿" ✗。
 */
const COVERED_BY: ReadonlyMap<string, readonly string[]> = new Map([
	// agents（2026-10-13，P2 生命周期工具）：p3-54 钉注册形态/闸行为/hostHalf/toolsOnly/四工具 execute ✓
	['vssaros-agents', ['p3-54-agents-tools.mjs']],
	['vssaros-browser', ['p3-32-browser-plugin.mjs']],
	// codebase（2026-10-12）：p3-11 盯**读侧**（页面/轻路径/契约 vs 真图）；p3-40 盯**写侧**（P1 影子索引：
	// 落点/锁/增量/审批闸/以及"影子优先"的负对照）✓ —— 新增的 `codebase_index` / `codebase_index_status`
	// 由两份共同覆盖，漏一边就可能出现"闸改了、行为探针还在绿"✗。
	['vssaros-codebase', ['p3-11-codebase-plugin.mjs', 'p3-40-codebase-shadow-index.mjs']],
	['vssaros-dashboard', ['p3-09-dashboard-plugin.mjs']],
	['vssaros-ide', ['p3-13-ide-plugin.mjs']],
	// 2026-10-20：pele 的 `render_diagram`（渲染 + **审批闸只在 saveTo 时 ask**）由 p3-148 钉住。
	// 此前它注册了工具却没有探针 ⇒ 这张表红着（"新模块的工具没人管"正是这条守卫要抓的）。
	['vssaros-pele', ['p3-148-pele-render.mjs']],
	// 2026-10-16：kanban_decompose + kanban_swarm（重构 4；两个都在 p3-110 里钉，见该文件的 ①—⑨）。
	['vssaros-kanban', ['p3-02-kanban-tool-pipeline.mjs', 'p3-26-write-tool-gates.mjs', 'p3-110-kanban-decompose.mjs']],
	// 2026-10-16（重构 4）：session_search（sessions 插件从"零工具"变"有工具"）。
	['vssaros-sessions', ['p3-106-session-search.mjs']],
	// 2026-10-16（重构 4）：kb_search 的 semantic 模式 + kb_reindex（建向量索引）都在 p3-108 里钉。
	['vssaros-kb', ['p3-08-kb-plugin.mjs', 'p3-108-kb-semantic.mjs']],
	// media（2026-10-12）：探针 `p3-37` 已落地 ⇒ 两个只读工具从 `UNPINNED` 台账里摘掉、填回这里 ✓。
	// ⚠ 编号是 **p3-37** 而不是台账原先写的 p3-35 —— 那个号被同批的 `p3-35-memory-partition.mjs` 占了 ✓。
	['vssaros-media', ['p3-37-media-plugin.mjs', 'p3-107-media-generate.mjs']],  // 2026-10-21：image_generate 迁走，p3-107 只剩 video/tts/vision 那几条
	// 2026-10-21：生图迁到 `@vssaros/dsh-imagegen`（`image_generate` 走官方 `tool.call.images` 画廊）⇒
	//   由 `p3-156` 钉住（注册 / 缺参 / 桥不在 / 桥参数 / pluginId 是包名 / attachment / image 块 / 审批闸 ✓）。
	//   2026-10-21（画布工作台）：`canvas_state` / `view_canvas` 由 `p3-157` 钉住
	//   （路由注册 / 鉴权 / 静态资源 / 路径穿越 / 状态推拉 / 旧序号挡住 / 没画布明确报错 / 选区截图存 attachment ✓）。
	//   2026-10-21（二批）：⑤落盘（内容寻址 / 幂等 / 目录穿越拒 / 回执带路径）与
	//   ⑥`edit_image` 多来源（attachment_id / path / 参考图优先级）由 `p3-161` 钉住 ✓。
	//   2026-10-21（三批）：⑦`generate_images` 批量（顺序 / 失败不中断 / 上限 / 取消语义 / 审批闸）由 `p3-162` 钉住；
	//   ⑨能力表（经桥读 IDE 的 capabilities / 缓存 / 读失败报错）与 ⑧多模型对比（并发 / 失败不中断 / 按能力表校正参数）由 `p3-163` 钉住 ✓。
	//   2026-10-21（四批）：⑩落位布局（3 列网格 / 连落 5 张不重叠 / 视口判定）、⑫拖图入画布
	//   （canvas-import ⇒ attachment + 账本 + 落工作区）与 ⑪画廊筛选/持久化（来源 / provider / 时间 / 关键字 /
	//   工作区图库 + 字节路由 + 穿越防护）由 `p3-165` 钉住 ✓。
	['vssaros-imagegen', ['p3-156-imagegen-generate.mjs', 'p3-157-imagegen-canvas.mjs', 'p3-158-imagegen-landings.mjs', 'p3-159-imagegen-edit.mjs', 'p3-160-imagegen-digest.mjs', 'p3-161-imagegen-save-refs.mjs', 'p3-162-imagegen-batch.mjs', 'p3-163-imagegen-capabilities.mjs', 'p3-164-imagegen-workbench.mjs', 'p3-165-imagegen-landing-import-gallery.mjs']],
	// 2026-10-16（重构 4）：mcp_install（mcp 插件从"零工具"变"有工具"）。
	['vssaros-mcp', ['p3-109-mcp-install.mjs', 'p3-111-market-list.mjs']],  // 2026-10-17：mcp_market_list
	['vssaros-memory', ['p3-07-memory-plugin.mjs']],
	['vssaros-skills', ['p3-04-skills-plugin.mjs', 'p3-111-market-list.mjs']],  // 2026-10-17：skill_market_list
	// web-content-import（2026-10-15 新增）：p3-93 钉路由 / 质量判定（占位页绝不写库）/ html 输入回路 /
	// 落盘（锁 + 原子写 + slug 派生 + 形状与 IDE 侧逐字对齐）/ 审批闸 ✓（无页面 ⇒ 进程内 + 回环 HTTP，fast ✓）。
	['vssaros-web-content-import', ['p3-93-web-content-import.mjs']],
	['vssaros-unreal', ['p3-33-unreal-plugin.mjs']],
	['vssaros-workflow', ['p3-10-workflow-plugin.mjs']],
	// 2026-10-21：dsh 侧**独立**的 TOF/OA 登录（`tof_signin` / `tof_status` / `tof_signout`）。
	//   它们住在**伴生插件** `vssaros-bridge` 里（该插件此前一个工具都没有 ⇒ 不在这张表里 ✓）。
	//   指定探针 = 桥的反向通道那份（它验的正是这个插件的宿主半 ✓）；三条 TOF 工具本身进 UNPINNED
	//   （要真开系统浏览器跑 TOF OAuth ⇒ 探针里跑不了 ⇒ 已知欠账 ✓，理由与转绿条件见下 ✓）。
	['vssaros-bridge', ['p3-12-bridge-reverse.mjs']],
]);

/**
 * 明确**不钉**的工具 → 理由（每条都必须给 ✓）。
 *
 * ⚠ 2026-10-12：media 那两条**已还清**（真机探针 `p3-37` 落地 ✓）⇒ 本表**重新为空** ✓。
 * 这张表非空时的语义是"**已知欠账**"、不是绕过：填进来时必须写清理由与转绿条件（原来那两条就是这么记的 ✓）。
 */
const UNPINNED: readonly (readonly [tool: string, why: string])[] = [
	// 2026-10-13：工作流 / 看板两条"展示类"工具（打开画布 / 在看板定位卡片）。它们**只开编辑器**、
	// 不写任何数据；而指定探针 `p3-13-ide-plugin.mjs` 是**反向通道**探针，要钉住这两条需要
	// "画布存在 / 看板里有那张卡片"的 IDE 场景 ⇒ 记成已知欠账 ✓（转绿条件写在理由里 ✓）。
	['workflow_open', '展示类（打开工作流画布）：需"画布存在"的 IDE 场景；转绿 = 在 p3-13 里真调 workflow 能力并断言 opened'],
	['taskboard_focus', '展示类（在看板定位卡片）：需"该卡片存在"的 IDE 场景；转绿 = 在 p3-13 里真调 taskboard 能力并断言 focused'],
	// 2026-10-21：dsh 侧**独立**的 TOF/OA 登录三条（`vssaros-bridge`）。
	//   它们要**真的开系统浏览器**跑一遍 TOF OAuth（还要用户的 iOA 会话 + 内网网关）⇒ 探针里跑不了
	//   ⇒ 记成已知欠账 ✓。转绿条件 = 用**可注入的假 whoami + 假浏览器**做端到端
	//   （`dsh-plugins/vssaros-bridge/lib/tof.js` 的服务层已经支持注入 whoami ✓ ⇒ 探针可写 ✓）。
	['tof_signin', '要真开浏览器跑 TOF OAuth（需用户 iOA 会话 + 内网网关）⇒ 探针跑不了；转绿 = 用可注入的假 whoami/假浏览器做端到端'],
	['tof_status', '读的是登录后的身份（同上跑不了）；转绿 = 同上（注入假 whoami 后断言投影里没有票据）'],
	['tof_signout', '清凭据（同上跑不了）；转绿 = 同上（断言两份 ref 都清掉、且默认只清本地那份）'],
];

suite('dsh 工具面覆盖守卫（快照 ↔ 探针）', () => {
	test('★ 每个工具都被指定探针提到（或在 UNPINNED 里写明理由）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const snapshot = JSON.parse(fs.readFileSync(join(root!, SNAPSHOT_REL), 'utf8')) as {
			readonly total: number;
			readonly plugins: Record<string, readonly { readonly name: string }[]>;
		};
		const toolBearing = Object.keys(snapshot.plugins);

		// ① 台账不许漏模块：工具面快照里的模块都必须在映射里 ✓（否则"新模块的工具没人管" ✗）
		for (const dir of toolBearing) {
			assert.ok(COVERED_BY.has(dir),
				`\`${dir}\` 注册了工具但不在覆盖映射里 ✗ ⇒ 为它指定探针（或说明为什么不需要）`);
		}
		// ② 反向：映射里不许留已经不再注册工具的模块 ✓（防腐烂 ✓）
		for (const dir of COVERED_BY.keys()) {
			assert.ok(toolBearing.includes(dir),
				`覆盖映射里的 \`${dir}\` 已不再注册任何工具 ✗ ⇒ 映射腐烂了`);
		}

		const unpinned = new Map(UNPINNED);
		let pinnedCount = 0;
		for (const dir of toolBearing) {
			const probes = COVERED_BY.get(dir)!;
			let text = '';
			for (const probe of probes) {
				const file = join(root!, SCRIPTS_REL, probe);
				assert.ok(fs.existsSync(file), `${dir} 的指定探针 \`${probe}\` 不存在 ✗（改名/删除 ⇒ 这条守卫会一直空转）`);
				text += fs.readFileSync(file, 'utf8');
			}
			for (const tool of snapshot.plugins[dir]!) {
				if (text.includes(tool.name)) {
					pinnedCount++;
					continue;
				}
				const why = unpinned.get(tool.name);
				assert.ok(why !== undefined,
					`\`${tool.name}\`（${dir}）没有任何指定探针提到它 ✗ ⇒ 要么在 \`${probes.join('` / `')}\` 里钉住它，要么进 UNPINNED 写明理由`);
				assert.ok(why!.trim().length >= 15, `\`${tool.name}\` 的豁免理由太短（≥15 字）✗`);
			}
		}
		// ③ 反向：UNPINNED 里的名字必须是**真实存在**的工具 ✓（防它自己腐烂 ✓）
		const allTools = new Set(toolBearing.flatMap(dir => snapshot.plugins[dir]!.map(t => t.name)));
		for (const [tool, why] of UNPINNED) {
			assert.ok(allTools.has(tool), `UNPINNED 里的 \`${tool}\` 不是任何模块的工具 ✗ ⇒ 表腐烂了（${why}）`);
		}
		// ④ 不许空转 ✓：钉到的 ＋ 豁免的必须**正好等于**快照里的工具数 ✓
		//（⚠ 第一版写的是 `pinnedCount === snapshot.total` ✗ —— 那样一旦有工具进 UNPINNED 就永远不成立 ✓，
		//  等于我自己把刚建的豁免机制废掉了 ✓；这条也是本轮自查出来的 ✓。）
		assert.ok(pinnedCount > 0 && pinnedCount + UNPINNED.length === snapshot.total,
			`钉到=${pinnedCount} 豁免=${UNPINNED.length} 快照 total=${snapshot.total} ⇒ 三个数字对不上（映射或快照有问题）✗`);
	});
});
