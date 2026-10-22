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

/** 各 kind 的本地根目录名（与 IDE 侧 `SarosPath` 同口径）。 */
const KIND_DIR = { skill: 'skills', workflow: 'workflows' };

/**
 * 读一个本地资源的版本（读不到就空串，不抛）。
 *
 * @param {string} dir
 * @param {string} kind
 */
async function versionOf(dir, kind) {
	try {
		if (kind === 'skill') {
			const md = await readFile(join(dir, 'SKILL.md'), 'utf8');
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
				await stat(join(dir, kind === 'skill' ? 'SKILL.md' : 'workflow.json'));
			} catch {
				continue;
			}
			items.push({ kind, localId: name, version: await versionOf(dir, kind) });
		}
	}
	return items;
}
