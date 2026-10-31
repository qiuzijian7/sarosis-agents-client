/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 反馈问卷的**唯一真源**（2026-10-31）。
 *
 * ⚠ 以前 IDE 侧（`menubar.contribution.ts`）与 dsh 侧（`dshHarness.contribution.ts`）
 *   各存一份同样的字符串 ⇒ 改一处忘一处、两份漂移。两边现在都从这里取。
 */
export const FEEDBACK_FORM_URL = 'https://sarosgame.feishu.cn/share/base/form/shrcnLSwbX5eJtTW9DxVmVMxiag';

/**
 * 可被 `prefill_` 预填的字段。
 *
 * ⚠ 题名必须与问卷里的题名**逐字一致**（飞书官方：改题名 ⇒ 预填**静默失效**，不报错）。
 *   2026-10-31 实测该问卷 7 题：
 *     1 提交时间（自动字段）  2 版本号  3 问题描述*  4 平台（单选：Win/Mac/Web）
 *     5 日志文件（附件）      6 问题截图（附件）  7 建议
 *   ⇒ 文本题走 prefill；**附件题不支持预填**，只能走 CDP 填 `input.files`。
 */
export interface IFeedbackPrefill {
	/** 题名「版本号」。 */
	版本号?: string;
	/** 题名「平台」，单选，取值必须是表里已有的选项。 */
	平台?: string;
	/** 题名「问题描述」（必填）。 */
	问题描述?: string;
	/** 题名「建议」。 */
	建议?: string;
}

/**
 * 给自己留的链接预算。
 *
 * 飞书硬上限是 16,000 字符（超过 ⇒ **整条**预填失效，不是截断）；再叠加
 * 浏览器 / openExternal 对超长 URL 的限制 ⇒ 这里按 8,000 收口。
 */
const FEEDBACK_URL_BUDGET = 8000;

/** 值编码：空格用 `+`（飞书官方示例的写法），其余交给 `encodeURIComponent`。 */
function encodeValue(v: string): string {
	return encodeURIComponent(v).replace(/%20/g, '+');
}

/**
 * 拼带预填的问卷链接。
 *
 * 预算不够时**按传入顺序砍值**（而不是让整条失效）：调用方把短的、关键的字段放前面，
 * 长文本（问题描述 / 建议）放后面 —— 它们最后填、也最先被砍。
 *
 * **独立导出**，守卫可直接断言（不必真打开一次问卷）。
 */
export function buildFeedbackUrl(fields: IFeedbackPrefill): string {
	const parts: string[] = [];
	let used = FEEDBACK_FORM_URL.length + 1;

	for (const [key, value] of Object.entries(fields)) {
		if (!value) { continue; }
		const prefix = `prefill_${encodeURIComponent(key)}=`;
		const room = FEEDBACK_URL_BUDGET - used;
		if (room <= prefix.length) { break; }
		let encoded = prefix + encodeValue(value);
		if (encoded.length > room) {
			// 中文 UTF-8 编码后一个汉字膨胀到 9 个字符 ⇒ 按最坏情况回退
			const keep = Math.max(0, Math.floor((room - prefix.length) / 9));
			encoded = prefix + encodeValue(value.slice(0, keep));
		}
		parts.push(encoded);
		used += encoded.length + 1;
	}

	return parts.length ? `${FEEDBACK_FORM_URL}?${parts.join('&')}` : FEEDBACK_FORM_URL;
}
