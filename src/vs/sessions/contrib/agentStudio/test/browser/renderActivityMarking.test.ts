/*---------------------------------------------------------------------------------------------
 *  renderActivityMarking.test.ts — 长任务归因标记 + 图表卡视口延迟（2026-09-20，源码级）
 *
 *  背景（真机日志 vscode-app-1789907494577 取证 ✓）：
 *   · `setMessages total=736 render=539.5ms`（LONG_TASK 591/563ms）；
 *   · `[ChatPerf] scrollbar.refreshMarkers=307.6ms`、`card.create.tool=69.8ms (renderMermaidDiagram)`；
 *   · 一次 **775ms 长任务报 `因=[(无标记)]`** —— 主线程被占 824ms 却无法归因 ✗
 *     （`markRenderActivity` 当时只覆盖 umd / subagent-cards / delta:* 四处，
 *      恰好在重渲染路径上全是空白 ⇒ 心跳只能写「无标记」）。
 *
 *  本文件钉住两条不变量：
 *   ① 四条重渲染路径必须打**常量**活动标记 ⇒ LONG_TASK 可直接读 `因=[...]`；
 *   ② 图表卡首屏渲染改为「进入视口才渲染」（用户主动重渲仍直连），且失败必须 fail-open。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/renderActivityMarking.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('长任务归因：渲染活动标记 + 图表卡视口延迟（2026-09-20）', () => {

	const CHAT_DIR = 'src/vs/sessions/browser/agentChat';
	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	// 剥离注释（本仓教训：注释里刻意引用旧写法/旧日志作取证，连注释查会假红 ✓）
	const code = (rel: string): string => readSrc(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	test('★★★ 四条重渲染路径必须打活动标记（否则 LONG_TASK 报「无标记」无法归因 ✗）', () => {
		const messages = code(`${CHAT_DIR}/agentChatPanel.messages.ts`);
		assert.ok(messages.includes("markRenderActivity('render-messages')"),
			'_renderMessages 必须打 render-messages（首屏/session 切换最大占用者 ✗）');
		assert.ok(messages.includes("markRenderActivity('lazy-chunk')"),
			'向上滚动加载历史块必须打 lazy-chunk ✗');

		const scrollbar = code(`${CHAT_DIR}/scrollbarController.ts`);
		assert.ok(scrollbar.includes("markRenderActivity('scrollbar-markers')"),
			'refreshScrollMarkers 必须打 scrollbar-markers（实测 307.6ms/535~602ms ✗）');

		const mermaid = code(`${CHAT_DIR}/agentChatPanel.mermaidCard.ts`);
		const mermaidMarks = mermaid.split("markRenderActivity('mermaid')").length - 1;
		assert.ok(mermaidMarks >= 2,
			`卡片渲染 + markdown fence 预览两条路径都要打 mermaid（实际 ${mermaidMarks} 处 ✗）`);
	});

	test('★★ 标记必须是常量字符串（热点路径零分配；拼字符串会加剧 GC 抖动 ✗）', () => {
		for (const rel of [`${CHAT_DIR}/agentChatPanel.messages.ts`, `${CHAT_DIR}/scrollbarController.ts`, `${CHAT_DIR}/agentChatPanel.mermaidCard.ts`]) {
			const src = code(rel);
			const calls = src.match(/markRenderActivity\([^)]*\)/g) ?? [];
			assert.ok(calls.length > 0, `${rel} 应有标记调用 ✗`);
			for (const call of calls) {
				assert.ok(/^markRenderActivity\('[a-zA-Z:-]+'\)$/.test(call),
					`标记必须传常量字符串（禁模板串/拼接）：${call} ✗`);
			}
		}
	});

	// ─── delegate 卡正文视口延迟（2026-09-20：真机 52.4ms 那条消息含 delegate×4）─────
	test('★★★ delegate 卡正文必须视口延迟构建（默认展开 + 建卡即建三段正文 = 白干 ✗）', () => {
		const src = code(`${CHAT_DIR}/agentChatPanel.delegateCards.ts`);
		assert.ok(src.includes('let bodyRendered = false;') && src.includes('const renderBody = (): void => {'),
			'delegate 卡必须把三段正文收进 renderBody（幂等守卫 ✗）');
		// 触发时机三选一：运行中立即 / 进入视口 / 用户展开兜底
		// ⚠ 空白宽容匹配（源码缩进随层级变化，精确 \t 计数会假红 ✗）
		assert.ok(/if \(isRunning\) \{\s*renderBody\(\);\s*\} else \{\s*this\._renderWhenCardVisible\(scroll, renderBody\);/.test(src),
			'必须「运行中立即 + 否则视口延迟」（运行中用户要看实时过程 ✗）');
		assert.ok(src.includes('renderBody();\t// ★ 用户展开'),
			'toggle 展开必须兜底 renderBody（视口未触发也不能出现空 body ✗）');
		// 延迟完成后补置底（构建前内容为空，早先 pin 无内容可钉）
		assert.ok(src.includes('this._markProgrammaticPinWrite(scroll)'),
			'延迟构建完成后必须补一次置底（否则卡片停在顶部 ✗）');
	});

	test('★★★ 图表卡首屏渲染必须走视口延迟；用户主动重渲必须仍直连 ✗✓', () => {
		const src = code(`${CHAT_DIR}/agentChatPanel.mermaidCard.ts`);
		assert.ok(src.includes('this._renderWhenCardVisible(previewPanel, () => void renderChart(currentTheme))'),
			'首次渲染必须改为视口延迟（否则一次建 N 张卡就排队 N 次 69.8ms 渲染 ✗）');
		// 主题按钮是用户主动操作 ⇒ 直连，不该被延迟（否则点了按钮没反应 ✗）
		assert.ok(src.includes('void renderChart(currentTheme);'),
			'主题切换等用户主动路径必须保留直连渲染 ✗');
	});

	test('★★★ 视口延迟必须 fail-open（无 IO / 异常 ⇒ 立即渲染，绝不吞图表 ✗）', () => {
		// ★ 2026-09-20：helper 已**提升到基类**（delegate/图表卡共用）⇒ 断言打在 base 定义处；
		//   图表卡侧只保留调用点（避免两处实现漂移 ✗）。
		const src = code(`${CHAT_DIR}/agentChatPanel.base.ts`);
		// ⚠ 必须定位到**定义处**（`protected _renderWhenCardVisible(`）——
		//   首处出现是调用点，取错窗口会假红（本测试首跑即踩 ✓）。
		const start = src.indexOf('protected _renderWhenCardVisible(');
		assert.ok(start !== -1, '必须存在 _renderWhenCardVisible 辅助方法 ✗');
		const body = src.slice(start, start + 1200);
		assert.ok(body.includes("typeof IntersectionObserver === 'undefined'") && body.includes('render(); return;'),
			'无 IntersectionObserver（旧环境/测试）必须立即渲染 ✗');
		assert.ok(/catch\s*\{\s*render\(\);\s*\}/.test(body), '异常必须回退为立即渲染（fail-open ✗）');
		assert.ok(body.includes('io.disconnect()'), '命中后必须断开观察器（防泄漏 + 防重复渲染 ✗）');
		assert.ok(body.includes('!el.isConnected'), '元素已被移除时必须跳过渲染（省掉整段工作 ✓）');
		assert.ok(body.includes('this._register(toDisposable('), '观察器必须纳入 disposables（pane 释放时断开 ✗）');
	});

	test('★★★ _renderMessages 不得回退为同步 refreshScrollMarkers（307.6ms 元凶 ✗）', () => {
		const src = code(`${CHAT_DIR}/agentChatPanel.messages.ts`);
		const fnIdx = src.indexOf('protected override _renderMessages(');
		assert.ok(fnIdx !== -1, '找不到 _renderMessages ✗');
		const body = src.slice(fnIdx, src.indexOf('protected override _setupLazyLoad(', fnIdx));
		assert.ok(body.includes('this._scrollbar.scheduleRefreshScrollMarkers()'),
			'_renderMessages 必须走 rAF 合并版标记刷新 ✗');
		assert.ok(!body.includes('this._scrollbar.refreshScrollMarkers()'),
			'_renderMessages 内不得再同步调 refreshScrollMarkers（布局陈旧 + 307.6ms ✗）');
	});

	// ─── parts 渲染按 kind 拆解（2026-09-20：回答「超长消息的钱花在哪类段上」）─────────
	// 背景：`render.createMessageElement=58.3ms | parts=127 tools=69` 与 `parts.render=56.7ms`
	// 几乎相等 ⇒ 成本全在 parts 遍历内；而旧的子标签只给「单次最慢」，回答不了
	// 「哪一类段吃掉最多」（数量型 vs 单点型需要完全不同的优化手段）。
	test('★★★ parts 渲染必须按 kind 拆解（text/tool/thinking 三类各自计数与耗时）', () => {
		const src = code(`${CHAT_DIR}/agentChatPanel.markdown.ts`);
		assert.ok(src.includes('parts.byKind.${kind}'), '必须按 kind 记录（供 30s 汇总看全局主导类别 ✗）');
		assert.ok(src.includes("chatPerf.record('parts.breakdown'"), '每条消息渲染结束必须打一行 breakdown ✗');
		// 三个分支都必须计入（漏一个 ⇒ 拆解总和 ≠ parts.render，结论失真 ✗）
		const perPartCalls = src.match(/perPart\('(text|tool|thinking)', tPart\)/g) ?? [];
		assert.strictEqual(perPartCalls.length, 3,
			`text/tool/thinking 三个分支都要计时（实际 ${perPartCalls.length} 处 ✗）`);
		// 明细必须带 msg id + 各类明细（否则无法与 createMessageElement 的 msg= 对齐 ✗）
		const bdIdx = src.indexOf("chatPerf.record('parts.breakdown'");
		const detail = src.slice(bdIdx, bdIdx + 700);
		for (const key of ['msg=${hostMsg?.id ?? \'\'}', 'parts=${parts.length}', 'text=${kindStat.text.n}', 'tool=${kindStat.tool.n}', 'think=${kindStat.thinking.n}']) {
			assert.ok(detail.includes(key), `breakdown 明细必须含 ${key} ✗`);
		}
	});
});
