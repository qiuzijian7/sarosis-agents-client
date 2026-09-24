/*---------------------------------------------------------------------------------------------
 *  `kb_build` 单元测试 —— 2026-09-24
 *
 *  背景：构建（库 → 笔记）此前**只有 UI 入口**（视图「批量构建库」/ 右键「构建为笔记」），
 *  于是「素材先落库、再构建」的链路走到最后一步就断了（技能 kb-game-teardown 只能叫用户自己点）。
 *  本工具的契约必须钉住四件事：
 *   ① 默认只读：`preview`（含缺省值）**绝不发起构建**；
 *   ② 发起语义：`build` 走 runner.start()，且**不 await**（发起即返回，长任务不卡住调用方）；
 *   ③ 两道护栏：知识库专家未配模型 ⇒ 拒绝；已有构建在进行 ⇒ 拒绝重复发起；
 *   ④ 无素材/无库 ⇒ 明确说明，不空跑也不静默。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/kbBuildTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { URI } from '../../../../../base/common/uri.js';
import {
	registerKbBuildTools, KB_BUILD_TOOL_NAME,
	type IKbBuildToolContext, type IKbBuildRunner, type IKbBuildRunResult,
} from '../../browser/providers/tool/kbBuildTools.js';
import { KbImportController } from '../../browser/kbImportController.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';

const VAULT = URI.file('C:/vault/kb');

/**
 * 复位「知识库专家未配置」提醒的 **5 分钟节流**。
 *
 * ⚠ 必须做：该节流是**静态**的（`KbImportController._kbConfigWarnedAt`），同进程内其它测试
 * 文件若先触发过，本文件的断言就会因"已被节流"而随机失败（跑单文件绿、跑聚合红）。
 */
function resetConfigWarnThrottle(): void {
	(KbImportController as unknown as { _kbConfigWarnedAt?: number })._kbConfigWarnedAt = undefined;
}

function setup(opts: {
	/** 待构建素材。 */
	pending?: string[];
	/** 知识库专家配置状态（'ready' | 'missing' | 'unknown'）。 */
	agentState?: 'ready' | 'missing' | 'unknown';
	/** 已有构建在进行。 */
	inFlight?: boolean;
	/** 不返回 vault（模拟没有激活的知识库）。 */
	noVault?: boolean;
	/** start() 抛错（验证失败通知）。 */
	startThrows?: boolean;
	/** start() 永不 resolve（验证「发起即返回」）。 */
	startHangs?: boolean;
	vault?: URI;
} = {}) {
	const registered: IBuiltinToolRegistration[] = [];
	const notifications: Array<{ severity: number; message: string }> = [];
	const starts: number[] = [];
	let resolveHang: (() => void) | undefined;

	const runner: IKbBuildRunner = {
		preview: async () => opts.pending ?? [],
		isInFlight: () => opts.inFlight === true,
		start: () => {
			starts.push(Date.now());
			if (opts.startThrows) { return Promise.reject(new Error('构建炸了')); }
			if (opts.startHangs) { return new Promise<IKbBuildRunResult>(resolve => { resolveHang = () => resolve({ pending: 0, built: 0, skipped: 0, systemDoc: null, usedFallback: false }); }); }
			return Promise.resolve({ pending: opts.pending?.length ?? 0, built: 1, skipped: 0, systemDoc: null, usedFallback: false });
		},
	};

	const ctx: IKbBuildToolContext = {
		register: d => { registered.push(d); },
		logService: { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as any,
		// kbAgentConfigState 通过这两个服务探测（见 kbImportController.kbAgentConfigState 的实现：
		// 句柄缺失 ⇒ 'unknown'（放行）；这里用真实判据形状注入）
		configurationService: { getValue: () => 'x' } as any,
		notificationService: {
			notify: (n: { severity: number; message: string }) => { notifications.push(n); },
			prompt: () => undefined,
		} as any,
		studioService: {
			isKbChatProviderAvailable: () => opts.agentState !== 'missing',
			_resolveKbChatModel: opts.agentState === undefined || opts.agentState === 'unknown'
				? undefined
				: () => (opts.agentState === 'missing' ? null : { providerId: 'p', modelId: 'm' }),
		} as any,
		resolveVaultRoot: async () => (opts.noVault ? undefined : (opts.vault ?? VAULT)),
		createRunner: () => runner,
	};
	registerKbBuildTools(ctx);
	const tool = registered.find(t => t.definition.name === KB_BUILD_TOOL_NAME);
	assert.ok(tool, '未注册 kb_build');
	return {
		tool: tool!, notifications, starts,
		release: () => resolveHang?.(),
	};
}

const call = (tool: IBuiltinToolRegistration, args: Record<string, unknown>): Promise<any> =>
	tool.handler(args, undefined, 'agent-1');

function textOf(r: unknown): string {
	const arr = Array.isArray(r)
		? r as Array<{ text?: string }>
		: (r as { content?: Array<{ text?: string }> })?.content ?? [];
	return String(arr[0]?.text ?? '');
}

suite('kb_build · 只读预检（preview）', () => {

	test('definition：工具名 / category / mode 两值（无 mode 时语义为只读，schema 里写明）', () => {
		const { tool } = setup();
		assert.strictEqual(tool.definition.name, 'kb_build');
		assert.strictEqual(tool.definition.category, 'knowledge');
		assert.deepStrictEqual(tool.definition.inputSchema.properties.mode.enum, ['preview', 'build']);
		assert.ok(/preview/.test(tool.definition.inputSchema.properties.mode.description));
	});

	test('★★ 缺省（不传 mode）与 mode=preview 都必须**只读**：列清单、不发起构建', async () => {
		for (const args of [{}, { mode: 'preview' }]) {
			const { tool, starts } = setup({ pending: ['库/raw/黑神话-拆解报告.md', '库/raw/原神-拆解报告.md'] });
			const r = await call(tool, args);
			const out = textOf(r);
			assert.match(out, /待构建素材 2 份/);
			assert.match(out, /库\/raw\/黑神话-拆解报告\.md/);
			assert.deepStrictEqual(starts, [], '只读模式绝不能发起构建');
			assert.strictEqual(r.details.started, undefined, '只读模式不应有 started=true');
			assert.strictEqual(r.details.mode, 'preview');
		}
	});

	test('★ 无待构建素材 ⇒ 明确说明且不发起（避免"点了没反应"）', async () => {
		const { tool, starts } = setup({ pending: [] });
		const out = textOf(await call(tool, { mode: 'preview' }));
		assert.match(out, /没有待构建的素材/);
		assert.deepStrictEqual(starts, []);
	});

	test('素材很多时截断清单（不把整份列表灌进上下文）', async () => {
		const many = Array.from({ length: 30 }, (_v, i) => `库/raw/素材-${i}.md`);
		const { tool } = setup({ pending: many });
		const out = textOf(await call(tool, {}));
		assert.match(out, /待构建素材 30 份/);
		assert.match(out, /只列前 20 份/);
		assert.strictEqual((out.match(/· 库\/raw\//g) ?? []).length, 20);
	});

	test('没有激活的知识库 ⇒ 给可执行的指引（而不是在错误目录上空跑）', async () => {
		const { tool, starts } = setup({ noVault: true, pending: ['库/a.md'] });
		const out = textOf(await call(tool, { mode: 'build' }));
		assert.match(out, /未找到知识库/);
		assert.deepStrictEqual(starts, []);
	});
});

suite('kb_build · 发起构建（build）', () => {

	test('★★ 发起即返回：start 挂起时 handler 也必须立刻回来（长任务不卡住调用方）', async () => {
		const { tool, starts, release } = setup({ pending: ['库/raw/x.md'], inFlight: false });
		const r = await call(tool, { mode: 'build' });   // ⚠ 若 handler await 了 start，这里会一直不返回
		const out = textOf(r);
		assert.strictEqual(starts.length, 1, '必须真的发起了构建');
		assert.match(out, /已发起知识库构建：1 份素材/);
		assert.match(out, /知识库专家/);
		assert.match(out, /进度/);
		assert.strictEqual(r.details.started, true);
		release();   // 收尾，避免挂起的 promise 影响后续
	});

	test('★ 未配模型的知识库专家 ⇒ 拒绝 + 弹提醒 + 说明去哪配置（不白跑几分钟）', async () => {
		resetConfigWarnThrottle();
		const { tool, starts, notifications } = setup({ agentState: 'missing', pending: ['库/raw/x.md'] });
		const out = textOf(await call(tool, { mode: 'build' }));
		assert.match(out, /知识库专家/);
		assert.match(out, /未配置|尚未配置/);
		assert.deepStrictEqual(starts, [], '未配模型时不该发起');
		assert.strictEqual(notifications.length, 1, '应弹一次提醒（用户在别处也能看到）');
		assert.match(notifications[0].message, /知识库专家/);
	});

	test('★ 已知配置状态为 missing 之外（unknown/ready）⇒ 放行（不误伤单测/早期启动）', async () => {
		const { tool, starts } = setup({ agentState: 'unknown', pending: ['库/raw/x.md'] });
		await call(tool, { mode: 'build' });
		assert.strictEqual(starts.length, 1);
	});

	test('★★ 已有构建在进行 ⇒ 拒绝重复发起（防两个会话互相覆盖缓存与导航）', async () => {
		const { tool, starts } = setup({ inFlight: true, pending: ['库/raw/x.md'] });
		const out = textOf(await call(tool, { mode: 'build' }));
		assert.match(out, /已有一个知识库构建正在进行/);
		assert.deepStrictEqual(starts, [], '并发时必须拒绝');
	});

	test('★ 无素材时 build 也不建会话（连"没有待构建素材"的通知都不该弹）', async () => {
		const { tool, starts } = setup({ pending: [] });
		const r = await call(tool, { mode: 'build' });
		assert.match(textOf(r), /没有待构建的素材/);
		assert.strictEqual(r.details.started, false);
		assert.deepStrictEqual(starts, []);
	});

	test('★ start 抛错 ⇒ 记日志 + 弹错误通知（"失败了没人知道"是本次要避免的形态）', async () => {
		const { tool, notifications } = setup({ pending: ['库/raw/x.md'], startThrows: true });
		await call(tool, { mode: 'build' });
		// 失败发生在发起之后（异步）⇒ 等一轮微/宏任务让 catch 落地
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.ok(notifications.some(n => /知识库构建失败/.test(n.message) || /构建炸了/.test(n.message)),
			`应弹失败通知，实际：${JSON.stringify(notifications)}`);
	});

	test('非法 mode（拼错）⇒ 退化为**只读** preview（宽容解析 + fail-safe 方向）', async () => {
		const { tool, starts } = setup({ pending: ['库/raw/x.md'] });
		const r = await call(tool, { mode: 'BUILD_NOW' });
		assert.strictEqual(r.details.mode, 'preview', '未知 mode 必须退化为只读，而不是猜成 build');
		assert.deepStrictEqual(starts, []);
	});
});
