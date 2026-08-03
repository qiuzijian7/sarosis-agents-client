/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * execute_code 命令护栏与脚本路径提取的纯逻辑（无 VS Code 依赖，可独立单测）。
 *
 * 从 compatibilityTools.ts 抽出（对齐 pathFilterNormalize.ts / webSearchParse.ts 模式）。
 *
 * 背景（日志 1785744765714 子代理工具失败分析）：
 *  - exit 255：模型在 Windows 上用 Unix `head` 管道 → cmd.exe 报 "不是内部或外部命令"
 *  - exit 2：模型用相对路径引用技能 CLI（如 scripts/anysearch_cli.py），但 cwd 是
 *    另一个 workspace（S1Game），技能 CLI 不在其中
 * 这两个 helper 在工具实现层解决——不改系统提示词、不针对个案硬编码。
 */

/** Unix-only 命令 → PowerShell 等价写法（用于护栏错误消息）。 */
export const UNIX_ONLY_COMMAND_HINTS: Record<string, string> = {
	head: 'Select-Object -First <N>',
	tail: 'Select-Object -Last <N>',
	grep: 'Select-String -Pattern <regex>',
	sed: "ForEach-Object { $_ -replace '<old>','<new>' }",
	awk: 'ForEach-Object with -split',
};

/**
 * Windows 护栏：检测命令段起始位置（行首 / `|` / `&&` / `;` 之后）的 Unix-only 命令。
 * cmd.exe 下 head/tail/grep/sed/awk 均不存在（exit 255 "不是内部或外部命令"）。
 * 命中即由调用方抛错并附 PowerShell 等价写法——模型看到可执行反馈后自行改写重发。
 */
export function detectUnixOnlyCommand(command: string): string | undefined {
	const m = /(?:^|[|;&]+)\s*(head|tail|grep|sed|awk)\b/im.exec(command);
	return m ? m[1].toLowerCase() : undefined;
}

/**
 * 从技能 supportFiles 中提取脚本文件的**绝对路径**（scripts/ 目录下的可执行脚本）。
 *
 * 用户拍板（2026-08-03）：技能 CLI 一律以绝对路径呈现给模型（技能注入/read_skill），
 * 模型直接用绝对路径调用，从根上避免相对路径 + cwd 解析问题（日志 1785744765714
 * 的 exit 2：子代理 cwd 是另一个 workspace，`scripts/anysearch_cli.py` 解析失败）。
 *
 * @param skillDir 技能根目录 fsPath
 * @param supportFiles 技能支持文件相对路径清单（如 "scripts/anysearch_cli.py"）
 */
export function skillScriptAbsolutePaths(skillDir: string, supportFiles: readonly string[]): string[] {
	const sep = skillDir.includes('\\') ? '\\' : '/';
	const out: string[] = [];
	for (const f of supportFiles) {
		const rel = f.replace(/\\/g, '/');
		if (!rel.startsWith('scripts/')) { continue; }
		if (!/\.(py|js|mjs|cjs|ps1|sh)$/i.test(rel)) { continue; }
		out.push(skillDir.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep));
	}
	return out;
}
