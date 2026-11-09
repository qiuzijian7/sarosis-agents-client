// @vssaros/dsh-marketplace — **Bot 组合包**的清单契约（纯函数，发布端与安装端共用）
//
// ★ 2026-11-09 方案（由 run-marketplace-bot-e2e-check.mjs 的红点倒逼）：
//   ① 不新增 `bot` kind —— 服务端 `kinds.ts` 不在这个仓库，且本仓 18+9+8 处按 kind 硬编码。
//      ⇒ 复用现有 `agent` 目录镜像包，包内多一份 `bot.json` 声明组件。
//   ② 为什么不是 `manifest.json`：`installBundle` 明确把 manifest 剔除（它是打包元数据，
//      落盘会污染资源目录并在下次发布被当成内容再打进去）⇒ 组件清单必须是独立文件。
//   ③ 为什么不是 dsh 插件包：商城 bundle 是 `manifest.json` 目录镜像，
//      工作台 `inspectWorkbenchArchive` 只认 `package.json` + `dsh.bundle.patch`，两种格式互不兼容。
//
// 一份 Bot 包 = `.agent.md`（Bot 定义）+ `bot.json`（本清单）+ `skills/<name>/SKILL.md`
//             + `mcp/<id>/config.json`（凭据只能写 `${env:VAR}` 占位符）。
// `tools` 是 dsh 工具真名的**声明**（工具实现随宿主/插件，不作为 bundle 文件分发）。

/** 包内清单文件名（唯一真源，发布端与安装端都读它）。 */
export const BOT_MANIFEST_FILE = 'bot.json';

/** Bot id = 目录名 = 商城 slug（服务端规则比 AGENT_ID_RE 更严，这里按商城口径）。 */
export const BOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 技能名：kebab-case（与 dsh skill-filesystem 的解析判据同源）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** MCP server 名（与 dshMcpConfig.ts 同源）。 */
export const MCP_SERVER_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 分项生效回执：一个 Bot 装完**不可能整体生效**。
 * · bot：`.agent.md` 落盘后可由 `vssarosAgents.rescan()` 增量注册 ⇒ applied；
 * · skills / tools：目录增删与插件 apply 要等下一次 Host 启动 ⇒ restart-required；
 * · mcp：`ctx.pluginManager` 没有 addRow，`mcp.json` 的行只在启动时生成 ⇒ restart-required。
 * 单个 `restartRequired` 布尔表达不了这个差异（会出现「Bot 看得见但 MCP 没连上」）。
 */
export const BOT_RECEIPT = Object.freeze({
	bot: 'applied',
	skills: 'restart-required',
	tools: 'restart-required',
	mcp: 'restart-required',
	note: 'Bot 定义已落盘；技能 / 工具 / MCP 需重启 Harness 后生效。MCP 凭据需用户在本机填 ${env:VAR} 对应的环境变量。',
});

/**
 * 从解包后的文件里读 `bot.json`。没有 ⇒ 返回 null（普通 agent 包，走原链路）。
 * @param {{path:string,data:Buffer}[]} files
 */
export function readBotManifest(files) {
	const found = (files ?? []).find(f => f.path === BOT_MANIFEST_FILE);
	if (!found) { return null; }
	let bot;
	try { bot = JSON.parse(found.data.toString('utf8')); }
	catch (e) { throw new Error(`bot.json 不是合法 JSON：${String(e?.message ?? e)}`); }
	if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
		throw new Error('bot.json 必须是一个对象');
	}
	return bot;
}

/**
 * 闭包校验：清单里声明的每个组件，包里必须有实体。
 * ⚠ 这是防止「装了半个包」的关键 —— 现有 `installBundle` 单 kind 单目录，
 *   把 skills/、mcp/ 塞进 agents/<id>/ 不会报错但技能/MCP 永远不生效。
 *
 * @param {{path:string,data:Buffer}[]} files
 * @param {object} bot bot.json 的内容
 * @returns {{ok:true, botId:string, skills:string[], tools:string[], mcpServers:string[]}}
 */
export function validateBotPack(files, bot) {
	if (!bot || typeof bot !== 'object') { throw new Error('bot.json 不是对象'); }
	if (bot.schemaVersion !== 1) { throw new Error(`bot.json 的 schemaVersion 只支持 1（当前 ${String(bot.schemaVersion)}）`); }
	const botId = String(bot.botId ?? '').trim();
	if (!BOT_ID_RE.test(botId)) { throw new Error(`bot.json 的 botId 非法：${botId}（只能 a-z0-9_-，小写字母开头，≤64）`); }
	if (bot.source && bot.source !== 'custom') {
		throw new Error('bot.json 的 source 必须是 custom（否则会被内置白名单静默过滤）');
	}
	// 裸模型名在 dsh 无路由 ⇒ 只许留空（跟随默认）或 provider/model 形式
	if (bot.model && !/^[^/\s]+\/[^/\s]+$/.test(String(bot.model))) {
		throw new Error(`bot.json 的 model 要么是空（跟随默认），要么写 provider/model：${bot.model}`);
	}
	if (Array.isArray(bot.workspacesRead) || Array.isArray(bot.workspacesWrite)) {
		throw new Error('bot.json 不许声明 workspaces-*（本机绝对路径不可移植）');
	}
	// 包级命名空间（缺省开启 ⇒ <botId>- 前缀；显式 false 才不隔离）。非法值在这里就拒，
	// 否则安装端拼出带 `/` 或 `..` 的目录名 ⇒ 越界。
	namespacePrefixOf(bot);
	// 依赖声明：形状 + **范围语法**都要验。只验形状的话作者写 `>=abc` 也能发出去，
	// 安装端却会把它当成「已满足」或永远匹配不上 ⇒ 在发布预检就拦掉。
	if (bot.requires !== undefined) {
		if (!bot.requires || typeof bot.requires !== 'object' || Array.isArray(bot.requires)) {
			throw new Error('bot.json 的 requires 必须是「依赖名 → 版本范围」的对象');
		}
		for (const [name, range] of Object.entries(bot.requires)) {
			if (!String(name).trim() || typeof range !== 'string' || !range.trim()) {
				throw new Error(`bot.json 的 requires.${name} 必须写版本范围字符串`);
			}
			if (satisfiesRange('1.0.0', range) === null) {
				throw new Error(`bot.json 的 requires.${name} 版本范围不合法：${range}`);
			}
		}
	}
	const paths = new Set((files ?? []).map(f => f.path));
	if (!paths.has('.agent.md')) { throw new Error('Bot 包缺少 .agent.md（Bot 定义）'); }

	const skills = Array.isArray(bot.skills) ? bot.skills.map(String) : [];
	for (const name of skills) {
		if (!SKILL_NAME_RE.test(name)) { throw new Error(`技能名不合法：${name}（需 kebab-case）`); }
		if (!paths.has(`skills/${name}/SKILL.md`)) {
			throw new Error(`Bot 包缺少技能实体：skills/${name}/SKILL.md（清单声明了但包里没有）`);
		}
	}
	const mcpServers = Array.isArray(bot.mcpServers) ? bot.mcpServers.map(String) : [];
	for (const name of mcpServers) {
		if (!MCP_SERVER_RE.test(name)) { throw new Error(`MCP server 名不合法：${name}`); }
		if (!paths.has(`mcp/${name}/config.json`)) {
			throw new Error(`Bot 包缺少 MCP 配置：mcp/${name}/config.json（清单声明了但包里没有）`);
		}
	}
	const tools = Array.isArray(bot.tools) ? bot.tools.map(String) : [];
	if (!Array.isArray(bot.tools)) { throw new Error('bot.json 的 tools 必须是数组（dsh 工具真名 / mcp__* 前缀）'); }
	for (const t of tools) {
		if (!/^!?[A-Za-z0-9_.:@/*-]{1,80}$/.test(t)) { throw new Error(`工具名不合法：${t}`); }
	}
	// 实际落位 id（按声明顺序，与 skills/mcpServers 一一对应）⇒ 安装端直接用，
	// 不必再各自拼一次前缀（两处各拼必漂移）。
	const map = componentIdMap(bot);
	const installedIds = {
		skills: skills.map(s => map.skills.get(s)),
		mcpServers: mcpServers.map(m => map.mcpServers.get(m)),
	};
	for (const id of installedIds.mcpServers) {
		if (!MCP_SERVER_RE.test(id)) {
			throw new Error(`加命名空间前缀后 MCP server 名超出 32 字符或不合法：${id}（请缩短 botId 或改用 namespace 自定义短前缀）`);
		}
	}
	return { ok: true, botId, skills, tools, mcpServers, prefix: map.prefix, installedIds };
}

/**
 * 凭据扫描（发布端硬闸）。
 * 起因：`publisher.js` 的 EXCLUDE_FILES 只有 .DS_Store/Thumbs.db，隐私体检只对 knowledge 跑
 *   ⇒ MCP `config.json` 里的 env/headers 会被原样打进包并随商城分发。
 * 这里只认 `${...}` 占位符；键名含 TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL 且值是实字符串 ⇒ 拦。
 *
 * @param {{path:string,data:Buffer}[]} files
 * @returns {{title:string,path:string}[]} blockers
 */
export function scanBotSecrets(files) {
	const blockers = [];
	const SENSITIVE_KEY = /(token|secret|password|passwd|api[-_]?key|credential|authorization)/i;
	for (const f of files ?? []) {
		const isMcp = /^mcp\/[^/]+\/config\.json$/.test(f.path);
		const isEnv = /(^|\/)\.env(\..*)?$/.test(f.path);
		if (!isMcp && !isEnv) { continue; }
		const text = f.data.toString('utf8');
		if (isEnv) {
			for (const line of text.split(/\r?\n/)) {
				const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
				if (m && !m[2].includes('${') && SENSITIVE_KEY.test(m[1])) {
					blockers.push({ title: `环境变量 ${m[1]} 含明文值`, path: f.path });
				}
			}
			continue;
		}
		let cfg;
		try { cfg = JSON.parse(text); } catch { continue; }
		for (const holder of [cfg?.env, cfg?.headers]) {
			if (!holder || typeof holder !== 'object') { continue; }
			for (const [key, value] of Object.entries(holder)) {
				const v = String(value ?? '');
				if (v.includes('${')) { continue; }
				if (SENSITIVE_KEY.test(key) && v.length >= 6) {
					blockers.push({ title: `MCP 凭据 ${key} 含明文值（应写 \${env:${key}}）`, path: f.path });
				} else if (/\b(sk-|ghp_|xox[baprs]-|Bearer\s+[A-Za-z0-9])/.test(v)) {
					blockers.push({ title: `MCP 配置疑似真实密钥（${key}）`, path: f.path });
				}
			}
		}
	}
	return blockers;
}

/** 给商城列表/详情展示用的组件摘要（不把整个 bot.json 灌给前端）。 */
export function botSummary(bot) {
	return {
		botId: String(bot?.botId ?? ''),
		skills: Array.isArray(bot?.skills) ? bot.skills.length : 0,
		tools: Array.isArray(bot?.tools) ? bot.tools.length : 0,
		mcpServers: Array.isArray(bot?.mcpServers) ? bot.mcpServers.length : 0,
	};
}

// ── P1：包级命名空间（★ 2026-11-09 用户拍板：**默认开启**）────────────
// 起因：两个 Bot 包都叫技能 `review-checklist` 时，裸名落位只能「谁先装谁占、后装拒绝」。
//   默认按 `<botId>-<name>` 落位 ⇒ 任意两个包都能共存；只有**显式 `namespace: false`**
//   才是逃生门（老包 / 必须固定技能名的包），也可传短前缀自定义。
//   开启时必须同步改写 .agent.md 的引用与 SKILL.md 的 frontmatter name
//   （不改的话 Bot 会指向不存在的技能；只改目录名则 dsh 里仍按 name 撞车）。

/**
 * 命名空间前缀；非法值直接抛（发布预检与安装端共用同一判据）。
 * 缺省 / null / true ⇒ `<botId>-`；false / 空串 ⇒ 不隔离。
 */
export function namespacePrefixOf(bot) {
	const n = bot?.namespace;
	if (n === false || n === '') { return ''; }
	if (n === undefined || n === null || n === true) { return `${String(bot?.botId ?? '').trim()}-`; }
	if (typeof n === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n)) { return `${n}-`; }
	throw new Error(`bot.json 的 namespace 只能是缺省 / true / false / 合法前缀（a-z0-9_-，≤32）：${String(n)}`);
}

/** 声明名 → 实际落位名的映射。 */
export function componentIdMap(bot) {
	const prefix = namespacePrefixOf(bot);
	const skills = new Map((Array.isArray(bot?.skills) ? bot.skills : [])
		.map(s => [String(s), prefix + String(s)]));
	const mcpServers = new Map((Array.isArray(bot?.mcpServers) ? bot.mcpServers : [])
		.map(m => [String(m), prefix + String(m)]));
	return { prefix, skills, mcpServers };
}

/**
 * 改写 `.agent.md` frontmatter 里的组件引用。
 * 只动 `skills:` / `tools:` 两节：`skills` 按名字换、`tools` 里的
 * `mcp__<server>__*` 按 server 换；其它工具名（read/glob/…）原样保留。
 * 包内没写这两节时不改动（返回原文），不猜格式。
 */
export function rewriteAgentMd(text, map) {
	const lines = String(text ?? '').split(/\r?\n/);
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') { close = i; break; }
	}
	const last = close > 0 ? close : lines.length;
	let section = '';
	for (let i = 1; i < last; i++) {
		const raw = lines[i];
		const head = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
		if (head) { section = head[1].toLowerCase(); }
		if (section === 'skills') {
			lines[i] = raw.replace(/[A-Za-z0-9_.-]+/g, t => map.skills.has(t) ? map.skills.get(t) : t);
		} else if (section === 'tools') {
			lines[i] = raw.replace(/mcp__([A-Za-z0-9_-]+)__/g,
				(all, srv) => map.mcpServers.has(srv) ? `mcp__${map.mcpServers.get(srv)}__` : all);
		}
	}
	return lines.join('\n');
}

// ── P1：依赖版本范围 ─────────────────────────────────────────────────
// 只做**纯计算 + 如实报告**：查不到版本 ⇒ `unknown`（不假装满足），
// 明确不满足 ⇒ `incompatible` ⇒ 安装失败。不做自动补装（那要新的依赖解析器）。

function parseSemver(s) {
	const m = String(s ?? '').trim()
		.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
	if (!m) { return null; }
	return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? String(m[4]) : '' };
}
function compareSemver(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a.nums[i] !== b.nums[i]) { return a.nums[i] > b.nums[i] ? 1 : -1; }
	}
	if (a.pre === b.pre) { return 0; }
	if (!a.pre) { return 1; }
	if (!b.pre) { return -1; }
	return a.pre > b.pre ? 1 : -1;
}

/**
 * 简版 semver 范围：`^ ~ >= <= > < =`、`&&`（空格）、`||`、预发布、构建元数据。
 * @returns {boolean|null} true/false = 满足与否；**null = 范围语法不可解析**（不许当成 false）
 */
export function satisfiesRange(version, range) {
	const v = parseSemver(version);
	if (!v) { return null; }
	const text = String(range ?? '').trim();
	if (!text || text === '*') { return true; }
	let parsedAny = false;
	for (const clause of text.split(/\s*\|\|\s*/)) {
		const parts = clause.trim().split(/\s+/).filter(Boolean);
		let all = true;
		for (const part of parts) {
			const m = part.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
			if (!m) { all = false; break; }
			parsedAny = true;
			const op = m[1] || '=';
			const r = { nums: [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)], pre: m[5] ? String(m[5]) : '' };
			const c = compareSemver(v, r);
			let hit;
			if (op === '^') {
				const upper = { nums: r.nums[0] > 0 ? [r.nums[0] + 1, 0, 0]
					: (r.nums[1] > 0 ? [0, r.nums[1] + 1, 0] : [0, 0, r.nums[2] + 1]), pre: '' };
				hit = c >= 0 && compareSemver(v, upper) < 0;
			} else if (op === '~') {
				hit = c >= 0 && compareSemver(v, { nums: [r.nums[0], r.nums[1] + 1, 0], pre: '' }) < 0;
			} else if (op === '>=') { hit = c >= 0; }
			else if (op === '<=') { hit = c <= 0; }
			else if (op === '>') { hit = c > 0; }
			else if (op === '<') { hit = c < 0; }
			else { hit = c === 0; }
			if (!hit) { all = false; break; }
		}
		if (all && parts.length) { return true; }
	}
	return parsedAny ? false : null;
}

/**
 * 命名空间化后同步改写 `SKILL.md` frontmatter 的 `name`。
 * ⚠ 只改目录名不够：dsh 的 skill-filesystem 用 **frontmatter 的 name** 做技能 id，
 *   两个包都写 `name: review-checklist` ⇒ 运行时仍会静默裁决（先到者赢），
 *   看起来「两个包都装上了」实际只有一个技能可见。
 */
export function rewriteSkillName(text, installedName) {
	const lines = String(text ?? '').split(/\r?\n/);
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') { close = i; break; }
	}
	const last = close > 0 ? close : lines.length;
	for (let i = 1; i < last; i++) {
		const m = lines[i].match(/^(\s*name\s*:\s*)(.*)$/);
		if (m) { lines[i] = m[1] + installedName; break; }
	}
	return lines.join('\n');
}

/** 逐项核对 requires；`versions` 是「依赖名 → 已装版本」的可信来源，缺的就是 unknown。 */
export function checkBotRequires(bot, versions = {}) {
	const results = [];
	for (const [name, range] of Object.entries(bot?.requires ?? {})) {
		const found = versions?.[name];
		if (!found) { results.push({ name, range, state: 'unknown' }); continue; }
		const ok = satisfiesRange(found, range);
		results.push({ name, range, found, state: ok === null ? 'unknown' : (ok ? 'ok' : 'incompatible') });
	}
	return { ok: results.every(r => r.state !== 'incompatible'), results };
}
