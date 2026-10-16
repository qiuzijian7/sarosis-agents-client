// @vssaros/dsh-mcp — 纯逻辑核：把 `~/.vssaros/mcp.json` 归一化成 dsh 的口径 + 渲染只读片段。
//
// ⚠ 本文件是 `src/vs/sessions/contrib/dshHarness/common/dshMcpConfig.ts` 的**宿主侧镜像**。
// 为什么必须有两份：方案 C（6.9）定的是"契约共享、实现各自一份"——`src/vs` **永久禁止** import
// `dsh-plugins/`（依赖面收敛），而插件也不能 import `src/vs`（它是运行时资源目录、不在插件依赖里）。
// 两份**逐条对齐**（含跳过原因的文案）由探针 `poc/dsh-p0/scripts/p3-18-mcp-page.mjs` 用同一批 fixture
// 跑两侧做**差分断言**：谁改了一侧而没改另一侧，探针先红。
//
// 归一化规则（与 src/vs 那份逐条一致，依据见那边的注释）：
//   · `type: 'stdio'` → `transport: 'stdio'`（缺 command ⇒ 跳过）
//   · `type: 'http'`  → `transport: 'streamable-http'`（缺 url ⇒ 跳过）
//   · `type: 'sse'`   → 跳过并说明（dsh 无该传输）
//   · 服务器名必须 `[A-Za-z0-9_-]{1,32}`
//   · `${env:X}` / `${X}` 用传入 env 替换；**残留任何 `${...}` 一律跳过**（绝不把占位符当字面量传出去）

/** dsh 的 serverName 约束（`dsh-mcp-client` 的字段说明）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 被 VsSaros/上游 `mcp.json` 允许、但 dsh 侧没有对应传输的类型。 */
const UNSUPPORTED_TRANSPORTS = {
	sse: 'dsh 的 dsh-mcp-client 只支持 stdio 与 streamable-http，不支持 sse',
};

/** `${env:VAR}` / `${VAR}` 变量替换；`env` 里没有的变量保留原样（由调用方按"仍有占位符"处理）。 */
function substituteEnv(text, env) {
	return text.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
		const value = env[name];
		return typeof value === 'string' ? value : full;
	});
}

/**
 * 解析 `mcp.json` 文本 → `{ servers, skipped }`（结构与方法名与 src/vs 那份一致，便于差分）。
 * @param {string} text
 * @param {Record<string, string | undefined>} [env]
 */
export function parseMcpServers(text, env = process.env) {
	const servers = [];
	const skipped = [];
	let root;
	try {
		root = JSON.parse(text);
	} catch (e) {
		return { servers: [], skipped: [{ name: '(整个文件)', reason: `mcp.json 不是合法 JSON：${e?.message ?? e}` }] };
	}
	const entries = root?.servers;
	if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
		return { servers: [], skipped: [{ name: '(整个文件)', reason: 'mcp.json 里没有 servers 对象' }] };
	}
	const seen = new Set();
	for (const [name, raw] of Object.entries(entries)) {
		const skip = reason => skipped.push({ name, reason });
		if (!SERVER_NAME_RE.test(name)) {
			skip(`服务器名不满足 dsh 的 [A-Za-z0-9_-]{1,32}：${name}`);
			continue;
		}
		if (seen.has(name)) {
			skip('重名（dsh 侧重名会导致后续那条加载失败）');
			continue;
		}
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			skip('配置不是对象');
			continue;
		}
		const config = raw;
		const type = typeof config.type === 'string' ? config.type : '';
		const unsupported = UNSUPPORTED_TRANSPORTS[type];
		if (unsupported) {
			skip(unsupported);
			continue;
		}
		/** 占位符解析：解析不了返回 undefined（调用方跳过该服务器）。 */
		const resolve = value => {
			const substituted = substituteEnv(value, env);
			return substituted.includes('${') ? undefined : substituted;
		};
		const resolveMap = (rawMap, what) => {
			if (rawMap === undefined) {
				return {};
			}
			if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
				return { bad: `${what} 不是对象` };
			}
			const map = {};
			for (const [key, value] of Object.entries(rawMap)) {
				if (typeof value !== 'string') {
					continue;
				}
				const resolved = resolve(value);
				if (resolved === undefined) {
					return { bad: `${what}.${key} 的值里有无法解析的占位符（如 \${workspaceFolder}）` };
				}
				map[key] = resolved;
			}
			return Object.keys(map).length ? { map } : {};
		};
		const resolveList = (rawList, what) => {
			if (rawList === undefined) {
				return {};
			}
			if (!Array.isArray(rawList)) {
				return { bad: `${what} 不是数组` };
			}
			const list = [];
			for (const item of rawList) {
				if (typeof item !== 'string') {
					continue;
				}
				const resolved = resolve(item);
				if (resolved === undefined) {
					return { bad: `${what} 里有无法解析的占位符（如 \${workspaceFolder}）` };
				}
				list.push(resolved);
			}
			return list.length ? { list } : {};
		};

		if (type === 'stdio' || (!type && typeof config.command === 'string')) {
			const command = typeof config.command === 'string' ? resolve(config.command.trim()) : undefined;
			if (command === undefined) {
				skip(typeof config.command === 'string' ? `command 里有无法解析的占位符：${config.command}` : 'stdio 服务器缺 command');
				continue;
			}
			const argsResult = resolveList(config.args, 'args');
			if (argsResult.bad) {
				skip(argsResult.bad);
				continue;
			}
			const envResult = resolveMap(config.env, 'env');
			if (envResult.bad) {
				skip(envResult.bad);
				continue;
			}
			const cwd = typeof config.cwd === 'string' ? resolve(config.cwd) : undefined;
			if (typeof config.cwd === 'string' && cwd === undefined) {
				skip(`cwd 里有无法解析的占位符：${config.cwd}`);
				continue;
			}
			servers.push({
				serverName: name,
				transport: 'stdio',
				command,
				...(argsResult.list ? { args: argsResult.list } : {}),
				...(envResult.map ? { env: envResult.map } : {}),
				...(cwd ? { cwd } : {}),
			});
			seen.add(name);
			continue;
		}
		if (type === 'http') {
			const url = typeof config.url === 'string' ? resolve(config.url.trim()) : undefined;
			if (url === undefined) {
				skip(typeof config.url === 'string' ? `url 里有无法解析的占位符：${config.url}` : 'http 服务器缺 url');
				continue;
			}
			const headersResult = resolveMap(config.headers, 'headers');
			if (headersResult.bad) {
				skip(headersResult.bad);
				continue;
			}
			servers.push({
				serverName: name,
				transport: 'streamable-http',
				url,
				...(headersResult.map ? { headers: headersResult.map } : {}),
			});
			seen.add(name);
			continue;
		}
		skip(`未识别的 type：${type || '(缺省)'}（dsh 侧只认 stdio / http）`);
	}
	return { servers, skipped };
}

/** 计数摘要（页面自诊断用；`sse` 这类被跳过的也计数，便于"配置了但没生效"一眼可见）。 */
export function summarizeMcp(parsed) {
	const byTransport = { stdio: 0, 'streamable-http': 0 };
	for (const server of parsed.servers) {
		byTransport[server.transport] = (byTransport[server.transport] ?? 0) + 1;
	}
	return { servers: parsed.servers.length, skipped: parsed.skipped.length, byTransport };
}

export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 服务器一行的"端点"摘要：stdio 给命令行，http 给 url。 */
export function endpointOf(server) {
	return server.transport === 'stdio'
		? [server.command, ...(server.args ?? [])].join(' ')
		: String(server.url ?? '');
}

/**
 * 渲染片段（`view.kind=section`，宿主 = skills 页；也可单独打开自查）。
 * 只读、无副作用；`readError` / `missing` 都是**常态**（没配 MCP 的人很多），所以文案不写成报错口吻。
 */
export function renderSection({ path, exists, readError, parsed, toolCount, toolNote, toolList }) {
	const summary = summarizeMcp(parsed);
	/**
	 * 设置齿轮（2026-10-15，桥 `9 → 10`）：与**技能行**用同一套属性 `[data-sk-settings]` ⇒ 点击由宿主页
	 *（skills 页）那段**委派**处理器统一处理 ✓ —— 本片段没有自己的页内 JS（HTML 片段里 `<script>` 不会执行 ✗），
	 * 所以"谁来接这个点击"只能在宿主页那一处 ✓（单一实现，不会漂 ✗）。
	 */
	const settingsBtn = (kind, id, title) => `<button type="button" class="sk-gear" data-sk-settings data-sk-kind="${kind}" data-sk-id="${escapeHtml(id)}" title="${escapeHtml(title)}">\u2699</button>`;
	/**
	 * 工具 → 它所属的服务器名。
	 *
	 * 为什么按**已知服务器名**前缀匹配、而不是从 `mcp__<server>__<tool>` 里切一段：server 名里可能有下划线
	 *（`codebase_memory` 这类）⇒ 切割是**歧义**的 ✗；拿已知名单做前缀匹配则无歧义（取最长命中 ✓）。
	 */
	const ownerOfTool = toolName => {
		const n = String(toolName ?? '');
		let best = '';
		for (const server of parsed.servers) {
			const prefix = `mcp__${server.serverName}__`;
			if (n.indexOf(prefix) === 0 && server.serverName.length > best.length) { best = server.serverName; }
		}
		return best;
	};
	const toolsOfServer = serverName => (toolList ?? []).filter(tool => String(tool.name ?? '').indexOf(`mcp__${serverName}__`) === 0);
	// 行形态沿用本片段既有的 `.id` / `small` / `code` 三件：**宿主页（skills 页）的 CSS 认的就是它们**
	//（`.sk-pane-mcp li .id` / `li small` / `li code`，且被 p3-04 的"两处排版逐项相等"钉着 ✓）⇒
	// 这里**不另起一套 class、也不复制 CSS**（复制必然漂移 ✗；本片段本就是"寄居在那一页"的形态 ✓）。
	// 2026-10-15 的新增只有**齿轮**（`[data-sk-settings]`，交互由宿主页那段委派处理器统一接 ✓）。
	const serverRows = parsed.servers.map(server => {
		const tools = toolsOfServer(server.serverName);
		return `<li data-mcp-server-row data-mcp-server="${escapeHtml(server.serverName)}">`
			+ `<span class="id">${escapeHtml(server.serverName)}</span>`
			+ ` <small>${escapeHtml(server.transport)}${tools.length ? ` · ${tools.length} 工具` : ''}</small>`
			+ `<code>${escapeHtml(endpointOf(server))}</code>`
			+ settingsBtn('mcp', server.serverName, '设置（在编辑区修改 mcp.json）')
			+ '</li>';
	}).join('');
	const skipRows = parsed.skipped.map(item => `<li><span class="id">${escapeHtml(item.name)}</span> ${escapeHtml(item.reason)}</li>`).join('');
	const body = !exists
		? `<p class="empty">还没有 MCP 配置：<code>${escapeHtml(path)}</code> 不存在（VS Code 的 <code>mcp.json</code> 导出到这份文件后这里会出现）。</p>`
		: (readError
			? `<p class="empty">读不了配置：<code>${escapeHtml(readError)}</code></p>`
			: (summary.servers
				? `<ul>${serverRows}</ul>`
				: '<p class="empty">配置里没有可挂载的服务器（全部被跳过，原因见下）。</p>'));
	const skips = skipRows ? `<section><h2>跳过的服务器 <small>${summary.skipped}</small></h2><ul>${skipRows}</ul></section>` : '';
	return `<section data-vssaros-page="mcp-section" data-vssaros-mcp-state="${!exists ? 'missing' : (readError ? 'error' : (summary.servers ? 'ok' : 'empty'))}" data-vssaros-mcp-path="${escapeHtml(path)}" data-vssaros-mcp-servers="${summary.servers}" data-vssaros-mcp-skipped="${summary.skipped}" data-vssaros-mcp-stdio="${summary.byTransport.stdio}" data-vssaros-mcp-http="${summary.byTransport['streamable-http']}" data-vssaros-mcp-tools="${escapeHtml(toolCount)}">
<h2>MCP 服务器 <small>${summary.servers ? `挂载 ${summary.servers} 台` : '未挂载'}${summary.skipped ? ` · 跳过 ${summary.skipped}` : ''}</small></h2>
<p class="diag">真源：<code>${escapeHtml(path)}</code> · 模型可见的 MCP 工具：<code>${escapeHtml(toolCount)}</code>${toolNote ? `（${escapeHtml(toolNote)}）` : ''}</p>
<p class="diag">改这份文件后需<b>重启 Host</b> 才生效（dsh 的一台服务器一个组合行，只能靠启动时的覆盖层加行）。</p>
${(toolList ?? []).length ? `<section data-vssaros-mcp-tool-list="ready"><h2>模型可见的 MCP 工具 <small>${(toolList ?? []).length}</small></h2><ul>${toolList.map(tool => `<li data-vssaros-mcp-tool="${escapeHtml(tool.name)}"><span class="id">${escapeHtml(tool.name)}</span>${tool.description ? ` <small>${escapeHtml(String(tool.description).slice(0, 200))}</small>` : ''}`
		// 工具**不可单独配置**（它是服务器给的）⇒ 这里的齿轮指向**它所属的服务器**的设置，标题里写明归属 ✓
		// （"每条 item 都有设置按钮"是用户的要求 ✓；指向"能改的那个东西"才不是假按钮 ✓）
		+ (ownerOfTool(tool.name) ? settingsBtn('mcp', ownerOfTool(tool.name), `设置所属服务器（${ownerOfTool(tool.name)}）`) : '')
		+ '</li>').join('')}</ul></section>` : ''}
${body}
${skips}
</section>`;
}
