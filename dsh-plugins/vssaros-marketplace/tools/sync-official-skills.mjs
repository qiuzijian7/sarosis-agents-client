#!/usr/bin/env node
/**
 * 把 Epic Games 官方 Unreal Engine Skills 上架到 VsSaros 商城（dsh 侧，kind=skill）。
 *
 * 来源：`EpicGames/unreal-engine-skills-for-claude-code-plugin` @ 0e27bde，MIT，
 *        Copyright (c) 2026 Epic Games, Inc.；插件 v3.1.2，含 3 个 skill。
 *        逐字原样收录在 tools/official-skills/，出处与不收录的部分见 SOURCE.md。
 *
 * 与 `sync-official-mcp.mjs` 是姊妹脚本：那个上架的是 UE 5.8 官方 MCP 的**连接配置**
 * （kind=mcp，本机 127.0.0.1:8000/mcp），这个上架的是**用那台 MCP 的工作流知识**（kind=skill）。
 * 两者配套：技能正文里的 list_toolsets / describe_toolset / call_tool 由编辑器内 MCP server 提供。
 *
 * 包结构：`<数据根>/skills/<slug>/` 镜像官方目录 + 一份 LICENSE（MIT 要求副本保留版权声明）。
 * 打包器 preparePublishBundle 会补 manifest.json，安装端要求包内有 SKILL.md（installers.js）。
 * ★ 不放进 vssaros-skill-bundle/skills/：那是随包技能根，check-skill-tier/scope 硬编码 174 条且要 tier。
 *
 * 图标：复用 tools/official-mcp-icons.json 里的 Unreal 官方 U 标 128×128 透明 PNG，
 * 按各自 slug 上传成服务端自持封面再 updatePackage 回填（不收 svg、不用 data: URI）。
 *
 * 用法（在 dsh-plugins/vssaros-marketplace 下执行）：
 *   node tools/sync-official-skills.mjs --dry            # 只列计划（不写服务器）
 *   node tools/sync-official-skills.mjs --icons --dry    # 连图标一起预览
 *   node tools/sync-official-skills.mjs --icons          # 登记 3 个技能 + 回填图标（幂等）
 *   node tools/sync-official-skills.mjs                  # 只登记（不带官方图标）
 *
 * 前置：~/.vssaros-dev/dsh-home/.credentials.yaml（或 ~/.vssaros/dsh-home/）里有
 *       VSSAROS_TOF_TICKET_DSH + VSSAROS_TOF_IDENTITY_DSH；内网可达
 *       MARKET_ENDPOINT（默认 http://21.91.158.20:3040）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const SOURCE_DIR = path.join(HERE, 'official-skills');
const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.91.158.20:3040').replace(/\/+$/, '');
const DRY = process.argv.includes('--dry');
const ICONS = process.argv.includes('--icons');
const VERSION = '1.0.0';
const CHANGELOG = 'EpicGames/unreal-engine-skills-for-claude-code-plugin @ 0e27bde 原样收录（MIT）';

/** 服务端自持封面 URL（isImageIcon 只认 https?://；data: URI 在真机会落成乱码）。 */
const iconUrlOf = slug => ENDPOINT + '/covers/' + slug + '.png';

const ORIGIN = [
	'',
	'来源：EpicGames/unreal-engine-skills-for-claude-code-plugin @ 0e27bde（MIT，Copyright (c) 2026 Epic Games, Inc.，插件 v3.1.2）。',
	'SKILL.md 逐字原样收录官方原文，仅在本商品描述与包内 LICENSE 补充说明；版权与许可全文见包内 LICENSE。',
].join('\n');

/** Epic 官方技能清单。slug 刻意等于官方 frontmatter 的 name ⇒ 安装后目录名与技能名一致。 */
const OFFICIAL_SKILLS = [
	{
		slug: 'unreal-mcp',
		name: 'Unreal MCP 工作流（Epic 官方）',
		category: '游戏开发',
		tags: ['epic-official', 'unreal', 'ue5.8', 'mcp', 'skill'],
		description: [
			'Epic Games 官方发布的 unreal-mcp 技能：通过实时 MCP 连接驱动正在运行的 Unreal Editor。',
			'覆盖 Actor 生成/变换、蓝图 / Widget / 材质 / Niagara / Sequencer / Control Rig / GAS、Actor 属性读写、Live Coding 重编译等；内置「先 list_toolsets → describe_toolset → call_tool」的按需工具发现流程，以及先保存、等编译、串行变更、检查结果、留意 PIE 等安全规则。',
			'包内原样收录官方 SKILL.md 与 references/operations.md、references/setup.md。',
			'',
			'★ 前置：Unreal Engine 5.8+ 编辑器启用 ModelContextProtocol + AllToolsets 插件并启动 MCP server。在 VsSaros 里请配合商城的「Unreal 官方 MCP（UE 5.8）」商品（unreal-official-mcp，kind=mcp）安装，它会把 http://127.0.0.1:8000/mcp 注册进 mcp.json；编辑器未运行时技能里的工具调用会失败。',
			'setup.md 讲的是 Claude Code 的 .mcp.json 配置步骤，在 VsSaros 里以上述 MCP 商品为准（该文档按官方原文保留）。',
			ORIGIN,
		].join('\n'),
	},
	{
		slug: 'create-toolset',
		name: 'Unreal Toolset 开发（Epic 官方）',
		category: '游戏开发',
		tags: ['epic-official', 'unreal', 'ue5.8', 'toolset', 'skill'],
		description: [
			'Epic Games 官方发布的 create-toolset 技能：编写或扩展 Unreal Engine Toolset —— 注册到 ToolsetRegistry、经 unreal-mcp server 暴露给 AI 的静态可调用函数集合。',
			'覆盖 API 设计原则（Clean / Complete / Composable / DRY）、C++ 与 Python 两条实现路径、参数与返回类型 / 结构体 schema 设计、注册方式、错误处理与测试，以及动手前先确认「能力是否已存在 / 是否该做成通用能力」的决策流程。',
			'',
			'适用：给 UE 5.8 官方 MCP 增加自定义工具，例如扩展 BlueprintTools / StaticMeshTools / MaterialTools。运行期调用已有工具请用 unreal-mcp 技能；编写引擎内 Agent Skill 请用 unreal-skill 技能。',
			ORIGIN,
		].join('\n'),
	},
	{
		slug: 'unreal-skill',
		name: 'Unreal Skill 编写（Epic 官方）',
		category: '游戏开发',
		tags: ['epic-official', 'unreal', 'ue5.8', 'agent-skill', 'skill'],
		description: [
			'Epic Games 官方发布的 unreal-skill 技能：创建 / 编辑 / 审阅 Unreal Engine 引擎内 Agent Skill —— 注册在 unreal-mcp server 上的命名指令包，与 Claude Code 的 .claude/skills/ 层技能不是一回事。',
			'覆盖技能设计原则（Novel / Collegial / Flexible / Durable / Agnostic / Parsimonious）、Python class 与 UAsset 两条实现路径、CreateSkill / ListSkills / GetSkills 的用法与评审清单。',
			'',
			'⚠ 这里的「Skill」指 UE 编辑器内的 Agent Skill，不是 VsSaros 商城里的技能商品。前置：UE 5.8 官方 MCP；运行期加载项目已注册的技能请用 unreal-mcp 技能。',
			ORIGIN,
		].join('\n'),
	},
];

const {
	createMarketClient, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF,
} = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
const { publishVersion } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

/** 发布前自检：官方源文件在、frontmatter 的 name 等于 slug、description 非空。 */
function assertSkillSource(slug) {
	const file = path.join(SOURCE_DIR, slug, 'SKILL.md');
	const raw = fs.readFileSync(file, 'utf8');
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
	if (!fm || !new RegExp('^name:\\s*' + slug + '\\s*$', 'm').test(fm[1])) {
		throw new Error(`${slug}/SKILL.md 的 frontmatter name 与 slug 不一致（会导致技能 id 与目录名对不上）`);
	}
	if (!/^description:\s*\S/m.test(fm[1])) { throw new Error(`${slug}/SKILL.md 缺 description`); }
	return file;
}

/** 与 sync-official-mcp.mjs 同款：yaml key → 客户端固定 ref（dev / 生产两套 home 都认）。 */
function loadTofCredentials() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
	const candidates = [
		path.join(home, '.vssaros-dev', 'dsh-home', '.credentials.yaml'),
		path.join(home, '.vssaros', 'dsh-home', '.credentials.yaml'),
	];
	const store = new Map();
	for (const file of candidates) {
		if (!fs.existsSync(file)) { continue; }
		const text = fs.readFileSync(file, 'utf8');
		const grab = key => {
			const m = new RegExp(key + '[ \\t]*:[ \\t]*(.+)$', 'm').exec(text);
			return m ? m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '') : undefined;
		};
		const ticket = grab('VSSAROS_TOF_TICKET_DSH');
		const identity = grab('VSSAROS_TOF_IDENTITY_DSH');
		if (ticket) { store.set(TOF_LOCAL_TICKET_REF, ticket); }
		if (identity) { store.set(TOF_IDENTITY_REF, identity); }
		if (ticket) { break; }
	}
	return store;
}

const kv = loadTofCredentials();
const credentials = {
	resolve: async ref => (kv.has(ref) ? { value: kv.get(ref) } : undefined),
	set: async (ref, value) => { kv.set(ref, value); },
	unset: async ref => { kv.delete(ref); },
};
const market = createMarketClient({ credentials, config: { marketEndpoint: ENDPOINT }, log: () => {} });

/** 服务端现有 kind=skill 的 slug 集合（分页），幂等：已存在就跳过，不叠版本、不覆盖别人的商品。 */
async function existingSlugs() {
	const out = new Set();
	for (let page = 1; page <= 20; page++) {
		const j = await market.request('GET', '/packages?kind=skill&pageSize=100&page=' + page);
		const items = j?.items ?? [];
		for (const it of items) { out.add(String(it.slug)); }
		if (!items.length || (typeof j?.total === 'number' && out.size >= j.total)) { break; }
	}
	return out;
}

for (const spec of OFFICIAL_SKILLS) { assertSkillSource(spec.slug); }

const existing = await existingSlugs();
const targets = OFFICIAL_SKILLS.filter(spec => !existing.has(spec.slug));
console.log(`商城现有 skill 商品 ${existing.size} 个；Epic 官方技能 ${OFFICIAL_SKILLS.length} 个；mode=${DRY ? 'DRY' : 'WRITE'}`);
console.log(`已有跳过 ${OFFICIAL_SKILLS.length - targets.length} 个；本次待登记 ${targets.length} 个`);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-official-skills-'));
let ok = 0;
const failures = [];
try {
	for (const spec of targets) {
		const dir = path.join(dataRoot, 'skills', spec.slug);
		fs.cpSync(path.join(SOURCE_DIR, spec.slug), dir, { recursive: true });
		fs.copyFileSync(path.join(SOURCE_DIR, 'LICENSE'), path.join(dir, 'LICENSE'));
		const fileCount = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).length;
		console.log(`  ${spec.slug}  files=${fileCount}`);
		if (DRY) { continue; }
		try {
			const r = await publishVersion({
				market, dataRoot, kind: 'skill', localId: spec.slug, version: VERSION,
				changelog: CHANGELOG,
				meta: {
					name: spec.name,
					category: spec.category,
					description: spec.description,
					tags: spec.tags,
				},
			});
			ok++;
			console.log(`  OK  ${spec.slug} v${r.version} bytes=${r.bytes}`);
		} catch (e) {
			failures.push({ id: spec.slug, error: String(e?.message ?? e).slice(0, 240) });
			console.error(`  FAIL ${spec.slug}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
} finally {
	fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── 图标回填：复用 Unreal 官方 U 标，按各自 slug 上传成自持 PNG + 写绝对 http URL ──
// 已存在的包走 ensurePackage 的 409 分支不会更新 meta ⇒ 图标必须靠这里显式回填。
// 幂等：先 GET 详情比对，icon 相同就跳过，不重复上传/写库。
let iconsOk = 0;
const iconFailures = [];
if (ICONS) {
	let png = Buffer.alloc(0);
	try {
		const assets = JSON.parse(fs.readFileSync(path.join(HERE, 'official-mcp-icons.json'), 'utf8'));
		png = Buffer.from(assets['unreal-official-mcp'] ?? '', 'base64');
	} catch (e) {
		iconFailures.push({ id: '(assets)', error: String(e?.message ?? e).slice(0, 240) });
	}
	if (!png.length) { iconFailures.push({ id: '(assets)', error: 'official-mcp-icons.json 里缺官方 U 标 PNG' }); }
	let coverToken = '';
	if (!DRY && png.length) { coverToken = await market.login(); }
	for (const spec of png.length ? OFFICIAL_SKILLS : []) {
		const iconUrl = iconUrlOf(spec.slug);
		if (DRY) { console.log(`  ICON DRY ${spec.slug} ${iconUrl} bytes=${png.length}`); continue; }
		try {
			const detail = await market.request('GET', '/packages/' + encodeURIComponent(spec.slug));
			if (String(detail?.icon ?? '') === iconUrl) { console.log(`  ICON SKIP ${spec.slug}`); continue; }
			const up = await fetch(ENDPOINT + '/api/v1/covers?' + new URLSearchParams({ slug: spec.slug, ext: 'png' }), {
				method: 'POST',
				headers: { authorization: 'Bearer ' + coverToken, 'content-type': 'application/octet-stream' },
				body: png,
				signal: AbortSignal.timeout(30_000),
			});
			const text = await up.text();
			let upUrl = '';
			try { upUrl = JSON.parse(text).url ?? ''; } catch { /* 非 JSON */ }
			if (!up.ok || !upUrl) { throw new Error(`封面上传失败 HTTP ${up.status} ${text.slice(0, 120)}`); }
			await market.updatePackage(spec.slug, { icon: iconUrl });
			iconsOk++;
			console.log(`  ICON OK  ${spec.slug} ${iconUrl}`);
		} catch (e) {
			iconFailures.push({ id: spec.slug, error: String(e?.message ?? e).slice(0, 240) });
			console.error(`  ICON FAIL ${spec.slug}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
}

console.log(`\n结果：登记成功 ${ok} / 登记失败 ${failures.length} / 跳过(已存在) ${OFFICIAL_SKILLS.length - targets.length}；图标写入 ${iconsOk} / 图标失败 ${iconFailures.length}`);
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); }
if (iconFailures.length) { console.log(JSON.stringify(iconFailures, null, 2)); }
if (!DRY && (failures.length || iconFailures.length)) { process.exitCode = 1; }
