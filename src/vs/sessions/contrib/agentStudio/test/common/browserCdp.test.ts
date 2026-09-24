/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser_*`（CDP）纯逻辑单测（P1-2，2026-09-24）。几个 suite：
 *
 * ① `CdpConnection` —— JSON-RPC 请求关联 / 超时 / 断线清理。用假 socket 覆盖。
 *    **这类逻辑的价值全在错误路径上**：正常路径看一眼就懂，而"超时后回包""断线时在飞的
 *    请求"这些边角一旦错了，表现出来是"命令永远悬着"，最难排查。
 *
 * ② 注入脚本（快照 / 图片清单）+ 渲染器。脚本是**注入到用户页面里跑的**，真机上只有
 *    "结果对不对"这一个信号 —— 所以这里用一个极小的假 DOM **真的执行它**，把排序/可见性
 *    过滤/上限截断/shadow 穿透/图片尺寸过滤这些行为钉住；渲染器则是纯字符串装配，
 *    逐条断言"空段不输出"与"下一步指引在不在"（模型就靠那两行知道该 vision_analyze
 *    还是该 execute_code 落盘）。
 *
 * ③ 端点优先级门控（见 `browserCdp — 端点优先级` suite）。
 *
 * 放在 `test/common/` 是因为被测模块在 `agentStudio/common/`（`npm run test-agentstudio-common`
 * 直接覆盖），且两者都无 VS Code 依赖。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	BrowserCdpReachabilityGate,
	CdpConnection,
	CdpTargetManager,
	cdpEndpointCandidates,
	connectPreferredEndpoint,
	dedicatedPortFor,
	formatCdpError,
} from '../../common/browserCdp.js';
import type { ICdpEndpoint, IWebSocketLike } from '../../common/browserCdp.js';
import { CHROME_REMOTE_DEBUGGING_PAGE } from '../../common/chromeDebugSetup.js';
import {
	IMAGES_SCRIPT,
	MAX_SNAPSHOT_IMAGES,
	MAX_SNAPSHOT_REFS,
	MIN_IMAGE_DIMENSION,
	SAROS_REF_ATTR,
	SNAPSHOT_SCRIPT,
	formatImages,
	formatSnapshot,
	isDocumentComplete,
	normalizeRawImages,
	normalizeRawSnapshot,
} from '../../browser/browserCdpSnapshot.js';
import type { IRawImages, IRawSnapshot } from '../../browser/browserCdpSnapshot.js';

// ─── 假 WebSocket ───────────────────────────────────────────────────────────

/** 记录所有发出去的帧，并允许测试手动回包 / 触发断线。 */
class FakeSocket implements IWebSocketLike {
	readonly sent: string[] = [];
	closed = false;
	/** 同步自动回包钩子（假 CDP 服务端用）——在 `send` 内即回，模拟同进程的即时响应。 */
	autoRespond?: (frame: Record<string, unknown>) => void;
	onopen?: (() => void) | null;
	onmessage?: ((event: { data: unknown }) => void) | null;
	onerror?: ((event: unknown) => void) | null;
	onclose?: (() => void) | null;

	send(data: string): void {
		if (this.closed) { throw new Error('socket already closed'); }
		this.sent.push(data);
		this.autoRespond?.(JSON.parse(data) as Record<string, unknown>);
	}
	close(): void { this.closed = true; }

	/** 回一条 CDP 响应。 */
	respond(payload: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}
	/** 模拟服务端断开。 */
	killConnection(): void {
		this.closed = true;
		this.onclose?.();
	}
	lastFrame(): Record<string, unknown> {
		return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
	}
}

// ─── 假 DOM（只为快照脚本服务，字段刻意最小化）──────────────────────────────

interface IFakeRect { left: number; top: number; width: number; height: number; }

class FakeEl {
	readonly attrs = new Map<string, string>();
	readonly children: FakeEl[] = [];
	shadowRoot: FakeEl | undefined;
	text = '';
	value = '';
	isContentEditable = false;
	rect: IFakeRect = { left: 0, top: 0, width: 100, height: 20 };
	visibility = 'visible';
	display = 'block';
	opacity = '1';

	// ── 图片采集脚本（`browser_get_images`）需要的字段 ──────────────────────
	// FakeEl 只服务注入脚本，字段刻意最小化；真实 DOM 里 `img.src`（属性映射）与
	// `getAttribute('src')`（属性）是两份来源，这里刻意都保留，以便分别测到两条分支。
	src = '';
	currentSrc = '';
	naturalWidth = 0;
	naturalHeight = 0;

	constructor(readonly tagName: string) { }

	/** 把本节点伪装成一张已渲染的图。三处来源分开设置，便于测"取值优先级"。 */
	asImage(opts: { attrSrc?: string; propSrc?: string; currentSrc?: string; alt?: string; w?: number; h?: number }): this {
		if (opts.attrSrc) { this.attrs.set('src', opts.attrSrc); }
		if (opts.propSrc) { this.src = opts.propSrc; }
		if (opts.currentSrc) { this.currentSrc = opts.currentSrc; }
		if (opts.alt) { this.attrs.set('alt', opts.alt); }
		this.naturalWidth = opts.w ?? 0;
		this.naturalHeight = opts.h ?? 0;
		return this;
	}

	getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
	setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
	removeAttribute(name: string): void { this.attrs.delete(name); }
	get innerText(): string { return this.text; }
	get textContent(): string { return this.text; }
	getBoundingClientRect(): IFakeRect { return this.rect; }

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	querySelectorAll(selector: string): any[] {
		const all: FakeEl[] = [];
		const collect = (el: FakeEl): void => {
			for (const child of el.children) { all.push(child); collect(child); }
		};
		collect(this);
		if (selector === '*') { return all; }
		const attrOnly = /^\[([^\]]+)\]$/.exec(selector);
		if (attrOnly) { return all.filter(e => e.attrs.has(attrOnly[1])); }
		const tags = selector.split(',').map(s => s.trim().toUpperCase());
		return all.filter(e => tags.includes(e.tagName));
	}

	add(...kids: FakeEl[]): this { this.children.push(...kids); return this; }
	with(attrs: Record<string, string>, text = ''): this {
		for (const [k, v] of Object.entries(attrs)) {
			this.attrs.set(k, v);
			// ⚠ 必须同步：脚本读的是 `el.value`（属性），而 `value` 同时也是一份 attribute。
			// 不同步的话"按 value 取名"这条分支根本测不到（曾经因此让 INPUT[type=submit] 静默漏掉）。
			if (k === 'value') { this.value = v; }
		}
		this.text = text;
		return this;
	}
	hidden(): this { this.display = 'none'; return this; }
	tiny(): this { this.rect = { left: 0, top: 0, width: 1, height: 1 }; return this; }
}

function el(tag: string): FakeEl { return new FakeEl(tag); }

/** 真的执行注入脚本（注入假 document / location / getComputedStyle）。 */
function runSnapshotScript(root: FakeEl, opts?: { title?: string; url?: string; bodyText?: string }): IRawSnapshot {
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const factory = new Function('document', 'location', 'getComputedStyle', `return ${SNAPSHOT_SCRIPT};`) as
		(doc: unknown, loc: unknown, gcs: unknown) => unknown;
	const doc = {
		title: opts?.title ?? 'Page title',
		body: { innerText: opts?.bodyText ?? '' },
		querySelectorAll: (s: string) => root.querySelectorAll(s),
	};
	const raw = factory(doc, { href: opts?.url ?? 'https://x.example/p' }, (e: FakeEl) => ({
		visibility: e.visibility, display: e.display, opacity: e.opacity,
	}));
	return normalizeRawSnapshot(raw);
}

suite('browserCdp — CdpConnection（JSON-RPC 关联）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('send frames an id + method + params and resolves on the matching response', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);

		const promise = conn.send<{ ok: boolean }>('Page.navigate', { url: 'https://a.example' });
		assert.strictEqual(conn.pendingCount, 1);
		assert.deepStrictEqual(socket.lastFrame(), { id: 1, method: 'Page.navigate', params: { url: 'https://a.example' } });

		socket.respond({ id: 1, result: { ok: true } });
		assert.deepStrictEqual(await promise, { ok: true });
		assert.strictEqual(conn.pendingCount, 0);
	});

	test('sessionId is included when provided (flatten mode)', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		void conn.send('Runtime.evaluate', { expression: '1' }, 'SESSION-1');
		assert.strictEqual(socket.lastFrame()['sessionId'], 'SESSION-1');
	});

	test('ids increment per call so concurrent requests do not collide', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		const a = conn.send('A');
		const b = conn.send('B');
		assert.deepStrictEqual(socket.sent.map(s => JSON.parse(s).id), [1, 2]);
		socket.respond({ id: 2, result: 'b' });
		socket.respond({ id: 1, result: 'a' });
		assert.strictEqual(await a, 'a');
		assert.strictEqual(await b, 'b');
	});

	test('a CDP error response rejects with the method and code (callers can pattern-match)', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		const promise = conn.send('Target.attachToTarget', { targetId: 'gone' });
		socket.respond({ id: 1, error: { code: -32602, message: 'No target with given id found' } });

		await assert.rejects(promise, (err: Error) => {
			assert.ok(err.message.includes('Target.attachToTarget'), err.message);
			assert.ok(err.message.includes('code -32602'), err.message);
			assert.ok(err.message.includes('No target with given id found'), err.message);
			return true;
		});
	});

	test('a timeout rejects and drops the pending entry（避免命令永远悬着）', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		const promise = conn.send('Page.navigate', undefined, undefined, 20);

		await assert.rejects(promise, /timed out after 20ms/);
		assert.strictEqual(conn.pendingCount, 0);

		// 迟到的响应不能被当成未知 id 之外的东西处理（不抛、不误配）。
		socket.respond({ id: 1, result: { late: true } });
	});

	test('closing the connection aborts every in-flight request and fires onClosed', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		let closedFired = 0;
		conn.onClosed(() => { closedFired++; });

		const a = conn.send('A');
		const b = conn.send('B');
		socket.killConnection();

		await assert.rejects(a, /aborted: socket closed/);
		await assert.rejects(b, /aborted: socket closed/);
		assert.strictEqual(conn.pendingCount, 0);
		assert.strictEqual(closedFired, 1);
	});

	test('after dispose, further sends reject immediately', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		conn.dispose();
		await assert.rejects(conn.send('A'), /connection is disposed/);
	});

	test('event messages (method, no id) are ignored instead of resolving a request', async () => {
		const socket = new FakeSocket();
		const conn = new CdpConnection(socket);
		const promise = conn.send('A');

		socket.respond({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
		assert.strictEqual(conn.pendingCount, 1, 'the event must not consume the pending call');

		socket.respond({ id: 1, result: 'ok' });
		assert.strictEqual(await promise, 'ok');
	});

	test('unparseable frames do not throw out of the message handler', () => {
		const socket = new FakeSocket();
		const warnings: string[] = [];
		const conn = new CdpConnection(socket, { warn: m => warnings.push(m) });
		socket.onmessage?.({ data: 'not json at all' });
		assert.strictEqual(conn.pendingCount, 0);
		assert.ok(warnings.some(w => w.includes('unparseable')), warnings.join('|'));
	});

	test('formatCdpError falls back to JSON when there is no message', () => {
		assert.ok(formatCdpError('X', { code: 1 }).message.includes('{"code":1}'));
		assert.ok(formatCdpError('X', null).message.includes('null'));
	});

});

suite('browserCdp — 快照采集脚本（在假 DOM 上真跑）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('assigns sequential refs to visible interactive elements and stamps the DOM attribute', () => {
		const root = el('#document');
		const a = el('A').with({ href: '/x' }, 'Home');
		const btn = el('BUTTON').with({}, 'Save');
		const p = el('P').with({}, 'just text');
		root.add(a, btn, p);

		const snap = runSnapshotScript(root, { title: 'T', url: 'https://x.example/p' });

		assert.strictEqual(snap.url, 'https://x.example/p');
		assert.strictEqual(snap.title, 'T');
		assert.deepStrictEqual(snap.nodes.map(n => [n.ref, n.role, n.name]), [[1, 'link', 'Home'], [2, 'button', 'Save']]);
		assert.strictEqual(a.getAttribute(SAROS_REF_ATTR), '1');
		assert.strictEqual(btn.getAttribute(SAROS_REF_ATTR), '2');
		assert.strictEqual(p.getAttribute(SAROS_REF_ATTR), null, 'non-interactive elements get no ref');
	});

	test('infers roles from tag + input type', () => {
		const root = el('#document');
		root.add(
			el('INPUT').with({ type: 'checkbox', 'aria-label': 'Remember me' }),
			el('INPUT').with({ type: 'submit', value: 'Go' }),
			el('INPUT').with({ placeholder: 'Email' }),
			el('TEXTAREA').with({ placeholder: 'Message' }),
			el('SELECT').with({ 'aria-label': 'Country' }),
			el('DIV').with({ role: 'menuitem' }, 'Item'),
		);
		const snap = runSnapshotScript(root);
		assert.deepStrictEqual(snap.nodes.map(n => n.role), ['checkbox', 'button', 'textbox', 'textbox', 'combobox', 'menuitem']);
	});

	test('skips hidden / zero-size / textually empty elements', () => {
		const root = el('#document');
		root.add(
			el('BUTTON').with({}, 'ok'),
			el('BUTTON').with({}, 'invisible').hidden(),
			el('BUTTON').with({}, 'tiny').tiny(),
			el('BUTTON').with({}),
		);
		const snap = runSnapshotScript(root);
		assert.deepStrictEqual(snap.nodes.map(n => n.name), ['ok']);
	});

	test('aria-label wins over inner text; placeholder and value are used for fields', () => {
		const root = el('#document');
		root.add(
			el('A').with({ 'aria-label': 'Aria wins' }, 'inner text'),
			el('INPUT').with({ placeholder: 'Placeholder' }),
		);
		const a2 = el('A').with({ href: '/y' }, 'inner');
		a2.value = 'value text';
		root.add(a2);

		const snap = runSnapshotScript(root);
		assert.strictEqual(snap.nodes[0].name, 'Aria wins');
		assert.strictEqual(snap.nodes[1].name, 'Placeholder');
		// A 标签不走 value 分支（只有 INPUT/TEXTAREA/SELECT 才看 value）
		assert.strictEqual(snap.nodes[2].name, 'inner');
	});

	test('pierces open shadow roots (普通选择器取不到但内容确实在 DOM 里)', () => {
		const root = el('#document');
		const host = el('DIV');
		host.shadowRoot = el('#shadow-root');
		host.shadowRoot.add(el('BUTTON').with({}, 'Inside shadow'));
		root.add(host, el('BUTTON').with({}, 'Light DOM'));

		const snap = runSnapshotScript(root);
		assert.deepStrictEqual(snap.nodes.map(n => n.name), ['Inside shadow', 'Light DOM']);
	});

	test('clears stale refs before re-numbering（导航/重渲染后旧 ref 必须作废）', () => {
		const root = el('#document');
		const stale = el('BUTTON').with({ [SAROS_REF_ATTR]: '99' }, 'Stale');
		root.add(stale, el('BUTTON').with({}, 'Fresh'));

		const snap = runSnapshotScript(root);
		assert.strictEqual(snap.nodes.length, 2);
		assert.strictEqual(stale.getAttribute(SAROS_REF_ATTR), '1', '旧的 99 被重编号');
		assert.strictEqual(snap.nodes[1].name, 'Fresh');
		assert.strictEqual(snap.nodes[1].ref, 2);
	});

	test('caps refs at MAX_SNAPSHOT_REFS and flags the truncation', () => {
		const root = el('#document');
		for (let i = 0; i < MAX_SNAPSHOT_REFS + 5; i++) { root.add(el('BUTTON').with({}, `b${i}`)); }

		const snap = runSnapshotScript(root);
		assert.strictEqual(snap.nodes.length, MAX_SNAPSHOT_REFS);
		assert.strictEqual(snap.truncatedRefs, true);
	});

	test('collects headings and a body text excerpt', () => {
		const root = el('#document');
		root.add(el('H1').with({}, 'Title one'), el('H3').with({}, 'Deeper'));
		const snap = runSnapshotScript(root, { bodyText: 'the page body text' });
		assert.deepStrictEqual(snap.headings, ['h1 Title one', 'h3 Deeper']);
		assert.strictEqual(snap.textExcerpt, 'the page body text');
	});

	test('the injected script is syntactically valid and contains no template leftovers', () => {
		// 语法错误只会在用户浏览器里炸（而且报错离根因很远）—— 这一条把它挡在编译期之外。
		assert.doesNotThrow(() => new Function(`return ${SNAPSHOT_SCRIPT};`));
		assert.ok(!SNAPSHOT_SCRIPT.includes('${'), 'no template-literal leftovers');
		assert.ok(SNAPSHOT_SCRIPT.includes(SAROS_REF_ATTR));
	});

});

// ─── 图片清单（browser_get_images，2026-09-24）───────────────────────────────
//
// 为什么值得这一组：图文帖的正文常常**就在图里**（小红书尤甚），而快照不采集图片 ⇒ 模型
// 既看不到、也无法 vision_analyze（后者需要一个 URL）。这个脚本是模型唯一的"看图入口"，
// 它的过滤规则一旦写错，表现是"模型说这页没图"或"塞进 40 张图标" —— 两种都很难在真机上定位。

/** 真的执行图片采集脚本（注入 fake document / location；脚本不需要 getComputedStyle）。 */
function runImagesScript(root: FakeEl, opts?: { title?: string; url?: string }): IRawImages {
	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const factory = new Function('document', 'location', `return ${IMAGES_SCRIPT};`) as (doc: unknown, loc: unknown) => unknown;
	const doc = {
		title: opts?.title ?? 'Page title',
		querySelectorAll: (s: string) => root.querySelectorAll(s),
	};
	return normalizeRawImages(factory(doc, { href: opts?.url ?? 'https://x.example/p' }));
}

suite('browserCdp — 图片清单采集脚本（在假 DOM 上真跑）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★ 采集 <img>：URL / 尺寸 / alt 都拿到，且 currentSrc 优先于属性', () => {
		const root = el('#document');
		root.add(
			el('IMG').asImage({ currentSrc: 'https://cdn.example/lazy.jpg', w: 800, h: 600 }),
			el('IMG').asImage({ attrSrc: 'https://cdn.example/a.png', alt: '封面', w: 1200, h: 630 }),
			el('IMG').asImage({ propSrc: 'https://cdn.example/b.jpg', w: 400, h: 300 }),
		);
		const raw = runImagesScript(root);

		assert.deepStrictEqual(raw.images.map(i => i.src), [
			'https://cdn.example/lazy.jpg',   // currentSrc 优先（懒加载真地址在这里）
			'https://cdn.example/a.png',      // 退回 attribute
			'https://cdn.example/b.jpg',      // 退回属性映射 el.src
		]);
		assert.strictEqual(raw.images[1].alt, '封面');
		assert.strictEqual(raw.images[1].width, 1200);
	});

	test('★★ 懒加载占位（src 是 data:、真地址在 currentSrc）必须**保留**真图', () => {
		// 这是实测写法：`src` 放 1×1 的 data: 占位，渲染后 `currentSrc` 才指向真实图片。
		// 若按"属性是 data: 就跳过"去判，会把整张真图误删 —— 表现是"这页的图全没了"。
		const root = el('#document');
		root.add(el('IMG').asImage({
			attrSrc: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
			currentSrc: 'https://cdn.example/real-photo.jpg',
			w: 1080, h: 1440,
		}));
		const raw = runImagesScript(root);

		assert.deepStrictEqual(raw.images.map(i => i.src), ['https://cdn.example/real-photo.jpg']);
		assert.strictEqual(raw.skippedInline, 0, '它不算"被跳过的内联图"');
	});

	test('★ 尺寸过滤：两维都小于阈值才算图标；尺寸未知时**保留**（不因未加载而漏图）', () => {
		const root = el('#document');
		// ⚠ 假 DOM 的 rect 有默认值，要测"两处尺寸都未知"必须显式归零，否则测的是 rect 兜底那条路。
		const unknown = el('IMG').asImage({ attrSrc: 'https://cdn.example/unknown.png' });
		unknown.rect = { left: 0, top: 0, width: 0, height: 0 };
		root.add(
			el('IMG').asImage({ attrSrc: 'https://cdn.example/icon.png', w: 16, h: 16 }),
			el('IMG').asImage({ attrSrc: 'https://cdn.example/banner.png', w: 900, h: 60 }),
			unknown,
		);
		const raw = runImagesScript(root);

		assert.deepStrictEqual(raw.images.map(i => i.src), [
			'https://cdn.example/banner.png',   // 细长但够宽 ⇒ 留
			'https://cdn.example/unknown.png',  // 尺寸未知 ⇒ 留（宁可多列，也不要说"这页没图"）
		]);
		assert.strictEqual(raw.images[1].width, 0, '未知尺寸如实报 0，渲染层写成 size unknown');
		assert.ok(MIN_IMAGE_DIMENSION > 16, '阈值本身要大于图标尺寸，否则这条用例证明不了什么');
	});

	test('★ naturalWidth 为 0 时退回布局尺寸（懒加载图不在视口内也常能拿到 rect）', () => {
		const img = el('IMG').asImage({ attrSrc: 'https://cdn.example/rect.png' });
		img.rect = { left: 0, top: 0, width: 640, height: 480 };
		const raw = runImagesScript(el('#document').add(img));
		assert.strictEqual(raw.images[0].width, 640);
		assert.strictEqual(raw.images[0].height, 480);
	});

	test('★★ data: 内联图绝不进清单，但跳过数量要如实报出', () => {
		const root = el('#document');
		root.add(
			el('IMG').asImage({ attrSrc: 'data:image/png;base64,AAAA' }),
			el('IMG').asImage({ currentSrc: 'data:image/png;base64,BBBB' }),
			el('IMG').asImage({ attrSrc: 'https://cdn.example/real.png', w: 500, h: 500 }),
		);
		const raw = runImagesScript(root);

		assert.deepStrictEqual(raw.images.map(i => i.src), ['https://cdn.example/real.png']);
		assert.strictEqual(raw.skippedInline, 2);
		assert.ok(formatImages(raw).includes('inline data: image(s) skipped'), '渲染层要说明跳过了几张');
	});

	test('★ 去重：同一 URL 只出现一次', () => {
		const root = el('#document');
		root.add(
			el('IMG').asImage({ attrSrc: 'https://cdn.example/same.png', w: 300, h: 300 }),
			el('IMG').asImage({ currentSrc: 'https://cdn.example/same.png', w: 300, h: 300 }),
		);
		assert.strictEqual(runImagesScript(root).images.length, 1);
	});

	test('★★ 超过上限只报"还有更多"（图片 URL 动辄一两百字符，不能无上限塞 context）', () => {
		const root = el('#document');
		for (let i = 0; i < MAX_SNAPSHOT_IMAGES + 5; i++) {
			root.add(el('IMG').asImage({ attrSrc: `https://cdn.example/${i}.png`, w: 300, h: 300 }));
		}
		const raw = runImagesScript(root);

		assert.strictEqual(raw.images.length, MAX_SNAPSHOT_IMAGES);
		assert.strictEqual(raw.truncated, true);
		assert.ok(formatImages(raw).includes('more images were not listed'));
	});

	test('★ 没有 src 的 <img> 不算（占位元素）', () => {
		assert.strictEqual(runImagesScript(el('#document').add(el('IMG'))).images.length, 0);
	});

	test('★ 同源 iframe 里的图也收（与快照脚本同一取向）', () => {
		const inner = el('#document').add(el('IMG').asImage({ attrSrc: 'https://cdn.example/in-frame.png', w: 400, h: 400 }));
		const frame = el('IFRAME') as FakeEl & { contentDocument?: FakeEl };
		frame.contentDocument = inner;
		const raw = runImagesScript(el('#document').add(frame));
		assert.deepStrictEqual(raw.images.map(i => i.src), ['https://cdn.example/in-frame.png']);
	});

	test('★★ 注入脚本语法有效、无模板残留（语法错误只会在用户浏览器里炸，报错离根因很远）', () => {
		assert.doesNotThrow(() => new Function(`return ${IMAGES_SCRIPT};`));
		assert.ok(!IMAGES_SCRIPT.includes('${'), 'no template-literal leftovers');
	});
});

suite('browserCdp — 图片清单渲染', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const raw = (images: IRawImages['images'], extra?: Partial<IRawImages>): IRawImages => ({
		url: 'https://x.example/p', title: 'T', images, truncated: false, skippedInline: 0, ...extra,
	});

	test('★ 空清单要**显式说明**（否则模型以为"这页没图"，而不是"没采到 / 图在 CSS 背景里"）', () => {
		const text = formatImages(raw([]));
		assert.ok(text.includes('## Images (0)'));
		assert.ok(text.includes('none found'));
		assert.ok(text.includes('CSS background'), '要给出"图可能在 CSS 背景里"这条线索');
	});

	test('★★ 必须带"下一步怎么用"：vision_analyze 直接吃 URL、入库要 execute_code + **相对路径**', () => {
		const text = formatImages(raw([{ src: 'https://cdn.example/a.png', alt: '图', width: 10, height: 20 }]));
		assert.ok(text.includes('https://cdn.example/a.png'));
		assert.ok(text.includes('[10x20]'));
		assert.ok(text.includes('alt="图"'));
		assert.ok(text.includes('vision_analyze'), '模型下一步要读图内文字，必须点出这个工具');
		assert.ok(text.includes('execute_code'), '入库要下载，必须点出这个工具');
		assert.ok(/relative/i.test(text), '必须强调入库用相对路径（绝对路径会让预览与飞书同步失效）');
	});

	test('★ 尺寸未知写成 size unknown（不要伪造 0x0）', () => {
		const text = formatImages(raw([{ src: 'https://cdn.example/u.png', alt: '', width: 0, height: 0 }]));
		assert.ok(text.includes('[size unknown]'));
		assert.ok(!text.includes('[0x0]'));
	});

	test('★ 无标题时退回 URL，绝不输出空标题（空标题会诱导编造）', () => {
		const text = formatImages(raw([], { title: '' }));
		assert.ok(text.startsWith('# https://x.example/p'));
	});

	// ─── 登录墙自诊断（2026-09-24）──────────────────────────────────────────
	//
	// 这一组存在的理由就是用户实际收到的那张表：「正文配图 ❌ 未获取 — 登录墙下内容图不渲染，
	// 仅返回头像/图标」。而当时日志里**一次 `browser_*` 调用都没有** —— 那句"原因"是模型自己
	// 编的。下面这些断言要保证：占位页的图片清单**自己会说话**，轮不到模型去猜。

	test('★★ 占位页标题：必须自诊断，并给出"缺的是登录态 + 去哪登录"', () => {
		// 真实形态：登录墙下头像/站点图标照常渲染 ⇒ "有图"看起来像"页面正常"，
		// 于是模型把头像当成正文配图报上去。
		const text = formatImages(raw(
			[{ src: 'https://sns.example/avatar.png', alt: '', width: 48, height: 48 }],
			{ title: '小红书 - 你访问的页面不见了' },
		));
		assert.ok(text.includes('This is NOT the page content'), text.slice(0, 400));
		assert.ok(text.includes('zh-page-gone'), '要带上命中的特征标签（排障时能一眼看出判据）');
		assert.ok(text.includes('not signed in'), '要说清成因是缺登录态，而不是工具坏了 / 页面没加载完');
		assert.ok(text.includes(CHROME_REMOTE_DEBUGGING_PAGE), '必须点名那个页面地址：那是用户唯一的行动依据');
		assert.ok(text.includes('9222'), '要提醒那个勾选框只认 9222（改端口会让这条路失效）');
		assert.ok(/sign in once/i.test(text), '专属实例那条备选也要给（在那个窗口里登录一次）');
		assert.ok(text.indexOf('Notes:') < text.indexOf('This is NOT the page content'),
			'通知必须在最后：前面那两行 Notes 在占位页上是错的行动指引，必须被覆盖');
	});

	test('★ 普通标题不得触发（"狼来了"会让这条通知整个失效）', () => {
		const text = formatImages(raw([], { title: '如何用 ffmpeg 抽帧' }));
		assert.ok(!text.includes('This is NOT the page content'));
	});

	// ─── 视频直链（2026-09-25）───────────────────────────────────────────

	test('★★ 有视频时单列一段并给出"下一步去抽帧"；没有时一段都不出', () => {
		// 存在的意义：正文可能全在视频画面里（小红书/抖音图文帖尤甚）—— 直链是那个"模型下一步
		// 该喂给抽帧"的东西；此前模型只能靠 execute_code 自己绕。
		const withV = formatImages(raw([], {
			videos: [{ src: 'http://sns-bak-v1.xhscdn.com/stream/x.mp4', title: '' }],
		}));
		assert.ok(withV.includes('## Videos (1)'));
		assert.ok(withV.includes('http://sns-bak-v1.xhscdn.com/stream/x.mp4'), '直链必须原样给');
		assert.ok(withV.includes('extract_video_frames'), '必须点出下一步，否则模型只能自己绕');

		const without = formatImages(raw([]));
		assert.ok(!without.includes('## Videos'), '没视频时一段都不出（空段会诱导编造）');
	});
});

suite('browserCdp — 快照渲染与容错', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const base: IRawSnapshot = { url: 'https://x.example/p', title: 'T', nodes: [], headings: [], textExcerpt: '', truncatedRefs: false };

	test('renders title, URL, refs and the ref-invalidation reminder', () => {
		const out = formatSnapshot({
			...base,
			nodes: [{ ref: 1, role: 'link', name: 'Sign in' }, { ref: 2, role: 'textbox', name: 'Search' }],
		});
		assert.ok(out.includes('# T'));
		assert.ok(out.includes('URL: https://x.example/p'));
		assert.ok(out.includes('## Interactive elements (2)'));
		assert.ok(out.includes('[1] link "Sign in"'));
		assert.ok(out.includes('[2] textbox "Search"'));
		assert.ok(out.includes('invalidated by navigation'));
	});

	test('an empty element list is stated explicitly (不能只留一个空段落)', () => {
		const out = formatSnapshot(base);
		assert.ok(out.includes('## Interactive elements (0)'));
		assert.ok(out.includes('(none found'));
	});

	test('omits empty sections entirely (空段会诱导模型编造内容)', () => {
		const out = formatSnapshot(base);
		assert.ok(!out.includes('## Headings'));
		assert.ok(!out.includes('## Text excerpt'));
		assert.ok(!out.includes('more interactive elements'));
	});

	test('flags truncated refs with the limit', () => {
		const out = formatSnapshot({ ...base, truncatedRefs: true, nodes: [{ ref: 1, role: 'button', name: 'b' }] });
		assert.ok(out.includes('more interactive elements were not listed'));
		assert.ok(out.includes(String(MAX_SNAPSHOT_REFS)));
	});

	test('renders headings and excerpt when present', () => {
		const out = formatSnapshot({ ...base, headings: ['h1 Intro'], textExcerpt: 'body' });
		assert.ok(out.includes('## Headings'));
		assert.ok(out.includes('h1 Intro'));
		assert.ok(out.includes('## Text excerpt'));
		assert.ok(out.endsWith('\nbody') || out.includes('\nbody\n'), out);
	});

	test('falls back to the URL as the title when the page has no title', () => {
		const out = formatSnapshot({ ...base, title: '' });
		assert.ok(out.startsWith('# https://x.example/p'));
	});

	// ─── 登录墙自诊断（2026-09-24，与图片清单那条同一套判据）───────────────

	test('★★ 正文是占位页时自诊断；页面文本**仍然保留**（快照语义 = 屏幕上现在是什么）', () => {
		const out = formatSnapshot({
			...base,
			title: '小红书 - 你访问的页面不见了',
			textExcerpt: '小红书\n首页\n你访问的页面不见了\n返回首页\n'.repeat(30),
		});
		assert.ok(out.includes('This is NOT the page content'));
		assert.ok(out.includes('zh-page-gone'));
		assert.ok(out.includes('你访问的页面不见了'), '文本留着：删掉会让快照与用户肉眼所见不一致');
		assert.ok(out.trimEnd().endsWith('say so plainly instead of reusing it.'),
			'通知必须落在最末 —— 末尾才是模型开口回复前读到的最后一句');
	});

	test('★★ 正常长文不得触发（否则每次快照都在喊狼来了）', () => {
		const out = formatSnapshot({
			...base,
			title: '如何用 ffmpeg 抽帧',
			textExcerpt: '这一段是真正的正文，讲怎么用 ffmpeg 抽帧。'.repeat(100),
		});
		assert.ok(!out.includes('This is NOT the page content'));
	});

	test('normalizeRawSnapshot survives garbage and drops malformed nodes', () => {
		assert.deepStrictEqual(normalizeRawSnapshot(undefined), { url: '', title: '', nodes: [], headings: [], textExcerpt: '', truncatedRefs: false });
		assert.deepStrictEqual(normalizeRawSnapshot(null).nodes, []);

		const snap = normalizeRawSnapshot({
			url: 'u', title: 't',
			nodes: [{ ref: 1, role: 'button', name: 'ok' }, { ref: 'x', name: 'bad' }, null, { ref: 2 }],
			headings: ['h1', 42],
			textExcerpt: 'text',
			truncatedRefs: 'yes',
		});
		assert.deepStrictEqual(snap.nodes, [{ ref: 1, role: 'button', name: 'ok' }]);
		assert.deepStrictEqual(snap.headings, ['h1']);
		assert.strictEqual(snap.textExcerpt, 'text');
		assert.strictEqual(snap.truncatedRefs, false, '只有严格 true 才算截断');
	});

	test('isDocumentComplete only accepts the exact readyState', () => {
		assert.strictEqual(isDocumentComplete({ readyState: 'complete' }), true);
		assert.strictEqual(isDocumentComplete({ readyState: 'loading' }), false);
		assert.strictEqual(isDocumentComplete({}), false);
		assert.strictEqual(isDocumentComplete(undefined), false);
	});

});

// ─── 假 CDP 服务端（只为 CdpTargetManager 的决策逻辑服务）────────────────────

interface IFakeTarget { url: string; title: string; type: string; }

/** 以 `FakeSocket.autoRespond` 实现的同步 CDP 服务端（只实现 Target.* 这一个域）。 */
function makeTargetServer(socket: FakeSocket) {
	const targets = new Map<string, IFakeTarget>();
	const attachCount = new Map<string, number>();
	const closeCalls: string[] = [];
	let seq = 0;

	socket.autoRespond = frame => {
		const { id, method, params } = frame as { id: number; method: string; params?: Record<string, unknown> };
		const ok = (result: unknown) => socket.respond({ id, result });
		const fail = (message: string, code = -32000) => socket.respond({ id, error: { code, message } });

		switch (method) {
			case 'Target.getTargets':
				return ok({ targetInfos: [...targets].map(([targetId, t]) => ({ targetId, ...t })) });
			case 'Target.attachToTarget': {
				const tid = String(params?.['targetId']);
				if (!targets.has(tid)) { return fail('No target with given id found'); }
				attachCount.set(tid, (attachCount.get(tid) ?? 0) + 1);
				return ok({ sessionId: `session-${tid}` });
			}
			case 'Target.createTarget': {
				const tid = `t${++seq}`;
				targets.set(tid, { url: String(params?.['url'] ?? 'about:blank'), title: '', type: 'page' });
				return ok({ targetId: tid });
			}
			case 'Target.closeTarget': {
				const tid = String(params?.['targetId']);
				closeCalls.push(tid);
				targets.delete(tid);
				return ok({});
			}
			default:
				return ok({});
		}
	};
	return { targets, attachCount, closeCalls };
}

/** 建一个「真 CdpConnection + 假服务端 + 真 CdpTargetManager」的组合。 */
function makeManager() {
	const socket = new FakeSocket();
	const server = makeTargetServer(socket);
	const conn = new CdpConnection(socket);
	return { socket, server, conn, manager: new CdpTargetManager(conn) };
}

suite('browserCdp — CdpTargetManager（目标选择 / attach / 只关自己的 tab）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ensurePage creates and attaches when nothing is available', async () => {
		const { server, manager } = makeManager();
		server.targets.set('user-tab', { url: 'https://user.example/', title: 'User', type: 'page' });

		const page = await manager.ensurePage();
		assert.strictEqual(page.targetId, 't1');
		assert.strictEqual(page.sessionId, 'session-t1');
		assert.strictEqual(page.url, 'about:blank');
		assert.strictEqual(manager.ownedCount, 1);
	});

	test('ensurePage reuses the already-attached page and attaches only once', async () => {
		const { server, manager } = makeManager();
		const first = await manager.ensurePage();
		const second = await manager.ensurePage();
		assert.strictEqual(second.targetId, first.targetId);
		assert.strictEqual(server.attachCount.get(first.targetId), 1, 'session 应被缓存');
	});

	test('ensurePage reuses an existing tab when the URL matches (不新开 tab)', async () => {
		const { server, manager } = makeManager();
		server.targets.set('match', { url: 'https://docs.example/guide', title: 'Docs', type: 'page' });

		const page = await manager.ensurePage('https://docs.example/guide');
		assert.strictEqual(page.targetId, 'match');
		assert.strictEqual(manager.ownedCount, 0, 'URL 命中时不应记为自己的 tab');
	});

	test('ensurePage re-attaches / re-creates when the previously attached target disappeared', async () => {
		const { server, manager } = makeManager();
		const first = await manager.ensurePage();
		server.targets.delete(first.targetId);  // 用户手动关掉了这个 tab

		const second = await manager.ensurePage();
		assert.notStrictEqual(second.targetId, first.targetId);
		assert.strictEqual(second.targetId, 't2');
	});

	test('closeOwned refuses targets this tool did not create (硬约束)', async () => {
		const { server, manager } = makeManager();
		server.targets.set('user-tab', { url: 'https://user.example/', title: 'User', type: 'page' });

		await assert.rejects(manager.closeOwned('user-tab'), /不是本工具创建/);
		assert.deepStrictEqual(server.closeCalls, [], '拒绝时不得发出 closeTarget');
		assert.ok(server.targets.has('user-tab'), '用户的 tab 必须还在');
	});

	test('closeOwned closes an owned target exactly once', async () => {
		const { server, manager } = makeManager();
		const page = await manager.ensurePage();
		assert.deepStrictEqual(await manager.closeOwned(page.targetId), { closed: true });
		assert.deepStrictEqual(server.closeCalls, [page.targetId]);
		assert.strictEqual(manager.ownedCount, 0);
		await assert.rejects(manager.closeOwned(page.targetId), /不是本工具创建/, '第二次必须拒绝');
	});

	test('ensureSession surfaces a readable error for a vanished target', async () => {
		const { manager } = makeManager();
		await assert.rejects(manager.ensureSession('gone'), err => {
			assert.ok(err.message.includes('无法附着到页面 gone'), err.message);
			assert.ok(err.message.includes('No target with given id found'), err.message);
			return true;
		});
	});

	test('list filters out non-page targets and devtools pages', async () => {
		const { server, manager } = makeManager();
		server.targets.set('p1', { url: 'https://a.example/', title: 'A', type: 'page' });
		server.targets.set('devtools', { url: 'devtools://devtools/bundled/x.html', title: 'DT', type: 'page' });
		server.targets.set('worker', { url: 'https://a.example/sw.js', title: 'SW', type: 'service_worker' });

		const list = await manager.list();
		assert.deepStrictEqual(list.map(t => t.targetId), ['p1']);
	});

	test('clearSessions forces a re-attach on the next ensurePage（连接断开后的语义）', async () => {
		const { server, manager } = makeManager();
		const first = await manager.ensurePage();
		assert.strictEqual(server.attachCount.get(first.targetId), 1);

		manager.clearSessions();
		const second = await manager.ensurePage();
		assert.strictEqual(second.targetId, first.targetId, '同一 tab 复用');
		assert.strictEqual(server.attachCount.get(first.targetId), 2, 'session 作废后必须重新 attach');
	});

});

suite('browserCdp — 可达性门控（避免模型白撞一次慢失败）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const INTERVAL = 30_000;
	/** 让后台探测的 then 落地。 */
	const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

	test('未探测过时保守返回不可用，并在后台发起探测（isUsable 不阻塞）', async () => {
		let calls = 0;
		const gate = new BrowserCdpReachabilityGate(async () => { calls++; return true; }, INTERVAL, undefined, () => 0);

		assert.strictEqual(gate.isUsable(), false, '首次调用必须立刻返回，不等网络');
		assert.strictEqual(calls, 1, '同时已经发起了一次探测');

		await flush();
		assert.strictEqual(gate.isUsable(), true, '探测成功后转为可用');
	});

	test('一个周期内只探测一次（available() 会被每个工具各调一遍）', async () => {
		let calls = 0;
		const gate = new BrowserCdpReachabilityGate(async () => { calls++; return false; }, INTERVAL, undefined, () => 0);

		for (let i = 0; i < 50; i++) { gate.isUsable(); }
		await flush();
		for (let i = 0; i < 50; i++) { gate.isUsable(); }
		assert.strictEqual(calls, 1, '同一个周期内不得重复探测');
	});

	test('周期到点后会重探 —— 用户中途开好远程调试能被发现', async () => {
		let now = 0;
		let reachable = false;
		let calls = 0;
		const gate = new BrowserCdpReachabilityGate(async () => { calls++; return reachable; }, INTERVAL, undefined, () => now);

		gate.isUsable();
		await flush();
		assert.strictEqual(gate.isUsable(), false);

		// 用户在这期间打开了 chrome://inspect 的开关
		reachable = true;
		now += INTERVAL + 1;
		gate.isUsable();
		await flush();

		assert.strictEqual(calls, 2, '过了周期必须重探');
		assert.strictEqual(gate.isUsable(), true, '重探成功后工具重新出现');
	});

	test('探测抛错被视为不可达（而不是把异常漏到 listTools 上）', async () => {
		let calls = 0;
		const gate = new BrowserCdpReachabilityGate(async () => { calls++; throw new Error('ipc broke'); }, INTERVAL, undefined, () => 0);

		assert.doesNotThrow(() => gate.isUsable());
		await flush();
		assert.strictEqual(gate.isUsable(), false);
		assert.strictEqual(calls, 1);
	});

	test('单飞：探测未返回时不叠加新探测（哪怕周期已过）', async () => {
		let calls = 0;
		let settle: (v: boolean) => void = () => { };
		const pending = new Promise<boolean>(resolve => { settle = resolve; });
		// interval=0 + 时钟冻结 ⇒ 节流形同失效，只有 _inFlight 能挡住重复探测。
		const gate = new BrowserCdpReachabilityGate(() => { calls++; return pending; }, 0, undefined, () => 0);

		gate.isUsable();
		gate.isUsable();
		gate.isUsable();
		assert.strictEqual(calls, 1, '在飞期间不得叠加探测');

		settle(true);
		await flush();
		assert.strictEqual(gate.isUsable(), true);
	});

	test('只在状态翻转时通知（避免每 30s 刷一条日志）', async () => {
		let now = 0;
		let reachable = false;
		const changes: Array<boolean> = [];
		const gate = new BrowserCdpReachabilityGate(async () => reachable, INTERVAL, r => changes.push(r), () => now);

		// 连续 3 个周期都是"不可达" → 只在第一次翻转时通知一次…… 注意初值是 false，
		// 所以"持续不可达"根本不该产生通知。
		for (let i = 0; i < 3; i++) {
			now += INTERVAL + 1;
			gate.isUsable();
			await flush();
		}
		assert.deepStrictEqual(changes, [], '一直是 false 就不是"变化"');

		reachable = true;
		now += INTERVAL + 1;
		gate.isUsable();
		await flush();
		assert.deepStrictEqual(changes, [true]);

		// 再持续可用 → 不再通知
		now += INTERVAL + 1;
		gate.isUsable();
		await flush();
		assert.deepStrictEqual(changes, [true]);
	});

	test('warmUp 让首次 listTools 就有结论（不必白等一个周期）', async () => {
		let calls = 0;
		const gate = new BrowserCdpReachabilityGate(async () => { calls++; return true; }, INTERVAL, undefined, () => 0);

		gate.warmUp();
		assert.strictEqual(calls, 1);
		await flush();
		assert.strictEqual(gate.isUsable(), true, '预热之后第一次查询就是可用');
	});

});

suite('browserCdp — 端点优先级（你自己的 Chrome 优先于专属实例）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★ 专属实例端口 = 配置端口 + 1（错开一位是为了不占 9222）', () => {
		// 9222 是 Chrome 自己那个开关**唯一**会监听的端口（它没有端口选项）。专属实例若占着它，
		// "用你日常的 Chrome（带全部登录态）"这条路就被静默堵死 —— 而我们仍连得上该端口，
		// 于是表现为"模型驱动的是空 profile / 它说我没登录"。
		assert.strictEqual(dedicatedPortFor(9222), 9223);
		assert.strictEqual(dedicatedPortFor(9333), 9334);
	});

	test('★ 上限那一档不得溢出，且结果不能等于配置端口', () => {
		const dedicated = dedicatedPortFor(65535);
		assert.ok(Number.isInteger(dedicated) && dedicated > 0 && dedicated <= 65535, `越界：${dedicated}`);
		assert.notStrictEqual(dedicated, 65535, '必须是个**别的**端口，否则候选列表里会出现两个相同端点');
	});

	test('★★ 候选顺序：配置端口(IPv4) → 配置端口(IPv6) → 专属实例', () => {
		const candidates = cdpEndpointCandidates(9222);
		assert.deepStrictEqual(candidates.map(c => c.url), [
			'http://127.0.0.1:9222',
			'http://[::1]:9222',
			'http://127.0.0.1:9223',
		]);
		assert.deepStrictEqual(candidates.map(c => c.selfLaunched), [false, false, true],
			'只有 +1 那个端口是我们自己拉起的');
	});

	test('★ 自定义端口同样岔开（不给 9222 之外的端口留后门）', () => {
		assert.deepStrictEqual(cdpEndpointCandidates(9333).map(c => c.port), [9333, 9333, 9334]);
		assert.deepStrictEqual(cdpEndpointCandidates(9333).map(c => c.url), [
			'http://127.0.0.1:9333',
			'http://[::1]:9333',
			'http://127.0.0.1:9334',
		]);
	});

	// ─── connectPreferredEndpoint ────────────────────────────────────────────

	/** 独立于端口推导造端点，避免这些用例与端口约定耦合。 */
	const ep = (url: string, selfLaunched = false): ICdpEndpoint => ({ host: '127.0.0.1', port: 9222, url, selfLaunched });

	test('★★ 按候选顺序取胜者，而不是"谁先回来选谁"', async () => {
		const { endpoint } = await connectPreferredEndpoint(
			[ep('http://a'), ep('http://b')],
			async e => {
				// b 先回来、a 慢 —— 胜者仍必须是 a（你自己的 Chrome 优先于专属实例）。
				if (e.url === 'http://a') { await new Promise(r => setTimeout(r, 20)); }
				return e.url;
			},
			() => { },
		);
		assert.strictEqual(endpoint.url, 'http://a');
	});

	test('★ 全部候选**并行**发起（串行会把几次约 2.5s 的超时叠起来）', async () => {
		const called: string[] = [];
		const pending = connectPreferredEndpoint(
			[ep('http://a'), ep('http://b'), ep('http://c')],
			async e => { called.push(e.url); await new Promise(r => setTimeout(r, 5)); return e.url; },
			() => { },
		);
		await new Promise(r => setTimeout(r, 1));
		assert.deepStrictEqual(called, ['http://a', 'http://b', 'http://c'], '发起阶段不得串行等待');
		await pending;
	});

	test('★★ 落败连接必须被关掉（每一个都是真的 WebSocket + Target 会话）', async () => {
		const disposed: string[] = [];
		const { endpoint, value } = await connectPreferredEndpoint(
			[ep('http://a'), ep('http://b'), ep('http://c')],
			async e => {
				if (e.url === 'http://b') { throw new Error('refused'); }
				return e.url;
			},
			v => disposed.push(v),
		);
		assert.strictEqual(endpoint.url, 'http://a');
		assert.strictEqual(value, 'http://a', '返回的是胜者的连接');
		assert.deepStrictEqual(disposed, ['http://c'], 'b 没连上（无需关），只有 c 需要关，且恰好一次');
	});

	test('★ 只有靠后的候选成功时也算成功（用户没开调试、专属实例在跑）', async () => {
		const disposed: string[] = [];
		const { endpoint } = await connectPreferredEndpoint(
			[ep('http://a'), ep('http://b')],
			async e => {
				if (e.url === 'http://a') { throw new Error('refused'); }
				return e.url;
			},
			v => disposed.push(v),
		);
		assert.strictEqual(endpoint.url, 'http://b');
		assert.deepStrictEqual(disposed, [], '只有一个连上，没有落败的连接要关');
	});

	test('★ 全部失败时抛**第一个**候选的错误（它的文案是给用户的引导）', async () => {
		await assert.rejects(
			() => connectPreferredEndpoint(
				[ep('http://a'), ep('http://b')],
				async e => { throw new Error(`boom:${e.url}`); },
				() => { },
			),
			/boom:http:\/\/a/,
		);
	});

	test('空候选：抛明确错误，而不是在读 settled[0] 时崩（调用方应保证至少一个）', async () => {
		await assert.rejects(
			() => connectPreferredEndpoint([], async () => 'x', () => { }),
			/候选端点为空/,
		);
	});

});
