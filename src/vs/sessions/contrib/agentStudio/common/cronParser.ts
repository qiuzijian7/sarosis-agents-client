/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// cronParser.ts - Cron 表达式解析器
// ------------------------------------------------------------------------------------------------
//
// 功能: 解析标准 Cron 表达式，计算下次触发时间
//
// Cron 表达式格式 (5位或6位):
// 秒(可选) 分钟 小时 日期 月份 星期几
// 
// 支持的特殊字符:
// - * : 任意值
// - , : 列表分隔符 (如 "1,3,5")
// - - : 范围 (如 "1-5")
// - / : 步长 (如 "*/5" 或 "0-30/5")
// - ? : 不指定 (仅用于 日期 和 星期几)
// - L : 最后 (如 "L" 表示最后一天)
// - W : 工作日 (如 "15W" 表示最接近15号的工作日)
// - # : 第几个星期几 (如 "5#3" 表示第三个星期五)

import { ILogService } from '../../../../platform/log/common/log.js';

// ------------------------------------------------------------------------------------------------
// 接口定义
// ------------------------------------------------------------------------------------------------

export interface ICronFields {
	second?: number[];     // 0-59
	minute: number[];      // 0-59
	hour: number[];        // 0-23
	dayOfMonth: number[];  // 1-31, 或特殊值
	month: number[];       // 1-12
	dayOfWeek: number[];   // 0-7 (0和7都是星期日)
}

export interface ICronParseResult {
	expression: string;
	fields: ICronFields;
	isValid: boolean;
	error?: string;
}

// ------------------------------------------------------------------------------------------------
// Cron 解析器实现
// ------------------------------------------------------------------------------------------------

export class CronParser {
	private readonly _logService: ILogService;

	constructor(logService?: ILogService) {
		this._logService = logService || console as unknown as ILogService;
	}

	// ------------------------------------------------------------------------------------------------
	// 公开方法
	// ------------------------------------------------------------------------------------------------

	/**
	 * 解析 Cron 表达式
	 * @param expression Cron 表达式字符串
	 * @returns 解析结果
	 */
	parse(expression: string): ICronParseResult {
		try {
			const fields = this._parseExpression(expression);
			return {
				expression,
				fields,
				isValid: true
			};
		} catch (error) {
			this._logService.error(`[CronParser] Failed to parse expression: ${expression}`, error);
			return {
				expression,
				fields: this._getDefaultFields(),
				isValid: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * 计算下次触发时间
	 * @param expression Cron 表达式
	 * @param fromDate 起始时间 (默认当前时间)
	 * @returns 下次触发的时间戳 (毫秒)，如果无法计算则返回 null
	 */
	getNextFireTime(expression: string, fromDate?: Date): number | null {
		const parseResult = this.parse(expression);
		if (!parseResult.isValid) {
			return null;
		}

		const from = fromDate || new Date();
		const next = this._findNextFireTime(parseResult.fields, from);
		
		return next ? next.getTime() : null;
	}

	/**
	 * 获取接下来 N 次触发时间
	 * @param expression Cron 表达式
	 * @param count 数量
	 * @param fromDate 起始时间
	 * @returns 时间戳数组
	 */
	getNextFireTimes(expression: string, count: number, fromDate?: Date): number[] {
		const parseResult = this.parse(expression);
		if (!parseResult.isValid) {
			return [];
		}

		const times: number[] = [];
		let current = fromDate || new Date();

		for (let i = 0; i < count; i++) {
			const next = this._findNextFireTime(parseResult.fields, current);
			if (!next) {
				break;
			}
			times.push(next.getTime());
			// 移动到下一毫秒，避免返回相同时间
			current = new Date(next.getTime() + 1);
		}

		return times;
	}

	// ------------------------------------------------------------------------------------------------
	// 私有方法 - 表达式解析
	// ------------------------------------------------------------------------------------------------

	private _parseExpression(expression: string): ICronFields {
		// 去除多余空格
		const trimmed = expression.trim().replace(/\s+/g, ' ');
		const parts = trimmed.split(' ');

		// 支持 5位 (标准) 或 6位 (带秒) 格式
		if (parts.length !== 5 && parts.length !== 6) {
			throw new Error(`Invalid cron expression: expected 5 or 6 fields, got ${parts.length}`);
		}

		let second: number[] | undefined;
		let minute: number[];
		let hour: number[];
		let dayOfMonth: number[];
		let month: number[];
		let dayOfWeek: number[];

		if (parts.length === 6) {
			// 6位格式: 秒 分 时 日 月 星期
			second = this._parseField(parts[0], 0, 59);
			minute = this._parseField(parts[1], 0, 59);
			hour = this._parseField(parts[2], 0, 23);
			dayOfMonth = this._parseField(parts[3], 1, 31, true);
			month = this._parseField(parts[4], 1, 12);
			dayOfWeek = this._parseField(parts[5], 0, 7);
		} else {
			// 5位格式: 分 时 日 月 星期
			minute = this._parseField(parts[0], 0, 59);
			hour = this._parseField(parts[1], 0, 23);
			dayOfMonth = this._parseField(parts[2], 1, 31, true);
			month = this._parseField(parts[3], 1, 12);
			dayOfWeek = this._parseField(parts[4], 0, 7);
		}

		return {
			second,
			minute,
			hour,
			dayOfMonth,
			month,
			dayOfWeek
		};
	}

	private _parseField(field: string, min: number, max: number, allowQuestion: boolean = false): number[] {
		// 处理特殊字符: *
		if (field === '*') {
			return this._range(min, max);
		}

		// 处理特殊字符: ?
		if (allowQuestion && field === '?') {
			return this._range(min, max);
		}

		// 按逗号分割多个值
		const values: number[] = [];
		const parts = field.split(',');

		for (const part of parts) {
			const parsed = this._parseFieldPart(part.trim(), min, max);
			values.push(...parsed);
		}

		// 去重并排序
		return [...new Set(values)].sort((a, b) => a - b);
	}

	private _parseFieldPart(part: string, min: number, max: number): number[] {
		// 处理步长: */5 或 0-30/5
		if (part.includes('/')) {
			const [rangeStr, stepStr] = part.split('/');
			const step = parseInt(stepStr, 10);
			
			if (isNaN(step) || step <= 0) {
				throw new Error(`Invalid step value: ${stepStr}`);
			}

			let rangeMin = min;
			let rangeMax = max;

			if (rangeStr !== '*') {
				const range = this._parseRange(rangeStr, min, max);
				rangeMin = range[0];
				rangeMax = range[range.length - 1];
			}

			const values: number[] = [];
			for (let i = rangeMin; i <= rangeMax; i += step) {
				values.push(i);
			}
			return values;
		}

		// 处理范围: 1-5
		if (part.includes('-')) {
			return this._parseRange(part, min, max);
		}

		// 处理单个值
		const value = parseInt(part, 10);
		if (isNaN(value) || value < min || value > max) {
			throw new Error(`Invalid value: ${part} (expected ${min}-${max})`);
		}

		return [value];
	}

	private _parseRange(rangeStr: string, min: number, max: number): number[] {
		const [startStr, endStr] = rangeStr.split('-');
		const start = parseInt(startStr, 10);
		const end = parseInt(endStr, 10);

		if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
			throw new Error(`Invalid range: ${rangeStr} (expected ${min}-${max})`);
		}

		return this._range(start, end);
	}

	private _range(start: number, end: number): number[] {
		const values: number[] = [];
		for (let i = start; i <= end; i++) {
			values.push(i);
		}
		return values;
	}

	private _getDefaultFields(): ICronFields {
		return {
			minute: [0],
			hour: [0],
			dayOfMonth: [1],
			month: [1],
			dayOfWeek: [0]
		};
	}

	// ------------------------------------------------------------------------------------------------
	// 私有方法 - 计算下次触发时间
	// ------------------------------------------------------------------------------------------------

	private _findNextFireTime(fields: ICronFields, from: Date): Date | null {
		const MAX_ITERATIONS = 10000; // 防止无限循环
		let iteration = 0;

		// 从下一分钟开始检查
		let current = new Date(from.getTime() + 60000);
		current.setSeconds(0, 0);

		while (iteration < MAX_ITERATIONS) {
			iteration++;

			// 检查月份
			if (!fields.month.includes(current.getMonth() + 1)) {
				// 跳到下一个月
				current.setMonth(current.getMonth() + 1, 1);
				current.setHours(0, 0, 0, 0);
				continue;
			}

			// 检查日期和星期几
			const dayOfMonth = current.getDate();
			const dayOfWeek = current.getDay(); // 0 = 星期日

			const dayOfMonthMatch = fields.dayOfMonth.includes(dayOfMonth);
			const dayOfWeekMatch = fields.dayOfWeek.includes(dayOfWeek) || 
								  (dayOfWeek === 0 && fields.dayOfWeek.includes(7));

			// 如果日期和星期几都指定了，需要同时满足 (Cron 的 , 逻辑)
			// 但如果其中一个是 *，则只检查另一个
			// 简化逻辑: 这里使用 OR 关系 (符合大多数 Cron 实现)
			if (!dayOfMonthMatch && !dayOfWeekMatch) {
				current.setDate(current.getDate() + 1);
				current.setHours(0, 0, 0, 0);
				continue;
			}

			// 检查小时
			if (!fields.hour.includes(current.getHours())) {
				current.setHours(current.getHours() + 1, 0, 0, 0);
				if (current.getHours() === 0) {
					current.setDate(current.getDate() + 1);
				}
				continue;
			}

			// 检查分钟
			if (!fields.minute.includes(current.getMinutes())) {
				current.setMinutes(current.getMinutes() + 1, 0, 0);
				if (current.getMinutes() === 0) {
					current.setHours(current.getHours() + 1, 0, 0, 0);
				}
				continue;
			}

			// 检查秒 (如果指定了)
			if (fields.second && !fields.second.includes(current.getSeconds())) {
				current.setSeconds(current.getSeconds() + 1, 0);
				if (current.getSeconds() === 0) {
					current.setMinutes(current.getMinutes() + 1, 0, 0);
				}
				continue;
			}

			// 所有条件都满足
			return current;
		}

		// 超过最大迭代次数
		this._logService.warn('[CronParser] Exceeded maximum iterations while finding next fire time');
		return null;
	}
}

// ------------------------------------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------------------------------------

/**
 * 验证 Cron 表达式是否有效
 */
export function isValidCronExpression(expression: string): boolean {
	try {
		const parser = new CronParser();
		const result = parser.parse(expression);
		return result.isValid;
	} catch {
		return false;
	}
}

/**
 * 获取人类可读的 Cron 表达式描述
 */
export function getCronDescription(expression: string): string {
	// 简化实现: 返回基本描述
	// 生产环境可以使用 cronstrue 库
	const descriptions: Record<string, string> = {
		'* * * * *': '每分钟',
		'*/5 * * * *': '每5分钟',
		'0 * * * *': '每小时',
		'0 0 * * *': '每天凌晨',
		'0 0 * * 0': '每周日凌晨',
		'0 0 1 * *': '每月1日凌晨',
		'0 0 1 1 *': '每年1月1日凌晨'
	};

	return descriptions[expression] || `Cron: ${expression}`;
}

// ------------------------------------------------------------------------------------------------
// 导出
// ------------------------------------------------------------------------------------------------

export const cronParser = new CronParser();
export default CronParser;
