/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
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
 *   2. 用户全局目录   `~/.vssaros/skills/<id>/SKILL.md`
 *   3. 由扩展通过 `IAgentOSService` 运行时 register 的内存 skill
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
	/** 来源标记，用于 UI 区分内置 / 用户 / 商城 / 扩展 / 内存 / 工作流（作为可执行技能） */
	readonly source: 'builtin' | 'user' | 'marketplace' | 'extension' | 'memory' | 'workflow';
	/** Skill 文件 URI（可选，用于「在编辑器中打开」） */
	readonly resource?: URI;
	/**
	 * 内容指纹 —— 基于 skill 正文（prompt）的哈希值。
	 * 用于跨目录去重：相同 name 且相同 contentHash 的技能视为完全重复，仅保留高优先级来源。
	 * 相同 name 但不同 contentHash 的技能视为不同版本，在 UI 中均保留并标注来源。
	 */
	readonly contentHash?: string;
	/** 是否启用该 skill（可通过 UI 开关控制） */
	enabled: boolean;
	/** 技能版本号（语义化版本，如 "1.0.0"） */
	version?: string;
	/** 技能商店中的 ID（用于检查更新） */
	storeId?: string;
	/** 更新检查 URL */
	updateUrl?: string;
	/**
	 * 适用平台列表（Hermes-Agent 兼容）。
	 * 例如 `['linux', 'macos', 'windows']`，用于跨平台可见性过滤。
	 */
	readonly platforms?: readonly string[];
	/**
	 * 分类标签列表（Hermes-Agent 兼容）。
	 * 例如 `['planning', 'code-review', 'workflow']`，用于标签筛选与搜索。
	 */
	readonly tags?: readonly string[];
	/**
	 * 关联技能 ID 列表（Hermes-Agent 兼容）。
	 * 例如 `['subagent-driven-development', 'test-driven-development']`，
	 * 用于 UI 推荐关联技能。
	 */
	readonly relatedSkills?: readonly string[];
	/** 技能作者（Hermes-Agent 兼容） */
	readonly author?: string;
	/** 技能许可证（Hermes-Agent 兼容） */
	readonly license?: string;
	/**
	 * 技能支持目录（references/scripts/assets/templates/tests）中的文件清单，
	 * 为相对技能根目录的路径（如 "references/api.md"、"scripts/run.py"）。
	 * 对齐 Agent Skills 规范的渐进披露：扫描时索引，模型经 read_skill(path=...) 按需读取。
	 */
	readonly supportFiles?: readonly string[];
	/**
	 * 技能声明的工具面白名单（Agent Skills 规范 `allowed-tools`）。
	 * 当前为 prompt 级约束：激活时在注入内容中声明限制；
	 * 同时透传为元数据，供后续硬裁剪工具面使用。
	 */
	readonly allowedTools?: readonly string[];
	/** 技能声明的偏好模型（Agent Skills 规范扩展，元数据透传） */
	readonly model?: string;
	/**
	 * 当 source === 'workflow' 时指向底层的 IStoredWorkflow.id。
	 * 用于「工作流作为可执行技能」双向打通：触发该 skill 即执行对应工作流。
	 */
	workflowId?: string;
	/**
	 * 可执行型技能的执行器描述。存在时表示触发该 skill 不是注入 prompt 文本，
	 * 而是由执行引擎运行对应执行器（目前仅支持 workflow 类型）。
	 * 文本型技能（prompt 注入）此字段为空。
	 */
	executor?: ISkillExecutor;
}

/**
 * 可执行型技能的执行器描述。
 * 目前仅支持 workflow：触发 skill 即运行 `IWorkflowExecutionService.executeWorkflow(workflowId)`。
 */
export interface ISkillExecutor {
	readonly kind: 'workflow';
	readonly workflowId: string;
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
	/** Agent 配置中指定的技能 ID 列表 —— 强制加载，不依赖 activation 模式或关键词匹配 */
	readonly required?: readonly string[];
}

/**
 * 一次 turn 中将要注入到 messages 的 skill 包。
 */
export interface ISkillInjection {
	readonly skill: ISkillDefinition;
	/** 注入位置：统一为 'user'——作为独立 user message 注入（Phase 1 渐进披露，不再内联 system prompt；required/always 也走此路径以确保生效）。 */
	readonly placement: 'system' | 'user';
	readonly content: string;
	/**
	 * 若该 skill 为可执行型（skill.executor 存在），此处回传执行器描述。
	 * ExecutionProvider 应据其触发执行而非注入 content 文本。
	 */
	readonly executor?: ISkillExecutor;
}

export const ISkillRegistry = createDecorator<ISkillRegistry>('skillRegistry');

export interface ISkillRegistry {
	readonly _serviceBrand: undefined;

	readonly onDidChangeSkills: Event<void>;

	/** 等待初始加载完成（技能目录扫描结束）。 */
	whenReady(): Promise<void>;

	/** 同步获取已加载的全部 skill。 */
	getSkills(): readonly ISkillDefinition[];

	/** 按 id 取单个 skill。 */
	getSkill(id: string): ISkillDefinition | undefined;

	/**
	 * 读取技能支持目录（references/scripts/assets/templates）中的文件内容。
	 * 路径安全：仅允许支持目录内的相对路径，拒绝 `..` 遍历。
	 * @param skillId 技能 id
	 * @param relativePath 相对技能根目录的路径（如 "references/api.md"）
	 */
	readSkillSupportFile(skillId: string, relativePath: string): Promise<string>;

	/** 注册一个内存中的 skill（典型用途：扩展提供）。 */
	registerSkill(skill: ISkillDefinition): IDisposable;

	/**
	 * 选出一次 turn 应该注入的 skill 集合：
	 * - context.required 中列出的 skill（强制加载，最高优先级）
	 * - 所有 `always` 类型
	 * - 所有命中 `match` 关键词的 `auto` 类型
	 * - context.explicit 中列出的 `manual` / `auto` 类型
	 * - 仅包含 enabled === true 的 skill
	 */
	resolveActivations(context: ISkillActivationContext): Promise<readonly ISkillInjection[]>;

	/** 启用指定 skill */
	enableSkill(id: string): void;

	/** 禁用指定 skill */
	disableSkill(id: string): void;

	/** 触发一次重扫（用户安装/卸载 skill 后或文件改动）。 */
	reload(): Promise<void>;
}
