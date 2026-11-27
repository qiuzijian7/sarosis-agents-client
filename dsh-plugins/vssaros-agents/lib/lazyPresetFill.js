/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Start fallback work only after arm(); explicit first use bypasses the timer. */
export function createLazyPresetFill(run, { delayMs = 15_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
	let timer;
	let pending;
	let disposed = false;
	const cancelTimer = () => {
		if (timer !== undefined) { clearTimer(timer); timer = undefined; }
	};
	const fillNow = (reason = 'preset-use') => {
		if (disposed) { return Promise.resolve(); }
		if (pending) { return pending; }
		cancelTimer();
		const attempt = Promise.resolve().then(() => disposed ? undefined : run(reason));
		pending = attempt;
		void attempt.catch(() => { if (pending === attempt) { pending = undefined; } });
		return attempt;
	};
	return {
		fillNow,
		arm() {
			if (disposed || pending || timer !== undefined) { return; }
			timer = setTimer(() => { void fillNow('ready-fallback').catch(() => undefined); }, delayMs);
			timer?.unref?.();
		},
		dispose() {
			disposed = true;
			cancelTimer();
			return pending?.catch(() => undefined) ?? Promise.resolve();
		},
	};
}
