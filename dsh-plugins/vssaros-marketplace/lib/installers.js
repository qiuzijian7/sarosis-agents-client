// @vssaros/dsh-marketplace — 安装器（★ 2026-10-22 S2：dsh 侧自己下载/解包/落盘）
//
// ★ 为什么在 dsh 侧：这三类商品落的就是**数据根**，而 dsh 侧本来就在写它
//   （`skill_manage` / `applyWorkflow`）⇒ 没有理由绕到 IDE 去装 ✓。
//   只有 **workbench** 包（dsh 插件）仍必须走 IDE 主进程（`dsh plugin add` + 重启 Host）。
//
// ★ 与 IDE 侧 `installers/*` 的语义**必须一致**（两侧都可能装同一个包 ⇒ 落点与格式不能漂）：
//   - skill：`<数据根>/skills/<id>/`，`SKILL.md` 的 frontmatter **回写 `storeId` / `version`**
//     （升级溯源要靠它；IDE 侧 `skillInstaller.injectFrontmatter` 同款）✓
//   - workflow：`<数据根>/workflows/<id>/workflow.json`（dsh 引擎读同一处）
//   - agent：**本轮不做**（要生成 `.agent.md`，格式真源在 IDE 侧 `agentMdFormat.ts`；
//     dsh 侧复制一份会漂 ✗ ⇒ 仍走 IDE，等包格式统一成"包内自带 `.agent.md`"再搬）
//
// ★ 覆盖保护：
//   - `install`：目标已存在 ⇒ **拒绝**（提示走"升级"）—— 与 IDE 侧 `!opts.force` 同语义 ✓
//   - `upgrade`：覆盖（skill 先删旧目录再写，避免残留旧文件）
//   - 升级前的本地备份：skill 的旧目录**改名**到 `<skills>/.upgrade-backup/<id>-<ts>/`（失手可恢复）
//
// ★ 一切失败**如实抛错**（绝不"装了一半还说成功"）✓

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listTarGzEntries } from './tar.js';

/** 三类落数据根的商品（agent 暂不在内，见文件头）。 */
export const BUNDLE_KINDS = ['skill', 'workflow'];

/** sha256（hex）。 */
export function sha256Of(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 校验落盘用的 id（`storeId` / `localId`）**不许跑出数据根**（★ 2026-10-22）。
 *
 * 为什么必须自己校验：id 虽然来自商城 slug（服务端也校验过），
 * 但**不能把"目录不能越界"这件事委托给远端** —— 服务端被换/被绕过时，
 * 这里就是最后一道。`join(root, '../evil')` 会把文件写到数据根**外面** ✗✗
 *
 * 拒绝：空、`.`/`..`、含 `/` 或 `\`、盘符（`C:`）、控制字符。
 *
 * @param {unknown} id
 * @param {string} [what] 报错时用的字段名
 * @returns {string} 校验通过的原值
 */
export function assertSafeStoreId(id, what = 'id') {
	const value = String(id ?? '');
	if (!value) { throw new Error(`${what} 不能为空`); }
	if (value === '.' || value === '..') { throw new Error(`${what} 不能是 "${value}"`); }
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(value)) { throw new Error(`${what} 含控制字符`); }
	if (/[\\/]/.test(value)) { throw new Error(`${what} 不能含路径分隔符：${value}`); }
	if (/^[A-Za-z]:/.test(value)) { throw new Error(`${what} 不能是盘符路径：${value}`); }
	return value;
}

/** 各 kind 的落地根：`<数据根>/skills` / `<数据根>/workflows`。 */
export function targetRootOf(dataRoot, kind) {
	if (kind === 'skill') { return join(dataRoot, 'skills'); }
	if (kind === 'workflow') { return join(dataRoot, 'workflows'); }
	throw new Error(`dsh 侧还不支持安装这一类：${kind}（当前支持 ${BUNDLE_KINDS.join(' / ')}）`);
}

/** 目录是否存在。 */
async function exists(p) {
	try { await stat(p); return true; } catch { return false; }
}

/**
 * 在 SKILL.md 的 frontmatter 里注入/替换 `storeId` 与 `version`（升级溯源）。
 *
 * 与 IDE 侧 `skillInstaller.injectFrontmatter` 同语义：**有则替换、无则追加**，
 * 其余行**逐字保留**（不动用户/作者写的东西 ✓）。
 *
 * @param {string} content
 * @param {{ storeId: string, version: string }} meta
 */
export function injectSkillFrontmatter(content, meta) {
	const text = String(content ?? '');
	const lines = text.split(/\r?\n/);
	if (lines.length === 0 || lines[0].trim() !== '---') {
		// 没有 frontmatter ⇒ 补一个（最小合法形态）
		return `---\nstoreId: ${meta.storeId}\nversion: ${meta.version}\n---\n\n${text}`;
	}
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
	if (end < 0) {
		// frontmatter 没闭合（坏文件）⇒ 不猜，原样返回并让调用方报错
		throw new Error('SKILL.md 的 frontmatter 没有闭合的 `---`（拒绝改写）');
	}
	const head = lines.slice(1, end);
	const setKey = (key, value) => {
		const prefix = `${key}:`;
		const at = head.findIndex(line => line.trim().startsWith(prefix));
		if (at >= 0) { head[at] = `${key}: ${value}`; } else { head.push(`${key}: ${value}`); }
	};
	setKey('storeId', meta.storeId);
	setKey('version', meta.version);
	return ['---', ...head, '---', ...lines.slice(end + 1)].join('\n');
}

/** 解包并返回 `路径 → Buffer`（已做路径穿越校验 ✓）。 */
export async function unpackBundle(gzBuffer) {
	// ⚠ 解压是**异步**的（`gunzip` 而非 `gunzipSync`，见 tar.js 的说明）⇒ 这里也必须 async ✓
	const { files, dirs, skipped } = await listTarGzEntries(gzBuffer);
	return { files, dirs, skipped };
}

/**
 * 把解出来的文件写进目标目录（`overwrite` 决定是否先清空）。
 *
 * @param {string} targetDir
 * @param {{ path: string, data: Buffer }[]} files
 * @param {{ overwrite?: boolean }} [opts]
 */
async function writeFiles(targetDir, files, opts = {}) {
	if (opts.overwrite) { await rm(targetDir, { recursive: true, force: true }); }
	await mkdir(targetDir, { recursive: true });
	for (const file of files) {
		const dest = join(targetDir, ...file.path.split('/'));
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, file.data);
	}
}

/**
 * 升级前把旧目录挪到备份处（**不删**，失手可恢复）。
 *
 * @param {string} targetDir
 * @param {string} backupRoot
 */
async function backupBeforeUpgrade(targetDir, backupRoot) {
	if (!await exists(targetDir)) { return undefined; }
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	await mkdir(backupRoot, { recursive: true });
	const dest = join(backupRoot, `${targetDir.split(/[\\/]/).pop()}-${ts}`);
	await cp(targetDir, dest, { recursive: true });
	return dest;
}

/**
 * 安装一个 bundle 包（skill / workflow）。
 *
 * @param {object} args
 * @param {string} args.dataRoot
 * @param {string} args.kind
 * @param {string} args.storeId 包 id（=商城 slug）
 * @param {string} args.version
 * @param {Buffer} args.gzBuffer 下载到的 package.tar.gz
 * @param {boolean} [args.upgrade] true = 覆盖（升级）；false/缺省 = 已存在则拒绝
 */
export async function installBundle({ dataRoot, kind, storeId, version, gzBuffer, expectedSha256, upgrade = false }) {
	// ★ 2026-10-22：id 越界检查 + **在校验完 sha256 之前不碰磁盘**（顺序很重要：
	//   先验包、再建目录 ⇒ 坏包不会留下半个目录）✓
	assertSafeStoreId(storeId, 'storeId');
	const wanted = String(expectedSha256 ?? '').trim().toLowerCase();
	if (wanted) {
		const actual = sha256Of(gzBuffer);
		if (actual !== wanted) {
			throw new Error(`包的 sha256 对不上（期望 ${wanted.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）⇒ 包可能损坏或被替换`);
		}
	}
	const root = targetRootOf(dataRoot, kind);
	const targetDir = join(root, storeId);
	const { files, skipped } = await unpackBundle(gzBuffer);
	if (files.length === 0) {
		throw new Error('包内没有任何文件（拒绝安装一个空包）');
	}
	const existing = await exists(targetDir);
	if (existing && !upgrade) {
		throw new Error(`「${storeId}」已经装过了。要在它基础上更新请用「升级」，或先卸载`);
	}
	let backup;
	if (existing && upgrade) {
		backup = await backupBeforeUpgrade(targetDir, join(root, '.upgrade-backup'));
	}

	// skill：SKILL.md 必须存在，且要回写 storeId/version（与 IDE 侧同语义 ✓）
	if (kind === 'skill') {
		const skillMdIndex = files.findIndex(f => f.path === 'SKILL.md');
		if (skillMdIndex < 0) {
			throw new Error('包里缺少 SKILL.md（技能包必须以 SKILL.md 为入口）');
		}
		const injected = injectSkillFrontmatter(files[skillMdIndex].data.toString('utf8'), { storeId, version });
		files[skillMdIndex] = { path: 'SKILL.md', data: Buffer.from(injected, 'utf8'), mode: files[skillMdIndex].mode };
	}
	// workflow：workflow.json 必须存在
	if (kind === 'workflow') {
		if (!files.some(f => f.path === 'workflow.json')) {
			throw new Error('包里缺少 workflow.json（工作流包必须带定义文件）');
		}
	}

	await writeFiles(targetDir, files, { overwrite: Boolean(existing) });
	return { targetDir, fileCount: files.length, skipped, ...(backup ? { backup } : {}) };
}

/**
 * 卸载一个 bundle 包（删目录；台账由调用方清 ✓）。
 *
 * @param {object} args
 * @param {string} args.dataRoot
 * @param {string} args.kind
 * @param {string} args.storeId
 */
export async function uninstallBundle({ dataRoot, kind, storeId }) {
	// 卸载也要挡越界 id（否则 `rm -rf ../..` 会删到数据根外）✗
	assertSafeStoreId(storeId, 'storeId');
	const root = targetRootOf(dataRoot, kind);
	const targetDir = join(root, storeId);
	if (!await exists(targetDir)) {
		throw new Error(`「${storeId}」没有装过（${targetDir} 不存在）`);
	}
	await rm(targetDir, { recursive: true, force: true });
	return { targetDir };
}

/** 读已装目录里的版本（skill 读 frontmatter，workflow 读 workflow.json），供"已安装"显示 ✓。 */
export async function installedVersionOf({ dataRoot, kind, storeId }) {
	assertSafeStoreId(storeId, 'storeId');
	const root = targetRootOf(dataRoot, kind);
	const file = kind === 'skill'
		? join(root, storeId, 'SKILL.md')
		: join(root, storeId, 'workflow.json');
	try {
		const text = await readFile(file, 'utf8');
		if (kind === 'workflow') {
			const parsed = JSON.parse(text);
			return typeof parsed?.version === 'string' ? parsed.version : undefined;
		}
		const m = /^version:\s*(.+)$/m.exec(text.split(/\r?\n---/)[0] ?? '');
		return m ? m[1].trim() : undefined;
	} catch {
		return undefined;
	}
}
