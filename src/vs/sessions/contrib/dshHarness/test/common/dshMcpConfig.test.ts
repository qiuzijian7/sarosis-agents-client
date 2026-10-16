/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `~/.vssaros/mcp.json`（上游 mcp.json 格式）→ dsh MCP 覆盖层 的纯逻辑测试。
 *
 * 这里每一条都对应一个真实的坑：sse 在 dsh 侧没有传输、serverName 有字符集约束、
 * `${workspaceFolder}` 我们替换不了（只有工作区 id，没有目录）——**跳过并说明**，绝不把 `\${...}`
 * 当字面量传给服务器进程（那会变成"服务器莫名起不来"这种最难查的故障）。
 */

import assert from 'assert';
import { IDshMcpServerSpec, mcpRowId, parseMcpServers, renderMcpOverlay } from '../../common/dshMcpConfig.js';

function configOf(text: string, env: Record<string, string> = {}) {
	return parseMcpServers(text, env);
}

suite('dshHarness / MCP 配置 → 覆盖层', () => {

	test('stdio 服务器：字段映射与 ${env:X} 替换', () => {
		const { servers, skipped } = configOf(JSON.stringify({
			servers: {
				github: {
					type: 'stdio',
					command: '${env:NODE_BIN}',
					args: ['-y', '@modelcontextprotocol/server-github'],
					env: { GITHUB_TOKEN: '${env:TOKEN}' },
					cwd: 'C:\\work',
				},
			},
		}), { NODE_BIN: 'node', TOKEN: 'secret' });

		assert.deepStrictEqual(skipped, []);
		assert.deepStrictEqual(servers, [{
			serverName: 'github',
			transport: 'stdio',
			command: 'node',
			args: ['-y', '@modelcontextprotocol/server-github'],
			env: { GITHUB_TOKEN: 'secret' },
			cwd: 'C:\\work',
		}]);
	});

	test('http 服务器 → streamable-http（url + headers）', () => {
		const { servers, skipped } = configOf(JSON.stringify({
			servers: { web: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${env:T}' } } },
		}), { T: 'abc' });
		assert.deepStrictEqual(skipped, []);
		assert.deepStrictEqual(servers, [{
			serverName: 'web',
			transport: 'streamable-http',
			url: 'https://mcp.example.com/mcp',
			headers: { Authorization: 'Bearer abc' },
		}]);
	});

	test('缺 type 但有 command 视为 stdio（上游 schema 的写法之一）', () => {
		const { servers } = configOf(JSON.stringify({ servers: { local: { command: 'node', args: ['server.js'] } } }));
		assert.strictEqual(servers.length, 1);
		assert.strictEqual(servers[0].transport, 'stdio');
	});

	test('sse 服务器被跳过并说明（dsh 无该传输）', () => {
		const { servers, skipped } = configOf(JSON.stringify({ servers: { legacy: { type: 'sse', url: 'https://x/sse' } } }));
		assert.deepStrictEqual(servers, []);
		assert.strictEqual(skipped.length, 1);
		assert.match(skipped[0].reason, /sse/);
	});

	test('服务器名不满足 dsh 字符集 [A-Za-z0-9_-]{1,32} 时跳过', () => {
		const { servers, skipped } = configOf(JSON.stringify({ servers: { 'bad name!': { command: 'node' } } }));
		assert.deepStrictEqual(servers, []);
		assert.match(skipped[0].reason, /A-Za-z0-9_-/);
	});

	test('${workspaceFolder} 之类解析不了的占位符：跳过并说明，不传字面量', () => {
		const { servers, skipped } = configOf(JSON.stringify({
			servers: { ws: { type: 'stdio', command: 'node', args: ['${workspaceFolder}/server.js'] } },
		}));
		assert.deepStrictEqual(servers, []);
		assert.match(skipped[0].reason, /占位符/);
	});

	test('command 缺省 / 非法结构 / 坏 JSON 都有可读原因', () => {
		assert.match(configOf(JSON.stringify({ servers: { a: { type: 'stdio' } } })).skipped[0].reason, /command/);
		assert.match(configOf(JSON.stringify({ servers: { a: 'nope' } })).skipped[0].reason, /不是对象/);
		assert.match(configOf('{ not json').skipped[0].reason, /不是合法 JSON/);
		assert.match(configOf('[]').skipped[0].reason, /没有 servers 对象/);
	});

	test('覆盖层：一行一个 dsh-mcp-client，id 稳定、含 serverName/transport 与配置', () => {
		const specs: IDshMcpServerSpec[] = [
			{ serverName: 'github', transport: 'stdio', command: 'C:\\Program Files\\node.exe', args: ['-y', 'pkg'], env: { TOKEN: 'a\'b' } },
			{ serverName: 'web', transport: 'streamable-http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
		];
		const yml = renderMcpOverlay(specs);
		assert.ok(yml.includes('- id: mcp-github'), yml);
		assert.ok(yml.includes('- id: mcp-web'));
		assert.strictEqual((yml.match(/@deepseek-ai\/dsh-mcp-client/g) ?? []).length, 2);
		assert.ok(yml.includes("serverName: 'github'"));
		assert.ok(yml.includes("transport: 'stdio'"));
		// 单引号标量里反斜杠不转义（YAML 语义），所以输出就是原样的 Windows 路径
		assert.match(yml, /command: 'C:\\Program Files\\node\.exe'/);
		assert.match(yml, /args: \['-y', 'pkg'\]/);
		assert.ok(yml.includes("TOKEN: 'a''b'"), '单引号要转义成两个');
		assert.ok(yml.includes("transport: 'streamable-http'"));
		assert.ok(yml.includes("url: 'https://x/mcp'"));
		assert.ok(yml.includes("Authorization: 'Bearer t'"));
		// 回归保护（真机实测踩过）：多个顶层 `- insert:` 只会被认第一个，后面的服务器的行会**静默消失**
		assert.strictEqual((yml.match(/^- insert:/gm) ?? []).length, 1, '只能有一个顶层 insert 块');
		assert.strictEqual(mcpRowId('weird-name_1'), 'mcp-weird-name_1');
		assert.strictEqual(renderMcpOverlay([]).trim().split('\n').filter(l => l.startsWith('-')).length, 0, '空列表只留注释');
	});
});
