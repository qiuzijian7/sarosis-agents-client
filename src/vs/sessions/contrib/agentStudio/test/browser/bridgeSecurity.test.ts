/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── P1 安全/附件/卡片降级工具单测（对齐 cc-connect message.go / card.go）──

import assert from 'assert';
import {
	allowFromCheck,
	checkAllowFromConfig,
	redactToken,
	renderCardToText,
	sanitizeAttachmentFileName,
	UnauthorizedAccessMessage,
} from "../../common/bridge/bridgeSecurity.js";
import { appendFileRefs } from "../bridge/bridgeAttachments.js";
import { BridgeCard } from "../../common/bridge/bridgeTypes.js";

suite("bridgeSecurity", () => {
	test("allowFromCheck: 空/星号允许所有人", () => {
		assert.strictEqual(allowFromCheck("", "anyone"), true);
		assert.strictEqual(allowFromCheck(undefined, "anyone"), true);
		assert.strictEqual(allowFromCheck("*", "anyone"), true);
	});

	test("allowFromCheck: 大小写不敏感逗号列表", () => {
		assert.strictEqual(allowFromCheck("Alice, Bob", "bob"), true);
		assert.strictEqual(allowFromCheck("Alice, Bob", "carol"), false);
		assert.strictEqual(allowFromCheck("ou_abc123", "ou_ABC123"), true);
	});

	test("sanitizeAttachmentFileName: 剥离目录穿越", () => {
		assert.strictEqual(sanitizeAttachmentFileName("../../escape.txt"), "escape.txt");
		assert.strictEqual(sanitizeAttachmentFileName("C:\\\\Users\\\\x\\\\a.png"), "a.png");
		assert.strictEqual(sanitizeAttachmentFileName("/etc/passwd"), "passwd");
		assert.strictEqual(sanitizeAttachmentFileName(".."), "");
		assert.strictEqual(sanitizeAttachmentFileName(""), "");
	});

	test("redactToken: 脱敏凭证", () => {
		assert.strictEqual(redactToken("token=secret123 end", "secret123"), "token=[REDACTED] end");
		assert.strictEqual(redactToken("no secret here", "secret123"), "no secret here");
		assert.strictEqual(redactToken("x", ""), "x");
	});

	test("checkAllowFromConfig: 空配置告警", () => {
		let warned = false;
		const isPermitAll = checkAllowFromConfig("feishu", "", () => (warned = true));
		assert.strictEqual(isPermitAll, true);
		assert.strictEqual(warned, true);
	});

	test("renderCardToText: 降级为纯文本", () => {
		const card: BridgeCard = {
			header: { title: "标题", color: "blue" },
			elements: [
				{ kind: "markdown", content: "正文内容" },
				{ kind: "divider" },
				{ kind: "note", text: "脚注" },
				{ kind: "actions", buttons: [{ text: "确定", value: "cmd:/ok" }] },
			],
		};
		const text = renderCardToText(card);
		assert.ok(text.includes("**标题**"));
		assert.ok(text.includes("正文内容"));
		assert.ok(text.includes("---"));
		assert.ok(text.includes("脚注"));
		assert.ok(text.includes("[确定]"));
		assert.ok(!text.includes("cmd:/ok"));
	});

	test("UnauthorizedAccessMessage: 不泄露身份", () => {
		assert.ok(!UnauthorizedAccessMessage.includes("allow_from"));
	});
});

suite("bridgeAttachments.appendFileRefs", () => {
	test("空路径原样返回 prompt", () => {
		assert.strictEqual(appendFileRefs("hi", []), "hi");
	});

	test("追加路径引用", () => {
		const out = appendFileRefs("分析文件", ["/tmp/a.pdf"]);
		assert.ok(out.startsWith("分析文件"));
		assert.ok(out.includes("/tmp/a.pdf"));
	});

	test("空 prompt 使用默认引导语", () => {
		const out = appendFileRefs("", ["/tmp/a.pdf"]);
		assert.ok(out.includes("附带"));
	});
});
