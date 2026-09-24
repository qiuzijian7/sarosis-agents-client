/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书 CLI（Channel 绑定页签新增能力，2026-09-23）的守卫用例。
 *
 * 分两类：
 *   · **纯逻辑**：状态徽章四态、版本比较、群列表解析 —— 可穷举的真值表；
 *   · **接线（源码/CSS 断言）**：`agentSettingsEditorPane.ts` 是 DOM 文件，分片测试 worker
 *     装不了 DOM stub（见 `channelIcons.test.ts` 头注释），所以对"UI 是否真的挂上了"
 *     用源码断言兜底：少一个 import / 少一次 appendChild，用例就会红。
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
	LARK_CLI_INSTALL_COMMAND,
	LARK_CLI_PACKAGE,
	isNewerVersion,
	larkCliStatusBadge,
	parseVersion,
	larkCliErrorText,
	parseLarkCliJson,
	type ILarkCliStatus,
} from '../../common/larkCli.js';
import { parseFeishuChatList } from '../../browser/feishuChatList.js';

const repoRoot = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentSettingsEditorPane.ts';
const CSS_REL = 'src/vs/sessions/contrib/agentStudio/browser/media/agentSettingsEditorPane.css';
const APP_REL = 'src/vs/code/electron-main/app.ts';
const CHANNEL_REL = 'src/vs/sessions/contrib/agentStudio/electron-main/larkCliChannel.ts';
const SERVICE_REL = 'src/vs/sessions/contrib/agentStudio/browser/larkCliService.ts';
const COMMON_REL = 'src/vs/sessions/contrib/agentStudio/common/larkCli.ts';

// ─── 纯逻辑 ────────────────────────────────────────────────────────────────

suite('飞书 CLI · 状态徽章四态', () => {
	test('桥不可用 → 灰「不可用」（不是红「未安装」——避免把宿主限制说成用户问题）', () => {
		const badge = larkCliStatusBadge({ available: false, installed: false, error: 'IPC 桥不可用' });
		assert.strictEqual(badge.tone, 'dim');
		assert.strictEqual(badge.label, '不可用');
		assert.deepStrictEqual(larkCliStatusBadge(undefined), { label: '不可用', tone: 'dim' });
	});

	test('可用但未安装 → 红「未安装」', () => {
		assert.deepStrictEqual(larkCliStatusBadge({ available: true, installed: false }), { label: '未安装', tone: 'bad' });
	});

	test('已安装且与 npm 最新一致 → 绿「已安装 x.y.z」', () => {
		const s: ILarkCliStatus = { available: true, installed: true, version: '0.4.2', latestVersion: '0.4.2' };
		assert.deepStrictEqual(larkCliStatusBadge(s), { label: '已安装 0.4.2', tone: 'ok' });
	});

	test('已安装但有更新 → 黄「可升级 …」；最新版本取不到时**不得**误报可升级', () => {
		const newer: ILarkCliStatus = { available: true, installed: true, version: '0.4.2', latestVersion: '0.5.0' };
		assert.deepStrictEqual(larkCliStatusBadge(newer), { label: '可升级 0.5.0', tone: 'warn' });
		// npm 查询失败（离线）⇒ latestVersion undefined ⇒ 仍是 ok
		const offline: ILarkCliStatus = { available: true, installed: true, version: '0.4.2' };
		assert.strictEqual(larkCliStatusBadge(offline).tone, 'ok');
	});
});

suite('飞书 CLI · 版本比较', () => {
	test('解析任意形态的版本串', () => {
		assert.deepStrictEqual(parseVersion('0.4.2'), [0, 4, 2]);
		assert.deepStrictEqual(parseVersion('v0.4.2'), [0, 4, 2]);
		assert.deepStrictEqual(parseVersion('@larksuite/cli@1.2.3'), [1, 2, 3]);
		assert.strictEqual(parseVersion('unknown'), undefined);
		assert.strictEqual(parseVersion(undefined), undefined);
	});

	test('逐位比较（含跨位：0.9.9 < 0.10.0）', () => {
		assert.strictEqual(isNewerVersion('0.4.2', '0.4.3'), true);
		assert.strictEqual(isNewerVersion('0.4.2', '0.4.2'), false);
		assert.strictEqual(isNewerVersion('0.5.0', '0.4.9'), false);
		assert.strictEqual(isNewerVersion('0.9.9', '0.10.0'), true);
		assert.strictEqual(isNewerVersion('1.0.0', '2.0.0'), true);
	});

	test('任一版本缺失/不可解析 → false（宁可不提示，也不要假提示）', () => {
		assert.strictEqual(isNewerVersion(undefined, '0.5.0'), false);
		assert.strictEqual(isNewerVersion('0.4.2', undefined), false);
		assert.strictEqual(isNewerVersion('dev', '0.5.0'), false);
	});
});

suite('飞书 CLI · 群列表解析（获取 chat_id）', () => {
	test('正常响应：取 chat_id / 名称 / 人数', () => {
		const chats = parseFeishuChatList({
			code: 0,
			data: { items: [{ chat_id: 'oc_1', name: '产品群', user_count: 12 }, { chat_id: 'oc_2', name: '值班群' }] },
		});
		assert.deepStrictEqual(chats, [
			{ chatId: 'oc_1', name: '产品群', memberCount: 12 },
			{ chatId: 'oc_2', name: '值班群', memberCount: undefined },
		]);
	});

	test('缺 data.items / 条目缺 chat_id → 跳过而不是抛错（拿得到号优先）', () => {
		assert.deepStrictEqual(parseFeishuChatList({ code: 0 }), []);
		assert.deepStrictEqual(parseFeishuChatList(undefined), []);
		assert.deepStrictEqual(parseFeishuChatList({ data: { items: [{ name: '无 id' }, { chat_id: '  ' }] } }), []);
	});

	test('群名缺失 → 占位「（未命名群）」（不能让 chat_id 因为没名字而不显示）', () => {
		const chats = parseFeishuChatList({ data: { items: [{ chat_id: 'oc_9' }, { chat_id: 'oc_8', name: '   ' }] } });
		assert.deepStrictEqual(chats.map(c => c.name), ['（未命名群）', '（未命名群）']);
		assert.deepStrictEqual(chats.map(c => c.chatId), ['oc_9', 'oc_8']);
	});
});

// ─── 接线守卫（源码/CSS 断言）─────────────────────────────────────────────

suite('飞书 CLI · 接线守卫', () => {
	test('★★★ 主进程通道注册在 app.ts（否则渲染层 invoke 永远无响应）', () => {
		const app = read(APP_REL);
		assert.ok(app.includes("from '../../sessions/contrib/agentStudio/electron-main/larkCliChannel.js'"),
			'app.ts 必须 import LarkCliChannel ✓');
		assert.ok(/this\._register\(new LarkCliChannel\(/.test(app),
			'★ app.ts 必须注册 LarkCliChannel —— 漏了这一步界面会「点了没反应」✗✓');
	});

	test('★★ 通道暴露 status / install 两个 handler，且用 validatedIpcMain（channel 名须 vscode: 前缀）', () => {
		const channel = read(CHANNEL_REL);
		// ★ 2026-09-23：通道名改为**常量**（单一口径，定义在 common/larkCli.ts，供主进程与渲染侧共用）
		//   ⇒ 断言相应改成「用常量 + 常量值正确」。这比原先写死字面量**更强**：
		//     「通道名写错」这种情况原先无人守（消费端用常量、注册端用常量，写错就一起错），
		//     现在由下面三条把常量值本身也钉住。
		assert.ok(channel.includes('validatedIpcMain.handle(LARK_CLI_STATUS_CHANNEL'), '必须有 status handler ✓');
		assert.ok(channel.includes('validatedIpcMain.handle(LARK_CLI_INSTALL_CHANNEL'), '必须有 install handler ✓');
		assert.ok(channel.includes('validatedIpcMain.handle(LARK_CLI_RUN_CHANNEL'),
			'必须有 run handler（2026-09-23 新增：飞书文档 → markdown 导入用）✓');
		const common = read(COMMON_REL);
		assert.ok(common.includes("LARK_CLI_STATUS_CHANNEL = 'vscode:larkCliStatus'"), 'status 常量值必须是 vscode:larkCliStatus ✓');
		assert.ok(common.includes("LARK_CLI_INSTALL_CHANNEL = 'vscode:larkCliInstall'"), 'install 常量值必须是 vscode:larkCliInstall ✓');
		assert.ok(common.includes("LARK_CLI_RUN_CHANNEL = 'vscode:larkCliRun'"), 'run 常量值必须是 vscode:larkCliRun ✓');
		assert.ok(channel.includes('child_process'), '探测/安装必须在主进程用 child_process 执行 ✓');
		assert.ok(!channel.includes('requestService'), 'CLI 通道不依赖 HTTP 出口（自己 spawn）✓');
	});

	test('★★ 渲染层封装永不抛：桥不可用时返回 available:false', () => {
		const svc = read(SERVICE_REL);
		assert.ok(svc.includes('nativeIpcBridge'), '必须用 nativeIpcBridge 取桥（历史坑：写错键名会永远判空）✓');
		assert.ok(/available:\s*false/.test(svc), '★ 桥不可用必须降级为 available:false，而不是抛错打断页签渲染 ✗✓');
	});

	test('★★★ 三个能力都挂进了 Channel 绑定页签（构建 + 渲染两个入口）', () => {
		const pane = read(PANE_REL);
		assert.ok(pane.includes('_buildLarkCliSection()'), '★ 页签构建必须调用 _buildLarkCliSection（漏了 = 界面完全不出现）✗✓');
		assert.ok(pane.includes('group.appendChild(this._buildLarkCliSection())'), '必须挂到飞书渠道分组下 ✓');
		assert.ok(pane.includes('void this._refreshLarkCliStatus(false)'), '★ 切到该页签必须触发状态探测（漏了 = 永远显示「检测中…」）✗✓');
		assert.ok(pane.includes('getLarkCliStatus') && pane.includes('installLarkCli'),
			'① 状态 / 安装必须接上渲染层封装 ✓');
		assert.ok(pane.includes('beginFeishuRegistration') && pane.includes('drawQrToCanvas'),
			'② 创建机器人必须复用已验证的 PersonalAgent 扫码流程 ✓');
		assert.ok(pane.includes('fetchFeishuChats'), '③ 获取 chat_id 必须接上群列表 ✓');
	});

	test('★★ 创建机器人写入的配置键与手工绑定/渠道编辑器一致（同一落点）', () => {
		const pane = read(PANE_REL);
		for (const key of ['sessions.channel.feishu.appId', 'sessions.channel.feishu.appSecret', 'sessions.channel.feishu.enabled']) {
			assert.ok(pane.includes(key), `扫码创建后必须写入 ${key}（否则「创建成功但渠道没生效」）✓`);
		}
	});

	test('★★ 安装命令只有一处定义（避免文档/UI/代码三份口径漂移）', () => {
		assert.ok(LARK_CLI_INSTALL_COMMAND.includes(LARK_CLI_PACKAGE) && LARK_CLI_INSTALL_COMMAND.includes('install'),
			'安装命令应形如 npx @larksuite/cli@latest install ✓');
		const channel = read(CHANNEL_REL);
		assert.ok(channel.includes('LARK_CLI_INSTALL_COMMAND'), '主进程通道必须复用同一常量 ✓');
	});

	test('★ 样式齐备：状态徽章四态 / 命令输出 / 二维码白底 / 群列表', () => {
		const css = read(CSS_REL);
		for (const sel of ['.larkcli-badge', '.larkcli-output', '.larkcli-qr-canvas', '.chatid-item']) {
			assert.ok(css.includes(sel), `CSS 缺少 ${sel} ✓`);
		}
		assert.ok(/\.larkcli-badge\.tone-(ok|warn|bad|dim)/.test(css) || css.includes('.larkcli-badge.tone-ok'),
			'徽章四态样式必须齐 ✓');
		assert.ok(/\.larkcli-qr-canvas\s*\{[^}]*background:\s*#ffffff/.test(css),
			'★ 二维码画布必须是白底（深色主题下浅底才可扫）✗✓');
	});
});

// ─── 聊天框 Channel 绑定页签（2026-09-23 修正投递点）─────────────────────────
//
// ⚠ 背景：聊天框里打开的「Agent 配置 → Channel 绑定」**不是** AgentSettingsEditorPane，
//   而是 `sessions/browser/agentChat/agentChatPanel*`（class 前缀 `chat-`）。
//   第一版把功能只做在编辑器面板上，用户截图里自然看不到 ⇒ 这组用例锁死聊天框这条链。

const CHAT_BASE_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';
const CHAT_DOWNLOADS_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.dropdowns.ts';
const CHAT_CSS_REL = 'src/vs/sessions/browser/agentChat/media/agentChat.css';
const HOST_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';

suite('飞书 CLI · 聊天框 Channel 绑定页签接线守卫', () => {
	test('★★★ base.ts：4 个 hook 既声明为 opts 成员，又接到实例字段（漏一个 = 该能力永远灰着）', () => {
		const base = read(CHAT_BASE_REL);
		for (const hook of ['onGetLarkCliStatus', 'onInstallLarkCli', 'onListFeishuChats', 'onCreateFeishuBot']) {
			assert.ok(base.includes(`${hook}?:`), `opts 类型必须声明 ${hook} ✗✓`);
			assert.ok(base.includes(`this._${hook} = opts.${hook};`), `构造必须把 ${hook} 接到字段 ✗✓`);
			assert.ok(base.includes(`protected readonly _${hook}?`), `必须声明受保护字段 _${hook} ✗✓`);
		}
	});

	test('★★★ host（nativeChatEditorPane.ts）注入四个实现，且复用既有那套链路', () => {
		const host = read(HOST_REL);
		for (const hook of ['onGetLarkCliStatus:', 'onInstallLarkCli:', 'onListFeishuChats:', 'onCreateFeishuBot:']) {
			assert.ok(host.includes(hook), `host 必须注入 ${hook} ✗✓`);
		}
		assert.ok(host.includes('getLarkCliStatus') && host.includes('installLarkCli'),
			'CLI 状态/安装必须走 larkCliService（主进程探测）✓');
		assert.ok(host.includes('fetchFeishuChats'), '群列表必须走 feishuChatList（渠道凭证 + 主进程出口）✓');
		assert.ok(host.includes('beginFeishuRegistration') && host.includes('pollFeishuRegistration'),
			'扫码必须复用 PersonalAgent device-flow（与渠道编辑器「扫码绑定」同一协议）✓');
		assert.ok(host.includes("toDataURL('image/png')"),
			'★ 二维码必须以 PNG data URL 回推面板（面板不依赖 QR 库）✗✓');
		assert.ok(host.includes('createMainProcessRequestService'),
			'★ 必须优先主进程 HTTP 出口（渲染进程直连飞书 OpenAPI 会被 CORS 拦）✗✓');
		for (const key of ['sessions.channel.feishu.appId', 'sessions.channel.feishu.appSecret', 'sessions.channel.feishu.enabled']) {
			assert.ok(host.includes(key), `扫码创建后必须写入 ${key}（与手工绑定同一落点）✓`);
		}
	});

	test('★★★ dropdowns.ts：页签渲染该区块（在群聊绑定之后）且渲染后立即探测一次', () => {
		const dd = read(CHAT_DOWNLOADS_REL);
		assert.ok(dd.includes('this._renderLarkCliSection(group, input, renderList)'),
			'★ _renderSettingsChannelTab 必须调用 _renderLarkCliSection（漏了 = 界面完全不出现）✗✓');
		assert.ok(/private _renderLarkCliSection\(group: HTMLElement, chatIdInput: HTMLInputElement, onBindingsChanged: \(\) => void\)/.test(dd),
			'★ 方法必须拿到 chat_id 输入框（「填入」要写进去）与绑定刷新回调 ✗✓');
		assert.ok(dd.includes('void refresh();'),
			'★ 区块渲染后必须探测一次状态（否则徽章永远停在「检测中…」）✗✓');
		assert.ok(dd.includes('chatIdInput.value = chat.chatId'),
			'「填入」必须真的写进输入框 ✓');
	});

	test('★ 聊天框样式齐备（chat-larkcli-* / chat-chatid-*），二维码图片白底', () => {
		const css = read(CHAT_CSS_REL);
		for (const sel of ['.chat-larkcli-badge', '.chat-larkcli-output', '.chat-larkcli-qr-img', '.chat-chatid-item']) {
			assert.ok(css.includes(sel), `agentChat.css 缺少 ${sel} ✗✓`);
		}
		assert.ok(/\.chat-larkcli-qr-img\s*\{[^}]*background:\s*#ffffff/.test(css),
			'★ 二维码必须白底（深色主题下浅底才可扫）✗✓');
	});

	test('★★★ 分层约束：面板不 import contrib/agentStudio 的 browser 实现（只走 common 契约 + host 回调）', () => {
		const dd = read(CHAT_DOWNLOADS_REL);
		const base = read(CHAT_BASE_REL);
		for (const [name, src] of [['agentChatPanel.dropdowns.ts', dd], ['agentChatPanel.base.ts', base]] as const) {
			assert.ok(!src.includes('contrib/agentStudio/browser/'),
				`${name} 不得 import contrib/agentStudio/browser/**（会破坏 sessions/browser 的分层）✗✓`);
		}
		assert.ok(base.includes('contrib/agentStudio/common/larkCli.js'),
			'契约类型必须来自 common 层（先例：configHtmlConfig.js）✓');
		assert.ok(dd.includes('contrib/agentStudio/common/larkCli.js'),
			'纯函数（larkCliStatusBadge）与命令常量必须来自 common 层 ✓');
	});
});

// ─── 两处样式一致性（2026-09-23 用户要求：聊天框与 editorpane 的该区块要一样）────
//
// 为什么要用「数值比对」而不是人工看：两处是**两份独立 CSS**（agentChat.css / agentSettingsEditorPane.css），
// 一旦有人只改一边就会悄悄漂移。这里把成对类的关键属性钉成相等。

const PANE_CSS_REL = 'src/vs/sessions/contrib/agentStudio/browser/media/agentSettingsEditorPane.css';

/**
 * 取某选择器的声明块（首个匹配）→ { prop: value }。
 *
 * ★ 必须先剥离 `/* … *​/` 注释：本仓 CSS 里普遍带大段说明注释，
 *   注释里出现「：」或 `;` 会把「取第一个冒号」的朴素解析带偏
 *   （实测：块内注释含全角冒号 ⇒ prop 变成 "注释+font-family"，查 font-family 永远取不到）。
 */
function cssBlock(css: string, selector: string): Record<string, string> {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = new RegExp(`(?:^|[\\n\\r}])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(clean);
	if (!m) { return {}; }
	const out: Record<string, string> = {};
	for (const decl of m[1].split(';')) {
		const i = decl.indexOf(':');
		if (i > 0) { out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim(); }
	}
	return out;
}

suite('飞书 CLI · 两处样式一致（聊天框 ↔ editorpane，逐值比对）', () => {
	const paneCss = read(PANE_CSS_REL);
	const chatCss = read(CHAT_CSS_REL);

	/** [pane 选择器, 聊天框选择器, 必须逐值相等的属性] */
	const GEOMETRY_PAIRS: Array<[string, string, string[]]> = [
		['.larkcli-badge', '.chat-larkcli-badge', ['display', 'align-items', 'padding', 'border-radius', 'font-size', 'line-height', 'white-space']],
		['.larkcli-detail', '.chat-larkcli-detail', ['flex', 'min-width', 'font-size', 'white-space']],
		['.larkcli-output', '.chat-larkcli-output', ['margin', 'padding', 'max-height', 'font-size', 'line-height', 'border-radius', 'white-space', 'overflow-wrap']],
		['.larkcli-qr', '.chat-larkcli-qr', ['display', 'flex-direction', 'align-items', 'gap', 'margin', 'padding', 'border', 'border-radius']],
		['.larkcli-qr-status', '.chat-larkcli-qr-status', ['font-size', 'text-align']],
		['.chatid-item', '.chat-chatid-item', ['display', 'align-items', 'gap', 'padding', 'border', 'border-radius']],
		['.chatid-item-info', '.chat-chatid-info', ['flex', 'min-width', 'display', 'flex-direction', 'gap']],
		['.chatid-item-name', '.chat-chatid-name', ['font-size']],
		['.chatid-item-id', '.chat-chatid-id', ['font-family', 'font-size']],
		['.binding-add-row', '.chat-larkcli-row', ['display', 'gap', 'margin-bottom']],
		['.agent-settings-btn', '.chat-settings-btn', ['display', 'align-items', 'gap', 'padding', 'font-size', 'border', 'border-radius', 'cursor']],
		['.agent-settings-btn.primary', '.chat-settings-btn.primary', ['background', 'color', 'border-color']],
	];

	for (const [paneSel, chatSel, props] of GEOMETRY_PAIRS) {
		test(`★ ${chatSel} 的几何/字号与 ${paneSel} 逐值相同`, () => {
			const pane = cssBlock(paneCss, paneSel);
			const chat = cssBlock(chatCss, chatSel);
			for (const prop of props) {
				assert.ok(pane[prop] !== undefined, `pane 侧 ${paneSel} 没有 ${prop}（守卫口径需与实现同步）`);
				assert.ok(chat[prop] !== undefined, `聊天框侧 ${chatSel} 没有 ${prop}（守卫口径需与实现同步）`);
				assert.strictEqual(chat[prop], pane[prop],
					`${chatSel} 的 ${prop} 应为 "${pane[prop]}"（与 pane 一致），实际 "${chat[prop]}" ✗✓`);
			}
		});
	}

	test('★★ 行容器都不设 align-items（pane 靠默认 stretch 撑起徽章/按钮高度），按钮必须继承字体', () => {
		assert.strictEqual(cssBlock(paneCss, '.binding-add-row')['align-items'], undefined,
			'pane 侧 .binding-add-row 不设 align-items（默认 stretch）—— 守卫口径需与实现同步');
		assert.strictEqual(cssBlock(chatCss, '.chat-larkcli-row')['align-items'], undefined,
			'★ 聊天框行也不能设 align-items：设 center 会让徽章矮 6px、按钮矮 1px（实测）✗✓');
		assert.strictEqual(cssBlock(chatCss, '.chat-settings-btn')['font-family'], 'inherit',
			'★ 按钮必须 font-family: inherit：pane 的按钮经工作台全局规则继承应用字体，'
			+ '不写会退回 UA 字体（Arial）⇒ 字形与宽度都不同（实测 46px vs 61.3px）✗✓');
	});

	test('★ 颜色族一致（同一 VS Code token，允许聊天框侧保留 --as-* 主题别名）', () => {
		const TOKEN_PAIRS: Array<[string, string, string]> = [
			['.larkcli-badge.tone-dim', '.chat-larkcli-badge.tone-dim', '--vscode-panel-border'],
			['.larkcli-detail', '.chat-larkcli-detail', '--vscode-descriptionForeground'],
			['.larkcli-output', '.chat-larkcli-output', '--vscode-textCodeBlock-background'],
			['.chatid-item', '.chat-chatid-item', '--vscode-input-background'],
			['.chatid-item-name', '.chat-chatid-name', '--vscode-editor-foreground'],
			['.chatid-item-id', '.chat-chatid-id', '--vscode-descriptionForeground'],
		];
		for (const [paneSel, chatSel, token] of TOKEN_PAIRS) {
			const pane = JSON.stringify(cssBlock(paneCss, paneSel));
			const chat = JSON.stringify(cssBlock(chatCss, chatSel));
			assert.ok(pane.includes(token), `pane 侧 ${paneSel} 应引用 ${token}`);
			assert.ok(chat.includes(token), `聊天框侧 ${chatSel} 应引用 ${token}（否则两处配色会漂移）✗✓`);
		}
		const okTones = ['.larkcli-badge.tone-ok', '.chat-larkcli-badge.tone-ok'];
		const paneOk = cssBlock(paneCss, okTones[0]);
		const chatOk = cssBlock(chatCss, okTones[1]);
		assert.strictEqual(chatOk.color, paneOk.color, '「已安装」绿必须同色 ✗✓');
		assert.strictEqual(chatOk['background'], paneOk['background'], '「已安装」绿底必须同色 ✗✓');
	});

	test('★★★ 按钮：CLI 区块/群列表行内**不得**再用 monaco 按钮类（它会 width:100% 撑满行）', () => {
		const dd = read(CHAT_DOWNLOADS_REL);
		// 只看代码行（注释里会解释这个坑、必然提到 monaco-text-button）
		const section = dd.slice(dd.indexOf('_renderLarkCliSection(group: HTMLElement'))
			.split(/\r?\n/).filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
		assert.ok(!section.includes('monaco-text-button'),
			'★ CLI 区块内出现 monaco-text-button ⇒ 群列表行会被撑满、群名/ID 被挤成 0 宽 ✗✓');
		assert.ok(section.includes('$("button.chat-settings-btn")'), '默认按钮必须是 .chat-settings-btn ✓');
		assert.ok(section.includes('$("button.chat-settings-btn.primary")'), '主按钮必须是 .primary ✓');
	});

	test('★★ 群列表行与 editorpane 同款：群名+ID 两行 +「填入」+「绑定到本 Agent」', () => {
		const dd = read(CHAT_DOWNLOADS_REL);
		const section = dd.slice(dd.indexOf('_renderLarkCliSection(group: HTMLElement'));
		for (const bit of ["'填入'", "'绑定到本 Agent'", 'chat-chatid-name', 'chat-chatid-id',
			'this._onAddFeishuBinding?.(chat.chatId)', 'onBindingsChanged()']) {
			assert.ok(section.includes(bit), `CLI 区块缺少 ${bit} ✗✓`);
		}
		// 绑定后刷新绑定列表，但**不**整页重渲染（否则刚拉取的群列表会被清空）
		assert.ok(dd.includes('this._renderLarkCliSection(group, input, renderList)'),
			'★ 必须把 renderList 传进去（绑定后刷新列表、且保留群列表）✗✓');
		assert.ok(!/_renderLarkCliSection[\s\S]{0,120}_renderSettingsChannelTab\(container\)/.test(dd),
			'★ 不得用整页重渲染来刷新（会清掉群列表）✗✓');
	});
});

/**
 * 通用命令执行（2026-09-23）：`docs +fetch` 的 JSON 解析与错误提取。
 *
 * 用例里的 JSON 形态取自**真机实测**（`lark-cli docs +fetch --doc <无效 token>` 的完整输出），
 * 不是凭空构造 —— 这正是「读不到文档」时要给用户看的那条分支。
 */
suite('AgentStudio - larkCli 命令输出解析（飞书文档导入）', () => {

	// 本文件其它用例也不用 `ensureNoDisposablesAreLeakedInTestSuite`（未导入）；
	// 这两个函数是纯字符串处理，不创建 disposable，无需该守卫。

	test('parseLarkCliJson：纯 JSON / 夹带杂项输出 / 非 JSON 三种情形', () => {
		assert.deepStrictEqual(parseLarkCliJson('{"a":1}'), { a: 1 });
		// CLI 前后可能夹带 npm 警告、升级提示等 ⇒ 取首个 { 到末个 }
		assert.deepStrictEqual(parseLarkCliJson('npm warn x\n{"ok":true,"n":2}\nnoise'), { ok: true, n: 2 });
		assert.strictEqual(parseLarkCliJson('完全不是 JSON'), undefined);
		assert.strictEqual(parseLarkCliJson(''), undefined);
	});

	test('larkCliErrorText：无 hint 时退到 message（真机实测的错误形态）', () => {
		const real = JSON.stringify({
			ok: false, identity: 'user',
			error: {
				type: 'api', subtype: 'unknown', code: 3380002,
				message: 'Invalid document_id or document not found. Verify the document_id exists and is accessible.',
				log_id: '2026…176A7D19',
			},
		});
		const text = larkCliErrorText(parseLarkCliJson(real), '');
		assert.ok(text.includes('Invalid document_id or document not found'), '应取到可读 message');
		assert.ok(text.includes('3380002'), '应带上错误码便于排查');
	});

	test('larkCliErrorText：有 hint 时优先用 hint（权限类错误给出可操作建议）', () => {
		const withHint = JSON.stringify({ ok: false, error: { code: 'permission_denied', message: 'denied', hint: '改用 docs +media-preview 预览' } });
		const text = larkCliErrorText(parseLarkCliJson(withHint), '');
		assert.ok(text.includes('改用 docs +media-preview 预览'), 'hint 优先于 message');
		assert.ok(!text.includes('denied') || text.includes('permission_denied'));
	});

	test('larkCliErrorText：拿不到结构化错误时回退 stderr 首行（不返回空字符串）', () => {
		assert.strictEqual(larkCliErrorText(undefined, 'spawn lark-cli ENOENT\ndetails'), 'spawn lark-cli ENOENT');
		assert.strictEqual(larkCliErrorText(undefined, ''), '未知错误');
	});
});
