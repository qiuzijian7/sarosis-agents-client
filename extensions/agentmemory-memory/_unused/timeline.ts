/*---------------------------------------------------------------------------------------------
 *  时间线 — 按时间排序的观察视图。
 *  参考 agentmemory src/functions/timeline.ts
 *
 *  提供按时间顺序浏览记忆的能力，支持时间范围过滤。
 *--------------------------------------------------------------------------------------------*/

export interface TimelineEntry {
	id: string;
	timestamp: number;
	content: string;
	type: string;
	importance: number;
	strength: number;
	relativePosition: number; // 0.0 (oldest) - 1.0 (newest)
}

interface InternalEntry {
	id: string;
	content: string;
	type: string;
	timestamp?: number;
	importance?: number;
	strength: number;
	metadata?: Record<string, unknown>;
	supersededBy?: string;
}

export class Timeline {
	/**
	 * Build a timeline from memory entries.
	 * Entries are sorted by timestamp ascending, with relative positions calculated.
	 */
	build(entries: InternalEntry[]): TimelineEntry[] {
		const active = entries.filter(e => !e.supersededBy);
		const sorted = [...active].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

		if (sorted.length === 0) return [];

		const oldest = sorted[0].timestamp ?? 0;
		const newest = sorted[sorted.length - 1].timestamp ?? 0;
		const span = Math.max(1, newest - oldest);

		return sorted.map(entry => ({
			id: entry.id,
			timestamp: entry.timestamp ?? 0,
			content: entry.content,
			type: entry.type,
			importance: entry.importance ?? 5,
			strength: entry.strength,
			relativePosition: ((entry.timestamp ?? 0) - oldest) / span,
		}));
	}

	/**
	 * Filter timeline by time range.
	 */
	filterByRange(
		entries: TimelineEntry[],
		from?: number,
		to?: number,
	): TimelineEntry[] {
		return entries.filter(e => {
			if (from !== undefined && e.timestamp < from) return false;
			if (to !== undefined && e.timestamp > to) return false;
			return true;
		});
	}

	/**
	 * Get entries from the last N hours.
	 */
	recent(entries: TimelineEntry[], hours: number): TimelineEntry[] {
		const cutoff = Date.now() - hours * 60 * 60 * 1000;
		return this.filterByRange(entries, cutoff);
	}

	/**
	 * Get entries by type.
	 */
	byType(entries: TimelineEntry[], type: string): TimelineEntry[] {
		return entries.filter(e => e.type === type);
	}

	/**
	 * Get a summary of the timeline (buckets by day).
	 */
	summarizeByDay(entries: TimelineEntry[]): Array<{ date: string; count: number; avgStrength: number }> {
		const buckets = new Map<string, TimelineEntry[]>();
		for (const entry of entries) {
			const date = new Date(entry.timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
			const bucket = buckets.get(date) ?? [];
			bucket.push(entry);
			buckets.set(date, bucket);
		}

		return Array.from(buckets.entries())
			.map(([date, items]) => ({
				date,
				count: items.length,
				avgStrength: items.reduce((sum, e) => sum + e.strength, 0) / items.length,
			}))
			.sort((a, b) => a.date.localeCompare(b.date));
	}
}
