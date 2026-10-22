/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  媒体库资产 → **工作流画布**（2026-10-19，统一媒体库为一个编辑区页时的必备件）。
 *
 *  背景：媒体库统一成 `MediaGalleryEditorPane`（编辑区页）之后，原来 webview 浮层里
 *  「把卡片拖到画布上创建一个 Loader 节点」这条路没了 —— 浮层与画布在**同一个 webview**，
 *  window 级 drop 直接读 `application/x-saros-asset`；而编辑区页是**宿主 DOM**，画布是
 *  `vscode-webview://` iframe（跨源）⇒ 自定义 MIME 的 DnD 不保证能过边界。
 *  ⇒ 改走"**按钮 + 宿主转发**"：pane 点「插入到画布」⇒ 本模块发一条请求 ⇒
 *  `WorkflowEditorPane`（它知道自己的 workflowId，也持有 controller）过滤后转发给 webview
 *  ⇒ webview 侧调 `spawnAssetLoader(assetId, kind, pos)`（与拖拽落地**同一个函数** ✓）。
 *
 *  ⚠ 为什么用模块级 Emitter 而不是让 pane 直接拿 controller：与 `canvasOpsBridge` 同款解耦
 *    （工具/编辑器层不碰 controller），且 pane 与画布**可能属于不同实例**，只有
 *    `WorkflowEditorPane` 同时知道"我是哪个工作流"和"我的 webview 在哪"✓。
 *  ⚠ 请求**带 workflowId**：同一时刻可能开着多个工作流画布，广播的话每个画布都会多一个节点 ✗。
 *  ⚠ fire-and-forget（没有回执）：画布没开 / 不是同一个工作流 ⇒ 这次点击**静默无效**。
 *    调用方（pane）因此在**只有带 workflowId 上下文时才显示**该动作 ✓。
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';

export interface IMediaAssetInsertRequest {
	/** 目标工作流 id（接收端按它过滤，避免多画布同时插入）。 */
	readonly workflowId: string;
	/** 媒体资产 id（写入节点 data.mediaAssetId）。 */
	readonly assetId: string;
	/** 资产类型：image / video / audio（决定 Loader 节点类型）。 */
	readonly kind: string;
}

/** 媒体库页发出的"插入到画布"请求（`WorkflowEditorPane` 订阅）。 */
export const mediaAssetInsertEmitter = new Emitter<IMediaAssetInsertRequest>();

/** 请求把某个媒体资产插入到指定工作流的画布（fire-and-forget）。 */
export function requestInsertMediaAsset(request: IMediaAssetInsertRequest): void {
	mediaAssetInsertEmitter.fire(request);
}
