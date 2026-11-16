import { createHash } from 'node:crypto';

export const PLUGIN_RESOURCE_FILE = 'workbench.plugin.json';
export const UNIFIED_PLUGIN_RESOURCE_FILE = 'vssaros.plugin.json';
export const RESOURCE_KINDS = ['bots', 'skills', 'tools', 'mcp'];
export const PLUGIN_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function pluginProfileKind(profile) {
	if (profile === 'bot') { return 'agent'; }
	if (profile === 'workbench') { return 'workbench'; }
	throw new Error(`未知插件 profile：${String(profile)}`);
}

export function resourceId(owner, id) {
	const hash = createHash('sha256').update(`${owner}\0${id}`).digest('hex').slice(0, 10);
	return `wb-${hash}-${id.slice(0, 18).replace(/-$/, '')}`;
}

function relativeFile(path) {
	if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0')
		|| path.startsWith('/') || path.includes(':') || path.split('/').some(s => s === '..' || !s)) {
		throw new Error(`资源路径不合法：${String(path)}`);
	}
	return path.replace(/^\.\//, '');
}

/** 与 Bot 运行时的顶层标量身份规则一致；只做静态身份预检，不加载插件模块。 */
function validateBotIdentity(data, row) {
	const text = data.toString('utf8');
	const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!header) { throw new Error(`Bot 缺少完整 frontmatter：${row.path}`); }
	const identity = {};
	for (const line of header[1].split(/\r?\n/)) {
		const match = /^(id|name)\s*:\s*(.*)$/.exec(line);
		if (!match) { continue; }
		const key = match[1];
		if (Object.hasOwn(identity, key)) { throw new Error(`Bot frontmatter ${key} 重复：${row.path}`); }
		let value = match[2].trim();
		if (/^["']/.test(value)) {
			if (value.length < 2 || value.at(-1) !== value[0]) { throw new Error(`Bot frontmatter ${key} 引号未闭合：${row.path}`); }
			value = value.slice(1, -1);
		} else if (/^[\[\]{}|>&*!]/.test(value)) {
			throw new Error(`Bot frontmatter ${key} 必须是标量：${row.path}`);
		}
		identity[key] = value.trim();
	}
	if (!identity.name) { throw new Error(`Bot frontmatter 缺 name：${row.path}`); }
	if (identity.id !== undefined && (!ID_RE.test(identity.id) || identity.id !== row.id)) {
		throw new Error(`Bot frontmatter id 与资源声明不一致：${row.path}`);
	}
}

/** 只读取并归一化清单，不执行模块、不修改条目；旧工作台清单映射到 workbench profile。 */
export function getPluginResourceManifest(entries) {
	const files = new Map();
	for (const entry of entries) {
		if (files.has(entry.name)) { throw new Error(`包内文件重复：${entry.name}`); }
		files.set(entry.name, entry.data);
	}
	if (files.has(PLUGIN_RESOURCE_FILE) && files.has(UNIFIED_PLUGIN_RESOURCE_FILE)) {
		throw new Error(`不能同时携带 ${PLUGIN_RESOURCE_FILE} 和 ${UNIFIED_PLUGIN_RESOURCE_FILE}`);
	}
	const filename = files.has(UNIFIED_PLUGIN_RESOURCE_FILE) ? UNIFIED_PLUGIN_RESOURCE_FILE : PLUGIN_RESOURCE_FILE;
	if (!files.has(filename)) { return null; }
	let plan;
	try { plan = JSON.parse(files.get(filename).toString('utf8')); }
	catch { throw new Error(`${filename} 不是合法 JSON`); }
	if (plan?.schemaVersion !== 1) { throw new Error('插件清单需要 schemaVersion:1'); }
	const legacy = filename === PLUGIN_RESOURCE_FILE;
	if (legacy && plan.profile !== undefined && plan.profile !== 'workbench') { throw new Error('旧工作台清单只能使用 workbench profile'); }
	const profile = legacy ? 'workbench' : plan.profile;
	pluginProfileKind(profile);
	if (profile === 'workbench' || plan.workbench !== undefined) {
		if (!plan.workbench || typeof plan.workbench !== 'object' || Array.isArray(plan.workbench)
			|| typeof plan.workbench.title !== 'string' || !plan.workbench.title.trim()) {
			throw new Error('工作台清单需要 workbench.title');
		}
	}
	if (plan.primaryBot !== undefined && (!ID_RE.test(plan.primaryBot) || typeof plan.primaryBot !== 'string')) {
		throw new Error('primaryBot 必须是合法的 Bot id');
	}
	const defaultBot = plan.workbench?.defaultBot;
	if (defaultBot !== undefined && (typeof defaultBot !== 'string' || !ID_RE.test(defaultBot))) {
		throw new Error('workbench.defaultBot 必须是合法的 Bot id');
	}
	if (plan.primaryBot !== undefined && defaultBot !== undefined && plan.primaryBot !== defaultBot) {
		throw new Error('primaryBot 与 workbench.defaultBot 冲突，必须一致');
	}
	return { ...plan, profile, primaryBot: plan.primaryBot ?? (profile === 'workbench' ? defaultBot : undefined) };
}

/** 只校验数据及包内闭包，不执行第三方模块。 */
export function validatePluginResources(packageManifest, entries) {
	const plan = getPluginResourceManifest(entries);
	if (!plan) { return null; }
	const files = new Map(entries.map(entry => [entry.name, entry.data]));
	if (typeof packageManifest.version !== 'string' || !PLUGIN_SEMVER_RE.test(packageManifest.version)) {
		throw new Error(`版本不是完整 SemVer：${String(packageManifest.version)}`);
	}
	for (const path of files.keys()) {
		if (/(^|\/)(\.env(?:\..*)?|mcp-secrets\.json|\.credentials\..*|installed-packages\.json|session\..*)$/.test(path)) {
			throw new Error(`工作台包不允许携带用户凭据或运行数据：${path}`);
		}
	}
	for (const values of [packageManifest.dependencies, packageManifest.optionalDependencies]) {
		for (const spec of Object.values(values ?? {})) {
			if (typeof spec !== 'string' || /^(file:|link:|workspace:|[A-Za-z]:|\/)/.test(spec)) { throw new Error('插件依赖不能指向作者的本地目录'); }
		}
	}
	for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
		if (packageManifest.scripts?.[lifecycle]) { throw new Error(`商城工作台必须提供构建产物，不能执行安装脚本：${lifecycle}`); }
	}
	const main = packageManifest.exports?.['.'] ?? packageManifest.main;
	const client = packageManifest.exports?.['./client'];
	if (typeof main !== 'string' || !files.has(relativeFile(main))) { throw new Error('缺少插件 Host 入口（协议 v1 入口须为字符串）'); }
	if (packageManifest.main !== undefined && (typeof packageManifest.main !== 'string' || !files.has(relativeFile(packageManifest.main)))) {
		throw new Error('声明的 main 入口不存在');
	}
	const patch = packageManifest.dsh?.bundle?.patch;
	const patches = Array.isArray(patch) ? patch : [patch];
	if (!patches.length || patches.some(path => typeof path !== 'string' || !files.has(relativeFile(path)))) {
		throw new Error('缺少或不存在声明的 dsh.bundle.patch 入口');
	}
	if (plan.profile === 'workbench' || client !== undefined) {
		if (typeof client !== 'string' || !files.has(relativeFile(client))) { throw new Error('缺少工作台页面入口 exports["./client"]'); }
	}
	if (plan.profile === 'workbench' && (!Array.isArray(packageManifest.dsh?.client?.inject)
		|| !packageManifest.dsh.client.inject.includes('@vssaros/dsh-workbenches'))) {
		throw new Error('工作台客户端必须注入 @vssaros/dsh-workbenches');
	}
	if (plan.resources !== undefined && (!plan.resources || typeof plan.resources !== 'object' || Array.isArray(plan.resources))) {
		throw new Error('resources 必须是对象，各类资源均可省略');
	}
	for (const key of Object.keys(plan.resources ?? {})) {
		if (!RESOURCE_KINDS.includes(key)) { throw new Error(`未知资源类型：${key}`); }
	}
	const resources = {};
	for (const kind of RESOURCE_KINDS) {
		const rows = plan.resources?.[kind] ?? [];
		if (!Array.isArray(rows)) { throw new Error(`resources.${kind} 必须是数组`); }
		const seen = new Set();
		resources[kind] = rows.map(row => {
			if (!ID_RE.test(row?.id ?? '') || row.id.length > 64) { throw new Error(`${kind} 资源 id 不合法`); }
			if (seen.has(row.id)) { throw new Error(`${kind} 资源 id 重复：${row.id}`); }
			seen.add(row.id);
			const path = relativeFile(row.path);
			if (!files.has(path)) { throw new Error(`${kind} 声明的文件不存在：${path}`); }
			if (kind === 'bots') {
				if (path !== `bots/${row.id}/.agent.md`) { throw new Error('bots 必须使用 bots/<id>/.agent.md'); }
				validateBotIdentity(files.get(path), row);
			}
			if (kind === 'skills' && path !== `skills/${row.id}/SKILL.md`) { throw new Error('skills 必须使用 skills/<id>/SKILL.md'); }
			if (kind === 'tools' && !/^lib\/tools\/.+\.m?js$/.test(path)) { throw new Error('tools 必须指向 lib/tools 下的 JS 模块'); }
			if (kind === 'mcp') {
				let config;
				try { config = JSON.parse(files.get(path).toString('utf8')); }
				catch { throw new Error(`mcp 配置不是合法 JSON：${path}`); }
				const type = config.type ?? config.transport;
				if (!['http', 'stdio'].includes(type)) { throw new Error('插件 MCP 仅支持 http / stdio'); }
				if (type === 'http') {
					const url = new URL(config.url);
					if (url.protocol !== 'https:') { throw new Error('远程 MCP 必须使用 HTTPS'); }
					if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|api.?key|^key$/i.test(key))) {
						throw new Error('MCP URL 不能携带凭据，使用 query 环境变量引用');
					}
				}
				if (type === 'stdio') {
					if (typeof config.command !== 'string' || !config.command.trim()) { throw new Error('stdio MCP 缺 command'); }
					if (/^(?:[A-Za-z]:|\/)|\.\.|\\/.test(config.command)) { throw new Error('stdio command 不能指向作者本机路径'); }
					if (config.approved === true) { throw new Error('插件不能替使用者批准 stdio MCP'); }
					const cwd = config.cwd === undefined ? path.slice(0, path.lastIndexOf('/')) : relativeFile(config.cwd);
					if (!cwd || ![...files.keys()].some(file => file.startsWith(cwd.replace(/\/$/, '') + '/'))) { throw new Error('stdio cwd 必须是包内存在的相对目录'); }
				}
				for (const values of [config.headers, config.env, config.query]) {
					if (values !== undefined && (!values || typeof values !== 'object' || Array.isArray(values))) { throw new Error('MCP headers/env/query 必须是对象'); }
					for (const [key, value] of Object.entries(values ?? {})) {
						const reference = /authorization/i.test(key) ? /^(?:Bearer |Basic )?\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/ : /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
						if (typeof value !== 'string') { throw new Error('MCP 配置映射值必须是字符串'); }
						if (/authorization|token|secret|password|api.?key|^key$/i.test(key)
							&& !reference.test(value)) {
							throw new Error(`MCP 凭据只能使用环境变量引用：${path} / ${key}`);
						}
					}
				}
			}
			return { ...row, path, runtimeId: resourceId(packageManifest.name, row.id) };
		});
	}
	if (plan.profile === 'bot' && !resources.bots.length) { throw new Error('bot profile 必须至少声明一个 Bot（resources.bots）'); }
	if (plan.profile === 'bot' && !plan.primaryBot) { throw new Error('bot profile 必须指定 primaryBot'); }
	if (plan.primaryBot !== undefined && !resources.bots.some(row => row.id === plan.primaryBot)) {
		throw new Error('primaryBot 引用了未声明的 Bot');
	}
	if (plan.workbench?.defaultBot && !resources.bots.some(row => row.id === plan.workbench.defaultBot)) {
		throw new Error('workbench.defaultBot 引用了未声明的 Bot');
	}
	return { schemaVersion: 1, packageName: packageManifest.name, version: packageManifest.version,
		profile: plan.profile, primaryBot: plan.primaryBot,
		...(plan.workbench ? { workbench: { ...plan.workbench } } : {}), resources };
}
