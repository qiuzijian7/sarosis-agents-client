// @vssaros/dsh-marketplace — 本地可发布资源枚举（★ 2026-10-22）
//
// 为什么单独一个模块：发布表单要让用户从"本机真实存在的资源"里挑，
// 而这段枚举逻辑**必须可单测**（真目录 → 列出的条目、跳过备份目录、版本读法三类）——
// 内联在 Host 半的 apply() 里就只能靠起 Host 才测得到 ✗
//
// 版本口径（与 `installers.installedVersionOf` 一致）：
//   · skill 读 `SKILL.md` 的 frontmatter `version:`
//   · mcp 读 `config.json` 的 `version` 字段

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { PUBLISHABLE_KINDS } from './publisher.js';
import { kbDataRootOf } from './installers.js';

/**
 * 各 kind 的本地根目录名（与 IDE 侧 `SarosPath` 同口径）。
 *
 * ★ 2026-10-22 晚：加 `agent` —— agent 的本地形态是 `<数据根>/agents/<id>/.agent.md`，
 *   与 skill/agent 一样是目录镜像 ⇒ 可发布、可安装 ✓
 */
// ★ 2026-10-23：加 mcp（`<数据根>/mcp/<id>/`，入口是 config.json）
// ★ 2026-10-31：加 knowledge（与 publisher.js 的 KIND_DIR 同口径；这里必须同步，否则
//   `join(dataRoot, KIND_DIR['knowledge'])` 会因为 undefined 直接抛 ERR_INVALID_ARG_TYPE ✗）
const KIND_DIR = { skill: 'skills', agent: 'agents', mcp: 'mcp', knowledge: 'knowledge' };

/**
 * 各 kind 的**关键文件**（没有它就不是一个可发布的资源）。
 *
 * ⚠ agent 是 `.agent.md`（点开头）—— 之前这里只写了 skill/workflow 两个分支，
 *   结果 agent 目录被当成"缺 workflow.json"**静默跳过**（页面上根本选不到）✗
 */
const ENTRY_OF = { skill: 'SKILL.md', agent: '.agent.md', mcp: 'config.json' };

/**
 * 读一个本地资源的版本（读不到就空串，不抛）。
 *
 * @param {string} dir
 * @param {string} kind
 */
/**
 * 目录内**最新修改时间**（递归，但限深限量 —— 发布前要快，不能卡住页面）。
 *
 * 为什么不用"今天"：那样同一天发两次就是同一个版本号 ⇒ 服务端撞 409 ✗
 * 用文件 mtime 的**分钟精度**：内容一改就变，同一天多次也能区分 ✓
 */
async function latestMtimeMs(dir, depth = 0) {
	let newest = 0;
	let seen = 0;
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			if (seen > 300 || depth > 4) { break; }   // 防空转（node_modules 之类）
			// ⚠ **不能跳过所有 `.` 开头的条目** —— agent 的入口就叫 `.agent.md`！
			//   只跳过已知的内部目录（备份 / 回收站 / 升级备份）。
			if (/^\.(upgrade-backup|trash|saros|git)(-|$)/.test(e.name)) { continue; }
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				newest = Math.max(newest, await latestMtimeMs(full, depth + 1));
				continue;
			}
			seen += 1;
			try { newest = Math.max(newest, (await stat(full)).mtimeMs); } catch { /* 跳过读不到的 */ }
		}
	} catch { /* 目录不存在 / 无权限 */ }
	return newest;
}

/**
 * **自动推导版本号**（★ 2026-10-26 用户选方案 A）。
 *
 * 何时用：资源文件里**没有写 `version`** 时（`config.json` 大多没写）。
 * 格式：`0.1.<YYYYMMDDHHmm>`（12 位）—— 语义化 3 段、能区分同一天多次发布。
 * 依据：目录内**最新文件 mtime** ⇒ 内容一改版本就变（确定性，不依赖"当前时间"）。
 *
 * ⚠ 这是**兜底**，不是替代：作者写了版本就用作者的（语义化版本比时间戳有意义）。
 *
 * @param {string} dir 资源目录
 * @returns {Promise<string>} 推导出的版本；连文件都读不到 ⇒ 空串（调用方自己兜）
 */
export async function deriveVersion(dir) {
	const ms = await latestMtimeMs(dir);
	if (!ms) { return ''; }
	const d = new Date(ms);
	const pad = (n) => String(n).padStart(2, '0');
	return `0.1.${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function versionOf(dir, kind) {
	try {
		// skill 与 agent 都从 markdown 的 frontmatter 取 version（agent 是 `.agent.md`）
		if (kind === 'skill' || kind === 'agent') {
			const md = await readFile(join(dir, ENTRY_OF[kind]), 'utf8');
			const head = md.split(/\r?\n---/)[0] ?? '';
			const m = /^version:\s*(.+)$/m.exec(head);
			// frontmatter 里可能写成 `version: "1.0.0"`（带引号）⇒ 去引号
			const v = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
			// 没写版本 ⇒ **自动推导**（方案 A），不让页面留空 / 不让用户瞎填
			return v || await deriveVersion(dir);
		}
		// ★ 2026-10-26 修：以前这里**写死读 `workflow.json`** ⇒ `mcp` 会去读一个不存在的
		//   文件（它的入口是 `config.json`）⇒ 抛错被 catch 吞掉 ⇒ 版本永远空串 ✗
		//   ⇒ 按 kind 取自己的入口文件（`ENTRY_OF` 就是那张表）
		const entry = ENTRY_OF[kind];
		if (!entry) { return ''; }
		const j = JSON.parse(await readFile(join(dir, entry), 'utf8'));
		const jv = typeof j?.version === 'string' ? j.version.trim() : '';
		// 同样兜底：`workflow.json` 大多**没写 version** ⇒ 自动推导
		return jv || await deriveVersion(dir);
	} catch {
		// 连入口文件都读不到（不该发生，listPublishables 已过滤）⇒ 最后再试一次推导
		return deriveVersion(dir);
	}
}

/**
 * 列出本机**可发布**的资源。
 *
 * 跳过：以 `.` 开头的目录（`.upgrade-backup` 这类内部目录）、非目录、以及
 * **缺关键文件**的目录（skill 没 `SKILL.md` / mcp 没 `config.json`）——
 * 后者发布时必然失败，列出来只会让用户白点一次 ✗
 *
 * @param {string} dataRoot
 * @returns {Promise<{ kind: string, localId: string, version: string }[]>}
 */
/**
 * ★ 2026-11-10（用户裁决）：商城里「已安装 / 可发布」的知识库，单位是
 *   `知识库列表/<文件夹>` —— **每个文件夹 = 一个独立知识库**（AIAgent / ComfyUI技术 / …）。
 *
 * 旧实现把 `<kbRoot>/.extra-vaults.json` 里的 **vault 容器 id**（`ext-<hash>`）当成商品，
 * 于是商城「已安装」里只显示一条 `ext-f0e1fcee`：名字是 id、描述是兜底文案、版本是目录
 * mtime ⇒ 与「知识库列表下一个个文件夹」完全对不上 ✗。
 *
 * 现在按 dsh 侧唯一真源取**库根**：
 *   ① `<数据根>/.kb-root.json`（聊天框工具卡配置的根，直接就是唯一库根）；
 *   ② 没配置时回退旧容器根 `kbDataRootOf()`，扫每个 `<vaultId>/知识库列表/`；
 *   ③ `.extra-vaults.json` / `.market-vaults.json` 登记的外部库目录也纳入（兼容存量）。
 * 再对每个库根枚举 `知识库列表/` 的一级子目录（跳过点开头），每个产出一条商品。
 *
 * ⚠ 只读：这里不写任何东西；`ext-<hash>` 只留在 KB 插件内部，不再进商城商品列表。
 * ⚠ 目录真名用 `知识库列表`（`笔记` / `库` 是 2026-11-02 改名前的旧称）。
 */
const KB_ROOT_CONFIG_FILE = '.kb-root.json';
const KB_NOTES_DIR = '知识库列表';

/** 数一个知识库文件夹里的 md 篇数（限深限量，发布前要快，不能卡住页面）。 */
async function countDocs(dir, depth = 0) {
	let n = 0;
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			if (e.name.startsWith('.') || n > 500) { continue; }
			const full = join(dir, e.name);
			if (e.isDirectory() && depth < 3) { n += await countDocs(full, depth + 1); }
			else if (e.isFile() && /\.md$/i.test(e.name)) { n += 1; }
		}
	} catch { /* 读不到就算 0 */ }
	return n;
}

/** 所有可能含 `知识库列表/` 的**库根**绝对路径（去重，读不到就少给、不猜）。 */
async function knowledgeRootsOf(dataRoot) {
	const roots = [];
	const push = (p) => {
		const abs = resolve(String(p || ''));
		if (abs && !roots.includes(abs)) { roots.push(abs); }
	};
	// ① dsh 侧根配置（数据根及其上一级：兼容独立启动器把数据根指到子目录）
	const base = String(dataRoot || '');
	for (const candidate of [base, dirname(base)]) {
		if (!candidate) { continue; }
		try {
			const cfg = JSON.parse(await readFile(join(candidate, KB_ROOT_CONFIG_FILE), 'utf8'));
			if (typeof cfg?.path === 'string' && cfg.path.trim()) { push(cfg.path.trim()); }
		} catch { /* 没配置 / 坏 JSON ⇒ 走回退 */ }
	}
	// ② 旧容器根：它自己可能就是根，也可能装多个 `<vaultId>/`
	const container = kbDataRootOf(dataRoot);
	if (!container) { return roots; }
	try { if ((await stat(join(container, KB_NOTES_DIR))).isDirectory()) { push(container); } } catch { /* 不是根 */ }
	let names = [];
	try { names = await readdir(container); } catch { names = []; }
	for (const name of names) {
		if (name.startsWith('.')) { continue; }
		const dir = join(container, name);
		try { if ((await stat(join(dir, KB_NOTES_DIR))).isDirectory()) { push(dir); } } catch { /* 不是库目录 */ }
	}
	// ③ 旧登记表里的外部库目录（vault 根）—— 只当"另一个库根"，绝不把 `ext-*` 当商品 id
	for (const file of ['.extra-vaults.json', '.market-vaults.json']) {
		try {
			const list = JSON.parse(await readFile(join(container, file), 'utf8'));
			for (const v of Array.isArray(list) ? list : []) {
				if (v && typeof v?.path === 'string' && v.path.trim()) { push(v.path.trim()); }
			}
		} catch { /* 登记表不存在 */ }
	}
	return roots;
}

export async function listKnowledgeVaults(dataRoot) {
	const found = new Map();
	for (const root of await knowledgeRootsOf(dataRoot)) {
		const notes = join(root, KB_NOTES_DIR);
		let entries = [];
		try { entries = await readdir(notes, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			if (!e.isDirectory() || e.name.startsWith('.') || found.has(e.name)) { continue; }
			found.set(e.name, join(notes, e.name));
		}
	}
	const items = [];
	for (const [name, dir] of found) {
		let version = '';
		try { version = await deriveVersion(dir); } catch { version = ''; }
		const docs = await countDocs(dir);
		items.push({
			kind: 'knowledge',
			localId: name,
			name,
			version: version || '1.0.0',
			sourceDir: dir,
			rel: KB_NOTES_DIR + '/' + name,
			description: `${docs} 篇文档 · ${KB_NOTES_DIR}/${name}`,
		});
	}
	return items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

export async function listPublishables(dataRoot) {
	const items = [];
	for (const kind of PUBLISHABLE_KINDS) {
		const root = join(dataRoot, KIND_DIR[kind]);
		let names = [];
		try { names = await readdir(root); } catch { continue; }
		for (const name of names) {
			if (name.startsWith('.')) { continue; }
			const dir = join(root, name);
			try { if (!(await stat(dir)).isDirectory()) { continue; } } catch { continue; }
			// 关键文件不在 ⇒ 不是一个可发布的资源（发布时必失败）
			// ⚠ knowledge **没有单一入口文件**（它是"一个库目录"）⇒ 跳过这条检查 ✓
			if (ENTRY_OF[kind]) {
				try {
					await stat(join(dir, ENTRY_OF[kind]));
				} catch {
					continue;
				}
			}
			items.push({ kind, localId: name, version: await versionOf(dir, kind) });
		}
	}
	// ★ knowledge 另加**真实的知识库**（本体在知识库插件的数据根下，不在这里）
	try {
		for (const v of await listKnowledgeVaults(dataRoot)) {
			const dup = items.some((x) => x.kind === v.kind && x.localId === v.localId);
			if (!dup) { items.push(v); }
		}
	} catch { /* 知识库侧不可用 ⇒ 不影响其它 kind */ }
	return items;
}
