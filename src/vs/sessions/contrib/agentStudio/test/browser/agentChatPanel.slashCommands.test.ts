/*---------------------------------------------------------------------------------------------
 *  聊天框斜杠命令的回归护栏（2026-09-22 用户需求「增加命令支持，如 /compact」✓）
 *
 *  设计要点（钉住 ✓）：
 *   · 命令是**立即执行**的动作 ✓，与 skill/workflow（插入 chip 组成提示词 ✗）语义不同 ⇒
 *     菜单里必须把命令渲染成 `data-command-id`（**不插 chip** ✗✓）；
 *   · 命令列表由宿主注入 ✓ ⇒ **宿主拿不到执行器就不出现条目** ✗✓（不给出"点了没反应"的死条目 ✓）；
 *   · 输入框打字流**天然可用** ✓：斜杠菜单已拦截 Enter（`_selectSlashMenuItem` ✓）⇒ 不需要改发送路径 ✓。
 *
 *  ⚠ 本文件刻意做**源码/协议级**断言 ✓（与本仓 `assertWired`、Channel 绑定护栏同一风格 ✓）：
 *    面板 DOM 级测试需要 DOM shim ✓，而这里要钉的是"接线与协议"，源码断言更稳更便宜 ✓。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { COMPACTION_METADATA_TYPE } from '../../common/historyCompaction.js';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const COMPOSER = 'src/vs/sessions/browser/agentChat/agentChatPanel.composer.ts';
const BASE = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';
const IFACE = 'src/vs/sessions/browser/agentChat/iChatPanel.ts';
const PANE = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';

suite('聊天框斜杠命令 — 接线与协议护栏 ✓', () => {

	test('★★★ 面板侧三处接线齐备 ✓：契约声明 / 字段声明 / 构造赋值（缺一即静默失效 ✗✓）', () => {
		const iface = read(IFACE);
		assert.ok(iface.includes('onListSlashCommands?'), '契约里必须有 onListSlashCommands ✓');
		assert.ok(iface.includes('onRunSlashCommand?'), '契约里必须有 onRunSlashCommand ✓');

		const base = read(BASE);
		assert.ok(base.includes('protected readonly _onListSlashCommands?'),
			'★ 基类必须有字段声明（只加契约、不加字段 ⇒ 面板永远拿不到 ✗✓）');
		assert.ok(base.includes('protected readonly _onRunSlashCommand?'), '基类必须有执行器字段 ✓');
		assert.ok(base.includes('this._onListSlashCommands = opts.onListSlashCommands;'),
			'★ 构造里必须**赋值**（声明了不赋值 ⇒ 静默 undefined ✗✓）');
		assert.ok(base.includes('this._onRunSlashCommand = opts.onRunSlashCommand;'), '执行器必须赋值 ✓');
		// ⚠ 该构造参数用的是**内联对象类型**（不是契约接口 ✗）⇒ 契约与内联类型**两处都要加** ✓✓
		assert.ok(base.includes('onListSlashCommands?: () => ReadonlyArray<{ command: string; label: string; description: string }>'),
			'★ 内联 opts 类型里也必须声明（只加契约 ⇒ TS2339 ✗✓ —— 我第一版就漏了这里 ✓）');
	});

	test('★★★ 命令是**执行**而不是插 chip ✓✓（渲染成 data-command-id + 立即调用执行器 ✓）', () => {
		const composer = read(COMPOSER);
		assert.ok(composer.includes("item.dataset.commandId = it.command ?? it.id;"),
			'★ 命令条目必须带 data-command-id（不带 ⇒ 选中时无法区分是命令还是 chip ✗✓）');
		assert.ok(composer.includes("} else if (it.kind === 'command') {"),
			'渲染时必须为 command 分支单独处理 ✓');
		assert.ok(composer.includes('this._runSlashCommand(it.command ?? it.id'),
			'点击命令条目必须**直接执行** ✓（插成 chip ⇒ `/compact` 会变成一段提示词被发给模型 ✗✓）');
		assert.ok(composer.includes("this._runSlashCommand(selected.dataset.commandId, '');"),
			'★ Enter 选中（`_selectSlashMenuItem`）也必须执行命令 ✓✓ —— 这正是"打字 /compact + 回车"的路径 ✓');
		assert.ok(composer.includes("kindBadge.textContent = it.kind === 'workflow' ? 'workflow' : it.kind === 'command' ? 'command' : 'skill';"),
			'三类条目必须有各自 badge（否则用户分不清"会执行"和"会插入" ✗✓）');
	});

	test('★★★ 命令列表**缺失/为空 ⇒ 不出现命令条目** ✓✓（不给出点不动的死条目 ✓）', () => {
		const composer = read(COMPOSER);
		assert.ok(composer.includes('const commands = this._onListSlashCommands?.() ?? [];'),
			'必须用可选调用 + 空数组兜底 ✓');
		assert.ok(composer.includes('if (!run) { return; }'),
			'★ 执行器缺失时必须静默返回（双保险 ✓ —— 菜单本就不该显示 ✓）');
	});

	test('★★★ `/compact-reset` 用公共 API 真跑 ✓；`/compact` **只在服务侧有能力时才列出** ✓✓', () => {
		const pane = read(PANE);
		assert.ok(pane.includes("command: 'compact-reset'"), '必须提供 /compact-reset（现在就能用 ✓）');
		assert.ok(pane.includes("typeof svc?.['handleCompactSlashCommand'] === 'function'"),
			'★ /compact 必须**按能力探测**再列出 ✗✓（无条件列出 ⇒ 用户敲了没反应 ✓✗）');
		assert.ok(pane.includes("await this._chatService.replaceHistory(agentId, sessionId, [...kept, reply as never]);"),
			'★ reset 必须**一次写盘**（去边界 + 追加回复 ✓；分两次会多一轮全量序列化 ✗✓）');
		assert.ok(pane.includes('await this._reloadChatHistory(agentId);'),
			'命令反馈必须刷新聊天区 ✓（否则磁盘变了、界面没变 ✗✓）');
	});

	test('★★ 边界消息的**字面量**必须与常量相等 ✓✓（pane 里刻意没引这条跨模块导入 ⇒ 靠本断言兜底 ✓）', () => {
		const pane = read(PANE);
		const literal = pane.includes("?.metadata?.type !== 'compaction'");
		assert.ok(literal, "pane 里用字面量 'compaction' 过滤边界消息 ✓");
		assert.strictEqual(COMPACTION_METADATA_TYPE, 'compaction',
			`★ 常量若改名，pane 里的字面量会**静默失配** ⇒ 本断言就是那道保险 ✗✓（实际 ${COMPACTION_METADATA_TYPE} ✗）`);
	});

	test('★ 命令列表顺序：压缩类放最前 ✓（最常用 ⇒ 菜单一打开就能看到 ✓）', () => {
		const pane = read(PANE);
		const iCompact = pane.indexOf("command: 'compact',");
		const iReset = pane.indexOf("command: 'compact-reset'");
		assert.ok(iCompact >= 0 && iReset >= 0 && iCompact < iReset,
			'`/compact` 应排在 `/compact-reset` 之前 ✓（menu 顺序 = push 顺序 ✓）');
	});
});
