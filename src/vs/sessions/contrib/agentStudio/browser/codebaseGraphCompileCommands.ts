/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * compile_commands.json Parser — C/C++ 编译命令解析。
 *
 * 对标 codebase-memory-mcp 的 pass_compile_commands.c (12KB C)。
 *
 * 功能：
 * 1. 解析 compile_commands.json（Clang compilation database）
 * 2. 提取每个源文件的 include 路径
 * 3. 用于 C/C++ 精确头文件解析（替代 #include 模糊匹配）
 *
 * 格式示例：
 * [
 *   {
 *     "directory": "/project/build",
 *     "command": "clang++ -I/usr/include -I./src -c src/main.cpp -o main.o",
 *     "file": "src/main.cpp"
 *   }
 * ]
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export interface CompileCommand {
	directory: string;
	file: string;
	command: string;
	includes: string[];     // parsed -I paths
	defines: string[];      // parsed -D macros
}

export class CompileCommandsParser {
	constructor(private _fileService: IFileService) {}

	/** Parse compile_commands.json from a build directory */
	async parse(rootPath: string): Promise<Map<string, CompileCommand>> {
		const result = new Map<string, CompileCommand>();

		// Try common locations
		const candidates = [
			URI.joinPath(URI.file(rootPath), 'compile_commands.json'),
			URI.joinPath(URI.file(rootPath), 'build', 'compile_commands.json'),
			URI.joinPath(URI.file(rootPath), '.vscode', 'compile_commands.json'),
		];

		let content: string | undefined;
		for (const uri of candidates) {
			try {
				const fileContent = await this._fileService.readFile(uri);
				content = fileContent.value.toString();
				break;
			} catch { /* try next */ }
		}

		if (!content) { return result; }

		try {
			const commands = JSON.parse(content) as any[];
			for (const cmd of commands) {
				const file = cmd.file as string;
				const directory = cmd.directory as string;
				const command = (cmd.command as string) || (cmd.arguments as string[])?.join(' ') || '';

				// Parse -I and -D flags from command
				const { includes, defines } = this._parseFlags(command, directory);

				result.set(file, {
					directory,
					file,
					command,
					includes,
					defines,
				});
			}
		} catch { /* invalid JSON */ }

		return result;
	}

	/** Parse -I (include) and -D (define) flags from a compile command */
	private _parseFlags(command: string, baseDir: string): { includes: string[]; defines: string[] } {
		const includes: string[] = [];
		const defines: string[] = [];

		// Match -I/path, -I path, -isystem/path, -isystem path
		const includeRegex = /(?:-I|-isystem)\s*([^\s]+)/g;
		let match;
		while ((match = includeRegex.exec(command)) !== null) {
			let path = match[1].trim().replace(/^["']|["']$/g, '');
			// Resolve relative to build directory
			if (!path.startsWith('/') && !path.match(/^[A-Z]:/i)) {
				path = `${baseDir}/${path}`;
			}
			includes.push(path);
		}

		// Match -Dmacro=value or -Dmacro
		const defineRegex = /-D\s*([^\s]+)/g;
		while ((match = defineRegex.exec(command)) !== null) {
			defines.push(match[1].replace(/^["']|["']$/g, ''));
		}

		return { includes, defines };
	}

	/** Resolve an #include path using compile commands */
	resolveInclude(includePath: string, fromFile: string, commands: Map<string, CompileCommand>): string | undefined {
		// Find compile command for the source file
		const cmd = commands.get(fromFile);
		if (!cmd) { return undefined; }

		// Try each include path
		for (const includeDir of cmd.includes) {
			const candidate = `${includeDir}/${includePath}`;
			// In a real implementation, we'd check if the file exists
			// For now, return the first candidate
			return candidate;
		}

		return undefined;
	}
}
