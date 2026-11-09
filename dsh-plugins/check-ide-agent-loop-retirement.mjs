#!/usr/bin/env node
/**
 * IDE agent loop 退役门禁（2026-11-07 用户拍板「IDE agent loop 整体下线」）。
 *
 * 背景：`chatEngine` 配置 enum 已收窄成 `['dsh']`，但 IDE 侧 agent loop 并未整体失活——
 * 工作流、知识库导入、任务编排、swarm/delegation、手机桥、Claw 视图、config-html、webview
 * 仍直接调 `IAgentOSService.executeAgentTurn` / `IAgentChatService.sendMessage`。
 * `agentOSService.ts` / `common/providers.ts` / `nativeChatEditorPane.ts` / `agentChatService.ts`
 * 等还被非 agent-loop 的功能复用，**不能整删**（见项目记忆里的 6 步下线顺序）。
 *
 * 所以这里把「只许收敛」变成机器判据：每下线一个运行期入口就下调上限，
 * 防止合并冲突 / 复制粘贴把旧的 IDE loop 入口抄回来。与 `check-legacy-freeze.mjs`
 * 同款：真要新增入口必须显式调上限并写明理由。
 *
 * 基线（2026-11-07 实测，生产调用点，不含测试）：
 *   - executeAgentTurn = 12（agentDelegationService / agentDriverService / preLoopDeps /
 *     swarmService / delegationTools / workflowChildPort / taskOrchestrationService ×6）
 *     —— 2026-11-07 Step 1 删掉零生产引用的 `providers/tool/planExploreTool.ts`（原第 13 个）
 *   - sendMessage = 7（★ 2026-11-07 口径修正：此前正则只认 `chatService.sendMessage`，
 *     漏计 `this.agentChatService.sendMessage` / `chat.sendMessage` 等变量名 ⇒ 把 13 误记成 4。
 *     现统一用 `\.sendMessage\s*\(` 统计生产 .ts。13 处的收敛：
 *       · `views/clawChatView.ts` 孤儿视图删除（-1）；
 *       · `configHtmlService` Text fallback 改走 `runTurn`（-1）；
 *       · `kbImportController` agentic 构建链整体换宿主到 `/x/kb/`（-3）；
 *       · 「移除 config.html」：`handleChatSend` / `handleChatSendStream` 退役（-2）；
 *       · IDE webview 主聊天 `chat.send` 改走 dsh 后台回合（-1，运行期本就不可达）。
 *       · IDE DOM 聊天面板的本地发送（运行期不可达）改走 dsh 后台回合（-1）。
 *       · `sarosPocket` 手机桥改走 dsh 后台回合，用 `appendMessage` 保住 IDE 会话历史（-1）。
 *     剩 4：taskOrchestrationService ×3、workflowExecutionService 各 1）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRIB = join(ROOT, 'src', 'vs', 'sessions', 'contrib');

const MAX_EXECUTE_AGENT_TURN = 12;
const MAX_SEND_MESSAGE = 4;

let failed = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const fail = msg => { console.error(`  ✗ ${msg}`); failed += 1; };

/** 只统计生产 `.ts`（排除测试文件与 test 目录）——测试里的 stub 不算运行期入口。 */
function productionTs(dir) {
	const out = [];
	if (!existsSync(dir)) { return out; }
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'test' || entry.name === 'node_modules') { continue; }
			out.push(...productionTs(rel));
		} else if (rel.endsWith('.ts') && !rel.endsWith('.test.ts') && !rel.includes('.test.')) {
			out.push(rel);
		}
	}
	return out;
}

const files = productionTs(CONTRIB);
function countCalls(pattern) {
	let n = 0;
	for (const file of files) {
		for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
			const trimmed = line.trim();
			// 注释里提到方法名不算运行期入口（否则写一句说明就会误报上限回升）。
			if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) { continue; }
			if (pattern.test(line)) { n += 1; }
		}
	}
	return n;
}

const turns = countCalls(/\.executeAgentTurn\s*\(|agentOS\.executeAgentTurn/);
if (turns > MAX_EXECUTE_AGENT_TURN) {
	fail(`executeAgentTurn 运行期入口回升到 ${turns}（上限 ${MAX_EXECUTE_AGENT_TURN}）⇒ 有 IDE loop 入口被抄回来`);
} else {
	ok(`executeAgentTurn 生产入口 ${turns} ≤ 上限 ${MAX_EXECUTE_AGENT_TURN}（只许继续减）`);
}

const sends = countCalls(/\.sendMessage\s*\(/);
if (sends > MAX_SEND_MESSAGE) {
	fail(`sendMessage 运行期入口回升到 ${sends}（上限 ${MAX_SEND_MESSAGE}）⇒ 有 IDE loop 入口被抄回来`);
} else {
	ok(`sendMessage 生产入口 ${sends} ≤ 上限 ${MAX_SEND_MESSAGE}（只许继续减）`);
}

// legacy 回退不许回来（配置层收窄是 Step 0 的前提）。
const CONTRIB_FILE = join(CONTRIB, 'dshHarness', 'electron-browser', 'dshHarness.contribution.ts');
const contrib = readFileSync(CONTRIB_FILE, 'utf8');
// ⚠ 只看 ChatEngine 这一段：同文件里 `ModuleEngine` / `EntryKanban` 仍保留 legacy 回退，
//   那是另两条产品开关，不属于 IDE agent loop，不能拿全文匹配误判。
const start = contrib.indexOf('[DshHarnessSettings.ChatEngine]:');
const next = start >= 0 ? contrib.indexOf('[DshHarnessSettings.', start + 1) : -1;
const block = start >= 0 ? contrib.slice(start, next > start ? next : undefined) : '';
if (!/enum:\s*\['dsh'\]/.test(block) || /enum:\s*\[\s*'legacy'|enum:\s*\['dsh',\s*'legacy'/.test(block)) {
	fail('chatEngine enum 不再是唯一的 [\'dsh\'] ⇒ legacy 回退被恢复了');
} else {
	ok('chatEngine enum 仍只有 [\'dsh\']（legacy 回退未恢复）');
}

// 已退役的 IDE loop 入口文件不许被重建（Step 1 起逐个往这里登记）。
// 计数门禁只拦「调用点回升」，拦不住有人把整个孤儿视图复制回来 ✗ ⇒ 两条判据互补。
const RETIRED_FILES = [
	'src/vs/sessions/contrib/agentStudio/browser/views/clawChatView.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/planExploreTool.ts',
	// ★ 2026-11-07「移除 config.html」第一刀：webview 内嵌预览面板 + 事件桥 + store + 样式。
	//   这些组件在 webview/src 里零挂载点，删后 webview build（esbuild）仍 exit=0。
	'src/vs/sessions/contrib/agentStudio/webview/src/features/configmd/ConfigHtmlPanel.tsx',
	'src/vs/sessions/contrib/agentStudio/webview/src/features/configmd/ConfigHtmlChatBox.tsx',
	'src/vs/sessions/contrib/agentStudio/webview/src/features/configmd/HtmlEditor.tsx',
	'src/vs/sessions/contrib/agentStudio/webview/src/features/configmd/configHtmlBridge.ts',
	'src/vs/sessions/contrib/agentStudio/webview/src/store/useConfigHtmlStore.ts',
	'src/vs/sessions/contrib/agentStudio/webview/src/styles/configHtml.css',
	// ★ 2026-11-07 第五刀：config.html URL 模式（共享 opener + 主进程本地服务通道）。
	'src/vs/sessions/contrib/agentStudio/browser/configHtmlPreviewOpener.ts',
	'src/vs/sessions/contrib/agentStudio/electron-main/configHtmlServerChannel.ts',
	// ★ 2026-11-07 第十一刀：config.html 配置模块整体删除（通用工具已外提到 nativeBridge.ts）。
	'src/vs/sessions/contrib/agentStudio/common/configHtmlConfig.ts',
];
const rebuilt = RETIRED_FILES.filter(f => existsSync(join(ROOT, f)));
if (rebuilt.length) {
	fail(`已退役的 IDE loop 入口被重建：${rebuilt.join('、')}`);
} else {
	ok(`${RETIRED_FILES.length} 个已退役 IDE loop 入口文件未被重建`);
}

// ── ⑤ 统一会话 launcher（IDE loop 的替代能力）必须在位 ──────────────
// 13 个 sendMessage 后台入口要改走它；这条判据防止替代能力被删掉后
// 「下线」变成「直接砍功能」。与 `test/common/dshSessionLauncher.test.ts` 互补：
// 单测测逻辑，这条门禁测文件与接线没被合并冲突弄丢。
const LAUNCHER_REQUIRED = {
	'src/vs/sessions/common/dshSessionLauncher.ts': [
		'setDshSessionLauncher', 'getDshSessionLauncher', 'runTurn(',
	],
	'src/vs/sessions/contrib/dshHarness/common/dshSessionLauncherCore.ts': [
		'resolveLaunchCwd', 'deriveLaunchSessionId', 'toSessionStartArgs(', 'toSessionRunArgs(',
	],
	'src/vs/sessions/contrib/dshHarness/electron-browser/dshSessionLauncher.ts': [
		'setDshSessionLauncher(impl)', 'this.dsh.startSession(', 'this.dsh.runSession(',
	],
	'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts': [
		'registerWorkbenchContribution2(DshSessionLauncherContribution.ID',
	],
	'dsh-plugins/vssaros-bridge/lib/index.js': [
		"case 'session.start'", "case 'session.run'", "case 'session.cancel'",
	],
	// ★ 2026-11-07：原本钉的是 config.html 的 Text fallback，但 htmlGenerate 随
	//   config.html 移除已退役 ⇒ 改钉仍在线的手机桥后台回合（同两个接线形态）。
	'src/vs/sessions/contrib/sarosPocket/browser/sarosPocket.contribution.ts': [
		'getDshSessionLauncher()', 'launcher.runTurn(',
	],
};
let missingCapability = 0;
for (const [rel, needles] of Object.entries(LAUNCHER_REQUIRED)) {
	const file = join(ROOT, rel);
	if (!existsSync(file)) { fail(`替代能力文件缺失：${rel}`); missingCapability += 1; continue; }
	const text = readFileSync(file, 'utf8');
	for (const needle of needles) {
		if (!text.includes(needle)) {
			fail(`${rel} 缺少接线 '${needle}' ⇒ session.start/run 链不完整`);
			missingCapability += 1;
		}
	}
}
if (missingCapability === 0) { ok('session.start/run 控制桥 + 统一 launcher 三层接线都在位'); }

// ── ⑥ 换 UI 宿主：知识库构建的 IDE 侧入口只留「打开 dsh /x/kb/ 页」 ────
// 2026-11-07 用户拍板：config.html 内嵌聊天 / 知识库构建 / 任务编排改由 dsh 页面承载。
// 知识库是第一个切片：阶段 A 落盘保留，阶段 B 的 IDE agentic 构建改路由到 `/x/kb/`
// 的 `kb_build`（工具 + 会话 + 批授权）。这条判据防止旧构建链被合并冲突抄回来。
const UI_HOST_REQUIRED = {
	'src/vs/sessions/contrib/agentStudio/browser/kbImportController.ts': [
		'export async function openKbBuildDshPage(',
		"DshPluginPageEditorInput.getOrCreate('agentStudio.knowledgeBase'",
		'if (!opts?.skipOpen) {', 'await openKbBuildDshPage(this._editorService)',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts': [
		'await openKbBuildDshPage(editorService)',
	],
	'src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBaseView.ts': [
		'void openKbBuildDshPage(this.editorService)',
		'await openKbBuildDshPage(this.editorService)',
	],
};
const UI_HOST_FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts': [
		'kbImport.buildNotesFromLibrary(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBaseView.ts': [
		'this._kbImport.buildNotesFromLibrary(', 'this._kbImport.buildPendingAsAgentSession(',
		'_batchBuildAll()',
	],
	// 知识库 agentic 执行链已整体退役；这些是代码形态（注释里提到名字不算）。
	'src/vs/sessions/contrib/agentStudio/browser/kbImportController.ts': [
		'chatService.sendMessage(', 'chat.sendMessage(',
		'await this._buildNoteAgentic(', 'this._ensureKbBuildChatSession()',
		'private async _buildPendingAsAgentSessionInner(',
		// 组合入口里那处「IDE 自动构建」调用（方法本身保留给静态批量管线，只禁这一形态）
		'await this.buildNotesFromLibrary(libUri, vaultRootUri)',
	],
};
let uiHostIssues = 0;
for (const [rel, needles] of Object.entries(UI_HOST_REQUIRED)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (!text.includes(needle)) { fail(`${rel} 缺少换宿主接线 '${needle}'`); uiHostIssues += 1; }
	}
}
for (const [rel, needles] of Object.entries(UI_HOST_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现 IDE 侧构建链 '${needle}' ⇒ 换宿主被回退`); uiHostIssues += 1; }
	}
}
if (uiHostIssues === 0) { ok('知识库构建入口已换宿主到 dsh /x/kb/（IDE 侧只留打开页面的按钮）'); }

// ── ⑦ 移除 config.html：内嵌聊天不得回来 ──────────────────────────────
// 2026-11-07 用户拍板「移除 config.html」（不新建 dsh 承接页）。
// `handleChatSend` / `handleChatSendStream` 已退役为可读提示；保留方法形状是因为
// `IConfigHtmlService` 与预览 SDK / webview controller 仍按原协议消费。
// 注意：`htmlGenerate` 的一次性生成仍保留（走 `runTurn`），不在本判据范围内。
const CONFIGHTML_FILE = 'src/vs/sessions/contrib/agentStudio/browser/configHtmlService.ts';
const configHtmlSrc = readFileSync(join(ROOT, CONFIGHTML_FILE), 'utf8');
let configHtmlIssues = 0;
// ★ 2026-11-07 第十四刀：内嵌聊天入口连同 config.html 服务一起瘦身，
// 原来的「可读提示」方法已删除 ⇒ 判据改为「死方法不得回来 + 活链必须在位」。
for (const needle of [
	'handleChatSend(', 'handleChatSendStream(', 'cancelStream(', 'htmlGenerate(',
	'writeHtml(', 'applyPatch(', 'parseModelOutput(', 'kvGet(',
	'await this.agentChatService.sendMessage(', 'private readonly _streamSessions =',
]) {
	if (configHtmlSrc.includes(needle)) { fail(`${CONFIGHTML_FILE} 又出现 config.html 死方法 '${needle}'`); configHtmlIssues += 1; }
}
for (const needle of ['getHtml(', 'setActiveAgentSession(', '_renderInternal(', '_ensureState(']) {
	if (!configHtmlSrc.includes(needle)) { fail(`${CONFIGHTML_FILE} 缺少仍在线的活链 '${needle}'`); configHtmlIssues += 1; }
}
if (configHtmlIssues === 0) { ok('config.html 服务已瘦成最小壳（内嵌聊天与 20 个死方法退役）'); }

// webview 侧：事件桥与两个 config.html 专用导出不得抄回来。
const WEBVIEW_FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/webview/src/index.tsx': [
		'dispatchConfigHtmlEvent(', 'configHtml.css', "case 'confightml.htmlRendered'",
	],
	'src/vs/sessions/contrib/agentStudio/webview/src/bridge/fileBridge.ts': [
		'openAgentConfigHtml(', 'previewAgentConfigHtml(', "'confightml.previewToFile'",
	],
	// ★ 2026-11-07 第四刀：`HtmlFileEditorPane` 是**通用** HTML 预览编辑器
	//   （图表预览 / 聊天 Apply HTML / kbBlocks 活页面都复用），不能整删；
	//   只摘 config.html 专属的 AgentConfigHtml SDK 注入与 confightml.* 消息监听。
	'src/vs/sessions/contrib/agentStudio/browser/htmlFileEditorPane.ts': [
		"case 'confightml.", "'confightml.chatSend'", 'AgentConfigHtml SDK] tag-1', 'sdkWrapper',
	],
	// URL 模式：主进程注册 + 两个预览入口不得抄回来。
	'src/vs/code/electron-main/app.ts': ['ConfigHtmlServerChannel'],
	'src/vs/sessions/contrib/agentStudio/browser/agentSettingsEditorPane.ts': [
		'ensureConfigHtmlServerAndOpenPreview(', 'configHtmlPreviewOpener.js',
	],
	'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts': [
		'ensureConfigHtmlServerAndOpenPreview(', 'configHtmlPreviewOpener.js',
	],
};
let webviewIssues = 0;
for (const [rel, needles] of Object.entries(WEBVIEW_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现 config.html 面板接线 '${needle}'`); webviewIssues += 1; }
	}
}
if (webviewIssues === 0) { ok('webview 内嵌预览面板接线已移除（事件桥 / 样式 / 零调用导出）'); }

// ★ 2026-11-07「移除 config.html」第三刀：`confightml.*` 消息协议对整体退役。
// host RequestType(14) + EventType(5) 与 webview RequestType(14) 由
// `messageProtocolConsistency.test.ts` 成对守卫 ⇒ 必须两边同时删，否则该测试立刻红。
const PROTOCOL_FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/browser/messageProtocol.ts': ["| 'confightml."],
	'src/vs/sessions/contrib/agentStudio/webview/src/bridge/messageClient.ts': ["| 'confightml."],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts': [
		'case "confightml.', '_sendEvent("confightml.',
	],
};
let protocolIssues = 0;
for (const [rel, needles] of Object.entries(PROTOCOL_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现 confightml 协议 '${needle}' ⇒ 移除被回退`); protocolIssues += 1; }
	}
}
if (protocolIssues === 0) { ok('confightml.* 消息协议对已移除（host + webview + controller case/推送）'); }

// ── ⑧ IDE webview 主聊天（运行期不可达）不得回到 IDE agent loop ──────
// 证据：`nativeChatEditorPane.ts:6099` 的 `if (!this._dshBinding && ...)` ⇒
// chatEngine=dsh 时 `_initChatPanel()` 不执行，IDE DOM 聊天面板不创建。
const WVC_FILE = 'src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts';
const wvcSrc = readFileSync(join(ROOT, WVC_FILE), 'utf8');
let wvcIssues = 0;
for (const needle of ['this._retiredChatSend(', 'getDshSessionLauncher()']) {
	if (!wvcSrc.includes(needle)) { fail(`${WVC_FILE} 缺少退役转发 '${needle}'`); wvcIssues += 1; }
}
if (wvcSrc.includes('this.agentChatService.sendMessage(')) {
	fail(`${WVC_FILE} 又出现 IDE 主聊天 sendMessage ⇒ 退役被回退`); wvcIssues += 1;
}
if (wvcIssues === 0) { ok('IDE webview 主聊天已改走 dsh 后台回合（不可达路径不再跑 IDE loop）'); }

// ★ 2026-11-07 主线：`NativeChatEditorPane` 的本地发送同样运行期不可达
//   （`setInput` 里 `!this._dshBinding && !this._isInitialized` 才 `_initChatPanel()`）。
const PANE_FILE = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
const paneSrc = readFileSync(join(ROOT, PANE_FILE), 'utf8');
let paneIssues = 0;
for (const needle of ['this._retiredChatSend(', 'getDshSessionLauncher()']) {
	if (!paneSrc.includes(needle)) { fail(`${PANE_FILE} 缺少退役转发 '${needle}'`); paneIssues += 1; }
}
if (paneSrc.includes('this._chatService.sendMessage(')) {
	fail(`${PANE_FILE} 又出现 IDE DOM 聊天 sendMessage ⇒ 退役被回退`); paneIssues += 1;
}
if (paneIssues === 0) { ok('IDE DOM 聊天面板本地发送已改走 dsh 后台回合'); }

// ── ⑩ 手机桥：回合改走 dsh，但 IDE 会话历史同步语义必须保留 ──────────
// `sarosPocket.sendToSession` 的现场需求是「手机上发了，桌面端聊天框也能看到」。
// 用 `appendMessage`（只落盘、不广播）显式写 user/assistant 两条：既不再跑 IDE loop，
// 又不与 fireUserMessageAdded 产生双气泡。这两条判据防止有人改回 sendMessage 或漏写历史。
const POCKET_FILE = 'src/vs/sessions/contrib/sarosPocket/browser/sarosPocket.contribution.ts';
const pocketSrc = readFileSync(join(ROOT, POCKET_FILE), 'utf8');
let pocketIssues = 0;
for (const needle of [
	'getDshSessionLauncher()', 'launcher.runTurn(',
	'chatService.appendMessage(agentId, userMessage)', 'chatService.fireUserMessageAdded(',
]) {
	if (!pocketSrc.includes(needle)) { fail(`${POCKET_FILE} 缺少接线 '${needle}'`); pocketIssues += 1; }
}
if (pocketSrc.includes('chatService.sendMessage(')) {
	fail(`${POCKET_FILE} 又出现 IDE 主聊天 sendMessage ⇒ 手机桥退役被回退`); pocketIssues += 1;
}
if (pocketIssues === 0) { ok('手机桥回合已改走 dsh（appendMessage 保住 IDE 会话历史）'); }

// ── ⑪ 移除 config.html：UI 页签与预设技能残留不得回来 ──────────────
// 2026-11-07：聊天设置面板的 ConfigHtml 页签（206 行渲染方法 + tab 项 + 分支 +
// 专用 import）、agent 更新时的自动技能注入、新建 agent 的预设默认技能已整体退役。
// 这些是**代码形态**禁串，注释里提到 config.html / confightml 不算。
const CONFIGHTML_UI_FORBIDDEN = {
	'src/vs/sessions/browser/agentChat/agentChatPanel.dropdowns.ts': [
		'_renderSettingsConfigHtmlTab(', "id: 'confightml'", 'import { defaultPortOf',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts': [
		'Auto-added "confightml" skill',
	],
	'src/vs/sessions/contrib/agentStudio/webview/src/features/agents/CreateAgentModal.tsx': [
		'PRESET_DEFAULT_SKILL_IDS',
	],
};
let configHtmlUiIssues = 0;
for (const [rel, needles] of Object.entries(CONFIGHTML_UI_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现 config.html UI 残留 '${needle}'`); configHtmlUiIssues += 1; }
	}
}
if (configHtmlUiIssues === 0) { ok('config.html 设置页签 / 预设技能 / 自动注入残留已清除'); }

// ── ⑫ 移除 config.html：ConfigHtml 回调链三层残留不得回来 ──────────
// 上一刀删了 `agentChatPanel.dropdowns.ts` 的渲染方法（唯一使用方）后，
// pane 实现 / base 字段 / IChatPanel 接口里的 5 个回调全成了死链，本轮整体退役。
// `nativeIpcBridge` 仍在 extractDocumentText 使用 ⇒ 不在禁串里。
const CONFIGHTML_CALLBACK_FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts': [
		'onGetConfigHtmlCfg:', 'onEnsureConfigHtmlServer:', 'UrlPreviewEditorInput', 'buildEnsureSpec',
	],
	'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts': [
		'_onGetConfigHtmlCfg?', 'ConfigHtmlCfg',
	],
	'src/vs/sessions/browser/agentChat/iChatPanel.ts': [
		'onGetConfigHtmlCfg?', 'ConfigHtmlCfg',
	],
};
let callbackIssues = 0;
for (const [rel, needles] of Object.entries(CONFIGHTML_CALLBACK_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现 ConfigHtml 回调链残留 '${needle}'`); callbackIssues += 1; }
	}
}
if (callbackIssues === 0) { ok('ConfigHtml 回调链（pane / base / IChatPanel 三层）已整体退役'); }

// ── ⑬ 移除 config.html：Agent 设置页的 ConfigHtml 页签不得重建 ────────
// 2026-11-07 第八刀：删掉连续 348 行的字段 + 11 个专属方法，以及 TabId / TABS /
// 三处调用 / 两处刷新 / configHtmlConfig import；两个只服务该页签的构造注入改成
// `_` 前缀普通参数（保留 DI 装饰器与位置签名）。删除前后都跑过方法名边界断言。
const SETTINGS_FILE = 'src/vs/sessions/contrib/agentStudio/browser/agentSettingsEditorPane.ts';
const settingsSrc = readFileSync(join(ROOT, SETTINGS_FILE), 'utf8');
let settingsIssues = 0;
for (const needle of [
	'_buildConfigHtmlTab(', '_fillConfigHtmlTab(', '_openConfigHtmlPreview(',
	"id: 'confightml'", 'configHtmlConfig.js', 'private _configHtml',
]) {
	if (settingsSrc.includes(needle)) { fail(`${SETTINGS_FILE} 又出现 ConfigHtml 页签残留 '${needle}'`); settingsIssues += 1; }
}
if (settingsIssues === 0) { ok('Agent 设置页 ConfigHtml 页签（348 行 + 8 处分散点）已整体退役'); }

// ── ⑭ 移除 config.html：商城安装侧不再落盘 config.html ───────────────
// 2026-11-07 第九刀：`vssaros-marketplace/lib/installers.js` 的旧包兼容逻辑
// （files.configHtml / htmlContent → config.html）已删除；目录镜像包自带的
// config.html 仍原样安装 ⇒ 旧包兼容不破。守卫 ⑨ 断言已反向。
const MP_INSTALLERS = 'dsh-plugins/vssaros-marketplace/lib/installers.js';
const mpSrc = readFileSync(join(ROOT, MP_INSTALLERS), 'utf8');
let mpIssues = 0;
for (const needle of [
	"out.push({ path: 'config.html'", 'bundleFiles.configHtml',
	"if (out.every(f => f.path !== 'config.html')) {",
]) {
	if (mpSrc.includes(needle)) { fail(`${MP_INSTALLERS} 又出现 config.html 落盘逻辑 '${needle}'`); mpIssues += 1; }
}
const MP_CHECK = 'dsh-plugins/vssaros-marketplace/test/run-marketplace-installer-check.mjs';
const mpCheckSrc = readFileSync(join(ROOT, MP_CHECK), 'utf8');
for (const needle of ['不再落成 config.html', "!fs.existsSync(path.join(r2.targetDir, 'config.html'))"]) {
	if (!mpCheckSrc.includes(needle)) { fail(`${MP_CHECK} 缺少退役断言 '${needle}'`); mpIssues += 1; }
}
if (mpIssues === 0) { ok('商城安装侧已停止落盘 config.html（旧包文件仍原样兼容）'); }

// ── ⑮ 移除 config.html：IDE 侧 AgentInstaller 不再写入/打包 config.html ──
// 2026-11-07 第十刀：删掉 install() 里从 agent.json files.* / manifest.htmlFiles
// 生成 config.html 的整段、preparePack() 里收集 config.html + 打包 html/ 与 config/
// 目录的整段、exportData 的 4 个 HTML 字段与 agent.configHtml、以及随之成为死代码的
// _copyDirectory。**保留** installFromAgentMd 对目录镜像包自带 config.html 的原样搬运
// （旧包兼容不破，与上一刀 dsh 商城安装侧同一策略）。
const IDE_INSTALLER = 'src/vs/sessions/contrib/agentStudio/browser/installers/agentInstaller.ts';
const ideInstallerSrc = readFileSync(join(ROOT, IDE_INSTALLER), 'utf8');
let installerIssues = 0;
for (const needle of [
	'const configHtmlUri =', 'exportData.files?.htmlContent', 'exportData.files?.configHtml',
	'htmlFiles: htmlFilesManifest', 'configMdContent', 'private async _copyDirectory(',
	'configHtml: agent.configHtml,',
]) {
	if (ideInstallerSrc.includes(needle)) { fail(`${IDE_INSTALLER} 又出现 config.html 打包/安装残留 '${needle}'`); installerIssues += 1; }
}
if (!ideInstallerSrc.includes('installFromAgentMd 原样搬运')) {
	fail(`${IDE_INSTALLER} 缺少「镜像包原样搬运」兼容说明`); installerIssues += 1;
}
if (installerIssues === 0) { ok('IDE AgentInstaller 已停止写入/打包 config.html（镜像包兼容保留）'); }

// ── ⑯ 移除 config.html：configHtmlConfig.ts 已删除，通用工具迁到 nativeBridge ──
// 该文件 15 个 config.html 专属导出在 IDE 侧 UI 全部退役后零消费者；仅有的两个
// 通用工具 nodeExecPath / nativeIpcBridge 外提到 common/nativeBridge.ts，4 个生产
// 引用方改指新文件。这条判据同时防止「重建旧文件」与「把 import 抄回去」。
const NATIVE_BRIDGE = 'src/vs/sessions/contrib/agentStudio/common/nativeBridge.ts';
let nativeBridgeIssues = 0;
if (!existsSync(join(ROOT, NATIVE_BRIDGE))) {
	fail(`通用工具模块缺失：${NATIVE_BRIDGE}`); nativeBridgeIssues += 1;
} else {
	const nb = readFileSync(join(ROOT, NATIVE_BRIDGE), 'utf8');
	for (const needle of ['export function nodeExecPath(', 'export function nativeIpcBridge(']) {
		if (!nb.includes(needle)) { fail(`${NATIVE_BRIDGE} 缺少 ${needle}`); nativeBridgeIssues += 1; }
	}
}
for (const rel of [
	'src/vs/sessions/contrib/agentStudio/browser/knowledge/feishuSyncCore.ts',
	'src/vs/sessions/contrib/agentStudio/browser/knowledge/kbVaultFs.ts',
	'src/vs/sessions/contrib/agentStudio/browser/larkCliService.ts',
	'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts',
]) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	if (text.includes('configHtmlConfig.js') || !text.includes('nativeBridge.js')) {
		fail(`${rel} 的通用工具 import 未指向 nativeBridge.js`); nativeBridgeIssues += 1;
	}
}
if (nativeBridgeIssues === 0) { ok('configHtmlConfig 已删除，通用工具外提到 nativeBridge.ts'); }

// ── ⑰ 移除 config.html：configHtmlService 瘦身第一批不得回退 ────────
// 2026-11-07 第十二刀：删 kv 存储组 / handleRunTerminal / htmlGenerate 组 +
// 三个模块级常量函数 + 接口 6 个成员；**保留** getHtml 渲染管线、
// setActiveAgentSession / resolveModelWriteConfirm / onDidRequestChatSend 等
// 仍被主聊天复用的活链。门禁 ⑤ 的接线断言已改钉 sarosPocket。
const SVC_FILE = 'src/vs/sessions/contrib/agentStudio/browser/configHtmlService.ts';
const IFACE_SVC_FILE = 'src/vs/sessions/common/agentStudioService.ts';
const deadSymbols = [
	'kvGet(', 'kvSet(', 'kvDelete(', 'kvList(', 'handleRunTerminal(', 'htmlGenerate(',
	'_resolveKvUri', 'EMIT_HTML_TOOL', 'CONFIGHTML_SYSTEM_PROMPT', 'getDshSessionLauncher',
];
let svcIssues = 0;
for (const rel of [SVC_FILE, IFACE_SVC_FILE]) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of deadSymbols) {
		if (text.includes(needle)) { fail(`${rel} 又出现 config.html 死代码 '${needle}'`); svcIssues += 1; }
	}
}
const svcSrc = readFileSync(join(ROOT, SVC_FILE), 'utf8');
for (const needle of ['getHtml(', 'setActiveAgentSession(', '_renderInternal(']) {
	if (!svcSrc.includes(needle)) { fail(`${SVC_FILE} 缺少仍在线的活链 '${needle}'`); svcIssues += 1; }
}
if (svcIssues === 0) { ok('configHtmlService 瘦身完成（死代码退役，主聊天活链保留）'); }

// ── ⑱ 移除 config.html：imgui 提交链（永不 fire 的死闭环）不得回来 ────
// `handleHtmlEvent` / `requestChatSend` 全仓零调用方（唯一触发源 confightml.*
// 协议与预览 iframe 已删）⇒ `onDidRequestChatSend` 事件永不 fire。整条链包括
// 服务侧 269 行 + Emitter、controller 的 73 行订阅、接口 3 个成员一并退役。
// 保留 getHtml / setActiveAgentSession / resolveModelWriteConfirm 等活链。
const IMGUI_FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/browser/configHtmlService.ts': [
		'onDidRequestChatSend', 'handleHtmlEvent(', 'requestChatSend(', '_handleImguiSubmit(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts': [
		'onDidRequestChatSend(', 'this._activeChatAgentSessionId',
	],
	'src/vs/sessions/common/agentStudioService.ts': [
		'onDidRequestChatSend', 'requestChatSend(', 'handleHtmlEvent(',
	],
};
let imguiIssues = 0;
for (const [rel, needles] of Object.entries(IMGUI_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现 imgui 死链 '${needle}'`); imguiIssues += 1; }
	}
}
if (imguiIssues === 0) { ok('imgui→chat.send 死闭环已整体退役（服务 / controller / 接口三层）'); }

// ── ⑲ 移除 config.html：模型写确认死闭环不得回来 ────────────────────
// fire 源 `_confirmModelWrite` 已随 config.html 移除 ⇒ 事件永不 fire，
// controller 的确认卡片订阅与 resolve 调用是死闭环；三层已整条退役。
const MODEL_WRITE_FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/browser/configHtmlService.ts': [
		'onDidRequestModelWriteConfirm', 'resolveModelWriteConfirm(', '_pendingModelWriteConfirms',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts': [
		'onDidRequestModelWriteConfirm', 'resolveModelWriteConfirm(',
	],
	'src/vs/sessions/common/agentStudioService.ts': [
		'onDidRequestModelWriteConfirm', 'resolveModelWriteConfirm(',
	],
};
let mwIssues = 0;
for (const [rel, needles] of Object.entries(MODEL_WRITE_FORBIDDEN)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (text.includes(needle)) { fail(`${rel} 又出现模型写确认死链 '${needle}'`); mwIssues += 1; }
	}
}
if (mwIssues === 0) { ok('config.html 模型写确认死闭环已整体退役'); }

// ── ⑳ 主线补能力：后台回合支持调用方覆盖 cwd ─────────────────────────
// 收口最后 4 个 sendMessage 的前置条件之一（worktree 隔离 / 节点级 cwd）。
// 桥侧 `runs.run` 本来就消费 cwd，只是 launcher 不允许调用方覆盖 ⇒ 本刀形成闭环。
const CWD_CAPABILITY = {
	'src/vs/sessions/contrib/dshHarness/common/dshSessionLauncherCore.ts': [
		'options.cwd?.trim() || cwd', 'readonly cwd?: string',
	],
	'src/vs/sessions/common/dshSessionLauncher.ts': ['readonly cwd?: string'],
	'src/vs/sessions/contrib/dshHarness/test/common/dshSessionLauncher.test.ts': [
		'toSessionRunArgs：调用方可覆盖 cwd',
	],
};
let cwdIssues = 0;
for (const [rel, needles] of Object.entries(CWD_CAPABILITY)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (!text.includes(needle)) { fail(`${rel} 缺少 cwd 覆盖能力 '${needle}'`); cwdIssues += 1; }
	}
}
if (cwdIssues === 0) { ok('后台回合已支持调用方覆盖 cwd（worktree 隔离前置能力）'); }

// ── ㉑ P4 文档：规划档案保留原文，但「实现状态」注记不得丢失 ────────
// 历史设计档案不改写（改了等于丢决策依据），只在明显过时的现状/规划段落后
// 追加状态注记。这两条判据防止有人清理文档时把注记一起删掉。
for (const [rel, needle] of [
	['doc/dsh-plugin-paradigm-refactor-plan.html', '实现状态（2026-11-07，规划后的实际落地）'],
	['doc/dsh-foundation-refactor-plan.html', '实现状态（2026-11-07）'],
]) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	if (!text.includes(needle)) { fail(`${rel} 缺少 P4 实现状态注记`); }
}
ok('P4 规划档案保留原文并附实现状态注记');

// ── ㉒ 主线补能力：后台回合内嵌附件不得被静默丢弃 ──────────────────
// 4 个 sendMessage 里 taskInlineData 是独立附件数组，换 runTurn 时最易丢。
// 本判据既钉住三层接线，也直接 import 桥侧纯函数验证序列化行为。
const ATTACHMENT_WIRING = {
	'src/vs/sessions/contrib/dshHarness/common/dshBridgeProtocol.ts': [
		'export interface IBridgeTurnAttachment', 'readonly attachments?: readonly IBridgeTurnAttachment[]',
	],
	'src/vs/sessions/contrib/dshHarness/common/dshSessionLauncherCore.ts': ['attachments: options.attachments'],
	'src/vs/sessions/common/dshSessionLauncher.ts': ['readonly attachments?: readonly'],
	'dsh-plugins/vssaros-bridge/lib/runs.js': ['export function buildPromptContent(', 'content: buildPromptContent(prompt, attachments)'],
};
for (const [rel, needles] of Object.entries(ATTACHMENT_WIRING)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (!text.includes(needle)) { fail(`${rel} 缺少附件接线 '${needle}'`); }
	}
}
// runs.js 是零 import 的纯函数模块 ⇒ 可安全动态导入做行为断言
const { buildPromptContent } = await import('./vssaros-bridge/lib/runs.js');
const plain = buildPromptContent('hi', undefined);
if (plain.length !== 1 || plain[0].type !== 'text' || plain[0].text !== 'hi') {
	fail('buildPromptContent 无附件时必须与改造前逐字一致（单条 text）');
}
const mixed = buildPromptContent('hi', [{ name: 'a.md', text: 'body' }, { name: '', text: '' }, null]);
if (mixed.length !== 2 || !mixed[1].text.includes('[attachment: a.md]') || !mixed[1].text.includes('body')) {
	fail('buildPromptContent 必须序列化有效附件并跳过无效项');
}
ok('后台回合内嵌附件已打通（协议 → launcher → 桥侧 text 块）');

// ── ㉓ 主线补能力：后台回合支持 AbortSignal 取消 ────────────────────
// 桥侧 session.cancel / runs.cancel 早已落地，缺的只是 launcher 暴露取消入口。
// 4 个 sendMessage 里 workflowExecutionService 的 Promise.race 超时需要这能力。
const CANCEL_WIRING = {
	'src/vs/sessions/common/dshSessionLauncher.ts': ['readonly signal?: AbortSignal'],
	'src/vs/sessions/contrib/dshHarness/electron-browser/dshSessionLauncher.ts': [
		'this.dsh.cancelSession(', "removeEventListener('abort'", 'options.signal?.addEventListener(',
	],
	'src/vs/sessions/contrib/dshHarness/test/common/dshSessionLauncher.test.ts': [
		'取消监听必须在 finally 里移除',
	],
};
for (const [rel, needles] of Object.entries(CANCEL_WIRING)) {
	const text = readFileSync(join(ROOT, rel), 'utf8');
	for (const needle of needles) {
		if (!text.includes(needle)) { fail(`${rel} 缺少取消接线 '${needle}'`); }
	}
}
ok('后台回合已支持 AbortSignal 取消（控制桥 session.cancel）');

// ── ⑬ ★ 2026-11-09：IDE 侧创建 Agent 已下线，唯一写口在 dsh 侧 ──────────
// 用户拍板「IDE 侧不要有创建功能，都改到 dsh 侧」。不造 IDE→dsh 转发通道：
//   页面桥明确「写入、执行类能力不走页面桥」，agents 模块也无承载页（view.kind='none'）。
// 三条判据：① createAgent 只拒绝、不写盘；② 退役残留调用点只许减；
//   ③ 用户能点到的入口（命令 / 商城安装 / 看板自动补齐）不许复活。
{
	const SVC_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts';
	const svc = readFileSync(join(ROOT, SVC_REL), 'utf8');
	const at = svc.indexOf('async createAgent(');
	const end = at >= 0 ? svc.indexOf('\n\t}', at) : -1;
	const body = at >= 0 && end > at ? svc.slice(at, end) : '';
	const WRITE_CALLS = ['createFolder(', 'writeFile(', '_writeAgentMd(', 'upsertAgentBinding(', 'return agent;'];
	const revived = WRITE_CALLS.filter(n => body.includes(n));
	if (at < 0 || revived.length || !/IDE 侧已不提供创建 Agent 能力/.test(body)) {
		fail(`IDE 侧 createAgent 又具备写盘能力（${revived.join('、') || '缺明确拒绝'}）⇒ 创建 Bot 必须统一走 dsh 侧 Bots 页签`);
	} else {
		ok('IDE 侧 createAgent 只拒绝、不写盘（唯一写口 = dsh /x/agents/api/agents）');
	}
	// 已退役/不可达路径里还留着 createAgent 调用（旧新建页、复制为、webview 桥、new_agent 工具、
	// installer）。它们一旦被调用只会拿到明确拒绝 ⇒ 用上限钉「只许继续减」，不强求一轮删干净。
	const MAX_CREATE_CALLS = 6;
	const createCalls = countCalls(/\.createAgent\s*\(/);
	if (createCalls > MAX_CREATE_CALLS) {
		fail(`IDE 侧 createAgent 调用点回升到 ${createCalls}（上限 ${MAX_CREATE_CALLS}）⇒ 有创建入口被抄回来`);
	} else {
		ok(`IDE 侧 createAgent 调用点 ${createCalls} ≤ 上限 ${MAX_CREATE_CALLS}（只许继续减）`);
	}
	const ENTRY_FORBIDDEN = {
		'src/vs/sessions/contrib/agentStudio/browser/agentMarketEditorPane.ts': ['createAgent('],
		'src/vs/sessions/contrib/agentStudio/browser/taskOrchestrationService.ts': ['createAgent('],
		'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts': [
			"DshPluginPageEditorInput.getOrCreate('agentStudio.presetAgent'",
		],
	};
	let entryIssues = 0;
	for (const [rel, needles] of Object.entries(ENTRY_FORBIDDEN)) {
		const text = readFileSync(join(ROOT, rel), 'utf8');
		for (const needle of needles) {
			if (text.includes(needle)) { fail(`${rel} 又出现 IDE 侧创建入口残留 '${needle}'`); entryIssues += 1; }
		}
	}
	if (entryIssues === 0) { ok('IDE 侧用户可点的创建入口（命令 / 商城安装 / 看板自动补齐）已下线'); }
}

console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ IDE agent loop 退役状态只许继续收敛');
process.exit(failed ? 1 : 0);
