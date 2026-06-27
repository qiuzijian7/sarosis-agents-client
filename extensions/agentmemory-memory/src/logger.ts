/*---------------------------------------------------------------------------------------------
 *  统一日志 — 集中化日志系统。
 *  1:1 复刻 agentmemory src/logger.ts
 *
 *  支持日志级别 + 分模块 + 缓冲 + 过滤。
 *--------------------------------------------------------------------------------------------*/

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
	timestamp: number;
	level: LogLevel;
	module: string;
	message: string;
	data?: Record<string, unknown>;
}

export interface LoggerConfig {
	minLevel: LogLevel;
	enableConsole: boolean;
	maxBuffer: number;
	modules?: Set<string>;  // 如果设置，只记录这些模块的日志
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0, info: 1, warn: 2, error: 3, fatal: 4,
};

const DEFAULT_CONFIG: LoggerConfig = {
	minLevel: 'info',
	enableConsole: true,
	maxBuffer: 500,
};

export class Logger {
	private _config: LoggerConfig;
	private _buffer: LogEntry[] = [];
	private _stats = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };

	constructor(config?: Partial<LoggerConfig>) {
		this._config = { ...DEFAULT_CONFIG, ...config };
	}

	private _shouldLog(level: LogLevel, module: string): boolean {
		if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this._config.minLevel]) return false;
		if (this._config.modules && this._config.modules.size > 0 && !this._config.modules.has(module)) return false;
		return true;
	}

	private _log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
		if (!this._shouldLog(level, module)) return;

		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			module,
			message,
			data,
		};

		this._buffer.push(entry);
		if (this._buffer.length > this._config.maxBuffer) {
			this._buffer.shift();
		}

		this._stats[level]++;

		if (this._config.enableConsole) {
			const prefix = `[${module}]`;
			const dataStr = data ? ' ' + JSON.stringify(data) : '';
			switch (level) {
				case 'debug': console.debug(prefix, message, dataStr); break;
				case 'info': console.info(prefix, message, dataStr); break;
				case 'warn': console.warn(prefix, message, dataStr); break;
				case 'error': console.error(prefix, message, dataStr); break;
				case 'fatal': console.error(prefix, 'FATAL:', message, dataStr); break;
			}
		}
	}

	debug(module: string, message: string, data?: Record<string, unknown>): void { this._log('debug', module, message, data); }
	info(module: string, message: string, data?: Record<string, unknown>): void { this._log('info', module, message, data); }
	warn(module: string, message: string, data?: Record<string, unknown>): void { this._log('warn', module, message, data); }
	error(module: string, message: string, data?: Record<string, unknown>): void { this._log('error', module, message, data); }
	fatal(module: string, message: string, data?: Record<string, unknown>): void { this._log('fatal', module, message, data); }

	/**
	 * 获取日志缓冲
	 */
	getBuffer(filter?: { level?: LogLevel; module?: string; limit?: number }): LogEntry[] {
		let entries = [...this._buffer];
		if (filter?.level) {
			entries = entries.filter(e => LEVEL_PRIORITY[e.level] >= LEVEL_PRIORITY[filter.level!]);
		}
		if (filter?.module) {
			entries = entries.filter(e => e.module === filter.module);
		}
		const limit = filter?.limit ?? 100;
		return entries.slice(-limit).reverse();
	}

	/**
	 * 获取统计
	 */
	getStats(): Record<LogLevel, number> & { total: number } {
		const total = Object.values(this._stats).reduce((s, v) => s + v, 0);
		return { ...this._stats, total };
	}

	/**
	 * 更新配置
	 */
	updateConfig(config: Partial<LoggerConfig>): void {
		this._config = { ...this._config, ...config };
	}

	/**
	 * 清除缓冲
	 */
	clear(): void {
		this._buffer = [];
		this._stats = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
	}
}

export const logger = new Logger();
