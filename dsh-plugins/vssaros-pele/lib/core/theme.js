// 主题预设的读取（真源：随包的 `assets/pele-theme.json`）。
//
// 为什么预设是**数据文件**而不是常量：IDE 渲染进程（TS）与 dsh Host（本插件）都要用同一套配色，
// 写成两份常量 ⇒ 一定会漂（本仓"同一份清单的两条读取路径必须同口径"的同一条纪律）。
// 于是：JSON 随包，两边各自读；这里只负责解析与兜底。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本插件的 assets 目录（`lib/core/` 往上两级）。安装后 assets 随 `files` 一起进包 ✓。 */
export function assetsDir() {
	return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
}

/** 预设里以 `$` 开头的键是注释（说明/版本），不是 CSS 变量 ⇒ 读值时跳过。 */
const isNoteKey = (k) => k.startsWith('$');

let cached = null;

/** 读并解析主题预设（同步 + 缓存；文件缺了直接抛，不静默回退 ✗）。 */
export function loadThemePresets() {
	if (cached) { return cached; }
	const file = join(assetsDir(), 'pele-theme.json');
	const parsed = JSON.parse(readFileSync(file, 'utf8'));
	const presets = {};
	for (const [name, vars] of Object.entries(parsed?.presets ?? {})) {
		presets[name] = Object.fromEntries(Object.entries(vars ?? {}).filter(([k]) => !isNoteKey(k)));
	}
	if (!Object.keys(presets).length) {
		throw new Error(`pele 主题预设为空或格式不对：${file}`);
	}
	cached = presets;
	return presets;
}

/** 取一个预设的 CSS 变量表；`theme` 只认 'dark' / 'default'，其它值按 default（与渲染入口同口径）。 */
export function themeVars(theme) {
	const presets = loadThemePresets();
	return presets[theme === 'dark' ? 'dark' : 'default'] ?? presets.default;
}

/** 可用预设名（给工具的参数描述 / 自检用）。 */
export function themeNames() {
	return Object.keys(loadThemePresets());
}
