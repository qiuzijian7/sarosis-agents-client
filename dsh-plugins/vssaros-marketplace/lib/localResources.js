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
import { join } from 'node:path';
import { PUBLISHABLE_KINDS } from './publisher.js';

/**
 * 各 kind 的本地根目录名（与 IDE 侧 `SarosPath` 同口径）。
 *
 * ★ 2026-10-22 晚：加 `agent` —— agent 的本地形态是 `<数据根>/agents/<id>/.agent.md`，
 *   与 skill/workflow 一样是目录镜像 ⇒ 可发布、可安装 ✓
 */
// ★ 2026-10-23：加 mcp（`<数据根>/mcp/<id>/`，入口是 config.json）
const KIND_DIR = { skill: 'skills', workflow: 'workflows', agent: 'agents', mcp: 'mcp' };

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
async function versionOf(dir, kind) {
	try {
		// skill 与 agent 都从 markdown 的 frontmatter 取 version（agent 是 `.agent.md`）
		if (kind === 'skill' || kind === 'agent') {
			const md = await readFile(join(dir, ENTRY_OF[kind]), 'utf8');
			const head = md.split(/\r?\n---/)[0] ?? '';
			const m = /^version:\s*(.+)$/m.exec(head);
			return m ? m[1].trim() : '';
		}
		const wf = JSON.parse(await readFile(join(dir, 'workflow.json'), 'utf8'));
		return typeof wf?.version === 'string' ? wf.version : '';
	} catch {
		return '';
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
			try {
				await stat(join(dir, ENTRY_OF[kind]));
			} catch {
				continue;
			}
			items.push({ kind, localId: name, version: await versionOf(dir, kind) });
		}
	}
	return items;
}
