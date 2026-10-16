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
 * `_notifications.prompt`）。而**知识库默认就在工作区之外**（`<数据根>/knowledge-base/…`，本机实测
 * `C:\Users\<u>\.vssaros-dev\knowledge-base` ⇒ 工作区是 `g:\SarosWorkspace\…`）✗
 * ⇒ 用户每点一行都得先去点那条通知；不知道要点的人看到的就是**"点了没反应"** ✗。
 *
 * ## 信任面**没有**被放宽（这是 allowlist，不是"凡是盘上文件都免问"✗）
 *
 * 只有两类根：
 *   ① **知识库数据根**：`kbRoot` 设置（用户改过才有 ✓，与 IDE `knowledgeBaseView.rootUri` 同一份
 *      `resolveKbRoot` 实现 ✓）缺省回落 `<数据根>/knowledge-base` ✓；
 *   ② **已登记的库根**：`agentStudio.kb.vaults` 里带 `customPath` 的那些（= 「配置文件夹为知识库」挂进来的
 *      外部目录 ✓）—— 同样只有**登记过**的才免问 ✓。
 * 其它工作区外路径**照旧**要用户点一下 ✓（协议头部那条安全模型不变 ✓）。
 * 与 VsSaros **自己的知识库视图**同一口径：它打开这些库里的文件从来不需要确认 ✓。
 */
export function knowledgeBaseTrustRoots(
	kbRootOverride: string | undefined,
	dataRoot: string | undefined,
	vaultPaths: readonly (string | undefined | null)[] = [],
): string[] {
	const roots: string[] = [];
	const push = (p: string | undefined | null) => {
		if (typeof p !== 'string') { return; }
		const trimmed = p.trim();
		if (trimmed) { roots.push(trimmed); }
	};
	// ① 数据根：设置过就用它；否则 `<数据根>/knowledge-base`（**与插件侧的缺省同值** ✓ ——
	//    两条口径必须一致，否则"页面里能列出来、点了却要确认"这种半信任态 ✓）。
	push(kbRootOverride);
	if (typeof dataRoot === 'string' && dataRoot.trim()) {
		const base = dataRoot.trim().replace(/[\\/]+$/, '');
		// ⚠ 这里刻意用 `/` 拼（不引 path 模块）：`isPathInside` 会把两种分隔符都归一 ✓，
		//   而 common 层引 `vs/base/common/path` 反而要小心中间层约束 ✗。
		if (base) { roots.push(`${base}/knowledge-base`); }
	}
	// ② 已登记库根（customPath）
	for (const p of vaultPaths) { push(p); }
	// 去重（数据根与某个库根可能同值；重复不影响判定，但读数里少一份噪声 ✓）
	return Array.from(new Set(roots));
}
