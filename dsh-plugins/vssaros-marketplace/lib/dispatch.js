// @vssaros/dsh-marketplace — **动作分派表**（★ 2026-10-23 抽出：原先是 6 层 if 嵌套）
//
// 为什么单独抽一个文件：
//   ① **可测**：分派原先是 `apply()` 里的一串 `if`，只能起整个 Host 才测得到 ⇒
//      "哪个 op 去哪"这条最容易错的契约，**一个测试都没有** ✗
//   ② **防漂移**：`OPS`（对外声明）与真实分派曾是两份手写清单，加 op 时漏改一处
//      就会出现「声明有、实际不认」（`callIde` 白名单）或相反 ✗
//   ③ **可读**：6 层 if 读不出"这个 op 到底走哪条路"
//
// 分派目标只有 5 种，每种对应 `index.js` 里的一段处理：
//   local-read    → 走本地（认证 + HTTP + 台账），如 list / installed / publishables
//   local-write   → 走本地落盘（skill / workflow / agent 的装升卸）
//   local-http    → 走本地纯 HTTP（编辑元数据 / 管理员审核，服务端判权）
//   local-publish → 走本地打包上传/下架
//   ide           → 转给 IDE 控制桥（workbench 装卸、agent 发布等，见各常量注释）

// ★ 打包能力的真源在 publisher.js（这里只引用，不再抄一份）
import { PUBLISHABLE_KINDS } from './publisher.js';

/** 走本地只读的 op（不碰 IDE 桥 ✓）。 */
// ★ 2026-10-27：`inspectGithub` 也是只读（只抓 GitHub 元数据，不写盘、不写商城）
//   ⇒ 放进 LOCAL_READ_OPS，这样它不需要审批、不会误判成写操作 ✓
// ★ 2026-10-26：`preflightPublish` 发布前体检（只抓上游元数据，不写盘、不写商城）⇒ 只读
export const LOCAL_READ_OPS = new Set(['list', 'detail', 'installed', 'publishables', 'reviewList', 'inspectGithub', 'preflightPublish']);

/**
 * 走本地落盘的**写** op（装 / 升 / 卸）。
 *
 * ★ 2026-10-23：新增 `trash`（删除到 `<数据根>/.trash-<时间戳>/`，可恢复）。
 *   ⚠ 必须加进这个集合 —— 否则 `isKnownOp` 不认，页面点「删除」只会拿到
 *   「不认识的商城动作：trash」（我在浏览器里是 stub 掉 confirm 测的，差点漏掉这条）。
 */
// ★ 2026-10-26：`setMcpEnabled` 写的是 `<数据根>/mcp.json` 的 disabled（与装/卸同一类落盘操作）
export const LOCAL_WRITE_OPS = new Set(['install', 'upgrade', 'uninstall', 'trash', 'setMcpEnabled']);

/**
 * 这三类 op 里，dsh 侧能自持的 kind。
 *
 * · `skill` / `workflow` / `agent`：都是"目录镜像落数据根"（agent 自 2026-10-22 起）
 * · `workbench`：必须 `dsh plugin add` + 重启 Host ⇒ 永远是 IDE
 * · `mcp` / `knowledge`：没有可落盘的本体（配置/文档集）⇒ 不进这条路径
 */
// ★ 2026-10-23（用户「都转移到 dsh 侧实现」）：加 `mcp`
//   （装完会顺带把服务器注册进 `<数据根>/mcp.json`，见 `mcpInstall.js`）
export const LOCAL_WRITE_KINDS = new Set(['skill', 'workflow', 'agent', 'mcp']);

/**
 * ★ 2026-10-24（用户：「插件管理能否在 dsh 侧实现，不走 ide」）：能。
 *   这类资源的包体在 npm / GitHub，安装 = `dsh plugin add`；而 dsh 把这件事做成了**进程内服务**
 *   `ctx.pluginManager`（@deepseek-ai/dsh-plugin-manager，与 CLI 共用 operations.js）
 *   ⇒ 插件自己就能装/卸/升，且装了 dsh-hmr 时**热生效、不用重启**。
 *   ⚠ 这里只表示「dsh 侧优先」：运行时没有 pluginManager（老 Host / 无 profileContext）时
 *     调用方必须退回 IDE ⇒ 所以标记为 local-plugin，而不是 local-write。
 */
export const LOCAL_PLUGIN_KINDS = new Set(['plugin', 'workbench']);

/** 走本地纯 HTTP 的写 op（服务端判权：assertAuthor / requireAdmin）。 */
export const LOCAL_HTTP_OPS = new Set([
	'updatePackage', 'reviewStatus', 'reviewFeature',
]);

/**
 * 走本地打包/下架的 op。
 *
 * `delete*` 是纯 HTTP，**不分 kind** ✓
 * `publish` 按 kind 判断（见 {@link PUBLISH_LOCAL_KINDS}）。
 */
export const LOCAL_PUBLISH_OPS = new Set(['deletePackage', 'deleteVersion']);

/**
 * `publish` 时 dsh 侧能自己打包的 kind。
 *
 * ★ 2026-10-23：**直接取 `publisher.js` 的同名清单**（单一真源）——
 *   之前这里手写了 `['skill','workflow']`，而 `PUBLISHABLE_KINDS` 已经加回了 `agent`
 *   （因为 IDE 侧安装器也认目录镜像包了）⇒ 两份清单打架：分派把 `publish(agent)`
 *   送去 IDE，而 dsh 侧明明能打包 ✗（本条由 dispatch 守卫 ⑦ 抓到）
 *
 * 历史（别再走回头路）：agent 的发布一度只能留 IDE，因为商城包格式是 `agent.json`
 * 而只有 IDE 的 `preparePack` 会组装它。后来 `agentInstaller.install` 加了
 * 「目录镜像」分支（认 `.agent.md`）⇒ 那个限制消失了 ⇒ agent 现在能双向发布/安装 ✓
 */
export const PUBLISH_LOCAL_KINDS = PUBLISHABLE_KINDS;

/**
 * 2026-10-24（用户：「插件 item 是允许有开关的」）：插件启用/停用与状态查询。
 * 它们**不带 kind**（操作对象是 npm 包名），所以按 op 名分派，走 local-plugin 那条路
 * （内部再按 pluginManager 能力决定能不能做，做不了就退回 IDE）。
 */
export const PLUGIN_STATE_OPS = new Set(['pluginState', 'setPluginEnabled']);

/** 全部**能被处理**的 op（本地 + IDE）。对外声明（`/api/meta`）与白名单都用它 ✓ */
export const ALL_OPS = [
	...LOCAL_READ_OPS,
	...LOCAL_WRITE_OPS,
	...LOCAL_HTTP_OPS,
	...LOCAL_PUBLISH_OPS,
	'publish',
	'self-check',
	...PLUGIN_STATE_OPS,
];

/** 需要用户确认、耗时较长的 op（转 IDE 时用长超时）。 */
export const WRITE_OPS = new Set([...LOCAL_WRITE_OPS, 'publish', ...LOCAL_PUBLISH_OPS]);

/**
 * 判定一个动作该在哪执行。
 *
 * @param {string} op
 * @param {{ kind?: unknown }} [params]
 * @returns {'local-read' | 'local-write' | 'local-plugin' | 'local-http' | 'local-publish' | 'ide'}
 */
export function resolveOp(op, params = {}) {
	const name = String(op ?? '');
	const kind = String(params?.kind ?? '');

	if (LOCAL_READ_OPS.has(name)) { return 'local-read'; }
	// 插件开关：不带 kind，按 op 名直接给 dsh 侧（能力不足时调用方退回 IDE）
	if (PLUGIN_STATE_OPS.has(name)) { return 'local-plugin'; }
	if (LOCAL_WRITE_OPS.has(name)) {
		// 插件 / 工作台：dsh 侧有 pluginManager 就能自己装（调用方按能力再兜底回 IDE）
		if (LOCAL_PLUGIN_KINDS.has(kind)) { return 'local-plugin'; }
		// 其余 kind 决定能不能自持：能 ⇒ 本地落盘；不能（mcp 等）⇒ 交 IDE
		return LOCAL_WRITE_KINDS.has(kind) ? 'local-write' : 'ide';
	}
	if (LOCAL_HTTP_OPS.has(name)) { return 'local-http'; }
	if (LOCAL_PUBLISH_OPS.has(name)) { return 'local-publish'; }
	if (name === 'publish') {
		if (PUBLISH_LOCAL_KINDS.includes(kind)) { return 'local-publish'; }
		// ★ 2026-10-26（分析工作台 GitHub 发布流程时发现）：**带 source（GitHub 地址）的登记**
		//   必须留在 dsh 侧。原来这里只看 kind ⇒ workbench / plugin 一律转 IDE，
		//   而 IDE 的 publish 分支只读 version / changelog、**把 source 丢了** ⇒
		//   用户填的 GitHub 地址被静默忽略，变成"打包上传"（workbench 根本没包可打）✗。
		//   服务端 external 接口不限 kind，dsh 侧 publishExternal 也能发任意 kind ⇒ 直接本地发 ✓。
		if (String(params?.source ?? '').trim()) { return 'local-publish'; }
		// 同一条理由：npm 源的登记也只是发一段 JSON（服务端 external 接口不限 kind）
		if (String(params?.npmName ?? '').trim()) { return 'local-publish'; }
		// 其余（真正的"打包上传"）：workbench 要 dsh plugin add + 重启 ⇒ 交 IDE
		return 'ide';
	}
	// 未知 / 纯 IDE 的 op ⇒ 兜底交 IDE（由 IDE 侧白名单给出"不认识"的可读报错）
	return 'ide';
}

/**
 * 这个 op 是否是**已知**动作（本地或 IDE 都会认）。
 *
 * 用途：`callIde` 的白名单 —— 用它代替手写清单，避免"声明有、实际不认"✗
 */
export function isKnownOp(op) {
	return ALL_OPS.includes(String(op ?? ''));
}
