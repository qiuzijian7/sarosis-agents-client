// 电脑操控的档位与调用分类（P0）。
//
// 与 IDE 侧 `common/desktopControlProtocol.ts` 是**同一份策略的两个副本**：
// TS 侧守主进程中继，JS 侧守 Host 工具；`dsh-plugins/check-computer-control.mjs`
// 逐项对账，防止两侧漂移。
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEVELS = ['off', 'view', 'background', 'foreground'];

/** P0 全部可用 op：只读，且与主进程中继的 method 名一一对应。 */
export const OBSERVE_OPS = [
	'getVersion', 'listApps', 'listWindows', 'getWindowState', 'getAccessibilityTree',
	'screenshot', 'getScreenSize', 'getCursorPosition', 'checkPermissions', 'getStatus',
];

/** P1/P2 的动作 op：登记只为分类与「明确拒」，P0 一个都不执行。 */
export const BACKGROUND_OPS = [
	'click', 'doubleClick', 'rightClick', 'typeText', 'pressKey', 'hotkey',
	'setValue', 'scroll', 'drag', 'clipboardRead', 'showWindow', 'launchApp',
];
export const FOREGROUND_OPS = ['activateApp', 'movePointer'];
export const REFUSED_OPS = [
	'killApp', 'setConfig', 'startRecording', 'stopRecording', 'replayTrajectory',
	'setAgentCursorState', 'setAgentCursorVisible',
];

export const PROTECTED_APP_HINTS = [
	'vssaros', 'vscode', 'code - oss', 'visual studio code',
	'dsh computer use', 'dsh host', 'settings', '系统设置',
	'credential manager', '凭据管理器', 'keychain access', '钥匙串访问',
	'password manager', '密码管理器',
];

export function classifyOp(op) {
	if (typeof op !== 'string' || !op) return 'foreground';
	if (OBSERVE_OPS.includes(op)) return 'observe';
	if (BACKGROUND_OPS.includes(op)) return 'background';
	return 'foreground';
}

export function levelAllows(level, kind) {
	if (level === 'off') return false;
	if (level === 'view') return kind === 'observe';
	if (level === 'background') return kind === 'observe' || kind === 'background';
	return level === 'foreground';
}

export function isProtectedApp(nameOrPath) {
	const text = String(nameOrPath ?? '').toLowerCase();
	if (!text) return false;
	return PROTECTED_APP_HINTS.some((hint) => text.includes(hint));
}

/** @returns { ok: true } 或 { ok:false, code, message }；执行前调用，fail-closed。 */
export function gateCall(op, level, { p0ReadOnly = true } = {}) {
	if (typeof op !== 'string' || !op) return { ok: false, code: -32602, message: 'op 必须是非空字符串' };
	if (REFUSED_OPS.includes(op)) return { ok: false, code: -32601, message: `${op} 被永久禁止` };
	const kind = classifyOp(op);
	if (p0ReadOnly && kind !== 'observe') {
		return { ok: false, code: -32601, message: `${op} 属于 ${kind}；P0 只读层不开放（输入注入属 P1/P2）` };
	}
	if (!levelAllows(level, kind)) {
		return { ok: false, code: -32601, message: `当前档位 ${level} 不允许 ${kind} 调用；用户可在「电脑操控」设置里调整` };
	}
	return { ok: true };
}

// ── 状态文件：<数据根>/computer-control.json ──────────────────────────────

export function defaultState() {
	return { version: 1, levels: {}, grants: {}, once: {} };
}

/** 解析失败一律回默认（fail-closed：没有有效配置 ⇒ 不额外开权限）。 */
export function readState(file, read = readFileSync) {
	try {
		const value = JSON.parse(read(file, 'utf8'));
		if (!value || value.version !== 1 || typeof value.levels !== 'object' || value.levels === null) return defaultState();
		const levels = {};
		for (const [botId, level] of Object.entries(value.levels)) {
			if (LEVELS.includes(level)) levels[botId] = level;
		}
		const plain = (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
		return {
			version: 1,
			levels,
			// P1：应用授权（一直允许）与会话级授权（这一次 / 拒绝）。
			grants: plain(value.grants),
			once: plain(value.once),
		};
	} catch {
		return defaultState();
	}
}

export function writeState(file, state, write = writeFileSync, rename = renameSync) {
	const tmp = join(dirname(file), `.computer-control.${process.pid}.tmp`);
	write(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
	rename(tmp, file);
}

export function levelFor(state, botId, fallback = 'view') {
	const level = state?.levels?.[botId];
	return LEVELS.includes(level) ? level : fallback;
}
