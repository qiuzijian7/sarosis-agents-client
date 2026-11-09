import { A as key, L as liveTicket, S as string, b as object, h as array, m as _enum, y as number } from "./poll-BQME6Yxb.js";
import { createHash } from "node:crypto";
const P4ConfigSchema = object({
	cli: string().trim().default("p4"),
	port: string().trim().default(""),
	user: string().trim().regex(/^[^\s@#%*]*$/).default(""),
	paths: array(object({ path: string().trim().regex(/^\/\/[^\s]+$/) }).strict()).default([]),
	pollSeconds: number().int().min(30).max(3600).default(60),
	failuresBeforeError: number().int().min(1).max(20).default(3),
	/**
	* How an approved CL is submitted: `pipeline` adds `pipelineTags` to its description so the server's own
	* shelve-for-submit automation submits it; `host` has dsh-superagent submit it as `submitUser` from `submitClient`.
	*/
	submit: _enum(["pipeline", "host"]).default("pipeline"),
	pipelineTags: string().trim().default("#review #ShelveForSubmit"),
	submitUser: string().trim().regex(/^[^\s@#%*]*$/).default(""),
	submitClient: string().trim().regex(/^[^\s@#%*]*$/).default("")
}).strict();
const p4Configured = (config) => !!config.port && !!config.user && config.paths.length > 0;
const globals = (config, call) => {
	const user = call.user ?? config.user;
	return [
		...config.port ? ["-p", config.port] : [],
		...user ? ["-u", user] : [],
		...call.client ? ["-c", call.client] : []
	];
};
/** Runs `p4 -Mj -ztag` with the Source's server and execution account and returns its data records (messages dropped). */
async function p4(commands, config, args, call = {}) {
	return (await commands.run(config.cli || "p4", [
		...globals(config, call),
		"-Mj",
		"-ztag",
		...args
	], void 0, call.input)).split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		const record = JSON.parse(line);
		if (typeof record.severity === "number") {
			if (record.severity >= 3) throw new Error(String(record.data ?? "p4 failed").trim());
			return [];
		}
		return [Object.fromEntries(Object.entries(record).map(([name, value]) => [name, String(value)]))];
	});
}
/** Runs `p4 -Mj` (no tagged fields) and returns its info messages, such as `Change 12 created.`. */
async function p4Messages(commands, config, args, call = {}) {
	return (await commands.run(config.cli || "p4", [
		...globals(config, call),
		"-Mj",
		...args
	], void 0, call.input)).split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		const record = JSON.parse(line);
		if (typeof record.severity === "number" && record.severity >= 3) throw new Error(String(record.data ?? "p4 failed").trim());
		return typeof record.data === "string" ? [record.data] : [];
	});
}
const DIFF_HEADER = /^==== (\/\/.+?)#(\d+|none) \((.+)\) ====$/;
/** Splits the text of `p4 describe -S -du` into each file's unified difference, at most `maxLines` lines per file. */
function parseDiffs(text, maxLines = 2e3) {
	const diffs = [];
	let current;
	for (const line of text.split(/\r?\n/)) {
		const header = DIFF_HEADER.exec(line);
		if (header) {
			current = {
				depotFile: header[1],
				rev: header[2],
				type: header[3],
				lines: []
			};
			diffs.push(current);
			continue;
		}
		if (!current) continue;
		if (current.lines.length >= maxLines) {
			current.truncated = true;
			continue;
		}
		if (current.lines.length || line) current.lines.push(line);
	}
	for (const diff of diffs) while (diff.lines.at(-1) === "") diff.lines.pop();
	return diffs;
}
/** Reads the unified differences of a CL's shelf. */
async function shelfDiffs(commands, config, change) {
	const global = globals(config, {});
	return parseDiffs(await commands.run(config.cli || "p4", [
		...global,
		"describe",
		"-S",
		"-du",
		String(change)
	]));
}
/** Files of a `describe` record, which numbers them `depotFile0`, `action0`, … */
function filesOf(record) {
	const files = [];
	for (let index = 0; record[`depotFile${index}`] !== void 0; index++) {
		const digest = record[`digest${index}`];
		files.push({
			depotFile: record[`depotFile${index}`],
			action: record[`action${index}`] ?? "",
			rev: record[`rev${index}`] ?? "",
			type: record[`type${index}`] ?? "",
			...digest ? { digest } : {}
		});
	}
	return files;
}
/**
* Reads a CL by the number it was created with (`-O` follows a submit's renumbering), and for a pending CL its shelf.
* @returns undefined when the server knows no such CL, as after it was deleted.
*/
async function readChange(commands, config, number) {
	let record;
	try {
		record = (await p4(commands, config, [
			"describe",
			"-s",
			"-O",
			String(number)
		]))[0];
	} catch (error) {
		if (/\bunknown\b/i.test(String(error))) return void 0;
		throw error;
	}
	if (!record) return void 0;
	const status = record.status === "submitted" ? "submitted" : record.status === "shelved" ? "shelved" : "pending";
	const shelf = status === "submitted" ? void 0 : (await p4(commands, config, [
		"describe",
		"-S",
		"-s",
		record.change ?? String(number)
	]))[0];
	return {
		number,
		current: Number(record.change) || number,
		status,
		client: record.client ?? "",
		user: record.user ?? "",
		description: record.desc ?? "",
		time: record.time ?? "",
		files: filesOf(record),
		shelved: shelf ? filesOf(shelf) : []
	};
}
/** Matches a depot path against a Perforce path pattern: `...` is any text, `*` any text within one directory. */
function inPath(depotFile, pattern, caseSensitive = true) {
	const source = pattern.split(/(\.\.\.|\*)/).map((part) => part === "..." ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("");
	return new RegExp(`^${source}$`, caseSensitive ? "" : "i").test(depotFile);
}
/** The shelf's content fingerprint a person approves: it changes when any file, its action or its content changes. */
function fingerprint(files) {
	const lines = files.map((file) => `${file.depotFile}\t${file.action}\t${file.type}\t${file.digest ?? ""}`).sort();
	return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}
/** The workspace a ticket's CL must belong to: its name ends with the ticket's short name, such as `superagent-<name>`. */
const ticketClient = (ticket, client) => !!ticket.execution?.name && (client === ticket.execution.name || client.endsWith(`-${ticket.execution.name}`));
const changeNumber = (thread) => thread.startsWith(`p4:`) ? Number(thread.slice(3)) : void 0;
const changesOf = (ticket, open = false) => (ticket.follows ?? []).filter((item) => !open || !item.closed).flatMap((item) => changeNumber(item.thread) ?? []);
/**
* Binds a pending CL to the ticket as its own Thread when the CL is the execution account's, belongs to the ticket's
* workspace, and touches only files under the Source's allowed paths; one CL binds to at most one open ticket.
* @returns why the CL was refused, or undefined once it is bound.
*/
function claimChangelist(ctx, config, ticketId, change) {
	const ticket = ctx.tickets.get(ticketId);
	if (!ticket || !liveTicket(ticket)) return "Ticket ended; do not report a changelist for it";
	if (change.status !== "pending") return `Changelist ${change.number} is ${change.status}; report a pending changelist`;
	if (config.user && change.user !== config.user) return `Changelist ${change.number} belongs to ${change.user}, not to the execution account ${config.user}`;
	if (!ticketClient(ticket, change.client)) return `Changelist ${change.number} is in workspace ${change.client}; use a workspace whose name ends with -${ticket.execution?.name ?? "DSH_SUPERAGENT_NAME"}`;
	const files = [...change.files, ...change.shelved];
	if (!files.length) return `Changelist ${change.number} has no files`;
	const outside = [...new Set(files.map((file) => file.depotFile).filter((file) => !config.paths.some((item) => inPath(file, item.path))))];
	if (outside.length) return `Changelist ${change.number} has files outside the allowed paths: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", …" : ""}`;
	const owner = ctx.tickets.open().find((item) => changesOf(item, true).includes(change.number));
	if (owner && owner.id !== ticketId) return `Changelist ${change.number} already belongs to another active ticket`;
	const follow = ticket.follows?.find((item) => item.thread === `p4:${change.number}`);
	if (!follow || follow.closed || !follow.own) ctx.atomic(() => {
		ctx.tickets.bindThread(ticketId, {
			source: "p4",
			id: String(change.number)
		}, true);
		ctx.threads.patch(`p4:${change.number}`, {
			change: change.number,
			client: change.client
		});
	});
	ctx.threads.describe(`p4:${change.number}`, { label: `CL ${change.number}` });
}
/**
* The notices a ticket that ended with its CL submitted sends to its conversations, such as a comment on its TAPD item,
* once per CL and conversation. `meta` reads a Thread's meta, where a submit records its submitted number.
*/
function changeEndNotices(ticket, meta) {
	if (ticket.ended?.outcome !== "merged") return [];
	const follow = (ticket.follows ?? []).filter((item) => item.own && item.closed && changeNumber(item.thread) !== void 0).sort((a, b) => b.closed.at.localeCompare(a.closed.at))[0];
	if (!follow) return [];
	const number = changeNumber(follow.thread);
	const submitted = Number(meta(follow.thread)?.submittedAs) || number;
	const text = submitted !== number ? `已提交为 CL ${submitted}（审核的是 CL ${number} 的 shelve）。` : `CL ${number} 已提交。`;
	return ticket.channels.filter((channel) => channel.source !== "p4").map((channel) => ({
		id: key("cl-submitted", String(number), channel.source, JSON.stringify(channel.address)),
		channel,
		text,
		kind: "notice",
		ticketId: ticket.id
	}));
}
/**
* Reports a submitted or deleted CL once to the open tickets that follow it, whose end the core decides.
* @returns whether the CL has ended.
*/
function observeChange(ctx, number, change) {
	if (!(!change || change.status === "submitted")) return false;
	if (ctx.tickets.open().some((ticket) => changesOf(ticket, true).includes(number))) {
		const at = change?.time ? (/* @__PURE__ */ new Date(Number(change.time) * 1e3)).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
		ctx.tickets.threadClosed({
			source: "p4",
			id: String(number)
		}, change ? "merged" : "closed", at);
	}
	if (change && change.current !== number) ctx.threads.patch(`p4:${number}`, { submittedAs: change.current });
	return true;
}
//#endregion
export { fingerprint as a, p4 as c, readChange as d, shelfDiffs as f, claimChangelist as i, p4Configured as l, changeEndNotices as n, inPath as o, changesOf as r, observeChange as s, P4ConfigSchema as t, p4Messages as u };
