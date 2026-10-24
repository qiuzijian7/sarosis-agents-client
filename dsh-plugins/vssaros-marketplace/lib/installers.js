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

/**
 * 落数据根的商品类型。
 *
 * ★ 2026-10-22 晚：**agent 也搬进来了**（用户要求"继续搬 agent"）。
 *   取证结论：agent 的本地形态极简 —— `<数据根>/agents/<id>/.agent.md`（外加可选 config.html），
 *   而 `.agent.md` 的 frontmatter 就含完整定义（id/name/tools/skills/role…）⇒
 *   **能像 skill 一样解包落盘**，不需要 IDE 的 `createAgent`。
 *
 * ⚠ 包格式有两种，都要认：
 *   ① **旧包**（IDE 侧 preparePack 产的）：`agent.json`（AgentExportData），
 *      `.agent.md` 全文在 `files.agentsMd` 里 ⇒ 这里解出来写成 `.agent.md` ✓
 *   ② **新包**（dsh 侧目录镜像）：直接就有 `.agent.md` ✓
 */
// ★ 2026-10-23（用户「都转移到 dsh 侧实现」）：加 `mcp` —— 它的本地形态同样是目录
//   （`<数据根>/mcp/<id>/config.json`），只是装完还要**注册进 mcp.json**（见 `mcpInstall.js`）
export const BUNDLE_KINDS = ['skill', 'workflow', 'agent', 'mcp'];

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

/** 各 kind 的落地根：`<数据根>/skills` / `workflows` / `agents`（与 IDE 侧同口径 ✓）。 */
export function targetRootOf(dataRoot, kind) {
	if (kind === 'skill') { return join(dataRoot, 'skills'); }
	if (kind === 'workflow') { return join(dataRoot, 'workflows'); }
	if (kind === 'agent') { return join(dataRoot, 'agents'); }
	if (kind === 'mcp') { return join(dataRoot, 'mcp'); }
	throw new Error(`dsh 侧还不支持安装这一类：${kind}（当前支持 ${BUNDLE_KINDS.join(' / ')}）`);
}

/**
 * 把 agent 包**规范化**成"磁盘上该有的样子"（★ 2026-10-22）。
 *
 * 两种包格式都要认（见 `BUNDLE_KINDS` 的注释）：
 *   · 有 `agent.json` ⇒ 从 `files.agentsMd` 取出 `.agent.md` 全文；
 *     `files.configHtml` / `files.htmlContent` 落成 `config.html`（与 IDE 侧
 *     `agentInstaller.install` 写的是同一个文件 ✓）
 *   · 没有 `agent.json` ⇒ 要求包内**自带** `.agent.md`（目录镜像）
 *
 * ⚠ 不解析 `agent.json` 的 `agent` 元数据：`.agent.md` 的 frontmatter 已经是完整定义
 *   （dsh 侧 preset 只读它）⇒ 多存一份反而会漂 ✗
 *
 * @param {{ path: string, data: Buffer }[]} files
 * @param {string} storeId
 * @returns {{ path: string, data: Buffer }[]}
 */
export function normalizeAgentBundle(files, storeId) {
	const agentJsonIndex = files.findIndex(f => f.path === 'agent.json');
	if (agentJsonIndex < 0) {
		if (!files.some(f => f.path === '.agent.md')) {
			throw new Error('agent 包里既没有 agent.json 也没有 .agent.md（不知道该装什么）');
		}
		// ⚠ 必须返回**拷贝**：调用方是"清空原数组再 push 回来"，返回同一个引用会把自己清空 ✗
		//   （2026-10-22 真被测试抓到：目录建了、文件一个都没写）
		return files.slice();
	}
	let parsed;
	try {
		parsed = JSON.parse(files[agentJsonIndex].data.toString('utf8'));
	} catch (e) {
		throw new Error(`agent.json 不是合法 JSON：${String(e?.message ?? e)}`);
	}
	const bundleFiles = parsed?.files ?? {};
	const agentsMd = typeof bundleFiles.agentsMd === 'string' ? bundleFiles.agentsMd : '';
	if (!agentsMd.trim()) {
		throw new Error('agent.json 里没有 files.agentsMd（这是 agent 的定义正文，缺了就装不出可用的 agent）');
	}
	// id 对不上就明确拒：装进去也注册不出来（preset 的 id 取自 frontmatter，与目录名不一致会更乱）
	const declaredId = typeof parsed?.agent?.id === 'string' ? parsed.agent.id.trim() : '';
	if (declaredId && declaredId !== storeId) {
		throw new Error(`包的 agent.id（${declaredId}）与商城标识（${storeId}）不一致 —— 装进去会和目录名对不上`);
	}
	const out = files.filter(f => f.path !== 'agent.json');
	out.push({ path: '.agent.md', data: Buffer.from(agentsMd, 'utf8') });
	if (out.every(f => f.path !== 'config.html')) {
		const configHtml = typeof bundleFiles.configHtml === 'string'
			? bundleFiles.configHtml
			: (typeof bundleFiles.htmlContent === 'string' ? bundleFiles.htmlContent : '');
		if (configHtml.trim()) {
			out.push({ path: 'config.html', data: Buffer.from(configHtml, 'utf8') });
		}
	}
	return out;
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
	// ★ 2026-10-23：**只有技能**需要这一步 —— dsh 的 `isSkillName` 只接受 kebab-case，
	//   所以 `name` 不可能写成中文；Agent / 工作流的 `name` 本来就允许中文，不需要第二个字段。
	//   商城商品名（「Kami 文档设计系统」）写进 `displayName` ⇒ 本地条目 UI 标题不退化。
	if (meta.displayName) { setKey('displayName', meta.displayName); }
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
export async function installBundle({ dataRoot, kind, storeId, version, gzBuffer, files: unpackedFiles, expectedSha256, upgrade = false, displayName = '' }) {
	// ★ 2026-10-22：id 越界检查 + **在校验完 sha256 之前不碰磁盘**（顺序很重要：
	//   先验包、再建目录 ⇒ 坏包不会留下半个目录）✓
	assertSafeStoreId(storeId, 'storeId');
	const wanted = String(expectedSha256 ?? '').trim().toLowerCase();
	if (wanted) {
		if (!gzBuffer) { throw new Error('给了 expectedSha256 但没有包体（无法校验）'); }
		const actual = sha256Of(gzBuffer);
		if (actual !== wanted) {
			throw new Error(`包的 sha256 对不上（期望 ${wanted.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）⇒ 包可能损坏或被替换`);
		}
	}
	const root = targetRootOf(dataRoot, kind);
	const targetDir = join(root, storeId);
	// ★ 2026-10-22：允许调用方直接给**已解开的文件**（GitHub 源要先"定位安装根"剥掉
	//   `<repo>-<ref>/` 前缀；若这里再要求 tar.gz，就得 解开→重打包→再解开，纯浪费 ✗）
	const { files, skipped } = Array.isArray(unpackedFiles)
		? { files: unpackedFiles, skipped: [] }
		: gzBuffer
			? await unpackBundle(gzBuffer)
			: (() => { throw new Error('installBundle 需要 gzBuffer 或 files 其中之一'); })();
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
		const injected = injectSkillFrontmatter(files[skillMdIndex].data.toString('utf8'), { storeId, version, displayName });
		files[skillMdIndex] = { path: 'SKILL.md', data: Buffer.from(injected, 'utf8'), mode: files[skillMdIndex].mode };
	}
	// workflow：workflow.json 必须存在
	if (kind === 'workflow') {
		const i = files.findIndex(f => f.path === 'workflow.json');
		if (i < 0) {
			throw new Error('包里缺少 workflow.json（工作流包必须带定义文件）');
		}
		// 2026-10-23（简化）：**不再**往 workflow.json 塞 displayName ——
		// workflow.json 的 `name` 本来就是可读名（「动态表情包工作流」），多一个字段只会让人猜哪个算数。
	}
	// agent（★ 2026-10-22）：旧包（agent.json + files.agentsMd）要转成 `.agent.md`；
	// 目录镜像包直接就有 `.agent.md` ✓（见 normalizeAgentBundle）
	if (kind === 'agent') {
		const normalized = normalizeAgentBundle(files, storeId);
		// 2026-10-23（简化）：Agent 的 `.agent.md` 里 `name` 允许中文（现有全是「GR垃圾回收专家」这类）
		// ⇒ 不需要 displayName；只有 **skill** 因为 dsh 强制 kebab 才需要第二个字段。

		files.length = 0;
		files.push(...normalized);
	}

	// ★ 2026-10-22（真机端到端抓到）：`manifest.json` 是**打包元数据**，不属于资源本体
	//   ⇒ **不落盘**（三种 kind 都一样）。此前它会跟着写进 `<数据根>/<kind根>/<id>/` ⇒
	//   资源目录里多出一个服务端格式的文件（污染，且下次发布还会把它当资源内容打进去 ✗）
	const runtimeFiles = files.filter(f => f.path !== 'manifest.json');
	await writeFiles(targetDir, runtimeFiles, { overwrite: Boolean(existing) });
	return { targetDir, fileCount: files.length, skipped, ...(backup ? { backup } : {}) };
}

/**
 * 卸载到回收站（★ 2026-10-23：用户要"已安装的工作流能删除"）。
 *
 * 为什么不直接 `uninstallBundle`（rm -rf）：本地自建的工作流/Agent **没有商城包可以重装**，
 * 删了就是永久丢失 ⇒ 一律移到 `<数据根>/.trash-<时间戳>/<kind>/<id>/`，用户能自己捞回来。
 *
 * @param {object} args
 * @param {string} args.dataRoot
 * @param {string} args.kind
 * @param {string} args.storeId
 */
export async function trashBundle({ dataRoot, kind, storeId }) {
	assertSafeStoreId(storeId, 'storeId');
	const root = targetRootOf(dataRoot, kind);
	const from = join(root, storeId);
	if (!await exists(from)) {
		throw new Error('「' + storeId + '」不在 ' + root + ' 里（可能已经删过）');
	}
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
	const to = join(dataRoot, '.trash-' + stamp, kind, storeId);
	await mkdir(dirname(to), { recursive: true });
	await rename(from, to);
	return { movedTo: to };
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
