// @vssaros/dsh-marketplace — 本地可发布资源枚举（★ 2026-10-22）
//
// 为什么单独一个模块：发布表单要让用户从"本机真实存在的资源"里挑，
// 而这段枚举逻辑**必须可单测**（真目录 → 列出的条目、跳过备份目录、版本读法三类）——
// 内联在 Host 半的 apply() 里就只能靠起 Host 才测得到 ✗
//
// 版本口径（与 `installers.installedVersionOf` 一致）：
//   · skill 读 `SKILL.md` 的 frontmatter `version:`
//   · workflow 读 `workflow.json` 的 `version` 字段

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { PUBLISHABLE_KINDS } from './publisher.js';
import { kbDataRootOf } from './installers.js';

/**
 * 各 kind 的本地根目录名（与 IDE 侧 `SarosPath` 同口径）。
 *
 * ★ 2026-10-22 晚：加 `agent` —— agent 的本地形态是 `<数据根>/agents/<id>/.agent.md`，
 *   与 skill/workflow 一样是目录镜像 ⇒ 可发布、可安装 ✓
 */
// ★ 2026-10-23：加 mcp（`<数据根>/mcp/<id>/`，入口是 config.json）
// ★ 2026-10-31：加 knowledge（与 publisher.js 的 KIND_DIR 同口径；这里必须同步，否则
//   `join(dataRoot, KIND_DIR['knowledge'])` 会因为 undefined 直接抛 ERR_INVALID_ARG_TYPE ✗）
const KIND_DIR = { skill: 'skills', workflow: 'workflows', agent: 'agents', mcp: 'mcp', knowledge: 'knowledge' };

/**
 * 各 kind 的**关键文件**（没有它就不是一个可发布的资源）。
 *
 * ⚠ agent 是 `.agent.md`（点开头）—— 之前这里只写了 skill/workflow 两个分支，
 *   结果 agent 目录被当成"缺 workflow.json"**静默跳过**（页面上根本选不到）✗
 */
const ENTRY_OF = { skill: 'SKILL.md', workflow: 'workflow.json', agent: '.agent.md', mcp: 'config.json' };

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
 * 何时用：资源文件里**没有写 `version`** 时（`workflow.json` 大多没写）。
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
 * **缺关键文件**的目录（skill 没 `SKILL.md` / workflow 没 `workflow.json`）——
 * 后者发布时必然失败，列出来只会让用户白点一次 ✗
 *
 * @param {string} dataRoot
 * @returns {Promise<{ kind: string, localId: string, version: string }[]>}
 */
/**
 * ★ 2026-10-31：列出**真实的知识库**（用户挂载的那些，不是装回来的包）。
 *
 * 为什么必须另列：知识库的本体在**知识库插件的数据根**里（`<dshHome>/knowledge-base/`），
 *   而本文件默认只扫 `<数据根>/<kind根>/` ⇒ 那样只能看到"装回来的包"，用户自己的库一个都没有 ✗。
 *   两个来源：
 *     ① `.extra-vaults.json`（用户「本地载入文件夹」登记的）
 *     ② 数据根下含 `笔记` 或 `库` 的目录（新建/内置的库）
 * ⚠ 只读：这里不写任何东西。
 */
export async function listKnowledgeVaults(dataRoot) {
	const kbRoot = kbDataRootOf(dataRoot);
	if (!kbRoot) { return []; }
	const found = new Map();
	// ① 登记表
	try {
		const list = JSON.parse(await readFile(join(kbRoot, '.extra-vaults.json'), 'utf8'));
		for (const v of Array.isArray(list) ? list : []) {
			if (!v || typeof v?.path !== 'string' || !v.path.trim()) { continue; }
			const p = v.path.trim();
			try { if (!(await stat(p)).isDirectory()) { continue; } } catch { continue; }
			found.set(p, { localId: String(v.id || basename(p)), name: String(v.name || v.id || basename(p)) });
		}
	} catch { /* 登记表不存在 ⇒ 只走扫描 */ }
	// ② 扫描
	let names = [];
	try { names = await readdir(kbRoot); } catch { names = []; }
	for (const name of names) {
		if (name.startsWith('.')) { continue; }
		const dir = join(kbRoot, name);
		try { if (!(await stat(dir)).isDirectory()) { continue; } } catch { continue; }
		let has = false;
		for (const sub of ['笔记', '库']) {
			try { if ((await stat(join(dir, sub))).isDirectory()) { has = true; break; } } catch { /* 没有这个子目录 */ }
		}
		if (!has || found.has(dir)) { continue; }
		found.set(dir, { localId: name, name });
	}
	const items = [];
	for (const [dir, meta] of found) {
		let version = '';
		try { version = await deriveVersion(dir); } catch { version = ''; }
		items.push({
			kind: 'knowledge',
			localId: meta.localId,
			name: meta.name,
			version: version || '1.0.0',
			sourceDir: dir,
		});
	}
	return items;
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
