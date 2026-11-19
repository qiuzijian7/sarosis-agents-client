import { A as key, S as string, T as unknown, b as object, d as sameName, g as boolean, h as array, i as pollThreads, l as escapeRegExp, m as _enum, n as cursorAt, o as health, r as pause, s as sourceContext, w as union, x as record, y as number } from "./poll-DRgTfbJS.js";
import { t as KV } from "./kv-0d42zQlz.js";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
//#region src/sources/tapd-filters.ts
/**
* Imports the filter export of the Saroasis platform's bug page (`/bug/client.html`) and compiles it into
* TAPD Open API query fields plus a small set of local rules. Field names, enum values and query syntax were
* verified with read-only /bugs/count and /bugs/custom_fields_settings probes against workspace 68880148.
*
* The export's `conditions` are display-oriented (Chinese field names and values); `state` carries the internal
* IDs and English priority codes. Compilation never silently drops a condition: every one appears in `report`.
*/
const Condition = object({
	field: string().trim().min(1),
	op: string().trim().min(1),
	enabled: boolean().default(true),
	value: union([array(string()), object({
		from: string(),
		to: string()
	})]).default([])
}).passthrough();
const TapdFilterExportSchema = object({
	source: string().optional(),
	page: string().optional(),
	url: string().optional(),
	exportedAt: string().optional(),
	conditions: array(Condition).min(1),
	state: record(string(), unknown()).optional()
}).passthrough();
/** A condition that TAPD's query syntax cannot express: applied to each fetched item by the Host. */
const LocalRuleSchema = object({
	field: _enum([
		"title",
		"label",
		"owner",
		"status"
	]),
	op: _enum([
		"not_like",
		"not_in",
		"in"
	]),
	values: array(string())
}).strict();
const ReportSchema = object({
	field: string(),
	op: string(),
	enabled: boolean(),
	target: _enum([
		"api",
		"local",
		"skipped",
		"manual"
	]),
	detail: string()
}).strict();
/** One daily sweep. `query` is sent to /bugs; `local` filters the returned items before they are dispatched. */
const TapdFilterScheduleSchema = object({
	name: string().trim().regex(/^[\w.-]{1,40}$/),
	enabled: boolean().default(false),
	/** Local HH:MM; the poll loop dispatches once per calendar day at or after this time. */
	/** Local HH:MM; default is the small-hours low-traffic window (avoids the 00:00 day rollover and service warm-up). */
	at: string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("02:00"),
	/** Hard cap of dispatched items per run, so a broad filter cannot create thousands of tickets. */
	maxPerRun: number().int().min(1).max(200).default(20),
	/** Only items modified within this many days are considered; the export's created range may span decades. */
	windowDays: number().int().min(1).max(30).default(2),
	query: record(string(), string()).default({}),
	local: array(LocalRuleSchema).default([]),
	report: array(ReportSchema).default([]),
	page: string().default(""),
	exportedAt: string().default("")
}).strict();
/** Fallbacks for an offline import; a live Host resolves both maps from the workspace's own configuration. */
const FIELD_NAMES_FALLBACK = {
	所属分支: "custom_field_10",
	是否必现: "custom_field_7",
	Bug类型: "custom_field_19",
	BUG类型: "custom_field_19"
};
const STATUS_CODES_FALLBACK = {
	新建: "new",
	修复中: "in_progress",
	已修复: "resolved",
	分支验证完成: "status_6",
	验收完成: "verified",
	主干待回归: "rejected",
	主干验收完成: "status_9",
	重新打开: "reopened",
	已完成: "closed",
	无效关闭: "status_1",
	挂起: "suspended",
	分支待回归: "status_8"
};
const valuesOf = (condition) => (Array.isArray(condition.value) ? condition.value : []).map((value) => value.trim()).filter(Boolean);
const rangeOf = (condition) => !Array.isArray(condition.value) ? condition.value : void 0;
/** TAPD time fields take `YYYY-MM-DD HH:mm:ss`, while the export writes `YYYY-MM-DDTHH:mm`. */
const tapdTime$1 = (value) => /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) ? `${value.slice(0, 10)} ${value.slice(11, 16)}:00` : value;
const opOf = (raw) => /不属于|not in/i.test(raw) ? "not_in" : /不包含|not like/i.test(raw) ? "not_like" : /介于|range/i.test(raw) ? "range" : "in";
/** Strips a parenthesised qualifier such as 状态（属于） or 标签（OR 口径）. */
const nameOf = (raw) => raw.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
/** Turns the display-oriented export into API fields, local rules and a per-condition report. */
function importTapdFilter(input, options = {}) {
	const parsed = TapdFilterExportSchema.parse(input);
	const fieldNames = {
		...FIELD_NAMES_FALLBACK,
		...options.fieldNames
	};
	const statusCodes = {
		...STATUS_CODES_FALLBACK,
		...options.statusCodes
	};
	const ownerGroups = options.ownerGroups ?? {};
	const query = {};
	const local = [];
	const report = [];
	const warnings = [];
	const releases = Array.isArray(parsed.state?.releases) ? parsed.state.releases.map(String).filter(Boolean) : [];
	const say = (condition, target, detail) => report.push({
		field: condition.field,
		op: condition.op,
		enabled: condition.enabled,
		target,
		detail
	});
	for (const condition of parsed.conditions) {
		const op = opOf(condition.op), name = nameOf(condition.field), values = valuesOf(condition);
		if (!condition.enabled) {
			say(condition, "skipped", "导出时已禁用，不参与筛选");
			continue;
		}
		if (op === "range") {
			const range = rangeOf(condition);
			if (name === "创建时间" && range) {
				query.created = `${tapdTime$1(range.from)}~${tapdTime$1(range.to)}`;
				say(condition, "api", `created=${query.created}（TAPD 时间区间）`);
			} else say(condition, "manual", "未知的时间区间字段，未生效");
			continue;
		}
		if (!values.length) {
			say(condition, "manual", "条件没有取值，未生效");
			continue;
		}
		switch (name) {
			case "发布计划": {
				const ids = releases.length ? releases : values.filter((value) => /^\d+$/.test(value));
				if (ids.length) {
					query.release_id = ids.join("|");
					say(condition, "api", `release_id=${query.release_id}（发布计划 ID）`);
				} else say(condition, "manual", "只有发布计划名称，导出里没有对应 ID，未生效");
				break;
			}
			case "优先级":
				query.priority_label = values.join("|");
				say(condition, "api", `priority_label=${query.priority_label}（中文优先级，用 | 取枚举）`);
				break;
			case "状态":
				if (op === "not_in") {
					const codes = values.map((value) => statusCodes[value] ?? value);
					if (codes.length > 1) {
						local.push({
							field: "status",
							op: "not_in",
							values: codes
						});
						say(condition, "local", `本地排除状态码 ${codes.join("、")}（中文名经 status_map 转义）`);
					} else {
						query.status = `<>${codes[0]}`;
						say(condition, "api", `status=<>${codes[0]}（状态中文名经 status_map 转义为状态码）`);
					}
				} else {
					query.v_status = values.join("|");
					say(condition, "api", `v_status=${query.v_status}（TAPD 支持中文状态名）`);
				}
				break;
			case "标签":
				if (op === "not_in") {
					local.push({
						field: "label",
						op: "not_in",
						values
					});
					say(condition, "local", `本地排除标签 ${values.join("、")}；TAPD 的 label=<> 会连无标签单子一起排除，语义不等价`);
				} else if (/OR/.test(condition.op) || /OR/.test(condition.field)) {
					query.label = `CONTAINS_OR<${values.join("|")}>`;
					say(condition, "api", `label=${query.label}`);
				} else {
					query.label = values.join("|");
					say(condition, "api", `label=${query.label}`);
				}
				break;
			case "标题":
				if (op === "not_like") {
					local.push({
						field: "title",
						op: "not_like",
						values
					});
					say(condition, "local", `本地排除标题含 ${values.join("、")} 的单子；TAPD 无 not-like，NOT_EQ 只排全等标题`);
				} else say(condition, "manual", "不支持的标题操作符，未生效");
				break;
			case "处理人": {
				const people = [...new Set(values.flatMap((value) => ownerGroups[value] ?? (/\d+\s*\.\d+|组/.test(value) ? [] : [value])))];
				if (people.length) {
					query.current_owner = `USER_OR<${people.join("|")}>`;
					say(condition, "api", `current_owner=USER_OR<${people.join("|")}>${values.some((value) => ownerGroups[value]) ? "（组名经成员映射展开）" : ""}`);
				} else {
					say(condition, "manual", `「${values.join("、")}」是组名，TAPD 的 current_owner 存人名；请在「组成员映射」里补成员后重新导入，否则此条件不生效（不会缩小范围）`);
					warnings.push(`处理人条件「${values.join("、")}」未生效：缺少组成员映射。`);
				}
				break;
			}
			default: {
				const field = fieldNames[name];
				if (!field) {
					say(condition, "manual", `未识别的字段「${name}」，未生效`);
					break;
				}
				const kept = values.filter((value) => value !== "--");
				if (!kept.length) {
					say(condition, "skipped", "取值只有空选项 --，无需筛选");
					break;
				}
				query[field] = kept.join("|");
				say(condition, "api", `${field}=${query[field]}（自定义字段「${name}」）`);
			}
		}
	}
	for (const item of report.filter((entry) => entry.target === "manual")) warnings.push(`${item.field}：${item.detail}`);
	const name = options.name ?? "filter-bug-1";
	return {
		query,
		local,
		report,
		warnings,
		schedule: TapdFilterScheduleSchema.parse({
			name,
			enabled: false,
			at: options.at ?? "02:00",
			maxPerRun: options.maxPerRun ?? 20,
			windowDays: options.windowDays ?? 2,
			query,
			local,
			report,
			page: parsed.page ?? "",
			exportedAt: parsed.exportedAt ?? ""
		}),
		watch: {
			name,
			workspace: "",
			type: "bug",
			item: "",
			status: "",
			owner: "",
			iteration: "",
			mode: "assigned",
			sweepOnly: true
		}
	};
}
/** Applies the local rules to one fetched item. `label` and `owner` come from the raw TAPD record. */
function matchesLocal(item, rules) {
	const label = item.label ?? "";
	const labelValues = label.split(/[|;；,，]/).map((value) => value.trim()).filter(Boolean);
	return rules.every((rule) => {
		if (!rule.values.length) return true;
		const values = rule.values.map((value) => value.toLowerCase());
		if (rule.field === "title") return rule.op === "not_like" ? values.every((value) => !item.title.toLowerCase().includes(value)) : values.some((value) => item.title.toLowerCase().includes(value));
		if (rule.field === "label") return rule.op === "not_in" ? values.every((value) => !labelValues.some((label) => label.toLowerCase() === value) && !label.toLowerCase().includes(value)) : values.some((value) => labelValues.some((label) => label.toLowerCase() === value));
		if (rule.field === "status") return rule.op === "not_in" ? values.every((value) => item.status.toLowerCase() !== value) : values.some((value) => item.status.toLowerCase() === value);
		const owners = item.owners.map((owner) => owner.toLowerCase());
		return rule.op === "in" ? values.some((value) => owners.some((owner) => owner.includes(value))) : values.every((value) => !owners.some((owner) => owner.includes(value)));
	});
}
/** A schedule is due when it is enabled, its local HH:MM has passed, and it has not run today. */
function sweepDue(schedule, now, lastRun) {
	if (!schedule.enabled) return false;
	if (lastRun === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`) return false;
	const minute = now.getHours() * 60 + now.getMinutes();
	const [hour = 0, minutePart = 0] = schedule.at.split(":").map(Number);
	return minute >= hour * 60 + minutePart;
}
const localDay$1 = (now) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
Object.freeze({
	story: "http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html",
	bug: "http://saroasisstudiosystem.saroasis.woa.com:9999/bug.html"
});
function collectTapdFilterRows() {
	if (location.href === "about:blank") return [];
	if (![
		"http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html",
		"http://saroasisstudiosystem.saroasis.woa.com:9999/bug.html",
		"http://saroasisstudiosystem.saroasis.woa.com:9999/bug/client.html"
	].includes(location.origin + location.pathname)) throw new Error("TAPD page redirected outside the permitted source");
	const root = document.querySelector("#storyFilterBody") || document.querySelector("#cvKpiLeftBody");
	if (!root) return [];
	const groupRows = [...root.querySelectorAll("tr.cvft-orgroup")];
	const cleanText = (element) => {
		const copy = element.cloneNode(true);
		copy.querySelectorAll(".x, .tick, .cnt").forEach((child) => child.remove());
		return copy.textContent.trim();
	};
	const readField = (element) => element?.tagName === "SELECT" ? element.selectedOptions[0]?.textContent.trim() : element?.textContent.trim();
	return [...root.querySelectorAll("table.cvft tr")].flatMap((tr) => {
		const cells = [...tr.children];
		const fieldCell = cells.find((cell) => cell.classList.contains("fld-cell"));
		if (!fieldCell) return [];
		const opCell = cells.find((cell) => cell.classList.contains("op-cell"));
		const field = readField(fieldCell.querySelector(".fld, select.cvft-edit")) || "";
		const op = readField(opCell?.querySelector(".op, select.cvft-edit")) || "";
		if (!field || !op) return [];
		const cell = cells[2];
		if (!cell) return [];
		const values = [...cell.querySelectorAll(".val-chip, .lblsel-box .lblsel-tag, .pchip.on")].map(cleanText).filter(Boolean);
		let range = [...cell.querySelectorAll("input[type=\"datetime-local\"], .ct-input[data-val]")].map((input) => input.getAttribute("data-val") ?? input.value ?? "");
		if (/介于|range/i.test(op) && !range.some(Boolean)) {
			const text = cell.textContent.trim().split(/\s*[~～]\s*/);
			if (text.length === 2 && text.every((value) => /^\d{4}-\d{2}-\d{2}/.test(value))) range = text;
		}
		if (!values.length && !/介于|range/i.test(op)) {
			const selected = [...cell.querySelectorAll("input[type=\"checkbox\"]:checked")].filter((input) => !input.hasAttribute("data-all"));
			for (const input of selected) {
				const label = input.closest("label")?.querySelector(".nm");
				if (label) values.push(label.textContent.trim());
			}
		}
		const sw = cells.find((td) => td.classList.contains("sw-cell"))?.querySelector(".cvft-sw");
		const group = tr.closest("tr.cvft-orgroup");
		return [{
			field,
			op,
			values: [...new Set(values)],
			range,
			enabled: !tr.classList.contains("cvft-row-off") && (!sw || sw.classList.contains("on")),
			...group ? { group: `or${groupRows.indexOf(group) + 1}` } : {}
		}];
	});
}
const TAPD_FILTER_READ_EXPRESSION = `(${collectTapdFilterRows.toString()})()`;
/** Readiness means all active rows have runtime values, not just a finished HTML load. */
function tapdFilterRowsReady(rows) {
	return Array.isArray(rows) && rows.length >= 2 && rows.some((row) => row.field === "发布计划" && row.values?.length) && rows.every((row) => row.enabled === false || /^(处理人|修复人)$/.test(row.field) || (/介于|range/i.test(row.op) ? row.range?.some(Boolean) : row.values?.length));
}
//#endregion
//#region src/sources/tapd-filter-schemes.ts
/**
* VsSaros addition (2026-11-17): TAPD filter schemes scraped from the Saroasis platform pages, and the
* "filter result pool" they feed. This module is pure: schemas, scraping/normalisation, the pool state
* machine and the daily run planner. No Host, HTTP or React dependency, so both the Host routes and
* the settings panel share exactly one contract.
*
* Two schemes (story + bug) are scraped from the platform's own condition cards. Matching items enter
* the pool disabled; a person enables the ones SuperAgent may fix. With `autoProcess` on, a daily run
* at `at` (default 02:00, the small-hours low-traffic window) plans at most `maxPerRun` of them.
* Every planned run carries a `runId` so a retry cannot dispatch the same item twice.
*/
function reconcilePoolState(state, inspect, now = /* @__PURE__ */ new Date()) {
	return {
		...state,
		records: Object.fromEntries(Object.entries(state.records ?? {}).map(([key, record]) => {
			if (record.dispatching && now.getTime() - Date.parse(record.lastRunAt) < 12e4) return [key, record];
			const intake = inspect(record.triggerId);
			return [key, intake ? {
				...record,
				dispatching: false,
				state: intake.state,
				intake,
				lastRunAt: intake.at ?? record.lastRunAt
			} : record.dispatching ? {
				...record,
				dispatching: false,
				state: "failed"
			} : record];
		}))
	};
}
const poolItemKey = (workspace, owner, item) => `${workspace}:${owner}:${item.kind}:${item.id}`;
function poolWithRuntime(pool, workspace, state) {
	return {
		...pool,
		items: pool.items.map((item) => {
			const record = state?.records?.[poolItemKey(workspace, pool.owner, item)];
			return record ? {
				...item,
				state: record.state,
				runId: record.runId,
				lastRunAt: record.lastRunAt,
				attempts: record.attempts,
				detail: record.intake?.detail,
				phase: record.intake?.phase,
				ticketId: record.intake?.ticketId,
				retryable: record.intake?.retryable
			} : item;
		})
	};
}
const FILTER_SCHEME_SOURCES = [{
	kind: "story",
	name: "filter-story-1",
	url: "http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html",
	script: ""
}, {
	kind: "bug",
	name: "filter-bug-1",
	url: "http://saroasisstudiosystem.saroasis.woa.com:9999/bug.html",
	script: "http://saroasisstudiosystem.saroasis.woa.com:9999/assets/bugview.js"
}];
const STORY_DUE_DEFAULT = {
	from: "2024-01-09T00:00:00",
	to: "2026-09-30T23:59:59"
};
/** TAPD range bounds are wall-clock times, not instants: never shift them through a timezone. */
function filterDateTime(value) {
	const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(value.trim());
	if (!match) return "";
	const date = match[1], time = match[2] ?? "00:00", seconds = match[3];
	const stamp = `${date}T${time}:${seconds ?? "00"}`;
	const parsed = /* @__PURE__ */ new Date(`${stamp}Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== stamp) return "";
	return `${date}T${time}${seconds === void 0 ? "" : `:${seconds}`}`;
}
function conditionRange(value) {
	const range = Array.isArray(value) ? {
		from: value[0] ?? "",
		to: value[1] ?? ""
	} : value;
	return {
		from: filterDateTime(range.from),
		to: filterDateTime(range.to)
	};
}
const FilterConditionSchema = object({
	field: string().trim().min(1),
	op: string().trim().min(1),
	enabled: boolean().default(true),
	value: union([array(string()), object({
		from: string(),
		to: string()
	}).strict()]).default([]),
	/** Non-empty marks a row inside an OR subgroup; rows outside are joined with a fixed AND. */
	group: string().trim().optional(),
	/** The owner row is system-owned: the current user replaces whatever the platform page showed. */
	locked: boolean().default(false)
}).strict();
const TapdFilterSchemeSchema = object({
	name: string().trim().regex(/^[\w.-]{1,40}$/),
	kind: _enum(["story", "bug"]),
	url: string().trim(),
	capturedAt: string().default(""),
	hash: string().default(""),
	/** `live` = conditions parsed from the page; `fallback` = built-in baseline because the page was unreachable. */
	source: _enum(["live", "fallback"]).default("fallback"),
	conditions: array(FilterConditionSchema).default([])
}).strict();
const PoolItemSchema = object({
	id: string().trim().min(1),
	kind: _enum(["story", "bug"]),
	title: string().default(""),
	priority: string().default(""),
	status: string().default(""),
	scheme: string().default(""),
	hit: string().default(""),
	/** A person must opt each item in; scraped candidates arrive disabled. */
	enabled: boolean().default(false),
	state: _enum([
		"pending",
		"queued",
		"processing",
		"done",
		"failed"
	]).default("pending"),
	detail: string().optional(),
	phase: _enum([
		"delivery",
		"evaluation",
		"working",
		"person",
		"rejected",
		"ended"
	]).optional(),
	ticketId: string().optional(),
	retryable: boolean().optional(),
	runId: string().default(""),
	lastRunAt: string().default(""),
	attempts: number().int().min(0).default(0)
}).strict();
const TapdFilterPoolSchema = object({
	name: string().trim().regex(/^[\w.-]{1,40}$/).default("filter-pool-1"),
	items: array(PoolItemSchema).default([]),
	/** Off until a person turns it on: the pool alone never dispatches anything. */
	autoProcess: boolean().default(false),
	/** Local HH:MM; the small-hours default avoids the 00:00 day rollover and service warm-up. */
	at: string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("02:00"),
	maxPerRun: number().int().min(1).max(200).default(20),
	processedToday: number().int().min(0).default(0),
	lastRun: string().default(""),
	/** The current user (TOF login name) that replaces every owner condition. */
	owner: string().default("")
}).strict();
/** Stable, dependency-free fingerprint; identical conditions never rewrite a saved scheme. */
function schemeHash(conditions) {
	const text = JSON.stringify(conditions);
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
/** Chinese display operators -> the internal operator names used by the condition compiler. */
function normaliseOp(raw) {
	if (/不属于|not in/i.test(raw)) return "not_in";
	if (/不包含|not like/i.test(raw)) return "not_like";
	if (/介于|range/i.test(raw)) return "range";
	return "in";
}
/**
* The platform pages declare their condition rows as `{ field:'…', op:'…', … }` (story/main.html's
* `storyFilterRows()` and bugview.js's `FilterCard.render`). Reading those declarations is the
* no-browser way to scrape the live condition set; a page that exposes a structured export hook
* (`window.__VSSAROS_TAPD_FILTERS__`) wins over the declaration parser.
*/
function parseScrapedConditions(text, kind) {
	const hook = /__VSSAROS_TAPD_FILTERS__\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text);
	if (hook) try {
		const parsed = JSON.parse(hook[1] ?? "{}");
		const found = array(FilterConditionSchema).safeParse(parsed.conditions);
		if (found.success && found.data.length) return found.data;
	} catch {}
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const pattern = /\{\s*field\s*:\s*'([^']+)'\s*,\s*op\s*:\s*'([^']+)'/g;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const field = (match[1] ?? "").trim(), op = (match[2] ?? "").trim(), key = `${field}|${op}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(FilterConditionSchema.parse({
			field,
			op,
			enabled: true,
			value: []
		}));
	}
	if (kind === "bug") {
		for (const condition of out) if (condition.field === "优先级" || /OR/.test(condition.field)) condition.group = "or1";
	}
	return out;
}
/**
* Executed inside a real browser tab (CDP `Runtime.evaluate`), this reads the *rendered* filter card:
* field, operator, value chips / datetime range, the per-row switch and the OR subgroup. Static HTML
* cannot carry any of these, because both platform pages build the card with JavaScript at runtime.
*/
const CDP_DOM_EXPRESSION = `JSON.stringify(${TAPD_FILTER_READ_EXPRESSION})`;
const DomRowSchema = object({
	field: string().trim().min(1),
	op: string().trim().min(1),
	values: array(string()).default([]),
	range: array(string()).default([]),
	enabled: boolean().default(true),
	group: string().trim().optional()
});
const OP_LABEL = {
	in: "属于 (In)",
	notin: "不属于 (Not In)",
	like: "包含 (Like)",
	notlike: "不包含 (Not Like)",
	range: "介于 (Range)",
	note: "固定"
};
/** Normalises the rendered DOM rows into the same condition contract as the static scraper. */
function parseDomConditions(raw) {
	const parsed = array(DomRowSchema).safeParse(raw);
	if (!parsed.success) return [];
	return parsed.data.map((row) => FilterConditionSchema.parse({
		field: row.field,
		op: OP_LABEL[row.op] ?? row.op,
		enabled: row.enabled,
		value: normaliseOp(OP_LABEL[row.op] ?? row.op) === "range" ? conditionRange(row.range.length ? row.range : row.values) : row.values,
		...row.group ? { group: row.group } : {}
	}));
}
/** Built-in baseline, used when the platform pages cannot be reached or declare no conditions. */
function fallbackConditions(kind) {
	return (kind === "story" ? [
		{
			field: "发布计划",
			op: "属于 (In)",
			value: ["PC-RushCBT3"]
		},
		{
			field: "处理人",
			op: "属于 (In)",
			value: []
		},
		{
			field: "状态",
			op: "属于 (In)",
			value: ["新建", "开发中"]
		},
		{
			field: "标签",
			op: "不属于 (Not In)",
			value: ["CBT3移除", "延期合入"]
		},
		{
			field: "预计完成时间",
			op: "介于 (Range)",
			value: { ...STORY_DUE_DEFAULT }
		}
	] : [
		{
			field: "发布计划",
			op: "属于 (In)",
			value: ["PC-RushCBT3"]
		},
		{
			field: "优先级",
			op: "属于 (In)",
			value: [
				"紧急",
				"高",
				"中",
				"低"
			],
			group: "or1"
		},
		{
			field: "标签（OR 口径）",
			op: "属于 (In)",
			value: ["必修bug"],
			group: "or1"
		},
		{
			field: "所属分支",
			op: "属于 (In)",
			value: ["release", "Beta_Test"]
		},
		{
			field: "状态（属于）",
			op: "属于 (In)",
			value: [
				"新建",
				"修复中",
				"重新打开"
			]
		},
		{
			field: "状态（不属于）",
			op: "不属于 (Not In)",
			value: ["挂起"]
		},
		{
			field: "处理人",
			op: "属于 (In)",
			value: []
		},
		{
			field: "标题",
			op: "不包含 (Not Like)",
			value: ["【Crash】", "【XScan】"]
		},
		{
			field: "创建时间",
			op: "介于 (Range)",
			value: {
				from: "",
				to: ""
			}
		}
	]).map((row) => FilterConditionSchema.parse({
		...row,
		enabled: true
	}));
}
/**
* Every owner condition becomes the current user's TOF account and is locked. If the page had no
* owner row, one is added, so a scheme always narrows work to the person using this Host.
*/
function applyOwnerOverride(conditions, owner) {
	const list = conditions.map((condition) => condition.field === "处理人" || condition.field === "修复人" ? {
		...condition,
		value: owner ? [owner] : [],
		enabled: true,
		locked: true
	} : condition);
	if (!owner || list.some((condition) => condition.field === "处理人")) return list;
	list.push(FilterConditionSchema.parse({
		field: "处理人",
		op: "属于 (In)",
		value: [owner],
		enabled: true,
		locked: true
	}));
	return list;
}
/** Compile OR groups as branch queries; their union must be filtered and deduplicated before intake. */
function compileSchemeBranches(scheme, options = {}) {
	const active = scheme.conditions.filter((condition) => condition.enabled);
	const owner = active.find((condition) => /^(处理人|修复人)$/.test(condition.field) && Array.isArray(condition.value) && condition.value.some((value) => value.trim()));
	if (!owner) throw new Error("处理人条件缺失，拒绝宽口径查询");
	const groups = /* @__PURE__ */ new Map();
	const common = [];
	for (const condition of active) if (condition.group && condition !== owner) groups.set(condition.group, [...groups.get(condition.group) ?? [], condition]);
	else common.push(condition);
	let branches = [common];
	for (const group of groups.values()) {
		branches = branches.flatMap((branch) => group.map((condition) => [...branch, condition]));
		if (branches.length > 16) throw new Error("OR 条件组合超过 16，请收窄方案");
	}
	return branches.map((conditions) => {
		const query = {}, local = [];
		for (const condition of conditions) {
			const field = condition.field.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
			const op = normaliseOp(condition.op);
			if (op === "range" || !Array.isArray(condition.value)) {
				const range = Array.isArray(condition.value) ? {
					from: condition.value[0] ?? "",
					to: condition.value[1] ?? ""
				} : condition.value;
				if (!range.from && !range.to) continue;
				const format = (value) => {
					const normalized = filterDateTime(value);
					if (!normalized) throw new Error(`${field}时间格式无效：${value}`);
					return normalized.replace("T", " ") + (normalized.length === 16 ? ":00" : "");
				};
				if (!["创建时间", "预计完成时间"].includes(field)) throw new Error(`不支持的时间字段：${field}`);
				const from = format(range.from || "1970-01-01T00:00"), to = format(range.to || "2099-12-31T23:59");
				if (from > to) throw new Error(`${field}开始时间不能晚于结束时间`);
				query[field === "创建时间" ? "created" : "due"] = `${from}~${to}`;
				continue;
			}
			let values = condition.value.filter((value) => value.trim());
			if (!values.length) throw new Error(`${field}没有取值，请配置或停用此条件`);
			if (field === "发布计划") {
				values = values.map((value) => /^\d+$/.test(value) ? value : options.releaseIds?.[value] ?? "");
				if (values.some((value) => !value)) throw new Error("发布计划名称未映射到 ID，请同步字典或填写发布计划 ID");
			}
			if (field === "标题" && op === "in") {
				query.title = `CONTAINS_OR<${values.join("|")}>`;
				continue;
			}
			if (op === "not_in" && !["标签", "状态"].includes(field)) throw new Error(`${field}暂不支持排除操作，未进行查询`);
			const result = importTapdFilter({ conditions: [{
				...condition,
				field: field === "修复人" ? "处理人" : condition.field,
				value: values
			}] }, options);
			if (result.warnings.length) throw new Error(result.warnings.join("；"));
			Object.assign(query, result.query);
			local.push(...result.local);
		}
		if (scheme.kind === "story" && query.current_owner) {
			query.owner = query.current_owner;
			delete query.current_owner;
		}
		return {
			query,
			local
		};
	});
}
/** Scraped candidates are merged, never duplicated; existing enable/state/runId always survive. */
function mergeIntoPool(pool, candidates) {
	const byId = new Map(pool.items.map((item) => [`${item.kind}:${item.id}`, { ...item }]));
	for (const candidate of candidates) {
		const key = `${candidate.kind}:${candidate.id}`, known = byId.get(key);
		byId.set(key, known ? {
			...known,
			title: candidate.title,
			priority: candidate.priority,
			status: candidate.status,
			scheme: candidate.scheme,
			hit: candidate.hit
		} : PoolItemSchema.parse({
			...candidate,
			enabled: false,
			state: "pending"
		}));
	}
	return {
		...pool,
		items: [...byId.values()]
	};
}
const localDay = (now) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
/** A daily run is due once per local day, at or after `at`, only while auto processing is on. */
function poolDue(pool, now) {
	if (!pool.autoProcess || pool.lastRun === localDay(now)) return false;
	const minute = now.getHours() * 60 + now.getMinutes();
	const [hour = 0, minutePart = 0] = pool.at.split(":").map(Number);
	return minute >= hour * 60 + minutePart;
}
/** Plans enabled pending/failed items, bounded by `maxPerRun`; `runId` makes retries idempotent. */
function planPoolRun(pool, now = /* @__PURE__ */ new Date()) {
	const day = localDay(now);
	const eligible = pool.items.filter((item) => item.enabled && (item.state === "pending" || item.state === "failed" && item.retryable !== false));
	const items = eligible.slice(0, pool.maxPerRun);
	return {
		runId: `${day}-${schemeHash(items.map((item) => ({
			field: item.id,
			op: "",
			enabled: true,
			value: [],
			locked: false
		})))}`,
		day,
		items,
		capped: eligible.length > items.length
	};
}
//#endregion
//#region src/sources/tapd-auth.ts
/**
* VsSaros addition: TAPD Open API credentials, aligned with SaroasisStudioSystem's `.env` contract.
*
* That platform (lib/tapd.js, .env.example) accepts three credential pairs in priority order and loads them
* from a local `.env`. The Host here reads the same variable names, so an existing `.env` can be pointed at
* with DSH_SUPERAGENT_TAPD_ENV_FILE instead of exporting secrets into the IDE process. Only whitelisted
* TAPD keys are taken from the file, it never overrides an existing environment value, and it is read lazily
* (not at module load) so a late-loaded credential is still picked up. The Executor never sees these values.
* VsSaros also ships an API account (BUNDLED_TAPD_CREDENTIALS) as the lowest-priority source, so a fresh install
* reads TAPD without setup; a file, the settings panel, or the Host environment still wins.
*/
/** The only keys a credentials file may contribute; nothing else in an `.env` reaches the Host. */
const KEYS = [
	"DSH_SUPERAGENT_TAPD_BEARER",
	"DSH_SUPERAGENT_TAPD_USER",
	"DSH_SUPERAGENT_TAPD_PASSWORD",
	"DSH_SUPERAGENT_TAPD_TIMEOUT_MS",
	"TAPD_CLIENT_ID",
	"TAPD_CLIENT_SECRET",
	"TAPD_API_USER",
	"TAPD_API_PWD",
	"TAPD_API_TOKEN",
	"TAPD_HTTP_TIMEOUT_MS",
	"TAPD_WORKSPACE_ID",
	"DSH_SUPERAGENT_TAPD_BUNDLED"
];
/** The key the panel writes to disable the shipped account; it is not a credential and is never replaced by a save. */
const BUNDLED_KEY = "DSH_SUPERAGENT_TAPD_BUNDLED";
const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i;
/**
* VsSaros addition: the TAPD Open API account shipped with the product, so an installed VsSaros can read TAPD
* without any per-machine setup. It is the *lowest*-priority source: a credentials file, the settings panel, or
* Host environment variables all override it. Set `DSH_SUPERAGENT_TAPD_BUNDLED=off` to turn it off entirely.
* The secret is only ever read by the Host (it is compiled into `lib/`, which is in the package's `files`).
*/
const BUNDLED_TAPD_CREDENTIALS = {
	TAPD_CLIENT_ID: "tapd-app-889817",
	TAPD_CLIENT_SECRET: "6E9C1B81-5443-6CFC-0D84-27C8DAEDB6FB"
};
/** The shipped account, unless the Host environment or the credentials file disables it (no IDE restart needed for the file). */
function bundledTapdEnv(base = process.env) {
	const fromFile = readTapdEnvFile(tapdEnvFile(base), base)[BUNDLED_KEY];
	return (base[BUNDLED_KEY] || fromFile || "").trim().toLowerCase() === "off" ? {} : BUNDLED_TAPD_CREDENTIALS;
}
/** Explicit override, else `<DSH_HOME>/tapd.env`, else `~/.dsh/tapd.env`. */
function tapdEnvFile(env = process.env) {
	const explicit = env.DSH_SUPERAGENT_TAPD_ENV_FILE?.trim();
	if (explicit) return explicit;
	return join(env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "tapd.env");
}
let cached;
/** Test hook: forget the cached credentials file. */
function resetTapdEnvCache() {
	cached = void 0;
}
/** Parses `KEY=VALUE` lines with quotes and `#` comments, keeping only whitelisted keys. */
function parseTapdEnv(text) {
	const values = {};
	for (const line of text.split(/\r?\n/)) {
		const match = LINE.exec(line);
		if (!match) continue;
		const key = match[1].toUpperCase();
		if (!KEYS.includes(key)) continue;
		let value = match[2] ?? "";
		if (value.startsWith("\"") && value.endsWith("\"") || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
		values[key] = value;
	}
	return values;
}
/** Parses `KEY=VALUE` with quotes and `#` comments; skips unknown keys and existing environment values. */
function readTapdEnvFile(file, base = process.env) {
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return {};
	}
	if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.values;
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {};
	}
	const values = Object.fromEntries(Object.entries(parseTapdEnv(text)).filter(([key]) => base[key] === void 0));
	cached = {
		file,
		mtimeMs,
		values
	};
	return values;
}
/** The shipped account, then the local credentials file, then the Host environment (each overrides the last). */
function tapdEnvironment(base = process.env) {
	const file = tapdEnvFile(base);
	return {
		...bundledTapdEnv(base),
		...readTapdEnvFile(file, base),
		...base
	};
}
const basic = (user, password, method) => ({
	header: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
	method
});
/**
* Five accepted sources, highest priority first: the two native SuperAgent variables (an explicit choice for
* this Host), then the three used by SaroasisStudioSystem (client_id/secret is the recommended enterprise
* API account: full permissions, no token exchange and no IP allowlist).
*/
function tapdCredential(env) {
	if (env.DSH_SUPERAGENT_TAPD_BEARER) return {
		header: `Bearer ${env.DSH_SUPERAGENT_TAPD_BEARER}`,
		method: "Bearer DSH_SUPERAGENT_TAPD_BEARER"
	};
	if (env.DSH_SUPERAGENT_TAPD_USER && env.DSH_SUPERAGENT_TAPD_PASSWORD) return basic(env.DSH_SUPERAGENT_TAPD_USER, env.DSH_SUPERAGENT_TAPD_PASSWORD, "Basic DSH_SUPERAGENT_TAPD_USER/PASSWORD");
	if (env.TAPD_CLIENT_ID && env.TAPD_CLIENT_SECRET) return basic(env.TAPD_CLIENT_ID, env.TAPD_CLIENT_SECRET, "Basic TAPD_CLIENT_ID/SECRET (API account)");
	if (env.TAPD_API_USER && env.TAPD_API_PWD) return basic(env.TAPD_API_USER, env.TAPD_API_PWD, "Basic TAPD_API_USER/PWD");
	if (env.TAPD_API_TOKEN) return {
		header: `Bearer ${env.TAPD_API_TOKEN}`,
		method: "Bearer TAPD_API_TOKEN"
	};
}
/** Request timeout, with a 3s floor (a hung TAPD socket otherwise wedges every later poll). */
function tapdTimeoutMs(env) {
	const raw = env.DSH_SUPERAGENT_TAPD_TIMEOUT_MS ?? env.TAPD_HTTP_TIMEOUT_MS;
	const parsed = Number.parseInt(String(raw ?? ""), 10);
	return Math.max(3e3, Number.isFinite(parsed) && parsed > 0 ? parsed : 3e4);
}
/** What to show when nothing is configured (only possible with the shipped account turned off). */
function tapdCredentialsHint(env = process.env) {
	return "No TAPD Open API credentials in the Host (the shipped account is off). Set one of: DSH_SUPERAGENT_TAPD_BEARER; DSH_SUPERAGENT_TAPD_USER + DSH_SUPERAGENT_TAPD_PASSWORD; TAPD_CLIENT_ID + TAPD_CLIENT_SECRET (recommended); TAPD_API_USER + TAPD_API_PWD; TAPD_API_TOKEN. Or put them as KEY=VALUE in " + tapdEnvFile(env) + " (or point DSH_SUPERAGENT_TAPD_ENV_FILE at an existing .env). Remove DSH_SUPERAGENT_TAPD_BUNDLED=off to use the account shipped with VsSaros. Credentials stay in the Host; Executors cannot read them.";
}
/** The file keys of each kind the panel offers: an account name (none for a token) and its secret. */
const TAPD_CREDENTIAL_KEYS = {
	client: {
		id: "TAPD_CLIENT_ID",
		secret: "TAPD_CLIENT_SECRET"
	},
	user: {
		id: "TAPD_API_USER",
		secret: "TAPD_API_PWD"
	},
	token: { secret: "TAPD_API_TOKEN" }
};
/** Every credential key; saving replaces all of them so a stale, higher-priority one cannot win over the new one. */
const CREDENTIAL_KEYS = [
	"DSH_SUPERAGENT_TAPD_BEARER",
	"DSH_SUPERAGENT_TAPD_USER",
	"DSH_SUPERAGENT_TAPD_PASSWORD",
	"TAPD_CLIENT_ID",
	"TAPD_CLIENT_SECRET",
	"TAPD_API_USER",
	"TAPD_API_PWD",
	"TAPD_API_TOKEN"
];
/** A credential the panel cannot save as given (missing, unknown kind, or a value that would break the file); answered with 400. */
var TapdCredentialError = class extends Error {};
const mask = (value) => value.length <= 6 ? "•".repeat(value.length) : `${value.slice(0, 3)}…${value.slice(-2)}`;
function fileValues(file) {
	try {
		return parseTapdEnv(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}
function fileKind(values) {
	return Object.keys(TAPD_CREDENTIAL_KEYS).find((kind) => {
		const keys = TAPD_CREDENTIAL_KEYS[kind];
		return !!values[keys.secret] && (!keys.id || !!values[keys.id]);
	});
}
/** The credential status the panel shows; it never carries a secret. */
function tapdCredentialStatus(base = process.env) {
	const file = tapdEnvFile(base);
	const values = fileValues(file);
	const bundled = bundledTapdEnv(base);
	const fromEnv = tapdCredential(base);
	const fromFile = tapdCredential({
		...bundled,
		...values
	});
	const effective = tapdCredential({
		...bundled,
		...values,
		...base
	});
	const fromEnvInUse = !!effective && !!fromEnv && effective.header === fromEnv.header;
	const fromFileInUse = !!effective && !fromEnvInUse && !!tapdCredential(values) && effective.header === fromFile?.header;
	const source = !effective ? "none" : fromEnvInUse ? "environment" : fromFileInUse ? "file" : "bundled";
	const saved = !!tapdCredential(values);
	const kind = fileKind(values) ?? (source === "bundled" ? "client" : void 0);
	const id = kind && TAPD_CREDENTIAL_KEYS[kind].id;
	const account = source === "bundled" && BUNDLED_TAPD_CREDENTIALS.TAPD_CLIENT_ID ? mask(BUNDLED_TAPD_CREDENTIALS.TAPD_CLIENT_ID) : id && values[id] ? mask(values[id]) : void 0;
	return {
		configured: !!effective,
		...effective ? { method: effective.method } : {},
		source,
		file,
		saved,
		bundled: Object.keys(bundled).length > 0,
		...kind ? { kind } : {},
		...account ? { account } : {},
		overridden: fromEnvInUse && !!tapdCredential(values)
	};
}
const SAFE = /^[^\r\n"'\0]{1,512}$/;
/**
* Writes one credential to the Host's credentials file, replacing every credential key there and keeping the other lines
* (timeouts, workspace, comments). An empty `id` or `secret` keeps the file's current value of the same kind, so the
* secret need not be typed again to change the account name; `clear` removes the credential keys only.
*/
async function saveTapdCredential(input, base = process.env) {
	const file = tapdEnvFile(base);
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {}
	const current = parseTapdEnv(text);
	const kept = text.split(/\r?\n/).filter((line) => {
		const key = LINE.exec(line)?.[1]?.toUpperCase();
		return !key || !CREDENTIAL_KEYS.includes(key) && key !== BUNDLED_KEY;
	});
	while (kept.length && kept.at(-1) === "") kept.pop();
	const lines = [...kept];
	const onlySwitch = input.bundled !== void 0 && !input.kind && !input.id && !input.secret && !input.clear;
	if (!input.clear && !onlySwitch) {
		const kind = input.kind;
		if (!kind || !(kind in TAPD_CREDENTIAL_KEYS)) throw new TapdCredentialError("Choose a TAPD credential kind");
		const keys = TAPD_CREDENTIAL_KEYS[kind];
		const same = fileKind(current) === kind;
		const id = input.id?.trim() || (same && keys.id ? current[keys.id] ?? "" : "");
		const secret = input.secret?.trim() || (same ? current[keys.secret] ?? "" : "");
		if (keys.id && !id) throw new TapdCredentialError("Enter the TAPD account name");
		if (!secret) throw new TapdCredentialError("Enter the TAPD secret");
		for (const value of keys.id ? [id, secret] : [secret]) if (!SAFE.test(value)) throw new TapdCredentialError("A TAPD credential may not contain quotes or line breaks and is at most 512 characters");
		if (!kept.some((line) => line.includes("dsh-superagent"))) lines.unshift("# TAPD Open API credentials for dsh-superagent (written by its settings panel).");
		if (keys.id) lines.push(`${keys.id}=${id}`);
		lines.push(`${keys.secret}=${secret}`);
	}
	if ((input.bundled ?? (String(current[BUNDLED_KEY] ?? "").trim().toLowerCase() === "off" ? "off" : "on")) === "off") lines.push(`${BUNDLED_KEY}=off`);
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(temporary, lines.length ? `${lines.join("\n")}\n` : "", {
		encoding: "utf8",
		mode: 384
	});
	for (let attempt = 0;; attempt++) try {
		await rename(temporary, file);
		break;
	} catch (error) {
		const code = error.code;
		if (attempt >= 2 || ![
			"EPERM",
			"EACCES",
			"EBUSY"
		].includes(code ?? "")) throw error;
		await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
	}
	await chmod(file, 384).catch(() => {});
	resetTapdEnvCache();
	return tapdCredentialStatus(base);
}
//#endregion
//#region src/sources/tapd-api.ts
/**
* VsSaros addition: reading and commenting on TAPD stories, bugs and tasks through TAPD's Open API
* (`https://api.tapd.cn` by default). Credentials are resolved by `tapd-auth.ts` in the Host only; the
* MCP/mcporter-internal transport was retired in 0.1.81, and the settings keys it used are kept solely
* so settings saved by older versions still parse. Records come back as plain objects of strings.
*/
const TAPD_SOURCE = "tapd";
const TAPD_TYPES = [
	"story",
	"bug",
	"task"
];
const COLLECTION = {
	story: {
		path: "stories",
		record: "Story",
		entry: "stories",
		page: "prong/stories/view"
	},
	bug: {
		path: "bugs",
		record: "Bug",
		entry: "bug",
		page: "bugtrace/bugs/view"
	},
	task: {
		path: "tasks",
		record: "Task",
		entry: "tasks",
		page: "prong/tasks/view"
	}
};
const TapdConfigSchema = object({
	/** Deprecated and ignored: the MCP transport was retired. Kept so older saved settings still parse. */
	transport: _enum(["openapi", "mcp"]).default("openapi"),
	api: string().trim().regex(/^https:\/\/[^\s/]+(\/[^\s]*)?$/).default("https://api.tapd.cn"),
	site: string().trim().regex(/^https:\/\/[^\s/]+$/).default("https://www.tapd.cn"),
	/** Deprecated and ignored (MCP CLI). Kept so older saved settings still parse. */
	cli: string().trim().default(""),
	/** Deprecated and ignored (MCP server). Kept so older saved settings still parse. */
	server: string().trim().regex(/^[\w.-]+$/).default("tapd"),
	/** TAPD `workspace_id`; every watch without its own inherits this. GR is the default. */
	workspace: string().trim().regex(/^\d+$/).default("68880148"),
	/** Deprecated and ignored (the retired intranet member endpoint). Kept so older saved settings still parse. */
	memberApi: string().trim().default(""),
	/** WeCom alias -> TAPD Chinese name; the only identity mapping the Open API Source uses. */
	members: array(object({
		alias: string().trim().min(1),
		name: string().trim().min(1)
	}).strict()).default([]),
	/** Optional TAPD identity: a person's Chinese name or a robot account's name, as TAPD writes `owner`/`current_owner`
	* and as people @ in comments. It is not a query parameter; it only recognises what addresses SuperAgent and signs
	* replies. Empty: no identity matching, and replies are signed `dsh-superagent`. */
	agent: string().trim().default(""),
	watches: array(object({
		name: string().trim().regex(/^[\w.-]{1,40}$/),
		/** Empty: inherit the Source-level `workspace`. */
		workspace: string().trim().regex(/^\d*$/).default(""),
		type: _enum(TAPD_TYPES),
		/** One item's ID: the watch follows that item alone. Empty: a list, by the filters below. */
		item: string().trim().regex(/^\d*$/).default(""),
		status: string().trim().default(""),
		owner: string().trim().default(""),
		iteration: string().trim().regex(/^\d*$/).default(""),
		/** `assigned`: only what is assigned to `agent`, or @s it; `all`: every change, which the Policy's admission table decides. */
		mode: _enum(["assigned", "all"]).default("assigned"),
		/** An imported daily-sweep watch is a filter container, not a change listener: `pollRound` skips it. */
		sweepOnly: boolean().optional()
	}).strict()).default([]),
	/** Legacy daily sweeps from the retired JSON import; kept so older saved settings still parse. */
	filterSchedules: array(TapdFilterScheduleSchema).default([]),
	/** Story + bug filter schemes scraped from the Saroasis platform pages. */
	filterSchemes: array(TapdFilterSchemeSchema).default([]),
	/** The candidate pool: enabled items are the only ones an automatic daily run may fix. */
	filterPool: TapdFilterPoolSchema.default(TapdFilterPoolSchema.parse({})),
	/** Owner group name -> TAPD person names, so an exported group can become `current_owner=USER_OR<...>`. */
	ownerGroups: array(object({
		group: string().trim().min(1),
		members: string().trim().min(1)
	}).strict()).default([]),
	/** Optional TAPD Webhook ingress: a fast lane on top of polling, off by default. TAPD POSTs to
	* `/orchestrator/webhook/tapd`; the event carries IDs only, so the item is reread before it is received. */
	webhook: boolean().default(false),
	/** The shared secret TAPD sends as the `secret` field (or `x-tapd-secret` header / `secret` query); required while on. */
	webhookSecret: string().trim().default(""),
	pollSeconds: number().int().min(60).max(3600).default(120),
	failuresBeforeError: number().int().min(1).max(20).default(3)
}).strict();
/** A watch (project/type/filters) and the account credentials are enough; the identity name is optional. */
const tapdConfigured = (config) => config.watches.length > 0 || config.filterSchemes.length > 0 || config.filterPool.items.length > 0;
/** A watch's own workspace ID, or the Source-level default (GR project) when the watch leaves it empty. */
const watchWorkspace = (config, watch) => watch.workspace || config.workspace;
/** TAPD writes times as `YYYY-MM-DD HH:mm:ss` in China time; this is the same instant in ISO form. */
const tapdInstant = (time) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(time) ? (/* @__PURE__ */ new Date(`${time.replace(" ", "T")}+08:00`)).toISOString() : time;
/** An instant as TAPD writes times, in China time. */
const tapdTime = (iso) => new Date(Date.parse(iso) + 288e5).toISOString().slice(0, 19).replace("T", " ");
/** Plain text of a TAPD rich-text field (HTML), with paragraphs and line breaks kept. */
function plainText(html) {
	return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const names = (value) => (value ?? "").split(/[;,；]/).map((name) => name.trim()).filter(Boolean);
function itemOf(type, record) {
	return {
		type,
		workspace: record.workspace_id ?? "",
		id: record.id ?? "",
		title: record.name ?? record.title ?? "",
		description: plainText(record.description ?? ""),
		status: record.status ?? "",
		owners: names(type === "bug" ? record.current_owner : record.owner),
		creator: record.creator ?? record.reporter ?? "",
		created: tapdInstant(record.created ?? ""),
		modified: tapdInstant(record.modified ?? record.created ?? ""),
		iteration: record.iteration_id ?? "",
		label: record.label ?? "",
		priority: record.priority_label ?? record.priority ?? ""
	};
}
const commentOf = (record) => ({
	id: record.id ?? "",
	author: record.author ?? "",
	text: plainText(record.description ?? ""),
	created: tapdInstant(record.created ?? ""),
	modified: tapdInstant(record.modified ?? record.created ?? "")
});
const itemPage = (site, item) => `${site}/${item.workspace}/${COLLECTION[item.type].page}/${item.id}`;
/** Parses the page of a story, bug or task on any TAPD site. */
function itemAddress(url) {
	const text = url.trim();
	for (const pattern of [/^https?:\/\/[^/]*tapd[^/]*\/(?:tapd_fe\/)?(\d+)\/(prong\/stories|bugtrace\/bugs|prong\/tasks)\/view\/(\d+)(?=\/?(?:[?#]|$))/i, /^https?:\/\/[^/]*tapd[^/]*\/(?:tapd_fe\/)?(\d+)\/(bug|bugs|story|stories|task|tasks)\/(?:detail|view)\/(\d+)(?=\/?(?:[?#]|$))/i]) {
		const match = pattern.exec(text);
		if (!match) continue;
		const path = match[2].toLowerCase();
		return {
			type: path.includes("stor") ? "story" : path.includes("bug") ? "bug" : "task",
			workspace: match[1],
			id: match[3]
		};
	}
}
/** TAPD failed to answer; `gone` when the item no longer exists, which a reply should not retry. */
var TapdError = class extends Error {
	gone;
	constructor(message, gone = false) {
		super(message);
		this.gone = gone;
	}
};
/**
* Strips the envelopes TAPD data comes in: an MCP tool result (`content[].text` or `structuredContent`), TAPD's own
* `{ status, data, info }`, and the one-key `{ Story: {...} }` wrapper of each record.
*/
function records(value) {
	let current = value;
	for (let depth = 0; depth < 6; depth++) {
		if (typeof current === "string") {
			const text = current;
			try {
				current = JSON.parse(text);
			} catch {
				throw new TapdError(text.slice(0, 500));
			}
			continue;
		}
		if (Array.isArray(current)) break;
		if (!current || typeof current !== "object") return [];
		const object = current;
		if (typeof object.data === "string" && /Hello world from TAPD API/i.test(object.data)) throw new TapdError("TAPD answered \"Hello world from TAPD API\": the API path does not exist");
		if (object.isError === true) throw new TapdError(JSON.stringify(object.content ?? object).slice(0, 500));
		if (Array.isArray(object.content) && object.structuredContent === void 0) {
			current = object.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
			continue;
		}
		if (object.structuredContent !== void 0) {
			current = object.structuredContent;
			continue;
		}
		if ("status" in object && "data" in object) {
			if (Number(object.status) !== 1) throw new TapdError(String(object.info ?? `TAPD status ${String(object.status)}`));
			current = object.data;
			continue;
		}
		if ("data" in object && Object.keys(object).length <= 3) {
			current = object.data;
			continue;
		}
		current = [object];
		break;
	}
	if (!Array.isArray(current)) return [];
	return current.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const keys = Object.keys(entry);
		const inner = keys.length === 1 && /^[A-Z]/.test(keys[0]) ? entry[keys[0]] : entry;
		if (!inner || typeof inner !== "object") return [];
		return [Object.fromEntries(Object.entries(inner).map(([name, field]) => [name, field == null ? "" : String(field)]))];
	});
}
const PAGE = 200;
const MAX_PAGES = 10;
/** Fetches every page of a list (TAPD pages hold at most 200). */
async function paged(read) {
	const all = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const got = await read(page);
		all.push(...got);
		if (got.length < PAGE) break;
	}
	return all;
}
/** saroasis-platform: TAPD ignores `offset` and always returns page 1; paging must use `page`. */
const listArgs = (filter, page) => {
	if (filter.offset !== void 0) throw new TapdError("TAPD ignores offset; pagination uses page");
	return {
		...filter,
		limit: String(PAGE),
		page: String(page),
		order: "modified asc"
	};
};
const commentFilter = (type, workspace, id, since) => ({
	workspace_id: workspace,
	entry_type: COLLECTION[type].entry,
	entry_id: id,
	...since ? { modified: `>${tapdTime(since)}` } : {}
});
/** TAPD's Open API, signed in with the account the Host's environment or credentials file names. */
var TapdOpenApi = class {
	options;
	fetch;
	constructor(options) {
		this.options = options;
		this.fetch = options.fetch ?? globalThis.fetch;
	}
	/** An explicit environment (tests) is used as-is; a real Host also reads the local credentials file. */
	get env() {
		return this.options.environment ?? tapdEnvironment();
	}
	authorization() {
		const credential = tapdCredential(this.env);
		if (!credential) throw new TapdError(tapdCredentialsHint(this.env));
		return credential.header;
	}
	/** Checks credentials and reachability with TAPD's testauth endpoint, without reading or changing any item. */
	async verify(workspace) {
		await this.request("GET", "quickstart/testauth", workspace ? { workspace_id: workspace } : {});
	}
	async request(method, path, fields, signal) {
		const timeout = AbortSignal.timeout(this.options.timeoutMs ?? tapdTimeoutMs(this.env));
		const query = new URLSearchParams(fields).toString();
		const url = `${this.options.api.replace(/\/$/, "")}/${path}${method === "GET" ? `?${query}` : ""}`;
		const response = await this.fetch(url, {
			method,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: {
				authorization: this.authorization(),
				accept: "application/json",
				...method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}
			},
			...method === "POST" ? { body: query } : {}
		});
		const text = await response.text();
		if (response.status === 401 || response.status === 403) throw new TapdError(`TAPD refused the account (HTTP ${response.status})`);
		if (!response.ok) throw new TapdError(`TAPD answered HTTP ${response.status}: ${text.slice(0, 300)}`, response.status === 404);
		return records(text);
	}
	async items(type, workspace, filter, signal) {
		return (await paged((page) => this.request("GET", COLLECTION[type].path, listArgs({
			workspace_id: workspace,
			...filter
		}, page), signal))).map((record) => itemOf(type, {
			workspace_id: workspace,
			...record
		}));
	}
	async comments(type, workspace, id, since, signal) {
		return (await paged((page) => this.request("GET", "comments", listArgs(commentFilter(type, workspace, id, since), page), signal))).map(commentOf);
	}
	async recentComments(type, workspace, id, limit, signal) {
		if (!Number.isInteger(limit) || limit < 0 || limit > 50) throw new TapdError("Recent comment limit must be 0–50");
		signal?.throwIfAborted();
		if (!limit) return [];
		return (await this.request("GET", "comments", {
			...commentFilter(type, workspace, id),
			limit: String(limit),
			page: "1",
			order: "modified desc"
		}, signal)).slice(0, limit).map(commentOf);
	}
	async comment(type, workspace, id, author, html, signal) {
		await this.request("POST", "comments", {
			workspace_id: workspace,
			entry_type: COLLECTION[type].entry,
			entry_id: id,
			author,
			description: html
		}, signal);
	}
	/** Candidate values for the settings dropdowns. `status_map` answers an object of code -> Chinese name,
	* while projects and iterations answer record lists; `records()` already normalises both envelopes. */
	async choices(kind, workspace, signal) {
		if (kind === "workspace") return (await this.request("GET", "workspaces/user_participant_projects", {}, signal)).map((row) => ({
			value: String(row.id ?? row.workspace_id ?? ""),
			label: String(row.name ?? row.title ?? row.id ?? "")
		})).filter((choice) => choice.value);
		if (kind === "iteration") return (await this.request("GET", "iterations", {
			workspace_id: workspace,
			limit: "200"
		}, signal)).map((row) => ({
			value: String(row.id ?? ""),
			label: String(row.name ?? row.id ?? "")
		})).filter((choice) => choice.value);
		const out = [];
		for (const system of ["bug", "story"]) {
			const rows = await this.request("GET", "workflows/status_map", {
				workspace_id: workspace,
				system
			}, signal);
			for (const row of rows) for (const [code, name] of Object.entries(row)) if (/^[A-Za-z0-9_-]+$/.test(code) && name && !out.some((choice) => choice.value === code)) out.push({
				value: code,
				label: String(name)
			});
		}
		return out;
	}
	async directoryMembers(workspace, signal) {
		return (await paged((page) => this.request("GET", "workspaces/users", {
			workspace_id: workspace,
			fields: "user,name,email",
			limit: String(PAGE),
			page: String(page)
		}, signal))).map((row) => ({
			user: row.user ?? "",
			name: row.name ?? "",
			email: row.email ?? "",
			...row.staff_id ? { staffId: row.staff_id } : {},
			...row.login_name ? { loginName: row.login_name } : {}
		})).filter((row) => row.user);
	}
	async releases(workspace, signal) {
		return (await paged((page) => this.request("GET", "releases", listArgs({ workspace_id: workspace }, page), signal))).map((row) => ({
			value: row.id ?? "",
			label: row.name ?? ""
		})).filter((row) => row.value && row.label);
	}
	/** Chinese custom-field names and workflow status names, taken from this workspace's own configuration. */
	async filterMaps(workspace, signal) {
		const fieldNames = {}, statusCodes = {};
		const rows = await this.request("GET", "bugs/custom_fields_settings", { workspace_id: workspace }, signal);
		for (const row of rows) {
			const name = String(row.name ?? "").trim(), field = String(row.custom_field ?? "").trim();
			if (name && field && /^custom_field_/.test(field)) fieldNames[name] = field;
		}
		const statuses = await this.request("GET", "workflows/status_map", {
			workspace_id: workspace,
			system: "bug"
		}, signal);
		for (const row of statuses) for (const [code, name] of Object.entries(row)) if (name && /^[A-Za-z0-9_-]+$/.test(code)) statusCodes[String(name)] = code;
		return {
			fieldNames,
			statusCodes
		};
	}
	async count(type, workspace, filter, signal) {
		const path = `${COLLECTION[type].path}/count`;
		const rows = await this.request("GET", path, {
			workspace_id: workspace,
			...filter
		}, signal);
		const value = Number(rows[0]?.count ?? 0);
		return Number.isFinite(value) ? value : 0;
	}
};
/** The `TapdApi` of a configuration: TAPD's Open API only, with the Host-side credentials resolved per request. */
function tapdApi(config) {
	return new TapdOpenApi({ api: config.api });
}
//#endregion
//#region src/sources/tapd-members.ts
/** TAPD owner cells end in semicolons; a query carrying them finds fewer items (saroasis-platform: 459 -> 386). */
const cleanOwner = (value) => value.trim().replace(/[;；]+$/, "").trim();
/** Alias (or WeCom account) -> TAPD Chinese name; a Chinese name passes through unchanged. */
const resolveTapdName = (input, members = []) => {
	const name = cleanOwner(input);
	if (!name) return "";
	const lower = name.toLowerCase();
	const hit = members.find((member) => cleanOwner(member.alias).toLowerCase() === lower || cleanOwner(member.name).toLowerCase() === lower);
	return hit ? cleanOwner(hit.name) : name;
};
//#endregion
//#region src/sources/tapd-identity.ts
const normalized = (value) => cleanOwner(value ?? "").toLowerCase();
const scope = (config, loginName) => JSON.stringify([
	config.api.replace(/\/$/, ""),
	config.workspace,
	normalized(loginName)
]);
const identityKey = (config, loginName) => KV.tapd.identity(scope(config, loginName));
const validIdentity = (identity) => identity.signedIn === true && typeof identity.loginName === "string" && !!identity.loginName.trim() && !identity.stale && !identity.expired && identity.hasCredential !== false;
const samePerson = (record, identity) => normalized(record.loginName) === normalized(identity.loginName) && record.userId === (identity.userId ?? "") && record.staffId === (identity.staffId ?? "");
const uniqueMembers = (rows) => [...new Map(rows.filter((row) => cleanOwner(row.user)).map((row) => [normalized(row.user), row])).values()];
function matchTapdIdentity(identity, members) {
	const rows = members.filter((row) => cleanOwner(row.user));
	const matched = [
		{
			by: "staffId",
			matches: identity.staffId ? rows.filter((row) => row.staffId === identity.staffId) : []
		},
		{
			by: "email",
			matches: identity.email ? rows.filter((row) => normalized(row.email) === normalized(identity.email)) : []
		},
		{
			by: "account",
			matches: rows.filter((row) => [row.user, row.loginName].some((value) => normalized(value) === normalized(identity.loginName)))
		}
	].filter((criterion) => criterion.matches.length);
	const owners = uniqueMembers(matched.flatMap((criterion) => criterion.matches));
	if (!owners.length) return { status: "unmatched" };
	if (owners.length !== 1) return { status: "ambiguous" };
	return {
		status: "resolved",
		tapdName: cleanOwner(owners[0].user),
		matchedBy: matched[0].by
	};
}
/** Only valid, scoped cached owner names are used by a person's saved daily schedule. Static overrides always win. */
function cachedTapdName(config, state, loginName, now = /* @__PURE__ */ new Date()) {
	const explicit = [...new Set(config.members.filter((row) => normalized(row.alias) === normalized(loginName)).map((row) => cleanOwner(row.name)))];
	if (explicit.length) return explicit.length === 1 ? explicit[0] : "";
	const manual = resolveTapdName(loginName, config.members);
	if (normalized(manual) !== normalized(loginName)) return manual;
	const record = state.get(identityKey(config, loginName));
	return record && !record.invalidated && Date.parse(record.expiresAt) > now.getTime() ? record.tapdName : "";
}
/** Saved schedules may renew only the same previously verified owner, never acquire a new mapping unattended. */
async function scheduledTapdName(config, api, state, loginName, now = /* @__PURE__ */ new Date()) {
	const cached = cachedTapdName(config, state, loginName, now);
	if (cached) return cached;
	if (config.members.some((row) => normalized(row.alias) === normalized(loginName))) return "";
	const key = identityKey(config, loginName), record = state.get(key);
	if (!record || record.invalidated || !api.directoryMembers) return "";
	let rows;
	try {
		rows = await api.directoryMembers(config.workspace);
	} catch {
		return "";
	}
	if (rows.length >= 2e3) return "";
	if (!(record.source === "confirmed" ? uniqueMembers(rows.filter((row) => normalized(row.user) === normalized(record.tapdName))).length === 1 : (() => {
		const result = matchTapdIdentity({
			loginName: record.loginName,
			staffId: record.staffId
		}, rows);
		return result.status === "resolved" && normalized(result.tapdName) === normalized(record.tapdName);
	})())) {
		state.set(key, {
			...record,
			invalidated: true,
			expiresAt: now.toISOString()
		});
		return "";
	}
	state.set(key, {
		...record,
		at: now.toISOString(),
		expiresAt: new Date(now.getTime() + (record.source === "confirmed" ? 30 : 1) * 864e5).toISOString()
	});
	return record.tapdName;
}
async function resolveTapdIdentity(config, api, state, identity, options = {}) {
	const now = options.now ?? /* @__PURE__ */ new Date();
	const base = {
		signedIn: validIdentity(identity),
		loginName: identity.loginName || "",
		staffId: identity.staffId ?? "",
		workspace: config.workspace,
		status: "unavailable",
		tapdName: "",
		source: "none",
		cached: false,
		message: "企业身份不可用或已过期，请重新登录后重试"
	};
	if (!validIdentity(identity)) return base;
	const key = identityKey(config, identity.loginName);
	const saved = state.get(key);
	const invalidate = () => {
		if (saved) state.set(key, {
			...saved,
			invalidated: true,
			expiresAt: now.toISOString()
		});
	};
	const manual = config.members.filter((row) => normalized(row.alias) === normalized(identity.loginName));
	const manualNames = [...new Set(manual.map((row) => cleanOwner(row.name)))];
	if (manualNames.length) {
		if (options.confirmName !== void 0 && (manualNames.length !== 1 || normalized(options.confirmName) !== normalized(manualNames[0]))) return {
			...base,
			status: "ambiguous",
			message: "已存在手动映射，请先在高级设置修正；一次确认不会覆盖它"
		};
		return manualNames.length === 1 ? {
			...base,
			status: "resolved",
			tapdName: manualNames[0],
			source: "manual",
			message: "使用已配置的手动映射"
		} : {
			...base,
			status: "ambiguous",
			message: "当前账号存在冲突的手动映射，请修正 members"
		};
	}
	if (!options.fresh && options.confirmName === void 0 && saved && !saved.invalidated && samePerson(saved, identity) && Date.parse(saved.expiresAt) > now.getTime()) return {
		...base,
		status: "resolved",
		tapdName: saved.tapdName,
		source: saved.source,
		matchedBy: saved.matchedBy,
		cached: true,
		message: "已复用此用户在当前项目的映射"
	};
	if (!api.directoryMembers) {
		invalidate();
		return {
			...base,
			message: "TAPD 成员目录能力不可用，请重试或配置手动映射"
		};
	}
	let rows;
	try {
		rows = await api.directoryMembers(config.workspace);
	} catch {
		invalidate();
		return {
			...base,
			message: "TAPD 成员目录读取失败，请检查接入状态后重试；未放宽处理人条件"
		};
	}
	if (rows.length >= 2e3) {
		invalidate();
		return {
			...base,
			message: "成员目录达到读取上限，无法可靠判断唯一性；请配置手动映射"
		};
	}
	const confirmation = options.confirmName ?? (saved && samePerson(saved, identity) && saved.source === "confirmed" ? saved.tapdName : void 0);
	const result = confirmation !== void 0 ? (() => {
		const matches = uniqueMembers(rows.filter((row) => normalized(row.user) === normalized(confirmation) || normalized(row.name) === normalized(confirmation)));
		return matches.length === 1 ? {
			status: "resolved",
			tapdName: cleanOwner(matches[0].user),
			matchedBy: "confirmation"
		} : { status: matches.length ? "ambiguous" : "unmatched" };
	})() : matchTapdIdentity(identity, rows);
	if (result.status !== "resolved") {
		invalidate();
		return {
			...base,
			status: result.status,
			message: result.status === "ambiguous" ? "匹配到多个 TAPD 用户，不能自动选取；请确认准确的 TAPD 用户名" : confirmation !== void 0 ? "该名称不在当前项目成员目录中，请填写准确的 TAPD 用户名" : "账号/工号/完整邮箱未能唯一匹配，请确认一次 TAPD 用户名；系统不会猜中文姓名"
		};
	}
	const source = result.matchedBy === "confirmation" ? "confirmed" : "automatic";
	const record = {
		loginName: identity.loginName,
		userId: identity.userId ?? "",
		staffId: identity.staffId ?? "",
		tapdName: result.tapdName,
		source,
		matchedBy: result.matchedBy,
		at: now.toISOString(),
		expiresAt: new Date(now.getTime() + (source === "confirmed" ? 30 : 1) * 864e5).toISOString()
	};
	state.set(key, record);
	return {
		...base,
		status: "resolved",
		tapdName: result.tapdName,
		source,
		matchedBy: result.matchedBy,
		message: source === "confirmed" ? "已确认，后续在当前项目自动复用" : "已通过 TAPD 成员目录精确匹配"
	};
}
//#endregion
//#region src/sources/tapd-sweep.ts
/** Runs every due schedule once. Failures are reported to Source health rather than silently swallowed. */
async function runFilterSweeps(ctx, api, config, now = /* @__PURE__ */ new Date(), signal) {
	const results = [];
	for (const schedule of config.filterSchedules) {
		const stateKey = KV.tapd.sweep(schedule.name);
		const state = ctx.state.get(stateKey);
		if (!sweepDue(schedule, now, state?.lastRun)) continue;
		const since = /* @__PURE__ */ new Date(now.getTime() - schedule.windowDays * 864e5);
		const filter = {
			...schedule.query,
			modified: `>${tapdTime(since.toISOString())}`
		};
		let result;
		try {
			const scannedItems = await api.items("bug", config.workspace, filter, signal);
			const matchedItems = scannedItems.filter((item) => matchesLocal(item, schedule.local));
			const seen = new Set(state?.seen ?? []);
			const fresh = matchedItems.filter((item) => !seen.has(item.id)).slice(0, schedule.maxPerRun);
			let dispatched = 0;
			for (const item of fresh) {
				const base = itemTrigger(item, "item", config, {
					name: schedule.name,
					mode: "all",
					item: ""
				});
				if (await ctx.receive({
					...base,
					human: false,
					actor: {
						source: "tapd",
						id: ""
					},
					addressed: "direct",
					meta: {
						...base.meta,
						mode: "all",
						filterSweep: schedule.name
					}
				}) === "stored") dispatched++;
				seen.add(item.id);
			}
			const next = {
				lastRun: localDay$1(now),
				seen: [...seen].slice(-2e3),
				scanned: scannedItems.length,
				matched: matchedItems.length,
				dispatched,
				at: now.toISOString()
			};
			ctx.state.set(stateKey, next);
			result = {
				name: schedule.name,
				scanned: scannedItems.length,
				matched: matchedItems.length,
				dispatched,
				capped: scannedItems.length >= 2e3 || fresh.length >= schedule.maxPerRun
			};
		} catch (error) {
			result = {
				name: schedule.name,
				scanned: 0,
				matched: 0,
				dispatched: 0,
				capped: false,
				error: String(error).slice(0, 300)
			};
		}
		results.push(result);
	}
	return results;
}
//#endregion
//#region src/sources/tapd.ts
/**
* VsSaros addition: the TAPD Source kind and its Cordis plugin entry (`dsh-superagent/tapd-watch`). It watches single
* stories, bugs or tasks and lists of them by workspace/type/filters, turns their changes into Triggers, follows the
* comments of the items tickets subscribe to, and replies with comments. An optional TAPD identity name recognises
* what is assigned to SuperAgent or @s it; it is never a query parameter.
*/
const TapdPolicySchema = object({ allowed: array(object({ id: string().trim().min(1) }).strict()).default([]) }).strict();
const TYPE_LABEL = {
	story: "需求",
	bug: "缺陷",
	task: "任务"
};
const DESCRIPTION_MAX = 8e3;
/** The Thread of an item: `tapd:<workspace>:<type>:<id>`. */
const itemThread = (item) => `${item.workspace}:${item.type}:${item.id}`;
function threadItem(id) {
	const [workspace, type, item] = id.split(":");
	return workspace && item && TAPD_TYPES.includes(type ?? "") ? {
		workspace,
		type,
		id: item
	} : void 0;
}
const channelOf = (item) => ({
	source: TAPD_SOURCE,
	thread: `${TAPD_SOURCE}:${itemThread(item)}`,
	address: {
		workspace: item.workspace,
		type: item.type,
		id: item.id
	}
});
const mentions = (text, name) => !!name && new RegExp(`@${escapeRegExp(name)}(?![\\w-])`, "i").test(text);
const assignedTo = (item, agent) => item.owners.some((owner) => sameName(owner, agent));
/** The visible line every reply ends with, by which a retry finds a reply that already went out. */
const replyMarker = (messageId) => `dsh-superagent · ${createHash("sha256").update(messageId).digest("hex").slice(0, 10)}`;
/** A Trigger for an item that came into a watch (`item`), was assigned to the configured identity (`assigned`), or changed status (`status`). */
function itemTrigger(item, event, config, watch) {
	const addressed = assignedTo(item, config.agent) || event === "item" && !!watch.item || mentions(item.description, config.agent);
	const head = event === "status" ? `${TYPE_LABEL[item.type]}状态变为「${item.status}」：${item.title}` : `[${TYPE_LABEL[item.type]}] ${item.title}`;
	const description = item.description.length > DESCRIPTION_MAX ? `${item.description.slice(0, DESCRIPTION_MAX)}…` : item.description;
	return {
		id: key("tapd", event, item.workspace, item.type, item.id, item.modified, event === "status" ? item.status : ""),
		source: TAPD_SOURCE,
		threads: [{
			source: TAPD_SOURCE,
			id: itemThread(item)
		}],
		actor: {
			source: TAPD_SOURCE,
			id: item.creator
		},
		human: !!item.creator && !sameName(item.creator, config.agent),
		...addressed ? { addressed: "direct" } : {},
		at: item.modified || (/* @__PURE__ */ new Date()).toISOString(),
		text: [
			head,
			`状态：${item.status || "—"} · 处理人：${item.owners.join("、") || "—"}${item.iteration ? ` · 迭代 ${item.iteration}` : ""}`,
			event === "status" ? "" : description
		].filter(Boolean).join("\n\n"),
		channel: channelOf(item),
		url: itemPage(config.site, item),
		meta: {
			kind: event,
			workspace: item.workspace,
			type: item.type,
			id: item.id,
			watch: watch.name,
			mode: watch.mode,
			status: item.status,
			owners: item.owners
		}
	};
}
function commentTrigger(item, comment, config) {
	return {
		id: key("tapd-comment", itemThread(item), comment.id, comment.modified),
		source: TAPD_SOURCE,
		threads: [{
			source: TAPD_SOURCE,
			id: itemThread(item)
		}],
		actor: {
			source: TAPD_SOURCE,
			id: comment.author
		},
		human: !!comment.author && !sameName(comment.author, config.agent),
		...mentions(comment.text, config.agent) ? { addressed: "mention" } : {},
		at: comment.modified || comment.created,
		text: comment.text,
		channel: channelOf(item),
		url: itemPage(config.site, item),
		meta: {
			kind: "comment",
			workspace: item.workspace,
			type: item.type,
			id: item.id,
			commentId: comment.id
		}
	};
}
/** The query fields of a watch's filters, as TAPD's list APIs take them. */
function watchFilter(watch) {
	const owner = cleanOwner(watch.owner);
	return {
		...watch.item ? { id: watch.item } : {},
		...watch.status ? { status: watch.status } : {},
		...owner ? { [watch.type === "bug" ? "current_owner" : "owner"]: owner } : {},
		...watch.iteration ? { iteration_id: watch.iteration } : {}
	};
}
/** A watch's state is reused only while the workspace and query filters it was read with still hold. */
const signatureOf = (config, watch) => JSON.stringify([
	watchWorkspace(config, watch),
	watch.type,
	watchFilter(watch)
]);
/** Resolve WeCom aliases to TAPD Chinese names before any owner comparison or query is made. */
function resolvedConfig(config) {
	const members = config.members;
	return {
		...config,
		agent: resolveTapdName(config.agent, members),
		watches: config.watches.map((watch) => ({
			...watch,
			owner: resolveTapdName(watch.owner, members)
		}))
	};
}
const changeFilter = (since) => ({ modified: `>${tapdTime(cursorAt(since))}` });
/**
* Reads one watch's changes and receives their Triggers. The first read of a list (or of a list whose filters changed)
* only records what is there: work already in the list is not taken up (D4). A single item is taken up at once.
*/
async function pollWatch(ctx, api, config, watch, signal) {
	const stored = ctx.state.get(KV.tapd.watch(watch.name));
	const state = stored?.signature === signatureOf(config, watch) ? stored : void 0;
	const filter = {
		...watchFilter(watch),
		...state ? changeFilter(state.since) : {}
	};
	const items = await api.items(watch.type, watchWorkspace(config, watch), filter, signal);
	const next = {
		signature: signatureOf(config, watch),
		since: state?.since ?? (items.length ? "" : (/* @__PURE__ */ new Date()).toISOString()),
		items: { ...state?.items }
	};
	let received = 0;
	for (const item of items) {
		const before = state?.items[item.id];
		const events = [];
		if (!state) {
			if (watch.item) events.push("item");
		} else if (!before) events.push("item");
		else {
			if (assignedTo(item, config.agent) && !before.owners.some((owner) => sameName(owner, config.agent))) events.push("assigned");
			if (before.status !== item.status) events.push("status");
		}
		const subscribed = (ctx.threads.get(`tapd:${itemThread(item)}`)?.subscriptions.length ?? 0) > 0;
		for (const event of events) {
			const trigger = itemTrigger(item, event, config, watch);
			if (config.agent && watch.mode === "assigned" && !trigger.addressed && !subscribed) continue;
			await ctx.receive(trigger);
			received++;
		}
		next.items[item.id] = {
			owners: item.owners,
			status: item.status
		};
		if (item.modified > next.since) next.since = item.modified;
	}
	ctx.state.set(KV.tapd.watch(watch.name), next);
	return received;
}
/** Reads the new comments on a subscribed item, skipping the agent's own replies. */
async function pollComments(ctx, api, config, thread, signal) {
	const item = threadItem(thread.ref.id);
	if (!item) return 0;
	const cursor = ctx.state.get(KV.tapd.comments(thread.key));
	if (!cursor) {
		ctx.state.set(KV.tapd.comments(thread.key), (/* @__PURE__ */ new Date()).toISOString());
		return 0;
	}
	let since = cursor, received = 0;
	for (const comment of await api.comments(item.type, item.workspace, item.id, cursorAt(cursor), signal)) {
		if (!comment.text.includes("dsh-superagent · ")) {
			await ctx.receive(commentTrigger(item, comment, config));
			received++;
		}
		if (comment.modified > since) since = comment.modified;
	}
	ctx.state.set(KV.tapd.comments(thread.key), since);
	return received;
}
/** One polling round: every watch, then the comments of every subscribed item. */
async function pollRound(ctx, api, config, signal) {
	const resolved = resolvedConfig(config);
	let received = 0;
	const failures = [];
	for (const watch of resolved.watches) {
		if (signal?.aborted) return received;
		if (watch.sweepOnly) continue;
		try {
			received += await pollWatch(ctx, api, resolved, watch, signal);
		} catch (error) {
			failures.push(`${watch.name}: ${String(error)}`);
		}
	}
	await pollThreads(ctx, TAPD_SOURCE, () => !!signal?.aborted, async (thread) => {
		received += await pollComments(ctx, api, resolved, thread, signal);
	});
	if (failures.length) throw new Error(failures.join("; "));
	return received;
}
const html = (text) => text.split("\n").map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("<br/>");
/** Posts a reply as a comment on its item once: a retry that finds the reply's marker sends nothing. */
async function sendTapd(api, config, message, signal) {
	const { workspace, type, id } = message.channel.address;
	if (!workspace || !id || !TAPD_TYPES.includes(type ?? "")) throw new Error("Missing TAPD reply target");
	const marker = replyMarker(message.id);
	try {
		if ((await api.comments(type, workspace, id, void 0, signal)).some((comment) => comment.text.includes(marker))) return "sent";
		await api.comment(type, workspace, id, resolveTapdName(config.agent, config.members) || "dsh-superagent", `${html(message.text)}<br/><br/><span style="color:#999">${marker}</span>`, signal);
		return "sent";
	} catch (error) {
		if (error instanceof TapdError && error.gone) return "gone";
		throw error;
	}
}
/** An error health once `failures` consecutive rounds fail, so one network blip stays quiet. */
const pollFailure = (failures, threshold, error) => failures >= threshold ? health("error", "pollFailures", {
	count: String(failures),
	error: String(error)
}) : void 0;
function makeTapdKind(options) {
	const apiOf = (config, ctx) => options.api?.(config, ctx) ?? tapdApi(config);
	const kind = {
		kind: TAPD_SOURCE,
		title: {
			zh: "TAPD",
			en: "TAPD"
		},
		description: {
			zh: "按接收项从 TAPD 拉取需求、缺陷和任务的变化，跟进已订阅单子的评论，并以评论回复。",
			en: "Reads changes to TAPD stories, bugs and tasks selected by each watch, follows the comments of subscribed items, and replies with comments."
		},
		schema: TapdConfigSchema,
		fields: [
			{
				key: "workspace",
				type: "text",
				label: {
					zh: "项目 ID",
					en: "Workspace ID"
				},
				pattern: "\\d+",
				chooseFrom: "workspace",
				choose: {
					zh: "从 TAPD 项目里选",
					en: "Choose a TAPD project"
				},
				hint: {
					zh: "默认 GR 项目 68880148（TAPD 的 workspace_id）。下拉候选来自 TAPD「我参与的项目」，点接收项的「读取 TAPD 选项」刷新。接收项不填项目 ID 时继承这里的值。",
					en: "Defaults to the GR project 68880148 (TAPD workspace_id). Dropdown options come from TAPD projects the account participates in; refresh them with the watches button. A watch with no workspace ID inherits this value."
				}
			},
			{
				key: "agent",
				type: "text",
				label: {
					zh: "TAPD 身份名",
					en: "TAPD identity name"
				},
				chooseFrom: "agent",
				choose: {
					zh: "从 TAPD 单据里的人选",
					en: "Choose a TAPD person"
				},
				hint: {
					zh: "可选。填 TAPD 账号体系里的名字（中文人名、机器人账号名，或企微账号——会按下面的成员映射解析成中文名），不是智能体的名字：单子指派给它、或评论里 @ 它，才算发给 SuperAgent，回评论也以它署名。它不参与取数。留空则不识别指派/@，回复署名 dsh-superagent；此时请把接收项设为「全部变化」，由策略的接收表决定。下拉候选来自 TAPD 单据的处理人/创建人聚合（TAPD Open API 没有成员名单接口）与静态成员映射。",
					en: "Optional. A name in TAPD's account system (a person's Chinese name or a robot account), not an agent name: only items assigned to it or comments that @ it address SuperAgent, and replies are signed with it. It is not a query parameter. Leave it empty to skip identity matching and sign replies as dsh-superagent; then set watches to \"All changes\" and let the Policy admission table decide. Options come from owners/creators of fetched TAPD items (TAPD has no member-list endpoint) plus the static member mapping."
				}
			},
			{
				key: "watches",
				type: "rows",
				label: {
					zh: "接收项",
					en: "Watches"
				},
				hint: {
					zh: "项目 ID 留空就继承上面的默认项目；填了“单号”就只盯这一个单子，保存后立即接下；不填就是列表，按状态、处理人、迭代筛选，第一次保存时已在列表里的单子不处理，只看之后的变化。“仅指派/@”只接收指派给上面身份名或 @ 它的（未填身份名时只收点名的单子）；“全部变化”由策略的接收表决定。",
					en: "With an item ID a watch follows that item alone and takes it up on saving; without one it is a list, filtered by status, owner and iteration, and items already in it when first saved are left alone. \"Assigned/@ only\" receives what is assigned to the identity name or @s it (with no identity name, only named items); \"All changes\" leaves it to the Policy's admission table."
				},
				columns: [
					{
						key: "name",
						type: "text",
						label: {
							zh: "名称",
							en: "Name"
						},
						pattern: "[\\w.\\-]{1,40}",
						refresh: {
							zh: "读取 TAPD 选项",
							en: "Read TAPD options"
						}
					},
					{
						key: "workspace",
						type: "text",
						label: {
							zh: "项目 ID",
							en: "Workspace ID"
						},
						pattern: "\\d*",
						optional: true,
						chooseFrom: "workspace"
					},
					{
						key: "type",
						type: "select",
						label: {
							zh: "类型",
							en: "Type"
						},
						options: [
							{
								value: "story",
								label: {
									zh: "需求",
									en: "Story"
								}
							},
							{
								value: "bug",
								label: {
									zh: "缺陷",
									en: "Bug"
								}
							},
							{
								value: "task",
								label: {
									zh: "任务",
									en: "Task"
								}
							}
						]
					},
					{
						key: "item",
						type: "text",
						label: {
							zh: "单号",
							en: "Item ID"
						},
						pattern: "\\d*",
						optional: true
					},
					{
						key: "status",
						type: "text",
						label: {
							zh: "状态",
							en: "Status"
						},
						optional: true,
						chooseFrom: "status"
					},
					{
						key: "owner",
						type: "text",
						label: {
							zh: "处理人",
							en: "Owner"
						},
						optional: true
					},
					{
						key: "iteration",
						type: "text",
						label: {
							zh: "迭代 ID",
							en: "Iteration ID"
						},
						pattern: "\\d*",
						optional: true,
						chooseFrom: "iteration"
					},
					{
						key: "mode",
						type: "select",
						label: {
							zh: "接收",
							en: "Receive"
						},
						options: [{
							value: "assigned",
							label: {
								zh: "仅指派/@",
								en: "Assigned/@ only"
							}
						}, {
							value: "all",
							label: {
								zh: "全部变化",
								en: "All changes"
							}
						}]
					}
				]
			},
			{
				key: "site",
				type: "text",
				label: {
					zh: "TAPD 站点",
					en: "TAPD site"
				},
				hint: {
					zh: "单子链接的前缀，例如 https://www.tapd.cn。",
					en: "The prefix of item links, such as https://www.tapd.cn."
				}
			},
			{
				key: "api",
				type: "text",
				advanced: true,
				group: {
					zh: "连接与凭据",
					en: "Connection & credentials"
				},
				label: {
					zh: "Open API 地址",
					en: "Open API address"
				},
				hint: {
					zh: "默认 https://api.tapd.cn，只有私有化部署才需要改。凭据在卡片下方的「接入检查」区管理；MCP 通道已下线。",
					en: "Defaults to https://api.tapd.cn; change only for a private deployment. Credentials are managed in the setup checklist below; the MCP transport was retired."
				}
			},
			{
				key: "ownerGroups",
				type: "rows",
				advanced: true,
				group: {
					zh: "接收范围",
					en: "Reception scope"
				},
				label: {
					zh: "组成员映射",
					en: "Owner group → members"
				},
				hint: {
					zh: "导入的筛选条件里「处理人」常填组名（如「一组 1.1（玩法）」），TAPD 的 current_owner 存的是人名。这里把组名映射成逗号分隔的人名后，导入时会转成 current_owner=USER_OR<…>。未映射的组名条件会明确标为「未生效」，不会静默缩小范围。",
					en: "An imported filter may name an owner group, while TAPD stores person names in current_owner. Map a group to comma-separated names so the import becomes current_owner=USER_OR<…>. An unmapped group is reported as not applied instead of silently narrowing the result."
				},
				columns: [{
					key: "group",
					type: "text",
					label: {
						zh: "组名",
						en: "Group"
					}
				}, {
					key: "members",
					type: "text",
					label: {
						zh: "成员（逗号分隔）",
						en: "Members (comma separated)"
					}
				}]
			},
			{
				key: "members",
				type: "rows",
				advanced: true,
				group: {
					zh: "接收范围",
					en: "Reception scope"
				},
				label: {
					zh: "手动身份映射（高级覆盖）",
					en: "Manual identity mapping (advanced override)"
				},
				hint: {
					zh: "筛选结果池优先使用此表；未配置时自动读取当前 TOF 身份与 TAPD 项目成员精确匹配，无法唯一匹配时在身份栏确认一次并记住。原有身份名/接收项仍使用此表；这里适合管理员预置或纠正映射，不需要每人维护全员表。",
					en: "Overrides automatic pool identity matching. Otherwise TOF is matched exactly to TAPD workspace members, with one confirmation if unresolved. Existing watches and agent identities still use this table. Administrators can preconfigure or correct entries."
				},
				columns: [{
					key: "alias",
					type: "text",
					label: {
						zh: "企微账号",
						en: "WeCom alias"
					}
				}, {
					key: "name",
					type: "text",
					label: {
						zh: "TAPD 中文名",
						en: "TAPD name"
					}
				}]
			},
			{
				key: "webhook",
				type: "switch",
				advanced: true,
				group: {
					zh: "连接与凭据",
					en: "Connection & credentials"
				},
				label: {
					zh: "TAPD Webhook（可选）",
					en: "TAPD Webhook (optional)"
				},
				hint: {
					zh: "默认关闭。TAPD 后台把事件 POST 到本机 /orchestrator/webhook/tapd，内容类型选 application/json，secret 填下面的验证密码（「网关 Token」不用填）。Host 只监听 127.0.0.1，云端 TAPD 需要内网网关或反向代理。它只是轮询之外的加速通道：事件只带单号，会回读并按接收项匹配；评论仍由轮询跟进。",
					en: "Off by default. Point TAPD at the local /orchestrator/webhook/tapd, choose application/json and set the secret below (ignore the gateway Token). The Host listens on 127.0.0.1 only, so cloud TAPD needs an intranet gateway or reverse proxy. This is only a fast lane on top of polling: events carry IDs, are reread and matched against watches, and comments still come from polling."
				}
			},
			{
				key: "webhookSecret",
				type: "text",
				advanced: true,
				group: {
					zh: "连接与凭据",
					en: "Connection & credentials"
				},
				label: {
					zh: "Webhook 验证密码",
					en: "Webhook shared secret"
				},
				hint: {
					zh: "与 TAPD 后台一致（POST body，或 x-tapd-secret 头 / secret 查询参数）。开启却留空会报错并让所有推送返回 503。明文保存在本机状态目录，不要复用其它系统的密码；轮换时同步改 TAPD 后台。",
					en: "The same value as in TAPD (POST body, x-tapd-secret header or secret query). Empty while enabled reports an error and answers 503. Stored in plain text in the local state directory; do not reuse another password and update TAPD when rotating."
				}
			},
			{
				key: "pollSeconds",
				type: "number",
				advanced: true,
				group: {
					zh: "运维参数",
					en: "Operations"
				},
				min: 60,
				max: 3600,
				label: {
					zh: "轮询间隔 / 秒",
					en: "Polling interval / seconds"
				}
			},
			{
				key: "failuresBeforeError",
				type: "number",
				advanced: true,
				group: {
					zh: "运维参数",
					en: "Operations"
				},
				min: 1,
				max: 20,
				label: {
					zh: "连续失败几次后报告异常",
					en: "Failed polls before reporting an error"
				}
			}
		],
		scope: ({ meta }, config) => {
			const row = meta.kind === "comment" ? "comments" : meta.kind === "status" ? "status" : "items";
			return {
				listened: true,
				observed: !config.agent || meta.mode === "all",
				row
			};
		},
		health: [TAPD_SOURCE],
		channel: {
			send: async (_host, message) => {
				const ctx = options.context();
				const config = ctx?.config(TAPD_SOURCE);
				if (!ctx || !config) throw new Error("The TAPD Source is not running");
				return sendTapd(apiOf(config, ctx), config, message);
			},
			link: (address) => {
				const config = options.context()?.config(TAPD_SOURCE);
				const type = address.type;
				const label = `TAPD ${TYPE_LABEL[type] ?? ""} ${address.id ?? ""}`.trim();
				return {
					url: config && address.workspace && address.id ? itemPage(config.site, {
						type,
						workspace: address.workspace,
						id: address.id
					}) : "",
					label: {
						zh: label,
						en: label
					}
				};
			}
		},
		find: (query) => {
			const address = itemAddress(query);
			return {
				threads: address ? [`${TAPD_SOURCE}:${itemThread(address)}`] : [],
				terms: []
			};
		},
		policy: {
			schema: TapdPolicySchema,
			fields: [{
				key: "allowed",
				type: "rows",
				label: {
					zh: "能发起工作的 TAPD 用户",
					en: "TAPD users who may originate work"
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "TAPD 名字",
						en: "TAPD name"
					}
				}]
			}],
			explicit: {
				zh: "名单里的人创建的单子指派给上面设置的 TAPD 身份名、在评论里 @ 它，或运维在来源里点名了这个单子。",
				en: "An item created by someone on the list is assigned to the configured TAPD identity, a comment @s it, or the operator named the item in the Source."
			},
			rows(stored) {
				const config = TapdConfigSchema.partial().parse(stored);
				const all = !config.agent || (config.watches ?? []).some((watch) => watch.mode === "all");
				const note = all ? {
					zh: "有“全部变化”的接收项",
					en: "Some watches receive all changes"
				} : {
					zh: "仅指派/@",
					en: "Assigned/@ only"
				};
				return [
					{
						id: "items",
						label: {
							zh: "新单子与指派",
							en: "New and assigned items"
						},
						note,
						cells: {
							listedUnaddressed: all,
							unlistedAddressed: true,
							unlistedUnaddressed: all
						}
					},
					{
						id: "status",
						label: {
							zh: "状态变化",
							en: "Status changes"
						},
						note,
						cells: {
							listedUnaddressed: all,
							unlistedAddressed: false,
							unlistedUnaddressed: all
						}
					},
					{
						id: "comments",
						label: {
							zh: "已订阅单子的评论",
							en: "Comments on subscribed items"
						},
						note: {
							zh: "仅 @",
							en: "@ only"
						},
						cells: {
							listedUnaddressed: false,
							unlistedAddressed: true,
							unlistedUnaddressed: false
						}
					}
				];
			}
		},
		refreshLabels: async (host, signal) => {
			const ctx = sourceContext(host, kind);
			const config = ctx.config(TAPD_SOURCE);
			if (!config) return {};
			const api = apiOf(config, ctx);
			const resolved = resolvedConfig(config);
			const labels = {};
			const put = (prefix, value, name) => {
				if (value) labels[`${prefix}:${value}`] = name;
			};
			if (api.choices) for (const [kindName, prefix] of [
				["workspace", "workspace"],
				["status", "status"],
				["iteration", "iteration"]
			]) try {
				for (const choice of await api.choices(kindName, resolved.workspace, signal)) put(prefix, choice.value, choice.label);
			} catch {}
			for (const member of resolved.members) put("agent", member.name, member.alias ? `${member.name}（${member.alias}）` : member.name);
			const owners = /* @__PURE__ */ new Set();
			for (const watch of resolved.watches) try {
				const items = await api.items(watch.type, watchWorkspace(resolved, watch), watchFilter(watch), signal);
				labels[watch.name] = watch.item ? items[0] ? `#${items[0].id} ${items[0].title} · ${items[0].status}` : `#${watch.item} 不存在或无权读取` : `${items.length} 个${TYPE_LABEL[watch.type]}`;
				for (const item of items) {
					for (const owner of item.owners) if (owner) owners.add(cleanOwner(owner));
					if (item.creator) owners.add(cleanOwner(item.creator));
				}
			} catch (error) {
				labels[watch.name] = `读取失败：${String(error).slice(0, 120)}`;
			}
			for (const owner of owners) if (!labels[`agent:${owner}`]) put("agent", owner, owner);
			if (!labels[`workspace:${resolved.workspace}`]) put("workspace", resolved.workspace, `${resolved.workspace}（当前）`);
			if (resolved.agent && !labels[`agent:${resolved.agent}`]) put("agent", resolved.agent, `${resolved.agent}（当前）`);
			for (const watch of resolved.watches) {
				if (watch.status && !labels[`status:${watch.status}`]) put("status", watch.status, `${watch.status}（当前）`);
				if (watch.iteration && !labels[`iteration:${watch.iteration}`]) put("iteration", watch.iteration, `${watch.iteration}（当前）`);
				if (watch.workspace && !labels[`workspace:${watch.workspace}`]) put("workspace", watch.workspace, `${watch.workspace}（当前）`);
			}
			ctx.state.set(KV.sources.labels(TAPD_SOURCE), labels);
			return labels;
		},
		environment: {
			variables: [
				{
					key: "DSH_SUPERAGENT_TAPD_ITEM",
					description: {
						zh: "接下工单的 TAPD 单子，写作 <类型>:<单号>，例如 bug:1001；工单不是从 TAPD 来的时为空",
						en: "The TAPD item that started the ticket, as <type>:<id> such as bug:1001; empty when it did not start on TAPD"
					}
				},
				{
					key: "DSH_SUPERAGENT_TAPD_WORKSPACE",
					description: {
						zh: "这个单子所在的 TAPD 项目 ID",
						en: "The TAPD workspace ID of that item"
					}
				},
				{
					key: "DSH_SUPERAGENT_TAPD_URL",
					description: {
						zh: "这个单子的页面",
						en: "The page of that item"
					}
				},
				{
					key: "DSH_SUPERAGENT_TAPD_BUG",
					description: {
						zh: "单子是缺陷时的单号；写 P4 CL 描述时以 --bug=<它> 关联",
						en: "The ID when the item is a bug; link a P4 CL description to it with --bug=<it>"
					}
				}
			],
			values: ({ config, trigger }) => {
				const meta = trigger?.source === "tapd" ? trigger.meta : void 0;
				const type = typeof meta?.type === "string" ? meta.type : void 0;
				const id = typeof meta?.id === "string" ? meta.id : "", workspace = typeof meta?.workspace === "string" ? meta.workspace : "";
				return {
					DSH_SUPERAGENT_TAPD_ITEM: type && id ? `${type}:${id}` : "",
					DSH_SUPERAGENT_TAPD_WORKSPACE: workspace,
					DSH_SUPERAGENT_TAPD_URL: type && id && workspace ? itemPage(config.site, {
						type,
						workspace,
						id
					}) : "",
					DSH_SUPERAGENT_TAPD_BUG: type === "bug" ? id : ""
				};
			}
		}
	};
	return kind;
}
const name = "dsh-superagent-tapd";
const inject = ["orchestrator"];
function apply(ctx) {
	const kindRef = {
		kind: TAPD_SOURCE,
		health: [TAPD_SOURCE]
	};
	let source;
	const kind = makeTapdKind({ context: () => source });
	ctx.effect(() => ctx.orchestrator.sources.register(kind), "tapd: source kind");
	ctx.effect(() => {
		source = sourceContext(ctx.orchestrator, kindRef);
		const controller = new AbortController();
		const running = watch(source, controller.signal, (config) => tapdApi(config)).catch((error) => {
			source?.report(TAPD_SOURCE, {
				state: "error",
				detail: String(error)
			});
		});
		return async () => {
			controller.abort();
			await running;
			source = void 0;
		};
	});
}
async function watch(ctx, signal, apiOf) {
	let failures = 0;
	await ctx.ready;
	if (!ctx.configured()) {
		ctx.report(TAPD_SOURCE, health("paused", "setupPending"));
		return;
	}
	while (!signal.aborted) {
		const config = ctx.config(TAPD_SOURCE);
		try {
			if (!config) ctx.report(TAPD_SOURCE, health("paused", "sourceOff"));
			else if (!tapdConfigured(config)) ctx.report(TAPD_SOURCE, health("paused", "tapdUnset"));
			else {
				let pollError = "";
				try {
					await pollRound(ctx, apiOf(config), config, signal);
				} catch (error) {
					pollError = String(error);
				}
				const sweeps = await runFilterSweeps(ctx, apiOf(config), config, /* @__PURE__ */ new Date(), signal);
				const poolRun = await runPoolDaily(ctx, apiOf(config), config, /* @__PURE__ */ new Date(), signal);
				const trouble = sweeps.find((item) => item.error || item.capped);
				const note = poolRun.error || pollError || (trouble?.error ? `TAPD 筛选扫描 ${trouble.name} 失败：${trouble.error}` : trouble ? `TAPD 筛选扫描 ${trouble.name} 达到单次上限（扫描 ${trouble.scanned}、命中 ${trouble.matched}、派发 ${trouble.dispatched}），可能漏单` : "");
				ctx.report(TAPD_SOURCE, config.webhook && !config.webhookSecret ? health("error", "tapdWebhookUnset") : note ? health("error", "pollFailures", {
					count: "1",
					error: note
				}) : {
					state: "ready",
					detail: ""
				});
			}
			failures = 0;
		} catch (error) {
			failures += 1;
			const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error);
			if (!signal.aborted && failed) ctx.report(TAPD_SOURCE, failed);
		}
		await pause((ctx.config("tapd")?.pollSeconds ?? 120) * 1e3, signal);
	}
}
//#endregion
//#region src/sources/tapd-filter-pool-run.ts
async function runPoolDaily(ctx, api, config, now = /* @__PURE__ */ new Date(), signal, manual = false) {
	const stateKey = KV.tapd.pool(config.filterPool.name);
	let initial = ctx.state.get(stateKey);
	if (ctx.intake) ctx.atomic(() => {
		const saved = ctx.state.get(stateKey);
		if (saved) {
			initial = reconcilePoolState(saved, (id) => ctx.intake.status(id), now);
			ctx.state.set(stateKey, initial);
		}
	});
	const pool = poolWithRuntime(config.filterPool, config.workspace, initial);
	const empty = {
		planned: 0,
		dispatched: 0,
		runId: ""
	};
	if (!manual && !poolDue({
		...pool,
		lastRun: initial?.lastRun ?? ""
	}, now)) return empty;
	if (!pool.owner.trim()) return {
		...empty,
		error: "当前用户身份不可用，未派发任何任务"
	};
	const run = planPoolRun(pool, now);
	const resolved = resolvedConfig(config);
	const owner = await scheduledTapdName(config, api, ctx.state, pool.owner, now);
	if (!owner) return {
		...empty,
		error: "TAPD 身份未解析或缓存已过期，请在设置页重新读取并确认身份"
	};
	let dispatched = 0;
	let error;
	const state = () => ctx.state.get(stateKey) ?? {
		lastRun: "",
		runIds: [],
		dispatched: 0,
		at: "",
		records: {}
	};
	for (const item of run.items) {
		if (signal?.aborted) {
			error = "运行已中止，未派发条目保留待处理";
			break;
		}
		const key = poolItemKey(config.workspace, pool.owner, item);
		let claimed = false;
		let triggerId = "";
		let requeue = false;
		ctx.atomic(() => {
			const saved = state(), known = saved.records?.[key];
			const intake = known && ctx.intake?.status(known.triggerId);
			if (known && (known.state === "done" || known.state === "processing" || known.state === "queued")) return;
			if (intake && (!intake.retryable || intake.phase === "rejected" && !manual)) return;
			if ((known?.attempts ?? 0) >= 3) return;
			const attempts = (known?.attempts ?? 0) + 1;
			requeue = !!intake?.retryable;
			triggerId = requeue ? known.triggerId : `tapd-pool:${key}:${attempts}`;
			const record = {
				state: "processing",
				runId: run.runId,
				triggerId,
				lastRunAt: now.toISOString(),
				attempts,
				item,
				dispatching: true
			};
			ctx.state.set(stateKey, {
				...saved,
				records: {
					...saved.records,
					[key]: record
				}
			});
			claimed = true;
		});
		if (!claimed) continue;
		try {
			const record = (await api.items(item.kind, config.workspace, { id: item.id }, signal)).find((row) => row.id === item.id && row.workspace === config.workspace);
			if (!record) throw new Error(`${item.id} 无法读取，未用过期快照代替`);
			if (!record.owners.some((name) => cleanOwner(name).toLowerCase() === owner.toLowerCase())) throw new Error(`${item.id} 处理人已变更，拒绝派发`);
			const base = itemTrigger(record, "item", resolved, {
				name: pool.name,
				mode: "all",
				item: item.id
			});
			ctx.atomic(() => {
				const saved = state(), previous = saved.records?.[key];
				if (previous?.triggerId !== triggerId || !previous.dispatching) throw new Error("池任务领取已失效，未派发");
				ctx.state.set(stateKey, {
					...saved,
					records: {
						...saved.records,
						[key]: {
							...previous,
							authorization: {
								authority: "host_pool",
								action: "repair",
								invocation: manual ? "manual" : "daily",
								workspace: config.workspace,
								pool: pool.name,
								itemType: item.kind,
								itemId: item.id,
								loginName: pool.owner,
								tapdOwner: owner,
								runId: run.runId,
								authorizedAt: now.toISOString()
							}
						}
					}
				});
			});
			const received = requeue ? ctx.intake.requeue(triggerId) ? "stored" : "duplicate" : await ctx.receive({
				...base,
				id: triggerId,
				at: now.toISOString(),
				human: false,
				actor: {
					source: TAPD_SOURCE,
					id: ""
				},
				addressed: "direct",
				meta: {
					...base.meta,
					mode: "all",
					filterSweep: pool.name,
					filterPool: pool.name,
					runId: run.runId
				}
			});
			if (received !== "stored" && received !== "duplicate") throw new Error(`${item.id} 被接收规则拒绝：${received}`);
			ctx.atomic(() => {
				const saved = state(), previous = saved.records?.[key];
				if (previous?.triggerId === triggerId) ctx.state.set(stateKey, {
					...saved,
					records: {
						...saved.records,
						[key]: {
							...previous,
							state: "queued",
							dispatching: false
						}
					}
				});
			});
			if (received === "stored") dispatched++;
		} catch (failure) {
			error = String(failure).slice(0, 300);
			ctx.atomic(() => {
				const saved = state(), previous = saved.records?.[key];
				if (previous?.triggerId === triggerId) ctx.state.set(stateKey, {
					...saved,
					records: {
						...saved.records,
						[key]: {
							...previous,
							state: "failed",
							dispatching: false
						}
					}
				});
			});
		}
	}
	ctx.atomic(() => {
		const saved = state();
		ctx.state.set(stateKey, {
			...saved,
			lastRun: !error && !manual ? localDay(now) : saved.lastRun,
			runIds: [.../* @__PURE__ */ new Set([...saved.runIds, run.runId])].slice(-30),
			dispatched,
			at: now.toISOString()
		});
	});
	return {
		planned: run.items.length,
		dispatched,
		runId: run.runId,
		...error ? { error } : {}
	};
}
//#endregion
export { tapdFilterRowsReady as $, tapdTime as A, TapdFilterPoolSchema as B, resolveTapdName as C, TapdOpenApi as D, TapdConfigSchema as E, tapdCredentialStatus as F, localDay as G, applyOwnerOverride as H, tapdEnvironment as I, parseScrapedConditions as J, mergeIntoPool as K, CDP_DOM_EXPRESSION as L, TapdCredentialError as M, saveTapdCredential as N, itemAddress as O, tapdCredential as P, schemeHash as Q, FILTER_SCHEME_SOURCES as R, cleanOwner as S, TAPD_TYPES as T, compileSchemeBranches as U, TapdFilterSchemeSchema as V, fallbackConditions as W, poolWithRuntime as X, poolItemKey as Y, reconcilePoolState as Z, threadItem as _, itemThread as a, cachedTapdName as b, mentions as c, pollRound as d, matchesLocal as et, pollWatch as f, signatureOf as g, sendTapd as h, inject as i, watchWorkspace as j, tapdApi as k, name as l, resolvedConfig as m, apply as n, itemTrigger as o, replyMarker as p, parseDomConditions as q, commentTrigger as r, makeTapdKind as s, runPoolDaily as t, pollComments as u, watch as v, TAPD_SOURCE as w, resolveTapdIdentity as x, watchFilter as y, PoolItemSchema as z };
