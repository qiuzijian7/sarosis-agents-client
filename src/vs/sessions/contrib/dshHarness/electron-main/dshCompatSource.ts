/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 兼容清单的来源：随包分发的 `dsh-plugins/dsh-compat.json`（与代码同等可信，不签名）
 * + 可选的远端签名清单（Ed25519，公钥见 DSH_COMPAT_TRUSTED_KEYS）。两者取生成时间较新的。
 *
 * ⚠ **可信密钥为空时（本仓当前就是空数组），远端清单整体不可用**：不去拉取，只在 `errors` 里
 * 说清"功能未启用、仅用随包清单"✓ —— 否则会以"密钥 X 不在可信列表中"收场，读起来像"密钥配错了"
 * 的 bug ✗。注意验签本身是 **fail-closed** 的（未知 keyId / 验签失败一律抛错）⇒
 * "没配密钥"绝不会退化成"不验签也放行"✓。
 *
 * 远端信封：`{ "keyId": "...", "payload": "<base64(清单 JSON)>", "signature": "<base64(Ed25519)>" }`，
 * 由 `build/saros/dsh-compat-manifest.mjs sign` 生成。成功拉取的信封缓存到本地，离线时使用缓存（仍重新验签）。
 *
 * 只依赖 Node 内置模块与 vs/base，不 import electron。
 */

import { createPublicKey, verify } from 'crypto';
import { promises as fsp } from 'fs';
import { DSH_COMPAT_TRUSTED_KEYS, IDshCompatManifest, newerManifest, parseCompatManifest } from '../common/dshCompat.js';
import { FetchLike } from './dshNodeInstaller.js';

export interface ISignedManifestEnvelope {
	readonly keyId: string;
	readonly payload: string;
	readonly signature: string;
}

export type TrustedKeys = readonly { readonly keyId: string; readonly publicKey: string }[];

/** 验签并解析信封；任何问题都抛错。 */
export function verifyManifestEnvelope(envelope: unknown, keys: TrustedKeys): IDshCompatManifest {
	const e = envelope as Partial<ISignedManifestEnvelope> | undefined;
	if (!e || typeof e.keyId !== 'string' || typeof e.payload !== 'string' || typeof e.signature !== 'string') {
		throw new Error('签名清单格式不正确（需要 keyId、payload、signature）');
	}
	const key = keys.find(k => k.keyId === e.keyId);
	if (!key) {
		throw new Error(`签名清单的密钥 ${e.keyId} 不在可信列表中`);
	}
	const payload = Buffer.from(e.payload, 'base64');
	const ok = verify(null, payload, createPublicKey(key.publicKey), Buffer.from(e.signature, 'base64'));
	if (!ok) {
		throw new Error('签名清单验签失败');
	}
	return parseCompatManifest(JSON.parse(payload.toString('utf8')));
}

export interface ICompatSourceOptions {
	readonly bundledPath?: string;
	readonly remoteUrl?: string;
	readonly cachePath: string;
	readonly fetch: FetchLike;
	readonly log: (line: string) => void;
	/** 仅测试使用。 */
	readonly trustedKeys?: TrustedKeys;
}

export interface ICompatLoadResult {
	readonly manifest?: IDshCompatManifest;
	/** 实际采用的来源。 */
	readonly source?: 'bundled' | 'remote' | 'cache';
	readonly errors: readonly string[];
}

export async function loadCompatManifest(opts: ICompatSourceOptions): Promise<ICompatLoadResult> {
	const errors: string[] = [];
	const keys = opts.trustedKeys ?? DSH_COMPAT_TRUSTED_KEYS;

	let bundled: IDshCompatManifest | undefined;
	if (opts.bundledPath) {
		try {
			bundled = parseCompatManifest(JSON.parse(await fsp.readFile(opts.bundledPath, 'utf8')));
		} catch (e) {
			errors.push(`随包清单：${String((e as Error)?.message ?? e)}`);
		}
	}

	let remote: IDshCompatManifest | undefined;
	let remoteSource: 'remote' | 'cache' | undefined;
	if (opts.remoteUrl?.trim()) {
		if (keys.length === 0) {
			// ★ 2026-10-12：**未配置可信密钥**（`DSH_COMPAT_TRUSTED_KEYS` 为空，当前就是）时，
			//   远端签名清单**整体不可用** —— 与其去拉一次、再被 `verifyManifestEnvelope` 以
			//   "密钥 X 不在可信列表中"拒掉（那读起来像"密钥配错了"的 bug ✗），不如直接说清
			//   "功能未启用、只用随包清单"✓。fail-closed 语义不变，只是把禁用状态**显式化**：
			//   谁都没法再以为"远端清单已经验过签了"✗。
			errors.push('远端清单：未配置可信密钥（DSH_COMPAT_TRUSTED_KEYS 为空）⇒ 远端签名清单不可用，仅用随包清单');
		} else {
				try {
					const res = await opts.fetch(opts.remoteUrl.trim());
					if (!res.ok) {
						throw new Error(`HTTP ${res.status}`);
					}
					const text = await res.text();
					remote = verifyManifestEnvelope(JSON.parse(text), keys);
					remoteSource = 'remote';
					await fsp.writeFile(opts.cachePath, text).catch(() => undefined);
				} catch (e) {
					errors.push(`远端清单：${String((e as Error)?.message ?? e)}`);
					try {
						remote = verifyManifestEnvelope(JSON.parse(await fsp.readFile(opts.cachePath, 'utf8')), keys);
						remoteSource = 'cache';
					} catch {
						// 没有可用缓存
					}
				}
			}
		}

	const manifest = newerManifest(bundled, remote);
	const source = !manifest ? undefined : manifest === remote ? remoteSource : 'bundled';
	if (errors.length) {
		opts.log(`compat manifest: ${errors.join('; ')}`);
	}
	return { manifest, source, errors };
}
