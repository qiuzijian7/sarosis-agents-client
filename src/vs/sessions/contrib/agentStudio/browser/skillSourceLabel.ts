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
		case 'user': return '📁 用户技能';
		case 'marketplace': return '☁️ 商城技能';
		case 'extension': return '🔌 扩展技能';
		case 'memory': return '🧠 内存技能';
		case 'workflow': return '⚙️ 工作流技能';
	}
}
