/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
	DSH_HOST_CONFIG_FILENAME, DSH_HOST_OVERLAY_PREFIX, DshHostOverlayKind, IDshHostConfig,
	hostIdleTtlText, hostOverlayFileName, parseDshHostConfig, renderHostOverlays, serializeDshHostConfig,
} from '../../common/dshHostConfig.js';
import {
	renderAgentsOverlay, renderBridgeOverlay, renderCodebaseOverlay, renderDataRootOverlay,
	renderKanbanOverlay, renderMemoryOverlay, renderSandboxOverlay,
} from '../../common/dshCli.js';
import { renderMcpOverlay } from '../../common/dshMcpConfig.js';
import { renderSkillsOverlay } from '../../common/dshSkillDirs.js';

/**
 * **中立配置源**（`common/dshHostConfig.ts`）：配置 → 覆盖层必须是**纯函数且只有一处真源**。
 *
 * 这里要钉住的是两类东西：
 * 1. **不走样**：聚合器给出的每条覆盖层，必须与对应渲染器**直接调用**逐字相同（否则两个入口会渲染出
 *    不同内容，且症状是"配置像没生效"这种沉默故障）；顺序与条件也要与主进程一致。
 * 2. **不漂移**：主进程（`dshHostSupervisor`）用到的那批渲染器与文件名前缀，和中立配置用的是**同一批**
 *    —— 主进程将来新增一条覆盖层而中立配置没跟上，就在这条测试上红，而不是在 standalone 入口里少注入。
 */

const readIfExists = (relative: string): string | undefined => {
	const file = path.join(process.cwd(), relative);
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
};

/** 跳过时的统一说明（把"为什么什么都没查"写进输出，避免把跳过误读成通过）。 */
const SKIP = '（跳过：仓库内找不到该源码——测试进程的 cwd 不是仓库根）';

const HOST_CONFIG = 'src/vs/sessions/contrib/dshHarness/common/dshHostConfig.ts';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const MCP_CONFIG = 'src/vs/sessions/contrib/dshHarness/common/dshMcpConfig.ts';

/** 覆盖层的**固定顺序**（前者先落地；后者覆盖前者，故顺序即语义）。 */
const ORDER: readonly DshHostOverlayKind[] = ['bridge', 'kanban', 'codebase', 'mcp', 'skills', 'agents', 'dataRoot', 'memory', 'sandbox'];

/** 一份"全字段"配置（各字段都非空，用来断言 9 条齐出）。 */
const fullConfig: IDshHostConfig = {
	bridge: { pipe: '\\\\.\\pipe\\vssaros-1', token: 'tok-1', hideOfficialDeepseek: true, welcomeNoticeVersion: '1.2.3' },
	dataRoot: 'C:/Users/x/.vssaros-dev',
	workspaceId: 'ws-1',
	workspaceRoot: 'C:/work/repo',
	relatedRoots: ['C:/work/other'],
	agentsRoot: 'C:/Users/x/.vssaros-dev/agents',
	// 内置**不在** `skillDirs` 里（2026-10-13 P2：它走 `bundledSkillDir` ⇒ rank 600 ✓）
	skillDirs: ['C:/Users/x/.vssaros-dev/skills'],
	bundledSkillDir: 'C:/builtin/skills',
	mcpServers: [{ serverName: 'kb', transport: 'stdio', command: 'node', args: ['kb.js'] }],
	mcpConfigPath: 'C:/Users/x/.vssaros-dev/mcp.json',
	gatewayUrl: 'http://127.0.0.1:8790',
	// 沙箱降级（2026-10-13）：探针探不通时才有值 ⇒ 这里给上，断言它排在**最后**一条 ✓
	sandboxMode: 'danger-full-access',
};

suite('dshHostConfig（中立配置源：配置 → 覆盖层）', () => {

	test('文件名常量：与主进程 `bridge-<id>.yml` / `roots-<id>.yml` 等逐字同形', () => {
		assert.strictEqual(hostOverlayFileName('bridge', 'abc123'), 'bridge-abc123.yml');
		assert.strictEqual(hostOverlayFileName('dataRoot', 'abc123'), 'roots-abc123.yml', '数据根那条的文件名是 `roots-`（历史命名）');
		assert.deepStrictEqual(Object.keys(DSH_HOST_OVERLAY_PREFIX).sort(), [...ORDER].sort(), '前缀表必须覆盖且仅覆盖这 8 类');
		assert.strictEqual(DSH_HOST_CONFIG_FILENAME, 'vssaros.config.json');
	});

	test('★ 单一真源：每条覆盖层与对应渲染器**直接调用**逐字相等（否则两个入口渲染出不同内容）', () => {
		const overlays = renderHostOverlays(fullConfig);
		assert.deepStrictEqual(overlays.map(o => o.kind), ORDER, '顺序必须固定（覆盖层是后者覆盖前者）');
		const byKind = new Map(overlays.map(o => [o.kind, o.text]));
		// ⚠ 实参要与 `renderHostOverlays` 里的调用**逐字同形**（这条测试的整个意义就是"两个入口渲染出同一份"）：
		//   2026-10-15 那支给 `renderBridgeOverlay` 加了 `idleTtlMs`（Host 驻留更久）与 `workspaceRoot`
		//   （personaSuffix 里烘焙 `{{cwd}}`，否则子代理作用域解析不了它、每轮必炸）⇒ 这里必须跟上，
		//   否则红的是"测试过期"，而不是"两个入口真的不一样"（两者症状一样、含义完全不同 ✗）。
		assert.strictEqual(byKind.get('bridge'), renderBridgeOverlay(
			fullConfig.bridge!.pipe, fullConfig.bridge!.token, true, '1.2.3',
			fullConfig.bridge!.idleTtlMs, fullConfig.workspaceRoot),
			'bridge 覆盖层要带上 idleTtlMs 与 workspaceRoot（后者进 personaSuffix）');
		assert.strictEqual(byKind.get('kanban'), renderKanbanOverlay('ws-1', 'C:/Users/x/.vssaros-dev'), '看板那份必须把**数据根**一起写进去（同一条目的 config 是整体替换）');
		assert.strictEqual(byKind.get('codebase'), renderCodebaseOverlay('C:/work/repo', ['C:/work/other']));
		assert.strictEqual(byKind.get('mcp'), renderMcpOverlay(fullConfig.mcpServers!));
		assert.strictEqual(byKind.get('skills'), renderSkillsOverlay(fullConfig.skillDirs!, fullConfig.bundledSkillDir),
			'内置也要原样转发（漏传 ⇒ 覆盖层里没有 bundled 那条 ⇒ 内置掉回 300 ✗）');
		assert.strictEqual(byKind.get('agents'), renderAgentsOverlay('C:/Users/x/.vssaros-dev/agents'));
		assert.strictEqual(byKind.get('dataRoot'), renderDataRootOverlay('C:/Users/x/.vssaros-dev', 'C:/Users/x/.vssaros-dev/mcp.json'));
		assert.strictEqual(byKind.get('sandbox'), renderSandboxOverlay('danger-full-access', 'C:/work/repo'),
			'沙箱降级那条打的是 base 的 `sandbox-policy` 行（探针探不通才会出现）');
		assert.strictEqual(byKind.get('memory'), renderMemoryOverlay('http://127.0.0.1:8790', 'C:/Users/x/.vssaros-dev', 'ws-1'),
			'记忆那份必须把**数据根**与**工作区 id** 一起写进去（同一条目的 config 是整体替换；dataRoot 供审计账本、workspaceId 供按工作区隔离分区）');
	});

	test('★ 条件渲染与主进程同口径：字段缺失/全空白 ⇒ **不产生**那一条（不是渲染空覆盖层）', () => {
		// ★ A 组缺口（2026-10-12，同一条测试内联）：kbRoot / unrealBridgeUrl 真的进了覆盖层吗？
		// 报告现场：用户在 IDE 里改了「知识库存储根」或「unreal bridge 地址」时，dsh 侧**过去没有任何
		// 等价配置键** ✗ ⇒ 前者表现为"资料库/画布空着但不报错"、后者表现为"设置改了仍连 8765" ✓。
		// 这一段钉**渲染**（纯函数 ✓ 秒级 ✓）；**真机效果**（改了设置 ⇒ Host 真跟着改）由探针负责 ✓（尚未补 ✗）。
		const dataRootOnly = renderHostOverlays({ dataRoot: '/d' }).find(o => o.kind === 'dataRoot')!.text;
		assert.ok(/- id: vssaros-kb[\s\S]*?dataRoot: '\/d'/.test(dataRootOnly), 'kb 行缺 dataRoot');
		assert.ok(!dataRootOnly.includes('kbRoot'),
			'用户**没改**知识库存储根时不该给 kbRoot（与插件默认同值；注入了只是多一个改错的机会 ✗）');
		assert.ok(!dataRootOnly.includes('vssaros-unreal'),
			'unreal 设置为空时不该渲染它的行（插件自带默认与 IDE 默认同值 ✓）');

		const both = renderHostOverlays({ dataRoot: '/d', kbRoot: '/custom/kb', unrealBridgeUrl: 'http://127.0.0.1:9999' })
			.find(o => o.kind === 'dataRoot')!.text;
		assert.ok(/kbRoot: '\/custom\/kb'/.test(both), 'kb 行必须带上用户的存储根');
		// （2026-10-15：canvas 模块已移除 ⇒ 不再有 canvasRoot 行 ✓。）
		assert.ok(/- id: vssaros-unreal[\s\S]*?bridgeUrl: 'http:\/\/127\.0\.0\.1:9999'/.test(both),
			'unreal 行必须带上用户改过的 bridge 地址');

		// ★ browser（2026-10-14，同一条缺口）：IDE 的 `browserCdp.{port,launchDedicated,headless}` 过去
		//   **到不了 Host**（插件只读自己的 config / `VSSAROS_BROWSER_*`）⇒ 关掉「自动拉起调试实例」
		//   不生效，抓已登录站点时被静默导向**空 profile** 的专属实例（现场＝先撞登录墙）。
		assert.ok(!dataRootOnly.includes('vssaros-browser'),
			'用户没改过 browser 三项时不该渲染它的行（插件自带默认与 IDE 默认同值 ✓）');
		const browserOff = renderHostOverlays({ dataRoot: '/d', browser: { launchDedicated: false } })
			.find(o => o.kind === 'dataRoot')!.text;
		// ⚠ 这条是本项存在的**唯一理由**：`false` 必须真的写出来 —— 用 `trimmed()` 那套 falsy 判断会把它
		//   当"没给" ⇒ 用户明明关了、Host 侧照旧拉起专属实例（正是要被修掉的那个现场 ✗）。
		assert.ok(/- id: vssaros-browser\s*\n\s*config:\s*\n\s*launchDedicated: false/.test(browserOff),
			'`launchDedicated: false` 必须真的进覆盖层（false 不能像空串那样被当成"没给" ✗）');
		const browserAll = renderHostOverlays({ dataRoot: '/d', browser: { port: 9333, launchDedicated: false, headless: true } })
			.find(o => o.kind === 'dataRoot')!.text;
		assert.ok(/- id: vssaros-browser[\s\S]*?port: 9333[\s\S]*?launchDedicated: false[\s\S]*?headless: true/.test(browserAll),
			'browser 行必须逐键带上用户改过的值');

		// JSON 往返：新字段必须参与 ✓ —— 否则**独立启动器**（没有 VsSaros 的入口）读同名配置时会把它们
		// 静默丢掉 ✗（`parseDshHostConfig` 只认它列出的字段 ✓）。
		const roundTrip = parseDshHostConfig(serializeDshHostConfig({ dataRoot: '/d', kbRoot: '/custom/kb', unrealBridgeUrl: 'http://x' }));
		assert.deepStrictEqual(roundTrip, { dataRoot: '/d', kbRoot: '/custom/kb', unrealBridgeUrl: 'http://x' },
			'新字段必须能无损往返（否则独立启动器丢字段，且丢得没声音 ✗）');
		// browser 单独一条（它含布尔 false ⇒ 走的是另一套解析，见 `parseDshHostConfig` 里那段注释 ✓）
		const browserRoundTrip = parseDshHostConfig(serializeDshHostConfig({
			dataRoot: '/d', browser: { port: 9333, launchDedicated: false, headless: false },
		}));
		assert.deepStrictEqual(browserRoundTrip?.browser, { port: 9333, launchDedicated: false, headless: false },
			'browser 三键必须无损往返（尤其两个 `false`：丢掉任何一个都等于把用户的"关掉"变成"默认" ✗）');

		assert.deepStrictEqual(renderHostOverlays({}), [], '空配置 ⇒ 一条都不渲染');
		// 空白串与空数组一律当"没给"（主进程到处是 `.trim() || undefined` 与 `filter(...existsSync)`）
		assert.deepStrictEqual(renderHostOverlays({
			dataRoot: '   ', workspaceId: '', workspaceRoot: '\t', agentsRoot: ' ',
			skillDirs: ['', '  '], relatedRoots: [], mcpServers: [], mcpConfigPath: ' ', gatewayUrl: '',
		}), []);
		assert.deepStrictEqual(renderHostOverlays({ bridge: { pipe: 'p', token: '   ', hideOfficialDeepseek: false } }).map(o => o.kind), [],
			'token 为空 ⇒ 不注入 bridge 覆盖层（否则伴生插件会拿空 token 起来）');
		// 只给 workspaceId ⇒ 只出看板那条（数据根缺省时不给 `dataRoot` 参数）
		const kanbanOnly = renderHostOverlays({ workspaceId: 'ws-2' });
		assert.deepStrictEqual(kanbanOnly.map(o => o.kind), ['kanban']);
		assert.strictEqual(kanbanOnly[0].text, renderKanbanOverlay('ws-2', undefined));
	});

	test('★ JSON 往返逐字相等（配置能落盘、能被另一个入口读回）', () => {
		const text = serializeDshHostConfig(fullConfig);
		assert.ok(text.endsWith('}\n'), '末尾换行（与仓库其它 serialize* 同形）');
		assert.ok(text.includes('\n  "dataRoot":'), text.slice(0, 120));
		assert.deepStrictEqual(parseDshHostConfig(text), fullConfig);
		// 只给部分字段时也不该冒出空字段（否则往返后多出 `relatedRoots: []` 这类噪声）
		const partial: IDshHostConfig = { bridge: { pipe: 'p', token: 't', hideOfficialDeepseek: false }, gatewayUrl: 'http://127.0.0.1:1' };
		assert.deepStrictEqual(parseDshHostConfig(serializeDshHostConfig(partial)), partial);
	});

	test('解析要**容错**：坏输入返回 undefined、坏字段被丢掉，但绝不抛（standalone 入口不该因一个手改的配置崩）', () => {
		assert.strictEqual(parseDshHostConfig('not json'), undefined);
		assert.strictEqual(parseDshHostConfig('   '), undefined);
		assert.strictEqual(parseDshHostConfig(null), undefined);
		assert.strictEqual(parseDshHostConfig([1, 2]), undefined);
		assert.strictEqual(parseDshHostConfig('[]'), undefined);
		// 未知键丢掉；坏 mcpServers 只丢那一条；bridge 不完整只丢 bridge
		const parsed = parseDshHostConfig(JSON.stringify({
			unknownKey: 1,
			dataRoot: '  C:/x  ',
			workspaceId: 42,
			mcpServers: [{ serverName: 'ok', transport: 'stdio' }, { serverName: '', transport: 'stdio' }, { serverName: 'x', transport: 'nope' }, 'junk'],
			bridge: { pipe: 'p' },
		}));
		assert.deepStrictEqual(parsed, {
			dataRoot: 'C:/x',   // 空白被去掉
			mcpServers: [{ serverName: 'ok', transport: 'stdio' }],
		});
	});

	test('★ 与主进程**不漂移**：主进程必须**委托**聚合器、且不再自己渲染（单一真源）', () => {
		const supervisor = readIfExists(SUPERVISOR);
		const neutral = readIfExists(HOST_CONFIG);
		const mcp = readIfExists(MCP_CONFIG);
		if (!supervisor || !neutral) { assert.ok(true, SKIP); return; }
		// ① 主进程**委托**：它只该"凑配置 → 写盘 → 记住文件"，不该自己拼覆盖层
		assert.ok(supervisor.includes('renderHostOverlays('),
			'主进程没调用 `renderHostOverlays` ⇒ 覆盖层又出现了第二份实现（会静默漂移）');
		assert.ok(supervisor.includes('hostOverlayFileName('),
			'覆盖层文件名要共用 `hostOverlayFileName`（否则两个入口的 run 目录对不上，人工比对失效）');
		// ② 主进程**不再**直接调这 7 个渲染器：它若又出现，就是平行实现回来了
		for (const fn of [
			'renderBridgeOverlay', 'renderKanbanOverlay', 'renderCodebaseOverlay',
			'renderSkillsOverlay', 'renderAgentsOverlay', 'renderDataRootOverlay', 'renderMemoryOverlay',
		]) {
			assert.ok(!new RegExp(`${fn}\\s*\\(`).test(supervisor),
				`主进程又直接调用 ${fn} 了 ⇒ 覆盖层有了第二份实现（要么删掉它，要么把差异并进 renderHostOverlays）`);
			assert.ok(neutral.includes(`${fn}(`), `中立配置没调用 ${fn} ⇒ standalone 入口会少注入这一条`);
		}
		// ③ MCP 是**有意的例外**：supervisor 的 `_writeMcpOverlay` 要先读盘+解析，并在"行已归 dsh 侧"时让路
		//    ⇒ 它留在 supervisor 里，但用的是**同一个** `renderMcpOverlay`。聚合器也为独立入口支持 mcp。
		assert.ok(neutral.includes('renderMcpOverlay('), '中立配置要能渲染 mcp（独立入口靠它）');
		assert.ok(supervisor.includes('renderMcpOverlay('), 'MCP 那条丢了渲染器（改 `_writeMcpOverlay` 时看这里）');
		assert.ok(!mcp || mcp.includes('export function renderMcpOverlay('), 'MCP 渲染器的定义不见了');
		// ④ ★ 打包产物里**没有 `__dirname` / `import.meta`**（2026-10-15 实测：Host 启动即
		//    `start failed: __dirname is not defined` —— supervisor 里出现这两个标识符 = 启动必挂）。
		//    定位仓库根用 `process.cwd()`（dev 以仓库根启动）+ `process.resourcesPath`（打包），
		//    绝不用"本文件的位置"当锚点 ✓。
		for (const bad of ['__dirname', 'import.meta']) {
			assert.ok(!supervisor.includes(bad),
				`dshHostSupervisor.ts 里出现了 \`${bad}\` ⇒ 打包产物里它是 undefined ⇒ Host 启动必挂（2026-10-15 实测）。定位仓库根用 process.cwd() / process.resourcesPath`);
		}
	});

	/**
	 * ★ **用户可见文案不许与常量脱钩**（2026-10-16）：`hostKeepAlive` 的设置说明里**曾经写死**"空闲 30 分钟
	 * 自动退出"，而解法 A（2026-10-15）把值改成 12 小时之后它就变成了**假话**（用户照设置读到的是 30 分钟，
	 * 实际是 12 小时 ✗）。现在文案由 `hostIdleTtlText()` 从常量派生 ⇒ 结构上不会再漂移；
	 * 下面这条再钉住**默认值本身**：谁改 `DSH_HOST_IDLE_TTL_MS`，谁就必须回来复审那句用户可见文案
	 * （红了不是"测试过期"，是"这句文案要重新过一遍" ✓）。
	 */
	test('★ 设置文案的时长由常量派生，默认值被钉住（改常量 ⇒ 强制复审文案）', () => {
		assert.strictEqual(hostIdleTtlText(30 * 60_000), '30 分钟', '整小时以下用"分钟"（更短的取值也要读得通）');
		assert.strictEqual(hostIdleTtlText(60 * 60_000), '1 小时', '整小时用"小时"，不许写成"60 分钟"');
		assert.strictEqual(hostIdleTtlText(), '12 小时',
			'Host 空闲自退的**默认**时长（解法 A：12h 覆盖一个工作日的多次重启）—— 改了常量就要来改这条，'
			+ '并回头复审 `dshHarness.contribution.ts` 里 `hostKeepAlive` 的那句用户可见文案');
	});
});
