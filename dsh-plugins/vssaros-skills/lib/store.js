// @vssaros/dsh-skills — store（主机侧 I/O）：数据根解析 + 技能目录扫描。
//
// 只读：本模块不声明 `vssaros.owns`（不写任何数据），所以没有锁/原子写那一套——与 kanban 的写入切片
// 是刻意的不对称（方案 6.8 的 owns 只对写路径有意义）。
//
// 数据根口径与 `@vssaros/dsh-kanban` 完全一致：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`。
// （方案 6.9 方案 C：契约共享、实现各自一份——两处各写一遍，由契约守卫与探针对齐。）

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SKILL_FILE, skillFromFile } from './core/skills.js';

/** 数据根。优先级：`config.dataRoot` → 环境变量 → `~/.vssaros`。 */
export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

/** 技能根：`config.skillsRoot`（测试/特殊部署用）→ `<数据根>/skills`。 */
export function skillsRootOf(config) {
	const configured = typeof config?.skillsRoot === 'string' ? config.skillsRoot.trim() : '';
	return configured || join(dataRootOf(config), 'skills');
}

/** 读一个技能文件；不存在/不可读返回 undefined（调用方按"已不可加载"处理）。 */
export async function readSkillFile(file) {
	try {
		return await readFile(file, { encoding: 'utf8' });
	} catch {
		return undefined;
	}
}

/** 目录指纹：用子目录名集合近似（技能增删会变；技能正文改动由 `get()` 现读，不进指纹）。 */
async function fingerprintOf(root) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name).sort().join(',');
	} catch {
		return 'absent';
	}
}

/**
 * 扫描技能根：每个子目录找 `SKILL.md`。
 * 返回 `{ skills, errors, root, missing }`——**不因为单个坏文件丢掉其它可用技能**（与 dsh 对来源的
 * 容错口径一致），坏文件带原因进 `errors`。
 */
export async function scanSkills(root, signal) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { skills: [], errors: [], root, missing: root, fingerprint: 'absent' };
		}
		throw new Error(`技能目录读取失败（${root}）：${e?.message ?? e}`);
	}
	const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
	const skills = [];
	const errors = [];
	for (const dir of dirs) {
		if (signal?.aborted) {
			break;
		}
		const file = join(root, dir, SKILL_FILE);
		try {
			const info = await stat(file);
			if (!info.isFile()) {
				continue;
			}
		} catch {
			continue; // 子目录里没有 SKILL.md：正常（比如 scripts/、docs/）
		}
		const text = await readSkillFile(file);
		if (text === undefined) {
			errors.push(`读取失败：${file}`);
			continue;
		}
		const parsed = skillFromFile(text, { id: dir, file });
		if (parsed.error) {
			errors.push(parsed.error);
			continue;
		}
		skills.push(parsed.skill);
	}
	return { skills, errors, root, fingerprint: await fingerprintOf(root) };
}

/** `SKILL.md` 所在目录名（技能 id），诊断用。 */
export function skillIdOf(file) {
	return basename(dirname(file));
}

/**
 * `SKILL.md` 的路径 → **技能目录**（绝对路径）。
 *
 * 为什么必须把它给出去（2026-10-13 实测事故）：技能里的脚本是模型用 bash/pwsh 执行的，而进程 cwd 是
 * **会话工作区**、不是技能目录 ⇒ `SKILL.md` 里 `node bin/archify.mjs doctor` 这种相对路径在工作区根下
 * 直接 `Cannot find module '<workspace>\bin\archify.mjs'` ✗✗。与 IDE 侧"技能 CLI 一律以绝对路径呈现"
 * （2026-08-03 决策，`skillTools.ts` 注入 skillDir + scriptPaths）同一口径 ✓。
 *
 * 行为：与 `dirname` 同（Windows 认两种分隔符 ✓；裸文件名返回 `'.'` —— 扫描器给的都是拼好的绝对路径 ⇒
 * 正常不会走到那个分支 ✓）。
 */
export function skillDirOf(file) {
	return dirname(file);
}
