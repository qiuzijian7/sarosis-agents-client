/**
 * @vssaros/dsh-unreal —— **Host 侧**的 `unreal_*` 工具族（**七个全在这里**）。
 *
 * ## 它解决什么
 *
 * `unreal_*` 在 VsSaros 里由 `vssaros-ide` 暴露，经反向通道交给 **IDE 进程**执行
 * （HTTP 客户端在 renderer，还专门绕了一道 CORS）。而它本质上就是**对本机 `/bridge/*` 发 HTTP**
 * ⇒ 没有 VsSaros 时不该整族失效。这里把它搬到 Host（README 4.68）：Host 是 Node，连 CORS 都没有。
 *
 * ## 七个工具都在这里（2026-10-13 口径变更）
 *
 * 此前本模块**只注册只读四个**（health / help / dump / find_asset），执行类三个（exec / wait / build）
 * 曾以"VsSaros 侧也只放行只读子集"为由**不注册** ✗。**那条口径已作废** ✗（用户 2026-10-13 决定）：
 * 七个 `unreal_*` 全部由 Host 实现 ✓。
 *
 * ⚠ 与之配套的 `UNREAL_READONLY_TOOLS` 清单已从 `dshIdeCapabilities.ts` **删除** ✓（那条约束过时 ✓）。
 * 但 IDE 侧 `browser/providers/tool/unrealTools.ts` 那份**同族实现仍在**（供 legacy 聊天栈用 ✓）——
 * 它属"要不要退役 legacy 那一整套"的**产品决策**，本次不动 ✗（要退，得连带处理 `builtinToolProvider`
 * 的 `_registerUnrealTools` 调用点、`toolsetConfig` 的 `unreal_` 前缀与那条 2026-09-21 事故注释 ✓）。
 *
 * 执行类三个能在编辑器里**跑任意 Python / 触发 C++ 构建** ⇒ 属"有用户可见副作用"那一类，
 * 权限**靠审批闸守** ✓：三个都挂官方 `tools/pre-execute` ⇒ `ask`（见下面 `WRITE_TOOLS`），
 * 而不是靠"不提供" ✗ —— 这也是本仓写工具的既有纪律（README 5.104 / 5.110 ✓）。
 *
 * ## 配置
 *
 * bridge 地址来自该行的 `config.bridgeUrl`，或环境变量 `VSSAROS_UNREAL_BRIDGE_URL`，
 * 缺省 `http://127.0.0.1:8765`（与 VsSaros 设置项 `sessions.agentStudio.unreal.bridgeUrl` 同默认值）。
 */

import { DEFAULT_BRIDGE_URL, TIMEOUT_MS, UNREAL_TOOLS, WRITE_TOOL_NAMES, callBridge } from './core/bridge.js';

export const name = 'vssaros-unreal';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
	const env = process.env;
	const bridgeUrl = typeof config.bridgeUrl === 'string' && config.bridgeUrl.trim()
		? config.bridgeUrl.trim()
		: (env.VSSAROS_UNREAL_BRIDGE_URL ?? '');

	const log = line => {
		try { process.stdout.write(`${line}\n`); } catch { /* 忽略 */ }
		ctx.logger?.info?.(line);
	};
	// ★ **让路标记**：`vssaros-ide` 检查它在不在，在就跳过自己那套 `unreal_*`（README 4.69 Step 1）。
	//   两个包注册同名工具会让整条 entry 失效（不是后者覆盖）⇒ 必须保证任何时刻只有一个。
	ctx.provide('vssarosUnreal', {
		plugin: '@vssaros/dsh-unreal',
		tools: UNREAL_TOOLS.map(t => t.name),
		executesInHost: true,
	});
	log(`[vssaros-unreal] apply（bridge=${bridgeUrl || DEFAULT_BRIDGE_URL} tools=${UNREAL_TOOLS.map(t => t.name).join(',')}）`);

	// ★ 审批闸：执行类三个（exec / wait / build）在 Unreal 编辑器里跑 Python / 触发构建 ✓ ⇒ 派发前先问 ✓。
	//   官方契约（`dsh-tools` 类型 L37-47）：`tools/pre-execute` 是 **waterfall** 事件，返回 `{ kind: 'ask' }`
	//   即"先问用户" ✓；`ask` 只有审批服务返回 `allowed-once` 才执行，否则 deny ✓；**没有审批支持的部署
	//   degrade to deny** ⇒ fail-closed ✓（headless/TUI 里宁可拒绝，也不静默执行 ✗）。
	//   只读四个**不放行**进闸 ✓ —— 否则每次 health/dump 都弹窗 ⇒ 审批疲劳 ✗（p3-26 钉着这条 ✓）。
	const WRITE_TOOLS = new Set(WRITE_TOOL_NAMES);
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && WRITE_TOOLS.has(exec.name)) {
			return {
				kind: 'ask',
				reason: `${exec.name} 会在本机 Unreal 编辑器里执行（跑 Python / 触发构建 ⇒ 改编辑器状态）`,
				displayReason: {
					en: `Allow ${exec.name} to run inside the locally running Unreal Editor?`,
					zh: `允许 ${exec.name} 在本机 Unreal 编辑器里执行？`,
				},
			};
		}
		return next();
	}));

	for (const tool of UNREAL_TOOLS) {
		const writes = WRITE_TOOLS.has(tool.name);
		ctx.effect(() => ctx.tools.register({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			// ⚠ dsh ≥ 0.2.1-alpha.1 起 `tools.register` **强制**要求 `output { schema, render }`
			//   （缺了整条 entry 不激活：`TypeError: tool "…" must declare output`）。
			//   本族返回的是**文本**（失败也是可读文本，见 `core/bridge.js`）⇒ 声明 string + 文本渲染。
			output: {
				schema: { type: 'string' },
				render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
			},
			// 逐工具超时（官方 `tools/call-timeout-policy` 读 `tool.timeoutMs` ✓）。wait 最长 30 分钟
			// （真源 `TIMEOUT_MS` ✓）⇒ 不声明的话会被策略按默认值提前掐断 ✗。
			timeoutMs: TIMEOUT_MS[tool.name] ?? 60_000,
			// 只读四个 ⇒ 可并行 ✓；执行类三个**改编辑器状态** ⇒ 不声明（默认独占 ✓）。
			...(writes ? {} : { isConcurrencySafe: () => true }),
			execute: async params => await callBridge(
				{ bridgeUrl: () => bridgeUrl },
				tool.endpoint,
				tool.buildBody(params ?? {}),
				tool.name,
			),
		}));
	}
}
