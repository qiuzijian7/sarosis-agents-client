/*---------------------------------------------------------------------------------------------
 *  unrealTerminalView.test.ts — 终端风格 unreal 卡片**时间线版（方案 E）**正文单测（jsdom ✓）
 *
 *  ★ 本文件两条最重要的不变量（用户要求 ✓）：
 *    ①「**结果必须显示出来**」⇒ 正文里**不得有任何默认隐藏** ✗✓（`display:none`/`hidden` 即失败 ✗）
 *    ②「**限制高度且与 mockup 一致**」⇒
 *       · 结果面板上限 = **190px**（mockup plan E 的 Chrome 实测原值 ✓）
 *       · TS 常量与 CSS 值**必须相等** ✓（改一处忘另一处 ⇒ 红 ✗✓）
 *       · 限高只作用于**显示**：结果**数据必须全量在 DOM 里** ✓（61 行一行不少 ✓）
 *
 *  真机数据来自 `vscode-app-1790084962792.log`（:6274-6277 / :6227-6232 ✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/browser/agentChat/unrealTerminalView.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	UNREAL_BODY_MAX_HEIGHT_PX,
	UNREAL_CMD_VALUE_MAX_CHARS,
	UNREAL_CODE_SNIPPET_LIMIT,
	createUnrealTerminalBody,
	formatUnrealResult,
	readUnrealExit,
} from './unrealTerminalView.js';

const CSS_REL = 'src/vs/sessions/browser/agentChat/media/agentChat.css';
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/** 真机 exec 返回（逐字 ✓ 日志 6274-6277 ✓）。 */
const EXEC_REAL = '{\n  "ok": true,\n  "repr": null,\n  "output": "UE version: 5.8.1-0+UE5\\nproject dir: /Game/Demo"\n}';
/** 真机 health 返回（逐字 ✓ 日志 6227-6232 ✓）。 */
const HEALTH_REAL = '{\n  "status": "ok",\n  "project": "unknown",\n  "pid": 82016,\n  "uptime_seconds": 17\n}';

/** 递归找「所有被隐藏的元素」（用户硬要求的反面 ✓）。 */
function hiddenElements(root: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	root.querySelectorAll<HTMLElement>('*').forEach(el => {
		if (el.style && el.style.display === 'none') { out.push(el); }
		if (el.hasAttribute('hidden')) { out.push(el); }
	});
	return out;
}

/**
 * 取 CSS 里某个选择器**规则**的声明块 ✓（供"限高取值"断言 ✓）。
 * ⚠ 必须锚定「规则行首 + `{`」✗✓ —— 直接 `indexOf('.unreal-term-out')` 会**先命中复合选择器**
 *   `.unreal-term-failed .unreal-term-out { color: … }`（它排在主规则之前 ✓）⇒ 取到的块里
 *   当然没有 max-height ✗✓（本轮实测踩到 ✓ —— 测试助手自己错，不是实现错 ✓）。
 */
function cssBlock(selector: string): string {
	const css = read(CSS_REL);
	let at = css.indexOf(`\n${selector} {`);
	if (at < 0) { at = css.indexOf(`${selector} {`); }
	assert.ok(at > 0, `CSS 里必须存在 ${selector} 规则 ✗✓`);
	return css.slice(at, css.indexOf('}', at));
}

suite('unreal 终端卡 · 时间线版（方案 E ✓ 限高与 mockup 一致 ✓ 2026-09-22）', () => {

	test('★★★ 硬要求①：结果**默认可见** —— 正文里不得有任何隐藏元素 ✗✓', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [['code', 'print(1)']], code: 'print(1)',
			resultText: EXEC_REAL, status: 'done', durationMs: 349,
		});
		assert.deepStrictEqual(hiddenElements(el), [],
			'**不允许**任何 `display:none` / `hidden` ✗✓ —— 看不全必须靠滚动解决 ✓（用户要求 ✓）');
		const out = el.querySelector('.unreal-term-out') as HTMLElement;
		assert.ok(out, '结果面板必须存在 ✓');
		assert.ok(out.textContent!.includes('UE version: 5.8.1'),
			`结果内容必须真的在 DOM 里（实际「${out.textContent}」✗）`);
	});

	test('★★★ 硬要求②：限高只裁**显示**，不裁**数据** —— 61 行结果必须一行不少 ✓', () => {
		const many = Array.from({ length: 61 }, (_, i) => `/Game/Props/SM_Prop_${i}.SM_Prop_${i}`).join('\n');
		const el = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [], status: 'done',
			resultText: JSON.stringify({ ok: true, output: `${many}\n...[truncated for IPC]` }),
		});
		const out = (el.querySelector('.unreal-term-out') as HTMLElement).textContent!;
		const lines = out.split('\n');
		// ⚠ 61 行资产 + **1 行上游截断标记** = 62 行 ✓（`...[truncated for IPC]` 是它自己的一行 ✓）
		assert.strictEqual(lines.length, 62,
			`结果被 JS 截断了 ✗✓（实际 ${lines.length} 行，应为 62 = 61 行 + 截断标记行 ✓）`);
		assert.ok(out.includes('/Game/Props/SM_Prop_60.SM_Prop_60'), '最后一行必须在 ✓');
		assert.ok(out.includes('[truncated for IPC]'), '上游截断标记必须原样保留 ✓（如实 ✓）');
	});

	test('★★★ 限高常量 = CSS 里**本体**的 max-height（改一处忘另一处 ⇒ 红 ✗✓）', () => {
		const tl = cssBlock('.unreal-term .unreal-term-tl');
		assert.ok(tl.includes(`max-height: ${UNREAL_BODY_MAX_HEIGHT_PX}px`),
			`时间线本体上限必须 = ${UNREAL_BODY_MAX_HEIGHT_PX}px 实际块：${tl}`);
		assert.ok(tl.includes('overflow: auto'), '本体必须同时是**滚动容器**（唯一 ✓）');
		assert.strictEqual(UNREAL_BODY_MAX_HEIGHT_PX, 354,
			'354 = mockup plan E 实测整卡最坏 386px − 卡片头 32px ✓（与 mockup 一致 ✓）');
	});

	test('★★★ 用户反馈②：内部分区**不得自带滚动** —— 屏幕上只允许一根滚动条 ✗✓', () => {
		for (const sel of ['.unreal-term .unreal-term-code', '.unreal-term .unreal-term-out']) {
			const block = cssBlock(sel);
			assert.ok(block.includes('max-height: none'),
				`${sel} 不得自带限高 ✗✓（旧版在此各写一个 max-height ⇒ 出现 2~3 根滚动条 ✗ 用户实测反馈 ✓）`);
			assert.ok(block.includes('overflow: visible'),
				`${sel} 不得自带滚动 ✗✓（滚动权全部交给 .unreal-term-tl ✓）`);
		}
	});

	test('★★★ 时间线结构：轴 + 节点①②，顺序固定（请求在前、结果在后 ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [['code', 'print(1)']], code: 'print(1)',
			resultText: EXEC_REAL, status: 'done',
		});
		assert.ok(el.querySelector('.unreal-term-tl'), '必须有时间线容器 ✓');
		const nodes = el.querySelectorAll('.unreal-term-node');
		assert.strictEqual(nodes.length, 2, '恰好两个节点（请求 / 结果）✓');
		const heads = Array.from(el.querySelectorAll('.unreal-term-node-head')).map(h => h.textContent!);
		assert.ok(heads[0].startsWith('① 请求'), `节点①必须是"请求"（实际「${heads[0]}」✗）`);
		assert.ok(heads[1].startsWith('② 结果'), `节点②必须是"结果"（实际「${heads[1]}」✗）`);
		assert.ok(heads[1].includes('exit 0'), '节点②标题带出口状态 ✓');
		assert.ok((nodes[1] as HTMLElement).classList.contains('unreal-term-node-ok'), '成功节点须有 ok 类 ✓');
	});

	test('★★ 失败节点：`ok:false` ⇒ 节点带 bad 类 + `exit ✗` ✓（HTTP 200 ≠ Python 成功 ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [], status: 'done',
			resultText: '{\n  "ok": false,\n  "output": "Traceback…"\n}',
		});
		assert.ok(el.querySelector('.unreal-term-node-bad'), '失败节点必须有 bad 类 ✓');
		assert.ok(el.querySelector('.unreal-term-node-ok') === null, '不得同时有 ok 类 ✗✓');
		const exit = el.querySelector('.unreal-term-exit') as HTMLElement;
		assert.ok(exit.textContent!.includes('exit ✗'), `必须显式失败（实际「${exit.textContent}」✗）`);
		assert.ok(el.classList.contains('unreal-term-failed'), '整块失败态类（只染标签 ✓）');
		assert.ok((el.querySelector('.unreal-term-out') as HTMLElement).textContent!.includes('Traceback'),
			'失败也要把结果**显示出来** ✓（排查靠它 ✓）');
	});

	test('★★★ 真机 exec 契约：结果取 **output**（不是整坨 JSON ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [['code', 'print(1)']], code: 'print(1)',
			resultText: EXEC_REAL, status: 'done', durationMs: 349,
		});
		const out = (el.querySelector('.unreal-term-out') as HTMLElement).textContent!;
		assert.ok(out.includes('UE version: 5.8.1') && out.includes('project dir: /Game/Demo'));
		assert.strictEqual(out.includes('"ok"'), false, '不得把 JSON 键塞进结果面板 ✗✓');
		assert.strictEqual((el.querySelector('.unreal-term-exit') as HTMLElement).textContent, ' · exit 0');
	});

	test('★★ 真机 health 契约：扁平对象 ⇒ 终端式 `key = value` 四行 ✓', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_health', args: [], resultText: HEALTH_REAL, status: 'done',
		});
		const kv = el.querySelector('.unreal-term-kv') as HTMLElement;
		assert.ok(kv, '扁平对象必须走 kv 模式 ✓');
		assert.strictEqual(kv.querySelectorAll('.unreal-term-key').length, 4,
			'status / project / pid / uptime_seconds 四行 ✓');
		const text = kv.textContent!;
		for (const k of ['status', 'project', 'pid', 'uptime_seconds']) {
			assert.ok(text.includes(k), `必须显示字段名 ${k} ✓`);
		}
		assert.ok(text.includes('82016') && text.includes('unknown'), '字段值必须在 ✓');
	});

	test('★★ 嵌套对象（dump ✓）⇒ 美化 JSON（保留结构 ✓ 靠滚动看全 ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_dump', args: [], status: 'done',
			resultText: '{\n  "actor_label": "X",\n  "transform": { "location": { "x": 1 } }\n}',
		});
		const out = (el.querySelector('.unreal-term-out') as HTMLElement).textContent!;
		assert.ok(out.includes('"transform"') && out.includes('"location"'), '嵌套结构必须保留 ✓');
		assert.ok(out.includes('\n'), 'JSON 必须带缩进（可读 ✓）');
	});

	test('★ 纯文本结果（build 报告 ✓）⇒ 原样显示 + 无代码节点件', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_build', args: [], resultText: 'Building…\n[48/48] Link\nBUILD SUCCESSFUL', status: 'done',
		});
		assert.ok((el.querySelector('.unreal-term-out') as HTMLElement).textContent!.includes('BUILD SUCCESSFUL'));
		assert.strictEqual(el.querySelector('.unreal-term-code'), null, 'build 无代码 ⇒ 不得建代码块 ✗');
	});

	test('★★ 命令头：参数拼成 `key=value`（含引号的带引号 ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_help', args: [['symbol', 'unreal.Actor'], ['filter', 'has value']],
			resultText: '{"symbol":"unreal.Actor"}', status: 'done',
		});
		const cmd = (el.querySelector('.unreal-term-cmd') as HTMLElement).textContent!;
		assert.ok(cmd.startsWith('$ unreal_help '), `实际「${cmd}」✗`);
		assert.ok(cmd.includes('symbol=unreal.Actor'), '无空格值不加引号 ✓');
		assert.ok(cmd.includes('filter="has value"'), '含空格必须加引号 ✓');

		// ★ 2026-09-22 用户反馈①：`unreal_exec` 的 `code` 参数动辄几百字符 ⇒ 正文**必须截断** ✗✓
		//   （旧版把整段脚本内联进命令行 ⇒ 卡片被顶高几百像素 ✗，且与下方代码块完全重复 ✗）
		const longVal = 'x'.repeat(UNREAL_CMD_VALUE_MAX_CHARS + 40);
		const el2 = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [['code', longVal]], resultText: '{}', status: 'done',
		});
		const cmd2 = el2.querySelector('.unreal-term-cmd') as HTMLElement;
		assert.ok(cmd2.textContent!.length < UNREAL_CMD_VALUE_MAX_CHARS + 40,
			`超长参数必须截断（实际 ${cmd2.textContent!.length} 字符 ✗ ⇒ 会把卡片顶高 ✗）`);
		assert.ok(cmd2.textContent!.includes('…'), '截断必须显式标出 `…` ✓');
		const title = cmd2.getAttribute('title')!;
		assert.ok(title.includes(longVal), '**完整命令**必须挂在 title 上 ✓（截断不丢信息 ✓）');
		assert.strictEqual(title.includes('…'), false, 'title 里不得截断 ✗✓');
	});

	test('★ 空结果 ⇒ `(无输出)` 兜底（绝不空白 ✗✓）', () => {
		const el = createUnrealTerminalBody({ toolName: 'unreal_exec', args: [], resultText: '', status: 'running' });
		assert.strictEqual((el.querySelector('.unreal-term-out') as HTMLElement).textContent, '(无输出)');
	});

	test('★★ 截断如实标注 + 规模进结果节点（不额外占一段 ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_exec', args: [], status: 'done',
			resultText: 'abc\n...[truncated for IPC]',
		});
		const meta = el.querySelector('.unreal-term-meta') as HTMLElement;
		assert.ok(meta, '规模行必须存在 ✓');
		const text = meta.textContent!;
		assert.ok(text.includes('⚠ 已截断'), `截断必须标注（实际「${text}」✗✓）`);
		assert.ok(/\d+ 行 · \d+ 字符/.test(text), `规模必须在（实际「${text}」✗）`);
		assert.ok(el.querySelector('.unreal-term-foot') === null, '不应再有独立页脚段 ✗✓（方案 E 已并入节点 ✓）');
	});

	test('★ bridge 错误态 ⇒ `exit ✗ bridge 不可达`（错误文案也必须显示出来 ✓）', () => {
		const el = createUnrealTerminalBody({
			toolName: 'unreal_health', args: [], status: 'error',
			resultText: 'bridge 不可达：http://127.0.0.1:8765/bridge/health — ECONNREFUSED',
		});
		assert.strictEqual((el.querySelector('.unreal-term-exit') as HTMLElement).textContent, ' · exit ✗ bridge 不可达');
		assert.ok((el.querySelector('.unreal-term-out') as HTMLElement).textContent!.includes('ECONNREFUSED'));
	});

	test('★ 代码片段超限 ⇒ 截断并标注（与旧实现同语义 ✓）', () => {
		const longCode = 'x'.repeat(UNREAL_CODE_SNIPPET_LIMIT + 100);
		const el = createUnrealTerminalBody({ toolName: 'unreal_exec', args: [], code: longCode, resultText: '{}', status: 'done' });
		const code = (el.querySelector('.unreal-term-code') as HTMLElement).textContent!;
		assert.ok(code.endsWith('… (已截断)'), '超限必须标注 ✓');
		assert.strictEqual(code.length, UNREAL_CODE_SNIPPET_LIMIT + '… (已截断)'.length + 1);
	});

	test('★★ 纯函数 `formatUnrealResult`：三种模式判定 + 内容字段优先 ✓', () => {
		assert.strictEqual(formatUnrealResult(EXEC_REAL).mode, 'text');
		assert.strictEqual(formatUnrealResult(EXEC_REAL).fromContentField, true);
		assert.strictEqual(formatUnrealResult(HEALTH_REAL).mode, 'kv');
		assert.strictEqual(formatUnrealResult('[1,2,3]').mode, 'json');
		assert.strictEqual(formatUnrealResult('plain text').mode, 'text');
		assert.strictEqual(formatUnrealResult('{ broken json').text, '{ broken json', '坏 JSON ⇒ 原样文本 ✓');
		assert.strictEqual(formatUnrealResult('   ').text, '(无输出)');
	});

	test('★★ 纯函数 `readUnrealExit`：四类失败都要显式标出 ✗✓', () => {
		assert.strictEqual(readUnrealExit('unreal_exec', EXEC_REAL, 'done').ok, true);
		assert.strictEqual(readUnrealExit('unreal_exec', '{"ok":false}', 'done').ok, false);
		assert.strictEqual(readUnrealExit('unreal_health', '{"status":"degraded"}', 'done').ok, false);
		assert.strictEqual(readUnrealExit('unreal_health', 'ECONNREFUSED', 'done').ok, false);
		assert.strictEqual(readUnrealExit('unreal_exec', '{}', 'error').ok, false, '状态 error ⇒ 失败 ✓');
	});

	test('★★★ CSS：结果面板必须可换行 + 选择器带前缀（防被 0,1,1 级通用规则静默覆盖 ✗✓）', () => {
		const outCss = cssBlock('.unreal-term .unreal-term-out');
		assert.ok(outCss.includes('white-space: pre-wrap'), '长行必须换行 ✓（终端里长 JSON 行最常见的坑 ✓）');
		assert.ok(outCss.includes('word-break: break-word'), '长 token 必须能断行 ✓');
		const css = read(CSS_REL);
		const at = css.indexOf('.unreal-term .unreal-term-tl');
		assert.ok(at > 0,
			'时间线本体必须用 `.unreal-term .unreal-term-tl`（0,2,0 ✓）—— 裸类名会被 0,1,1 级通用规则覆盖 ✗✓（用户反馈① 的放大器 ✓）');
		assert.ok(css.includes('.unreal-term-node-ok'), '时间线容器样式必须存在 ✓');
		assert.ok(css.includes('.unreal-term-node-ok'), '成功节点色必须存在 ✓');
		assert.ok(css.includes('.unreal-term-node-bad'), '失败节点色必须存在 ✓');
		assert.ok(css.includes('.unreal-term-kv'), 'kv 模式样式必须存在 ✓');
		assert.ok(css.includes('.unreal-term-exit'), 'exit 样式必须存在 ✓');
		assert.ok(css.includes('.unreal-term-failed'), '失败态样式必须存在 ✓');
	});

	test('★ CSS：本体限高必须配 `overflow: auto`（只裁不滚 ⇒ 用户就真看不到结果了 ✗✓）', () => {
		const block = cssBlock('.unreal-term .unreal-term-tl');
		assert.ok(/max-height:\s*\d+px/.test(block), '本体必须有像素上限 ✓');
		assert.ok(block.includes('overflow: auto'), '本体限高必须配 overflow: auto ✗✓');
	});
});
