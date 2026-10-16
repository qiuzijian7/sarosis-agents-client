/*---------------------------------------------------------------------------------------------
 *  Skill 来源 → UI 标签映射（可单测的纯函数）。
 *
 *  抽离自 resourceManagerEditorPane 的 _skillSourceLabel，独立成模块以避免在
 *  Node 下 import 整个 EditorPane（其模块顶层依赖 window）。用于「双向打通」
 *  新增的 'workflow' 来源分支，以及其它内置/用户/商城/扩展/内存来源。
 *--------------------------------------------------------------------------------------------*/
import type { ISkillDefinition } from '../common/skills.js';

/** 把 skill 来源枚举映射成 UI 展示标签。 */
export function skillSourceLabel(source: ISkillDefinition['source']): string {
	switch (source) {
		case 'builtin': return '📦 内置技能';
		// 插件自带技能（2026-10-13 P2）：来自 dsh 插件包里的 `skills/`（例如 `@tt-a1i/archify-dsh`）。
		// 必须与"内置"分开显示：所有者是**插件包**（只读、随插件升级），不是产品内置 ✗
		// ⚠ 图标刻意**不用** 🔌（那是 `extension` 用的）：两个来源在同一列表里挨着显示，
		//   同图标 + "扩展技能/插件技能"两个近义词 = 用户根本分不清 ✗ ⇒ 用 🧩
		case 'plugin': return '🧩 插件技能';
		// 项目级技能（2026-10-13 P1）：来自工作区里的 `.dsh/skills` / `.agents/skills`，
		// 与用户技能分开显示 —— 否则用户分不清"这个技能是我装的还是这个仓库自带的" ✗
		case 'project': return '🗂️ 项目技能';
		case 'user': return '📁 用户技能';
		case 'marketplace': return '☁️ 商城技能';
		case 'extension': return '🔌 扩展技能';
		case 'memory': return '🧠 内存技能';
		case 'workflow': return '⚙️ 工作流技能';
	}
}
