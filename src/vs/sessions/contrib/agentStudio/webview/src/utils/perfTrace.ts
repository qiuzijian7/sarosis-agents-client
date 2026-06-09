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
	/** epoch ms when the host finished generating the HTML, i.e. the instant
	 *  right before the webview starts downloading/parsing the bundle. This is
	 *  the only fair baseline for "true bundle load latency". */
	private readonly htmlTs: number | null;
	/** epoch ms when the inline <script> in the HTML executed. The gap
	 *  htmlTs→inlineTs ≈ webview process spawn + HTML transport (NO bundle yet),
	 *  and inlineTs→firstMark ≈ bundle download (module waterfall) + parse + eval.
	 *  This split decisively separates "process spawn" from "bundle download". */
	private readonly inlineTs: number | null;
	private readonly marks: PerfMark[] = [];
	private finished = false;

	constructor() {
		this.origin = pickOrigin();
		const hostCreate = W.__AS_PERF_HOST_CREATE_TS__;
		this.hostCreateTs = typeof hostCreate === 'number' && hostCreate > 0 ? hostCreate : null;
		const htmlTs = W.__AS_PERF_HTML_TS__;
		this.htmlTs = typeof htmlTs === 'number' && htmlTs > 0 ? htmlTs : null;
		const inlineTs = W.__AS_PERF_INLINE_TS__;
		this.inlineTs = typeof inlineTs === 'number' && inlineTs > 0 ? inlineTs : null;
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

			const firstMark = this.marks.length ? this.marks[0] : null;
			const lastMark = this.marks.length ? this.marks[this.marks.length - 1] : null;
			const total = lastMark ? lastMark.sinceOrigin : 0;
			console.log(
				`%c[AS-PERF] TOTAL  program-start → ${lastMark?.label ?? 'end'} = ${total}ms` +
				` (includes user idle time before the panel was opened)`,
				'color:#7cd96a;font-weight:bold',
			);

			// ── TRUE latencies (the numbers that actually matter) ─────────────
			// `bundle-load` = host finished HTML → first JS mark fires. This is
			//   the real cost of: webview process spawn + bundle download (via
			//   the service-worker resource proxy) + parse + eval. It EXCLUDES
			//   the idle time the user spent before opening the panel.
			// `panel-open → first-paint` = the real perceived latency from the
			//   moment the user opened the panel to the first chat paint.
			const bundleLoadBaseline = this.htmlTs ?? this.hostCreateTs ?? this.origin;
			const bundleLoadMs = firstMark ? firstMark.ts - bundleLoadBaseline : null;
			const openBaseline = this.hostCreateTs ?? this.htmlTs ?? this.origin;
			const openToPaintMs = lastMark ? lastMark.ts - openBaseline : null;

			// ── Decisive split of bundle-load into its two halves ────────────
			// htmlTs → inlineTs  ≈ webview process spawn + HTML transport
			//                      (NO bundle involved yet)
			// inlineTs → firstMark ≈ bundle download (ESM module waterfall via
			//                      the service-worker proxy) + parse + eval
			const spawnMs =
				this.htmlTs !== null && this.inlineTs !== null
					? this.inlineTs - this.htmlTs
					: null;
			const downloadMs =
				this.inlineTs !== null && firstMark
					? firstMark.ts - this.inlineTs
					: null;

			if (bundleLoadMs !== null) {
				console.log(
					`%c[AS-PERF] ★ bundle-load (HTML→${firstMark?.label}) = ${bundleLoadMs}ms` +
					`  ← process spawn + download + parse + eval (THE real load cost)`,
					'color:#ff7043;font-weight:bold',
				);
			}
			if (spawnMs !== null || downloadMs !== null) {
				console.log(
					`%c[AS-PERF]   ↳ split: process-spawn+html (HTML→inline) = ${spawnMs ?? '?'}ms` +
					`  |  bundle-download+parse (inline→${firstMark?.label}) = ${downloadMs ?? '?'}ms`,
					'color:#ff7043',
				);
			}
			if (openToPaintMs !== null) {
				console.log(
					`%c[AS-PERF] ★ panel-open → first-paint = ${openToPaintMs}ms  (perceived latency)`,
					'color:#ff7043;font-weight:bold',
				);
			}

			// Highlight the single slowest stage so the bottleneck is obvious.
			// Skip the FIRST mark for "slowest" because its Δ is measured from
			// `program-start` and is dominated by pre-open idle time (misleading).
			let slowest: PerfMark | null = null;
			for (let i = 1; i < this.marks.length; i++) {
				const m = this.marks[i];
				if (!slowest || m.sincePrev > slowest.sincePrev) {
					slowest = m;
				}
			}
			if (slowest) {
				console.log(
					`%c[AS-PERF] SLOWEST post-load stage = "${slowest.label}" took ${slowest.sincePrev}ms`,
					'color:#ffb454;font-weight:bold',
				);
			}

			// Relay the full timeline back to the HOST log so the end-to-end
			// chain (host [AS-PERF][host] + webview stages) is visible in ONE
			// place. Fire-and-forget; host prints it as [AS-PERF][webview].
			this.relayToHost(total, slowest, bundleLoadMs, openToPaintMs, spawnMs, downloadMs);
		} catch (err) {
			console.warn('[AS-PERF] report failed:', err);
		}
	}

	/** Send the timeline to the host so it shows up in the main log file. */
	private relayToHost(
		total: number,
		slowest: PerfMark | null,
		bundleLoadMs: number | null,
		openToPaintMs: number | null,
		spawnMs: number | null,
		downloadMs: number | null,
	): void {
		try {
			postMessage('perf.report', {
				origin: this.origin,
				total,
				bundleLoadMs,
				openToPaintMs,
				spawnMs,
				downloadMs,
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
