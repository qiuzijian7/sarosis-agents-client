/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具参数修复器
 * 参考 Hermes-Agent 的 _repair_tool_call_arguments() 实现
 * 自动修复常见的 JSON 格式错误
 */
export class ToolArgumentRepairer {
	/**
	 * 修复工具调用参数中的常见 JSON 错误
	 * @param toolName 工具名称（用于日志记录）
	 * @param argsJson 原始 JSON 字符串
	 * @returns 修复后的 JSON 字符串
	 */
	static repair(toolName: string, argsJson: string): string {
		if (!argsJson || argsJson.trim().length === 0) {
			return '{}';
		}

		// 1. 已经是合法 JSON，直接返回
		try {
			JSON.parse(argsJson);
			return argsJson;
		} catch {
			// 继续修复
		}

		let repaired = argsJson;

		try {
			// 2. 移除 trailing commas（尾随逗号）
			repaired = this._removeTrailingCommas(repaired);

			// 3. 修复 Python None 值
			repaired = this._fixPythonNone(repaired);

			// 4. 转义控制字符
			repaired = this._escapeControlCharacters(repaired);

			// 5. 修复单引号（转为双引号）
			repaired = this._fixSingleQuotes(repaired);

			// 6. 修复未引用的键名
			repaired = this._quoteUnquotedKeys(repaired);

			// 7. 尝试包装成对象（如果缺少大括号）
			repaired = this._wrapInObjectIfNeeded(repaired);

			// 8. 最终验证
			try {
				JSON.parse(repaired);
				console.log(`[ToolRepair] Successfully repaired arguments for ${toolName}`);
				return repaired;
			} catch (error) {
				console.warn(`[ToolRepair] Failed to repair arguments for ${toolName}, returning empty object`);
				return '{}';
			}
		} catch (error) {
			console.error(`[ToolRepair] Error repairing arguments for ${toolName}:`, error);
			return '{}';
		}
	}

	/**
	 * 移除尾随逗号
	 */
	private static _removeTrailingCommas(json: string): string {
		// 移除对象或数组末尾的逗号
		return json.replace(/,(\s*[}\]])/g, '$1');
	}

	/**
	 * 修复 Python None 值（转为 JSON null）
	 */
	private static _fixPythonNone(json: string): string {
		return json.replace(/\bNone\b/g, 'null');
	}

	/**
	 * 转义控制字符
	 */
	private static _escapeControlCharacters(json: string): string {
		return json.replace(/[\x00-\x1F]/g, (c) => {
			const hex = c.charCodeAt(0).toString(16).padStart(4, '0');
			return `\\u${hex}`;
		});
	}

	/**
	 * 修复单引号（转为双引号）
	 * 注意：这个方法很简单，可能会误伤字符串内容中的单引号
	 */
	private static _fixSingleQuotes(json: string): string {
		// 将单引号替换为双引号，但跳过转义的单引号
		let result = '';
		let inString = false;
		let stringChar = '';

		for (let i = 0; i < json.length; i++) {
			const char = json[i];
			const prevChar = i > 0 ? json[i - 1] : '';

			if (!inString && (char === '"' || char === "'")) {
				inString = true;
				stringChar = char;
				result += '"'; // 统一使用双引号
			} else if (inString && char === stringChar && prevChar !== '\\') {
				inString = false;
				result += '"'; // 统一使用双引号
			} else {
				result += char;
			}
		}

		return result;
	}

	/**
	 * 为未引用的键名添加引号
	 */
	private static _quoteUnquotedKeys(json: string): string {
		// 匹配未引用的键名（后面跟着冒号）
		return json.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
	}

	/**
	 * 如果缺少大括号，尝试包装成对象
	 */
	private static _wrapInObjectIfNeeded(json: string): string {
		const trimmed = json.trim();

		// 如果已经是对象或数组，直接返回
		if (
			(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
			(trimmed.startsWith('[') && trimmed.endsWith(']'))
		) {
			return trimmed;
		}

		// 尝试包装成对象
		return `{${trimmed}}`;
	}

	/**
	 * 验证并修复工具参数（完整流程）
	 */
	static validateAndRepair(
		toolName: string,
		args: Record<string, unknown> | string | undefined,
	): Record<string, unknown> {
		// 如果已经是对象，直接返回
		if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
			return args as Record<string, unknown>;
		}

		// 如果是字符串，尝试解析和修复
		if (typeof args === 'string') {
			const repaired = this.repair(toolName, args);
			try {
				return JSON.parse(repaired);
			} catch {
				return {};
			}
		}

		// 其他情况返回空对象
		return {};
	}
}
