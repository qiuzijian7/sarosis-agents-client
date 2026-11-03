// @vssaros/dsh-chat-surface — 聊天里的「已创建自动化任务」卡片（conversation.chat.turnTail）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.scheduleCard.js")。
//
// ── 为什么要有它（2026-11-03，对照官方 dsh-client-ui-schedule 的 ScheduleTurnCard）─────────────
// 官方在**回合尾部**渲染「这一轮建出来的提醒」卡片：标题 + 频率 + 整卡可点（打开任务详情）。
// 我们此前聊天里只有工具输出的一段文字 ⇒ 用户建完不知道去哪看、也没法一键跳。
//
// ── 三条与官方一致的纪律 ────────────────────────────────────────────────────────────────
// ① **从结果反解，不做前端缓存**：任务身份只来自该次 `schedule_create` 的工具结果文本
//    （官方 `scheduleCreateCardModel` 同样从结果 JSON 读），所以会话重放/滚动加载后卡片仍对得上；
// ② **只认本轮**：用 `root.callTime` 落在本回合的 [start, end] 时间窗内筛（ToolState 本身不带 turn）；
// ③ **pending 不出卡**：只有 `kind === 'tool-result'` 的结算结果才渲染 —— 没有任务 id 的卡片
//    点了也去不了任何地方（官方同样只在拿到 task 时才出卡）。
//
// ── 数据形状（取自 dsh-client-ui-conversation 的类型定义）────────────────────────────────
//   nodes.values() 里 `kind === 'tool-call'` 的节点，`data` 是 `{ root: ToolCallBlock }`；
//   结算后的 `ToolCallBlock` 即 `{ kind: 'tool-result', name, content: ContentBlock[], callTime, isError }`。
//   ⚠ 不要假设 content 一定是 `{text}`：这里两种常见形状都认（见 textOf）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.scheduleCard.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

const SLOT = "conversation.chat.turnTail";
const TOOL_NAME = "schedule_create";
const STYLE_ID = "vssaros-schedule-created-cards";

const CSS = `
.vssSchedTurnCards { display:flex; flex-direction:column; gap:6px; margin:6px 0 2px; }
.vssSchedTurnCard {
	display:flex; align-items:center; gap:8px; width:100%; text-align:left; cursor:pointer;
	padding:8px 10px; border-radius:10px; font:inherit; color:inherit;
	border:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
	background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06));
	transition:background-color .12s;
}
.vssSchedTurnCard:hover { background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
/* ★ 2026-11-03：描边/激活别用 `--dsw-alias-brand-primary` —— 它在暗色主题下是
   `neutral-bluish-1000`（最深蓝黑），大面积填充或描边会看不见（scheduler 开关全黑就是这么来的）。 */
.vssSchedTurnCard:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary, #4c9aff); outline-offset:1px; }
.vssSchedTurnCardGlyph { flex:0 0 auto; opacity:.75; }
.vssSchedTurnCardTitle { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.vssSchedTurnCardFreq { flex:0 0 auto; font-size:11px; color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.vssSchedTurnCardOpen { flex:0 0 auto; font-size:11px; color:var(--dsw-alias-brand-text, #4c9aff); }
`;

function maintainStyle() {
	// ⚠ 守卫会用**假 document** 跑一遍 install()：它只有部分方法 ⇒ 逐个能力探测，
	//   缺任何一个就安静跳过（样式是增强，不是装载前提）。2026-11-03 首跑就栽在 getElementById 上。
	if (typeof document === "undefined" || !document || typeof document.getElementById !== "function"
		|| typeof document.createElement !== "function" || !document.head) { return; }
	if (document.getElementById(STYLE_ID)) { return; }
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

/** 把 ToolResultNode 的 content 拼成纯文本（`{type:'text',text}` 与 `{type:'text',value}` 都认）。 */
function textOf(block) {
	const parts = [];
	for (const item of (block && block.content) || []) {
		if (!item || typeof item !== "object") { continue; }
		if (typeof item.text === "string") { parts.push(item.text); continue; }
		if (typeof item.value === "string") { parts.push(item.value); continue; }
		if (item.type === "text" && typeof item.content === "string") { parts.push(item.content); }
	}
	return parts.join("\n").trim();
}

/**
 * 从结果文本里取任务身份：**JSON 优先**（我们的工具返回 `{id,title,kind,ruleText,next,sessionId}`），
 * 解析不了再用 `t-xxxxxxxx` 正则兜底（结果被外层包了别的东西时）。
 */
function taskOfText(text) {
	if (!text) { return null; }
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && typeof parsed.id === "string" && parsed.id) {
			return { id: parsed.id, title: String(parsed.title || ""), ruleText: String(parsed.ruleText || "") };
		}
	} catch { /* 不是 JSON，走正则 */ }
	const match = /"?(t-[0-9a-z]{6,})"?/.exec(text);
	return match ? { id: match[1], title: "", ruleText: "" } : null;
}

/** 本轮创建出来的任务（按 callTime 落在回合时间窗内筛，去重保序）。 */
function tasksOfTurn(snapshot, turn) {
	const nodes = snapshot && snapshot.nodes;
	if (!nodes || typeof nodes.values !== "function" || !turn) { return null; }
	const start = turn.start && typeof turn.start.time === "number" ? turn.start.time : null;
	const end = turn.end && typeof turn.end.time === "number" ? turn.end.time : null;
	if (start === null) { return null; }
	const out = [];
	const seen = Object.create(null);
	for (const node of nodes.values()) {
		if (!node || node.kind !== "tool-call" || !node.data) { continue; }
		const root = node.data.root;
		if (!root || root.kind !== "tool-result" || root.name !== TOOL_NAME) { continue; }
		if (typeof root.callTime === "number" && (root.callTime < start || (end !== null && root.callTime > end))) { continue; }
		const task = taskOfText(textOf(root));
		if (!task || seen[task.id]) { continue; }
		seen[task.id] = true;
		out.push(task);
	}
	return out.length ? out : null;
}

function openTask(taskId) {
	// 跳转的唯一入口由 automation 插件暴露（2026-11-03）：写焦点键 + 派发事件 + 打开工作台。
	if (typeof window !== "undefined" && typeof window.__vssarosSchedulerFocus === "function") {
		try { return window.__vssarosSchedulerFocus(taskId); } catch { return false; }
	}
	return false;
}

function ScheduleCreatedCard(props) {
	const turn = props && props.turn;
	const tasks = props && typeof props.useChat === "function"
		? props.useChat((snapshot) => tasksOfTurn(snapshot, turn))
		: null;
	if (!tasks || !tasks.length) { return null; }
	return react.createElement("div", {
		className: "vssSchedTurnCards",
		"data-vssaros-schedule-cards": String(tasks.length),
	}, tasks.map((task) => react.createElement("button", {
		key: task.id,
		type: "button",
		className: "vssSchedTurnCard",
		"data-vssaros-schedule-card": task.id,
		title: "打开任务详情：" + (task.title || task.id),
		onClick: () => { openTask(task.id); },
	},
		react.createElement("span", { className: "vssSchedTurnCardGlyph" }, "🕒"),
		react.createElement("span", { className: "vssSchedTurnCardTitle" }, task.title || task.id),
		task.ruleText ? react.createElement("span", { className: "vssSchedTurnCardFreq" }, task.ruleText) : null,
		react.createElement("span", { className: "vssSchedTurnCardOpen" }, "打开"),
	)));
}

/** 装载（主包 client.js 逐个 `part.install(ctx, shell)`）。 */
function install(ctx, shell) {
	if (!ctx || !ctx.slots || typeof ctx.slots.register !== "function") { return; }
	try { maintainStyle(); } catch { /* 样式是增强，失败不影响卡片注册 */ }
	try {
		ctx.slots.inject(SLOT, () => ctx.slots.register({
			name: SLOT,
			id: "vssaros-schedule-created",
			// 官方 ScheduleTurnCard 也是 20；用量页脚是 100 ⇒ 卡片在页脚之上、紧跟对话正文。
			order: 20,
		}, ScheduleCreatedCard));
	} catch (error) {
		console.warn("[vssaros-chat-surface] 自动化任务卡片注册失败：" + String((error && error.message) || error));
	}
	// shell 目前用不到（卡片只读 store + 调 window 上的跳转函数），保留参数位以便将来加"当前会话"判定。
	void shell;
}

exports.install = install;
// 仅测试用：纯逻辑可脱离 store 直接断言（插件装载只读 install）。
exports.__test = { textOf, taskOfText, tasksOfTurn };
return module.exports;
	},
});

