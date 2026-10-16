/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级发现（方案第 3.3 节第 1、2 步）与升级通道（第 3.4 节）的纯逻辑：
 * npm dist-tags + VsSaros 兼容清单 → 按通道给出候选版本、预检结果与推荐版本。不含 I/O。
 */

import { compareSemver, isRuntimeVersionDir, isSupportedNodeVersion, parseSemver } from './dshCli.js';

export type DshUpdateChannel = 'stable' | 'preview' | 'locked';

export interface IDshCompatEntry {
	readonly version: string;
	readonly verifiedAt?: string;
	/** 通过的检查项（如 `runtime-smoke` / `bridge` / `health` / `chat-smoke`）。 */
	readonly checks?: readonly string[];
	/** 该 dsh 版本要求的伴生插件版本范围。 */
	readonly bridgePlugin?: string;
	readonly notes?: string;
}

export interface IDshCompatManifest {
	readonly schema: 1;
	readonly generatedAt: string;
	readonly versions: readonly IDshCompatEntry[];
	/** 已知有问题的版本：任何通道都不推荐，也不可选。 */
	readonly blocked?: readonly { readonly version: string; readonly reason: string }[];
	/**
	 * 构建期预装进安装包的 dsh 版本（`build/prepack-dsh-runtime.mjs` 读取；必须出现在 versions 里）。
	 * 运行时只读使用 `<appPath>/dsh-runtime/<bundled>`，不随上游自动更新——升级靠发新版 IDE。
	 */
	readonly bundled?: string;
}

/**
 * 远端兼容清单的可信公钥（Ed25519，SPKI PEM）。CI 的 dsh-compat 流水线建立后把它的公钥加到这里；
 * 在此之前只有随包分发的清单生效（随包清单与代码同等可信，不需要签名）。
 */
export const DSH_COMPAT_TRUSTED_KEYS: readonly { readonly keyId: string; readonly publicKey: string }[] = [];

/** 校验并规范化清单内容；不合法时抛错（调用方据此回退到下一个来源）。 */
export function parseCompatManifest(raw: unknown): IDshCompatManifest {
	const m = raw as Partial<IDshCompatManifest> | undefined;
	if (!m || m.schema !== 1 || typeof m.generatedAt !== 'string' || !Array.isArray(m.versions)) {
		throw new Error('兼容清单格式不正确（需要 schema=1、generatedAt、versions）');
	}
	const versions = m.versions.filter((e): e is IDshCompatEntry => !!e && typeof e.version === 'string' && isRuntimeVersionDir(e.version));
	const blocked = Array.isArray(m.blocked) ? m.blocked.filter(b => !!b && typeof b.version === 'string' && isRuntimeVersionDir(b.version)).map(b => ({ version: b.version, reason: String(b.reason ?? '') })) : [];
	// bundled 只在指向一个清单内已验证的版本时才生效（防指向未测版本）。
	const bundled = typeof m.bundled === 'string' && isRuntimeVersionDir(m.bundled) && versions.some(v => v.version === m.bundled) ? m.bundled : undefined;
	return { schema: 1, generatedAt: m.generatedAt, versions, blocked, ...(bundled ? { bundled } : {}) };
}

// ─── semver 范围 ──────────────────────────────────────────────────────────────

/**
 * 判断版本是否满足范围。支持 `||`、空格分隔的比较式（`>= > < <= =`）与 `*`。
 * 预发布版本按普通版本参与比较（相当于 npm 的 includePrerelease）—— dsh 目前只发预发布版。
 * 无法解析的范围返回 undefined（调用方当作"无法判断"，不阻止）。
 */
export function satisfiesRange(version: string, range: string): boolean | undefined {
	const sets = range.split('||').map(s => s.trim());
	let parsedAny = false;
	for (const set of sets) {
		if (!set || set === '*' || set === 'x') {
			return true;
		}
		let ok = true;
		for (const part of set.split(/\s+/)) {
			const m = /^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(part);
			if (!m) {
				return undefined;
			}
			parsedAny = true;
			const c = compareSemver(version, m[2]);
			const op = m[1] ?? '=';
			const pass = op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
			if (!pass) {
				ok = false;
				break;
			}
		}
		if (ok) {
			return true;
		}
	}
	return parsedAny ? false : undefined;
}

// ─── 发现 ─────────────────────────────────────────────────────────────────────

export interface IDshUpdateInput {
	/**
	 * 随包**模块插件**（`dsh-plugins/<dir>`）对 `@deepseek-ai/dsh` 的 peer 范围（预检 ③）。
	 *
	 * 为什么需要它：此前只校验**伴生插件**（bridge）的 peer 范围 ②；而模块插件（kanban / codebase /
	 * memory …）同样声明了 `peerDependencies['@deepseek-ai/dsh']`，一旦运行时升到范围外，
	 * dsh 的准入检查会把该插件判为不兼容（`disabled: true` / 加载不了 ✗）⇒
	 * 用户看到的是"升级成功，但某个模块凭空消失"✗。列出来 ⇒ 版本选择器里那一项会被标注并置灰 ✓。
	 *
	 * 范围解析不了（`satisfiesRange` 返回 undefined）时**不报**问题 ✓ —— 与 ② 同一口径：
	 * 宁可漏报，不误报（避免挡住正常升级）。
	 */
	readonly modulePluginPeerRanges?: readonly { readonly name: string; readonly range: string }[];
	readonly channel: DshUpdateChannel;
	/** 锁定通道的版本；为空时锁定在当前版本。 */
	readonly pinned?: string;
	readonly current?: string;
	readonly installed: readonly string[];
	/** npm dist-tags，如 `{ latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.1-alpha.1' }`；查询失败时为空。 */
	readonly distTags: Readonly<Record<string, string>>;
	readonly manifest?: IDshCompatManifest;
	/** 伴生插件 package.json 对 `@deepseek-ai/dsh` 的 peer 范围（预检 ②）。 */
	readonly bridgePeerRange?: string;
	readonly bridgeVersion?: string;
	/** 将用于运行新版本的 Node（预检 ④）。 */
	readonly nodeVersion?: string;
}

export interface IDshUpdateCandidate {
	readonly version: string;
	/** 出现在兼容清单中。 */
	readonly verified: boolean;
	readonly tags: readonly string[];
	readonly installed: boolean;
	readonly current: boolean;
	readonly blocked?: string;
	/** 预检不通过的原因；空数组表示通过。 */
	readonly problems: readonly string[];
}

export interface IDshUpdateDiscovery {
	readonly channel: DshUpdateChannel;
	readonly current?: string;
	readonly candidates: readonly IDshUpdateCandidate[];
	/** 建议切换到的版本（已排除当前版本、被阻止的版本与预检失败的版本）。 */
	readonly recommended?: string;
	readonly notes: readonly string[];
}

/** 尝鲜通道只跟随这两个 tag；其他 tag（如 `alpha`）可手动选择，但不推荐。 */
const PREVIEW_TAGS = ['latest', 'next'];

/**
 * 判定「当前版本」：运行中的 Host 版本最可信。
 * 默认路径（不设 `runtimePath`）下 dsh 常来自内置（`<appPath>/dsh-runtime/<ver>`）或全局安装，
 * 两者都不写托管目录，只看托管指针会得到 undefined —— 界面显示「当前 -」，
 * 且因为候选里没有 `current=true`，正在跑的版本会被当成可升级目标弹提示。
 * 设了 `runtimePath` 时托管指针本就无意义（切换不生效），只认运行中的 Host。
 */
export function resolveCurrentVersion(input: {
	readonly runtimePath?: string;
	/** 运行中 Host 的版本（`_supervisor.status.dshVersion`；非运行态为空）。 */
	readonly runningVersion?: string;
	/** 由托管指针/已装版本推出的版本（`selectRuntimeVersion`）。 */
	readonly managedVersion?: string;
}): string | undefined {
	if (input.runtimePath?.trim()) {
		return input.runningVersion;
	}
	return input.runningVersion ?? input.managedVersion;
}

export function discoverUpdates(input: IDshUpdateInput): IDshUpdateDiscovery {
	const notes: string[] = [];
	const manifestVersions = new Map((input.manifest?.versions ?? []).map(e => [e.version, e]));
	const blocked = new Map((input.manifest?.blocked ?? []).map(b => [b.version, b.reason]));
	const tagsOf = (v: string) => Object.entries(input.distTags).filter(([, tv]) => tv === v).map(([t]) => t).sort();

	const pool = new Set<string>();
	const add = (v: string | undefined) => v && isRuntimeVersionDir(v) && pool.add(v);
	switch (input.channel) {
		case 'stable':
			manifestVersions.forEach((_, v) => add(v));
			if (!input.manifest) {
				notes.push('没有可用的兼容清单：稳定通道不推荐任何版本。');
			}
			break;
		case 'preview':
			manifestVersions.forEach((_, v) => add(v));
			Object.values(input.distTags).forEach(add);
			if (!Object.keys(input.distTags).length) {
				notes.push('无法查询 npm dist-tags：只列出兼容清单中的版本。');
			}
			break;
		case 'locked':
			add(input.pinned || input.current);
			if (!input.pinned) {
				notes.push('锁定通道未指定版本（sessions.dshHarness.pinnedVersion）：锁定在当前版本。');
			}
			break;
	}
	// 已安装的版本始终可选（用于回退）。
	input.installed.forEach(add);
	add(input.current);

	const candidates: IDshUpdateCandidate[] = [...pool].sort((a, b) => compareSemver(b, a)).map(version => {
		const entry = manifestVersions.get(version);
		const problems: string[] = [];
		if (input.bridgePeerRange && satisfiesRange(version, input.bridgePeerRange) === false) {
			problems.push(`伴生插件只支持 dsh ${input.bridgePeerRange}`);
		}
		if (entry?.bridgePlugin && input.bridgeVersion && satisfiesRange(input.bridgeVersion, entry.bridgePlugin) === false) {
			problems.push(`该版本需要伴生插件 ${entry.bridgePlugin}，当前为 ${input.bridgeVersion}`);
		}
		// ★ 2026-10-12：自研**模块插件**的 peer 预检（③）—— 升到某版本后若有随包模块插件不兼容，
		//   那一项会被标注并置灰（界面已展示 `problems`；`eligible` 也会把它排除出"推荐" ✓）。
		for (const mp of input.modulePluginPeerRanges ?? []) {
			if (mp.range && satisfiesRange(version, mp.range) === false) {
				problems.push(`随包模块插件 ${mp.name} 要求 dsh ${mp.range}，不含 ${version}`);
			}
		}
		if (input.nodeVersion && !isSupportedNodeVersion(input.nodeVersion)) {
			problems.push(`Node ${input.nodeVersion} 低于 dsh 要求（22.19+ / 24+）`);
		}
		return {
			version,
			verified: !!entry,
			tags: tagsOf(version),
			installed: input.installed.includes(version),
			current: version === input.current,
			blocked: blocked.get(version),
			problems,
		};
	});

	const eligible = (c: IDshUpdateCandidate) => !c.current && !c.blocked && !c.problems.length;
	const newer = (c: IDshUpdateCandidate) => !input.current || compareSemver(c.version, input.current) > 0;
	let recommended: string | undefined;
	switch (input.channel) {
		case 'stable':
			recommended = candidates.find(c => c.verified && eligible(c) && newer(c))?.version;
			break;
		case 'preview':
			// 尝鲜是稳定的超集：latest / next 不可用（如超出伴生插件范围）时仍可推荐已验证的版本。
			recommended = candidates.find(c => (c.verified || c.tags.some(t => PREVIEW_TAGS.includes(t))) && eligible(c) && newer(c))?.version;
			break;
		case 'locked': {
			const target = input.pinned && candidates.find(c => c.version === input.pinned);
			recommended = target && eligible(target) ? target.version : undefined;
			break;
		}
	}
	const cur = input.current && candidates.find(c => c.current);
	if (cur && cur.blocked) {
		notes.push(`当前版本 ${cur.version} 已被兼容清单标记为有问题：${cur.blocked}`);
	}
	return { channel: input.channel, current: input.current, candidates, recommended, notes };
}

/**
 * 首次安装选哪个版本：按通道的推荐（当前为空，所以稳定通道=清单中最高的可用版本）；
 * 没有推荐时（如稳定通道缺清单）退回 npm `latest`，否则用户无法开始使用。
 */
export function selectInstallTarget(input: Omit<IDshUpdateInput, 'current'>): string | undefined {
	const d = discoverUpdates({ ...input, current: undefined, channel: input.channel === 'locked' && !input.pinned ? 'stable' : input.channel });
	const latest = input.distTags.latest;
	return d.recommended ?? (latest && isRuntimeVersionDir(latest) ? latest : undefined);
}

/** 兼容清单的生成时间比较（来源择新）。 */
export function newerManifest(a: IDshCompatManifest | undefined, b: IDshCompatManifest | undefined): IDshCompatManifest | undefined {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	return Date.parse(b.generatedAt) > Date.parse(a.generatedAt) ? b : a;
}

export function isPrerelease(version: string): boolean {
	return !!parseSemver(version)?.pre;
}
