/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FLOW 控制链判定（2026-09-10 用户规则）—— **无依赖纯函数**，可单测、可复用。
 *
 * 画布端口约定（webview `registry.ts`）：
 *   - 控制流端口固定名：`flowIn`（入） / `flowOut`（出），类型 `FLOW`；
 *   - 数据端口用业务名：`images` / `batch` / `prompt` / `texts` …
 *
 * 两条语义（调用方据此分流）：
 *   - **执行**：所有连线（含数据线）都驱动上游执行与数据流转 —— 没有 FLOW 连线的
 *     节点，其上下游的图片等媒体输出照常产出；
 *   - **卡片阶段**：只有 FLOW 连线上的节点才在工作流卡里展示为「阶段」，数据辅助
 *     节点（loader / picker 等）不占阶段位。
 */

export const FLOW_IN_PORT = 'flowIn';
export const FLOW_OUT_PORT = 'flowOut';

/** 连接的最小结构（与 WorkflowGraphConnection 兼容，避免跨层类型依赖）。 */
export interface IFlowConnectionLike {
	from: string;
	to: string;
	fromPort?: string;
	toPort?: string;
}

/**
 * 出边（from → to）是否由 FLOW 控制口发出。
 * 端口名缺失时**保守视为 FLOW**（旧工作流 / 非 schema 节点），否则老工作流的卡片
 * 会整片空白——宁多显示，不误隐藏。
 */
export function isFlowOut(port: string | undefined): boolean {
	return port === undefined || port === FLOW_OUT_PORT;
}

/** 入边是否进入 FLOW 控制口（端口名缺失时保守视为 FLOW，同上）。 */
export function isFlowIn(port: string | undefined): boolean {
	return port === undefined || port === FLOW_IN_PORT;
}

/**
 * 单条连接是否为 FLOW 控制连线。
 * LiteGraph 连接要求两端端口类型兼容，故 FLOW 边的**两端**都应是控制口
 * （`flowOut` → `flowIn`）；只判一侧会把「数据边 + 旧数据缺端口名」误判成 FLOW。
 */
export function isFlowConnection(conn: IFlowConnectionLike): boolean {
	return isFlowOut(conn.fromPort) && isFlowIn(conn.toPort);
}

/**
 * 节点是否落在 FLOW 控制链上（任一入边或出边是 FLOW 连线）。
 * 用于决定该节点是否在工作流卡里展示为「阶段」。
 */
export function isNodeOnFlowChain(connections: readonly IFlowConnectionLike[] | undefined, nodeId: string): boolean {
	if (!nodeId) { return false; }
	for (const c of (connections ?? [])) {
		if (c.from === nodeId && isFlowOut(c.fromPort)) { return true; }
		if (c.to === nodeId && isFlowIn(c.toPort)) { return true; }
	}
	return false;
}
