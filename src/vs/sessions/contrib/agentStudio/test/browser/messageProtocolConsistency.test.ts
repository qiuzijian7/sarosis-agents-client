/*---------------------------------------------------------------------------------------------
 *  Unit test: 消息白名单一致性守卫（2026-09-11 质量评估 P1）。
 *
 *  背景：`RequestType`（WebView → Host 的请求类型）在**两处**手动维护：
 *    - host   : browser/messageProtocol.ts
 *    - webview: webview/src/bridge/messageClient.ts
 *  文件里明写「kept in sync manually」——实测已漂移（host 223 项 vs webview 193 项），
 *  新增消息时漏改一处会导致 tsgo 报 TS2678（not comparable to RequestType）或运行时
 *  静默失败。
 *
 *  本测试直接**解析两份源码**的 `export type RequestType` 联合体字面量并比对集合，
 *  把「手动同步」变成「有测试守卫」，防止继续漂移。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 从源码里抽取 `export type RequestType = ... ;` 的联合体字面量集合。
 * 只匹配**行首 `| 'xxx'`** 形态（联合体成员写法），避免被同行注释里的引号污染。
 */
function extractRequestType(src: string): Set<string> {
	const start = src.indexOf('export type RequestType');
	assert.ok(start >= 0, '未找到 `export type RequestType` 声明');
	const end = src.indexOf(';', start);
	assert.ok(end > start, '未找到 RequestType 联合体结尾');
	const body = src.slice(start, end);
	const out = new Set<string>();
	for (const m of body.matchAll(/^\s*\|\s*'([^']+)'/gm)) {
		out.add(m[1]);
	}
	return out;
}

suite('消息白名单一致性（RequestType 两处手动同步 → 测试守卫）', () => {
	// 测试运行目录为仓库根（run-browser-test.mjs 约定）
	const root = process.cwd();
	const hostFile = path.join(root, 'src/vs/sessions/contrib/agentStudio/browser/messageProtocol.ts');
	const webviewFile = path.join(root, 'src/vs/sessions/contrib/agentStudio/webview/src/bridge/messageClient.ts');

	test('★ host 与 webview 的 RequestType 字面量集合必须一致', () => {
		const host = extractRequestType(fs.readFileSync(hostFile, 'utf8'));
		const webview = extractRequestType(fs.readFileSync(webviewFile, 'utf8'));

		const onlyHost = [...host].filter(x => !webview.has(x)).sort();
		const onlyWebview = [...webview].filter(x => !host.has(x)).sort();

		assert.deepStrictEqual(
			{ onlyHost, onlyWebview },
			{ onlyHost: [], onlyWebview: [] },
			`RequestType 白名单已漂移：\n` +
			`  仅 host 有（webview 需补）: ${onlyHost.join(', ') || '(无)'}\n` +
			`  仅 webview 有（host 需补）: ${onlyWebview.join(', ') || '(无)'}\n` +
			`修复：把缺失项补到对应文件，保持两处一致。`,
		);
	});

	test('本次会话新增的消息在两处都已登记', () => {
		const host = extractRequestType(fs.readFileSync(hostFile, 'utf8'));
		const webview = extractRequestType(fs.readFileSync(webviewFile, 'utf8'));
		for (const key of ['workflow.sessions.list', 'workflow.sessions.select']) {
			assert.ok(host.has(key), `host 缺 ${key}`);
			assert.ok(webview.has(key), `webview 缺 ${key}`);
		}
	});
});
