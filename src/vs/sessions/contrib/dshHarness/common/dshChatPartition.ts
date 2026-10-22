/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **聊天视图的网络分区判定**（2026-10-21，中间栏并排多聊天）。
 *
 * 背景：Chromium 对同一个 `host:port` 的 HTTP/1.1 并发连接上限是 **6**，而 dsh 的每个页面
 * 长期占住若干条连接（状态同步流）。真机实测（弹窗场景）：两个 dsh 页并存时三个页面的
 * `fetch` 全部 10s 超时，关掉弹窗主窗口立刻恢复 ⇒ 共享池被占满后，新请求只能永远排队，
 * 表现为"页面已加载但 `session.create` 永不返回"、"reload 也救不回来"。
 *
 * ⇒ 同一窗口并排跑多个聊天时，**第 2..N 个聊天视图各占一个独立分区**（独立 socket 池）✓。
 *
 * 判定口径（三档）：
 *  - `desktop`：弹窗（拼装式 desktop）—— 既有语义，与主窗口彻底隔离。
 *  - `main`：**第一个**聊天视图 —— 仍用主分区 ⇒ 单聊天场景行为完全不变，
 *    且与插件页同源 ⇒ 跨页焦点交接（聊天页 → agents 页）照旧 ✓。
 *  - `pool`：主分区上已经有活跃聊天视图时的后来者 —— 独占一个池分区。
 *
 * 抽成纯模块的理由：这个判定一旦写错，后果是"两个聊天互相饿死"（界面表现像"卡住"，
 * 极难从日志里看出来）⇒ 判定本身必须有单测，而不是只靠主进程那几百行里的一个 if ✓。
 */

/** 聊天视图的分区类别。 */
export type DshChatPartitionKind =
	/** 弹窗专用分区（与主窗口彻底隔离）。 */
	| 'desktop'
	/** 主分区（与插件页同源；单聊天场景用它）。 */
	| 'main'
	/** 池分区（并发聊天视图各自独占一个）。 */
	| 'pool';

export interface IDshChatPartitionDecision {
	readonly kind: DshChatPartitionKind;
	/** 实际使用的分区名（`electron.session.fromPartition` 的参数）。 */
	readonly partition: string;
}

export interface IDshChatPartitionInput {
	/** 该视图是否被显式要求独立分区（弹窗走这条）。 */
	readonly isolatedPool: boolean;
	/** 视图承载的表面（`chat` / `plugin-page` / …）。 */
	readonly surface: string;
	/** 主分区上是否已经有**活跃的聊天视图**（socket 池是 session 级的 ⇒ 跨窗口也共享）。 */
	readonly mainPartitionBusy: boolean;
	/** 已经分配过几个池分区（下一个池分区的序号 = 该值 + 1 ⇒ 分区名不复用）。 */
	readonly poolSeq: number;
	/** 弹窗分区名。 */
	readonly desktopPartition: string;
	/** 主分区名。 */
	readonly mainPartition: string;
	/** 池分区名前缀。 */
	readonly poolPrefix: string;
}

/**
 * 判定一个视图该用哪个网络分区。
 *
 * ⚠ 顺序有讲究（每条都对应一种"两个聊天互相饿死"或"行为突变"的现场）：
 *  1. `isolatedPool` 最优先 —— 弹窗的语义就是"彻底独立"，不能被后面的规则改写；
 *  2. 非聊天表面一律主分区 —— 插件页之间要共享登录态/偏好（localStorage 同源）；
 *  3. 聊天视图：主分区空闲 ⇒ 用主分区（单聊天零变化）；已被占用 ⇒ 独占池分区。
 */
export function decideChatPartition(input: IDshChatPartitionInput): IDshChatPartitionDecision {
	if (input.isolatedPool) {
		return { kind: 'desktop', partition: input.desktopPartition };
	}
	if (input.surface !== 'chat') {
		return { kind: 'main', partition: input.mainPartition };
	}
	if (!input.mainPartitionBusy) {
		return { kind: 'main', partition: input.mainPartition };
	}
	return { kind: 'pool', partition: `${input.poolPrefix}${input.poolSeq + 1}` };
}
