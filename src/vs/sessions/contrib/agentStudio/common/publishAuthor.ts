/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 上传发布时的「作者」解析逻辑（纯函数，便于测试）。
 *
 * 规则：优先取当前登录用户的显示名（displayName），其次登录名（username），
 * 最后回退到资源自带的 author 字段。三者都为空时返回 undefined。
 *
 * 这样上传表单中的作者栏能自动带出登录者身份，而不是依赖资源里可能过时/缺失的 author。
 */

export interface IPublishAuthorUser {
	readonly displayName?: string;
	readonly username?: string;
}

/**
 * 解析发布时应使用的作者名。
 * @param currentUser 当前登录用户（来自 marketplaceService.getCurrentUser()）
 * @param resourceAuthor 资源（skill/agent/workflow）自带的 author 字段
 * @returns 作者名；三者均空时返回 undefined（调用方应视为「无作者信息」）
 */
export function resolvePublishAuthor(
	currentUser: IPublishAuthorUser | undefined,
	resourceAuthor?: string,
): string | undefined {
	const fromUser = currentUser?.displayName?.trim() || currentUser?.username?.trim();
	if (fromUser) { return fromUser; }
	const fromResource = resourceAuthor?.trim();
	if (fromResource) { return fromResource; }
	return undefined;
}
