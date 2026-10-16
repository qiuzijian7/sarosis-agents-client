/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 生态用户级技能目录清单（SKILL.md 规范）—— **一处定义、两侧共用**。
 *
 * ★ 2026-10-12（用户决定）：**清单为空 ⇒ 两侧都不再扫描生态目录** ✓。本文件保留下来，是为了
 *   ① 让"两处消费点同源"这条机制还在（IDE `skillRegistryService._doReload()` ↔ Host
 *      `dshHarnessService._skillDirs()` 都调这里 ✓）；② 重新启用只需往下面数组里加回一行 ✓。
 *
 * 为什么停扫（原设计是"把 `~/.agents/skills` / `~/.copilot/skills` / `~/.claude/skills`
 * 也扫进来 ⇒ 用户为其它工具写的技能零改动可用"）：
 *   · 生态目录与**自营/内置**技能同属 `source: 'user'`（同 rank）⇒ 撞 id 时是 first-wins，
 *     并**逐 id 打一条 WARN**（`skillRegistryService._setSkillWithPriority`）✗ —— 本机实测
 *     `~/.agents/skills(31)` 与 `~/.claude/skills(35)` 有 **31 个同名、且 SKILL.md 逐字节相同**
 *     ⇒ 每次 reload 刷 31 行**无信息量**的告警 ✗。
 *   · 那 31 个（lark-* 全家桶 / agent-reach / web-access / feishu-doc …）与**内置 150 个零重叠**、
 *     也不在 `~/.vssaros/skills` ⇒ **停扫后它们会从 IDE 与 dsh 两侧一起消失** ✗。要让它们继续可用，
 *     把技能放进 `~/.vssaros/skills`（或内置库）即可 ✓ —— 这是本决定的**已知代价**，不是意外 ✓。
 *
 * ⚠ 仍然**不扫工作区**级目录（`.agents/skills` / `.github/skills` / `.claude/skills`）：工作区目录
 * 可被 clone 注入（提示词注入面），要扫必须先过一次 Workspace Trust 判定 ✓。
 *
 * 两个消费点**必须用同一份清单**，否则会出现"IDE 看得见、dsh Host 看不见"这类最难查的不一致 ✗：
 *   · IDE 侧（技能库）：`browser/skillRegistryService.ts` 的 `_doReload()` ⇒ `ecosystemUserSkillDirUris`
 *   · Host 侧（`--patch` 覆盖层）：`dshHarness/electron-browser/dshHarnessService.ts` 的 `_skillDirs()`
 *     ⇒ `ecosystemUserSkillDirPaths`
 *
 * 守卫：`test/common/skillEcosystemDirs.test.ts` —— 现在钉的是"**必须为空**（刻意不扫）"＋
 * "两个消费点仍接线"；要重新启用必须先在该用例里显式登记，否则会红 ✓。
 */

import { URI } from '../../../../base/common/uri.js';
import { join } from '../../../../base/common/path.js';

/**
 * 相对用户主目录的生态技能目录（正斜杠分段）。
 *
 * ★ 2026-10-12：**刻意置空** ✗ —— 不再扫描 `~/.agents/skills` / `~/.copilot/skills` /
 * `~/.claude/skills`（原因与代价见文件头注释 ✓）。要重新启用：把目录加回来，
 * 并同步 `test/common/skillEcosystemDirs.test.ts` 的第一条用例（它现在要求本数组为空 ✓）。
 */
export const ECOSYSTEM_USER_SKILL_DIRS: readonly string[] = [];

/**
 * URI 形态（IDE 侧走 `fileService` 用）。
 *
 * 只负责拼接：目录不存在是**正常情况**（绝大多数用户没有其它工具的目录），
 * 调用方必须按"不存在就跳过"处理，不要把缺失当错误报 ✗。
 */
export function ecosystemUserSkillDirUris(userHome: URI): URI[] {
	return ECOSYSTEM_USER_SKILL_DIRS.map(rel => URI.joinPath(userHome, ...rel.split('/')));
}

/**
 * 本机路径形态（dsh Host 覆盖层用；`join` 是平台感知的 ⇒ Windows 出反斜杠，
 * 与 `resolveSarosPath(...).fsPath` 同形 ✓，而 `existsSync` 两种分隔符都认 ✓）。
 */
export function ecosystemUserSkillDirPaths(userHomeFsPath: string): string[] {
	return ECOSYSTEM_USER_SKILL_DIRS.map(rel => join(userHomeFsPath, ...rel.split('/')));
}
