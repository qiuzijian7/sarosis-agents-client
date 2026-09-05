/*---------------------------------------------------------------------------------------------
 *  visual/runtimeDom — 沙箱的**浏览器渲染**实现（`SandboxMountImpl`）。
 *
 *  ★ 为什么单独一个文件：`runtime.ts` 必须保持「宿主无关 + 绝不 import .tsx」——
 *    Node 侧 runner 的 esbuild 插件只解析 `.js → .ts`，且 nodeCard.tsx 会把
 *    react/react-dom 拖进 bundle（Node 测试不需要渲染，只需执行）。
 *    → 渲染能力单独放这里，由浏览器侧注入 `createSandbox({ mountImpl: mountCard })`。
 *
 *  ★ 只在浏览器宿主（visual/build.mjs）下被 import。
 *--------------------------------------------------------------------------------------------*/

import type { SandboxContext, SandboxMountImpl } from './runtime.js';

type AnyRec = Record<string, unknown>;

/**
 * 渲染一张真实节点卡片（走运行时同一条 `createNodeCard` 通路）。
 *
 * 卡片与沙箱共享 `snapshotStore` / `cardStateStore` —— 所以 `sandbox.run()` 执行完
 * 写回快照、更新 runState 后，卡片会**自动重渲染**成 success（显示 OUTPUT）或
 * error（显示 ErrorBanner）。这就是「渲染 + 执行」闭环。
 */
export const mountCard: SandboxMountImpl = async (
	host: HTMLElement,
	ctx: SandboxContext,
	type: string,
	nodeId: string,
): Promise<{ unmount: () => void; meta: unknown }> => {
	// 无扩展名：由 visual/build.mjs 的解析插件挑选 .ts / .tsx
	const nodeCard = await import('../src/features/workflowEditor/comfyHost/nodeCard') as unknown as {
		getNodeCardMeta(spec: unknown, properties: unknown): unknown;
		createNodeCard(host: HTMLElement, meta: unknown, opts: unknown): () => void;
	};

	const spec = ctx.getSpec(type);
	if (!spec) {
		throw new Error(`runtimeDom.mountCard: unknown node type "${type}"`);
	}

	const meta = nodeCard.getNodeCardMeta(spec, {} as AnyRec);
	const unmount = nodeCard.createNodeCard(host, meta, {
		snapshotStore: ctx.store,
		cardStateStore: ctx.cardState,
		nodeId,
	});
	return { unmount, meta };
};
