/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { Agent } from '../../../common/agentStudioTypes.js';

/**
 * 判定指定用户是否可上传（发布到商城）该 agent。
 *
 * 规则（避免多人维护时非 owner 互相覆盖上传）：
 *   - 内置 agent（source==='builtin'）不可上传 —— 系统资产。
 *   - owner 为空：允许认领式上传（兼容存量 / 未登录时创建的 agent）。
 *   - owner 非空：仅 owner 本人可上传。
 *
 * @param agent         待判定的 agent 定义
 * @param currentUserId 当前登录用户的 user_id（TOF，格式 taihu:staffid:xxx）；未登录传 undefined
 */
export function canUploadAgent(agent: Agent, currentUserId?: string): boolean {
	if (agent.source === 'builtin') {
		return false;
	}
	if (!agent.owner) {
		return true;
	}
	return !!currentUserId && currentUserId === agent.owner;
}

/**
 * 解析上传成功后应认领的 owner。
 *
 * 返回当前登录用户 ID（即应写入 Agent.owner 的值），未登录返回 undefined
 * （此时不应改写 owner，避免把未登录上传误写成空 owner）。
 *
 * @param currentUserId 当前登录用户的 user_id；未登录传 undefined
 */
export function resolveClaimOwner(currentUserId?: string): string | undefined {
	return currentUserId || undefined;
}
