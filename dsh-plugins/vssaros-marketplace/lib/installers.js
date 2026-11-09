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
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listTarGzEntries } from './tar.js';
// ★ 2026-11-09 Bot 组合包：清单契约 + MCP 注册/注销 + 台账（三者都不反向依赖 installers ⇒ 无环）
import {
	BOT_MANIFEST_FILE, BOT_RECEIPT, readBotManifest, scanBotSecrets, validateBotPack,
	checkBotRequires, componentIdMap, rewriteAgentMd, rewriteSkillName,
} from './botPack.js';
import { registerMcpServer, removeMcpCompletely } from './mcpInstall.js';
import { readInstalled, removeInstalled, upsertInstalled } from './installedLedger.js';

/**
 * 落数据根的商品类型。
 *
 * ★ 2026-10-22 晚：**agent 也搬进来了**（用户要求"继续搬 agent"）。
 *   取证结论：agent 的本地形态极简 —— `<数据根>/agents/<id>/.agent.md`（config.html 属历史遗留，2026-11-07 起不再写入），
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
	// ★ 2026-10-31：知识库落到 <数据根>/knowledge/<id>/（与 publisher 的 KIND_DIR 同口径 ✓）
	if (kind === 'knowledge') { return join(dataRoot, 'knowledge'); }
	throw new Error(`dsh 侧还不支持安装这一类：${kind}（当前支持 ${BUNDLE_KINDS.join(' / ')}）`);
}

/**
 * 把 agent 包**规范化**成"磁盘上该有的样子"（★ 2026-10-22）。
 *
 * 两种包格式都要认（见 `BUNDLE_KINDS` 的注释）：
 *   · 有 `agent.json` ⇒ 从 `files.agentsMd` 取出 `.agent.md` 全文。
 *     ★ 2026-11-07（移除 config.html）：旧包的 `files.configHtml` / `files.htmlContent`
 *     不再落成 `config.html`；包内自带的 `config.html` 文件仍原样安装 ✓
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
	// ★ 2026-11-07（移除 config.html）：旧包 `files.configHtml` / `files.htmlContent`
	//   不再落成 config.html —— IDE 侧 UI 已整体退役，落盘只会留下无人消费的孤儿文件。
	//   目录镜像包里**自带**的 config.html 仍由上面的 out.filter 原样保留 ⇒ 旧包兼容不破 ✓
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
 * ★ 2026-11-09：**Bot 组合包分发安装**。
 *
 * 为什么不能走普通 `installBundle` 的单目录落位：包里的 `skills/<name>/`、`mcp/<id>/`
 * 会被原样塞进 `<数据根>/agents/<id>/`，而技能 provider 只扫 `<数据根>/skills/`、
 * MCP 只认 `<数据根>/mcp.json` ⇒ **不报错但技能/MCP 永远不生效**（最危险的假绿）。
 *
 * 做法：先全量校验 + 生成落位计划 + 查冲突，再逐项写；任一步失败把本次新建的目录回滚掉。
 * `bot.json` 留在 agent 目录里（agents 扫描器只读 `.agent.md`），供 `uninstallBundle`
 * 级联卸载时反查「当初分发了哪些组件」。
 */
/**
 * ★ 升级迁移：读旧版本落盘的 bot.json，算出「上一次分发出去的组件 id」。
 * 老包（`namespace:false`）用裸名，新版本默认开启后带前缀 ⇒ 不清理的话
 * 数据根会同时留两份技能，`mcp.json` 也会多一条指向旧目录的行。
 * 没有 `installedComponents` 时回退到原声明名（更早的老包）。
 */
async function previousComponentIds(dataRoot, storeId) {
	const file = join(dataRoot, 'agents', storeId, BOT_MANIFEST_FILE);
	if (!await exists(file)) { return []; }
	let old;
	try { old = JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
	const installed = old.installedComponents && typeof old.installedComponents === 'object'
		? old.installedComponents : {};
	const skills = Array.isArray(installed.skills) ? installed.skills
		: (Array.isArray(old.skills) ? old.skills : []);
	const mcps = Array.isArray(installed.mcpServers) ? installed.mcpServers
		: (Array.isArray(old.mcpServers) ? old.mcpServers : []);
	return [
		...skills.map(s => ({ kind: 'skill', id: String(s) })),
		...mcps.map(m => ({ kind: 'mcp', id: String(m) })),
	];
}

async function installBotPack({ dataRoot, storeId, version, files, bot, upgrade }) {
	const checked = validateBotPack(files, bot);
	if (checked.botId !== storeId) {
		throw new Error(`bot.json 的 botId（${checked.botId}）与商城标识（${storeId}）不一致`);
	}
	// ★ 2026-11-09 P1：依赖范围如实核对。查不到版本 ⇒ unknown（不阻断，但回执里明说）；
	//   明确 incompatible ⇒ 装一半也没用，直接拒。
	const requires = checkBotRequires(bot, {});
	if (!requires.ok) {
		const bad = requires.results.filter(r => r.state === 'incompatible')
			.map(r => `${r.name} 需要 ${r.range}，当前 ${r.found}`).join('；');
		throw new Error(`Bot 依赖不满足：${bad}`);
	}
	// 安装端再扫一次：包可能不是从自家发布端来的（离线包 / 换过服务端）
	const blockers = scanBotSecrets(files);
	if (blockers.length) {
		throw new Error('安装被凭据扫描拦下：包内含明文密钥/token，请改用 ${env:VAR} 占位符');
	}
	const map = componentIdMap(bot);
	const pathsOf = (prefix) => files
		.filter(f => f.path.startsWith(prefix))
		.map(f => ({ ...f, path: f.path.slice(prefix.length) }));
	const skillPrefixes = checked.skills.map(s => `skills/${s}/`);
	const mcpPrefixes = checked.mcpServers.map(m => `mcp/${m}/`);
	// ★ 命名空间：落位的 `.agent.md` 必须把 skills:/tools: 里的引用同步改成加前缀后的名字，
	//   否则 Bot 会指向一个不存在的技能；落盘 bot.json 记下实际 id 供级联卸载反查。
	const agentFiles = files.filter(f => f.path !== 'manifest.json'
		&& !skillPrefixes.some(p => f.path.startsWith(p))
		&& !mcpPrefixes.some(p => f.path.startsWith(p)))
		.map(f => {
			if (f.path === '.agent.md') {
				return { ...f, data: Buffer.from(rewriteAgentMd(f.data.toString('utf8'), map)) };
			}
			if (f.path === BOT_MANIFEST_FILE) {
				return { ...f, data: Buffer.from(JSON.stringify({
					...bot,
					installedComponents: {
						prefix: checked.prefix,
						skills: checked.installedIds.skills,
						mcpServers: checked.installedIds.mcpServers,
					},
				}, null, 2)) };
			}
			return f;
		});
	const plan = [
		{ kind: 'agent', id: storeId, dir: join(dataRoot, 'agents', storeId), files: agentFiles },
		...checked.skills.map((s, i) => {
			const installedId = checked.installedIds.skills[i];
			return {
				kind: 'skill', id: installedId, dir: join(dataRoot, 'skills', installedId),
				files: pathsOf(`skills/${s}/`).map(f => f.path === 'SKILL.md'
					? {
						...f,
						data: Buffer.from(injectSkillFrontmatter(
							rewriteSkillName(f.data.toString('utf8'), installedId),
							{ storeId: installedId, version })),
					}
					: f),
			};
		}),
		...checked.mcpServers.map((m, i) => {
			const installedId = checked.installedIds.mcpServers[i];
			return {
				kind: 'mcp', id: installedId, source: m,
				dir: join(dataRoot, 'mcp', installedId), files: pathsOf(`mcp/${m}/`),
			};
		}),
	];
	// 冲突检查必须在任何写盘之前（否则会留下「装了 2/3 个组件」的残局）
	// ★ 2026-11-09：台账的 owner 决定「这个组件是不是别人的」—— 两个 Bot 包用了
	//   同一个通用技能名时不许静默覆盖，报错要点出占用者，让作者改名或对方先卸载。
	const ledger = await readInstalled(dataRoot);
	const ownerOf = (kind2, id) => ledger.find(e => e.kind === kind2 && e.storeId === id)?.owner ?? '';
	// 必须在写盘前读：upgrade 会先 rm 掉整个 agent 目录（旧 bot.json 也一起没了）。
	const previousIds = upgrade ? await previousComponentIds(dataRoot, storeId) : [];
	if (!upgrade) {
		for (const item of plan) {
			if (await exists(item.dir)) {
				const owner = ownerOf(item.kind, item.id);
				if (owner && owner !== storeId) {
					throw new Error(`「${item.id}」已被其它包占用（owner: ${owner}）：${item.dir}。请改名或让对方先卸载，不覆盖别人的组件`);
				}
				throw new Error(`「${item.id}」已经装过了（${item.dir}）。要更新请用「升级」，或先卸载${owner ? `（owner: ${owner}）` : ''}`);
			}
		}
	}
	const written = [];
	try {
		for (const item of plan) {
			await writeFiles(item.dir, item.files, { overwrite: upgrade });
			written.push(item);
		}
		for (const item of plan.filter(p => p.kind === 'mcp')) {
			const mf = files.find(f => f.path === `mcp/${item.source}/config.json`);
			await registerMcpServer(dataRoot, item.id, JSON.parse(mf.data.toString('utf8')));
		}
		// 每个组件一条台账 ⇒ 已安装页签 / 升级检查能看到全部分发物，而不是只看到 Bot
		for (const item of plan) {
			await upsertInstalled(dataRoot, { kind: item.kind, storeId: item.id, version, owner: storeId });
		}
		// ★ 升级迁移：旧版本分发过、本次不再使用的组件要清掉（老包裸名 → 新版本带前缀）。
		//   只清 owner 属于自己的，别人的组件绝不碰；清理失败也不该让整个升级回滚。
		const currentIds = new Set(plan.map(p => p.id));
		for (const old of previousIds) {
			if (currentIds.has(old.id)) { continue; }
			const owner = ownerOf(old.kind, old.id);
			if (owner && owner !== storeId) { continue; }
			try {
				if (old.kind === 'mcp') { await removeMcpCompletely(dataRoot, old.id); }
				else { await rm(join(dataRoot, 'skills', old.id), { recursive: true, force: true }); }
				await removeInstalled(dataRoot, old.kind, old.id);
			} catch { /* 旧目录只是冗余；新版本已就位，不因清理失败回滚 */ }
		}
	} catch (e) {
		for (const item of written) {
			if (!upgrade) { await rm(item.dir, { recursive: true, force: true }).catch(() => undefined); }
		}
		for (const item of plan.filter(p => p.kind === 'mcp')) {
			await removeMcpCompletely(dataRoot, item.id).catch(() => undefined);
		}
		throw e;
	}
	return {
		targetDir: plan[0].dir,
		fileCount: files.length,
		skipped: [],
		bot: BOT_RECEIPT,
		// ★ 依赖状态如实回执：unknown ≠ 已满足，前端不该把「没查到」说成「都装好了」
		requires,
		components: plan.map(p => ({ kind: p.kind, id: p.id, dir: p.dir })),
	};
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
	// ★ 2026-11-09：包里有 bot.json ⇒ 组合包，走分发安装；普通 agent 包保持原链路 ✓
	const bot = readBotManifest(files);
	if (bot) {
		return installBotPack({ dataRoot, storeId, version, files, bot, upgrade });
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
	// ★ 2026-10-31：知识库装完**登记成库**（否则在知识库里看不见 ⇒ 等于没装）
	let vault = undefined;
	if (kind === 'knowledge') {
		try {
			// ⚠ 这里**没有** manifest 变量（此前误引用它 ⇒ ReferenceError 被吞 ⇒ 登记静默失败）
			//   ⇒ 从包内的 manifest.json 里取名字；取不到就用 storeId ✓
			let kbName = storeId;
			try {
				const mf = files.find(f => f.path === 'manifest.json');
				if (mf) {
					const j = JSON.parse(mf.data.toString('utf8'));
					if (j && typeof j.name === 'string' && j.name.trim()) { kbName = j.name.trim(); }
				}
			} catch { kbName = storeId; }
			vault = await registerKnowledgeVault({ dataRoot, id: storeId, name: kbName, dir: targetDir });
		} catch { /* best effort：登记失败不该让安装失败 */ }
	}
	return { targetDir, fileCount: files.length, skipped, ...(vault ? { vault } : {}), ...(backup ? { backup } : {}) };
}

/**
 * ★ 2026-10-31：知识库**装完必须让知识库侧看得见**。
 *
 * 为什么需要这一步：装完只是"文件落在 <数据根>/knowledge/<id>/"，而知识库的库清单
 *   在**另一个插件**（vssaros-kb）的数据根下（`<dshHome>/knowledge-base/.extra-vaults.json`）
 *   ⇒ 两边数据根不同、又没有跨插件服务 ⇒ 用**注册表文件**做契约：
 *     本侧写 `<kb数据根>/.market-vaults.json`，KB 侧读它并合并进库清单 ✓。
 *
 * ⚠ best effort：找不到 KB 数据根就只写"包内标记"（.kb-vault.json），绝不因此让安装失败。
 */
export const MARKET_VAULTS_FILE = '.market-vaults.json';

/** 推测知识库插件的数据根（含 `knowledge-base` 目录的那一层）。 */
export function kbDataRootOf(dataRoot) {
	let cur = resolve(String(dataRoot ?? ''));
	for (let i = 0; i < 5; i++) {
		const cand = join(cur, 'knowledge-base');
		try { if (statSync(cand).isDirectory()) { return cand; } } catch { /* 继续往上 */ }
		const up = dirname(cur);
		if (!up || up === cur) { break; }
		cur = up;
	}
	return '';
}

/**
 * 把一个装好的知识库登记进知识库插件的清单。
 * @returns {Promise<{ ok: boolean, path?: string, why?: string }>}
 */
export async function registerKnowledgeVault({ dataRoot, id, name, dir }) {
	const entry = {
		id: String(id ?? ''),
		name: String(name ?? id ?? ''),
		path: resolve(String(dir ?? '')),
		from: 'marketplace',
		attachedAt: new Date().toISOString(),
	};
	// ① 包内标记（无论找不找得到 KB 数据根都写 ⇒ KB 侧可据此识别）
	try {
		await writeFile(join(entry.path, '.kb-vault.json'), JSON.stringify(entry, null, 2), 'utf8');
	} catch { /* best effort */ }
	// ② 写 KB 侧注册表
	const kbRoot = kbDataRootOf(dataRoot);
	if (!kbRoot) { return { ok: false, why: 'kb-data-root-not-found' }; }
	const file = join(kbRoot, MARKET_VAULTS_FILE);
	try {
		let list = [];
		try { list = JSON.parse(await readFile(file, 'utf8')) ?? []; } catch { list = []; }
		if (!Array.isArray(list)) { list = []; }
		const idx = list.findIndex((v) => v && v.id === entry.id);
		if (idx >= 0) { list[idx] = entry; } else { list.push(entry); }
		await writeFile(file, JSON.stringify(list, null, 2), 'utf8');
		return { ok: true, path: file };
	} catch (e) {
		return { ok: false, why: String((e && e.message) || e) };
	}
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
	// ★ 2026-11-09 级联卸载：组合包安装时把 bot.json 留在了 agent 目录里，
	//   按它反查当初分发出去的技能/MCP，逐个删目录 + 注销 mcp.json + 清台账。
	//   不这么做的话，卸载 Bot 会留下一堆「装了但没人用」的技能和 MCP 行。
	const botFile = join(targetDir, BOT_MANIFEST_FILE);
	if (await exists(botFile)) {
		let bot = {};
		try { bot = JSON.parse(await readFile(botFile, 'utf8')); } catch { /* 清单坏了也要删主目录 */ }
		// ★ 2026-11-09 P1：优先用落盘 bot.json 里的「实际落位 id」（命名空间加了前缀）。
		//   老包没有 installedComponents ⇒ 回退到原声明名，逐字兼容。
		const installed = bot.installedComponents && typeof bot.installedComponents === 'object'
			? bot.installedComponents : {};
		const skills = Array.isArray(installed.skills) ? installed.skills.map(String)
			: (Array.isArray(bot.skills) ? bot.skills.map(String) : []);
		const mcps = Array.isArray(installed.mcpServers) ? installed.mcpServers.map(String)
			: (Array.isArray(bot.mcpServers) ? bot.mcpServers.map(String) : []);
		const ledger = await readInstalled(dataRoot);
		// ★ 2026-11-09：只清 owner 属于自己的组件。同名技能可能先被别的 Bot 包装过，
		//   按名字一律删会跨包互相破坏（老台账没有 owner ⇒ 视为本包，保持兼容）。
		const ownedByMe = (kind2, id) => {
			const row = ledger.find(e => e.kind === kind2 && e.storeId === id);
			return !row || !row.owner || row.owner === storeId;
		};
		for (const name of skills) {
			if (!ownedByMe('skill', name)) { continue; }
			await rm(join(dataRoot, 'skills', name), { recursive: true, force: true });
			await removeInstalled(dataRoot, 'skill', name);
		}
		for (const name of mcps) {
			if (!ownedByMe('mcp', name)) { continue; }
			// 先注销 mcp.json 再删目录（反了会留下指向不存在目录的 entry）
			await removeMcpCompletely(dataRoot, name);
			await removeInstalled(dataRoot, 'mcp', name);
		}
		await removeInstalled(dataRoot, kind, storeId);
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
