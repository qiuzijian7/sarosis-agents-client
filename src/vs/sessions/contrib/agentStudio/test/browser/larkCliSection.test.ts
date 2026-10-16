/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「飞书 CLI」区块（`browser/larkCliSection.ts` 的 `LarkCliSection`）的**行为特征化网**。
 *
 * ## 来历（2026-10-12）
 *
 * 该区块原先长在 `agentSettingsEditorPane.ts` 里（`_buildLarkCliSection` → `_larkCliSleep`，284 行）。
 * 为把它外提，先在**搬迁前**写成本文件并跑绿（当年在 Pane 上的接缝是
 * `Object.create(Pane.prototype)` + 注入字段）；搬迁后**断言与期望值一字未改**，只把驱动面从
 * "Pane 的私有方法"换成"`LarkCliSection` 的同一个方法" ⇒ 两边都绿就是"行为没变"的证据 ✓。
 * 本文件另有 7 条反向突变验证（改标题/改按钮文案/去掉不可用判定/去掉重入保护/吞掉失败通知…）
 * 全部让它变红 ⇒ 不是空跑 ✓。
 *
 * ## 与 `larkCli.test.ts` 的分工
 *
 * 那个文件覆盖**纯逻辑**（徽章四态 / 版本比较 / 群列表解析）与**源码断言**；本文件用**真 DOM**
 * 驱动区块自己的方法，覆盖"结构 + 状态渲染 + 忙碌矩阵 + 两条真实失败路径 + 宿主契约"。
 * （`larkCli.test.ts` 头注释说"分片 worker 装不了 DOM stub" —— 那是当时的口径：本轮已有
 * `test/browser/domStub.mjs`（jsdom）由 runner 自动装载 ✓。）
 *
 * ## 可驱动性的边界（为什么只测这些）
 *
 * 这簇**不走注入服务**，而是直接 `import { getLarkCliStatus, installLarkCli } from './larkCliService.js'`
 * ⇒ 模块函数**无法被替换** ✗。因此"成功路径"（真探测到 CLI、真装上、真扫码成功）在本环境不可造 ✗；
 * 但**失败路径是真的**（`larkCliService` 保证永不抛：无 IPC 桥时 `getLarkCliStatus()` 返回
 * `available:false`、`installLarkCli()` 返回 `ok:false`）⇒ 用它们做**跨重构稳定**的判据 ✓。
 *
 * 刻意不测（依赖网络/canvas，不可确定 ✗）：带凭证的 `_fetchChatIds` 群列表渲染、
 * `_createFeishuBotByQr` 的扫码轮询循环（仅覆盖"缺容器时早退"）。
 */

import assert from 'assert';
import { AgentSettingsEditorPane } from '../../browser/agentSettingsEditorPane.js';
import { LarkCliSection, type ILarkCliSectionHost } from '../../browser/larkCliSection.js';
import { LARK_CLI_INSTALL_COMMAND, LARK_CLI_PACKAGE, type ILarkCliStatus } from '../../common/larkCli.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/** 只声明本文件真正用到的成员（含新模块的私有成员：TS private 运行时不设防，仅用于驱动）。 */
interface ISectionView {
	build(): HTMLElement;
	refresh(manual: boolean): Promise<void>;
	_renderLarkCliStatus(): void;
	_applyLarkCliBusy(): void;
	_installLarkCli(): Promise<void>;
	_showLarkCliOutput(text: string): void;
	_createFeishuBotByQr(): Promise<void>;
	_fetchChatIds(): Promise<void>;
	_larkCliSleep(ms: number): Promise<void>;
	_larkCliStatus: ILarkCliStatus | undefined;
	_larkCliProbing: boolean;
	_larkCliInstalling: boolean;
	_larkCliQrPolling: boolean;
	_larkCliStatusEl?: HTMLElement;
	_larkCliDetailEl?: HTMLElement;
	_larkCliCheckBtn?: HTMLButtonElement;
	_larkCliInstallBtn?: HTMLButtonElement;
	_larkCliOutputEl?: HTMLElement;
	_larkCliQrEl?: HTMLElement;
	_larkCliCreateBtn?: HTMLButtonElement;
}

interface INotice { readonly kind: 'info' | 'warn' | 'error'; readonly msg: string }

interface IFakes {
	readonly view: ISectionView;
	readonly notices: INotice[];
	readonly config: Map<string, unknown>;
	/** 「绑定到本 Agent」被复用了几次（宿主流程回调）。 */
	readonly bindings: { count: number };
	readonly bindingInput: { value: string; focused: boolean; focus(): void };
	setReadOnly(v: boolean): void;
}

/** 造一个区块 + 假宿主（三个服务 / 只读 / 输入框 / 绑定回调）。 */
function makeSection(opts?: { readOnly?: boolean }): IFakes {
	const notices: INotice[] = [];
	const config = new Map<string, unknown>();
	const bindings = { count: 0 };
	const bindingInput = { value: '', focused: false, focus(): void { bindingInput.focused = true; } };
	const state = { readOnly: !!opts?.readOnly };

	const host: ILarkCliSectionHost = {
		notificationService: {
			info: (m: string) => notices.push({ kind: 'info', msg: m }),
			warn: (m: string) => notices.push({ kind: 'warn', msg: m }),
			error: (m: string) => notices.push({ kind: 'error', msg: m }),
		} as unknown as INotificationService,
		configurationService: {
			getValue: (k: string) => config.get(k),
			updateValue: async (k: string, v: unknown) => { config.set(k, v); },
		} as unknown as IConfigurationService,
		requestService: {} as never,
		readOnly: () => state.readOnly,
		bindingInput: () => bindingInput as unknown as HTMLInputElement,
		addFeishuBinding: () => { bindings.count++; },
	};

	return {
		view: new LarkCliSection(host) as unknown as ISectionView,
		notices, config, bindings, bindingInput,
		setReadOnly: (v: boolean) => { state.readOnly = v; },
	};
}

const textOf = (el: Element | undefined | null): string => el?.textContent ?? '';

suite('飞书 CLI 区块 · 结构（外提后宿主入口仍须返回同样的 DOM）', () => {

	test('分组骨架：标题 / 说明 / 状态行 / 输出区 / 机器人行 / 二维码 / chat_id 行', () => {
		const { view } = makeSection();
		const sec = view.build();

		assert.strictEqual(sec.className, 'binding-section');
		assert.strictEqual(textOf(sec.children[0]), '飞书 CLI', '第一个子节点是分组标题');

		const hint = textOf(sec.children[1]);
		assert.ok(hint.includes(LARK_CLI_PACKAGE), `说明里要点出包名 ${LARK_CLI_PACKAGE}`);
		assert.ok(hint.includes('安装与升级是同一条命令'), '说明里必须讲清"安装与升级同一命令"（否则用户会找 upgrade）');

		assert.strictEqual(textOf(view._larkCliStatusEl), '检测中…', '徽章初值是「检测中…」（探测未返回前不能空着）');
		assert.strictEqual(view._larkCliStatusEl?.className, 'larkcli-badge');
		assert.strictEqual(textOf(view._larkCliDetailEl), '', '详情初值为空（由渲染填充）');
		assert.strictEqual(textOf(view._larkCliCheckBtn), '🔄 重新检测');
		assert.strictEqual(textOf(view._larkCliCreateBtn), '🤖 创建机器人（扫码授权）');
		// 安装按钮文案由 `_renderLarkCliStatus` 填（构建期刻意留空 ⇒ 不会闪一个错误文案）
		assert.strictEqual(textOf(view._larkCliInstallBtn), '');

		assert.strictEqual(view._larkCliOutputEl?.style.display, 'none');
		assert.strictEqual(view._larkCliQrEl?.style.display, 'none');

		const botHint = Array.from(sec.querySelectorAll('.larkcli-detail')).map(textOf).join(' | ');
		assert.ok(botHint.includes('自动写入渠道凭证'), '机器人行要说明"扫码后自动写凭证"（否则用户不知道要手工复制什么）');
	});

	test('三个按钮的点击接线：各自驱动对应入口（用实例上的替身截获，真不去网络）', async () => {
		const { view } = makeSection();
		const calls: string[] = [];
		(view as unknown as Record<string, unknown>).refresh = (manual: boolean) => { calls.push(`refresh:${manual}`); return Promise.resolve(); };
		(view as unknown as Record<string, unknown>)._installLarkCli = () => { calls.push('install'); return Promise.resolve(); };
		(view as unknown as Record<string, unknown>)._createFeishuBotByQr = () => { calls.push('createBot'); return Promise.resolve(); };

		view.build();
		view._larkCliCheckBtn?.click();
		view._larkCliInstallBtn?.click();
		view._larkCliCreateBtn?.click();
		await new Promise(r => setTimeout(r, 0));

		assert.deepStrictEqual(calls, ['refresh:true', 'install', 'createBot'],
			'重新检测传 manual=true（要给通知）、安装与扫码各走自己的入口');
	});
});

suite('飞书 CLI 区块 · 状态渲染（四态 × 按钮矩阵）', () => {

	const CASES: ReadonlyArray<{ name: string; status: ILarkCliStatus; label: string; tone: string; detail: string; installText: string; installDisabled: boolean }> = [
		{
			name: '桥不可用', status: { available: false, installed: false, error: 'IPC 桥不可用' },
			label: '不可用', tone: 'dim', detail: 'IPC 桥不可用', installText: '⬇ 安装', installDisabled: true,
		},
		{
			name: '可用但未安装', status: { available: true, installed: false, latestVersion: '0.5.0' },
			label: '未安装', tone: 'bad', detail: `npm 最新 0.5.0 · 将执行：${LARK_CLI_INSTALL_COMMAND}`,
			installText: '⬇ 安装', installDisabled: false,
		},
		{
			name: '已安装且是最新', status: { available: true, installed: true, version: '0.4.2', latestVersion: '0.4.2', path: '/usr/local/bin/lark' },
			label: '已安装 0.4.2', tone: 'ok', detail: '/usr/local/bin/lark · npm 最新 0.4.2',
			installText: '⬆ 升级', installDisabled: false,
		},
		{
			name: '已安装但有更新', status: { available: true, installed: true, version: '0.4.2', latestVersion: '0.5.0' },
			label: '可升级 0.5.0', tone: 'warn', detail: 'npm 最新 0.5.0', installText: '⬆ 升级', installDisabled: false,
		},
	];

	test('四态：徽章文案/色调 + 详情拼接 + 安装按钮文案与禁用位', () => {
		for (const c of CASES) {
			const { view } = makeSection();
			view.build();
			view._larkCliStatus = c.status;
			view._renderLarkCliStatus();

			assert.strictEqual(textOf(view._larkCliStatusEl), c.label, `[${c.name}] 徽章文案`);
			assert.strictEqual(view._larkCliStatusEl?.className, `larkcli-badge tone-${c.tone}`, `[${c.name}] 徽章色调`);
			assert.strictEqual(view._larkCliStatusEl?.title, c.status.error ?? '', `[${c.name}] 徽章 title 给错误原因（悬停可读）`);
			assert.strictEqual(textOf(view._larkCliDetailEl), c.detail, `[${c.name}] 详情拼接`);
			assert.strictEqual(textOf(view._larkCliInstallBtn), c.installText, `[${c.name}] 安装按钮文案`);
			assert.strictEqual(view._larkCliInstallBtn?.disabled, c.installDisabled, `[${c.name}] 安装按钮禁用位`);
		}
	});

	test('未探测（status undefined）⇒ 徽章「不可用」且安装按钮禁用（宁可不装，也不要点了崩）', () => {
		const { view } = makeSection();
		view.build();
		view._renderLarkCliStatus();
		assert.strictEqual(textOf(view._larkCliStatusEl), '不可用');
		assert.strictEqual(view._larkCliInstallBtn?.disabled, true);
		assert.strictEqual(textOf(view._larkCliInstallBtn), '⬇ 安装', 'undefined 不是"已安装" ⇒ 文案仍是安装');
	});

	test('只读模式 ⇒ 重新检测与安装都禁用（与其它区块口径一致，且是**逐次读取**宿主状态）', () => {
		const { view, setReadOnly } = makeSection({ readOnly: true });
		view.build();
		view._larkCliStatus = { available: true, installed: true, version: '0.4.2' };
		view._renderLarkCliStatus();
		view._applyLarkCliBusy();
		assert.strictEqual(view._larkCliInstallBtn?.disabled, true);
		assert.strictEqual(view._larkCliCheckBtn?.disabled, true);

		// ★ 关键：只读是靠 host 的读取函数拿的 ⇒ 宿主改状态后**无需通知区块**（外提时定的契约）
		setReadOnly(false);
		view._renderLarkCliStatus();
		view._applyLarkCliBusy();
		assert.strictEqual(view._larkCliInstallBtn?.disabled, false, '切回可写后应立刻恢复可点（说明读的是活状态而不是快照）');
		assert.strictEqual(view._larkCliCheckBtn?.disabled, false);
	});
});

suite('飞书 CLI 区块 · 忙碌态矩阵', () => {

	test('探测中 ⇒ 「⏳ 检测中…」+ 两个按钮都禁用；探测结束恢复', () => {
		const { view } = makeSection();
		view.build();
		view._larkCliProbing = true;
		view._applyLarkCliBusy();
		assert.strictEqual(textOf(view._larkCliCheckBtn), '⏳ 检测中…');
		assert.strictEqual(view._larkCliCheckBtn?.disabled, true);
		assert.strictEqual(view._larkCliInstallBtn?.disabled, true);

		view._larkCliProbing = false;
		view._applyLarkCliBusy();
		assert.strictEqual(textOf(view._larkCliCheckBtn), '🔄 重新检测');
		assert.strictEqual(view._larkCliCheckBtn?.disabled, false);
	});

	test('安装中 ⇒ 重新检测按钮文案不变但仍禁用；安装按钮文案由渲染给「⏳ 安装中…」', () => {
		const { view } = makeSection();
		view.build();
		view._larkCliStatus = { available: true, installed: true, version: '0.4.2' };
		view._larkCliInstalling = true;
		view._applyLarkCliBusy();
		assert.strictEqual(view._larkCliCheckBtn?.disabled, true, '安装期间不许再触发探测（否则状态会被探测覆盖）');
		assert.strictEqual(textOf(view._larkCliCheckBtn), '🔄 重新检测', '忙碌文案只归「探测中」用');
		view._renderLarkCliStatus();
		assert.strictEqual(textOf(view._larkCliInstallBtn), '⏳ 安装中…');
		assert.strictEqual(view._larkCliInstallBtn?.disabled, true);
	});

	test('已探测到"不可用" ⇒ 即便不忙，安装按钮也保持禁用（`available === false` 也要挡住）', () => {
		const { view } = makeSection();
		view.build();
		view._larkCliStatus = { available: false, installed: false, error: 'IPC 桥不可用' };
		view._applyLarkCliBusy();
		assert.strictEqual(view._larkCliInstallBtn?.disabled, true);
	});
});

suite('飞书 CLI 区块 · 输出与延时', () => {

	test('_showLarkCliOutput：容器缺失时静默（不抛）；存在时写文本并去掉 display:none', () => {
		const { view } = makeSection();
		view._larkCliOutputEl = undefined;
		view._showLarkCliOutput('不该崩');
		view.build();
		view._showLarkCliOutput('第一行\n第二行');
		assert.strictEqual(textOf(view._larkCliOutputEl), '第一行\n第二行');
		assert.strictEqual(view._larkCliOutputEl?.style.display, '', '显示（清掉 initial 的 none）');
	});

	test('_larkCliSleep：按 ms 延时 resolve（0ms 仍是异步 ⇒ 不能同步 resolve）', async () => {
		const { view } = makeSection();
		let done = false;
		const p = view._larkCliSleep(0).then(() => { done = true; });
		assert.strictEqual(done, false, '同步阶段不应已完成（轮询循环靠它让出事件循环）');
		await p;
		assert.strictEqual(done, true);
	});
});

suite('飞书 CLI 区块 · 无 IPC 桥的真实失败路径（跨重构稳定）', () => {

	test('探测（静默）：徽章「不可用」+ 详情给原因 + 安装禁用；不发通知', async () => {
		const { view, notices } = makeSection();
		view.build();
		await view.refresh(false);

		assert.strictEqual(view._larkCliStatus?.available, false);
		assert.strictEqual(textOf(view._larkCliStatusEl), '不可用');
		assert.strictEqual(view._larkCliStatusEl?.className, 'larkcli-badge tone-dim');
		assert.ok(textOf(view._larkCliDetailEl).includes('IPC 桥不可用'), `详情要带原因，实际：${textOf(view._larkCliDetailEl)}`);
		assert.strictEqual(view._larkCliInstallBtn?.disabled, true);
		assert.deepStrictEqual(notices, [], '静默探测（页签切入）不发通知 —— 否则每次切页签都弹提示');
		assert.strictEqual(view._larkCliProbing, false, 'finally 必须复位（否则按钮永久卡在「检测中」）');
	});

	test('探测（手动）：同一状态但发 warn，且文案说明是"探测不可用"（不是用户没装）', async () => {
		const { view, notices } = makeSection();
		view.build();
		await view.refresh(true);
		assert.strictEqual(notices.length, 1);
		assert.strictEqual(notices[0].kind, 'warn');
		assert.ok(notices[0].msg.startsWith('飞书 CLI 探测不可用：'), `实际：${notices[0].msg}`);
	});

	test('探测重入：已在探测中 ⇒ 直接返回（不重复打通知、不覆盖进行中的状态）', async () => {
		const { view, notices } = makeSection();
		view.build();
		view._larkCliProbing = true;
		await view.refresh(true);
		assert.deepStrictEqual(notices, []);
		assert.strictEqual(view._larkCliStatus, undefined, '重入时不应写入状态');
	});

	test('安装（无桥）：输出 ❌ + 失败通知 + 结束后自动重探（徽章回到「不可用」）+ 忙碌复位', async () => {
		const { view, notices } = makeSection();
		view.build();
		await view._installLarkCli();

		const out = textOf(view._larkCliOutputEl);
		assert.ok(out.startsWith('❌ '), `输出以 ❌ 开头，实际：${out}`);
		assert.ok(out.includes('IPC 桥不可用'), `输出要带原因，实际：${out}`);
		assert.deepStrictEqual(notices.map(n => n.kind), ['info', 'error'],
			'先 info「正在主进程执行…」再 error「安装失败」（成功才走 info 成功那条）');
		assert.ok(notices[0].msg.includes('正在主进程执行飞书 CLI 安装'), `实际：${notices[0].msg}`);
		assert.ok(notices[1].msg.startsWith('飞书 CLI 安装失败：'), `实际：${notices[1].msg}`);
		assert.strictEqual(view._larkCliInstalling, false, 'finally 复位');
		assert.strictEqual(textOf(view._larkCliStatusEl), '不可用', '安装失败后自动重探 ⇒ 徽章反映真实状态');
	});

	test('安装重入：已在安装中 ⇒ 直接返回（不重复执行命令）', async () => {
		const { view, notices } = makeSection();
		view.build();
		view._larkCliInstalling = true;
		await view._installLarkCli();
		assert.deepStrictEqual(notices, []);
		assert.strictEqual(textOf(view._larkCliOutputEl), '', '重入不应写输出');
	});
});

suite('飞书 CLI 区块 · 获取 chat_id（无凭证早退，零网络）', () => {

	test('未配置 app_id / app_secret ⇒ 提示去"扫码授权或手工填写"，且不禁用按钮（可反复尝试）', async () => {
		const { view } = makeSection();
		view.build();
		await view._fetchChatIds();

		const listEl = view._larkCliOutputEl?.parentElement?.querySelector('.chatid-list');
		assert.ok(listEl, '群列表容器应挂在区块里');
		assert.strictEqual(listEl?.children.length, 1);
		const tip = textOf(listEl?.children[0]);
		assert.ok(tip.includes('尚未配置飞书应用凭证'), `实际：${tip}`);
		assert.ok(tip.includes('创建机器人（扫码授权）') && tip.includes('app_id'), '提示要给出两条可行动作');
	});

	test('二维码容器缺失 ⇒ 早退且不置起轮询标志（不会卡住后续点击）', async () => {
		const { view } = makeSection();
		view._larkCliQrEl = undefined;
		await view._createFeishuBotByQr();
		assert.strictEqual(view._larkCliQrPolling, false);
	});
});

suite('飞书 CLI 区块 · 宿主契约（外提后的接缝）', () => {

	test('宿主只保留 2 个入口，8 个内部方法**不得**留在宿主（防第二套实现）', () => {
		const paneProto = AgentSettingsEditorPane.prototype as unknown as Record<string, unknown>;
		for (const m of ['_buildLarkCliSection', '_refreshLarkCliStatus']) {
			assert.strictEqual(typeof paneProto[m], 'function', `宿主缺入口 ${m}（调用点会断）`);
		}
		for (const m of [
			'_renderLarkCliStatus', '_applyLarkCliBusy', '_installLarkCli', '_showLarkCliOutput',
			'_createFeishuBotByQr', '_fetchChatIds', '_larkCliSleep',
		]) {
			assert.strictEqual(paneProto[m], undefined,
				`宿主侧不应再有 ${m} —— 真源已搬到 larkCliSection.ts，宿主只准转发 ✗`);
		}

		const sectionProto = LarkCliSection.prototype as unknown as Record<string, unknown>;
		for (const m of [
			'build', 'refresh',
			'_renderLarkCliStatus', '_applyLarkCliBusy', '_installLarkCli', '_showLarkCliOutput',
			'_createFeishuBotByQr', '_fetchChatIds', '_larkCliSleep',
		]) {
			assert.strictEqual(typeof sectionProto[m], 'function', `larkCliSection 缺 ${m}`);
		}
	});

	test('宿主转发真的接通：用假 Pane 只注入必要字段 ⇒ 建出的 DOM 与区块直建一致', () => {
		const pane = Object.create(AgentSettingsEditorPane.prototype) as unknown as Record<string, unknown>;
		const notices: INotice[] = [];
		pane.notificationService = {
			info: (m: string) => notices.push({ kind: 'info', msg: m }),
			warn: (m: string) => notices.push({ kind: 'warn', msg: m }),
			error: (m: string) => notices.push({ kind: 'error', msg: m }),
		};
		pane.configurationService = { getValue: () => undefined, updateValue: async () => { /* noop */ } };
		pane._readOnly = false;
		// ⚠ 转发面里其余字段（_requestService / _bindingInput / _addFeishuBinding）只被"用到时"读 ⇒
		//   这里刻意不注入：证明**没用到就不会碰**（懒读契约 ✓），否则建个 DOM 就会崩。
		const sec = (pane as unknown as { _buildLarkCliSection(): HTMLElement })._buildLarkCliSection();

		assert.strictEqual(sec.className, 'binding-section');
		assert.strictEqual(textOf(sec.children[0]), '飞书 CLI');
		assert.ok(textOf(sec.children[1]).includes(LARK_CLI_PACKAGE));
	});
});
