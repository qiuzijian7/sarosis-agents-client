/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TUI（CLI）面板**流式重绘**的防闪烁契约测试（2026-09-21 第二轮）。
 *
 * ── 两轮问题的完整链路（用户两次实测 ✓）──────────────────────────────────────
 * 第一轮（今早）：`setStreamTextBuffer` / `setStreamThinkingBuffer` **每个 delta** 都触发
 *   `_updateMessageElement` ✓，而它是 `clearNode(el)` + 整条消息重建 ✗ ⇒ 每秒几十次
 *   「清空 + 重建」⇒ 闪烁 ✓。修法 = **rAF 合并** ✓（但只降了频率 ✗）。
 * 第二轮（本次，用户报"还是有闪烁"✓）：合并到"每帧一次"仍等于**每秒最多 60 次空白帧** ✗✓
 *   —— 因为 `clearNode` 与随后的 append 之间存在**空元素中间态**，长消息（表格/代码块）
 *   必然被画出一帧空白 ✓✓。修法 = ①**离屏构建 + 一次换入**（结构上无空白帧 ✓✓）
 *   ②**限频 80ms**（每秒 ≤~12 次 ✓）。
 *
 * ── 为什么用源码断言 ───────────────────────────────────────────────────────────
 * `CliChatEditorPanel` 依赖 DI 容器与 xterm 宿主 ✗，直接实例化成本远高于收益 ✓；
 * 而本轮的不变量都是**结构性**的（"不许再出现 clear-then-rebuild" ✓），
 * 用源码断言既精确又不会假装测过行为 ✓（行为验证请真机：见文件末注释 ✓）。
 *
 * 运行：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/browser/agentChat/cliChatEditorPanel.render.test.ts
 */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REL = 'src/vs/sessions/browser/agentChat/cliChatEditorPanel.ts';

function readSrc(): string {
	const abs = path.join(process.cwd(), REL);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 截出某个方法体（从签名到下一个同级 `\tprivate`/`\toverride` 之前 ✓）。 */
function methodBody(src: string, signature: string): string {
	const start = src.indexOf(signature);
	assert.ok(start >= 0, `找不到方法：${signature}`);
	const rest = src.slice(start + signature.length);
	const nextMember = rest.search(/\n\t(?:private|public|protected|override|static|readonly)\s/);
	return nextMember >= 0 ? rest.slice(0, nextMember) : rest;
}

suite('TUI 流式重绘防闪烁契约（2026-09-21 第二轮）', () => {

	test('★★★ 单条重建**不得**在活节点上 clearNode ⇒ 必须离屏构建 + 一次换入（无空白帧 ✓）', () => {
		const body = methodBody(readSrc(), 'private _updateMessageElement(messageId: string): void {');
		assert.ok(body.includes('const scratch = document.createElement('),
			'必须在**游离节点**上构建（否则中间空白态会被画出一帧 ⇒ 闪烁 ✗✓）');
		assert.ok(/el\.replaceChildren\(\.\.\./.test(body),
			'必须用 `replaceChildren(...)` **一次换入** ✓');
		assert.ok(!/clearNode\(el\)/.test(body),
			'★ 不许再对**活节点** clearNode ✗（这正是闪烁根因：clear 与 append 之间存在空元素帧 ✓✓）');
		// 渲染函数会改写容器的 class / style ⇒ 必须回写，否则出现"先默认样式再跳变" ✓
		assert.ok(/el\.className = scratch\.className/.test(body), '必须回写 className（user 消息/配色类 ✓）');
		assert.ok(/el\.style\.cssText = scratch\.style\.cssText/.test(body), '必须回写 style（--cli-msg-border-color ✓）');
	});

	test('★★★ 必须**限频**：连续 delta 不得每帧都重建（每秒 ≤ ~12 次 ✓）', () => {
		const src = readSrc();
		assert.ok(/RENDER_MIN_INTERVAL_MS = \d+/.test(src), '必须有最小重建间隔常量 ✓');
		assert.ok(/wait = CliChatEditorPanel\.RENDER_MIN_INTERVAL_MS - elapsed/.test(src),
			'间隔必须真正参与判定（只声明不引用 = 假护栏 ✗）');
		assert.ok(/window\.setTimeout\(/.test(src), '未到间隔时应排队而非立即重建 ✓');
	});

	test('★★ TUI 侧必须有渲染打点（本次真机日志里 `cliChat` 命中 0 ✗ ⇒ 无从取证 ✓）', () => {
		const src = readSrc();
		assert.ok(src.includes('[CliRender]'), '慢了必须留下 `[CliRender] ⚠ slow ...` 行 ✓（下次"还闪"才能定位 ✓）');
		assert.ok(/RENDER_SLOW_WARN_MS = \d+/.test(src), '慢渲染阈值必须是常量 ✓');
	});

	test('★★ 整段重建（_renderAllMessages）也必须离屏换入（否则载入会话闪一整帧 ✗）', () => {
		const body = methodBody(readSrc(), 'private _renderAllMessages(): void {');
		assert.ok(!/clearNode\(this\._messagesContainer\)/.test(body),
			'禁止先清空整个容器再重建 ✗（载入/切换会话会闪一整帧空白 ✓）');
		assert.ok(/this\._appendMessageElement\(msg, scratch\)/.test(body), '必须建到游离节点上 ✓');
		assert.ok(/this\._messagesContainer\.replaceChildren\(\.\.\./.test(body), '必须一次换入 ✓');
	});

	test('★★★ 流式期间必须**禁用异步代码块高亮**（否则每次重建都"先没代码块再补上" ⇒ 闪烁 ✓✓）', () => {
		const src = readSrc();
		// 真正的根因（用户第二轮实测 ✓）：`codeBlockRenderer` 是 **async** 的 ⇒ renderMarkdown
		// **分两段出 DOM**（先文本 → 代码块等 Promise ✓）⇒ 每 80ms 重建一次就"抹掉再画"一次 ✗✓。
		assert.ok(/codeBlockRenderer: hlCodeBlock/.test(src), '仍应保留高亮渲染器（流结束后要用 ✓）');
		assert.ok(/const hlCodeBlock = streaming\s*\?\s*undefined/.test(src),
			'★ 流式期间必须把高亮钩子置空 ⇒ 走**同步**朴素 <pre> ✓（结构上不可能两段式 ✓）');
		// 两个渲染入口都必须把 streaming 传下去（漏一个就会从那条路径闪回来 ✗）
		// ⚠ 两处写法不同：assistant 传 `msg.isStreaming === true` ✓、thinking 体传 `streaming` ✓
		//   ⇒ 断言必须覆盖两种形式（否则"看起来合并了"其实漏了一处 ✗✓）
		const streamingCalls = (src.match(/_renderMarkdown\([^;]*?(?:streaming|isStreaming)/g) ?? []).length;
		assert.ok(streamingCalls >= 2,
			`assistant 文本 + thinking 体都要传 streaming（实际 ${streamingCalls} 处 ✗）`);
	});

	test('★★★ 流**结束**必须补一次高亮渲染（否则代码块永远停在朴素 <pre> ✗✓）', () => {
		const body = methodBody(readSrc(), 'setStreamPhase(phase: StreamPhase): void {');
		assert.ok(/phase === 'idle'/.test(body), '必须在 idle（流结束）时触发 ✓');
		assert.ok(/_scheduleUpdateMessageElement\(last\.id\)/.test(body),
			'必须重排最后一条 assistant（补高亮版 ✓）');
	});

	test('★★★★ 滚动容器内禁止"无条件整段换入"（塌陷 scrollHeight ⇒ 拽回滚动 + 整屏重排 ✗✓）', () => {
		const src = readSrc();
		const body = methodBody(src, 'private _updateMessageElement(messageId: string): void {');
		// 用户第四轮报「依旧闪烁 + 底部无法滚动/看不到」⇒ 根因 = `replaceChildren` 先清空再加回 ✗
		assert.ok(/this\._updateTextInPlace\(el, scratch\)/.test(body),
			'必须先尝试**就地更新文本**（结构未变 ⇒ 零节点变更 ✓✓）');
		assert.ok(/_afterContentMutation\(scroller, prevTop, prevHeight, wasAtBottom\)/.test(body),
			'内容变更后必须恢复滚动锚点 ✓（否则用户滚动会被拽回 ✗）');
		// 就地更新必须"先全量校验、再统一写入"✗（边校验边写会留半套改动）
		// ⚠ 比对发生在 `_updateTextInPlace` 内 ⇒ 断言针对**全文**（不是上述方法体 ✗）
		assert.ok(/_sameStructure\(el, scratch\)/.test(src), '必须有结构比对 ✓');
		assert.ok(/private _applyText\(/.test(src), '必须有落地写入（叶子写 textContent ✓）');
		// 自动跟随失效的根因：自触发 scroll 事件把 _autoScroll 写成 false ⇒ 必须屏蔽
		const listener = methodBody(src, 'this._disposables.add(addDisposableListener(this._messagesScroll, EventType.SCROLL, () => {');
		assert.ok(/_suppressScrollSync/.test(listener), '滚动监听必须忽略自触发事件 ✓');
		assert.ok(/private _suppressScrollSync = false;/.test(src), '必须有屏蔽标记声明 ✓');
		// 两个渲染入口都要带锚点恢复
		const all = methodBody(src, 'private _renderAllMessages(): void {');
		assert.ok(/_afterContentMutation\(/.test(all), '_renderAllMessages 同样必须恢复锚点 ✓');
	});

	test('★★★★★★ 必须有 ResizeObserver 总闸（贴底后高度还会涨 ⇒ "看着到底其实还有内容" ✗✓）', () => {
		const src = readSrc();
		// 用户第六轮截图：滚动条已到底，但**异步代码块**之后的内容仍被截断 ✗✓
		// ⇒ 根因 = 非流式的高亮渲染是**异步**的 ⇒ 贴底之后才插入 ⇒ scrollHeight 再涨 ✗✓
		assert.ok(/new ResizeObserver\(/.test(src), '必须监听内容容器高度变化 ✓');
		assert.ok(/ro\.observe\(this\._messagesContainer\)/.test(src), '必须观察消息容器 ✓');
		assert.ok(/if \(!this\._autoScroll\) \{ return; \}/.test(src),
			'贴底前必须判断跟随态（否则与用户上滚**抢** ✗✓）');
		assert.ok(/ro\.disconnect\(\)/.test(src), 'dispose 时必须断开 ✓');
	});

	test('★★★★★ 贴底必须"滚两次"（布局未刷新时 `scrollHeight` 偏小 ⇒ 停在离底一行 ✗✓）', () => {
		const src = readSrc();
		const pin = methodBody(src, 'private _pinToBottom(scroller: HTMLElement): void {');
		// 同步一次 + **下一帧**一次（用户截图：最后一行被切在半行 + 再也滚不动 ✓✓）
		const sync = (pin.match(/scroller\.scrollTop = scroller\.scrollHeight;/g) ?? []).length;
		assert.ok(sync >= 2, `贴底必须写两次（同步 + 下一帧），实际 ${sync} ✗`);
		assert.ok(/requestAnimationFrame\(/.test(pin), '第二次必须在下一帧 ✓');
		// 所有贴底入口都必须走 `_pinToBottom`（各自滚一次 = 会漏 ✓）
		const scrollToBottom = methodBody(src, 'private _scrollToBottom(_animate: boolean): void {');
		assert.ok(/_pinToBottom\(this\._messagesScroll\)/.test(scrollToBottom),
			'_scrollToBottom 必须复用 `_pinToBottom` ✓');
		const afterMutation = methodBody(src, 'private _afterContentMutation(');
		assert.ok(/_pinToBottom\(scroller\)/.test(afterMutation),
			'_afterContentMutation 必须复用 `_pinToBottom` ✓');
		// "直接插进活容器"那条路（addMessage ✗）此前既无锚点也无贴底 ⇒ 必须补齐
		const add = methodBody(src, 'addMessage(message: IAgentChatMessage): void {');
		assert.ok(/_afterContentMutation\(scroller, prevTop, prevHeight, wasAtBottom\)/.test(add),
			'addMessage 必须走同一套锚点恢复 ✓');
		assert.ok(!/_scrollToBottom\(true\);\s*\}\s*$/m.test(add) || /_afterContentMutation\(/.test(add),
			'addMessage 不得只用 `_scrollToBottom` ✗');
		// 切会话语义 = 看最新 ⇒ 必须强制恢复跟随（否则沿用上一会话的 false ⇒ 打开就停在半截 ✗）
		const setMsgs = methodBody(src, 'setMessages(messages: IAgentChatMessage[]): void {');
		assert.ok(/this\._autoScroll = true;/.test(setMsgs), 'setMessages 必须强制恢复跟随 ✓');
	});

	test('★★★ 状态栏/提示行也必须"离屏 + 未变不碰 DOM"（每 delta 重建会让 spinner 动画反复重启 ✗✓）', () => {
		const src = readSrc();
		const statusBody = methodBody(src, 'private _renderStatusBar(): void {');
		const metaBody = methodBody(src, 'private _renderPromptMeta(): HTMLElement {');
		// 用户第三轮报「整个聊天框都在闪」⇒ 根因 = 这两个"周边区域"被每 delta 清空重建 ✗
		assert.ok(!/clearNode\(this\._statusBar\)/.test(statusBody),
			'状态栏禁止 clearNode（`.cli-spinner` 是 CSS 动画 —— 重建 = 动画从头播 ⇒ 看起来一直在闪 ✗✓）');
		assert.ok(!/clearNode\(this\._promptMetaRow\)/.test(metaBody),
			'提示行禁止 clearNode ✓');
		// 必须"内容未变 ⇒ 不碰 DOM"（只做离屏换入还不够：换入也会重启动画 ✗）
		assert.ok(/_lastStatusText/.test(statusBody), '状态栏必须有文本签名跳过 ✓');
		assert.ok(/replaceChildren\(\.\.\.Array\.from\(scratch\.childNodes\)\)/.test(statusBody),
			'状态栏变化时必须一次换入 ✓');
		assert.ok(/_lastMetaText/.test(metaBody), '提示行必须有文本签名跳过 ✓');
		assert.ok(/private _lastStatusText = ''/.test(src) && /private _lastMetaText = ''/.test(src),
			'签名字段必须声明 ✓');
	});

	test('★★ dispose 必须清掉限频定时器（否则释放后仍会改已销毁的 DOM ✗✓）', () => {
		const body = methodBody(readSrc(), 'override dispose(): void {');
		assert.ok(/window\.clearTimeout\(this\._renderTimer\)/.test(body), '必须清定时器 ✓');
		assert.ok(/this\._pendingRenderIds\.clear\(\)/.test(body), '必须清待重建队列 ✓');
	});
});
