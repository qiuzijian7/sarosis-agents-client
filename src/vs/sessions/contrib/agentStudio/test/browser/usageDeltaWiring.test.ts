/*---------------------------------------------------------------------------------------------
 *  usageDeltaWiring.test.ts — usage 透出链路（2026-09-20，「输入框 tokens UI 未更新」取证修复）
 *
 *  症状（真机日志 vscode-app-1789912013937）：composer 的上下文环长时间不动。
 *  根因链：
 *    ① **pi 内核不产 `usage` delta** —— `eventAdapter` 的 `message_end` 只映射
 *       `assistant_turn`，usage 仅进 host 侧记账（`piTurnKernel.accumulateUsage`）；
 *       而 pane/chatService 的 token 展示（上下文环、消息 footer 的 token/积分 pill、
 *       持久化的 `tokenUsage`）全靠 `usage` delta。legacy 路径是 provider delta 直通，故无此问题。
 *    ② pane 侧还有一道**多余的门**：`setStreamUsage` 被包在 `if (limit > 0)` 内
 *       （limit = `_currentMaxContextTokens`）——模型元信息匹配失败时连真实 usage 都不上送。
 *
 *  本文件钉住链路两端（行为断言在主链路：`piTurnKernel.test.ts` 的 usage 用例 ✓）：
 *    · 内核侧：message_end 必须补发 usage，且**先 usage 后边界**；
 *    · pane 侧：`setStreamUsage` 必须**无条件**调用（真实 usage 不进守卫）；
 *    · 口径：input/cacheRead 归一（与 host 记账同款，防 UI 与 Dashboard 数字打架 ✗）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/usageDeltaWiring.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('usage 透出链路（pi 内核 → pane → 上下文环）', () => {

	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	// 剥注释（本仓教训：注释里会刻意引用旧写法/旧日志作取证，连注释查会假红 ✓）
	const code = (rel: string): string => readSrc(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	const ADAPTER = 'src/vs/sessions/contrib/agentStudio/browser/piLoop/eventAdapter.ts';
	const PANE = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';

	test('★★★ message_end 必须补发 usage delta，且先 usage 后 assistant_turn', () => {
		const src = code(ADAPTER);
		assert.ok(src.includes('toUsageDelta('), 'eventAdapter 必须有 pi Usage → 本仓 usage delta 的映射 ✗');
		assert.ok(src.includes('type: \'usage\''), '必须产出 `usage` 类型的 delta ✗');
		// 顺序：usage 先入 out，assistant_turn 后入（usage 属于刚定稿的这条消息）
		const pushUsageIdx = src.indexOf('if (usageDelta) { out.push(usageDelta); }');
		const pushTurnIdx = src.indexOf('out.push(toAssistantTurnDelta(event.message));');
		assert.ok(pushUsageIdx !== -1 && pushTurnIdx !== -1 && pushUsageIdx < pushTurnIdx,
			'usage delta 必须排在 assistant_turn 之前（否则可能挂到下一轮消息 ✗）');
	});

	test('★★★ 口径归一：input 与 cacheRead 的关系判定必须与 host 记账同款', () => {
		const src = code(ADAPTER);
		const fnIdx = src.indexOf('function toUsageDelta(');
		assert.ok(fnIdx !== -1, '找不到 toUsageDelta ✗');
		const body = src.slice(fnIdx, fnIdx + 900);
		assert.ok(body.includes('rawInput >= cacheRead ? rawInput : rawInput + cacheRead'),
			'OpenAI 系 input 已含 cache / Anthropic 系不含 ⇒ 必须做同一归一（否则 UI 与 Dashboard 数字不一致 ✗）');
		assert.ok(body.includes('if (input <= 0 && output <= 0) { return undefined; }'),
			'零用量必须返回 undefined（不得产空 delta 污染下游基线 ✗）');
	});

	test('★★★ pane：真实 usage 不得被 `limit > 0` 守卫挡住（模型元信息缺失也要上送 ✗）', () => {
		const src = code(PANE);
		const usageIdx = src.indexOf('setStreamUsage({');
		assert.ok(usageIdx !== -1, 'pane 的 usage 分支必须调用 setStreamUsage ✗');
		// 找它所属的守卫链：向上取最近的 if (limit > 0) 出现位置，断言 setStreamUsage 不在其之后
		const limitGuardIdx = src.lastIndexOf('if (limit > 0)', usageIdx);
		const branchStart = src.lastIndexOf("case 'usage'", usageIdx);
		assert.ok(branchStart !== -1, '找不到 usage delta 分支 ✗');
		assert.ok(limitGuardIdx === -1 || limitGuardIdx < branchStart,
			'`setStreamUsage` 必须在该分支**无条件**执行（进了 `if (limit > 0)` ⇒ 元信息缺失时环永不更新 ✗）');
		// 而需要 effectiveWindow 的 setContextUsage 仍应在守卫内（分母口径依赖模型窗口）
		const ctxIdx = src.indexOf('setContextUsage({', usageIdx);
		const ctxGuardIdx = src.lastIndexOf('if (limit > 0)', ctxIdx);
		assert.ok(ctxIdx !== -1 && ctxGuardIdx !== -1 && ctxGuardIdx > branchStart,
			'`setContextUsage` 仍应在 limit 守卫内（它需要 effectiveWindow/thresholdTokens ✗）');
	});
});
