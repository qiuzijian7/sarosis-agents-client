/*---------------------------------------------------------------------------------------------
 *  MCP 工具归属：**只认 `category`**（2026-10-12）。
 *
 *  起因：查证"IDE 侧 `mcp_<server>_<tool>` vs dsh 侧 `mcp__<server>__<tool>` 命名双轨"时，
 *  发现 `integrationView.ts` 的 MCP 重试补偿分支按 `tool.name.split('__')` 取 server ——
 *  我们的名字是**单**下划线 ⇒ 恒不分割 ⇒ 回落 `(tool as any).serverId`（`IToolDefinition`
 *  上没这个字段）⇒ 全部判成 `'unknown'` ⇒ ① UI 多出一个假服务器条目；② 本该清掉的
 *  「启动中」spinner 继续转。**分歧的代价不是审美，是错误的解析** ✗。
 *
 *  结论：两侧名字各自跟随上游（IDE 侧 = 上游 VS Code 的 `IMcpTool.id`；Host 侧 =
 *  `@deepseek-ai/dsh-mcp-client`），**不该统一**；该做的是把"归属"这件事收敛到
 *  `category`（`mcpServerIdOf` 单一真源 ✓）并用守卫钉住"不许解析名字"。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-mcpServerAttribution-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	MCP_TOOL_CATEGORY_PREFIX,
	isMcpSourcedTool,
	mcpServerIdOf,
} from '../../common/toolApprovalPolicy.js';
import type { IToolDefinition } from '../../common/providers.js';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';

function def(category?: string): IToolDefinition {
	return { name: 'x', description: '', inputSchema: {}, ...(category === undefined ? {} : { category }) };
}

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去注释 ⇒ 只对**活代码**断言（注释里会刻意引用被禁的写法作教训 ✓）。 */
function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter(line => !/^\s*\/\//.test(line))
		.map(line => line.replace(/\s\/\/.*$/, ''))
		.join('\n');
}

/** 域内全部非测试实现文件（与 fileSizeBudget / architectureBoundaries 同口径）。 */
function listTsFiles(relDir: string): string[] {
	const abs = path.join(process.cwd(), relDir);
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (['node_modules', 'webview', 'test', 'media'].includes(entry.name)) { continue; }
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) { continue; }
			out.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
		}
	};
	walk(abs);
	return out;
}

suite('MCP 工具归属 — mcpServerIdOf（category 唯一解析点）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('从 `mcp:<serverId>` 取 server id（原样大小写、含连字符）', () => {
		assert.strictEqual(mcpServerIdOf(def(`${MCP_TOOL_CATEGORY_PREFIX}foo`)), 'foo');
		assert.strictEqual(mcpServerIdOf(def(`${MCP_TOOL_CATEGORY_PREFIX}codebase-mem`)), 'codebase-mem');
		assert.strictEqual(mcpServerIdOf(def('mcp:codebase-mem')), 'codebase-mem', '前缀常量必须仍是 "mcp:"');
		assert.strictEqual(mcpServerIdOf(def('MCP:Foo')), 'Foo', '前缀判定大小写不敏感，但 id 原样返回');
	});

	test('非 MCP 来源 / 缺失定义 / 空前缀 ⇒ undefined（不得返回空串）', () => {
		assert.strictEqual(mcpServerIdOf(def('filesystem')), undefined);
		assert.strictEqual(mcpServerIdOf(def()), undefined);
		assert.strictEqual(mcpServerIdOf(undefined), undefined);
		assert.strictEqual(mcpServerIdOf(def('mcp:')), undefined,
			'空 id 必须返回 undefined —— 返回 "" 会让调用方把"没拿到"当成"拿到了" ✗');
	});

	test('★ `isMcpSourcedTool` ⇒ `mcpServerIdOf`（解析出 id 必是 MCP；反之不成立）', () => {
		const samples = [def('mcp:foo'), def('mcp:'), def('MCP:bar'), def('filesystem'), def(), undefined];
		for (const s of samples) {
			if (mcpServerIdOf(s) !== undefined) {
				assert.strictEqual(isMcpSourcedTool(s), true,
					`解析出了 server id 却不是 MCP 来源：${JSON.stringify(s?.category)}`);
			}
		}
		// 退化情形（空 id）必须**显式**钉住：两函数在这里**应当**不一致 ——
		//   它仍是 MCP 来源（审批通道必须拦，见 toolApprovalPolicy 的论证），
		//   但拿不到 server 归属（调用方须按 'unknown' 跳过）。
		//   ⚠ 别把这条"改成同真同假"：那会让 `mcp:` 要么漏审批、要么被当成合法服务器 ✗。
		assert.strictEqual(isMcpSourcedTool(def('mcp:')), true, '空 id 仍是 MCP 来源（审批依赖）');
		assert.strictEqual(mcpServerIdOf(def('mcp:')), undefined, '但归属拿不到 ⇒ 调用方须跳过');
	});
});

suite('MCP 工具归属 — 跨源码守卫（不许从工具名解析 server）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★ `integrationView.ts` 不得解析工具名，必须走 mcpServerIdOf', () => {
		const code = stripComments(readSource(`${DOMAIN_REL}/browser/views/integrationView.ts`));

		const badSplit = code.split('\n').filter(l => /\.name\.split\(/.test(l) || /\(tool as any\)\.serverId/.test(l));
		assert.deepStrictEqual(badSplit, [],
			'工具名不能用来推 server（`mcp_<server>_<tool>` 是**单**下划线，拆不出来 ✗）：\n' + badSplit.join('\n'));

		assert.ok(/mcpServerIdOf\(/.test(code),
			'integrationView 必须经 mcpServerIdOf（category 单一真源）解析归属 ✗');
		assert.ok(/serverId === 'unknown'/.test(code),
			'解析不出（unknown）必须跳过 —— 否则会往 mcpServers 里塞一个假服务器 ✗');
	});

	test('★★ 全域：`category` 的 MCP 前缀解析只准出现在 toolApprovalPolicy（单一解析点）', () => {
		const allow = `${DOMAIN_REL}/common/toolApprovalPolicy.ts`;
		const violations: string[] = [];
		for (const rel of listTsFiles(DOMAIN_REL)) {
			if (rel === allow) { continue; }
			const code = stripComments(readSource(rel));
			if (/\.replace\(\s*\/\^mcp:/.test(code)) {
				violations.push(rel);
			}
		}
		assert.deepStrictEqual(violations, [],
			'自造的 `category.replace(/^mcp:/, "")` 请改用 mcpServerIdOf（否则又多一个解析点 ✗）：\n' + violations.join('\n'));
	});

	test('★ `_toDefinition` 必须用 MCP_TOOL_CATEGORY_PREFIX 生成 category（不得退化成裸 "mcp"）', () => {
		const code = stripComments(readSource(`${DOMAIN_REL}/browser/providers/tool/mcpToolProvider.ts`));
		// 必须锚**定义**而不是首次出现：`listTools` 会先调用 `this._toDefinition(...)`，
		// 用 `_toDefinition(` 取到的会是调用点，切片必然错过方法体（本用例初版就是这么写错的 ✗）。
		const start = code.indexOf('private _toDefinition(');
		assert.ok(start > 0, '未找到 _toDefinition（改名了？守卫需同步 ✗）');
		const body = code.slice(start, code.indexOf('\n\t}', start) > 0 ? code.indexOf('\n\t}', start) : start + 2000);
		assert.ok(/MCP_TOOL_CATEGORY_PREFIX/.test(body),
			'_toDefinition 的 category 必须用 MCP_TOOL_CATEGORY_PREFIX 拼（审批与动态 toolset 都依赖它）✗');
	});
});
