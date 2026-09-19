/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  obsidianNoteFormat.ts — 知识库笔记格式约定的「单一真源」。
 *
 *  背景：笔记格式规则曾同时写在 kbImportController 的 Stage2 提示词与内置技能
 *  obsidian-markdown（resources/.agents/skills/obsidian-skills/obsidian-markdown/SKILL.md）
 *  两处，容易漂移。约定如下：
 *   - 本文件 = 「本项目 KB 笔记」格式约定的唯一真源（frontmatter 字段、双链口径、callout）；
 *   - obsidian-markdown SKILL.md = 通用 Obsidian 语法参考（聊天场景按需激活），
 *     其中与本项目约定相关的部分以本文件为准（SKILL.md 头部有同步指针注释）。
 *  修改格式约定时：改这里 → Stage2 提示词自动生效；再按需同步 SKILL.md 注释。
 *--------------------------------------------------------------------------------------------*/

/**
 * 知识库笔记格式规则（注入 Stage2 系统提示词）。
 * 自带结尾换行，可直接拼接到提示词段落之间。
 */
export const KB_NOTE_FORMAT_RULES: string = [
	'',
	'格式约定（必须遵守）：',
	'1. 每个文件以 YAML frontmatter 开头，字段：type（schema 类型 id）、title（笔记标题——双链与关系图谱以它为节点名，须简洁唯一）、created（YYYY-MM-DD）；可选 tags（字符串数组）。',
	'2. 不要手写 sources / status 字段：sources 由管线自动注入，status 由去抽象化门控自动管理。',
	'3. 在相关笔记正文里，用 [[其他笔记的 title]] 语法引用本批次及库中相关笔记，建立双链（关系图谱依赖这些链接）；需要自定义显示文本时用 [[title|显示文本]]；仅引用确定存在的笔记标题，不要编造。',
	'4. 正文用标准 Markdown 组织（标题/列表/表格/代码块）；需要强调的信息可用 callout 语法（> [!note] / > [!tip] / > [!warning]）。',
	'',
].join('\n');
