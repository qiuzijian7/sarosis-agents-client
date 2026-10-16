/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件包结构守卫（P3-0，方案 6.1 / 6.5 / 13.3）。
 *
 * 为什么需要：模块插件是"三处声明必须一致"的资产——插件包（`dsh-plugins/<name>/package.json` 的
 * `vssaros` 清单）、VsSaros 侧聚合表（`common/dshModuleContainers.ts`）、插件自己注册的页面路由。
 * 三处任一漂移都会表现为"图标在但页面 404"或"容器 ID 撞车"，而这类错误在编译期完全看不出来。
 *
 * 守卫范围（对 `dsh-plugins/*` 全量生效，含两个基础插件）：
 * 1. 包结构：包名前缀、patch 声明与文件存在、入口文件存在、files 覆盖产物；
 * 2. 依赖面：只允许 `peerDependencies` 里的 `@deepseek-ai/dsh`（随 dsh 分发的包不得声明为依赖）；
 * 3. patch 必须插入一行且其 `name` 等于包名（否则装上了也不挂载）；
 * 4. 有 `vssaros` 清单的模块插件：清单本身合法（用真实校验器），且与聚合表逐项一致
 *    （module / containerId / order / route / legacyCounterpart），路由还必须在插件源码里注册。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DSH_BUILTIN_MODULES, DSH_MODULE_CONTAINERS, DSH_MODULE_PAGES, defaultPageRoute, moduleContainerOf, moduleIdForPluginName } from '../../common/dshModuleContainers.js';
import { IVssarosPluginManifest, tryParseVssarosManifest } from '../../common/vssarosPluginManifest.js';
import { compareSemver, parseSemver, renderAgentsOverlay, renderBridgeOverlay, renderCodebaseOverlay, renderDataRootOverlay, renderKanbanOverlay, renderMemoryOverlay } from '../../common/dshCli.js';
import { renderSkillsOverlay } from '../../common/dshSkillDirs.js';
import { listBundledPlugins } from '../../electron-main/dshBundledPlugins.js';

const PLUGINS_REL = 'dsh-plugins';

interface IPluginPackage {
	readonly dirName: string;
	readonly dir: string;
	readonly json: Record<string, unknown>;
	/** patch 文件的绝对路径。 */
	readonly patchFiles: readonly string[];
	readonly patchText: string;
	/** main / exports 指向的入口文件绝对路径。 */
	readonly entryFiles: readonly string[];
	readonly filesField: readonly string[];
}

function repoRoot(): string | undefined {
	return fs.existsSync(path.join(process.cwd(), PLUGINS_REL)) ? process.cwd() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrArray(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value];
	}
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `files` 声明（相对路径，可能带 `./`、可能含通配）是否覆盖某个包内文件。 */
function filesCovers(files: readonly string[], dir: string, absFile: string): boolean {
	const rel = path.relative(dir, absFile).split(path.sep).join('/');
	return files.some(f => {
		const pattern = f.replace(/^\.\//, '');
		if (pattern === rel || pattern === `./${rel}`) {
			return true;
		}
		const base = pattern.replace(/\*+.*$/, '');
		return base.length > 0 && rel.startsWith(base);
	});
}

/**
 * **随包 vendored 的第三方包**（非 `@vssaros/*`）：逐条写明上游与理由。
 *
 * 为什么要有这份例外（2026-10-14）：`dsh-plugins/` 原本只放我们自己的 `@vssaros/*` 包 ⇒ 下面那几条断言
 * （包名前缀 / patch 必须插入"自己" / 必须声明 dsh peer）当时写成**无条件**是合理的。archify 是**产品要求
 * 随包预装**的第三方技能包（2026-10-14 用户拍板；理由与取舍见 `dsh-plugins/vssaros-archify/VENDOR.md`），
 * 它天然不满足那三条：
 *   · 包名是上游的 `@tt-a1i/archify-dsh`（**故意不改**：改成 `@vssaros/*` 就会与 npm 上那份变成"两个 provider
 *     各报一个 archify 技能" ✗ —— 那正是 2026-10-13 消灭掉的重复交付）；
 *   · patch 插的是 `@deepseek-ai/dsh-skill-filesystem`（配置**别人的** provider 去扫本包的 `skills/`），
 *     不是"插入自己那行"；
 *   · 上游没声明 dsh peer —— 我们不替上游**编**一个范围（编错会让 dsh 的准入检查**误拒**该插件 ✗）。
 * ⇒ 例外**只开这三条**（逐条在案）；包结构、文件存在性、`files` 覆盖这些**照样查** ✓，另外额外钉一条
 *   "vendored 目录里的版本 == 这里登记的版本"（防有人换了字节却忘了更新这份记录 ✓）。
 */
const VENDORED_THIRD_PARTY: Record<string, { readonly upstream: string; readonly version: string; readonly why: string }> = {
	'vssaros-archify': {
		upstream: '@tt-a1i/archify-dsh',
		version: '1.0.0',
		why: 'archify 技能随包预装（MIT，上游 tt-a1i/archify）。用户 2026-10-14 要求"默认随包自动装"。',
	},
};

/** 读取 `dsh-plugins/` 下每个含 package.json 的目录（跳过 node_modules）。 */
function readPluginPackages(root: string): readonly IPluginPackage[] {
	const baseDir = path.join(root, PLUGINS_REL);
	const out: IPluginPackage[] = [];
	for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === 'node_modules') {
			continue;
		}
		const dir = path.join(baseDir, entry.name);
		const manifestPath = path.join(dir, 'package.json');
		if (!fs.existsSync(manifestPath)) {
			continue;
		}
		const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
		const patchFiles = stringOrArray(asRecord(asRecord(json['dsh'])['bundle'])['patch'])
			.map(p => path.resolve(dir, p));
		const entryRel = [
			...stringOrArray(json['main']),
			...Object.values(asRecord(json['exports'])).flatMap(v => typeof v === 'string' ? [v] : Object.values(asRecord(v)).filter((x): x is string => typeof x === 'string')),
		].filter(p => p.startsWith('./') && (p.endsWith('.js') || p.endsWith('.mjs')));
		out.push({
			dirName: entry.name,
			dir,
			json,
			patchFiles,
			patchText: patchFiles.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n'),
			entryFiles: [...new Set(entryRel.map(p => path.resolve(dir, p)))],
			filesField: stringOrArray(json['files']),
		});
	}
	return out;
}

/**
 * 从入口出发走静态相对 import 图（BFS）。用途：`files` 必须覆盖**所有会被加载的文件**——
 * 漏写一个（如新增 `lib/store.js` 却没加进 files）就装出"能装不能跑"的包，而这类错误在本地开发时
 * 完全看不出来（源码目录里文件都在）。只跟相对说明符，裸包名与 `node:` 不跟。
 */
function collectRelativeImports(entryFiles: readonly string[], dir: string): readonly string[] {
	const seen = new Map<string, string>();
	const queue = entryFiles.filter(f => fs.existsSync(f));
	while (queue.length && seen.size < 200) {
		const file = queue.shift()!;
		if (seen.has(file)) {
			continue;
		}
		const source = fs.readFileSync(file, 'utf8');
		seen.set(file, source);
		for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
			const resolved = path.resolve(path.dirname(file), match[1]);
			if (fs.existsSync(resolved) && !seen.has(resolved)) {
				queue.push(resolved);
			}
		}
	}
	return [...seen.keys()];
}

/** 解析 `vssaros` 清单；不合法时直接 fail（守卫不做"跳过坏数据"的宽容处理）。 */
function manifestOf(plugin: IPluginPackage): IVssarosPluginManifest | undefined {
	const raw = plugin.json['vssaros'];
	if (raw === undefined) {
		return undefined;
	}
	const parsed = tryParseVssarosManifest(raw, { builtin: true });
	if (parsed.error !== undefined) {
		assert.fail(`${plugin.dirName} 的 vssaros 清单不合法：${parsed.error}`);
	}
	return parsed.manifest;
}

function normalizeRoute(route: string): string {
	return route.endsWith('/') ? route.slice(0, -1) : route;
}

suite('dsh 插件包结构守卫（package.json / patch / 清单 三处一致）', () => {

	test('每个插件包的 patch、入口与 files 都真实存在，且 patch 插入了自己', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const plugins = readPluginPackages(root!);
		assert.ok(plugins.length >= 2, `dsh-plugins 下应有基础插件与模块插件，实际 ${plugins.length} 个`);
		for (const plugin of plugins) {
			const name = plugin.json['name'];
			const vendored = VENDORED_THIRD_PARTY[plugin.dirName];
			if (vendored) {
				// 随包 vendored 第三方（例外 1/3）：包名与版本都**照着登记核对** —— 谁换了 vendored 的字节、
				// 却没改这份记录，就在这里红 ✓（比"无条件要求 @vssaros/*"对这类包更有信息量）。
				assert.strictEqual(name, vendored.upstream,
					`${plugin.dirName} 是 vendored 第三方包，包名必须是登记的上游名 ${vendored.upstream}`);
				assert.strictEqual(plugin.json['version'], vendored.version,
					`${plugin.dirName} 的版本与登记不一致（换了 vendored 字节就要同步改 VENDORED_THIRD_PARTY 与 VENDOR.md ✓）`);
			} else {
				assert.ok(typeof name === 'string' && name.startsWith('@vssaros/'), `${plugin.dirName} 的包名必须是 @vssaros/*`);
			}

			assert.ok(plugin.patchFiles.length > 0, `${plugin.dirName} 必须声明 dsh.bundle.patch`);
			for (const file of plugin.patchFiles) {
				assert.ok(fs.existsSync(file), `${plugin.dirName} 的 patch 文件不存在：${path.relative(plugin.dir, file)}`);
			}
			assert.ok(plugin.entryFiles.length > 0, `${plugin.dirName} 必须声明 main / exports 入口`);
			for (const file of plugin.entryFiles) {
				assert.ok(fs.existsSync(file), `${plugin.dirName} 的入口文件不存在：${path.relative(plugin.dir, file)}`);
			}

			assert.ok(plugin.filesField.length > 0, `${plugin.dirName} 必须声明 files（打包按它过滤）`);
			const reachable = collectRelativeImports(plugin.entryFiles, plugin.dir);
			for (const file of [...plugin.patchFiles, ...reachable]) {
				assert.ok(filesCovers(plugin.filesField, plugin.dir, file),
					`${plugin.dirName} 的 files 未覆盖 ${path.relative(plugin.dir, file)}——装出来会缺文件`);
			}
			assert.ok(plugin.entryFiles.every(f => reachable.includes(f)), `${plugin.dirName} 的入口未进入 import 图`);

			// 客户端半（README 4.65）：`./client` 导出与 `dsh.client` 声明必须**成对**——
			// dsh 的 web 加载器只按 `dsh.client` 去找 `./client`，缺一边就是"文件躺在包里、永远不会被加载"
			// （或者相反：声明了却没有文件）。platform 必须是 web（本仓库的客户端半都跑在 dsh 的页面里）。
			const clientExport = asRecord(plugin.json['exports'])['./client'];
			const clientBlock = asRecord(asRecord(plugin.json['dsh'])['client']);
			const hasClientBlock = Object.keys(clientBlock).length > 0;
			assert.strictEqual(typeof clientExport === 'string', hasClientBlock,
				`${plugin.dirName}: ./client 导出与 dsh.client 声明必须成对（导出=${typeof clientExport === 'string'}，声明=${hasClientBlock}）`);
			if (hasClientBlock) {
				assert.strictEqual(clientBlock['platform'], 'web', `${plugin.dirName}: dsh.client.platform 必须是 web`);
				assert.ok(Array.isArray(clientBlock['inject']), `${plugin.dirName}: dsh.client.inject 必须是前置包数组`);
			}

			assert.match(plugin.patchText, /-\s*insert:/, `${plugin.dirName} 的 patch 必须用 insert 插入行`);
			if (!vendored) {
				assert.match(plugin.patchText, new RegExp(`name:\\s*['"]${escapeRegExp(name as string)}['"]`),
					`${plugin.dirName} 的 patch 必须插入 name 等于包名的行`);
			}
			// 例外 2/3：vendored 的 patch 插的是**别人的** provider（`@deepseek-ai/dsh-skill-filesystem`，
			// 配置它去扫本包 `skills/`）⇒ 上面那条"插入自己"不适用 ✓；但"确实插了一行"仍照查（上面那行 ✓）。
		}
	});

	test('插件包不得把随 dsh 分发的包声明为依赖（只允许 peerDependencies 里的 @deepseek-ai/dsh）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		for (const plugin of readPluginPackages(root!)) {
			// 例外 3/3：vendored 第三方包不要求声明 dsh peer —— 上游没声明，我们不替它**编**一个范围
			//（编错会让 dsh 的准入检查误拒 ✓）。"不得声明 @deepseek-ai/* 为依赖"那条对**所有**包照查 ✓。
			if (!VENDORED_THIRD_PARTY[plugin.dirName]) {
				const peerRange = asRecord(plugin.json['peerDependencies'])['@deepseek-ai/dsh'];
				assert.ok(typeof peerRange === 'string' && peerRange.trim(), `${plugin.dirName} 必须声明 peerDependencies["@deepseek-ai/dsh"]`);
			}
			for (const field of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
				for (const dep of Object.keys(asRecord(plugin.json[field]))) {
					assert.ok(!dep.startsWith('@deepseek-ai/'), `${plugin.dirName} 的 ${field} 不得声明随 dsh 分发的包：${dep}`);
				}
			}
		}
	});

	test('插件清单不得再声明 chatRenderers（改用 dsh 原生的 ConversationNodeDefinition）', function () {
		// 方案那一格落地描述的原话："模块插件的聊天卡片改用 dsh 原生的会话节点注册
		// （`ConversationNodeDefinition`），**清单中移除 `chatRenderers`**"。
		// 2026-10-11 全仓核查：代码与插件清单里**已无** `chatRenderers`（只剩方案正文那句说明）⇒
		// 那半步早已完成 ✓。这条守卫把"已完成"变成"不会被悄悄改回来"——原生机制的价值是
		// **一次注册两处生效**（VsSaros 不需要额外的渲染器协议），再冒出一个自研渲染器字段就是走回头路 ✗。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		for (const plugin of readPluginPackages(root!)) {
			const manifest = asRecord(plugin.json['vssaros']);
			for (const field of ['chatRenderers', 'chat_renderers'] as const) {
				assert.ok(manifest[field] === undefined, `${plugin.dirName} 的 vssaros 清单不得再声明 ${field}`);
			}
			// 原始文本再兜一道：将来有人把它塞进别的字段/层级里，这条仍能抓到 ✓
			assert.ok(!/chatRenderers|chat_renderers/.test(JSON.stringify(plugin.json)),
				`${plugin.dirName} 的清单里不得出现 chatRenderers（改用 ConversationNodeDefinition）`);
		}
	});

	test('★ peer 范围 vs 本机运行时：插件声明的 @deepseek-ai/dsh 必须被实际装的 dsh 满足', function () {
		// 方案那格第四要求"CI 版本矩阵"里，**本地能验**的那一半就是这条 ✓：装的是哪个 dsh、插件声明支持哪些 dsh，
		// 两者必须相容。互补证据是真机探针（p3-01/… 跑真 Host）—— 范围不相容时那边会先炸 ✓。
		// 语义比较**复用已测过的** `parseSemver` / `compareSemver` ✓（不在这里另造一个 semver ✗ —— 那种"看起来对"的
		// 比较器正是守卫本身最容易出错的地方）。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const runtimeBase = path.join(root!, 'poc', 'dsh-p0', '.runtime');
		const installed = (fs.existsSync(runtimeBase) ? fs.readdirSync(runtimeBase) : [])
			.map(v => path.join(runtimeBase, v, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
			.filter(p => fs.existsSync(p))
			.map(p => String((JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: unknown }).version ?? ''))
			.filter(v => !!parseSemver(v));
		if (!installed.length) {
			this.skip(); // 没装运行时（裸 CI）⇒ 如实跳过 ✓
		}
		let checked = 0;
		for (const plugin of readPluginPackages(root!)) {
			if (VENDORED_THIRD_PARTY[plugin.dirName]) {
				// 例外 3/3（同上面那条用例）：vendored 第三方包**不声明** dsh peer ⇒ 没有范围可验，
				// 而我们不替上下游**编**一个（编错会让 dsh 的准入检查误拒 ✓）。下面 `checked > 0`
				// 那条断言保证本守卫不会因为这里的 continue 而空转 ✓。
				continue;
			}
			const range = String(asRecord(plugin.json['peerDependencies'])['@deepseek-ai/dsh'] ?? '').trim();
			assert.ok(range, `${plugin.dirName} 必须声明 peerDependencies["@deepseek-ai/dsh"]`);
			for (const version of installed) {
				for (const comparator of range.split(/\s+/)) {
					const m = /^(>=|<=|>|<)(.+)$/.exec(comparator);
					assert.ok(!!m, `${plugin.dirName} 的 peer 范围「${range}」含本守卫不认识的比较符「${comparator}」⇒ 大声失败（不猜、不放过 ✗）`);
					const [, op, target] = m!;
					const cmp = compareSemver(version, target.trim());
					const satisfied = op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : cmp < 0;
					assert.ok(satisfied, `${plugin.dirName} 声明 peer「${range}」，但本机装的是 dsh ${version}（卡在 ${op}${target}）`);
					checked++;
				}
			}
		}
		assert.ok(checked > 0, '一个插件的 peer 范围都没验到 ⇒ 守卫空转 ✗');
	});

	test('★ 覆盖层行 id 必须与插件自带 patch 的行同名（不一致会打空 ⇒ 静默降级）', function () {
		// 4.79 的教训：`--patch` 覆盖层按**行 id** 定位 ⇒ 行 id 与插件 `cordis.patch.yml` 插入的那行不一致时，
		// 补丁**打空、且不报错** ✗，静默退回"没配置"路径（看板的 `workspaceId`、代码图谱的 `workspaceRoot`
		// 都栽过这一类）。所以这里**真的去读**插件 patch ✓ —— 只比字面量等于把这条契约的一半留在纸面上 ✗。
		// 范围：打**本仓插件**行的三个覆盖层 ✓；mcp / skills 打的是**随 dsh 分发**的行（本地没有对应插件包）
		// ⇒ 无法在本条内核对，如实排除 ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const overlays: readonly [pluginDir: string, yml: string][] = [
			['vssaros-bridge', renderBridgeOverlay('\\\\.\\pipe\\probe', 'token', false)],
			['vssaros-kanban', renderKanbanOverlay('ws_probe')],
			['vssaros-codebase', renderCodebaseOverlay('/ws/probe', ['/ws/other'])],
			// agents 的 `agentsRoot`（dev 数据根 ≠ 生产数据根 ⇒ 不注入会列错目录，见 renderAgentsOverlay）
			['vssaros-agents', renderAgentsOverlay('/home/probe/.vssaros-dev/agents')],
		];
		for (const [dirName, yml] of overlays) {
			const rowId = /^- id: (\S+)\s*$/m.exec(yml)?.[1];
			assert.strictEqual(rowId, dirName, `${dirName} 的覆盖层应打在自己那一行上，实际打到：${rowId}`);
			const patchFile = path.join(root!, 'dsh-plugins', dirName, 'cordis.patch.yml');
			assert.ok(fs.existsSync(patchFile), `${dirName} 缺 cordis.patch.yml ⇒ 覆盖层无处可打 ✗`);
			const patch = fs.readFileSync(patchFile, 'utf8');
			// ⚠ 插件 patch 里的行是**缩进**在 `- insert:` 下的（`    - id: …`），覆盖层那份才是顶格 `- id: …`
			// ⇒ 这里必须允许前导空白（第一版写成顶格匹配，结果把 bridge 误报成"打空" ✗）。
			assert.ok(new RegExp(`^\\s*-\\s+id:\\s+${dirName}\\s*$`, 'm').test(patch),
				`${dirName} 的 cordis.patch.yml 里没有 \`id: ${dirName}\` 这一行 ⇒ 覆盖层会**打空并静默降级** ✗`);
		}
	});

	test('★ 数据根覆盖层：每个键落在它该在的那一行（库记录必须归 vssaros-kb）', () => {
		// 2026-10-15 真机事故：web-content-import 那一行被插在 kb 行与 `kbVaults` / `kbActiveVaultId` 之间
		// ⇒ YAML 里这两个键归属于"上面最近的 `- id:`" ⇒ 全落到了 web-content-import 名下 ✗；
		// kb 页拿不到库记录注入（提示"老 Host / 独立启动器"、已登记的自定义路径库消失、库删除分流失去依据）。
		// 上面那条只核对"行 id 真存在" ⇒ **看不出键挂错行** ✗ ⇒ 这里按行解析、逐键钉归属 ✓。
		const yml = renderDataRootOverlay('/home/probe/.vssaros-dev', '/home/probe/.vssaros-dev/mcp.json', {
			kbRoot: '/custom/kb',
			kbVaults: '[{"id":"20260101000000-aaaaaa1","name":"probe"}]',
			kbActiveVaultId: '20260101000000-aaaaaa1',
			unrealBridgeUrl: 'http://127.0.0.1:9999',
			browser: { port: 9333, launchDedicated: false, headless: true },
		});
		const keysByRow = new Map<string, string[]>();
		let current: string | undefined;
		for (const line of yml.split('\n')) {
			const row = /^- id: (\S+)\s*$/.exec(line);
			if (row) {
				current = row[1];
				assert.ok(!keysByRow.has(current), `数据根覆盖层里 \`${current}\` 出现了两次 ✗`);
				keysByRow.set(current, []);
				continue;
			}
			const key = /^ {4}(\w+):/.exec(line);
			if (key) {
				assert.ok(current, `键 ${key[1]} 出现在任何 \`- id:\` 之前 ✗`);
				keysByRow.get(current!)!.push(key[1]);
			}
		}
		const expected = new Map<string, readonly string[]>([
			['vssaros-workflow', ['dataRoot']],
			['vssaros-skills', ['dataRoot']],
			['vssaros-media', ['dataRoot']],
			['vssaros-dashboard', ['dataRoot']],
			['vssaros-kb', ['dataRoot', 'kbRoot', 'kbVaults', 'kbActiveVaultId']],
			['vssaros-web-content-import', ['dataRoot', 'kbRoot']],
			['vssaros-dsh-mcp', ['path']],
			['vssaros-unreal', ['bridgeUrl']],
			['vssaros-browser', ['port', 'launchDedicated', 'headless']],
		]);
		assert.deepStrictEqual([...keysByRow.keys()].sort(), [...expected.keys()].sort(),
			'数据根覆盖层的行集合变了 ⇒ 请同步本条的期望表（新行的每个键也要钉归属）');
		for (const [row, keys] of expected) {
			assert.deepStrictEqual(keysByRow.get(row), [...keys],
				`\`${row}\` 这一行的键不对：期望 ${keys.join(', ')}，实际 ${(keysByRow.get(row) ?? []).join(', ')} ⇒ 有键挂到了别的行上 ✗`);
		}
	});

	test('★ 数据根覆盖层：行 id 落在真插件行上，且"读数据根的模块"一个不漏', function () {
		// 2026-10-12：kb / canvas / workflow / skills 的兜底数据根都是 `~/.vssaros`，而 **dev 的数据根是
		// `~/.vssaros-dev`** ⇒ 不注入时 dev 实例读**生产**数据 ✗（资料库/画布/工作流列生产库、技能页列
		// 生产技能目录、MCP 页看生产 `mcp.json` ⇒ 于是"页面说的文件"与"真挂载用的文件"是两个）。
		// 而这些模块**此前从来没有**被注入过：探针全都自己注入数据根 ⇒ 这个缺口从没暴露（与 5.69 那条
		// fake "测的是另一个世界"同病因）。
		// 判据两条：① 覆盖层每一行都必须打到**真存在**的插件行上（拼错 = 打空 + 静默降级 ✗）；
		// ② 凡是读 `config?.dataRoot` 的插件，要么被数据根覆盖层覆盖 ✓，要么在例外表里写明理由 ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		// ⚠ 渲染时**带上全部可选的额外行**（kb / unreal / browser）—— 不带的后果是本条对那几个行 id 的
		//   "真存在"核对**空转** ✗（2026-10-14 补 browser 时发现的：`renderDataRootOverlay(...)` 缺省 extras
		//   ⇒ `vssaros-browser` 那行压根不在 yml 里，等于没被这条守卫覆盖 ✓）。
		const yml = renderDataRootOverlay('/home/probe/.vssaros-dev', '/home/probe/.vssaros-dev/mcp.json', {
			kbRoot: '/custom/kb',
			unrealBridgeUrl: 'http://127.0.0.1:9999',
			browser: { port: 9333, launchDedicated: false, headless: true },
		});
		const rowIds = [...yml.matchAll(/^- id: (\S+)/gm)].map(m => m[1]);
		const pluginsDir = path.join(root!, 'dsh-plugins');
		const dirs = fs.readdirSync(pluginsDir).filter(d => d.startsWith('vssaros-'));
		/** 插件目录 → 它自带 patch 插入的行 id。⚠ 行 id **不一定**等于目录名（canvas / mcp 多一个 `dsh-`）。 */
		const rowIdOf = new Map<string, string>();
		for (const dir of dirs) {
			const patchFile = path.join(pluginsDir, dir, 'cordis.patch.yml');
			const id = fs.existsSync(patchFile) ? /^\s*-\s+id:\s+(\S+)/m.exec(fs.readFileSync(patchFile, 'utf8'))?.[1] : undefined;
			if (id) {
				rowIdOf.set(dir, id);
			}
		}
		for (const id of rowIds) {
			assert.ok([...rowIdOf.values()].includes(id),
				`数据根覆盖层打了 \`${id}\`，但没有插件 patch 插入这一行 ⇒ 打空并静默降级 ✗`);
		}
		const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.js') ? [full] : []);
		});
		/**
		 * 不靠数据根覆盖层、但由**专属**覆盖层注入同源根的插件（写明是哪一个覆盖层 ✓）。
		 * `kanban`：看板文件在 `<数据根>/<TASKBOARD_FILE>` ⇒ 它的 `dataRoot` **必须**注入 ✓，
		 * 但只能注在**它自己那份**覆盖层里（实测：同一行被两份覆盖层打时 `config` 是**整体替换** ✗）。
		 * `agents`：`dataRoot` 只被 `agentsRootOf` 当兜底，而 `agentsRoot` 已注入 ⇒ 无需再注入 ✓。
		 */
		const coveredElsewhere = new Map<string, string>([
			['vssaros-kanban', 'renderKanbanOverlay'],
			['vssaros-agents', 'renderAgentsOverlay'],
			// `memory`（2026-10-12）：审计账本落 `<数据根>/memory-audit/` ⇒ 它的 `dataRoot`
			// **真的**注在 `renderMemoryOverlay` 里（与 gatewayUrl 同一份 `config` —— 那一行已被
			// 记忆覆盖层占用，再往 `renderDataRootOverlay` 加一条会**静默抹掉 gatewayUrl** ✗）。
			['vssaros-memory', 'renderMemoryOverlay'],
		]);
		for (const [dir, id] of rowIdOf) {
			const lib = path.join(pluginsDir, dir, 'lib');
			if (!fs.existsSync(lib)) {
				continue;
			}
			const readsRoot = walk(lib).some(f => /config\??\.dataRoot/.test(fs.readFileSync(f, 'utf8')));
			if (readsRoot && !coveredElsewhere.has(dir)) {
				assert.ok(rowIds.includes(id),
					`${dir} 读 \`config.dataRoot\` 但数据根覆盖层里没有它的行（\`${id}\`）⇒ dev 实例会读生产数据 ✗`);
			}
		}
		// 上表那几条**不许是安慰剂** ✗ —— 它们指向的覆盖层必须**真的**写出那个键，否则等于没覆盖 ✓。
		assert.ok(/^\s*dataRoot:/m.test(renderKanbanOverlay('ws_probe', '/home/probe/.vssaros-dev')),
			'看板覆盖层必须真的注入 dataRoot（看板文件在 `<数据根>/…` ⇒ 不注入会读写生产看板 ✗）');
		assert.ok(/^\s*agentsRoot:/m.test(renderAgentsOverlay('/home/probe/.vssaros-dev/agents')),
			'agents 覆盖层必须真的注入 agentsRoot（没有它 dev 会列生产 agent ✗）');
		assert.ok(/^\s*dataRoot:/m.test(renderMemoryOverlay('http://127.0.0.1:8790', '/home/probe/.vssaros-dev')),
			'记忆覆盖层必须真的注入 dataRoot（审计账本落 `<数据根>/memory-audit/` ⇒ 不注入会把账本写进**生产**数据根 ✗）');
		// ★ **一行只能有一个覆盖层**：实测同一行被两份覆盖层打时，后者把整份 `config` **替换**掉 ✗
		//   （2026-10-12 用 `--patch a.yml --patch b.yml` + `--dump-config` 验证：先写的键直接消失）。
		//   ⇒ "同一个行 id 出现在两个覆盖层里"就是**静默抹掉另一个键**的隐患 ✓。
		const idsIn = (text: string) => [...text.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map(m => m[1]);
		const dedupe = (map: Map<string, string>, id: string, owner: string, what: string) => {
			const prev = map.get(id);
			assert.strictEqual(prev, undefined, `${what}：\`${id}\` 同时被两处打（${prev} 与 ${owner}）✗`);
			map.set(id, owner);
		};
		// ① **insert** 侧：插件 patch 插入的行 id + 覆盖层插入的行 id，**全局不许重名** ✗。
		//    2026-10-12 实测到一次真事故：技能目录行曾用 `id: vssaros-skills`，与我们技能插件 patch
		//    插入的**是同一个 id** ⇒ 组合结果里出现两行同 id（一个 `@vssaros/dsh-skills`、一个
		//    `@deepseek-ai/dsh-skill-filesystem`）⇒ **后一份顶掉前一份**（技能页与 provider 可能整个
		//    消失 ✗）。探针看不见 —— 探针**不挂 IDE 那份覆盖层** ✓（同 5.84 的病因）。
		const insertOwner = new Map<string, string>();
		for (const [dir, id] of rowIdOf) {
			dedupe(insertOwner, id, `dsh-plugins/${dir}/cordis.patch.yml`, 'insert 重名');
		}
		for (const id of idsIn(renderSkillsOverlay(['/root/probe/skills']))) {
			dedupe(insertOwner, id, 'renderSkillsOverlay', 'insert 重名');
		}
		// ② **patch** 侧：按行 id 覆盖 config 的覆盖层，**不许两处打同一行** ✗（实测：后一份把整份
		//    `config` **替换**掉 ⇒ 先写的键静默消失 ✓）；且**必须打在一个真存在的行上** ✗（打空 = 静默降级）。
		const patchOwner = new Map<string, string>();
		const patchClaims: readonly [name: string, yml: string][] = [
			['renderDataRootOverlay', yml],
			['renderKanbanOverlay', renderKanbanOverlay('ws_probe', '/root/probe')],
			['renderAgentsOverlay', renderAgentsOverlay('/root/probe/agents')],
			['renderBridgeOverlay', renderBridgeOverlay('\\\\.\\pipe\\probe', 'token', false)],
			['renderCodebaseOverlay', renderCodebaseOverlay('/ws/probe', [])],
		];
		for (const [name, text] of patchClaims) {
			for (const id of idsIn(text)) {
				dedupe(patchOwner, id, name, 'patch 打到同一行');
				// 覆盖层还会按行 id 打**随 dsh 分发**的行（例如 bridge 关掉官方首启弹窗：`ui-settings-models`
				// `llm-deepseek` / `ui-settings-general`）—— 那些行不在本仓插件里，无法在本条内核对 ✓。
				// 判据因此收紧到「**我们自己的行**（`vssaros-*`）必须真存在」✓ —— "打空并静默降级"正是这里要防的 ✗。
				if (id.startsWith('vssaros-')) {
					assert.ok(insertOwner.has(id),
						`${name} 打的 \`${id}\` 没有任何插件 patch 插入 ⇒ 打空并静默退回默认口径 ✗`);
				}
			}
		}
		// 合法组合的样子（**别**把它当成重名 ✗）：插件 patch **insert** `vssaros-skills`，数据根覆盖层
		// 再 **patch** 同一行注入 `dataRoot` ✓ —— patch 已存在的行正是它该干的 ✓。
		assert.ok(insertOwner.has('vssaros-skills') && patchOwner.get('vssaros-skills') === 'renderDataRootOverlay',
			'数据根覆盖层应 patch 我们技能插件那一行（`vssaros-skills`）以注入 dataRoot ✓');
	});

	test('★ 配置错型必须在**装配期**就抛（不是用到才炸）', async function () {
		// 依据：`doc/dsh-modules-conformance.html` §5-8。本仓插件**不 import `@deepseek-ai/schemastery`** ✓
		//（见 kanban 文件头的理由：避免 profile 侧对 dsh 包的解析依赖）⇒ 用不了 dsh 的 `Config` 声明，
		// 于是这几个模块在 `apply` 的**第一行**自己校验 ✓。
		// 判据：错型的键必须**当场抛**、并且**报出键名** ✓ —— 校验发生在 ctx 被用到之前，所以传空对象就够 ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const cases: readonly [dir: string, bad: Record<string, unknown>, key: string][] = [
			['vssaros-kanban', { workspaceId: 123 }, 'workspaceId'],
			['vssaros-kanban', { lockWaitMs: 'soon' }, 'lockWaitMs'],
			['vssaros-workflow', { dataRoot: { a: 1 } }, 'dataRoot'],
			['vssaros-workflow', { lockStaleMs: 1.5 }, 'lockStaleMs'],
		];
		for (const [dir, bad, key] of cases) {
			const entry = path.join(root!, 'dsh-plugins', dir, 'lib', 'index.js');
			const mod = await import(pathToFileURL(entry).href);
			assert.throws(() => (mod as { apply: (ctx: unknown, config: unknown) => void }).apply({}, bad),
				(error: Error) => new RegExp(`config\\.${key}`).test(error.message),
				`${dir} 的 config.${key} 错型时必须在**装配期**抛错，并报出键名`);
		}
	});

	test('★ 插件不许用**同步**解压（会卡住 Host 主线程）', function () {
		// 依据：`doc/dsh-modules-conformance.html` §5-3 —— codebase 的重路径要在 Host 进程里解压 ~129MB 的图谱，
		// 用 `gunzipSync` 会让**同进程的其它请求一起停摆** ✗（页面、别的工具、反向桥都卡住）。
		// 2026-10-12 已改成 `await gunzip(…)`（libuv 线程池 ✓）；这条守卫防它被改回去 ✓。
		// ⚠ 只扫**解压**这一族（`…Sync` 版）：同步 I/O 在插件里有合法用法（启动期读小文件 ✓），不在本条管辖内 ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const pluginsDir = path.join(root!, 'dsh-plugins');
		let checked = 0;
		const bad: string[] = [];
		for (const dir of fs.readdirSync(pluginsDir)) {
			const lib = path.join(pluginsDir, dir, 'lib');
			if (!fs.existsSync(lib)) {
				continue;
			}
			const walk = (current: string): string[] => fs.readdirSync(current, { withFileTypes: true }).flatMap(entry => {
				const full = path.join(current, entry.name);
				return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.js') ? [full] : []);
			});
			for (const file of walk(lib)) {
				checked += 1;
				const text = fs.readFileSync(file, 'utf8');
				for (const match of text.matchAll(/\b(gunzip|inflate|inflateRaw|brotliDecompress|zstdDecompress)Sync\s*\(/g)) {
					bad.push(`${dir}/${path.relative(lib, file)} → ${match[1]}Sync`);
				}
			}
		}
		// 例外（**必须写明理由** ✓）：条目形如 `插件/相对文件 → 函数名`。
		const ALLOW = new Set([
			// 自证写路径的**解码助手**：它解的是自己刚产出的小图（自证夹具 ✓），不是 129MB 的真源图谱 ✓；
			// 且它是**同步 API**（探针按同一读侧口径核对时直接调用 ✓）⇒ 保持同步合理 ✓。
			// ⚠ 哪天它被用到**大图**上，这条必须删掉并把调用改成 `await` ✗。
			'vssaros-codebase/indexer.js → gunzipSync',
		]);
		const offenders = bad.filter(entry => !ALLOW.has(entry));
		assert.deepStrictEqual(offenders, [],
			`这些地方在用**同步**解压 ⇒ 大文件会把 Host 主线程卡住 ✗（改成 await promisify(gunzip)(…)）：\n  ${offenders.join('\n  ')}`);
		assert.ok(checked > 0, '一个 lib/*.js 都没扫到 ⇒ 守卫空转 ✗');
	});

	test('★ 静态 inject 不许含 webServer / connection（headless profile 会整包 pending）', function () {
		// 依据：`doc/dsh-modules-conformance.html` §5-9 + kanban 的注释先例 —— `webServer` / `connection`
		// 只在 **web 模板**里存在；写进**静态** `inject` 会让整个插件在 headless / tui profile 里
		// **永久 pending**，**连工具一起失效** ✗（2026-10-12：这一批把 dashboard / codebase / kb / mcp /
		// memory / workflow 六个模块都改成 `ctx.inject(['webServer','connection'], …)` 动态挂 ✓）。
		// 例外：`vssaros-bridge` —— 它按设计只在 web 组合里用（且静态 inject 里还有 `sessionController` 等
		// web 模板专属服务 ✓），headless 下本来就不装它 ✓。
		const WEB_ONLY_OK = new Set(['vssaros-bridge']);
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const pluginsDir = path.join(root!, 'dsh-plugins');
		let checked = 0;
		for (const dir of fs.readdirSync(pluginsDir)) {
			const entry = path.join(pluginsDir, dir, 'lib', 'index.js');
			if (!fs.existsSync(entry)) {
				continue;
			}
			const text = fs.readFileSync(entry, 'utf8');
			const list = /^export const inject = \[([^\]]*)\]/m.exec(text)?.[1];
			if (list === undefined) {
				continue; // 没有静态 inject（全走动态）也是合法的 ✓
			}
			checked += 1;
			if (WEB_ONLY_OK.has(dir)) {
				continue;
			}
			assert.ok(!/webServer|connection/.test(list),
				`${dir}/lib/index.js 的静态 inject 含 webServer/connection（${list.trim()}）⇒ 非 web 模板里整包 pending、`
				+ "工具一起失效 ✗；应改成 ctx.inject(['webServer','connection'], page => …) 动态挂 ✓");
		}
		assert.ok(checked > 0, '一个静态 inject 都没扫到 ⇒ 守卫空转 ✗');
	});

	test('★ 反向通道：未声明 `vssarosBridge` 的插件不许直接读 `ctx.vssarosBridge`（那句恒抛 ⇒ 功能假装不存在）', function () {
		// 依据（2026-10-14 真机根因，用户报"双击工作流条目没打开编辑器"）：cordis 的 context 代理对
		// **没在 `inject` 里声明的服务**一律抛 `cannot get property "x" without inject`
		// （`@deepseek-ai/cordis/src/reflect.ts` 的 handler；`ctx.provide` 只让**声明过**的 fiber 读到）。
		// ⇒ `const found = ctx.vssarosBridge` 包 try/catch 的写法**恒为 undefined**：点条目永远回
		// 503「控制桥不可用」，而桥其实是好的（真机 `/x/vssaros-bridge` 实测 `reverse=ready clients=1`）✗。
		// ⚠ workflow / kanban / codebase **三个模块抄了同一份写法** ⇒ 三条"在 IDE 打开"路径全都没通过 ✗，
		//   而各自的探针只测了**没桥**那一支（断言 503 文案）⇒ 断言的是坏行为，测不出来 ✓（本条补上）。
		// 合法读法两种：① `ctx.inject(['vssarosBridge'], scope => …)` 后在 scope 里读 ✓（三个模块现在都用它）；
		// ② 静态 `inject` 里声明它（`vssaros-ide` 的选择，代价是没装桥的组合里整包 pending）。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const pluginsDir = path.join(root!, 'dsh-plugins');
		const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
			const full = path.join(dir, entry.name);
			return entry.isDirectory() ? walk(full) : (entry.name.endsWith('.js') ? [full] : []);
		});
		let checked = 0;
		const offenders: string[] = [];
		const withoutBridge: string[] = [];
		for (const dir of fs.readdirSync(pluginsDir)) {
			const lib = path.join(pluginsDir, dir, 'lib');
			if (!fs.existsSync(lib)) {
				continue;
			}
			const files = walk(lib);
			const sources = files.map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));
			const entryText = sources.find(s => path.basename(s.file) === 'index.js')?.text ?? '';
			const declared = /^export const inject = \[([^\]]*)\]/m.exec(entryText)?.[1]?.includes('vssarosBridge') === true;
			const dynamic = sources.some(s => s.text.includes("ctx.inject(['vssarosBridge']"));
			// 正面：定义了 `bridgeOf()`（本仓反向通道的**共享助手名**，三个消费方都叫它）的插件必须有一条
			// 合法取法 ✓ —— 防"取法被删掉、功能静默消失"这种最难发现的状态（它不会让任何测试变红）。
			// ⚠ 采集面只认这一个名字 ⇒ 新写的插件若用别的助手名，**负向**那条（不许直接读）仍然管住危险写法 ✓；
			//    所以这里不追着"调用 callIDE 的所有写法"枚举（那会把**提供方** `vssaros-bridge` 自己也扫进来 ✗）。
			if (sources.some(s => /\bbridgeOf\b/.test(s.text)) && !declared && !dynamic) {
				withoutBridge.push(dir);
			}
			if (declared) {
				continue; // 静态声明过 ⇒ 直接读是合法的（vssaros-ide 就是这一支）
			}
			for (const { file, text } of sources) {
				checked += 1;
				for (const [index, line] of text.split('\n').entries()) {
					const trimmed = line.trim();
					if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
						continue; // 注释里会**写明**这个坑，别让守卫打自己 ✗
					}
					if (/\bctx\s*\.\s*vssarosBridge\b|\bctx\s*\[\s*['"]vssarosBridge['"]\s*\]/.test(line)) {
						offenders.push(`${dir}/${path.relative(lib, file).replace(/\\/g, '/')}:${index + 1}`);
					}
				}
			}
		}
		assert.deepStrictEqual(offenders, [],
			"这些地方直接读 `ctx.vssarosBridge` ⇒ **恒抛**（未在 inject 里声明）⇒ 被 catch 吞掉后功能假装不存在 ✗；"
			+ "改成 `ctx.inject(['vssarosBridge'], scope => { bridge = scope.vssarosBridge; })` 后在 scope 里读 ✓：\n  "
			+ offenders.join('\n  '));
		assert.deepStrictEqual(withoutBridge, [],
			"这些插件调用 `callIDE`（反向通道）却没有合法取法 ⇒ 反向调用永远不会发生 ✗："
			+ `${withoutBridge.join(', ')}（要么静态 inject 声明，要么 ctx.inject 动态声明 ✓）`);
		assert.ok(checked > 0, '一个 lib/*.js 都没扫到 ⇒ 守卫空转 ✗');
	});

	test('★ 客户端卡（跑在 dsh 原生界面）不许把 `--vscode-*` 当主色令牌', function () {
		// 依据：`doc/dsh-modules-conformance.html` §1-E / §4-2 —— 跑在 **dsh 原生聊天页**里的工具卡必须用
		// `--dsw-alias-*`（那界面里 `--vscode-*` **根本不存在**，只剩回退色 ✗）；而自托管 `/x/*` 页
		// （宿主是 VsSaros 的 WebContentsView）用 `--vscode-*` 是**对的**（§4-3）⇒ 本守卫只看 `lib/client*.js` ✓。
		// 判据：每一处 `--vscode-` 都必须出现在同一行 `--dsw-alias-` **之后**（即仅作回退 ✓）；注释行跳过 ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const pluginsDir = path.join(root!, 'dsh-plugins');
		let checked = 0;
		for (const dir of fs.readdirSync(pluginsDir)) {
			const lib = path.join(pluginsDir, dir, 'lib');
			if (!fs.existsSync(lib)) {
				continue;
			}
			for (const name of fs.readdirSync(lib).filter(f => /^client.*\.js$/.test(f))) {
				checked += 1;
				const lines = fs.readFileSync(path.join(lib, name), 'utf8').split('\n');
				for (const [index, line] of lines.entries()) {
					const trimmed = line.trim();
					if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
						continue;
					}
					const vscodeAt = line.indexOf('--vscode-');
					if (vscodeAt < 0) {
						continue;
					}
					const aliasAt = line.indexOf('--dsw-alias-');
					assert.ok(aliasAt >= 0 && aliasAt < vscodeAt,
						`${dir}/lib/${name}:${index + 1} 把 \`--vscode-*\` 当主色令牌 ✗ —— dsh 原生界面里没有这个变量；`
						+ '应写成 `var(--dsw-alias-…, var(--vscode-…, #回退色))`');
				}
			}
		}
		assert.ok(checked > 0, '一个客户端卡都没扫到 ⇒ 守卫空转 ✗');
	});

	test('★ 写入类工具必须挂官方审批闸（tools/pre-execute ⇒ ask）', function () {
		// 报告 §5-1 / README 5.104、5.110：写盘工具在派发前必须 `ask` ✓（官方契约：`ask` 只有审批服务返回
		// `allowed-once` 才执行 ✓、**没有审批支持的部署 degrade to deny** ⇒ fail-closed ✓）。
		// 这一条守的是**最容易"看起来修好了"的坏法** ✗：闸挂了但名单是空的 ✓、或名单里的名字早就改名
		//（⇒ 闸永远不拦 ✓）。判据因此两层：源码里真有闸 ✓ ＋ 导出的名单非空且逐个能对上注册 ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		/**
		 * ★ 「写工具 ⇒ 挂闸 or 写明理由」**台账**（README 5.110）。
		 *
		 * 为什么不是一份"挂了闸的模块名单"✗：那种名单只能证明"**这几个**挂了" ✓，证明不了
		 * "**新出现的**写工具也挂了" ✗ —— 而写工具恰恰是最不该靠自觉的东西 ✓。判据与 `dshProbeCoverage`
		 * 的 `EXCLUDED` 同形 ✓：**每个注册了工具的模块都必须出现在台账里** ✓（模块清单取自
		 * `dsh-plugins/tools-snapshot.json` —— 那份快照由 `dshToolSnapshot.test.ts` 守着不漂移 ✓），
		 * 没理由的缺席就是"忘了" ✓。
		 *
		 * 「写」的口径（写死在这里，免得各人理解不同 ✓）：工具**名**或**参数名**里出现下面这些**改状态**的
		 * 动词 ⇒ 它可能改东西 ✓ ⇒ 要么 `gate: true` ✓、要么在 `allowedWriteish` 里**逐条**写明为什么不用挂 ✓。
		 * ⚠ 这条口径是**下限**不是全集 ✗：它看不见藏在 `op` 枚举**值**里的动作（`browser` 的
		 * navigate/click/type… ✓ 就属于这类）—— 那些由 `p3-32` **行为级**钉住 ✓（本台账里 browser 标 `gate: true` ✓）。
		 */
		const WRITEISH_VERBS = ['create', 'update', 'delete', 'remove', 'write', 'set', 'add', 'apply', 'index', 'sync', 'complete', 'block', 'unblock', 'link', 'comment', 'remember', 'refresh', 'reset', 'open', 'navigate', 'click', 'type', 'press'];
		/**
		 * ⚠ 按**词元**匹配，不是按子串 ✗ —— 第一版用 `includes`，当场把只读的 `codebase_trace` 误报成写工具
		 * （README 5.110 ✓）：子串会把 `offset`、`setting`、`resetting` 之类全算进来 ✗。
		 * 词元 = 名字与参数名按非字母数字 + camelCase 切开后的小写词 ✓（`codebase_self_index` ⇒ codebase/self/index ✓，
		 * 于是仍会命中 `index` ✓ —— 那正是我们**想要**它命中的那条 ✓）。
		 */
		const tokensOf = (tool: { readonly name: string; readonly params?: readonly string[] }) =>
			`${tool.name} ${(tool.params ?? []).join(' ')}`
				.split(/[^A-Za-z0-9]+|(?=[A-Z])/)
				.map(token => token.toLowerCase())
				.filter(Boolean);
		const isWriteish = (tool: { readonly name: string; readonly params?: readonly string[] }) =>
			tokensOf(tool).some(token => WRITEISH_VERBS.includes(token));
		const LEDGER: readonly {
			readonly dir: string;
			/** `'hook'` = 挂官方 `tools/pre-execute` 钩子 ✓；`'self'` = **自己发起**确认（见 browser 那条 ✓）。 */
			readonly gate?: 'hook' | 'self';
			readonly reason?: string;
			readonly allowedWriteish?: readonly (readonly [tool: string, why: string])[];
		}[] = [
			// ── 挂了闸（两种挂法都认 ✓，但判据不同 —— 见下面分支 ✓；行为由 p3-02 / p3-26 / 各模块探针钉住 ✓）
			{ dir: 'vssaros-kanban', gate: 'hook' },     // 8 个写动词（改看板数据文件 ✓）
			{ dir: 'vssaros-workflow', gate: 'hook' },   // workflow_update（写定义文件 ✓）
			{ dir: 'vssaros-kb', gate: 'hook' },         // kb_feishu_sync（真写资料库；dry-run 不放行 ✓）
			// memory（2026-10-13 更新）：过闸的是 `WRITE_TOOLS` 里那几个**会改用户数据**的
			//（remember / forget / cascade / crystal ✓）；`memory_refresh` 与 `memory_recall` **刻意不在**
			//（前者只重取快照、后者只读 ⇒ 弹窗只会造成审批疲劳 ✗）—— 判据是"会不会改用户数据"，
			// 不是"名字像不像写" ✓。名单由源码里的 `WRITE_TOOLS` 逐名核对（见下面那段提取 ✓）。
			{ dir: 'vssaros-memory', gate: 'hook' },
			{ dir: 'vssaros-skills', gate: 'hook' },     // 技能管理（写技能目录 ✓）
			// web-content-import（2026-10-15 新增）：`content_import` 的 `mode:"write"` 把内容写进知识库
			// `库/raw/`（跨会话持久 ✓）⇒ 挂官方钩子；`read` 是纯读 ⇒ 闸里明确只拦 write（不拦只读 ✓）。
			{ dir: 'vssaros-web-content-import', gate: 'hook' },
			// agents（2026-10-13，P2 生命周期工具）：过闸的是 `agent_switch_persona`（改运行中会话的提示词）
			// 与 `agent_stop`（停别人的回合）✓；`agent_list` 只读 ✓。
			{
				dir: 'vssaros-agents', gate: 'hook', allowedWriteish: [
					['agent_open_session', '只建一条空会话（cwd+preset），不写用户数据；等于"开新聊天"，弹窗只会造成审批疲劳'],
				],
			},
		// codebase（2026-10-12，P1 影子索引）：`codebase_index` 扫整个工作区 + 把图谱**持久**落到数据目录
		// ⇒ 与 kb / kanban 的写同一档 ✓（此前本模块不挂闸，靠 `allowedWriteish` 豁免"只写可再生的自证缓存"）。
		// ⚠ 同模块的 `codebase_self_index` **刻意不在** `WRITE_TOOLS` 里（只写 mkdtemp、秒级、写完即弃 ⇒
		// 弹窗只会造成审批疲劳 ✓）—— 这条**不对称**是设计（理由写在插件源码 `WRITE_TOOLS` 上 ✓），
		// 行为由 p3-40 发真事件钉住（拦截 / 放行两侧 ✓）。
		{ dir: 'vssaros-codebase', gate: 'hook' },
			// ⚠ browser **故意不挂钩子** ✓：它是"一个工具 + `op` 参数"，而钩子拿不到审批**结果** ⇒
			//   在 `execute` 里做不了 fail-closed 兜底（钩子返回 ask、而运行时没有那条钩子时，动作会**不经询问**
			//   地执行 ✗）⇒ 它自己发起 `approval.request` 并自己判结果 ✓ ⇒ 判据必须跟着换（不能只看
			//   `kind: 'ask'` ✗，那是钩子那种挂法的形状 ✓）。动作类 op 藏在 `op` 值里 ⇒ 另由 p3-32 行为级钉住 ✓。
			{ dir: 'vssaros-browser', gate: 'self' },
			// ── 不挂闸，理由写在下面（每条都要求"可被复核" ✓，不是"就不挂" ✗）
			{
				dir: 'vssaros-ide',
				reason: '工具都是对**编辑器视图**的操作（打开文件 / 定位 / 显示 diff / 取诊断 / 取选中 / 打开工作流画布 / 在看板定位卡片），不写任何磁盘数据；且它们本就在 IDE 进程侧执行 ⇒ 闸的位置在那边，不在这里重复。',
				allowedWriteish: [
					['open_file', '在编辑器里打开文件：可撤销的视图动作，不写盘'],
					// 2026-10-13 新增：名字里带 `open`（命中写动词清单）但**只打开画布**，与 open_file 同性质 ✓
					['workflow_open', '在编辑器区打开工作流画布（展示类：不改数据、不写盘，与 open_file 同性质）'],
				],
			},
			{ dir: 'vssaros-dashboard', reason: '两个工具都是**只读**（列会话 / 读遥测快照）⇒ 没有可拦的写入。' },
			{ dir: 'vssaros-media', reason: '两个工具都是**只读**（media_list / media_stats 只跑 SELECT），而且库是以 `readOnly: true` **打开**的（`lib/store.js`）⇒ 连"忘写 WHERE 子句"都伤不到数据。要放开写能力的前置纪律写在同文件末尾（WAL 已就位 / 不建表 / 短事务 / 覆盖语义）。' },
			// ★ 2026-10-13：`vssaros-unreal` 从"只读四个（所以不挂闸）"改成**注册全部七个 ＋ 挂闸** ✓ ——
			// 执行类三个（`unreal_exec` / `unreal_wait` / `unreal_build`）能在编辑器里跑任意 Python / 触发
			// C++ 构建 ⇒ 与 kanban/kb 的写同一档 ✓。只读四个不进闸（免得每次 dump 都弹窗 ✗），由源码里的
			// `WRITE_TOOLS` 区分 ✓；行为由 `dshUnrealPlugin.test.ts` 的发真事件钉住（ask/allow 两侧 ✓）。
			{ dir: 'vssaros-unreal', gate: 'hook' },
		];

		const snapshot = JSON.parse(fs.readFileSync(path.join(root!, 'dsh-plugins', 'tools-snapshot.json'), 'utf8')) as {
			readonly plugins: Record<string, readonly { readonly name: string; readonly params?: readonly string[] }[]>;
		};
		const toolBearing = Object.keys(snapshot.plugins);
		const ledgerDirs = LEDGER.map(entry => entry.dir);
		for (const dir of toolBearing) {
			assert.ok(ledgerDirs.includes(dir),
				`\`${dir}\` 注册了工具但不在审批闸台账里 ✗ —— 要么给它挂 \`tools/pre-execute\`（gate: true），要么写明为什么不挂（reason + allowedWriteish）`);
		}
		for (const entry of LEDGER) {
			assert.ok(toolBearing.includes(entry.dir),
				`台账里的 \`${entry.dir}\` 已经不再注册任何工具 ✗ ⇒ 台账腐烂了（新工具面快照里没有它）`);
		}

		for (const entry of LEDGER) {
			// 扫整个 `lib/`（2026-10-13 修）：agents 的闸跟着工具住在 `lib/tools.js`，只读 `index.js` 会假红 ✗
			// —— 与 toolOwnership 那次同型（"守卫只认一种文件布局" ⇒ 表驱动插件整族不可见）。下游判据
			// （钩子字面量 / `kind: 'ask'` / WRITE_TOOLS 提取）都是"必须包含"，拼接只会放宽命中面，不会让存量转红 ✓。
			const libDir = path.join(root!, 'dsh-plugins', entry.dir, 'lib');
			const libWalk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
				const full = path.join(dir, e.name);
				return e.isDirectory() ? libWalk(full) : (e.name.endsWith('.js') ? [full] : []);
			});
			const src = libWalk(libDir).map(f => fs.readFileSync(f, 'utf8')).join('\n');
			const tools = snapshot.plugins[entry.dir]!;
			if (entry.gate) {
				// ⚠ 判据分两种**挂法**（第一版只认钩子 ⇒ browser 被误报 ✗，见 README 5.110）：
				if (entry.gate === 'hook') {
					// 用**带引号的字面量**判"代码里有钩子" ✓：注释里裸提 `tools/pre-execute` 不算 ✗
					//（browser 的注释正是那样提的 ✓ —— 而它走 self 那条 ✓）。
					assert.ok(/['"]tools\/pre-execute['"]/.test(src), `${entry.dir} 标了 hook ⇒ 源码里必须注册 \`tools/pre-execute\` 钩子 ✗`);
					assert.ok(/kind:\s*['"]ask['"]/.test(src), `${entry.dir} 的钩子没有返回 ask ⇒ 挂了也不拦 ✗`);
				} else {
					// 自己发起（browser ✓）：必须真走审批缝 ✓、结果不是 `allowed-once` 就**抛**（fail-closed ✓）、
					// 且必须**惰性**取服务 ✓（拿不到就拒绝，而不是假设一定存在 ✗）。
					assert.ok(/approval\.request/.test(src), `${entry.dir} 标了 self ⇒ 源码里必须自己发起 \`approval.request\` ✗`);
					assert.ok(/allowed-once/.test(src), `${entry.dir} 自己发起的确认里必须比对 \`allowed-once\` ✗`);
					assert.ok(/throw new Error/.test(src), `${entry.dir} 自己发起确认 ⇒ 结果不合时必须**抛**（fail-closed）✗`);
					assert.ok(/ctx\.get\?\.\(['"]approval['"]\)/.test(src),
						`${entry.dir} 必须**惰性**取审批服务（拿不到就拒绝），不能假设它一定存在 ✗`);
				}
				// ⚠ **提取方式必须容错**（2026-10-13 修）。这里踩过两次，第二次才看到真正的危害：
				//   ① 旧写法 `JSON.parse(declared[1].replace(/'/g, '"'))` 遇到 `//` 注释会**直接抛 SyntaxError** ✗
				//      —— 而这个仓的 `WRITE_TOOLS` **本来就该带注释**（memory 插件在那里写了"为什么
				//      `memory_forget` / `memory_cascade` / `memory_crystal` 过闸、而 `memory_recall` 不过" ✓，
				//      那正是这条纪律最需要被复核的地方 ✓）；
				//   ② ⚠⚠ 而**真正的危害**是旧写法那层 `if (declared)`：**提取不到就整段跳过** ✗✗ ——
				//      它让"名单格式变了"这件事**悄悄失去守卫**（上一次 `--common` 里那条
				//      `SyntaxError: … is not valid JSON` 其实是**好事**：它至少把失效喊出来了 ✓，
				//      而如果换成"正则也没匹配上"，守卫会**一声不响地什么都不检查** ✗✗）。
				//   ⇒ 现在两层都换掉：**括号配平**取字面量（与注释/换行无关 ✓）＋ **提取失败必须报错**（不静默 ✗）。
				//
				// ⚠ 顺序是**先剥注释、再配平**：注释里完全可能出现 `[` / `]`（比如"见 WRITE_TOOLS [sic]"⚠），
				//   先配平会被它们带偏 ✗。剥注释用**等长替换**（空格填充）⇒ 索引不变 ⇒ 配平结果仍能对回原文 ✓
				//   （若先剥注释再切片，索引会错位 ✗）。
				//   已知边界：字符串字面量里的 `//`（如 URL）也会被当注释剥掉 —— 对"工具名清单"无影响 ✓
				//   （`WRITE_TOOLS` 里只有 `memory_*` 这类名字 ✓），换别的用途要重新审视这一条 ✓。
				const blanked = src
					.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
					.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
				const start = blanked.indexOf('export const WRITE_TOOLS');
				if (start !== -1) {
					const openAt = blanked.indexOf('[', start);
					let end = -1;
					if (openAt !== -1) {
						let depth = 0;
						for (let i = openAt; i < blanked.length; i++) {
							const ch = blanked[i];
							if (ch === '\'' || ch === '"') {
								// 跳过字符串字面量（名字里不含引号，但通用一点更安全 ✓）
								const quote = ch;
								i++;
								while (i < blanked.length && blanked[i] !== quote) { i++; }
								continue;
							}
							if (ch === '[') { depth++; } else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
						}
					}
					// ⚠⚠ **提取失败必须报错**（不能 `if (declared)` 式地静默跳过 ✗✗ —— 见上面 ②）
					assert.ok(openAt !== -1 && end !== -1,
						`${entry.dir} 有 \`export const WRITE_TOOLS\`，但没解析出数组字面量 ✗ —— 守卫**不许静默跳过**：`
						+ '格式变了就把它改回能被解析的形状，或同步改这里的提取方式 ✓');
					// 名字按**出现顺序**取、去重（顺序也是参数，重复没意义 ✓）
					const names = [...new Set([...blanked.slice(openAt, end + 1).matchAll(/['"]([\w-]+)['"]/g)].map(m => m[1]!))];
					assert.ok(names.length > 0, `${entry.dir} 的 WRITE_TOOLS 是空的 ✗（空名单 = 假修好 ✗）`);
					for (const name of names) {
						assert.ok(src.includes(`name: '${name}'`), `${entry.dir} 的 WRITE_TOOLS 里有 \`${name}\`，但源码里没有注册它 ✗`);
					}
				}
				continue;
			}
			assert.ok((entry.reason ?? '').trim().length >= 30,
				`${entry.dir} 不挂闸就必须写清理由（≥30 字，能被复核）✗`);
			const excused = new Map(entry.allowedWriteish ?? []);
			for (const tool of tools) {
				if (!isWriteish(tool)) {
					continue;
				}
				const why = excused.get(tool.name);
				assert.ok(why !== undefined,
					`${entry.dir} 的工具 \`${tool.name}\` 看起来会改状态（命中写动词清单）却没挂闸、也不在 allowedWriteish 里 ✗ ⇒ 新写工具不许静默无闸`);
				assert.ok(why!.trim().length >= 15, `${entry.dir} 的 \`${tool.name}\` 的豁免理由太短（≥15 字）✗`);
			}
		}
	});

	test('★ Slot 目录比对：client.js 注入的 slot 名必须在运行时目录里（写错会静默失效）', function () {
		// 方案那一格四要求之一。为什么值得一条守卫：`ctx.slots.inject("<名字>", …)` 里名字写错**不会报错** ✗，
		// 只是那个视图永远不出现（典型静默失效）。目录的真源在 dsh 运行时里：各客户端包的
		// `<pkg>/lib/types/client/{contract/,}slots.d.ts`（声明）+ 各包 `lib/client.js` 的 inject/register 调用 ✓。
		// 扫描面是**有界**的（每包最多 3 个文件），不会去 walk 整个 node_modules ✓。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const runtimeBase = path.join(root!, 'poc', 'dsh-p0', '.runtime');
		const runtime = fs.existsSync(runtimeBase)
			? fs.readdirSync(runtimeBase).map(v => path.join(runtimeBase, v, 'node_modules', '@deepseek-ai')).find(p => fs.existsSync(p))
			: undefined;
		if (!runtime) {
			this.skip(); // 没装运行时（裸 CI）⇒ 如实跳过，不假装通过 ✗
		}
		const catalogue = new Set<string>();
		const addNames = (text: string) => {
			for (const m of text.matchAll(/slots\.(?:inject|register)\(\s*['"]([^'"]+)['"]/g)) {
				catalogue.add(m[1]);
			}
			for (const m of text.matchAll(/name:\s*['"]([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)['"]/g)) {
				catalogue.add(m[1]);
			}
			for (const m of text.matchAll(/^\s*'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)':/gm)) {
				catalogue.add(m[1]);
			}
		};
		for (const pkg of fs.readdirSync(runtime!)) {
			const base = path.join(runtime!, pkg);
			for (const rel of [path.join('lib', 'types', 'client', 'contract', 'slots.d.ts'), path.join('lib', 'types', 'client', 'slots.d.ts'), path.join('lib', 'client.js')]) {
				const file = path.join(base, rel);
				if (fs.existsSync(file)) {
					addNames(fs.readFileSync(file, 'utf8'));
				}
			}
		}
		assert.ok(catalogue.size > 5, `运行时 slot 目录没扫出来（只 ${catalogue.size} 个名字）⇒ 这条守卫会变空转 ✗`);
		let checked = 0;
		for (const plugin of readPluginPackages(root!)) {
			const libDir = path.join(root!, 'dsh-plugins', plugin.dirName, 'lib');
			const clientFile = path.join(libDir, 'client.js');
			if (!fs.existsSync(clientFile)) {
				continue;
			}
			// 标识符形式的名字可能定义在**同包别的文件**里（实测 kanban 就有这种）⇒ 查找面扩到该插件 `lib/` 下的所有 JS ✓
			// （仍然有界：一个插件就十来个文件 ✓）。真写错了照样红 ✓ —— 因为**值**不在目录里 ✓。
			const libText: string[] = [];
			const walkLib = (dir: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						walkLib(full);
					} else if (entry.name.endsWith('.js')) {
						libText.push(fs.readFileSync(full, 'utf8'));
					}
				}
			};
			walkLib(libDir);
			const packageText = libText.join('\n');
			// ⚠ 必须**先剥注释**再扫：`client.js` 的头注释里就写着用法示例
			// `slots.inject(SLOT, () => slots.register(…))` ✓ —— 注释里的 `SLOT` 只是个占位名，
			// 当真代码扫就会误判成"解析不出 slot 名" ✗（实测踩过这条）。
			const text = fs.readFileSync(clientFile, 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/^\s*\/\/.*$/gm, '');
			for (const m of text.matchAll(/slots\.inject\(\s*([^,)]+)/g)) {
				const raw = m[1].trim();
				let name = /^['"]([^'"]+)['"]$/.exec(raw)?.[1];
				if (!name && /^[A-Za-z_$][\w$]*$/.test(raw)) {
					name = new RegExp(`(?:const|let|var)\\s+${raw}\\s*=\\s*['"]([^'"]+)['"]`).exec(packageText)?.[1];
				}
				assert.ok(!!name, `${plugin.dirName} 的 client.js 里 slots.inject(${raw}) 解析不出 slot 名 ✗（守卫无法判定 ⇒ 大声失败，不静默放行）`);
				assert.ok(catalogue.has(name!), `${plugin.dirName} 的 client.js 注入的 slot「${name}」不在运行时目录里（写错不会报错、视图只是永不出现 ✗）`);
				checked++;
			}
		}
		assert.ok(checked > 0, '一个 slots.inject 都没扫到 ⇒ 守卫空转 ✗（路径或写法变了，请修守卫）');
	});

	test('容器页面表（DSH_MODULE_PAGES）与插件清单逐项一致', function () {
		// 这张表让渲染进程在不读插件清单的前提下知道"这个容器该显示哪一页"（README 4.64）。
		// 它**不是第二真源**：这里把每一项钉回各插件包的真实清单；没有插件包的模块必须是 `none`
		// （否则页面解析会指向一条不存在的路由 ⇒ 面板点开是空的）。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const byModule = new Map<string, IPluginPackage>();
		for (const plugin of readPluginPackages(root!)) {
			const module = moduleIdForPluginName(String(plugin.json['name'] ?? ''));
			if (module) {
				byModule.set(module, plugin);
			}
		}
		for (const page of DSH_MODULE_PAGES) {
			const plugin = byModule.get(page.module);
			if (!plugin) {
				assert.strictEqual(page.kind, 'none', `${page.module} 没有插件包 ⇒ DSH_MODULE_PAGES 里必须是 none`);
				continue;
			}
			const view = asRecord(asRecord(plugin.json['vssaros'])['view']);
			assert.strictEqual(page.kind, view['kind'], `${plugin.dirName} 的 view.kind 与 DSH_MODULE_PAGES 不一致`);
			if (page.kind === 'none') {
				assert.strictEqual(page.route, undefined, `${page.module} 是 none，不该记路由`);
				continue;
			}
			assert.strictEqual(normalizeRoute(String(page.route)), normalizeRoute(String(view['route'])),
				`${plugin.dirName} 的 view.route 与 DSH_MODULE_PAGES 不一致`);
			if (page.kind === 'section') {
				assert.strictEqual(page.host, view['host'], `${plugin.dirName} 的 view.host 与 DSH_MODULE_PAGES 不一致`);
			}
		}
	});

	test('模块插件的清单与 VsSaros 聚合表逐项一致（module / containerId / order / route / legacyCounterpart）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const modulePlugins = readPluginPackages(root!)
			.map(plugin => ({ plugin, manifest: manifestOf(plugin) }))
			.filter((x): x is { plugin: IPluginPackage; manifest: IVssarosPluginManifest } => !!x.manifest?.module);
		assert.ok(modulePlugins.length > 0, '至少应存在一个模块插件（P3-1 起 @vssaros/dsh-kanban）');

		for (const { plugin, manifest } of modulePlugins) {
			const packageName = String(plugin.json['name']);
			// 先对到内置模块表：拿到强类型 module id，后续容器查找才能类型安全
			const builtin = DSH_BUILTIN_MODULES.find(m => m.module === manifest.module);
			assert.ok(builtin, `${manifest.module} 必须是已知内置模块`);
			assert.strictEqual(moduleIdForPluginName(packageName), builtin!.module,
				`${plugin.dirName} 的 module=${manifest.module} 与 DSH_BUILTIN_MODULES 里 ${packageName} 的映射不一致`);

			const container = DSH_MODULE_CONTAINERS.find(c => c.modules.includes(builtin!.module));
			if (!container) {
				// **无图标模块**（`ide` / `channels`，README 4.53）：不在容器表里 ⇒ 清单必须显式
				// `view.kind=none`，且不许声明 activityBar / legacyCounterpart。容器与 none **互斥**——
				// 否则"这个模块到底有没有界面"就变成两份数据打架。
				assert.strictEqual(manifest.view.kind, 'none',
					`${plugin.dirName} 不在容器表里 ⇒ 清单必须声明 view.kind=none（当前是 ${manifest.view.kind}）`);
				assert.strictEqual(manifest.activityBar, undefined,
					`${plugin.dirName} 是无图标模块（view.kind=none），不能声明 activityBar`);
				assert.strictEqual(manifest.legacyCounterpart, undefined,
					`${plugin.dirName} 是无图标模块，没有要接管的旧容器`);
				continue;
			}
			assert.notStrictEqual(manifest.view.kind, 'none',
				`${plugin.dirName} 有容器 ${container!.containerId}，不能用 view.kind=none（容器与 none 互斥）`);

			if (manifest.activityBar) {
				// 共容器（skills/mcp、kb/memory）的可见性由聚合表算，但清单必须声明同一个容器 id 与 order
				assert.strictEqual(manifest.activityBar.containerId, container!.containerId,
					`${plugin.dirName} 的 activityBar.containerId 必须与聚合表一致（${container!.containerId}）`);
				assert.strictEqual(manifest.activityBar.order, container!.activityBar.order,
					`${plugin.dirName} 的 activityBar.order 必须与聚合表一致（${container!.activityBar.order}）`);
				assert.strictEqual(moduleContainerOf(manifest.activityBar.containerId).containerId, container!.containerId);
			}

			assert.strictEqual(manifest.legacyCounterpart, container!.containerId,
				`${plugin.dirName} 的 legacyCounterpart 必须是它接管的旧容器 id`);

			if (manifest.view.kind === 'page') {
				assert.strictEqual(normalizeRoute(manifest.view.route), normalizeRoute(defaultPageRoute(container!)),
					`${plugin.dirName} 的 view.route 与聚合表推导的默认路由不一致`);
				const source = plugin.entryFiles.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
				assert.ok(source.includes(normalizeRoute(manifest.view.route)),
					`${plugin.dirName} 的入口没有注册清单声明的路由 ${normalizeRoute(manifest.view.route)}`);
			}

			if (manifest.view.kind === 'section') {
				// 寄居区块（决议①）：宿主必须同容器、必须不是自己，且**不能占用宿主的页面路由**——
				// 两个 `/x/...` 前缀撞上就是"谁先注册谁赢"的静默故障。
				assert.ok(container!.modules.length > 1,
					`${plugin.dirName} 声明了 section 视图，但它所在的容器 ${container!.containerId} 只有自己一个模块（没有可寄居的宿主）`);
				assert.ok((container!.modules as readonly string[]).includes(manifest.view.host),
					`${plugin.dirName} 的 view.host=${manifest.view.host} 不在同一容器 ${container!.containerId} 的模块集合里`);
				assert.notStrictEqual(manifest.view.host, manifest.module,
					`${plugin.dirName} 的 view.host 不能是自己`);
				assert.notStrictEqual(normalizeRoute(manifest.view.route), normalizeRoute(defaultPageRoute(container!)),
					`${plugin.dirName} 的片段路由不能占用宿主页面路由 ${normalizeRoute(defaultPageRoute(container!))}`);
				const source = plugin.entryFiles.filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
				assert.ok(source.includes(normalizeRoute(manifest.view.route)),
					`${plugin.dirName} 的入口没有注册清单声明的片段路由 ${normalizeRoute(manifest.view.route)}`);
			}
		}
	});

	test('Host 入口必须能被加载（语法正确 + 零外部依赖）', async function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		for (const plugin of readPluginPackages(root!)) {
			// **只查 Host 侧入口**：客户端条目（`exports["./client"]`，`dsh.client.platform === "web"`）跑在浏览器里，
			// 顶层就是 `window`/`document`，在 Node 里 import 必然失败——那不是缺陷。
			const clientExports = asRecord(plugin.json['exports'])['./client'];
			const clientEntries = (typeof clientExports === 'string' ? [clientExports] : [])
				.map(p => path.resolve(plugin.dir, p));
			for (const entry of plugin.entryFiles) {
				if (!fs.existsSync(entry) || clientEntries.includes(entry)) {
					continue; // 入口存在性由前面的用例负责
				}
				try {
					// 动态 import 同时覆盖两件事：① 语法错误（一个未闭合的模板字符串就够毁掉整个插件，
					// 而且只在真机 Host 日志里看得见——本文件作者被这条咬过一次）；② 插件不该依赖任何外部包，
					// 能 import 成功就说明它只用了 Node 内建能力与自己的相对路径（方案 6.1：模块插件不 import dsh 包）。
					await import(`${pathToFileURL(entry).href}?guard=${Date.now()}`);
				} catch (e) {
					assert.fail(`${plugin.dirName} 的入口 ${path.basename(entry)} 加载失败：${String((e as Error)?.message ?? e)}`);
				}
			}
		}
	});

	test('★ 随包脚本与真源字节一致，且被 files 覆盖（否则装出来的包里没有它）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		// 真源是 `resources/.agents/kb/feishu-sync.mjs`（IDE 侧与 dsh 侧共用同一份同步逻辑）。
		// 为什么要副本：dsh 插件要能**独立安装**（profile 里只有它时也得能同步），不能依赖宿主 app 的资源目录。
		// 为什么要守卫：两份副本**没有任何编译期关系**——改了真源忘了副本，表现是"IDE 里同步正常、dsh 里行为不同"，
		// 而脚本 1400+ 行，diff 起来没人会看。宁可这里红一次，把重新拷贝这件事变成机械动作。
		const source = path.join(root, 'resources', '.agents', 'kb', 'feishu-sync.mjs');
		const copy = path.join(root, PLUGINS_REL, 'vssaros-kb', 'scripts', 'feishu-sync.mjs');
		const pkg = readPluginPackages(root).find(p => p.dirName === 'vssaros-kb');
		assert.ok(pkg, '找不到 vssaros-kb 包');
		assert.ok(fs.existsSync(source) && fs.existsSync(copy), `真源或副本不存在：${source} / ${copy}`);
		assert.ok(
			filesCovers(pkg!.filesField, pkg!.dir, copy),
			'scripts/feishu-sync.mjs 没被 files 覆盖 ⇒ 装出来的包里没有它（"能装不能跑"）',
		);
		assert.strictEqual(
			fs.readFileSync(copy, 'utf8'),
			fs.readFileSync(source, 'utf8'),
			'副本与真源不一致：把 resources/.agents/kb/feishu-sync.mjs 重新拷到 dsh-plugins/vssaros-kb/scripts/',
		);
	});

	test('★ PDF 提取脚本（python）与真源内嵌模板串字节一致，且被 files 覆盖（2026-10-14，P2 §16.12）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		// 真源把脚本**内嵌**在 kbDocConvertChannel.ts 的 EXTRACT_SCRIPT 模板串里（主进程每次写临时文件再跑 ✓）；
		// dsh 侧是**文件**（插件要独立安装 ✓）⇒ 副本与"模板串的运行时内容"必须逐字节一致，
		// 否则两边提取口径会悄悄分叉（脚本里有 NFKC 归一化 / U+FFFD 清理 / 图片改名这些**语义级**细节 ✗）。
		const tsPath = path.join(root, 'src/vs/sessions/contrib/agentStudio/electron-main/kbDocConvertChannel.ts');
		const copy = path.join(root, PLUGINS_REL, 'vssaros-kb', 'scripts', 'saros-kb-extract-doc.py');
		const pkg = readPluginPackages(root).find(p => p.dirName === 'vssaros-kb');
		assert.ok(pkg, '找不到 vssaros-kb 包');
		assert.ok(fs.existsSync(tsPath) && fs.existsSync(copy), `真源或副本不存在：${tsPath} / ${copy}`);
		assert.ok(
			filesCovers(pkg!.filesField, pkg!.dir, copy),
			'scripts/saros-kb-extract-doc.py 没被 files 覆盖 ⇒ 装出来的包里没有它（"能装不能跑"）',
		);
		const ts = fs.readFileSync(tsPath, 'utf8');
		const startMark = 'const EXTRACT_SCRIPT = `';
		const start = ts.indexOf(startMark);
		assert.ok(start >= 0, '真源里找不到 EXTRACT_SCRIPT（改名了就要同步这里的取法）');
		const bodyStart = start + startMark.length;
		let end = -1;
		for (let i = bodyStart; i < ts.length; i++) {
			if (ts[i] === '`' && ts[i - 1] !== '\\') { end = i; break; }
		}
		assert.ok(end > 0, '真源里找不到 EXTRACT_SCRIPT 模板串的终点');
		// 模板串反转义（TS 语义 ✓）：\\ → \ 、 \` → ` 、 \$ → $ —— 与提取脚本（Temp/kb-extract-script.mjs）同一口径 ✓
		const sourceScript = ts.slice(bodyStart, end).replace(/\\([\\`$])/g, (_m, ch) => ch as string);
		assert.strictEqual(
			fs.readFileSync(copy, 'utf8'),
			sourceScript,
			'副本与真源 EXTRACT_SCRIPT 不一致：从 kbDocConvertChannel.ts 重新提取到 dsh-plugins/vssaros-kb/scripts/saros-kb-extract-doc.py',
		);
	});

	test('没有幽灵模块：dsh-plugins 里声明的模块都在内置模块表内', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const known = new Set<string>(DSH_BUILTIN_MODULES.map(m => m.module));
		for (const plugin of readPluginPackages(root!)) {
			const manifest = manifestOf(plugin);
			if (manifest?.module) {
				assert.ok(known.has(manifest.module), `${plugin.dirName} 声明了未登记的内置模块：${manifest.module}`);
			}
		}
	});

	test('★ planned 双向钉住：登记为 planned 的模块不许有插件目录，非 planned 的必须有', function () {
		// 为什么需要（2026-10-16）：channels 曾登记在 DSH_BUILTIN_MODULES 里但 `dsh-plugins/` 下根本没有
		// 对应目录 ⇒ 没人发现"这个模块永远不会激活"；反向更危险：写了插件却忘了登记 ⇒ 装了不出图标。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const dirs = new Set(readPluginPackages(root!).map(p => p.dirName));
		for (const m of DSH_BUILTIN_MODULES) {
			const dirName = m.pluginName.replace(/^@vssaros\/dsh-/, 'vssaros-');
			const exists = dirs.has(dirName);
			if (m.planned) {
				assert.ok(!exists, `${m.module} 标记为 planned 但插件目录 ${dirName} 已存在 ⇒ 去掉 planned 标记`);
			} else {
				assert.ok(exists, `${m.module}（${m.pluginName}）没有对应插件目录 ${dirName} ⇒ 要么补插件，要么标 planned: true`);
			}
		}
	});

	test('★ 所有模块插件随包自动安装（自发现，不是硬编码清单）', function () {
		// 2026-10-11 用户要求"`@vssaros/*` 的插件都一起自动安装"。
		// 判据只有一份：插件自己的 `vssaros.module`（`listBundledPlugins`）—— 宿主安装清单、插件中心
		// 「随包」段、profile seed 三处都必须**走这条自发现**；任何一处改成硬编码清单，都会在将来新增模块时
		// 静默漏装（不报错 ✗，用户只会发现"少了一块能力"）。构建脚本不能 import TS ⇒ 判据就地重写了一份，
		// 这条同时把两侧口径钉在一起。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}

		// ① 真发现（拿真实随包目录跑）：随包目录里的模块插件必须**全部**被列出来
		const found = listBundledPlugins(path.join(root, 'dsh-plugins'));
		const modules = found.packages.map(p => p.module).sort();
		// 随包目录里**必须**被扫出来的模块插件（新加模块时把它加进来 ✓ —— 否则"随包扫描漏了一个模块"
		// 这件事没人验 ✗，而它正是 supervisor 自动安装的输入 ✓）。
		for (const expected of ['agents', 'skills', 'mcp', 'kb', 'memory', 'codebase', 'kanban', 'workflow', 'dashboard', 'ide']) {
			assert.ok(modules.includes(expected),
				`随包目录里的 ${expected} 模块没被发现（实际发现：${modules.join(', ') || '（空）'}）`);
		}
		assert.ok(!found.packages.some(p => p.name === '@vssaros/dsh-bridge' || p.name === '@vssaros/dsh-chat-surface'),
			'伴生插件（bridge / chat-surface）不算模块插件（它们由启动路径单独维护）');
		assert.ok(found.packages.every(p => fs.existsSync(path.join(p.dir, 'package.json'))),
			'每条发现结果都要指向一个真实目录（自发现错了会装到不存在的路径）');

		const read = (rel: string) => fs.readFileSync(path.join(root!, rel), 'utf8');
		const harnessDir = path.join('src', 'vs', 'sessions', 'contrib', 'dshHarness');

		// ② 宿主：channel 自发现 → supervisor 展开进安装清单
		const channel = read(path.join(harnessDir, 'electron-main', 'dshHarnessChannel.ts'));
		assert.ok(/listBundledPlugins\(this\._bundledPluginsRoot\)/.test(channel),
			'channel 必须用 listBundledPlugins 自发现模块插件（硬编码清单会漏掉新模块）');
		assert.ok(/^\t{3}modulePluginDirs,$/m.test(channel), 'channel 必须把发现的清单交给 supervisor');
		const supervisor = read(path.join(harnessDir, 'electron-main', 'dshHostSupervisor.ts'));
		assert.ok(/\.\.\.this\._opts\.modulePluginDirs\.map/.test(supervisor),
			'supervisor 的伴生插件清单必须展开 modulePluginDirs');
		// ★ 2026-10-12 口径更新：覆盖层的"渲染"已收敛到**单一真源** `common/dshHostConfig.ts` 的
		//   `renderHostOverlays(config)`（README 4.64：独立启动器要的是**同一组**覆盖层，两份平行实现
		//   一漂移就是静默错配）⇒ supervisor 不再自己 `renderXxxOverlay(...)`，而是"凑配置 → 交给它"。
		//   断言因此分两层：**宿主真的调了那个真源** ✓ ＋ **真源里真的调了各渲染器**（下面那三条）✓。
		assert.ok(/renderHostOverlays\(hostConfig\)/.test(supervisor),
			'supervisor 必须把 hostConfig 交给 renderHostOverlays（自己再手写一遍覆盖层 = 又开一份平行实现 ✗）');
		// 同一条理由，但对象是**读 `<数据根>` 的那几个模块**（kb / canvas / workflow / skills + mcp 的 path）：
		// 构建器写对了不等于**真的有人调它** ✗ —— 2026-10-12 之前这几个模块的注入**从来不存在**，
		// 而"构建器在哪、谁调用它"这件事只有这条断言看得见 ✓。
		const hostConfigMod = read(path.join(harnessDir, 'common', 'dshHostConfig.ts'));
		assert.ok(/renderAgentsOverlay\(agentsRoot\)/.test(hostConfigMod),
			'渲染真源仍必须写 agents 覆盖层（这一步与"装上模块"是两件事：dev 数据根 ≠ 生产数据根）');
		// ⚠ 只钉"**第一个参数是 `dataRoot`**"这一点 ✓，不钉整行逐字 —— 2026-10-12 加了第 3 个参数
		//（`{ kbRoot, unrealBridgeUrl }` ✓）时，按旧形态逐字匹配的这条立刻红了 ✓，而它本意只是"别漏了这次调用" ✓。
		assert.ok(/renderDataRootOverlay\(\s*dataRoot/.test(hostConfigMod),
			'渲染真源仍必须写数据根覆盖层（kb/canvas/workflow/skills 都读它，漏了 ⇒ dev 实例读生产数据）');
		// ★ A 组缺口（2026-10-12 评估）：kb 的存储根与 unreal 的 bridge 地址**过去没有任何等价配置键** ✗
		// ⇒ 用户在 IDE 里改过这两项时，dsh 侧照旧读默认（kb 表现为"资料库/画布空着但不报错" ✗）。
		// 这条钉"渲染真源仍把它们传下去" ✓；**效果**（真机上改了设置 dsh 跟着改）由真机探针负责 ✓（尚未补 ✗）。
		assert.ok(/kbRoot:\s*trimmed\(config\.kbRoot\)/.test(hostConfigMod)
			&& /unrealBridgeUrl:\s*trimmed\(config\.unrealBridgeUrl\)/.test(hostConfigMod),
			'渲染真源必须把 kbRoot / unrealBridgeUrl 传给 renderDataRootOverlay（A 组缺口：IDE 改过这两项时 dsh 要跟着改）');
		assert.ok(/renderKanbanOverlay\(workspaceId, dataRoot\)/.test(hostConfigMod),
			'看板覆盖层必须**带上** dataRoot（看板文件在 `<数据根>/…` ⇒ 漏掉参数会静默退回 `~/.vssaros`、读写生产看板 ✗）');

		// ③ seed：构建脚本按同一判据自发现（口径漂移 ⇒ 首启 profile 与 build 出来的组合不一致）
		const prepack = read(path.join('build', 'prepack-dsh-runtime.mjs'));
		assert.ok(/discoverModulePluginDirs\(join\(root, 'dsh-plugins'\)\)/.test(prepack),
			'profile seed 必须自发现模块插件（不能只有桥/聊天框/agents 三个）');
		assert.ok(/pkg\?\.vssaros\?\.module/.test(prepack),
			'seed 的判据必须与宿主侧同源（`vssaros.module`）');
	});

	test('★ 页面插件的 client chunk 必须语法可解析（它们是被当字符串 eval 的）', function () {
		// Why: dsh 的 client chunk 在页面里以 `window.__ModuleLoader__.load({...})` 形式被**当字符串求值**，
		// 一个语法错（哪怕只是某行注释的 `// ` 被吃掉）就会让**整块皮肤静默消失** —— 页面不报错、
		// Host 不报错，我们这边只剩"某个功能没了"的现象（2026-10-12 实测：`client.js` 有一行注释丢了
		// 标记 ⇒ 直到单测恰好加载到那个 chunk 才炸出 SyntaxError ✗，此前无任何信号）。
		// 这条把"语法可解析 + 清单里的文件都在"钉住：改完客户端 JS 立刻红，不必等某个用例恰好加载它。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		// ★ 2026-10-14 **扩采集面**：原来只扫 `vssaros-chat-surface`（路径硬编码 ✗）⇒ 新加的客户端插件
		//   （如 `vssaros-kb-refs`）**默认不受保护**（"写完就以为有守卫"）。改成按**注册形态**枚举：
		//   凡是 `package.json` 里声明了 `dsh.client` 的包，它的每个 `lib/client*.js` 都要过这一关 ✓
		//   （口径与"静态扫描守卫的采集面要按注册形态枚举"一致 ✓；ESM 形态的 chunk 仍跳过 ✓）。
		const pluginsRoot = path.join(root, 'dsh-plugins');
		const checked: string[] = [];
		for (const pkgDir of fs.readdirSync(pluginsRoot)) {
			const pkgPath = path.join(pluginsRoot, pkgDir, 'package.json');
			if (!fs.existsSync(pkgPath)) {
				continue;
			}
			let manifest: { dsh?: { client?: unknown } };
			try {
				manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
			} catch {
				continue;   // 坏清单由另一条用例负责报，这里不抢它的活
			}
			if (!manifest.dsh?.client) {
				continue;   // 没有客户端半的包不适用本用例
			}
			const libDir = path.join(pluginsRoot, pkgDir, 'lib');
			if (!fs.existsSync(libDir)) {
				continue;
			}
			for (const name of fs.readdirSync(libDir).filter(n => /^client.*\.js$/.test(n))) {
				const src = fs.readFileSync(path.join(libDir, name), 'utf8');
				checked.push(`${pkgDir}/${name}`);
				if (/^\s*(export|import)\s/m.test(src)) {
					continue;   // ESM 形态不适用 `new Function`（本仓的 chunk 都是 `window.__ModuleLoader__.load` 形态）
				}
				assert.doesNotThrow(() => { new Function(src); }, `${pkgDir}/${name} 语法不可解析（页面里会整块静默消失）`);
			}
		}
		// 枚举面自证：数量塌了说明枚举路径/基准变了（那时"零报错"是假的 ✓）
		assert.ok(checked.length >= 12, `客户端 chunk 总数异常（枚举基准变了？）：${checked.length} —— ${checked.slice(0, 4).join(', ')}`);
		// chat-surface 的 PART_CHUNKS 清单必须与磁盘一致（删了文件忘改清单 ⇒ 那个部件静默没了）
		const chatSurfaceLib = path.join(pluginsRoot, 'vssaros-chat-surface', 'lib');
		if (fs.existsSync(chatSurfaceLib)) {
			const entry = fs.readFileSync(path.join(chatSurfaceLib, 'client.js'), 'utf8');
			const list = /const PART_CHUNKS = \[([\s\S]*?)\];/.exec(entry);
			assert.ok(list, 'client.js 里找不到 PART_CHUNKS（清单形态变了？）');
			for (const rel of (list[1].match(/"[^"]+"/g) ?? []).map(s => s.slice(1, -1))) {
				assert.ok(fs.existsSync(path.join(chatSurfaceLib, rel)), `PART_CHUNKS 里的 ${rel} 不存在（该部件会静默缺失）`);
			}
		}
	});

	test('★ kb-refs 的 `@知识库` 源：种类编码 / 剪贴板投影 / 提交期取正文（**真跑一遍**，不只解析）', async function () {
		// Why: 这整个插件是**纯客户端**的 —— 页面不崩、Host 不报 ⇒ "写错了"与"没写"的现象**一模一样** ✗；
		// 而运行时探针（p3-82）**只在有 composer 时才驱动得到它**（裸 Host 没配模型 ⇒ 连会话都起不来 ✓）。
		// ⇒ 这里用最便宜的方式把它**真跑起来**：假 `window.__ModuleLoader__` 收下工厂 → 装进假 ctx →
		// 像 pipeline 那样调 `onPick` / `codec.clipboardText` / `codec.serialize`（配桩 `fetch`）✓。
		// 钉的是**语义**：种类怎么编码、剪贴板里出现什么、读不到正文时是**阻断**还是**静默降级**。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const src = fs.readFileSync(path.join(root, 'dsh-plugins', 'vssaros-kb-refs', 'lib', 'client.js'), 'utf8');
		// ⚠ 用 **holder 对象**而不是 `let factory` ：`let x = undefined` 后在闭包里赋值，TS 的流分析
		// **只看得见 `undefined` 这一次赋值** ⇒ `assert.ok(x)` 会把它narrow 成 `never`，`x!()` 报 TS2349 ✗
		// （tsgo 当场抓到 ✓）。`const factory = holder.factory` 的**声明类型**是联合 ⇒ `asserts` 好用 ✓。
		const holder: { factory?: (require: (id: string) => unknown) => any } = {};
		const fakeWindow: any = { __ModuleLoader__: { load: (spec: any) => { holder.factory = spec.factory; } } };
		const fakeDocument: any = { documentElement: { dataset: {} as Record<string, string> } };
		new Function('window', 'document', src)(fakeWindow, fakeDocument);
		const factory = holder.factory;
		assert.ok(factory, 'chunk 必须以 `window.__ModuleLoader__.load({factory})` 形态导出工厂');
		// 本包**不该 require 任何模块**（只用页面上的 fetch 与内置对象 ✓）—— 真 require 了就让它当场炸 ✓
		const mod = factory(() => { throw new Error('kb-refs 的客户端半边不该 require 任何模块'); });
		let source: any;
		mod.apply({
			get: (id: string) => (id === 'inputTriggers' ? { registerSource: (s: any) => { source = s; return () => { }; } } : undefined),
			effect: (fn: () => () => void) => fn(),
		});
		assert.equal(fakeDocument.documentElement.dataset.vssarosKbRefs, '1',
			'注册成功必须留下自证标记（探针 p3-82 靠它判"注册这一跳真跑了" ✓）');
		assert.ok(source && source.trigger === '@' && source.name === '知识库', '必须注册一个 `@` 源、组名 `知识库`');

		const sig = new AbortController().signal;
		const req = (query: string) => ({ query, quoted: false, position: 'inline' as const, drilled: false, signal: sig });
		const sess = { sessionId: 's' };
		const realFetch = (globalThis as any).fetch;
		try {
			// ① 候选：指针档 vs 附正文档（`@+关键词`）—— 种类必须编进 `value`（`onPick` 拿不到 query ✓）
			(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true, items: [{ uri: 'file:///kb/笔记/a.md', title: 'A', snippet: 'snip' }] }) });
			const ptr = await source.candidates(sess, req('A'));
			assert.equal(ptr.length, 1);
			assert.equal(ptr[0].value, 'file:///kb/笔记/a.md', '指针档：value 就是服务端 uri **原样**（零改写 ✓）');
			const attach = await source.candidates(sess, req('+A'));
			assert.equal(attach[0].value, 'body:file:///kb/笔记/a.md', '附正文档：value 带**可逆**前缀 `body:`');
			assert.ok(/附正文/.test(attach[0].label), 'chip 上只有 label 看得见 ⇒ 种类必须写进 label（`appearance` 只有 session|file|folder ✗）');
			// 空查询 ⇒ 空候选（那条路由对空 query 会 400 ⇒ 不许把 400 当成"没有结果"刷出来 ✓）
			assert.deepEqual(await source.candidates(sess, req('')), []);
			assert.deepEqual(await source.candidates(sess, req('+')), []);

			// ② onPick：行本体 = 引用；drill（面包屑 / Tab）= **换档**（新查询文本 + 菜单保持开着 ✓）
			const pickOf = (candidate: any, action: 'pick' | 'drill') => ({ candidate, session: sess, position: 'inline' as const, via: 'menu' as const, action, span: { start: 0, end: 1, draftRev: 0 } });
			const p1 = source.onPick(pickOf(ptr[0], 'pick'));
			assert.equal(p1.insert.source, '知识库');
			assert.equal(p1.insert.ref, 'file:///kb/笔记/a.md');
			assert.equal(p1.insert.clipboardText, 'file:///kb/笔记/a.md', '指针档剪贴板就是 uri 原样 ✓');
			const p2 = source.onPick(pickOf(attach[0], 'pick'));
			assert.equal(p2.insert.ref, 'body:file:///kb/笔记/a.md', 'ref 里带种类 ⇒ 到**提交期**才知道要取正文 ✓');
			assert.equal(p2.insert.clipboardText, 'file:///kb/笔记/a.md（附正文）',
				'**剪贴板里不许出现 `body:` 这种内部前缀**（粘出来像乱码 ✗），但种类要留着（否则读者不知道当初要带正文 ✓）');
			assert.deepEqual(source.onPick(pickOf({ name: 'x', value: '' }, 'drill')), { text: '', continue: true }, '面包屑回退 = 换查询文本，菜单保持开着');
			assert.deepEqual(source.onPick(pickOf({ name: 'x', value: '+' }, 'drill')), { text: '+', continue: true }, '点「+ 附正文」= 切到附正文档');
			// 面包屑两档都要在：附正文这个档**没有别的入口**（行本体不能既是引用又是开关 ✗）⇒ 必须摆出来 ✓
			assert.ok(source.header(sess, { query: 'A', drilled: false }).some((c: any) => c.value === '+'),
				'指针档也要给出"切到附正文"的**可点**面包屑（否则是个没人找得到的功能 ✗）');
			assert.ok(source.header(sess, { query: '+A', drilled: true }).some((c: any) => c.current === true),
				'附正文档要显示当前档（`current` 那一项不可点 ✓）');

			// ③ 失败策略**分档**：指针档**永不 reject**（kb 挂了也不该阻断这次发送 ✓）；
			//    附正文档**读不到就 reject**（正文是这次引用唯一的意义 ⇒ 不许静默降级成指针 ✓）
			(globalThis as any).fetch = async () => { throw new Error('net down'); };
			assert.match(await source.codec.serialize('file:///kb/笔记/a.md', sig), /指针引用/, '指针档失败也要给出模型可见文本');
			await assert.rejects(() => source.codec.serialize('body:file:///kb/笔记/a.md', sig),
				(e: Error) => /拿不到正文/.test(e.message), '附正文档读不到正文必须**阻断**（契约：never a silent downgrade）');

			// ④ 附正文成功路径：必须走 kb 的**只读取正文**路由（与 `kb_read` 同一条围栏 ✓）；超长**带标记**截断
			let seenUrl = '';
			(globalThis as any).fetch = async (url: string) => {
				seenUrl = String(url);
				return { ok: true, json: async () => ({ ok: true, path: 'p', bytes: 5, truncated: false, content: 'HELLO' }) };
			};
			const text = await source.codec.serialize('body:file:///kb/笔记/a.md', sig);
			assert.ok(seenUrl.includes('/x/kb/api/doc?uri=') && seenUrl.includes(encodeURIComponent('file:///kb/笔记/a.md')),
				`附正文必须走 doc 路由且 uri 传的是**原样**：（实测 ${seenUrl}）`);
			assert.ok(text.includes('HELLO') && text.includes('附正文'), '模型要能看到正文本身（否则"附正文"是空承诺 ✗）');
			(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true, content: 'x'.repeat(64 * 1024), truncated: false }) });
			const long = await source.codec.serialize('body:file:///kb/笔记/a.md', sig);
			assert.ok(long.length < 64 * 1024 && /已截断/.test(long), '超长必须**截断并写明**（静默截断 ✗）');
			(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: '拒绝读取库外文件' }) });
			await assert.rejects(() => source.codec.serialize('body:file:///kb/之外.md', sig), /拒绝读取库外文件/,
				'围栏拒绝要**如实带出来**（吞成空正文 = 把越权失败当成功 ✗）');
		} finally {
			(globalThis as any).fetch = realFetch;
		}
	});

	test('★ 插件换版本后必须换进程（不许静默复用/接管旧 Host）', function () {
		// 现场一（2026-10-11，排查一整晚）：profile 依赖已指向 `@vssaros/dsh-agents@0.1.7`，
		// 而**常驻 Host 内存里还是 0.1.5**（只认 `personaId`）⇒ 人格切换恒回
		// `HTTP 400：需要 sessionId 与 personaId`。
		// 现场二（2026-10-12）：IDE 启动时磁盘上换了 6 个插件，而 `host.json` 里那个 **18:15 的老 Host 被接管**；
		// 它内存里缺新版插件 ⇒ 聊天页白屏（`bodyText:""`、`surface.opened:false`、
		// `error: cannot get required service "uiWorkspace" in inactive context`），
		// **自动重载页面两次也救不回来**（源头在 Host 内存里，不在页面）✗✗。
		// 两次同因：dsh 的 web server 把插件**前端** chunk 从磁盘现读，而模块半边是启动时 require 的
		// ⇒ "前端新、后端旧"这种最误导的组合。这条钉住五处接线，缺任何一处都会退回"静默跑旧代码"：
		//   ① 安装发现版本真变了就置标记（**不能只看 `state === 'running'`**：IDE 刚启动时装插件，
		//      状态还是 idle，正是现场二漏掉的那个口子）；
		//   ② `start()` 的"原样复用"早退必须让开（`!this._pluginsStale`）；
		//   ③ 让开之后要真的停掉旧进程再起新的；
		//   ④ `$DSH_HOME/host.json` 的**接管**路径也必须让开（现场二就是走了这条路）；
		//   ⑤ 起新 Host 前清掉标记（不清 ⇒ 之后每次 `start()` 都可能多重启一次）。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const supervisor = fs.readFileSync(
			path.join(root, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-main', 'dshHostSupervisor.ts'), 'utf8');

		assert.ok(/private _pluginsStale = false;/.test(supervisor), '① 要有 `_pluginsStale` 标记');
		assert.ok(/if \(changed\) \{\s*\n\s*this\._pluginsStale = true;/.test(supervisor),
			'① *只要*版本真变了就置标记（`changed` 是现成的判据；加上 `state === running` 会漏掉 IDE 启动时的接管路径）');
		assert.ok(/if \(this\._status\.state === 'running' && !this\._pluginsStale\)/.test(supervisor),
			'② `start()` 的复用早退必须让开（否则标记形同虚设）');
		assert.ok(/await this\.stop\(\);\s*\n\s*\}\s*\n\s*return this\._doStart\(options\);/.test(supervisor),
			'③ 让开之后必须真的停掉旧进程再起新的（否则会起出第二个 Host）');
		assert.ok(/if \(existing && this\._pluginsStale\) \{/.test(supervisor),
			'④ `host.json` 的既有 Host 在插件换版后**不许接管**（2026-10-12 白屏就是接管了老进程）');
		assert.ok(/const pluginsWereStale = this\._pluginsStale;/.test(supervisor)
			&& /this\._pluginsStale = false;/.test(supervisor)
			&& /if \(leaseFromLock && !pluginsWereStale &&/.test(supervisor),
			'⑤ 锁竞争里那个 Host 也不接管');
		// ⑥ 清标记的位置**必须在真正 spawn 成功之后**：2026-10-12 实测把它清在"进 lock 之前"，
		//    并发的第二次 start 把标记读成 false ⇒ 又接管了坏 Host（日志 `reusing the Host started by pid 80344`）✗。
		assert.ok(!/const pluginsWereStale = this\._pluginsStale;\s*\n\s*this\._pluginsStale = false;/.test(supervisor),
			'⑥ 不许在进 lock 之前就清标记（并发 start 会因此接管旧 Host）');
		assert.ok(/ready in \$\{Date\.now\(\) - t0\} ms[\s\S]{0,600}?this\._pluginsStale = false;/.test(supervisor),
			'⑥ spawn 成功（打出 ready in …）之后才清标记');
		// ⑦ 插件图自检：**接管**与**新起**两条路都要体检（白屏根因就是接管了一个"插件 import 失败"的进程），
		//    不通过时换进程重载（只自动一次）。
		// ⑧ ★ 标记必须挂在**真正执行安装的那一行**上（2026-10-13 实测）：`_installFromDir` 是另一条路
		//    （日志 `${label} install: …`），而启动时的伴生插件安装走 `_ensurePlugin`（日志 `installing … (was …)`）
		//    ⇒ 只在 `_installFromDir` 置标记 = **标记从没设上**，防接管形同虚设 ✗✗。
		assert.ok(/installing \$\{name\}@\$\{bundled\} \(was \$\{installed \?\? 'absent'\}\)`\);\s*\n[\s\S]{0,900}?this\._pluginsStale = true;/.test(supervisor),
			'⑧ 真正的安装 choke point（`installing … (was …)` 那一行之后）必须置标记');
		assert.ok(/private async _auditPluginGraph\(why: string\): Promise<void>/.test(supervisor)
			&& /void this\._auditPluginGraph\('接管既有 Host'\)/.test(supervisor)
			&& /void this\._auditPluginGraph\('新起 Host'\)/.test(supervisor),
			'⑦ 两条路都要做插件图自检（接管那条正是 2026-10-12 白屏的入口）');
		assert.ok(/r\.phase === 'failed'/.test(supervisor) && /_pluginAuditRestarted/.test(supervisor)
			&& /setTimeout\(\(\) => \{ void this\._restartAfterPluginAudit\(\); \}, 0\)/.test(supervisor),
			'⑦ 自检要认 phase==="failed" 并（延后、且只一次地）自动换进程');
	});
});

/**
 * ★ 打包链守卫：**内置 dsh 运行时必须进包**（2026-10-16 用户报「打包出的 vssaros.exe 无法找到 dsh」，
 * 首启弹「需要准备 DeepSeek Harness 运行环境」⇒ 要求用户自己 npm 装运行时）。
 *
 * 现场与根因（两条各自都合理的设计叠起来 = 静默坏包 ✗✗）：
 *   · `/dsh-runtime/` 在 `.gitignore` 里（由 `build/prepack-dsh-runtime.mjs` **现生成**）⇒ CI / 干净检出
 *     里根本没有这个目录；
 *   · `gulpfile.vscode.ts` 的 `dshRuntime` 流是 `allowEmpty: true`（有意：本地 dev 打包可以不带运行时，
 *     退回"运行期 npm 安装引导"）；
 *   ⇒ 谁也没红：`code.iss` 的 `[Files] Source: "*"` 照搬暂存目录 ⇒ 暂存没有 = 装出来没有。
 *
 * 不变量（这些都是"只要被删掉就会再次静默出坏包"的线，改动前先读 `strip-before-pack.mjs` 的 2.5d）：
 *   ① 两个打包入口各自**在 gulp 之前**跑 prepack（幂等：已有同版 bin.js 时跳过安装）；
 *   ② `strip-before-pack.mjs` 把内置运行时当**关键构件**（缺失且无法自愈 ⇒ criticalMissing ⇒ 禁止出包），
 *      版本取 `dsh-plugins/dsh-compat.json` 的 `bundled`（不写死，防漂移）；
 *   ③ `verify-staging.ps1` 对它是**硬性**（不再"仓库侧没有就只 WARN 放行"）；
 *   ④ gulp 的资源流仍然列着 `dsh-runtime/*\/node_modules/**`（路径与宿主 `join(app.getAppPath(),'dsh-runtime')` 同源）。
 *      （写成 `*\/` 是为了不让这个 glob 里的斜杠把本注释提前闭合 ✗——注释里出现 `*` 紧跟 `/` 就是这个下场。）
 */
suite('dshHarness / 打包链：内置 dsh 运行时（缺它 = 首启要用户自己装 dsh）', () => {
	const root = repoRoot();
	const read = (rel: string): string | undefined => {
		if (!root) { return undefined; }
		const abs = path.join(root, rel);
		return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
	};

	const REL_INSTALLER = 'deploy-package/scripts/build-installer.ps1';
	const REL_CI_PACKAGE = '.ci/scripts/package-vscode.ps1';
	const REL_STRIP = 'build/saros/strip-before-pack.mjs';
	const REL_VERIFY = '.ci/scripts/verify-staging.ps1';
	const REL_GULP = 'build/gulpfile.vscode.ts';
	const REL_GENERATE_EXE = '.ci/scripts/generate-exe.ps1';
	const REL_PREPACK = 'build/prepack-dsh-runtime.mjs';
	const REL_INSTALL_DEPS = '.ci/scripts/install-deps.ps1';

	test('守卫前置：七个打包链文件都能读到（读不到就显式跳过，不许静默通过）', function () {
		if (!root) { this.skip(); }
		for (const rel of [REL_INSTALLER, REL_CI_PACKAGE, REL_STRIP, REL_VERIFY, REL_GULP, REL_GENERATE_EXE, REL_PREPACK, REL_INSTALL_DEPS]) {
			assert.ok(read(rel), `读不到 ${rel}（守卫会变成空跑）`);
		}
	});

	test('★ 两个打包入口都在 gulp 之前跑 prepack（否则 CI/干净检出必出坏包）', () => {
		const installer = read(REL_INSTALLER)!;
		const ci = read(REL_CI_PACKAGE)!;
		for (const [name, src] of [['build-installer.ps1', installer], ['.ci package-vscode.ps1', ci]] as const) {
			const prepackAt = src.indexOf('prepack-dsh-runtime.mjs');
			assert.ok(prepackAt > 0, `${name} 必须跑 \`node build/prepack-dsh-runtime.mjs\`（dsh-runtime 被 gitignore ⇒ 干净检出里没有它）`);
			const gulpAt = src.search(/gulp vscode-win32-x64/);
			assert.ok(gulpAt > 0, `${name} 找不到 gulp 步骤（守卫不能空跑）`);
			assert.ok(prepackAt < gulpAt, `${name} 里 prepack 必须在 gulp **之前**（gulp 的资源流是按目录现拷的）`);
			assert.match(src.slice(prepackAt), /\$LASTEXITCODE -ne 0[\s\S]{0,200}?exit 1/, `${name}：prepack 失败必须中止构建（不许带病出包）`);
		}
	});

	test('★ build-installer 装完还要**当场验**运行时在产物里（这条流程不跑 strip-before-pack）', () => {
		const installer = read(REL_INSTALLER)!;
		assert.match(installer, /resources\\app\\dsh-runtime\\\$bundledVersion\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js/,
			'必须按 <appPath>/dsh-runtime/<bundled>/node_modules/@deepseek-ai/dsh/lib/bin.js 校验（与宿主解析同源）');
		assert.match(installer, /ConvertFrom-Json\)\.bundled/, '版本取 dsh-plugins/dsh-compat.json 的 bundled（不许写死）');
		assert.match(installer, /if \(-not \(Test-Path \$runtimeBin\)\)[\s\S]{0,400}?exit 1/, '缺运行时必须 exit 1（否则用户首启撞"准备环境"）');
	});

	test('★ strip-before-pack：内置运行时是关键构件（缺失 ⇒ criticalMissing ⇒ 禁止出包）+ 可执行提示', () => {
		const strip = read(REL_STRIP)!;
		assert.match(strip, /dsh-runtime\/\$\{bundledVersion\}/, '自愈/校验的路径要带 manifest 的 bundled 版本');
		assert.match(strip, /'node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js'/, 'sentinel 用运行时真入口（同时证明版本对、目录不空壳）');
		assert.match(strip, /dsh-plugins\/dsh-compat\.json[\s\S]{0,200}?bundled/, '版本从 dsh-compat.json 读（与 supervisor / 运行时解析同源）');
		assert.match(strip, /node build\/prepack-dsh-runtime\.mjs/, '缺失时要给出可执行的补救（跑 prepack）—— 否则现场只知道"缺"');
		assert.match(strip, /if \(criticalMissing > 0\)[\s\S]{0,300}?process\.exit\(1\)/, '关键构件缺失必须让脚本 exit 1');
	});

	test('★ verify-staging：内置运行时是硬性（不再"仓库侧没有就只 WARN 放行"）', () => {
		const verify = read(REL_VERIFY)!;
		const rel = verify.slice(verify.indexOf('dsh 运行时'));
		assert.ok(rel.length > 0, '找不到 dsh 运行时段（守卫不能空跑）');
		assert.ok(!/\[WARN\][^\n]*dsh-runtime/.test(rel),
			'不许再有"仓库侧没有 dsh-runtime ⇒ 只 WARN"这条路（2026-10-16 之前它放过了坏包 ✗）');
		// ★ 条件 + 动作一起钉：只查"有没有 Write-Error 这句话"会漏掉"条件被改成永假"这种退化
		//   （2026-10-16 突变验证实测：只把 `if (-not (Test-Path …))` 换成 `if ($false)`，弱版本守卫照样绿 ✗）。
		assert.match(rel,
			/if \(-not \(Test-Path \(Join-Path \$repoRoot "dsh-runtime\\\$bundledVer"\)\)\) \{\s*Write-Error[\s\S]{0,300}?exit 1/,
			'缺 dsh-runtime\\<bundled> 必须当场 Write-Error + exit 1（要连着条件一起，防空壳断言 ✗）');
		assert.match(rel, /prepack-dsh-runtime\.mjs/, '错误文案要给出可执行补救（跑 prepack）');
		assert.match(rel, /dsh-runtime\\\$bundledVer\\node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js/, '仍要把运行时入口列为必需项');
	});

	test('★ gulp 资源流仍在拷 dsh-runtime（路径与宿主 appPath 同源）', () => {
		const gulp = read(REL_GULP)!;
		assert.match(gulp, /dsh-runtime\/\*\/node_modules\/\*\*/, '资源流必须仍在拷 dsh-runtime 的 node_modules（否则上面两道门都会红）');
		const channel = read('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts')!;
		assert.match(channel, /join\(app\.getAppPath\(\), 'dsh-runtime'\)/, '宿主读的就是 <appPath>/dsh-runtime（两处必须同源）');
	});

	test('★★ generate-exe 必须在调 Inno **之前**硬拦缺运行时（流水线"失败也继续" ⇒ 只有这里拦得住）', () => {
		const gen = read(REL_GENERATE_EXE)!;
		const checkAt = gen.indexOf('dsh-runtime\\$bundledDsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js');
		assert.ok(checkAt > 0, '必须按与宿主同源的路径判它进没进包');
		const innoAt = gen.indexOf("Invoke-InnoTask 'vscode-win32-x64-inno-updater'");
		assert.ok(innoAt > 0, '找不到 Inno 任务（守卫不能空跑）');
		assert.ok(checkAt < innoAt, '检查必须在**调用 Inno 之前**——跑完 Inno 就已经有 exe 可上传了 ✗✗');
		// ★ 条件与动作一起钉（2026-10-16 突变验证实测：只钉文案时，把条件改成 `Test-Path "C:\never"`
		//   这种永假仍然绿 ✗ —— 门就形同虚设了）
		assert.match(gen, /if \(-not \(Test-Path \$dshRuntimeBin\)\) \{\s*Write-Error[\s\S]{0,600}?exit 1/,
			'必须真的判 $dshRuntimeBin 在不在（条件被改成永假 = 这道门白设 ✗）');
		assert.match(gen, /ConvertFrom-Json\)\.bundled/, '版本要取自 dsh-plugins/dsh-compat.json（不许写死）');
	});

	test('★★ prepack 的删除必须健壮且裁剪失败**不许**拖垮构建（2026-10-16 CI 崩溃现场）', () => {
		const prepack = read(REL_PREPACK)!;
		// ① prune 里不许有裸 rmSync（那次 ENOTEMPTY 就是它抛出来的：CI 上 soffice.cfg 那层超 MAX_PATH）
		//    ⚠ 只取**函数体**：prune 与 removeTree 之间的注释里会提到 rmSync（解释为什么不能用它）✗
		const pruneAt = prepack.indexOf('function prune(');
		assert.ok(pruneAt > 0, '找不到 prune（守卫不能空跑）');
		const pruneEnd = prepack.indexOf('\n}', pruneAt);
		assert.ok(pruneEnd > pruneAt, '找不到 prune 的结尾（守卫不能空跑）');
		const pruneBody = prepack.slice(pruneAt, pruneEnd);
		assert.ok(!/rmSync\(/.test(pruneBody),
			'prune 里不许直接 rmSync —— 未捕获的 ENOTEMPTY 会让整个 prepack 崩（裁剪是可选优化，绝不能拦出包 ✗✗）');
		assert.match(pruneBody, /removeTree\(/, 'prune 必须用不抛的 removeTree');
		assert.match(pruneBody, /⚠ 裁剪失败/, '删不掉要**大声**说明（并说明包会变大），不许静默');
		// ② removeTree 必须有长路径兜底（扩展长度前缀 `\\?\`）与挪开兜底
		assert.match(prepack, /function removeTree\(/, '要有不抛的 removeTree');
		assert.match(prepack, /toExtendedLengthPath\(/, '要用扩展长度前缀兜底（CI 未开 LongPathsEnabled ⇒ 深层路径 rmdir 必 ENOTEMPTY）');
		assert.match(prepack, /'\\\\\\\\\?\\\\'/, '前缀本身要是 `\\\\?\\`（Windows 扩展长度路径）');
		assert.match(prepack, /renameSync\(abs, aside\)/, '删不掉就挪开（对调用方而言"目标不存在"就够了）');
		assert.match(prepack, /function removeTreeOrThrow\(/, '需要"必须删干净"的场景要有单独入口');
	});

	test('★★ profile 种子是加速项：建不出来**不许**拦出包，且要自己解决 pnpm（2026-10-16 第二次现场）', () => {
		const prepack = read(REL_PREPACK)!;
		// ① 主流程与"已安装跳过"那条都必须走 safeBuildProfileSeed（裸 await buildProfileSeed 会把
		//    `'pnpm' is not recognized` 变成"打包失败"——2026-10-16 第二次现场正是它 ✗）
		const calls = prepack.match(/await buildProfileSeed\(/g) ?? [];
		assert.strictEqual(calls.length, 1, `裸 buildProfileSeed 只应出现在 safeBuildProfileSeed 内部（实际 ${calls.length} 处）`);
		const safeCalls = prepack.match(/await safeBuildProfileSeed\(/g) ?? [];
		assert.ok(safeCalls.length >= 2, '两条路径（跳过安装 / 刚装完）都要走 safeBuildProfileSeed');
		// ② pnpm 三级兜底：PATH → corepack → npm -g（dsh plugin add 直接 spawn pnpm，运行时不带它）
		assert.match(prepack, /function ensurePnpm\(/, '要有 ensurePnpm');
		assert.match(prepack, /'corepack', \['enable', 'pnpm'\]/, 'corepack 是第二级兜底（Node ≥16 自带）');
		assert.match(prepack, /\['install', '-g', 'pnpm'/, 'npm -g 是第三级兜底（CI 的 npm 已指内网镜像）');
		// ③ 失败要清掉半成品种子：宿主判"种子可用"只看 profiles/<p>/package.json 在不在
		//    （`_profileSeedDir`）⇒ 半成品会被当好的整目录拷进 DSH_HOME ✗✗
		assert.match(prepack, /removeTree\(join\(runtimeDir, 'profile-seed'\)\)/, '失败必须清掉半成品种子');
		assert.match(prepack, /宁可没有，也不给一个装不起来的 profile/, '清理要留一行可读的说明');
	});

	test('★★ verify-staging：种子只告警、运行时本体才硬性（加速项不许拦出包）', () => {
		const verify = read(REL_VERIFY)!;
		const seedDeclAt = verify.indexOf('$seedWarn = @(');
		assert.ok(seedDeclAt > 0, '种子要单独列成 $seedWarn（守卫不能空跑）');
		const seedBlock = verify.slice(seedDeclAt, verify.indexOf(')', seedDeclAt));
		assert.match(seedBlock, /profile-seed/, '$seedWarn 里放种子项');
		// $required 段里不许再出现 profile-seed（放回去 = 没有 pnpm 的构建机又不许出包 ✗）
		const requiredAt = verify.indexOf('$required += "dsh-runtime');
		const requiredBlock = verify.slice(requiredAt, seedDeclAt);
		assert.ok(!requiredBlock.includes('profile-seed'), 'profile-seed 不许留在 $required 里（那是硬拦）');
		assert.match(requiredBlock, /node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js/, '运行时本体仍必须是硬性');
		assert.match(verify, /\[WARN\][^\n]*profile seed missing/, '缺种子要在日志里可见（否则"首启慢"会被当偶发）');
	});

	test('★ CI 依赖步骤要备好 pnpm（否则种子在 CI 上永远建不出来）', () => {
		const deps = read(REL_INSTALL_DEPS)!;
		assert.match(deps, /pnpm --version/, '要探测 pnpm 是否可用');
		assert.match(deps, /npm install -g pnpm/, '缺了就装一个（显式带内网镜像更稳）');
		assert.match(deps, /\[WARN\] pnpm 不可用/, '装不上要告警（不拦出包，但必须可见）');
	});
});
