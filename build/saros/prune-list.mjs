/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 构建期「重型可选负载」裁剪清单 —— `prepack-dsh-runtime.mjs` 与 `check-dsh-release.mjs`
 * 的**唯一真源**（纯数据、无副作用，两边都 import 它）。
 *
 * 为什么需要单一真源（2026-11-07）：
 *   10-28 加 ②bis 发布守卫时，把「运行时与种子都不该有 libreoffice 内核」硬编码在守卫里；
 *   11-02 Office 全量路线上线后 prepack 的 `PRUNE_LIST` 被置空（内核有意保留），但守卫没跟上
 *   ⇒ CI 全新构建装出 182MB 内核时会**误报并拦住出包**。守卫必须跟着清单走，而不是自己抄一份。
 */

/**
 * 安装后要裁掉的**运行时本体**负载。每项是从 runtime 根开始的相对路径段
 * （`prune()` 用 `join(targetDir, ...rel)` 定位）。
 *
 * ★ 2026-11-02：LibreOffice Kit 原生引擎不裁 —— Office 全量路线需要它做渲染 / 转换 /
 *   重算，随 **dsh-runtime 本体**分发，见 `build/prepare-office-runtime.mjs:276`。
 *   ★ 2026-11-12（dsh 0.2.2-rc.2）：Office 工具仍依赖这个原生引擎，保留理由不变。
 *   ★ 2026-11-21：Windows 有原生 win32-x64 引擎时不会使用 wasm 后备，因此裁掉
 *   `libreoffice-kit-wasm` 的 145MB 资源，保留原生 Office 能力。
 *
 * 注意：sherpa-onnx-*（本地语音识别，22 MB）**不裁** —— 语音输入是聊天框特性。
 */
export const PRUNE_LIST = [
	// Windows 桌面端有 win32-x64 原生引擎时不会加载 wasm 后备；保留原生引擎和 Office 能力，
	// 移除 145MB 的 portable wasm 资源，减少安装包体积。
	['node_modules', '@deepseek-ai', 'libreoffice-kit-wasm'],
];

/**
 * pnpm 虚拟店（`node_modules/.pnpm/<entry>/`）里要裁掉的重型内核。
 *
 * **独立于 PRUNE_LIST**：种子 profile 里的这份是 pnpm 平铺装出来的**依赖副本**，
 * Office 工具用的是 dsh-runtime 本体那份内核、不指向种子里的副本 ⇒ 裁掉是安全的，
 * 实测省 ~182MB（2026-11-07 种子 755MB → 573MB / 648MB）。
 * 这条只作用于**种子**，不碰运行时本体。
 *
 * pnpm 12 默认用 `.pnpm` 虚拟店布局，内核藏在
 * `@deepseek-ai+libreoffice-kit-win32-x64@<ver>/node_modules/...`；hoisted 布局没有这个路径。
 */
export const VIRTUAL_STORE_HEAVY_RE = /^@deepseek-ai\+libreoffice-kit-(?:win32|darwin|linux|wasm)/;
