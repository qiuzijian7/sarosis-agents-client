/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros 主题 → dsh 页面 token 的映射与校验（方案 5.13.2 的 P2 项：主题 token 对齐）。
 *
 * dsh 的主题扩展点：客户端插件对 `theme` 服务调 `overrideTokens(source, tokens)`，
 * token 名就是 CSS 变量名（`--dsw-alias-*`），值必须是 `{ light, dark }` 双形态。
 * 我们的口径：两形态都填 VsSaros 当前主题的颜色 —— 聊天框始终跟 IDE 一致，
 * 与 dsh 自己的 light/dark 偏好解耦（页面嵌在 IDE 里，不该跟着系统走）。
 *
 * 本文件不含 DOM / 服务依赖（可单测）；颜色取值由调用方注入。
 */

/** token 名 → VsSaros 颜色 id 与备选（按序取第一个有值的）。 */
const TOKEN_MAP: ReadonlyArray<readonly [token: string, ids: readonly string[]]> = [
	['--dsw-alias-bg-base', ['editor.background']],
	['--dsw-alias-bg-layer-1', ['sideBar.background', 'editorWidget.background']],
	['--dsw-alias-bg-layer-2', ['panel.background', 'editorWidget.background']],
	['--dsw-alias-bg-overlay', ['editorWidget.background', 'menu.background']],
	['--dsw-alias-border-l1', ['panel.border', 'editorGroup.border']],
	['--dsw-alias-border-l2', ['input.border', 'panel.border']],
	['--dsw-alias-brand-primary', ['button.background', 'focusBorder', 'textLink.foreground']],
	['--dsw-alias-label-primary', ['editor.foreground', 'foreground']],
	['--dsw-alias-label-secondary', ['descriptionForeground']],
	['--dsw-alias-state-error-primary', ['errorForeground', 'inputValidation.errorForeground']],
	['--dsw-alias-state-idle-primary', ['disabledForeground']],
	['--dsw-alias-state-success-primary', ['testing.iconPassed', 'terminal.ansiGreen']],
	['--dsw-alias-state-warn-primary', ['editorWarning.foreground', 'list.warningForeground']],
];

export type DshThemeTokens = Record<string, { light: string; dark: string }>;

/** 取色器：返回 CSS 颜色串（如 `#1e1e1e` / `rgba(...)`），取不到返回 undefined。 */
export type DshThemeColorGetter = (vscodeColorId: string) => string | undefined;

/** 从当前主题构建覆盖 token；两形态同值。取不到色的 token 跳过（保留 dsh 默认）。 */
export function buildDshThemeTokens(getColor: DshThemeColorGetter): DshThemeTokens {
	const tokens: DshThemeTokens = {};
	for (const [token, ids] of TOKEN_MAP) {
		for (const id of ids) {
			const value = getColor(id);
			if (value) {
				tokens[token] = { light: value, dark: value };
				break;
			}
		}
	}
	return tokens;
}

const TOKEN_NAME_RE = /^--dsw-alias-[a-z0-9-]+$/;
const COLOR_VALUE_RE = /^[a-zA-Z0-9#(),.%\s-]{1,120}$/;

/**
 * 视图**底色候选**（2026-10-13：修「初次打开侧栏视图会白屏一下」）。
 *
 * ## 为什么需要它
 *
 * 侧栏里的插件自托管页是**原生 `WebContentsView`**（`dshViewHost.ts`）——它从创建到页面画出第一帧
 * 之间，显示的是 Electron 的**默认底色（白）** ✗。深色主题下这就是"一开就闪一下白"（用户 2026-10-13 报障）。
 * 最省且最对的修法是：**建视图时就把它染成当前主题对应位置的底色** ✓（`View.setBackgroundColor`）。
 *
 * ## 为什么是"两个候选色"而不是一个
 *
 * 颜色只有渲染进程知道（`IThemeService`），而**该用哪个位置的颜色**只有主进程知道
 * （它持有 `pageSurface`：`'sideview'` = 侧栏、`'editor'` = 编辑器区）⇒ 把两个都推过去、由主进程挑 ✓。
 * 侧栏用 `sideBar.background`、编辑器区用 `editor.background` —— 这两处在浅色主题下差别明显，
 * 用错会让"闪"变成"闪成另一种不协调的颜色" ✗。
 */
export interface IDshViewBackgrounds {
	/** 侧栏承载（`pageSurface='sideview'`，以及 chat / sessions / full 这些同样落在侧栏的视图） */
	sidebar?: string;
	/** 编辑器区承载（`pageSurface='editor'`） */
	editor?: string;
}

/** 跨进程边界校验（形状与 `validateThemeTokens` 同口径：只允许 CSS 颜色的形状 ✓）。 */
export function validateViewBackgrounds(value: unknown): value is IDshViewBackgrounds {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const v = value as Record<string, unknown>;
	for (const key of ['sidebar', 'editor']) {
		const raw = v[key];
		if (raw !== undefined && (typeof raw !== 'string' || !COLOR_VALUE_RE.test(raw))) {
			return false;
		}
	}
	return true;
}

/**
 * 按**承载位置**挑底色（纯函数：判断只写这一份，主进程不在两处各写一遍 ✓）。
 *
 * 回退口径：位置对应的那个缺了就退另一个 —— **有主题色就比默认白好** ✓（不追求完美、绝不退回白 ✗）。
 */
export function backgroundForPageSurface(backgrounds: IDshViewBackgrounds | undefined, pageSurface: string | undefined): string | undefined {
	if (!backgrounds) {
		return undefined;
	}
	const picked = pageSurface === 'editor' ? backgrounds.editor : backgrounds.sidebar;
	return picked ?? backgrounds.sidebar ?? backgrounds.editor;
}

/** 页面桥 `applyTheme` 负载校验（跨进程边界）：token 名/颜色值的形状都收紧。 */
export function validateThemeTokens(value: unknown): value is DshThemeTokens {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	for (const [name, modes] of Object.entries(value)) {
		if (!TOKEN_NAME_RE.test(name)) {
			return false;
		}
		if (!modes || typeof modes !== 'object') {
			return false;
		}
		const m = modes as Record<string, unknown>;
		if (typeof m.light !== 'string' || typeof m.dark !== 'string' || !COLOR_VALUE_RE.test(m.light) || !COLOR_VALUE_RE.test(m.dark)) {
			return false;
		}
	}
	return true;
}
