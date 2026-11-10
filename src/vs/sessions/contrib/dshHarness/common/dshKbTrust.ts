/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 页面桥的**路径信任口径**：哪些根算"我们自己的数据"⇒ 打开时**不必**再问用户一次。
 *
 * ## 为什么需要（2026-10-15，用户报"点击知识库里的文件打不开 editorpane"）
 *
 * 页面桥对**工作区之外**的路径一律先弹一条带「打开」按钮的通知（`dshHarness.contribution.ts` 的
 * `_notifications.prompt`）。而**知识库默认就在工作区之外**（`<数据根>/knowledge-base/…`）✗
 * ⇒ 用户每点一行都得先去点那条通知；不知道要点的人看到的就是**"点了没反应"** ✗。
 *
 * ## ★ 2026-11-10：以 dsh 侧配置为准
 *
 * 用户裁决「移除 IDE 侧配置和逻辑」⇒ 原先的两类根里，`kbRootOverride`（幽灵设置
 * `agentStudio.knowledge.storage.path`）与 `vaultPaths`（IDE storage `agentStudio.kb.vaults`
 * 的 customPath）**全部移除**。现在只认 dsh 侧：
 *   ① `dshConfiguredRoot`：`<数据根>/.kb-root.json` 里由聊天框工具卡写入的根目录（可选）；
 *   ② 缺省 `<数据根>/knowledge-base`。
 *
 * 这仍是 **allowlist**（不是"凡是盘上文件都免问"✗）：其它工作区外路径照旧要用户点一下 ✓。
 */
export function knowledgeBaseTrustRoots(
	dataRoot: string | undefined,
	dshConfiguredRoot?: string,
): string[] {
	const roots: string[] = [];
	const push = (p: string | undefined | null) => {
		if (typeof p !== 'string') { return; }
		const trimmed = p.trim();
		if (trimmed) { roots.push(trimmed); }
	};
	// ① dsh 侧自持的根配置（工具卡写入；与插件 `kbRootOf` 同一份文件）
	push(dshConfiguredRoot);
	// ② 缺省根：与插件侧的缺省同值 ✓（两条口径必须一致，否则"页面里能列出来、点了却要确认"）
	if (typeof dataRoot === 'string' && dataRoot.trim()) {
		const base = dataRoot.trim().replace(/[\\/]+$/, '');
		// ⚠ 这里刻意用 `/` 拼（不引 path 模块）：`isPathInside` 会把两种分隔符都归一 ✓，
		//   而 common 层引 `vs/base/common/path` 反而要小心中间层约束 ✗。
		if (base) { roots.push(`${base}/knowledge-base`); }
	}
	// 去重（配置根与缺省根可能同值；重复不影响判定，但读数里少一份噪声 ✓）
	return Array.from(new Set(roots));
}
