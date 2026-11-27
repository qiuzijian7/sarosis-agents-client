/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { realpathSync, statSync } from 'fs';
import { isAbsolute } from '../../../../base/common/path.js';

/** Process-local successful probes only; PATH commands remain uncached until resolved to an absolute file. */
export class DshRuntimeProbeCache {
	private readonly _entries = new Map<string, { expires: number; pending: Promise<unknown> }>();

	constructor(private readonly _now: () => number = Date.now, private readonly _ttlMs = 30_000) { }

	clear(): void { this._entries.clear(); }

	private _identity(files: readonly string[]): string | undefined {
		try {
			if (!files.length || files.some(file => !isAbsolute(file))) { return undefined; }
			return JSON.stringify(files.map(file => {
				const resolved = realpathSync.native(file);
				const stat = statSync(resolved, { bigint: true });
				if (!stat.isFile()) { throw new Error('Probe input is not a file'); }
				return [resolved, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(value => value.toString())];
			}));
		} catch { return undefined; }
	}

	run<T>(files: readonly string[], probe: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
		const key = this._identity(files);
		if (!key) { return probe(); }
		const existing = this._entries.get(key);
		if (existing && existing.expires > this._now()) { return existing.pending as Promise<T>; }
		const entry = { expires: this._now() + this._ttlMs, pending: Promise.resolve().then(probe) };
		this._entries.delete(key);
		this._entries.set(key, entry);
		while (this._entries.size > 16) { this._entries.delete(this._entries.keys().next().value!); }
		void entry.pending.then(value => {
			if (this._entries.get(key) !== entry) { return; }
			if (!accept(value) || this._identity(files) !== key) { this._entries.delete(key); }
			else { entry.expires = this._now() + this._ttlMs; }
		}, () => { if (this._entries.get(key) === entry) { this._entries.delete(key); } });
		return entry.pending;
	}
}
