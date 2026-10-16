/*---------------------------------------------------------------------------------------------
 *  文件规模预算（P0-2，2026-09-21）。
 *
 *  来源：与 pi 上游的对比分析 —— 上游 `packages/agent` 最大文件 2012 行、
 *  `packages/coding-agent` 只有一个 6767 行的 interactive-mode ✓；而我们 agent 域
 *  已有 12 个 >2500 行的文件，最大 6544 行 ✗。大文件不是"风格问题"：它是
 *  「改一处要读 6000 行」「合并冲突全落在同一文件」「单测无法按职责切分」的根因 ✓。
 *
 *  本断言的作用不是**立刻拆分**（那是排期问题 ✓），而是：
 *   ① 把现有超预算文件**登记在案**（债务可见 ✓，每一条都要写理由 ✓）；
 *   ② **禁止新增**（新文件超标 ⇒ 红 ✗）；
 *   ③ 登记表与常量必须**同步减少**（拆完必须回来改 ✓）—— 即清单只能缩短 ✓。
 *
 *  运行：
 *      npm run test-agentstudio-common
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';
const BUDGET_LINES = 2500;

/**
 * 已知超预算文件（**只减不增** ✓）。2026-09-21 首次登记时的实测行数见注释 ✓。
 * 拆分之日：删掉对应条目 + 把 `FROZEN_OVERSIZE_COUNT` 减 1 ✓（本用例会强制你这么做 ✓）。
 */
const GRANDFATHERED_OVERSIZE: Record<string, string> = {
	// 6544 行：图谱构建（索引/查询/持久化/可视化数据组装耦合在一处）
	'src/vs/sessions/contrib/agentStudio/browser/codebaseGraphService.ts': '图谱服务，待按 索引/查询/持久化 三向拆分',
	// 6375 行：聊天卡渲染主面板
	'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts': '聊天面板，渲染/流式/工具卡装配耦合',
	// 5984 行（首轮实测漏登记 ✗ —— 由本用例自身抓出 ✓，正好证明它能兜住"新增/漏登记" ✓）
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts': 'webview 控制器，消息/视图/生命周期耦合',
	// 5193 行
	'src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBaseView.ts': '知识库视图，视图+数据访问耦合',
	// 4893 行
	'src/vs/sessions/contrib/agentStudio/browser/taskBoardNativeRenderer.ts': '任务看板原生渲染器',
	// 4241 行
	'src/vs/sessions/contrib/agentStudio/browser/workflowExecutionService.ts': '工作流执行引擎',
	// 4217 行
	'src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts': 'agentOS 编排服务',
	// 4189 行
	'src/vs/sessions/contrib/agentStudio/common/contextManager.ts': '上下文管理（压缩/预算/装配）',
	// 4153 行
	'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts': '贡献点注册（数量型膨胀）',
	// 4105 行
	'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts': '会话/历史服务（P0-1 起历史落盘已拆到 sessionHistoryLog ✓，可继续外提）',
	// 3744 行：pi 内核切换完成后应移除（阶段 4b ✓）
	'src/vs/sessions/contrib/agentStudio/browser/agentTurnExecutor.ts': 'legacy 主循环（pi 内核收尾后删除 ⇒ 天然消解 ✓）',
	// 3662 行
	'src/vs/sessions/contrib/agentStudio/browser/taskOrchestrationService.ts': '任务编排',
	// ✅ 2026-10-12 销账：`agentSettingsEditorPane.ts` 3208 → **2493 行**（同日两刀，都在行为网后面切）：
	//    · 「版本 / 商城版本」473 行 → `browser/agentVersionsSection.ts`
	//      （行为网 `test/browser/agentSettingsVersionsSection.test.ts` 21 条，拆前绿 / 拆后仍绿 ⇒ 等价性有据）
	//    · 「飞书 CLI」284 行 → `browser/larkCliSection.ts`
	//      （行为网 `test/browser/larkCliSection.test.ts` 19 条，拆前 17 条已绿 + 7 条反向突变证明不空跑）
	//    ⇒ 条目删除、冻结数 13→12 ✓（这才是"登记欠账"的正确收尾：拆到预算内再销账 ✓）
	// ✅ 2026-10-12 销账：`kbImportController.ts` 3077 → **2369 行**（把「库/笔记路径 + 构建缓存 +
	//    落盘叶子」这批静态成员外提到 `browser/knowledge/kbVaultFs.ts`，行为不变，有 1169 行测试守着）✓
	// ⚠ 2026-10-14 登记（**由本用例自身抓出**：插件中心那几个 tab/入口不是一次加完的，涨破 2500 时没人回来登记
	//   ⇒ 这条断言一直在报「新增超预算文件」，`failure-baseline.json` 里又没有它（容忍 0）⇒ 整轮全量的退出码是 1，
	//   真回归会被这条噪音淹掉 ✗。登记它是本文件头①那条「债务可见」的正解 ✓）。
	//   拆分方向（谁拆谁按这套走）：把「dsh 页签」整块外提 —— 运行时状态/组合启停/添加插件 + 策展清单卡片 +
	//   社区目录，落 `browser/views/pluginsDshSection.ts`；**前置条件**是先给它建行为网（本文件目前**没有**
	//   pluginsView 的渲染测试，拆了没法证明等价 ⇒ 与 `agentSettingsEditorPane` 那次同路径：先补网、再拆、再销账 ✓）。
	'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts': '插件中心视图（三页签 + 商城搜索 + VSIX 分发 + dsh 插件中心/添加插件）待带行为网把 dsh 页签外提',
	// ⚠ 2026-10-14 登记（同样**由本用例抓出**：落地 `chatWorkspaceAuthority` 那套"会话级工作区覆盖"
	//   时它从 2497 涨到 ~2520 ⇒ 恰好越过预算 ✗）。已先把新增注释压到最短（保留"为什么/三条语义/
	//   契约测试指针"），仍越线 ⇒ 按本文件头①「债务可见」登记 ✓。
	//   拆分方向：`agentStudioService.ts` 是**大杂烩**（工作区 / 会话 / agent / 连接 / 技能全在一个类里），
	//   先外提「会话」切片（含本次这套覆盖表）落 `browser/agentStudioSessions.ts`；
	//   **前置条件**：契约测试把 `_sessionWorkspaceOverrides` 钉在**本文件**里
	//   （`chatWorkspaceAuthority.test.ts` 的 IMPL 常量）⇒ 拆之前要先把那条契约改成"跟到新文件" ✓，
	//   否则拆完测试仍指旧路径 ⇒ 假绿 ✗。
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts': 'Agent Studio 主服务（工作区/会话/agent/连接/技能大杂烩）待按 会话 → agent·连接 外提',
};

/**
 * 冻结数量：新增超预算文件会让下面的断言变红 ⇒ 必须先把老的拆掉或改架构 ✓。
 *
 * 2026-10-12：先由 12 调到 14（登记 `agentSettingsEditorPane` 涨回 + `kbImportController` 从未登记），
 * 同日拆掉后者后回落到 13；再拆掉 `agentSettingsEditorPane`（两刀都进了 2500 行内）后**回落到 12** ✓
 * —— 清单只减不增 ✓。
 *
 * 2026-10-14：12 → **13**（登记 `views/pluginsView.ts` 2575 行）。同上：涨破预算时**先登记**（理由见下面那条），
 * 拆到 2500 行内那天再回来删条目 + 减 1 ✓。"只减不增"指的是**不许无声地涨** —— 涨必须有这一行可 review ✓。
 *
 * 2026-10-14（同日第二笔）：13 → **14**（登记 `browser/agentStudioService.ts` ~2520 行 —— 落地
 * `chatWorkspaceAuthority` 那套会话级工作区覆盖时越线 ✓）。同样：拆完回来销账 ✓。
 */
const FROZEN_OVERSIZE_COUNT = 14;

function listImplementationFiles(): string[] {
	const abs = path.join(process.cwd(), DOMAIN_REL);
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (['node_modules', 'webview', 'test', 'media'].includes(entry.name)) { continue; }
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) { continue; }
			out.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
		}
	};
	walk(abs);
	return out;
}

function lineCount(rel: string): number {
	return fs.readFileSync(path.join(process.cwd(), rel), 'utf8').split('\n').length;
}

suite('文件规模预算（P0-2）', () => {

	test(`★★★ 超 ${BUDGET_LINES} 行的文件必须**登记在案**，且不得新增`, () => {
		const offenders = listImplementationFiles()
			.map(rel => ({ rel, lines: lineCount(rel) }))
			.filter(f => f.lines > BUDGET_LINES)
			.sort((a, b) => b.lines - a.lines);

		const unregistered = offenders.filter(f => !GRANDFATHERED_OVERSIZE[f.rel]);
		assert.deepStrictEqual(unregistered.map(f => `${f.rel}（${f.lines} 行）`), [],
			`新增超预算文件 ✗ —— 要么拆分，要么先写出理由并登记（只减不增 ✓）：\n` +
			unregistered.map(f => `  ${f.rel} = ${f.lines} 行`).join('\n'));

		assert.strictEqual(offenders.length, FROZEN_OVERSIZE_COUNT,
			`超预算文件数量与冻结值不一致（实测 ${offenders.length}，冻结 ${FROZEN_OVERSIZE_COUNT}）—— ` +
			`拆掉一个就把 FROZEN_OVERSIZE_COUNT 减 1 并删除登记项 ✓（清单只减不增 ✓）`);
	});

	test('★★ 登记项必须仍然存在且仍然超预算（拆完要回来销账 ✓）', () => {
		const stale: string[] = [];
		for (const rel of Object.keys(GRANDFATHERED_OVERSIZE)) {
			const abs = path.join(process.cwd(), rel);
			if (!fs.existsSync(abs)) { stale.push(`${rel}（文件已不存在 ⇒ 删除登记项 ✓）`); continue; }
			if (lineCount(rel) <= BUDGET_LINES) {
				stale.push(`${rel}（已降到 ${lineCount(rel)} 行 ⇒ 删除登记项并下调 FROZEN_OVERSIZE_COUNT ✓）`);
			}
		}
		assert.deepStrictEqual(stale, [], `登记表已过期，请销账：\n${stale.join('\n')}`);
	});

	test('★ 每个登记项都必须写明理由（债务可见 ✓）', () => {
		for (const [rel, reason] of Object.entries(GRANDFATHERED_OVERSIZE)) {
			assert.ok(reason && reason.trim().length >= 4, `${rel} 缺少拆分理由 ✗`);
		}
	});
});
