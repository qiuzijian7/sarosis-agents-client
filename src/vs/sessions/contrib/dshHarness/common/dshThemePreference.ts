/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 读 dsh **自己的**「外观」偏好（`<dshHome>/settings.yaml` → `ui-theme.preference`）。
 *
 * ## 为什么要有这一层（2026-11-02，抄官方 dsh-desktop 的时序）
 * 我们原来靠**页面自报** `documentElement[data-ds-theme-source]` 才知道 dsh 的明暗
 * （见 `preload-dshView.ts` 与 `dshViewHost.applyPageThemeSource`）。那条通道只在**页面跑起来之后**
 * 才可能发出第一条 ⇒ 在此之前（建视图 → dom-ready，真机几百毫秒到数秒）`prefers-color-scheme`
 * 是上一轮的值/系统值 ⇒ 自托管页与第三方组件会先按错的明暗画一帧。
 *
 * 官方桌面壳的做法正好相反：`nativeTheme.themeSource = harnessThemePreference()` 在**建窗口之前**设置
 * （`dsh-desktop/src/main/index.ts` 的 `harnessThemePreference()`），所以窗口一出生就是对的。
 * 我们是多窗口宿主，不能改全局 `nativeTheme`（会波及 IDE 窗口），但可以**在建视图时**就把
 * 该视图要模拟的 palette 模式定下来 —— 前提是**主进程能读到这份偏好**，也就是本文件。
 *
 * ## 为什么要自己解析 YAML
 * 只需要一个布尔级的事实（`ui-theme.preference` 的三个取值之一）。为了它引入 YAML 依赖、
 * 或把「读文件」这件事挪进渲染进程都不划算 ⇒ 用一个**只认这一段**的最小扫描器，
 * 并且**认不出就当没配**（`system`）：宁可回到旧行为，也不要猜错把用户界面刷成反色 ✗。
 *
 * ⚠ 与官方一致：**只读不写**。设置项的真源永远是 dsh 自己的设置界面。
 */

import { DshColorScheme } from './dshHarness.js';

/** dsh「外观」的三个取值（与 `settings.yaml` 里 `ui-theme.preference` 同字面量）。 */
export type DshThemePreference = 'light' | 'dark' | 'system';

/** 认不出/没配 ⇒ `system`（= 交回真实的系统值，不替用户做决定）。 */
export const DSH_DEFAULT_THEME_PREFERENCE: DshThemePreference = 'system';

/**
 * 从 `settings.yaml` 文本里取 `ui-theme.preference`。
 *
 * 认这两种写法（dsh 的设置界面写的是第一种）：
 * ```yaml
 * ui-theme:
 *   preference: dark
 * ```
 * ```yaml
 * ui-theme: { preference: dark }
 * ```
 * 其它一律回落 `system`。
 */
export function parseThemePreference(yamlText: string): DshThemePreference {
	if (typeof yamlText !== 'string' || !yamlText) {
		return DSH_DEFAULT_THEME_PREFERENCE;
	}
	const lines = yamlText.split(/\r?\n/);

	// ① 块写法：`ui-theme:` 之后、缩进更深的行里找 `preference:`
	for (let i = 0; i < lines.length; i++) {
		const head = /^(\s*)ui-theme\s*:\s*(#.*)?$/.exec(lines[i]);
		if (!head) {
			continue;
		}
		const baseIndent = head[1].length;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			if (!line.trim() || /^\s*#/.test(line)) {
				continue;                       // 空行/注释不结束块
			}
			const indent = /^(\s*)/.exec(line)?.[1].length ?? 0;
			if (indent <= baseIndent) {
				break;                          // 回到同级/更浅 ⇒ 这一块结束了
			}
			const m = /^\s*preference\s*:\s*['"]?([A-Za-z]+)['"]?\s*(#.*)?$/.exec(line);
			if (m) {
				return normalizePreference(m[1]);
			}
		}
	}

	// ② 行内映射写法（整份文件只有一行时也成立）
	const inline = /(^|\n)\s*ui-theme\s*:\s*\{[^}]*preference\s*:\s*['"]?([A-Za-z]+)/.exec(yamlText);
	if (inline) {
		return normalizePreference(inline[2]);
	}
	return DSH_DEFAULT_THEME_PREFERENCE;
}

function normalizePreference(raw: string): DshThemePreference {
	const v = String(raw ?? '').trim().toLowerCase();
	return v === 'light' || v === 'dark' || v === 'system' ? v : DSH_DEFAULT_THEME_PREFERENCE;
}

/**
 * 偏好 + 系统明暗 ⇒ 这个视图要模拟的 palette 模式。
 *
 * `system` ⇒ `undefined` = **不要模拟**（让页面读真实的系统值；任何模拟值在这里都是错的，
 * 而且页面自报的那条通道同样把 `system` 解释为"撤掉模拟"，两边口径一致 ✓）。
 */
export function colorSchemeForPreference(preference: DshThemePreference, systemIsDark: boolean): DshColorScheme | undefined {
	if (preference === 'light') {
		return 'light';
	}
	if (preference === 'dark') {
		return 'dark';
	}
	void systemIsDark;                    // system 不需要推断：不模拟就是最准的
	return undefined;
}
