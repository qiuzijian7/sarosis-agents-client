/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 系统类型定义。
 *
 * 设计参考：Hermes-Agent 的 `agent/skill_commands.py` + `skills/` 目录。
 *
 * 关键差异：
 * - Hermes 使用 Python AST + 文件扫描；这里使用 IFileService 异步扫描，仅支持 .md。
 * - Hermes 把激活后的 skill 作为「user message」注入以保留 prompt cache；
 *   这里同样以 user-message 形式提供给 ExecutionProvider，让上层决定何时
 *   合并到对话中（典型路径：`/skill <name>` 或被 PlanningProvider 自动选用）。
 *
 * Skill 来源（按优先级合并，重名后注册的覆盖前者）：
 *   1. 内置目录   `extensions/.../skills/*` （随产品发布）
 *   2. 全局目录   `~/.sarosis/skills/<id>/SKILL.md`
 *   3. 工作区目录 `<workspace>/.sarosis/skills/<id>/SKILL.md`
 *   4. 由扩展通过 `IAgentOSService` 运行时 register 的内存 skill
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * Skill 触发模式：
 * - `manual`：仅在用户显式 `/skill <id>` 时激活。
 * - `auto`：当用户消息匹配 `match` 关键词时由 PlanningProvider 自动激活。
 * - `always`：每次 turn 都注入（轻量「行为指南」型 skill）。
 */
export type SkillActivation = 'manual' | 'auto' | 'always';

/**
 * 单个 Skill 定义。`prompt` 是要注入对话的实际正文（去除 frontmatter）。
 */
export interface ISkillDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly activation: SkillActivation;
	/** auto 模式下的关键词（小写比较） */
	readonly match?: readonly string[];
	/** Skill 显示分类，例如 "code", "review", "docs" */
	readonly category?: string;
	/** 该 skill 期望使用的 tool 名集合（仅作元数据，不强制裁剪） */
	readonly recommendedTools?: readonly string[];
	/** 注入到对话中的正文（已去除 frontmatter） */
	readonly prompt: string;
	/** 来源标记，用于 UI 区分内置 / 用户 / 工作区 / 扩展 */
	readonly source: 'builtin' | 'user' | 'workspace' | 'extension' | 'memory';
	/** Skill 文件 URI（可选，用于「在编辑器中打开」） */
	readonly resource?: URI;
}

/**
 * Skill 激活上下文 —— 由 ExecutionProvider 在 turn 开始时调用。
 */
export interface ISkillActivationContext {
	readonly userMessage: string;
	readonly agentId: string;
	readonly sessionId?: string;
	/** 用户已显式选中的 skill id 列表（来自 `/skill` 命令） */
	readonly explicit?: readonly string[];
}

/**
 * 一次 turn 中将要注入到 messages 的 skill 包。
 */
export interface ISkillInjection {
	readonly skill: ISkillDefinition;
	/** 注入位置：'system' 合入 system prompt；'user' 作为独立 user message（推荐）。 */
	readonly placement: 'system' | 'user';
	readonly content: string;
}

export const ISkillRegistry = createDecorator<ISkillRegistry>('skillRegistry');

export interface ISkillRegistry {
	readonly _serviceBrand: undefined;

	readonly onDidChangeSkills: Event<void>;

	/** 同步获取已加载的全部 skill。 */
	getSkills(): readonly ISkillDefinition[];

	/** 按 id 取单个 skill。 */
	getSkill(id: string): ISkillDefinition | undefined;

	/** 注册一个内存中的 skill（典型用途：扩展提供）。 */
	registerSkill(skill: ISkillDefinition): IDisposable;

	/**
	 * 选出一次 turn 应该注入的 skill 集合：
	 * - 所有 `always` 类型
	 * - 所有命中 `match` 关键词的 `auto` 类型
	 * - context.explicit 中列出的 `manual` / `auto` 类型
	 */
	resolveActivations(context: ISkillActivationContext): readonly ISkillInjection[];

	/** 触发一次重扫（用户安装/卸载 skill 后或文件改动）。 */
	reload(): Promise<void>;
}
