// I/O 层：数据根解析、loop 目录读取、ledger/state 的原子落盘。
//
// 数据根口径与 siblings（kanban / skills / mcp / workflow）**完全一致**：
// `config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`。
// 不一致的后果是最难发现的一类 bug（开发根下跑着生产根的数据），
// 所以这里不做任何"聪明"的兜底，只照抄同一条链。

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLedger, normalizeLedger, recoverOnStart } from './core/ledger.js';
import { normalizeLoop } from './core/spec.js';
import { foundation } from './foundationRef.js';

const LOOP_FILE = 'loop.json';
const LEDGER_FILE = 'ledger.json';
const STATE_FILE = 'state.json';

const text = value => (typeof value === 'string' ? value.trim() : '');

export function dataRootOf(config) {
	// 委托到 @vssaros/dsh-foundation（重构 1.3 起真源只有一份）：链是
	// `config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`，与 siblings 逐字同口径。
	// ⚠ 不要在这里再写一份解析 —— 两份实现的真实后果是"开发根下跑着生产根的数据"。
	return foundation().dataRootOf(config);
}

export const loopsDirOf = config => join(dataRootOf(config), 'loops');
export const loopDirOf = (config, name) => join(loopsDirOf(config), name);

/**
 * 原子写：tmp → rename。
 * 为什么必须原子：ledger 是崩溃恢复的唯一依据，半截 JSON 会让"去重历史"整份失效，
 * 而失效的表现是"同一个 bug 被再修一遍"——没有报错，只有重复劳动。
 *
 * 为什么不用 foundation 的 `atomicWriteFile`：它是 async（`await rename`），而账本要在
 * "标记 running → 立刻进入下一条 item"这个同步推进点落盘；同步版只有十来行，语义相同。
 */
export function writeJsonAtomic(path, value) {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
	try {
		renameSync(tmp, path);
	} catch (error) {
		// Windows 上目标被杀软/编辑器短暂占用时 rename 会失败：退化成"先删再改名"。
		// 这一步不是原子的，但比整份写失败好（下一次状态变化会再写一次）。
		try {
			rmSync(path, { force: true });
			renameSync(tmp, path);
		} catch {
			rmSync(tmp, { force: true });
			throw error;
		}
	}
}

function readJson(path) {
	if (!existsSync(path)) {
		return { value: null, error: '' };
	}
	try {
		return { value: JSON.parse(readFileSync(path, 'utf8')), error: '' };
	} catch (error) {
		return { value: null, error: `${path}: ${String(error?.message ?? error)}` };
	}
}

/**
 * 列出所有 loop。**单个 loop 坏掉不许拖垮整张列表**：读不懂的进 `error` 字段，
 * 由 UI/工具如实显示（静默跳过 = "我明明放了 loop 却不跑"）。
 */
export function listLoops(config = {}) {
	const dir = loopsDirOf(config);
	if (!existsSync(dir)) {
		return { dir, loops: [] };
	}
	const names = readdirSync(dir, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
		.map(entry => entry.name)
		.sort();
	const loops = [];
	for (const name of names) {
		const loopDir = join(dir, name);
		const file = join(loopDir, LOOP_FILE);
		if (!existsSync(file)) {
			loops.push({ name, dir: loopDir, spec: null, warnings: [], error: `缺少 ${LOOP_FILE}` });
			continue;
		}
		const read = readJson(file);
		if (read.error) {
			loops.push({ name, dir: loopDir, spec: null, warnings: [], error: read.error });
			continue;
		}
		try {
			const { spec, warnings } = normalizeLoop(name, read.value);
			loops.push({ name, dir: loopDir, spec, warnings, error: '' });
		} catch (error) {
			loops.push({ name, dir: loopDir, spec: null, warnings: [], error: String(error?.message ?? error) });
		}
	}
	return { dir, loops };
}

export const findLoop = (config, name) => listLoops(config).loops.find(loop => loop.name === name) ?? null;

/**
 * 读 ledger 并**顺手做启动恢复**（running → failed）。
 * 放在读路径上而不是"启动时扫一遍"：Host 是按需拉起的，任何一次读都可能是重启后的第一次。
 */
export function readLedger(config, name, nowMs = Date.now()) {
	const path = join(loopDirOf(config, name), LEDGER_FILE);
	const read = readJson(path);
	const { ledger, warning } = normalizeLedger(read.value ?? createLedger());
	const recovered = recoverOnStart(ledger, nowMs);
	return { ledger, path, warning: read.error || warning, recovered };
}

export const writeLedger = (config, name, ledger) =>
	writeJsonAtomic(join(loopDirOf(config, name), LEDGER_FILE), ledger);

/** state.json：只存"上一次这一轮什么时候开始"与上一次结果，给 due 计算与面板用。 */
export function readState(config, name) {
	const read = readJson(join(loopDirOf(config, name), STATE_FILE));
	const value = read.value && typeof read.value === 'object' && !Array.isArray(read.value) ? read.value : {};
	return {
		state: {
			lastRoundStartedAt: text(value.lastRoundStartedAt),
			lastRoundFinishedAt: text(value.lastRoundFinishedAt),
			lastResult: text(value.lastResult),
			lastError: text(value.lastError),
			totalRounds: Number.isInteger(value.totalRounds) ? value.totalRounds : 0,
			consecutiveFailures: Number.isInteger(value.consecutiveFailures) ? value.consecutiveFailures : 0,
		},
		warning: read.error,
	};
}

export const writeState = (config, name, state) =>
	writeJsonAtomic(join(loopDirOf(config, name), STATE_FILE), state);
