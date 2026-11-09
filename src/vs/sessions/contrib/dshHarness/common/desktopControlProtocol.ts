/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros addition (2026-11-09, P0 · read-only): policy for the desktop-control relay.
 *
 * The relay is the main process's loopback WebSocket that lets a dsh Host plugin OBSERVE the
 * desktop (screenshot, window list, screen size). P0 deliberately has **no input-injection code
 * at all**: the method allowlist below contains only observe methods, and any other method is
 * refused before dispatch. Input injection (background/foreground tiers), OS-wide window
 * enumeration and a real accessibility tree belong to P1/P2.
 *
 * Fail-closed rules, all testable without Electron:
 * - an unknown method is classified as `foreground` (the most dangerous tier);
 * - the `off` tier sees nothing, `view` sees only observe methods;
 * - P0 additionally refuses every non-observe method regardless of tier;
 * - a permanent denylist covers config/recording/replay/kill operations.
 */

export const DESKTOP_CONTROL_FILE = 'desktop-control.json';
/** WebSocket path prefix; a fresh random token follows it on every app start. */
export const DESKTOP_CONTROL_PATH = '/desktop-control/vssaros/';

export interface IDesktopControlEndpoint {
	readonly version: 1;
	/** ws://127.0.0.1:<port><DESKTOP_CONTROL_PATH><token> */
	readonly wsUrl: string;
	/** The main process serving it; the Host skips a file whose process is gone. */
	readonly pid: number;
	readonly startedAt: string;
}

export type DesktopLevel = 'off' | 'view' | 'background' | 'foreground';
export type DesktopCallKind = 'observe' | 'background' | 'foreground';

export const DESKTOP_LEVELS: readonly DesktopLevel[] = ['off', 'view', 'background', 'foreground'];

/**
 * The main process's own ceiling, NOT a level supplied by the Host (the Host is not trusted
 * for this decision). Default `view` keeps the product read-only; P1 background input requires
 * an explicit opt-in at the relay's construction site.
 */
export const DESKTOP_DEFAULT_MAX_LEVEL: DesktopLevel = 'view';

/** `off`/`view` force the hard read-only gate regardless of what a caller claims. */
export function isReadOnlyLevel(level: DesktopLevel): boolean {
	return level === 'off' || level === 'view';
}

/**
 * P2: a foreground call may move the visible pointer or raise a window, so it must not race
 * the person using the machine. The relay asks the OS how long the user has been idle.
 */
export const DESKTOP_USER_IDLE_THRESHOLD_SECONDS = 3;

export function isForegroundMethod(method: unknown): boolean {
	return typeof method === 'string' && DESKTOP_FOREGROUND_METHODS.has(method);
}

/**
 * @returns undefined when allowed. Unknown/NaN idle time is refused (fail-closed): a platform
 * that cannot report idle time must never open foreground control.
 */
export function foregroundIdleRefusal(
	idleSeconds: number,
	threshold = DESKTOP_USER_IDLE_THRESHOLD_SECONDS,
): IDesktopRefusal | undefined {
	if (!Number.isFinite(idleSeconds) || idleSeconds < threshold) {
		return {
			code: -32001,
			message: `用户最近 ${threshold}s 内还在操作电脑（或本机读不到空闲时间）；前台动作已拒绝。请等用户停手，或让用户在「电脑操控」里接管。`,
		};
	}
	return undefined;
}

/** The complete P0 capability surface. Nothing here mutates the desktop. */
export const DESKTOP_OBSERVE_METHODS: ReadonlySet<string> = new Set([
	'getVersion',
	'listApps',
	'listWindows',
	'getWindowState',
	'getAccessibilityTree',
	'screenshot',
	'getScreenSize',
	'getCursorPosition',
	'checkPermissions',
	'getStatus',
]);

/**
 * P2 presence methods. These never touch the desktop: `stop` only makes the relay MORE
 * conservative and `reportStatus` only stores display metadata, so they are allowed at every
 * level (including `off`) — an emergency stop must still work when control is switched off.
 */
export const DESKTOP_PRESENCE_METHODS: ReadonlySet<string> = new Set(['stop', 'reportStatus']);

export function isPresenceMethod(method: unknown): boolean {
	return typeof method === 'string' && DESKTOP_PRESENCE_METHODS.has(method);
}

/** Display-only state for the tray / floating indicator. Never contains credentials or pixels. */
export interface IDesktopControlStatus {
	readonly active: boolean;
	readonly botId: string;
	readonly appKey: string;
	readonly handoffState: 'idle' | 'pending' | 'user';
	readonly stopped: boolean;
}

export const DESKTOP_IDLE_STATUS: IDesktopControlStatus = {
	active: false, botId: '', appKey: '', handoffState: 'idle', stopped: false,
};

/** Declared for classification and explicit refusal; P0 never executes them. */
export const DESKTOP_BACKGROUND_METHODS: ReadonlySet<string> = new Set([
	'click', 'doubleClick', 'rightClick', 'typeText', 'pressKey', 'hotkey',
	'setValue', 'scroll', 'drag', 'clipboardRead', 'showWindow', 'launchApp',
]);
export const DESKTOP_FOREGROUND_METHODS: ReadonlySet<string> = new Set([
	'activateApp', 'movePointer',
]);

/** Never allowed, in any tier, in any phase. */
export const DESKTOP_REFUSED_METHODS: ReadonlySet<string> = new Set([
	'killApp', 'setConfig', 'startRecording', 'stopRecording', 'replayTrajectory',
	'setAgentCursorState', 'setAgentCursorVisible',
]);

/**
 * Apps a Bot must never target. P0 only marks them in the window list; when P1 adds input
 * injection this becomes a hard pre-execute gate (a Bot must not click its own approval card).
 */
export const PROTECTED_APP_HINTS: readonly string[] = [
	'vssaros', 'vscode', 'code - oss', 'visual studio code',
	'dsh computer use', 'dsh host', 'settings', '系统设置',
	'credential manager', '凭据管理器', 'keychain access', '钥匙串访问',
	'password manager', '密码管理器',
];

export function classifyDesktopMethod(method: unknown): DesktopCallKind {
	if (typeof method !== 'string' || !method) {
		return 'foreground';
	}
	if (DESKTOP_OBSERVE_METHODS.has(method)) {
		return 'observe';
	}
	if (DESKTOP_BACKGROUND_METHODS.has(method)) {
		return 'background';
	}
	return 'foreground';
}

export function levelAllows(level: DesktopLevel, kind: DesktopCallKind): boolean {
	if (level === 'off') {
		return false;
	}
	if (level === 'view') {
		return kind === 'observe';
	}
	if (level === 'background') {
		return kind === 'observe' || kind === 'background';
	}
	return true;
}

export function isProtectedApp(nameOrPath: unknown): boolean {
	const text = String(nameOrPath ?? '').toLowerCase();
	if (!text) {
		return false;
	}
	return PROTECTED_APP_HINTS.some(hint => text.includes(hint));
}

export interface IDesktopRefusal { code: number; message: string }

/**
 * @returns undefined when allowed, otherwise a JSON-RPC-shaped refusal.
 * @param p0ReadOnly P0 hard gate: refuse every non-observe method even if the tier would allow it.
 */
export function desktopControlRefusal(method: unknown, level: DesktopLevel, p0ReadOnly = true): IDesktopRefusal | undefined {
	if (typeof method !== 'string' || !method) {
		return { code: -32602, message: 'method must be a non-empty string' };
	}
	if (DESKTOP_REFUSED_METHODS.has(method)) {
		return { code: -32601, message: `${method} is permanently refused` };
	}
	const kind = classifyDesktopMethod(method);
	if (p0ReadOnly && kind !== 'observe') {
		return { code: -32601, message: `${method} is a ${kind} method; the P0 read-only relay does not serve it` };
	}
	if (!levelAllows(level, kind)) {
		return { code: -32601, message: `level ${level} does not allow ${kind} calls` };
	}
	return undefined;
}

/** Constant-time compare of the token embedded in the request path. */
export function desktopTokenMatches(pathValue: string | undefined, token: string): boolean {
	if (typeof pathValue !== 'string' || !pathValue.startsWith(DESKTOP_CONTROL_PATH) || !token) {
		return false;
	}
	const given = pathValue.slice(DESKTOP_CONTROL_PATH.length).split('?')[0];
	if (given.length !== token.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < token.length; i++) {
		diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
	}
	return diff === 0;
}
