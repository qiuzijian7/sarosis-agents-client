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
	/**
	 * 「已装比随包**新**」的条目（2026-10-28）。
	 *
	 * 这类**不是错配**：exe 比 profile 旧是正常状态（先跑新 dev、再跑旧安装包）。
	 * 分开记是为了两件事：① 不触发降级重装（见 `_planPluginInstall`）；
	 * ② 日志里别把它们混进"版本不一致，先看这里"的告警里（那会把人引到错方向）。
	 */
	readonly newer: readonly IBundledPluginVersion[];
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
	const newer: IBundledPluginVersion[] = [];
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
		// ★ 2026-10-28：已装比随包**新** ⇒ 不是错配（exe 比 profile 旧属正常），单独归类、不进告警。
		if (isVersionNewer(installed, bundled)) {
			newer.push(entry);
			continue;
		}
		mismatched.push(entry);
		lines.push(`${entry.label} ${entry.name}：已装 ${installed ?? '（缺失）'} / 随包 ${bundled}`);
	}
	return { mismatched, newer, lines };
}

/**
 * `a` 是否比 `b` **新**（用于"已装比随包新 ⇒ 不降级"）。
 *
 * 为什么需要（2026-10-28 真机：打包版 exe 启动卡在"正在启动 VsSaros…"六分钟）：
 *   那个 exe 里随包的 `@vssaros/dsh-chat-surface@0.2.243`，而 profile 里已经装着 0.2.259
 *   （dev 侧一路升上来的）⇒ `_planPluginInstall` 只判"不相等"就安排安装 ⇒ **每次启动都降级重装
 *   8 个包**（`dsh plugin add` 一条命令装 8 个，实测跑满 4 分钟超时，然后逐项回退再失败）
 *   ⇒ 用户看到的就是长时间卡在启动占位。
 *   exe 比 profile 旧是**正常状态**（用户先用新 dev、再跑旧安装包），绝不该把已装的新版本回退 ✗。
 *
 * 口径：只做"数字段逐段比较"（本仓版本恒为 `x.y.z` 或带 `-prerelease`）：
 *   · 主次修订号：逐段数字比较，缺失段按 0；
 *   · 主次修订全等时：**没有 prerelease 的更大**（`1.0.0` > `1.0.0-rc.1`）；
 *     两边都有 prerelease ⇒ 字符串比较（够用，且不会把 `rc.2` 判成比 `rc.1` 旧）。
 * 读不懂的版本（含字母/格式异常）⇒ 返回 false（**保守：不据此跳过安装**，宁可多装一次也别漏装）。
 */
export function isVersionNewer(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b || a === b) {
		return false;
	}
	const parse = (v: string) => {
		const [core, pre] = v.split('-', 2);
		const nums = core.split('.');
		if (!nums.length || nums.some(n => !/^\d+$/.test(n))) {
			return undefined;
		}
		return { nums: nums.map(n => Number(n)), pre };
	};
	const pa = parse(a);
	const pb = parse(b);
	if (!pa || !pb) {
		return false;
	}
	const len = Math.max(pa.nums.length, pb.nums.length);
	for (let i = 0; i < len; i++) {
		const x = pa.nums[i] ?? 0;
		const y = pb.nums[i] ?? 0;
		if (x !== y) {
			return x > y;
		}
	}
	if (pa.pre === pb.pre) {
		return false;
	}
	if (!pa.pre) {
		return true;    // 正式版 > 预发布
	}
	if (!pb.pre) {
		return false;
	}
	return pa.pre > pb.pre;
}

/**
 * 生成整段提示文本（自检用；宿主负责写日志）。
 *
 * @param audit `auditBundledPluginVersions` 的结果。
 * @returns 整段文本；没有错配时返回空串。
 */
export function renderBundledVersionAudit(audit: IBundledVersionAudit): string {
	const hasMismatch = !!audit?.lines?.length;
	const newer = audit?.newer ?? [];
	if (!hasMismatch && !newer.length) {
		return '';
	}
	const out: string[] = [];
	if (hasMismatch) {
		out.push(`⚠ profile 与随包插件版本不一致（${audit.lines.length} 项）—— 若报 "agent-preset/invalid … never started" 或新建会话失败，先看这里：`);
		out.push(...audit.lines.map(line => `  · ${line}`));
	}
	if (newer.length) {
		// ★ 2026-10-28：这一类**不是**错配，单独一句话说清（否则会把人引去查"版本没装齐"，方向全错）。
		out.push(`（另有 ${newer.length} 项已装比随包**新** ⇒ 保留已装版本、不降级：${newer.map(e => `${e.name} ${e.installed} > ${e.bundled}`).join('；')}）`);
	}
	return out.join('\n');
}
