/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 轻量 cron 表达式解析/匹配（对齐 cc-connect cron.go 的 5 字段语义）──
// 仅覆盖常用子集：min hour day-of-month month day-of-week，支持 * , - / 与 ?（同 *）。
// 不做 2 月闰年/时区特殊处理；字段边界按标准 cron 含义。纯函数，便于单测。

export interface CronField {
	readonly minute: string;
	readonly hour: string;
	readonly dom: string;
	readonly month: string;
	readonly dow: string;
}

export function parseCronExpr(expr: string): CronField {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`cron 表达式需 5 段（分 时 日 月 周），收到：${expr}`);
	}
	return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

/** 解析单个字段为允许的取值集合。 */
function fieldValues(token: string, min: number, max: number): Set<number> {
	const set = new Set<number>();
	if (token === "*" || token === "?") {
		for (let v = min; v <= max; v++) {
			set.add(v);
		}
		return set;
	}
	for (const part of token.split(",")) {
		if (part === "") {
			continue;
		}
		let step = 1;
		let base = part;
		const slashIdx = part.indexOf("/");
		if (slashIdx >= 0) {
			base = part.slice(0, slashIdx);
			const stepStr = part.slice(slashIdx + 1);
			step = parseInt(stepStr, 10);
			if (!Number.isFinite(step) || step <= 0) {
				throw new Error(`cron 步长非法：${part}`);
			}
		}
		if (base === "*" || base === "?") {
			for (let v = min; v <= max; v += step) {
				set.add(v);
			}
			continue;
		}
		const dashIdx = base.indexOf("-");
		if (dashIdx >= 0) {
			const lo = parseInt(base.slice(0, dashIdx), 10);
			const hi = parseInt(base.slice(dashIdx + 1), 10);
			if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
				throw new Error(`cron 区间非法：${base}`);
			}
			for (let v = lo; v <= hi; v += step) {
				set.add(v);
			}
			continue;
		}
		const n = parseInt(base, 10);
		if (!Number.isFinite(n)) {
			throw new Error(`cron 字段非法：${base}`);
		}
		set.add(n);
	}
	return set;
}

/** 判断给定时间是否命中 cron 表达式（按本地时间逐字段匹配）。 */
export function cronMatches(expr: string, date: Date): boolean {
	const f = parseCronExpr(expr);
	const minute = fieldValues(f.minute, 0, 59);
	const hour = fieldValues(f.hour, 0, 23);
	const dom = fieldValues(f.dom, 1, 31);
	const month = fieldValues(f.month, 1, 12);
	let dow = fieldValues(f.dow, 0, 7);
	if (dow.has(7)) {
		// 周日既可用 0 也可用 7 表示
		dow.add(0);
	}

	if (!minute.has(date.getMinutes())) {
		return false;
	}
	if (!hour.has(date.getHours())) {
		return false;
	}
	if (!month.has(date.getMonth() + 1)) {
		return false;
	}
	const dayOfMonth = date.getDate();
	const dayOfWeek = date.getDay(); // 0=Sun
	// dom 与 dow 的关系：标准 cron 中两者为「或」关系（除非其中一个为 *）。
	const domIsStar = f.dom === "*" || f.dom === "?";
	const dowIsStar = f.dow === "*" || f.dow === "?";
	if (domIsStar && dowIsStar) {
		return dom.has(dayOfMonth);
	}
	if (domIsStar) {
		return dow.has(dayOfWeek);
	}
	if (dowIsStar) {
		return dom.has(dayOfMonth);
	}
	// 两者都指定 → 满足其一即可
	return dom.has(dayOfMonth) || dow.has(dayOfWeek);
}
