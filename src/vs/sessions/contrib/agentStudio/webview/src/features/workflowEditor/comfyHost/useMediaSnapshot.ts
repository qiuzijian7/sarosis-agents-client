/*---------------------------------------------------------------------------------------------
 *  useMediaSnapshot — React binding for MediaSnapshotStore.
 *
 *  Cards subscribe to the store so thumbnails appear as soon as a Comfy node
 *  produces output (without remounting the card).
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { MediaSnapshotStore } from './mediaSnapshotStore';
import type { MediaRef, MediaSnapshotEntry } from './mediaSnapshot';

/**
 * 订阅 store 自增版本号 —— 组件把它当作值依赖后，store put/clear 任何变化
 * 都会触发重渲染。
 *
 * ★ 必须 export：nodeCard 的 SnapshotPreview 直接使用 `useStoreVersion(snapshotStore)`
 *   把版本作为 `bustedSrc` 的入参（缓存穿透的二级护城河）。esbuild IIFE 打包下
 *   命名导出有丢失风险（见项目历史踩坑记录），务必使用【命名 export function】的
 *   字面语法形式，不可改写成 `const xxx = () =>`。
 */
export function useStoreVersion(store: MediaSnapshotStore | undefined): number {
	return React.useSyncExternalStore(
		React.useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => { /* no-op */ }), [store]),
		React.useCallback(() => store?.getSnapshot() ?? 0, [store]),
		React.useCallback(() => store?.getSnapshot() ?? 0, [store]),
	);
}

/**
 * 函数式变体（避免 esbuild IIFE 下命名导出的 hook 名称丢失）。
 *
 * ★ 跨模块 import 时函数引用可能为 undefined；改为对象属性访问可被
 *   bundler/运行时可靠地解析。nodeCard 改用它；这里也复用 useStoreVersion。
 */
export const mediaSnapshotHooks = {
	storeVersion: useStoreVersion,
};

/**
 * Subscribe to a store and return the media ref for a key (or undefined).
 * `getSnapshot` returns the store version so the component re-renders on mutation;
 * we then look up the ref freshly.
 */
export function useMediaSnapshotRef(store: MediaSnapshotStore | undefined, key: string): MediaRef | undefined {
	const version = useStoreVersion(store);
	void version;
	return store?.get(key);
}

/**
 * Subscribe to a store and return ALL snapshot entries for a node (batch output).
 * Cards show a thumbnail grid when a stage emits multiple media items.
 */
export function useNodeSnapshots(store: MediaSnapshotStore | undefined, nodeId: string | undefined): MediaSnapshotEntry[] {
	const version = useStoreVersion(store);
	void version;
	if (!store || !nodeId) { return []; }
	return store.byNode(nodeId);
}

/**
 * Picker 专用：订阅 store 并聚合所有上游节点的 media entry（卡片按上游
 * 节点 ID 读图，而非 picker 自身）。与 useNodeSnapshots 同样基于 useStoreVersion
 * 订阅，store 变更时组件重渲染且此处重新计算——否则 picker 在「上游先生成图像、
 * 后 spawn」的时序下 Pool 计数会更新但缩略图始终为空。
 */
export function usePickerSnapshots(store: MediaSnapshotStore | undefined, upstreamNodeIds: readonly string[] | undefined): MediaSnapshotEntry[] {
	const version = useStoreVersion(store);
	void version;
	if (!store || !upstreamNodeIds?.length) { return []; }
	const out: MediaSnapshotEntry[] = [];
	for (const uid of upstreamNodeIds) {
		const list = store.byNode(uid);
		if (list) { out.push(...list); }
	}
	return out;
}

/**
 * 跨节点订阅：返回 store 里**所有节点**的 entry（可选按 kind 过滤）。picker 的
 * 「全部生成图」视图用它替代 usePickerSnapshots（后者仅直接上游）。同样基于
 * useStoreVersion 订阅，store 变更时重渲染。
 */
export function useAllSnapshots(store: MediaSnapshotStore | undefined, kind?: MediaRef['kind']): MediaSnapshotEntry[] {
	const version = useStoreVersion(store);
	void version;
	if (!store) { return []; }
	return store.allEntries(kind);
}
