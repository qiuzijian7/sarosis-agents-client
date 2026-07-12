/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 平台桥接层：安全与卡片降级工具（对齐 cc-connect core/message.go + card.go）──
// 本文件为纯函数（无 fs / 无平台服务依赖），可在 common/ 下被引用与单测。

import { BridgeCard } from "./bridgeTypes.js";

/** 无权限时的用户态提示（对齐 cc-connect UnauthorizedAccessMessage，不泄露 allow_from/用户ID/会话ID）。 */
export const UnauthorizedAccessMessage = "角色未授权，请联系管理员添加权限。";

/**
 * 校验入站用户是否在允许列表内（对齐 cc-connect AllowList）。
 * - allowFrom 为空或 "*" → 允许所有人；
 * - 否则按逗号分隔，大小写不敏感比较 userId。
 */
export function allowFromCheck(allowFrom: string | undefined, userId: string): boolean {
	const list = (allowFrom ?? "").trim();
	if (list === "" || list === "*") {
		return true;
	}
	const target = userId.trim().toLowerCase();
	for (const id of list.split(",")) {
		if (id.trim().toLowerCase() === target) {
			return true;
		}
	}
	return false;
}

/**
 * 启动时检查 allowFrom 配置（对齐 cc-connect CheckAllowFrom）。
 * 未配置时通过 log 输出安全告警（默认 permit-all）。
 * 返回 true 表示 permit-all（未限制）。
 */
export function checkAllowFromConfig(
	platform: string,
	allowFrom: string | undefined,
	log?: (msg: string) => void,
): boolean {
	if ((allowFrom ?? "").trim() === "") {
		const msg = `[Bridge] 平台 ${platform} 未配置 allow_from — 将允许所有用户，请在配置中限制访问。`;
		if (log) {
			log(msg);
		}
		return true;
	}
	return false;
}

/**
 * 在文本中将敏感 token 替换为 [REDACTED]，避免凭证泄露到日志/错误（对齐 cc-connect RedactToken）。
 */
export function redactToken(text: string, token: string | undefined): string {
	if (!token || token === "" || !text) {
		return text;
	}
	return text.split(token).join("[REDACTED]");
}

/**
 * 把不受信任的附件文件名归约为安全 basename（对齐 cc-connect sanitizeAttachmentFileName）。
 * 剥离所有目录成分（含 Windows 反斜杠），拒绝 "." / ".." 等父目录引用。
 * 无法产出安全 basename 时返回 ""，调用方应回退到生成名。
 */
export function sanitizeAttachmentFileName(name: string | undefined): string {
	if (!name) {
		return "";
	}
	// 反斜杠归一为斜杠，确保任意 OS 都能剥离 Windows 风格路径。
	let n = name.replace(/\\/g, "/");
	n = n.split("/").pop() ?? "";
	if (n === "" || n === "." || n === "..") {
		return "";
	}
	return n;
}

/**
 * 将富卡片降级为纯文本表示（对齐 cc-connect Card.RenderText）。
 * 用于不支持原生卡片的平台（飞书交互卡 / Telegram 行内键盘之外的通道）。
 */
export function renderCardToText(card: BridgeCard): string {
	const lines: string[] = [];

	if (card.header && card.header.title) {
		lines.push(`**${card.header.title}**`, "");
	}

	for (const el of card.elements) {
		switch (el.kind) {
			case "markdown":
				lines.push(el.content, "");
				break;
			case "divider":
				lines.push("---", "");
				break;
			case "note":
				lines.push(el.text);
				break;
			case "actions":
				lines.push(el.buttons.map(b => `[${b.text}]`).join("  "), "");
				break;
		}
	}

	return lines.join("\n").replace(/\n+$/u, "");
}
