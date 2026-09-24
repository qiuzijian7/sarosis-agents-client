/*---------------------------------------------------------------------------------------------
 *  `web_search` / `web_extract` **handler 级**接线测试（P1，2026-09-24）。
 *
 *  为什么要有这一层：纯逻辑（memo / 落盘 / 形状防护）各自有单测，但"**接线**"只经过编译期
 *  检查 —— 例如 memo 是否真的插在链路的每一环里、落盘拿到的是不是**全文**、被缓存的是不是
 *  **内联片段**、二进制拒绝是否发生在 `htmlToPlainText` 之前。类型正确不等于接对了。
 *
 *  怎么跑起来：真调 `registerWebTools()` 拿到真实注册表，只给它一个最小 ctx ——
 *    · requestService：假响应（`bufferToStream(VSBuffer.fromString(html))`，与 `asText`
 *      要求的 `ReadableStream<VSBuffer>` 同源，不是手搓事件对象）
 *    · 不注入 webContentExtractorService ⇒ 强制走**原始 HTML 回退路径**（本文件要测的那条）
 *    · writeExtractSpill / 页面缓存：探针（记录收到的内容），IO 完全不出现在测试里
 *
 *  运行：npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { VSBuffer, bufferToStream } from '../../../../../base/common/buffer.js';
import { registerWebTools } from '../../browser/providers/tool/webTools.js';
import type { WebToolContext, IWebPageCacheLike } from '../../browser/providers/tool/webTools.js';
import type { ICachedPage } from '../../browser/providers/tool/webPageCache.js';
import { WebSearchMemo } from '../../browser/providers/tool/webSearchMemo.js';
import { WEB_EXTRACT_CHAR_LIMIT } from '../../browser/providers/tool/webSearchParse.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/builtinToolProvider.js';
import type {
	IWebContentExtractorService,
	WebContentExtractResult,
} from '../../../../../platform/webContentExtractor/common/webContentExtractor.js';

/** 可解析的 DDG 结果页（解析器认 `result__a` / `result__snippet` 类名）。 */
const DDG_HTML = '<html><body>'
	+ '<a class="result__a" href="https://example.com/page1">Page One</a>'
	+ '<span class="result__snippet">snippet one</span>'
	+ '</body></html>';

/** 正文明显超出 web_extract 预算的页面（预算 20000 字符，这里约 32k）。 */
function longPageHtml(): string {
	const paras = Array.from({ length: 400 }, (_, i) => `<p>paragraph ${i} ${'x'.repeat(70)}</p>`).join('');
	return `<!doctype html><html><head><title>Long Page</title></head><body>${paras}</body></html>`;
}

interface IHarness {
	setBody(body: string): void;
	setSpillPath(path: string | undefined): void;
	callText(tool: string, args: Record<string, unknown>): Promise<string>;
	readonly requests: string[];
	readonly spillCalls: string[];
	readonly cachePuts: ICachedPage[];
	readonly logs: string[];
}

/**
 * 造一个最小桩 ctx 并真调 `registerWebTools()`。
 *
 * `main` 给出时注入 `webContentExtractorService`（主进程 reader 路径 **真的** 会被走到）；
 * 不给则**不注入** —— 这与 web/未知环境下 `NullWebContentExtractorService` 的处境等价
 * （handler 会静默回退到原始 HTML 路径），也是其余用例依赖的形态。
 */
function makeHarness(main?: { text: string; title?: string }): IHarness {
	let body = '';
	let spillPath: string | undefined = 'C:\\Users\\me\\.vssaros\\tmp\\web-extract-20260924-120000-000-001.txt';
	const requests: string[] = [];
	const spillCalls: string[] = [];
	const cachePuts: ICachedPage[] = [];
	const logs: string[] = [];
	const registrations = new Map<string, IBuiltinToolRegistration>();

	// 本文件要确定性地走 requestService 回退路径：桥已在**模块级**清掉（见文件上方），
	// 并由 suiteTeardown 复原 —— 批处理的分片是多文件同进程，不能把后续文件的前提改掉。

	const webCache: IWebPageCacheLike = {
		get: () => undefined,
		put: page => { cachePuts.push({ ...page, cachedAt: Date.now() }); },
		info: () => { }, warn: () => { },
	};

	// ⚠ 必须是**稳定实例**（真实侧是 `??= ` 惰性单例）。写成 `() => new WebSearchMemo()` 会让
	// 每次取用都是空备忘 ⇒ memo 永不命中，而测试会以"没打网"的方式假绿（本文件首版就踩了这个坑）。
	const searchMemo = new WebSearchMemo();

	const logService = {
		info: (m: string) => logs.push(String(m)),
		warn: (m: string) => logs.push(String(m)),
		error: (m: string) => logs.push(String(m)),
		trace: () => { }, debug: () => { },
	};

	const ctx = {
		register: (r: IBuiltinToolRegistration) => {
			const name = r.definition.name;
			registrations.set(name, r);
			return { dispose: () => { } };
		},
		requestService: {
			request: async (options: { url?: string }) => {
				requests.push(String(options?.url ?? ''));
				return {
					res: { statusCode: 200, headers: {} },
					stream: bufferToStream(VSBuffer.fromString(body)),
				};
			},
		},
		logService,
		getWebCache: () => webCache,
		getSearchMemo: () => searchMemo,
		writeExtractSpill: async (content: string) => {
			spillCalls.push(content);
			return spillPath;
		},
		// 主进程 reader 路径：只有显式给了 main 才注入（见 makeHarness 注释）。形状取自
		// platform/webContentExtractor/common/webContentExtractor.ts 的 `WebContentExtractResult`。
		webContentExtractorService: main === undefined ? undefined : {
			extract: async (): Promise<WebContentExtractResult[]> => [
				{ status: 'ok', result: main.text, title: main.title },
			],
		} as unknown as IWebContentExtractorService,
	} as unknown as WebToolContext;

	registerWebTools(ctx);

	return {
		setBody: b => { body = b; },
		setSpillPath: p => { spillPath = p; },
		async callText(tool, args) {
			const reg = registrations.get(tool);
			assert.ok(reg, `tool ${tool} 未注册`);
			const out = await reg.handler(args, undefined);
			const contents = Array.isArray(out) ? out : out.content;
			return contents.map(c => (c as { text?: string }).text ?? '').join('');
		},
		requests, spillCalls, cachePuts, logs,
	};
}

/** 用一个**新的** harness 跑（避免 memo/缓存跨用例串味）。 */
function fresh(): IHarness {
	return makeHarness();
}

/** 主进程 reader 路径的 harness（注入 extractor，因此不会走原始 HTML 回退）。 */
function freshMain(text: string, title = 'Main Page'): IHarness {
	return makeHarness({ text, title });
}

/**
 * 宿主/其它测试可能给 `globalThis.vscode` 装桥（装了就会走主进程 IPC 路径，绕过我们要测的
 * `requestService` 回退）。这里在模块级清掉、并在 suiteTeardown 复原 —— **批处理的分片是
 * 多文件同进程**，直接 delete 会把后续文件的前提改掉。
 */
const hadVscodeBridge = 'vscode' in (globalThis as object);
const savedVscodeBridge = (globalThis as { vscode?: unknown }).vscode;
delete (globalThis as { vscode?: unknown }).vscode;

suite('webTools handler — 接线（search memo / 落盘 / 形状防护）', () => {

	suiteTeardown(() => {
		if (hadVscodeBridge) { (globalThis as { vscode?: unknown }).vscode = savedVscodeBridge; }
	});

	// ─── search memo 接线 ───────────────────────────────────────────────

	test('★★ 同一查询第二次调用**零网络请求**（memo 真的插在链路的每一环里）', async () => {
		const h = fresh();
		h.setBody(DDG_HTML);

		const first = await h.callText('web_search', { query: 'typescript generics' });
		assert.ok(first.includes('Page One'), `第一次应拿到结果：${first.slice(0, 200)}`);
		const afterFirst = h.requests.length;
		assert.ok(afterFirst > 0, '第一次必须真的打了网');

		const second = await h.callText('web_search', { query: 'typescript generics' });
		assert.strictEqual(h.requests.length, afterFirst, '第二次必须走 memo，不得再打网');
		assert.strictEqual(second, first, '内容应当一致');
		assert.ok(h.logs.some(l => l.includes('memo hit')), '要能看出走的是 memo（否则"没打网"可能是别的 bug 造成的）');
	});

	test('★ 不同 limit 落在不同桶 ⇒ 不共用条目', async () => {
		const h = fresh();
		h.setBody(DDG_HTML);
		await h.callText('web_search', { query: 'same query', max_results: 5 });
		const after5 = h.requests.length;
		await h.callText('web_search', { query: 'same query', max_results: 10 });
		assert.ok(h.requests.length > after5, '5 与 10 是不同桶，必须各自打网');
	});

	// ─── web_extract：落盘接线 ──────────────────────────────────────────

	test('★★ 超限页面：**全文**交给落盘，内联只给头尾 + 路径', async () => {
		const h = fresh();
		const html = longPageHtml();
		h.setBody(html);

		const text = await h.callText('web_extract', { url: 'https://example.com/long' });

		assert.strictEqual(h.spillCalls.length, 1, '超限必须落盘一次');
		assert.ok(h.spillCalls[0].length > WEB_EXTRACT_CHAR_LIMIT, `落盘的必须是**全文**（收到 ${h.spillCalls[0].length} 字符）`);
		assert.ok(h.spillCalls[0].length > text.length, '内联输出必须短于全文（否则落盘没意义）');

		const path = '\\web-extract-20260924-120000-000-001.txt';
		assert.ok(text.includes(path), '内联片段里必须带落盘路径（缓存命中时不会再发通知）');
		assert.ok(text.includes('[PAGE TRUNCATED IN CONTEXT — FULL TEXT SAVED]'), '要给出明确通知');
		assert.ok(text.includes('file_read with offset/limit'), '要给出可直接执行的取回方式');
	});

	test('★★ 被缓存的是**内联片段**（含路径），不是全文', async () => {
		const h = fresh();
		h.setBody(longPageHtml());
		await h.callText('web_extract', { url: 'https://example.com/long' });

		assert.strictEqual(h.cachePuts.length, 1, '成功产物应入缓存一次');
		const cached = h.cachePuts[0];
		assert.ok(cached.text.includes('web-extract-'), '缓存里也要含路径 —— 这是缓存命中时唯一的信息来源');
		assert.ok(cached.text.length <= WEB_EXTRACT_CHAR_LIMIT + 1, `缓存文本应受上限约束（实测 ${cached.text.length}）`);
		assert.ok(!h.spillCalls[0].startsWith(cached.text.slice(0, 50)) || cached.text.length < h.spillCalls[0].length, '缓存不该存全文');
	});

	test('★ 落盘不可用（IO 失败）⇒ 退化为纯截断，且如实说明"没能保存"', async () => {
		const h = fresh();
		h.setBody(longPageHtml());
		h.setSpillPath(undefined);

		const text = await h.callText('web_extract', { url: 'https://example.com/long' });

		assert.ok(text.includes('could NOT be saved'), '不得假装有文件可读');
		assert.ok(!text.includes('[PAGE TRUNCATED IN CONTEXT — FULL TEXT SAVED]'), '没有文件就不该发"已保存"通知');
		assert.ok(text.length > 0, '仍然要返回截断后的正文（降级不是失败）');
	});

	// ─── web_extract：形状防护接线 ──────────────────────────────────────

	test('★★ 二进制载荷：标签化失败，且**不落盘、不入缓存**', async () => {
		const h = fresh();
		h.setBody(`%PDF-1.7\n${'\u0000\u0001\u0002'.repeat(500)}`);

		const text = await h.callText('web_extract', { url: 'https://example.com/file.pdf' });

		assert.ok(text.includes('Web extract refused'), text.slice(0, 200));
		assert.ok(text.includes('PDF'), '要点明类型');
		assert.ok(text.includes('Do NOT treat any part of this response as page content'), '要明确禁止当正文用');
		assert.strictEqual(h.spillCalls.length, 0, '垃圾内容不该落盘');
		assert.strictEqual(h.cachePuts.length, 0, '垃圾内容不该入缓存');
	});

	test('★ 内联 base64（正文里的文本形态）被换成占位符 —— 原始 HTML 路径的真实风险面', async () => {
		const h = fresh();
		// 关键区别（写测试时实测到的真实行为）：raw 路径下 `<img src="data:…">` 会被
		// htmlToPlainText **连标签一起剥掉**（载荷本来就不会泄漏，占位符也就无处可留）；
		// 真正需要防的是**落在正文文本里**的 base64（`<pre>` / JSON 串 / 段落内），
		// 它会原样进入输出并吃掉预算 —— 这一条才是本防护在 raw 路径上的价值。
		h.setBody(`<html><body><p>before</p><pre>blob: data:image/png;base64,${'A'.repeat(400)}</pre><p>after</p></body></html>`);

		const text = await h.callText('web_extract', { url: 'https://example.com/img' });

		assert.ok(text.includes('[inline image/png removed]'), text.slice(0, 300));
		assert.ok(!text.includes('A'.repeat(400)), '载荷本体不得进入上下文');
		assert.ok(text.includes('before') && text.includes('after'), '正文要保留');
	});

	test('★ `<img src="data:…">` 里的载荷同样不会泄漏到输出', async () => {
		const h = fresh();
		h.setBody(`<html><body><p>before</p><img src="data:image/png;base64,${'A'.repeat(400)}"><p>after</p></body></html>`);

		const text = await h.callText('web_extract', { url: 'https://example.com/img' });

		assert.ok(!text.includes('A'.repeat(400)), '标签属性里的载荷不得进入上下文');
		assert.ok(text.includes('before') && text.includes('after'), '正文要保留');
	});

	// ─── 主进程 reader 路径（**另一处**独立的接线，不是 raw 路径的重复）────────
	//
	// 为什么单列一组：主进程序与原始 HTML 路径是两处**独立**的接线 —— webTools.ts 里各自
	// 调用一次 stripInlineBase64 / detectBinaryPayload / _spillAndExcerpt。只测 raw 的话，
	// "主进程序那一处接错了"不会被发现（而它恰好是多数 Electron 用户实际走的那条）。

	/** 长到足以触发落盘的主进程正文（预算 20000 字符）。 */
	function longMainText(): string {
		return Array.from({ length: 400 }, (_, i) => `paragraph ${i} ${'x'.repeat(70)}`).join('\n');
	}

	test('★★ 主进程路径：超限同样落盘，且**不打任何网络请求**', async () => {
		const full = longMainText();
		const h = freshMain(full);

		const text = await h.callText('web_extract', { url: 'https://example.com/long' });

		assert.strictEqual(h.requests.length, 0, '走主进程 reader 路径时不该有任何网络请求（有就说明回退到 raw 了）');
		assert.strictEqual(h.spillCalls.length, 1);
		assert.strictEqual(h.spillCalls[0], full, '落盘的必须是主进程序返回的**全文**');
		assert.ok(text.includes('web-extract-'), '内联片段要带落盘路径');
		assert.ok(text.includes('[PAGE TRUNCATED IN CONTEXT — FULL TEXT SAVED]'), '要给出通知');
		assert.ok(text.length < full.length, '内联输出必须短于全文');
	});

	test('★ 主进程路径：缓存里存的是内联片段（含路径），来源标记为 reader-mode', async () => {
		const h = freshMain(longMainText());
		await h.callText('web_extract', { url: 'https://example.com/long' });

		assert.strictEqual(h.cachePuts.length, 1);
		assert.ok(h.cachePuts[0].text.includes('web-extract-'), '缓存命中时路径只能来自缓存的内容本身');
		assert.strictEqual(h.cachePuts[0].source, 'reader-mode', '来源要标对，否则排障时分不清哪条路给的');
	});

	test('★★ 主进程路径：二进制载荷同样被拒（不落盘、不入缓存）', async () => {
		const h = freshMain(`%PDF-1.7\n${'\u0000\u0001\u0002'.repeat(500)}`);

		const text = await h.callText('web_extract', { url: 'https://example.com/file.pdf' });

		assert.ok(text.includes('Web extract refused'), text.slice(0, 160));
		assert.ok(text.includes('PDF'));
		assert.strictEqual(h.spillCalls.length, 0, '垃圾内容不该落盘');
		assert.strictEqual(h.cachePuts.length, 0, '垃圾内容不该入缓存');
		assert.strictEqual(h.requests.length, 0);
	});

	test('★★ 主进程路径：markdown 内联图 → [IMAGE: alt]（此行为**只**在这条路上成立）', async () => {
		// 两条路行为不同，所以断言必须打在各自那条路上：raw HTML 下 `<img src="data:…">` 会被
		// htmlToPlainText 连标签一起剥掉（占位符无处可留）；reader-mode 输出是 markdown 形态，
		// `![alt](data:…)` 的 alt 才能被保住。
		const prose = Array.from({ length: 60 }, (_, i) => `第 ${i} 段正文，长度足够让它不被判为过薄。`).join('\n');
		const h = freshMain(`导语\n![架构图](data:image/png;base64,${'A'.repeat(400)})\n${prose}`);

		const text = await h.callText('web_extract', { url: 'https://example.com/img' });

		assert.ok(text.includes('[IMAGE: 架构图]'), text.slice(0, 300));
		assert.ok(!text.includes('A'.repeat(400)), '载荷不得进入上下文');
	});

	// ─── 参数校验（顺手钉住两个既有前置检查）────────────────────────────

	test('web_extract 拒绝非 http(s) 的 url', async () => {
		const h = fresh();
		await assert.rejects(h.callText('web_extract', { url: 'file:///etc/passwd' }), /must start with http/);
	});

	test('web_search 拒绝空 query', async () => {
		const h = fresh();
		await assert.rejects(h.callText('web_search', { query: '   ' }), /query is required/);
	});

});
