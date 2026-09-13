/*---------------------------------------------------------------------------------------------
 *  图像分析工具（vision_analyze）单元测试
 *
 *  背景（2026-09-11）：与 drawio / session_search 同源的**第 4 个半成品** ——
 *  bundled 定义 / BUNDLED_TOOLSETS.vision / agentToolIsolator 的 READ_IMAGE 映射 /
 *  `AGENT_STUDIO_AUX_VISION_*` 配置与设置 UI 全都齐备，唯独没有 handler
 *  → 被注册成 stub → listTools 跳过 → 模型看不到。
 *
 *  覆盖：
 *   - 工具注册（名称 / inputSchema / 必需的 image+query）
 *   - 图片解析（data URL / 裸 base64 / 空白清理 / 非法输入）
 *   - 模型选择（aux 配置 'auto' 语义 / 自动路由到 supportsImages）
 *   - 调用语义（只收 text delta、忽略 thinking、provider 报错、无可用模型）
 *   - 大小上限
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/visionAnalyzeTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	registerVisionAnalyzeTools, VISION_ANALYZE_TOOL_NAME, parseImageInput,
} from '../../browser/providers/tool/visionAnalyzeTools.js';
import { binaryReadRejectedMessage } from '../../browser/providers/tool/coreTools.js';

import type { IToolResultContent } from '../../common/providers.js';

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as any;

interface IChatOpts { modelId: string; supportsImages: boolean; deltas: Array<{ type: string; content?: string; error?: string }>; throwOnChat?: boolean }

function makeProvider(o: IChatOpts) {
	return {
		id: o.modelId,
		name: o.modelId,
		priority: 1,
		onDidChangeModels: () => ({ dispose() { } }),
		listModels: async () => [{ id: o.modelId, name: o.modelId, supportsImages: o.supportsImages }],
		getAuthStatus: () => 'authenticated',
		async *chat() {
			if (o.throwOnChat) { throw new Error('provider exploded'); }
			for (const d of o.deltas) { yield d; }
		},
	} as any;
}

function makeRunner(opts: {
	providers?: any[];
	auxProvider?: string;
	auxModel?: string;
	/** 注入的本地图片加载器（生产由 `builtinToolProvider` 提供，带 file_read 同源护栏）。 */
	loadLocalImage?: (p: string, agentId?: string) => Promise<{ data: string; mimeType: string }>;
	/** 主模型是否支持图片输入（`mode:auto/attach` 的分流开关）。缺省 = 不支持。 */
	mainModelSupportsImages?: () => Promise<boolean>;
}) {
	const registered: any[] = [];
	const ctx: any = {
		register: (d: any) => registered.push(d),
		logService: quietLog,
		configurationService: {
			getValue: (key: string) => {
				if (key.endsWith('vision.provider')) { return opts.auxProvider ?? ''; }
				if (key.endsWith('vision.model')) { return opts.auxModel ?? ''; }
				return '';
			},
		},
		getModelProviders: () => opts.providers ?? [],
		loadLocalImage: opts.loadLocalImage,
		mainModelSupportsImages: opts.mainModelSupportsImages,
	};
	registerVisionAnalyzeTools(ctx);
	const handler = registered[0].handler;
	return {
		definition: registered[0].definition,
		/** 原始内容块数组 —— `mode:auto/attach` 命中时是 `[image, text]` 两项。 */
		invokeRaw: async (args: Record<string, unknown>): Promise<IToolResultContent[]> =>
			handler(args, undefined, 'agent-1'),
		/** 取文本答案（attach 模式下取其中的 text 项）。 */
		invoke: async (args: Record<string, unknown>): Promise<string> => {
			const res: IToolResultContent[] = await handler(args, undefined, 'agent-1');
			assert.ok(Array.isArray(res) && res.length > 0, 'handler 应返回内容块');
			const text = [...res].reverse().find(c => c.type === 'text');
			assert.ok(text, '结果里应有 text 项');
			return (text as { text: string }).text;
		},
	};
}

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

suite('Vision Analyze Tool (vision_analyze)', () => {

	test('VISION_ANALYZE_TOOL_NAME 与 bundled / isolator 登记名一致', () => {
		assert.strictEqual(VISION_ANALYZE_TOOL_NAME, 'vision_analyze');
	});

	test('definition 结构正确（image + query 必填）', () => {
		const r = makeRunner({});
		assert.strictEqual(r.definition.name, 'vision_analyze');
		assert.deepStrictEqual(r.definition.inputSchema.required, ['image', 'query']);
		assert.ok(r.definition.inputSchema.properties.image);
		assert.ok(r.definition.inputSchema.properties.query);
	});

	test('空 image / 空 query → 明确报错', async () => {
		const r = makeRunner({});
		assert.ok((await r.invoke({ image: '  ', query: 'x' })).includes('"image" is required'));
		assert.ok((await r.invoke({ image: DATA_URL, query: '  ' })).includes('"query" is required'));
	});

	// ─── 图片解析（纯函数）──────────────────────────────────────────────────

	test('parseImageInput：data URL → 保留 MIME', async () => {
		const p = await parseImageInput('data:image/jpeg;base64,AAAA', quietLog);
		assert.strictEqual(p.data, 'AAAA');
		assert.strictEqual(p.mimeType, 'image/jpeg');
	});

	test('parseImageInput：裸 base64 → 默认 png，并清理空白/换行', async () => {
		const p = await parseImageInput('AA\nBB  CC', quietLog);
		assert.strictEqual(p.data, 'AABBCC');
		assert.strictEqual(p.mimeType, 'image/png');
	});

	test('parseImageInput：非法输入 → 抛出可操作错误', async () => {
		// 2026-09-13：文案加入「本地文件路径」形态（此前只列 data URL/base64/URL）
		await assert.rejects(() => parseImageInput('这不是图片也不是 url', quietLog), /must be a local file path/);
	});

	test('★ 图片过大 → 明确报错（不把超大请求发到网络层）', async () => {
		const r = makeRunner({ providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [] })] });
		// 8MB base64 上限 → 构造 9MB
		const huge = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024);
		const text = await r.invoke({ image: huge, query: 'what is this' });
		assert.ok(text.includes('too large'), `应报过大，实际: ${text.slice(0, 120)}`);
	});

	// ─── 本地文件路径（2026-09-13 新增）─────────────────────────────────────
	//
	// 动机（实测日志）：模型自己截图后要看一眼，手上是**本地路径**
	// （`docs/kb-mockups/_shot-sidebar.png`）→ `file_read` 以 binary 拒绝
	// （文案当时还说「Use a different tool」，却一个都不点名）→ 整条
	// 「渲染 → 截图 → 看效果」闭环断掉。本工具原先只收 data URL / base64 / URL，
	// 同样用不了。

	test('★★ 本地路径 → 交给注入的加载器（并原样透传 agentId）', async () => {
		const seen: Array<{ p: string; agentId?: string }> = [];
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [{ type: 'text', content: 'ok' }] })],
			loadLocalImage: async (p, agentId) => {
				seen.push({ p, agentId });
				return { data: 'AAAA', mimeType: 'image/png' };
			},
		});
		const text = await r.invoke({ image: 'docs/kb-mockups/_shot-sidebar.png', query: '描述' });
		// handler 会加 `[Vision Analysis] (model: …)` 前缀（与其它用例一致，故用 includes）
		assert.ok(text.includes('ok'), text);
		assert.deepStrictEqual(
			seen, [{ p: 'docs/kb-mockups/_shot-sidebar.png', agentId: 'agent-1' }],
			'路径应原样交给加载器 —— 护栏在加载器那侧（与 file_read 同源），本工具不自行解析',
		);
	});

	test('★★ 控制组：data URL / http(s) / 裸 base64 **不走**本地加载器', async () => {
		let called = 0;
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [{ type: 'text', content: 'ok' }] })],
			loadLocalImage: async () => { called++; return { data: 'X', mimeType: 'image/png' }; },
		});
		await r.invoke({ image: DATA_URL, query: 'q' });
		await r.invoke({ image: 'AAAA', query: 'q' }); // 纯 base64 字符集
		assert.strictEqual(called, 0, '载荷形态不得被当成路径');
	});

	test('★★ 加载器抛错（护栏拒绝 / 非图片）→ 理由原样回传', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [] })],
			loadLocalImage: async () => { throw new Error('Cannot read: sensitive directory ".ssh"'); },
		});
		const text = await r.invoke({ image: '.ssh/id_rsa', query: 'q' });
		assert.ok(text.includes('vision_analyze error'), text);
		assert.ok(text.includes('sensitive directory'), `护栏拒绝理由必须回传：${text}`);
	});

	test('★ 未注入加载器 → 明确说明可用形态（不得静默失败）', async () => {
		const r = makeRunner({});
		const text = await r.invoke({ image: 'docs/x.png', query: 'q' });
		assert.ok(text.includes('local path'), text);
		assert.ok(text.includes('data URL'), '必须给出替代形态');
	});

	// ─── mode 分流（2026-09-13）：主模型能看图就附上去，否则走 aux 文本 ────────

	test('★★ mode=auto + 主模型支持图片 → **返回图像块**（跳过 aux 模型，主模型直接看像素）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [] })],
			mainModelSupportsImages: async () => true,
		});
		const res = await r.invokeRaw({ image: DATA_URL, query: '描述' });
		assert.strictEqual(res.length, 2, 'attach 模式应返回 [image, text] 两项');
		assert.strictEqual(res[0].type, 'image', '图像块在前（agent loop 会把它转成 user 消息）');
		assert.strictEqual((res[0] as { data: string }).data, 'iVBORw0KGgoAAAANSUhEUg==', '必须是纯 base64');
		assert.ok((res[1] as { text: string }).text.includes('描述'), 'text 项应带上原 query 交给主模型自答');
	});

	test('★★ 控制组：mode=text + 主模型支持图片 → **仍走 aux 文本**（省上下文）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [{ type: 'text', content: 'aux-answer' }] })],
			mainModelSupportsImages: async () => true,
		});
		const res = await r.invokeRaw({ image: DATA_URL, query: 'q', mode: 'text' });
		assert.strictEqual(res.length, 1, '显式 text 模式只返回一个文本块');
		assert.ok((res[0] as { text: string }).text.includes('aux-answer'));
	});

	test('★★ 控制组：mode=auto + 主模型**不支持**图片 → 退回 aux 文本（fail-closed）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [{ type: 'text', content: 'aux-answer' }] })],
			mainModelSupportsImages: async () => false,
		});
		const res = await r.invokeRaw({ image: DATA_URL, query: 'q' });
		assert.strictEqual(res.length, 1);
		assert.strictEqual(res[0].type, 'text');
	});

	test('★★ mode=attach + 主模型不支持图片 → **明确报错**（不静默退化为文本）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [] })],
			mainModelSupportsImages: async () => false,
		});
		const text = await r.invoke({ image: DATA_URL, query: 'q', mode: 'attach' });
		assert.ok(text.includes('mode="attach"'), text);
		assert.ok(text.includes('mode="text"'), '必须给出可执行出路');
	});

	test('★★ 能力探测抛错 → 按「不支持」处理（fail-closed，绝不冒 400 风险）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [{ type: 'text', content: 'aux-answer' }] })],
			mainModelSupportsImages: async () => { throw new Error('probe failed'); },
		});
		const res = await r.invokeRaw({ image: DATA_URL, query: 'q' });
		assert.strictEqual(res.length, 1);
		assert.strictEqual(res[0].type, 'text', '探测失败必须退回文本，而不是发图');
	});

	test('★ 非法 mode → 按 auto 处理（宽容解析）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'm', supportsImages: true, deltas: [{ type: 'text', content: 'aux-answer' }] })],
			mainModelSupportsImages: async () => true,
		});
		const res = await r.invokeRaw({ image: DATA_URL, query: 'q', mode: 'nonsense' });
		assert.strictEqual(res[0].type, 'image', '非法值退回 auto（主模型支持 → 附图）');
	});

	test('★★ 交叉断言：`file_read` 的二进制拒绝文案必须点名本工具', () => {
		// 工具改名而指引没跟上 → 模型照着文案调用一个**不存在**的工具。
		const msg = binaryReadRejectedMessage(
			'docs/kb-mockups/_shot-sidebar.png', '/ws/docs/kb-mockups/_shot-sidebar.png',
		);
		assert.ok(msg.includes(VISION_ANALYZE_TOOL_NAME),
			`文案必须含工具名 ${VISION_ANALYZE_TOOL_NAME}：${msg}`);
		assert.ok(/Do NOT retry file_read/.test(msg), '必须明确劝阻重试');
		// 扩展名分流：图片 → 点名本工具；文档 → 转换建议；其余 → 通用说明（不得误导到 vision）
		assert.ok(binaryReadRejectedMessage('a.docx', '/ws/a.docx').includes('pandoc'));
		const other = binaryReadRejectedMessage('a.zip', '/ws/a.zip');
		assert.ok(!other.includes(VISION_ANALYZE_TOOL_NAME), '非图片不得被误导到 vision 工具');
	});

	// ─── 模型选择与调用 ─────────────────────────────────────────────────────

	test('★ 无可用 vision 模型 → 明确报错并指向设置项', async () => {
		const r = makeRunner({ providers: [makeProvider({ modelId: 'text-only', supportsImages: false, deltas: [] })] });
		const text = await r.invoke({ image: DATA_URL, query: 'x' });
		assert.ok(text.includes('no vision-capable model'), '应提示无可用模型');
	});

	test('★ 自动路由到第一个 supportsImages 的模型并返回文本', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'vision-1', supportsImages: true, deltas: [{ type: 'text', content: '图中是一只猫' }, { type: 'done' }] })],
		});
		const text = await r.invoke({ image: DATA_URL, query: '描述这张图' });
		assert.ok(text.includes('图中是一只猫'), '应返回模型文本');
		assert.ok(text.includes('vision-1'), '应标注使用的模型');
	});

	test('★ 只收 text delta —— thinking 不得混入答案', async () => {
		const r = makeRunner({
			providers: [makeProvider({
				modelId: 'v', supportsImages: true,
				deltas: [
					{ type: 'thinking', content: '内部推理不应出现' },
					{ type: 'text', content: '正式答案' },
					{ type: 'done' },
				],
			})],
		});
		const text = await r.invoke({ image: DATA_URL, query: 'q' });
		assert.ok(text.includes('正式答案'), '应包含正文');
		assert.ok(!text.includes('内部推理不应出现'), 'thinking 不应混入答案');
	});

	test('provider 抛错 → 明确错误（不静默）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'v', supportsImages: true, deltas: [], throwOnChat: true })],
		});
		const text = await r.invoke({ image: DATA_URL, query: 'q' });
		assert.ok(text.includes('vision_analyze error'), '应报告错误');
		assert.ok(text.includes('provider exploded'), '应带上底层原因');
	});

	test('provider 返回 error delta 且无正文 → 报告 provider 错误', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'v', supportsImages: true, deltas: [{ type: 'error', error: 'quota exceeded' }] })],
		});
		const text = await r.invoke({ image: DATA_URL, query: 'q' });
		assert.ok(text.includes('quota exceeded'), '应转达 provider 错误');
	});

	test('模型返回空文本 → 明确说明（不返回空串）', async () => {
		const r = makeRunner({
			providers: [makeProvider({ modelId: 'v', supportsImages: true, deltas: [{ type: 'done' }] })],
		});
		const text = await r.invoke({ image: DATA_URL, query: 'q' });
		assert.ok(text.includes('returned no text'), '应明确说明无输出');
	});

	test("★ aux 配置为 'auto' 时走自动路由（不把 auto 当 provider id）", async () => {
		const r = makeRunner({
			auxProvider: 'auto',
			providers: [makeProvider({ modelId: 'auto-routed', supportsImages: true, deltas: [{ type: 'text', content: 'ok' }] })],
		});
		const text = await r.invoke({ image: DATA_URL, query: 'q' });
		assert.ok(text.includes('auto-routed'), "'auto' 应被视为未配置并走自动路由");
	});
});
