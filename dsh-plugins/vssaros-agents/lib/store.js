// @vssaros/dsh-agents — store（主机侧 I/O）：数据根解析 + agent 目录扫描。只读，不声明 `owns`。
//
// 数据根口径与 kanban / skills 一致：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`。
// agent 根：`<数据根>/agents/<id>/.agent.md`（与 IDE 的 `_getSarosAgentsDir()` 同一处）。
//
// ✅ 2026-10-19 **缺口已补上**（原先记的是"v0 不覆盖"）：内置 agent 现在经
//   `config.agentsBuiltinRoot` 交付 —— Host 启动期由代码真源（`common/builtinAgents.ts`）生成
//   md 副本到 runDir（`dshHostSupervisor._writeBuiltinAgentsDir`），再把该目录写进覆盖层。
//   ⚠ 真源**只有** IDE 那份代码；`resources/.agents/agents/` 已删除，这里的目录是**产物**
//   （与 skills 的 `bundledSkillDir` 同一类道理：产品侧的东西用绝对路径交付给读不到源码的进程 ⇒
//   内置技能/内置 agent 都活在同一层设计里）。没注入 ⇒ 退回"只列自定义"（不报错 ✓）。

import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { AGENT_FILE, agentFromFile } from './core/agents.js';
import { pluginOverridesFromAgentMd } from './core/create.js';

/** 数据根。优先级：`config.dataRoot` → 环境变量 → `~/.vssaros`。 */
export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

/** agent 根：`config.agentsRoot`（测试/特殊部署）→ `<数据根>/agents`。 */
export function agentsRootOf(config) {
	const configured = typeof config?.agentsRoot === 'string' ? config.agentsRoot.trim() : '';
	return configured || join(dataRootOf(config), 'agents');
}

const agentSources = new Map();
const sourceRootOf = (config) => {
	const root = resolve(agentsRootOf(config));
	return process.platform === 'win32' ? root.toLowerCase() : root;
};

/** 注册已解析的插件 Bot 数组；同根 owner/id 互斥，返回只撤销本次注册的幂等函数。 */
export function registerAgentSource(config, source) {
	const owner = typeof source?.owner === 'string' ? source.owner.trim() : '';
	if (!owner) { throw new Error('agent source owner 不能为空'); }
	if (!Array.isArray(source?.agents)) { throw new Error('agent source agents 必须是数组'); }
	const root = sourceRootOf(config);
	const sources = agentSources.get(root) ?? new Map();
	if (sources.has(owner)) { throw new Error(`agent source owner 已注册：${owner}`); }
	const ids = new Set();
	const agents = source.agents.map((agent) => {
		if (!agent || typeof agent.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id)) {
			throw new Error('插件 Bot id 必须是已命名空间化的小写安全 id');
		}
		if (typeof agent.name !== 'string' || !agent.name.trim()) { throw new Error(`插件 Bot 缺 name：${agent.id}`); }
		if (ids.has(agent.id)) { throw new Error(`agent source 内 id 冲突：${agent.id}`); }
		for (const [otherOwner, rows] of sources) {
			if (rows.some(row => row.id === agent.id)) { throw new Error(`插件 Bot id 已注册：${agent.id}（owner：${otherOwner}）`); }
		}
		ids.add(agent.id);
		const row = structuredClone(agent);
		return { ...row, tools: Array.isArray(row.tools) ? row.tools : [], persona: typeof row.persona === 'string' ? row.persona : (typeof row.systemPrompt === 'string' ? row.systemPrompt : ''), source: 'plugin', sourceOwner: owner };
	});
	sources.set(owner, agents);
	agentSources.set(root, sources);
	return () => {
		if (sources.get(owner) !== agents) { return; }
		sources.delete(owner);
		if (!sources.size && agentSources.get(root) === sources) { agentSources.delete(root); }
	};
}

function sourceMapping(value, label) {
	if (value === undefined) { return new Map(); }
	if (!(value instanceof Map) && (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))) {
		throw new Error(`agent source ${label} 必须是 Map 或对象`);
	}
	const entries = value instanceof Map ? [...value] : Object.entries(value);
	if (entries.some(([key, target]) => typeof key !== 'string' || !key.trim() || typeof target !== 'string' || !target.trim())) {
		throw new Error(`agent source ${label} 映射必须是非空字符串`);
	}
	return new Map(entries);
}

export async function parseAgentSource(source) {
	if (source?.agents !== undefined) {
		if (!Array.isArray(source.agents)) { throw new Error('agent source agents 必须是数组'); }
		if (source.root !== undefined || source.ids !== undefined) { throw new Error('agent source 数组与 root 声明不能混用'); }
		return source;
	}
	if (typeof source?.root !== 'string' || !isAbsolute(source.root) || basename(source.root) !== 'bots') {
		throw new Error('agent source root 必须是包内 bots 的绝对目录');
	}
	if (source.ids === undefined) { throw new Error('agent source root 必须声明 ids 映射'); }
	const ids = sourceMapping(source.ids, 'ids');
	for (const [id, target] of ids) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) { throw new Error('插件 Bot id 声明或命名空间 id 非法'); }
	}
	const skills = sourceMapping(source.skills, 'skills');
	const tools = sourceMapping(source.tools, 'tools');
	const mcp = [...sourceMapping(source.mcp, 'mcp')].sort(([a], [b]) => b.length - a.length);
	const root = resolve(source.root);
	const base = await realpath(root);
	await Promise.all([...ids.keys()].map(async id => {
		const file = await realpath(join(root, id, AGENT_FILE));
		const rel = relative(base, file);
		if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) { throw new Error(`插件 Bot 文件逃逸 bots 目录：${id}`); }
	}));
	const scan = await scanAgents(root, undefined, { ids: new Set(ids.keys()) });
	if (scan.errors.length) { throw new Error(`插件 Bot 解析失败：${scan.errors.join('；')}`); }
	const mappedTools = (entries) => [...new Set(entries.flatMap(entry => {
		const deny = entry.startsWith('!') ? '!' : '';
		const name = deny ? entry.slice(1) : entry;
		for (const [id, target] of mcp) {
			const prefix = `mcp__${id}__`;
			if (name.startsWith(prefix)) { return [`${deny}mcp__${target}__${name.slice(prefix.length)}`]; }
		}
		if (tools.has(name)) { return [deny + tools.get(name)]; }
		if (name.endsWith('*')) {
			const matches = [...tools].filter(([id]) => id.startsWith(name.slice(0, -1)));
			if (matches.length) { return matches.map(([, target]) => deny + target); }
		}
		return [entry];
	}))];
	const agents = [...ids].map(([id, target]) => {
		const file = join(root, id, AGENT_FILE);
		const row = scan.agents.find(agent => agent.file === file);
		if (!row || row.id !== id) { throw new Error(`插件 Bot id 与目录声明不一致：${id}`); }
		return { ...row, id: target, skills: (row.skills ?? []).map(name => skills.get(name) ?? name), tools: mappedTools(row.tools) };
	});
	return { ...source, agents };
}

/**
 * **内置** agent 根：`config.agentsBuiltinRoot`（Host 启动期由代码真源生成的 md 副本目录）。
 * ⚠ 它是**产物**不是真源 —— 真源只有 IDE 侧的 `common/builtinAgents.ts`；
 *   `resources/.agents/agents/` 已删除，Host 读不到产品源码 ⇒ 只能这样交付。
 *   没注入 ⇒ 返回 undefined（只列自定义 agent，与 2026-10-19 之前的行为一致 ✓ 不会更糟）。
 */
export function agentsBuiltinRootOf(config) {
	const configured = typeof config?.agentsBuiltinRoot === 'string' ? config.agentsBuiltinRoot.trim() : '';
	return configured || undefined;
}

/**
 * 扫**两个**根并合并：内置（`agentsBuiltinRoot`）+ 自定义（`agentsRoot`）。
 *
 * ★ 同 id 时**自定义优先**：用户在设置里改过的内置 agent 会落在用户目录
 *   （IDE 侧 getAgents 的第 2 级"用户覆写"）⇒ 那份必须赢，否则用户的改动被内置覆盖 ✗。
 *
 * ⚠ 内置那份**可能不存在**（老 Host / 没注入）⇒ 忽略其 missing，不把它算成错误
 *   （"没有内置目录"是降级，不是故障；只列自定义即可 ✓）。
 */
export async function scanAgentsFromConfig(config, signal) {
	const builtinRoot = agentsBuiltinRootOf(config);
	// ★ 2026-10-29：内置根与自定义根**并发**扫（两个根各 21/10 个 agent，
	//   串行就是两倍等待）⇒ 结果与顺序不变。
	const [builtinResult, customResult] = await Promise.all([
		(async () => {
			if (!builtinRoot) { return { agents: [], errors: [], missing: undefined, fingerprint: undefined }; }
			try {
				return await scanAgents(builtinRoot, signal);
			} catch (e) {
				return { agents: [], errors: [`内置 agent 目录读取失败（${builtinRoot}）：${String(e?.message ?? e)}`], missing: undefined, fingerprint: undefined };
			}
		})(),
		(async () => scanAgents(agentsRootOf(config), signal))(),
	]);
	const builtin = builtinResult;
	const custom = customResult;
	const byId = new Map();
	// `source` 决定"能不能给用户看"（内置的 code-architect/coder 那些只是内部子代理）。
	// ★ 2026-10-20：判定改为 `isShownAgent`（core/agents.js）——内置必须 `.agent.md` 写了
	//   `userFacing: true` 才展示（与 IDE 的 `USER_FACING_BUILTIN_AGENT_IDS` 由守卫 ⑤ 强绑定）；
	//   自定义永远可见。这里只负责把 `source` 标对，过滤别在本函数里各写一份 ✗。
	for (const a of builtin.agents) { byId.set(a.id, { ...a, source: 'builtin' }); }
	const sources = [...(agentSources.get(sourceRootOf(config))?.entries() ?? [])];
	const pluginAgents = sources.flatMap(([, agents]) => structuredClone(agents));
	for (const a of pluginAgents) { byId.set(a.id, a); }
	const overlayErrors = [];
	for (const a of custom.agents) {
		const record = a.pluginOverrides;
		if (!record) { byId.set(a.id, { ...a, source: 'custom' }); continue; }
		const plugin = pluginAgents.find(row => row.id === a.id);
		if (plugin && record.owner !== plugin.sourceOwner) {
			overlayErrors.push(`插件覆写 owner 不匹配：${a.id}`);
			byId.set(a.id, { ...a, source: 'custom', sourceOwner: record.owner });
			continue;
		}
		const row = { ...(plugin ?? a), file: a.file, source: 'custom', sourceOwner: record.owner, pluginOverrides: structuredClone(record) };
		for (const [field, value] of Object.entries(record.delta)) {
			if (field === 'workspacesRead' || field === 'workspacesWrite') {
				row.workspaces = { ...(row.workspaces ?? {}), [field === 'workspacesRead' ? 'read' : 'write']: structuredClone(value) };
			} else if (field === 'memoryChars' && value === null) {
				delete row.memoryChars;
			} else {
				row[field] = structuredClone(value);
			}
		}
		byId.set(a.id, row);
	}
	return {
		agents: [...byId.values()],
		sourceAgentIds: pluginAgents.map(a => a.id),
		sourceAgents: structuredClone(pluginAgents),
		errors: [...(builtin.errors ?? []), ...(custom.errors ?? []), ...overlayErrors],
		root: custom.root,
		missing: custom.missing,
		fingerprint: `${builtin.fingerprint ?? 'absent'}|${custom.fingerprint ?? 'absent'}${sources.length ? `|${JSON.stringify(sources)}` : ''}`,
	};
}

async function fingerprintOf(root) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name).sort().join(',');
	} catch {
		return 'absent';
	}
}

/**
 * **廉价、内容敏感的源文件签名**（P0-2）。
 *
 * 与 `scanAgentsFromConfig` 不同：这里只读目录 + `.agent.md` 的 `mtimeMs/size`，不读正文、
 * 不解析 Markdown、不构造 preset 定义。Windows 上真机每个 `.agent.md` 的 readFile 可能被
 * 杀软放大到几百毫秒，而 stat 可以并发且廉价 ⇒ 用它做 syncPresets 的前置短路判据。
 */
async function quickRootSignature(root) {
	if (!root) { return 'absent'; }
	try {
		const entries = await readdir(root, { withFileTypes: true });
		const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
		const parts = await Promise.all(dirs.map(async (id) => {
			try {
				const info = await stat(join(root, id, AGENT_FILE));
				return info.isFile() ? `${id}:${Math.round(info.mtimeMs)}:${info.size}` : null;
			} catch {
				return null;
			}
		}));
		return parts.filter(Boolean).join(',');
	} catch {
		return 'absent';
	}
}

/** 稳定序列化插件注入的 agent 源；畸形数据退回 id 列表，签名宁可变化也不抛错。 */
function sourceSignature(entries) {
	return [...entries]
		.sort(([a], [b]) => String(a).localeCompare(String(b)))
		.map(([owner, agents]) => {
			const rows = Array.isArray(agents) ? agents : [];
			const payload = rows.map((agent) => {
				try {
					return `${agent?.id ?? ''}:${JSON.stringify(agent)}`;
				} catch {
					return `${agent?.id ?? ''}:unserializable`;
				}
			}).sort().join(',');
			return `${String(owner)}:${payload}`;
		})
		.join('|');
}

/** 内置根 + 自定义根 + 内存插件 Bot 源的稳定签名；只读 stat，不读正文。 */
export async function quickScanSignatureOf(config) {
	const builtinRoot = agentsBuiltinRootOf(config);
	const [builtinSig, customSig] = await Promise.all([
		builtinRoot ? quickRootSignature(builtinRoot) : Promise.resolve('absent'),
		quickRootSignature(agentsRootOf(config)),
	]);
	const sources = [...(agentSources.get(sourceRootOf(config))?.entries() ?? [])];
	return createHash('sha256')
		.update(`${builtinSig}|${customSig}|${sourceSignature(sources)}`)
		.digest('hex');
}

/**
 * 扫描 agent 根：每个子目录一个 `.agent.md`。
 * 返回 `{ agents, errors, root, missing }`——坏文件带原因进 errors，**不丢其它 agent**。
 * （目录里没有 `.agent.md` 属正常，跳过；不把它当错误刷屏。）
 */
export async function scanAgents(root, signal, { ids } = {}) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { agents: [], errors: [], root, missing: root, fingerprint: 'absent' };
		}
		throw new Error(`agent 目录读取失败（${root}）：${e?.message ?? e}`);
	}
	const dirs = entries.filter(e => e.isDirectory() && (!ids || ids.has(e.name))).map(e => e.name).sort();
	const agents = [];
	const errors = [];
	// ★★ 2026-10-29（真机：加了 agents 覆盖层后 Host ready 从 **7s 变 21s**）：
	//   原来 31 个 agent（21 内置 + 10 自定义）逐个**串行** `stat` + `readFile`。
	//   Windows 上每次读文件都被杀软扫一遍（实测 ~450ms/文件）⇒ 合计 ~14 秒，
	//   而 dsh 的 ready 在等这个插件的 apply ⇒ **首启慢 14 秒全是这里** ✗✗。
	//   ⇒ 改成**并发**读：IO 等待重叠（杀软也能批量处理），结果与顺序完全不变。
	const results = await Promise.all(dirs.map(async (dir) => {
		if (signal?.aborted) {
			return null;
		}
		const file = join(root, dir, AGENT_FILE);
		try {
			const info = await stat(file);
			if (!info.isFile()) {
				return null;
			}
		} catch {
			return null; // 没有 .agent.md 的目录：正常（如 agents/custom 只是容器）
		}
		let text;
		try {
			text = await readFile(file, { encoding: 'utf8' });
		} catch {
			return { error: `读取失败：${file}` };
		}
		const parsed = agentFromFile(text, { id: dir, file });
		if (parsed.error) {
			return { error: parsed.error };
		}
		const record = pluginOverridesFromAgentMd(text);
		if (record?.error) { return { error: `${record.error}：${file}` }; }
		return { agent: { ...parsed.agent, ...(record ? { pluginOverrides: record } : {}) } };
	}));
	// 还原成"按目录名排序"的稳定顺序（并发完成顺序是乱的 ⇒ 不能直接 push）。
	for (const r of results) {
		if (!r) { continue; }
		if (r.error) { errors.push(r.error); } else { agents.push(r.agent); }
	}
	return { agents, errors, root, fingerprint: await fingerprintOf(root) };
}
