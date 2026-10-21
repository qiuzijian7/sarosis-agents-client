/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「profile 已装版本」vs「随包版本」的**版本错配审计**（纯逻辑、无 I/O）。
 *
 * ## 为什么需要（现场：2026-10-21 15:41，用户报"新建会话报错"）
 *
 * 症状：`新建会话失败: agent-preset/invalid: vssaros-memory (@vssaros/dsh-memory): never started`
 * —— dsh 的预设审计里那一行的 fiber 从未激活 ⇒ **整个 agent-preset 判为 invalid** ⇒ 新建会话被直接拒掉。
 *
 * 真正的原因是**版本错配**：profile 里 `@vssaros/dsh-memory` 停在 0.3.81，而**携带预设**的
 * `@vssaros/dsh-agents` 已是新一代 ⇒ 预设里 memory 那一行按新口径挂载、按旧插件实现 ⇒ 挂不起来。
 * 而当时的启动日志里**只有别的插件的 installing 行** ⇒ 从日志完全看不出"profile 与随包不同代"这层原因 ✗✗
 * （排查绕了很久：先怀疑插件代码、apply 抛错、入口缺失、依赖被剪……全不是）。
 *
 * ⇒ 本模块把这一层原因变成**启动日志里的一行名字 + 两个版本号**，让这类失败从"用户新建会话失败"
 *   降级成"日志里看得见的版本错配"。
 *
 * ## 口径（刻意与安装流程**解耦**）
 *
 * 安装流程（`dshHostSupervisor._planPluginInstall`）只覆盖"这次要装/要升级"的条目；
 * **漏装**（压根没进清单）、被 `skipPluginInstall` 放过的、随包源码缺入口被跳过的 ⇒ 都不在它的视野里 ✗
 * ⇒ 而"安装器没管"的那一批恰恰是**最该被看见**的（它们会让预设行挂不起来）⇒ 这里独立走一遍 ✓。
 */

/** 一条随包插件的版本对照。 */
export interface IBundledPluginVersion {
	/** 插件包名（如 `@vssaros/dsh-memory`）。 */
	readonly name: string;
	/** 人类可读的标签（如"记忆模块"）。 */
	readonly label: string;
	/** profile 里已装版本；`undefined` = 没装。 */
	readonly installed?: string;
	/** 随包源码的版本；`undefined` = 读不到（当作"无从比对"，不报）。 */
	readonly bundled?: string;
}

/** 审计结果。 */
export interface IBundledVersionAudit {
	/** 真正不一致的条目（已装 ≠ 随包）。 */
	readonly mismatched: readonly IBundledPluginVersion[];
	/** 直接可贴进日志的行（每行一个插件）。 */
	readonly lines: readonly string[];
}

/**
 * 比对版本并给出可贴日志的行。
 *
 * @param entries 随包插件的版本对照（已装/随包都可缺）。
 * @returns 不一致条目 + 日志行。
 */
export function auditBundledPluginVersions(entries: readonly IBundledPluginVersion[]): IBundledVersionAudit {
	const mismatched: IBundledPluginVersion[] = [];
	const lines: string[] = [];
	for (const entry of entries) {
		const bundled = entry?.bundled;
		if (!bundled) {
			// 随包版本读不到 ⇒ 无从比对（不是"错配"，别误报 ✓）。
			continue;
		}
		const installed = entry?.installed;
		if (installed === bundled) {
			continue;
		}
		mismatched.push(entry);
		lines.push(`${entry.label} ${entry.name}：已装 ${installed ?? '（缺失）'} / 随包 ${bundled}`);
	}
	return { mismatched, lines };
}

/**
 * 生成整段提示文本（自检用；宿主负责写日志）。
 *
 * @param audit `auditBundledPluginVersions` 的结果。
 * @returns 整段文本；没有错配时返回空串。
 */
export function renderBundledVersionAudit(audit: IBundledVersionAudit): string {
	if (!audit || !audit.lines?.length) {
		return '';
	}
	return [
		`⚠ profile 与随包插件版本不一致（${audit.lines.length} 项）—— 若报 "agent-preset/invalid … never started" 或新建会话失败，先看这里：`,
		...audit.lines.map(line => `  · ${line}`),
	].join('\n');
}
