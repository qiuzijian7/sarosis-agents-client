/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渠道条目的状态计算（设置页 Channel 配置用）。
 *
 * ★ 纯函数、无 DOM：把「该渠道现在在干什么」拆成可测的判定树。
 *
 * 判定顺序（后面的覆盖不了前面的，前面的优先）：
 *   1. 无适配器（该渠道没有平台实现）→ 「未实现」（灰）
 *   2. 缺凭证 → 「未配置」（灰）
 *   3. 配了但没启用 → 「已停用」（灰）
 *   4. 有适配器但没装配上（bridge 里查不到平台实例）→ 「已启用（未装配）」（琥珀）
 *   5. 平台运行时状态 → 已连接（绿）/ 连接中（琥珀）/ 异常（红，detail 为失败原因）
 *
 * Why: 渠道类问题此前最大的体感是「配了没反应、坏了不吭声」（见 D-02/D-12/D-14）。
 *      状态条的作用就是把这四层原因各自显形，用户一眼看出卡在哪一层。
 */

import type { BridgePlatformStatus } from "../../common/bridge/bridgeTypes.js";

export type ChannelStatusTone = "ok" | "warn" | "bad" | "dim";

export interface ChannelStatusInfo {
	readonly tone: ChannelStatusTone;
	/** 徽章文本（短，一行放得下）。 */
	readonly label: string;
	/** 悬浮提示（完整原因）。 */
	readonly detail?: string;
}

/** 计算所需的全部输入（调用方负责取配置 / 运行时；本函数不做 IO）。 */
export interface ChannelStatusInputs {
	/** 该渠道是否有平台适配器（feishu / telegram 有，其余没有）。 */
	readonly hasAdapter: boolean;
	/** 凭证是否就绪（appId+appSecret / botToken 等必需字段齐全）。 */
	readonly configured: boolean;
	/** 是否启用（启用开关 / env 覆盖等都已算好）。 */
	readonly enabled: boolean;
	/** 平台实例的运行时状态（bridge.getPlatform(id)?.getStatus()；未装配时为 undefined）。 */
	readonly platform?: BridgePlatformStatus;
}

/** 计算渠道状态徽章。hasAdapter=false 时也返回徽章（「未实现」），保证列表整齐。 */
export function computeChannelStatus(inputs: ChannelStatusInputs): ChannelStatusInfo {
	if (!inputs.hasAdapter) {
		return { tone: "dim", label: "未实现", detail: "该渠道当前没有平台适配器（暂无运行时接入）" };
	}
	if (!inputs.configured) {
		return { tone: "dim", label: "未配置", detail: "缺少凭证（如 App ID / App Secret / Bot Token）" };
	}
	if (!inputs.enabled) {
		return { tone: "dim", label: "已停用", detail: "已配置但未启用（启用开关为关，且无 env 覆盖）" };
	}
	const platform = inputs.platform;
	if (!platform) {
		return {
			tone: "warn",
			label: "已启用 · 未装配",
			detail: "凭证已就绪且已启用，但运行时未装配平台 —— 多半是装配失败或尚未完成，请重启窗口或查看日志",
		};
	}
	switch (platform.state) {
		case "connected":
			return { tone: "ok", label: "已连接", detail: platform.detail };
		case "connecting":
			return { tone: "warn", label: "连接中…", detail: platform.detail };
		case "error":
			return { tone: "bad", label: "异常", detail: platform.detail };
		default:
			return { tone: "dim", label: "已启用 · 未连接", detail: platform.detail ?? "平台已装配但未连接" };
	}
}
