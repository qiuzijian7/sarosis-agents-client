/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - First-load Performance Tracer
 *
 *  Measures the elapsed time from program/window start to the moment the chat
 *  panel finishes its FIRST successful paint, and prints a per-stage timeline
 *  so we can pinpoint what makes the initial open slow.
 *
 *  Time base (origin) selection, most-accurate first:
 *    1. window.__AS_PERF_RENDERER_ORIGIN__  — host renderer navigation start
 *       (≈ VS Code window/program start), injected by the host controller.
 *    2. performance.timeOrigin              — this webview iframe's nav start.
 *    3. window.__AS_PERF_HOST_CREATE_TS__   — host controller creation time.
 *
 *  All marks use Date.now() (epoch wall-clock) so values are comparable across
 *  the host renderer process and the webview iframe (which have independent
 *  performance.now() origins).
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { postMessage } from '../bridge/messageClient.js';

interface PerfMark {
	readonly label: string;
	/** epoch ms (Date.now) when the mark was recorded */
	readonly ts: number;
	/** ms since the chosen origin (program/window start) */
	readonly sinceOrigin: number;
	/** ms since the previous mark */
	readonly sincePrev: number;
}

const W = window as unknown as Record<string, unknown>;

function pickOrigin(): number {
	const rendererOrigin = W.__AS_PERF_RENDERER_ORIGIN__;
	if (typeof rendererOrigin === 'number' && rendererOrigin > 0) {
		return rendererOrigin;
	}
	if (typeof performance !== 'undefined' && performance.timeOrigin > 0) {
		return performance.timeOrigin;
	}
	const hostCreate = W.__AS_PERF_HOST_CREATE_TS__;
	if (typeof hostCreate === 'number' && hostCreate > 0) {
		return hostCreate;
	}
	return Date.now();
}

class PerfTracer {
	private readonly origin: number;
	private readonly hostCreateTs: number | null;
	private readonly marks: PerfMark[] = [];
	private finished = false;

	constructor() {
		this.origin = pickOrigin();
		const hostCreate = W.__AS_PERF_HOST_CREATE_TS__;
		this.hostCreateTs = typeof hostCreate === 'number' && hostCreate > 0 ? hostCreate : null;
	}

	/** Record a timeline checkpoint. */
	mark(label: string): void {
		if (this.finished) {
			return;
		}
		const ts = Date.now();
		const prev = this.marks.length ? this.marks[this.marks.length - 1].ts : this.origin;
		const entry: PerfMark = {
			label,
			ts,
			sinceOrigin: ts - this.origin,
			sincePrev: ts - prev,
		};
		this.marks.push(entry);
		// Per-mark line so we still get data even if `finish` never fires.
		console.log(`[AS-PERF] ${label}: +${entry.sinceOrigin}ms (Δ${entry.sincePrev}ms from prev)`);
	}

	/** Record the terminal mark (first successful chat paint) and print the report. ONLY fires once. */
	finish(label = 'chat-first-paint'): void {
		if (this.finished) {
			return;
		}
		this.mark(label);
		this.finished = true;
		this.report();
	}

	private report(): void {
		try {
			console.log(
				'%c[AS-PERF] ════════ Chat first-load timeline ════════',
				'color:#4fc3f7;font-weight:bold',
			);
			console.log(`[AS-PERF] origin (program/window start) = ${new Date(this.origin).toISOString()}`);
			if (this.hostCreateTs !== null) {
				console.log(`[AS-PERF] host created webview controller at +${this.hostCreateTs - this.origin}ms`);
			}

			const rows = this.marks.map((m) => ({
				stage: m.label,
				'since start (ms)': m.sinceOrigin,
				'Δ from prev (ms)': m.sincePrev,
			}));
			// console.table renders a readable grid in the webview devtools.
			console.table(rows);

			const total = this.marks.length ? this.marks[this.marks.length - 1].sinceOrigin : 0;
			console.log(
				`%c[AS-PERF] TOTAL  program-start → ${this.marks[this.marks.length - 1]?.label ?? 'end'} = ${total}ms`,
				'color:#7cd96a;font-weight:bold',
			);

			// Highlight the single slowest stage so the bottleneck is obvious.
			let slowest: PerfMark | null = null;
			for (const m of this.marks) {
				if (!slowest || m.sincePrev > slowest.sincePrev) {
					slowest = m;
				}
			}
			if (slowest) {
				console.log(
					`%c[AS-PERF] SLOWEST stage = "${slowest.label}" took ${slowest.sincePrev}ms`,
					'color:#ffb454;font-weight:bold',
				);
			}

			// Relay the full timeline back to the HOST log so the end-to-end
			// chain (host [AS-PERF][host] + webview stages) is visible in ONE
			// place. Fire-and-forget; host prints it as [AS-PERF][webview].
			this.relayToHost(total, slowest);
		} catch (err) {
			console.warn('[AS-PERF] report failed:', err);
		}
	}

	/** Send the timeline to the host so it shows up in the main log file. */
	private relayToHost(total: number, slowest: PerfMark | null): void {
		try {
			postMessage('perf.report', {
				origin: this.origin,
				total,
				slowest: slowest
					? { label: slowest.label, ms: slowest.sincePrev }
					: null,
				marks: this.marks.map((m) => ({
					label: m.label,
					sinceOrigin: m.sinceOrigin,
					sincePrev: m.sincePrev,
				})),
			});
		} catch {
			// ignore — perf relay must never break the app
		}
	}
}

/** Singleton — survives module re-entry via window storage. */
export const perfTrace: PerfTracer =
	(W.__AS_PERF__ as PerfTracer | undefined) ?? ((W.__AS_PERF__ = new PerfTracer()) as PerfTracer);
