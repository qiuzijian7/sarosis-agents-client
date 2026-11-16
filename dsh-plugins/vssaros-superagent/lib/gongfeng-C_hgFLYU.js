import { A as key, R as liveTicket, S as string, a as polled, b as object, g as boolean, h as array, m as _enum, r as pause, s as sourceContext, v as looseObject, y as number } from "./poll-DRgTfbJS.js";
import { t as KV } from "./kv-DEhBtrT7.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
//#region src/sources/gongfeng-api.ts
/** Independent Gongfeng API v3 transport. MR IID is resolved to its internal ID before detail/note operations. */
const GONGFENG_SOURCE = "gongfeng";
const positive = number().int().positive().safe();
const account = object({
	id: positive,
	username: string().min(1),
	bot: boolean().optional()
});
const GongfengConfigSchema = object({
	api: string().trim().url().refine((value) => {
		const url = new URL(value);
		return url.origin === "https://git.woa.com" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/api/v3";
	}, "The supported Gongfeng endpoint is https://git.woa.com/api/v3").default("https://git.woa.com/api/v3"),
	project: string().trim().regex(/^\d*$/).default(""),
	agent: string().trim().regex(/^[\w.-]*$/).default(""),
	bots: array(object({ id: string().trim().regex(/^[\w.-]+$/) }).strict()).max(100).default([]),
	observeMrs: boolean().default(false),
	observeComments: boolean().default(false),
	pollSeconds: number().int().min(60).max(3600).default(120),
	failuresBeforeError: number().int().min(1).max(20).default(3)
}).strict();
const GongfengMrSchema = looseObject({
	id: positive,
	iid: positive,
	project_id: positive,
	source_project_id: positive.nullish(),
	target_project_id: positive.nullish(),
	title: string(),
	description: string().nullish(),
	source_branch: string().min(1),
	target_branch: string().min(1),
	state: _enum([
		"opened",
		"reopened",
		"closed",
		"merged"
	]),
	author: account,
	created_at: string().datetime({ offset: true }),
	updated_at: string().datetime({ offset: true }),
	merged_at: string().datetime({ offset: true }).nullish(),
	closed_at: string().datetime({ offset: true }).nullish(),
	web_url: string().optional()
});
const GongfengNoteSchema = looseObject({
	id: positive,
	body: string(),
	author: account,
	created_at: string().datetime({ offset: true }),
	updated_at: string().datetime({ offset: true }).optional(),
	system: boolean().default(false)
});
/** Redacted API/identity errors, without returning credential material or server response bodies. */
var GongfengError = class extends Error {
	constructor(message) {
		super(`Gongfeng: ${message}`);
		this.name = "GongfengError";
	}
};
/** Only Host environment or its private local credential file; never a token in Source settings/tool responses. */
function gongfengToken(env = process.env) {
	const direct = env.DSH_SUPERAGENT_GONGFENG_TOKEN?.trim() || env.WOA_GITLAB_TOKEN?.trim();
	if (direct) return direct;
	const file = env.DSH_SUPERAGENT_GONGFENG_ENV_FILE?.trim() || join(env.DSH_HOME || join(homedir(), ".dsh"), "gongfeng.env");
	try {
		const text = readFileSync(file, "utf8");
		return /^\s*DSH_SUPERAGENT_GONGFENG_TOKEN\s*=\s*([^\r\n]+)\s*$/m.exec(text)?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2") || void 0;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return void 0;
		throw new GongfengError("Cannot read the local credential file");
	}
}
const gongfengPage = (config, mr, path) => `${new URL(config.api).origin}/${path}/merge_requests/${mr.iid}`;
/** Requests have deadlines, refuse credential-bearing redirects, and never retry writes. */
var GongfengOpenApi = class {
	config;
	options;
	token;
	constructor(config, options = {}) {
		this.config = config;
		this.options = options;
	}
	async request(method, path, fields, signal) {
		signal?.throwIfAborted();
		const token = this.token ??= (this.options.token ?? gongfengToken)();
		if (!token || /[\r\n]/.test(token)) throw new GongfengError("Set DSH_SUPERAGENT_GONGFENG_TOKEN in the Host environment or gongfeng.env");
		const query = new URLSearchParams(fields).toString();
		const url = `${this.config.api}/${path}${method === "GET" && query ? `?${query}` : ""}`;
		const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15e3);
		let response;
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				method,
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				headers: {
					"PRIVATE-TOKEN": token,
					accept: "application/json",
					...method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}
				},
				...method === "POST" ? { body: query } : {}
			});
		} catch {
			signal?.throwIfAborted();
			throw new GongfengError("Request failed, timed out or attempted a redirect; no write retry performed");
		}
		if (!response.ok) throw new GongfengError(`HTTP ${response.status}; check account, project and access (response body omitted)`);
		const reader = response.body?.getReader();
		if (!reader) throw new GongfengError("Empty response body");
		const chunks = [];
		let bytes = 0;
		try {
			for (;;) {
				signal?.throwIfAborted();
				timeout.throwIfAborted();
				const part = await reader.read();
				if (part.done) break;
				bytes += part.value.byteLength;
				if (bytes > 2e6) {
					await reader.cancel();
					throw new GongfengError("Response exceeds the read limit");
				}
				chunks.push(part.value);
			}
		} catch {
			signal?.throwIfAborted();
			throw new GongfengError("Response read failed or exceeded its deadline/size; inspect write outcomes before retrying");
		} finally {
			reader.releaseLock();
		}
		const text = Buffer.concat(chunks).toString("utf8");
		try {
			return {
				value: JSON.parse(text),
				next: response.headers.get("x-next-page")
			};
		} catch {
			throw new GongfengError("Unexpected response envelope");
		}
	}
	async list(path, schema, page, fields = {}, signal) {
		if (!Number.isInteger(page) || page < 1 || page > 10) throw new GongfengError("Page must be 1–10");
		const result = await this.request("GET", path, {
			...fields,
			page: String(page),
			per_page: "50"
		}, signal);
		const parsed = array(schema).safeParse(result.value);
		if (!parsed.success) throw new GongfengError("Unexpected list schema");
		const more = result.next === null ? parsed.data.length === 50 : result.next !== "";
		if (result.next && result.next !== String(page + 1)) throw new GongfengError("Unexpected next-page cursor");
		if (more && page === 10) throw new GongfengError("Pagination limit reached; narrow the project before advancing its cursor");
		return {
			items: parsed.data,
			next: more ? page + 1 : null
		};
	}
	async verify(agent, signal) {
		const user = account.safeParse((await this.request("GET", "user", {}, signal)).value);
		const project = looseObject({
			id: positive,
			path_with_namespace: string().min(1),
			permissions: object({
				project_access: object({ access_level: number() }).nullish(),
				group_access: object({ access_level: number() }).nullish()
			}).nullish()
		}).safeParse((await this.request("GET", `projects/${this.config.project}`, {}, signal)).value);
		if (!user.success || !project.success || String(project.data.id) !== this.config.project) throw new GongfengError("Unexpected account/project schema");
		if (agent && user.data.username !== agent) throw new GongfengError("The token account differs from the configured execution account");
		const level = Math.max(project.data.permissions?.project_access?.access_level ?? 0, project.data.permissions?.group_access?.access_level ?? 0);
		return {
			project: String(project.data.id),
			path: project.data.path_with_namespace,
			username: user.data.username,
			canPush: level >= 30
		};
	}
	mrs(page, signal) {
		return this.list(`projects/${this.config.project}/merge_requests`, GongfengMrSchema, page, {
			order_by: "updated_at",
			sort: "desc"
		}, signal);
	}
	async mr(iid, signal) {
		if (!Number.isSafeInteger(iid) || iid <= 0) throw new GongfengError("Invalid MR IID");
		const result = await this.request("GET", `projects/${this.config.project}/merge_requests`, {
			iid: String(iid),
			page: "1",
			per_page: "50"
		}, signal);
		const matches = array(GongfengMrSchema).safeParse(result.value);
		if (!matches.success) throw new GongfengError("Unexpected MR lookup schema");
		const found = matches.data.filter((mr) => mr.iid === iid && String(mr.project_id) === this.config.project);
		if (found.length !== 1) throw new GongfengError("MR not found or ambiguous");
		const detail = GongfengMrSchema.safeParse((await this.request("GET", `projects/${this.config.project}/merge_requests/${found[0].id}`, {}, signal)).value);
		if (!detail.success || detail.data.id !== found[0].id || detail.data.iid !== iid || String(detail.data.project_id) !== this.config.project) throw new GongfengError("MR identity mismatch");
		return detail.data;
	}
	notes(id, page, signal) {
		if (!Number.isSafeInteger(id) || id <= 0) throw new GongfengError("Invalid internal MR ID");
		return this.list(`projects/${this.config.project}/merge_requests/${id}/notes`, GongfengNoteSchema, page, {
			order_by: "created_at",
			sort: "asc"
		}, signal);
	}
	async note(id, body, signal) {
		if (!Number.isSafeInteger(id) || id <= 0 || !body.trim()) throw new GongfengError("Invalid note target/body");
		await this.request("POST", `projects/${this.config.project}/merge_requests/${id}/notes`, { body }, signal);
	}
	async create(input, signal) {
		const parsed = GongfengMrSchema.safeParse((await this.request("POST", `projects/${this.config.project}/merge_requests`, input, signal)).value);
		if (!parsed.success || String(parsed.data.project_id) !== this.config.project || String(parsed.data.source_project_id) !== this.config.project || parsed.data.source_branch !== input.source_branch || parsed.data.target_branch !== input.target_branch || parsed.data.author.username !== this.config.agent || !["opened", "reopened"].includes(parsed.data.state)) throw new GongfengError("MR creation response could not be verified; inspect the project before retrying");
		return parsed.data;
	}
};
//#endregion
//#region src/sources/gongfeng.ts
/** Gongfeng Source: scoped MR intake, comment replies, and independent delivery lifecycle (no automatic merge). */
const gongfengThread = (project, iid) => `${project}:${iid}`;
function gongfengRef(thread) {
	const match = /^(\d+):(\d+)$/.exec(thread);
	const iid = Number(match?.[2]);
	return match && Number.isSafeInteger(iid) && iid > 0 ? {
		project: match[1],
		iid
	} : void 0;
}
const address = (config, mr) => ({
	project: config.project,
	iid: String(mr.iid)
});
const mentions = (text, agent) => !!agent && new RegExp(`(?:^|\\s)@${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s.,:;!?，。])`, "i").test(text);
function gongfengTrigger(config, mr, path, note) {
	if (String(mr.project_id) !== config.project || note?.system) return void 0;
	const author = note?.author ?? mr.author;
	if (author.username === config.agent) return void 0;
	const text = note?.body ?? `${mr.title}\n${mr.description ?? ""}`;
	const bot = author.bot === true || config.bots.some((row) => row.id === author.username);
	const addressed = mentions(text, config.agent);
	return {
		id: key(GONGFENG_SOURCE, config.project, String(mr.iid), note ? `note:${note.id}:${note.updated_at ?? note.created_at}` : `mr:${mr.updated_at}`),
		source: GONGFENG_SOURCE,
		threads: [{
			source: GONGFENG_SOURCE,
			id: gongfengThread(config.project, mr.iid)
		}],
		actor: {
			source: GONGFENG_SOURCE,
			id: author.username
		},
		human: !bot,
		...addressed ? { addressed: "mention" } : {},
		at: note?.updated_at ?? note?.created_at ?? mr.updated_at,
		text,
		channel: {
			source: GONGFENG_SOURCE,
			thread: `${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`,
			address: address(config, mr)
		},
		url: gongfengPage(config, mr, path),
		meta: {
			project: config.project,
			iid: mr.iid,
			mrId: mr.id,
			kind: note ? "comment" : "mr",
			addressed,
			...note ? { noteId: note.id } : {}
		}
	};
}
/** A source MR or verified same-project agent branch only; never steals another ticket's MR. */
function claimGongfengMr(ctx, config, ticketId, mr, path) {
	const ticket = ctx.tickets.get(ticketId);
	if (!ticket || !liveTicket(ticket)) return "Ticket ended";
	if (String(mr.project_id) !== config.project || String(mr.target_project_id ?? mr.project_id) !== config.project) return "MR project differs from the configured project";
	const origin = ctx.triggers.get(ticket.origin.triggerId);
	const started = origin?.source === "gongfeng" && origin.meta.project === config.project && origin.meta.iid === mr.iid;
	const opened = !!config.agent && mr.author.username === config.agent && String(mr.source_project_id ?? "") === config.project && !!ticket.execution?.name && mr.source_branch === `agent/${ticket.execution.name}`;
	if (!started && !opened) return "MR does not belong to this ticket; use its source MR or the execution account and ticket branch in this project";
	if (ctx.tickets.open().some((other) => other.id !== ticketId && other.follows?.some((follow) => !follow.closed && follow.thread === `gongfeng:${gongfengThread(config.project, mr.iid)}`))) return "MR already belongs to another active ticket";
	if (mr.state !== "opened" && mr.state !== "reopened") return "MR is not open; do not report it as ready";
	ctx.atomic(() => {
		ctx.tickets.bindThread(ticketId, {
			source: GONGFENG_SOURCE,
			id: gongfengThread(config.project, mr.iid)
		}, opened || started);
		ctx.threads.patch(`${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`, {
			project: config.project,
			iid: mr.iid,
			mrId: mr.id,
			projectPath: path
		});
		ctx.threads.describe(`${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`, {
			label: `MR !${mr.iid}: ${mr.title}`,
			url: gongfengPage(config, mr, path)
		});
	});
}
function observeGongfengMr(ctx, config, mr) {
	if (String(mr.project_id) !== config.project) return;
	if (mr.state === "closed" || mr.state === "merged") ctx.tickets.threadClosed({
		source: GONGFENG_SOURCE,
		id: gongfengThread(config.project, mr.iid)
	}, mr.state === "merged" ? "merged" : "closed", mr.merged_at ?? mr.closed_at ?? mr.updated_at);
	else {
		const thread = `${GONGFENG_SOURCE}:${gongfengThread(config.project, mr.iid)}`;
		for (const ticket of ctx.tickets.open()) {
			const follow = ticket.follows?.find((item) => item.thread === thread);
			if (follow?.closed) ctx.tickets.bindThread(ticket.id, {
				source: GONGFENG_SOURCE,
				id: gongfengThread(config.project, mr.iid)
			}, follow.own);
		}
	}
}
async function allNotes(api, id, signal) {
	const out = [];
	for (let page = 1; page !== null;) {
		const got = await api.notes(id, page, signal);
		out.push(...got.items);
		page = got.next;
		if (page !== null && page > 10) throw new Error("Gongfeng comment page limit reached");
	}
	return out;
}
/** Baselines pre-existing history, deterministic event IDs, and advances cursors only after successful ingestion. */
async function pollGongfeng(ctx, config, api, signal) {
	const identity = await api.verify(config.agent, signal);
	const signature = JSON.stringify([
		config.api,
		config.project,
		config.agent,
		config.observeMrs,
		config.observeComments,
		config.bots
	]);
	const previous = ctx.state.get(KV.gongfeng.watch(config.project));
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const state = previous?.signature === signature ? previous : {
		initializedAt: now,
		signature,
		seen: {}
	};
	const mrs = /* @__PURE__ */ new Map();
	for (let page = 1; page !== null;) {
		const got = await api.mrs(page, signal);
		for (const mr of got.items) {
			if (String(mr.project_id) !== config.project) throw new Error("Gongfeng MR list project mismatch");
			mrs.set(mr.iid, mr);
		}
		page = got.next;
		if (page !== null && page > 10) throw new Error("Gongfeng MR page limit reached");
	}
	for (const thread of ctx.threads.subscribed(GONGFENG_SOURCE)) {
		const ref = gongfengRef(thread.key.slice(`${GONGFENG_SOURCE}:`.length));
		if (ref?.project === config.project && polled(ctx, thread) && !mrs.has(ref.iid)) mrs.set(ref.iid, await api.mr(ref.iid, signal));
	}
	const check = () => {
		signal?.throwIfAborted();
		if (JSON.stringify(ctx.config("gongfeng")) !== JSON.stringify(config)) throw new Error("Gongfeng configuration changed during polling");
	};
	check();
	const seen = {};
	for (const mr of mrs.values()) {
		signal?.throwIfAborted();
		const content = createHash("sha256").update(JSON.stringify([mr.title, mr.description])).digest("hex");
		const prior = state.seen[String(mr.iid)];
		if (previous?.signature === signature && content !== prior && Date.parse(mr.updated_at) >= Date.parse(state.initializedAt)) {
			let trigger = gongfengTrigger(config, mr, identity.path);
			if (trigger && (prior !== void 0 || Date.parse(mr.created_at) < Date.parse(state.initializedAt))) trigger = {
				...trigger,
				human: false,
				addressed: void 0,
				meta: {
					...trigger.meta,
					addressed: false,
					updaterUnknown: true
				}
			};
			check();
			if (trigger && (config.observeMrs || trigger.addressed)) await ctx.receive(trigger);
		}
		observeGongfengMr(ctx, config, mr);
		const notes = await allNotes(api, mr.id, signal);
		const cursorKey = KV.gongfeng.notes(config.project, mr.iid);
		const cursor = ctx.state.get(cursorKey);
		for (const note of notes) {
			const at = note.updated_at ?? note.created_at;
			if (Date.parse(at) < Date.parse(cursor?.signature === signature ? cursor.at : state.initializedAt)) continue;
			const trigger = gongfengTrigger(config, mr, identity.path, note);
			check();
			if (trigger && (config.observeComments || trigger.addressed)) await ctx.receive(trigger);
		}
		check();
		ctx.state.set(cursorKey, {
			signature,
			at: new Date(notes.reduce((last, note) => Math.max(last, Date.parse(note.updated_at ?? note.created_at)), Date.parse(cursor?.signature === signature ? cursor.at : state.initializedAt))).toISOString()
		});
		seen[String(mr.iid)] = content;
	}
	check();
	ctx.state.set(KV.gongfeng.watch(config.project), {
		initializedAt: state.initializedAt,
		signature,
		seen
	});
}
function makeGongfengKind(context, apiOf = (config) => new GongfengOpenApi(config)) {
	const active = () => context()?.config(GONGFENG_SOURCE);
	return {
		kind: GONGFENG_SOURCE,
		title: {
			zh: "工蜂",
			en: "Gongfeng"
		},
		description: {
			zh: "独立工蜂 API v3：接收 MR 与评论，报告并跟踪工单 MR。首次启用只建立历史基线，不自动处理存量 MR；不会自动合并。",
			en: "Independent Gongfeng API v3 MR/comment intake and delivery tracking; baselines existing history on activation, never merges automatically."
		},
		schema: GongfengConfigSchema,
		health: [GONGFENG_SOURCE],
		fields: [
			{
				key: "project",
				type: "text",
				label: {
					zh: "工蜂项目 ID",
					en: "Gongfeng project ID"
				},
				pattern: "\\d+",
				hint: {
					zh: "填数字项目 ID，不是 GitHub owner/name 或本机目录。",
					en: "Numeric project ID, not a GitHub name or local directory."
				}
			},
			{
				key: "agent",
				type: "text",
				label: {
					zh: "执行账号用户名",
					en: "Execution username"
				},
				hint: {
					zh: "须与 API Token 账号一致；Host 环境变量 DSH_SUPERAGENT_GONGFENG_TOKEN，或本机 gongfeng.env 保存同名键。密钥不进设置。",
					en: "Must match the token account. Host DSH_SUPERAGENT_GONGFENG_TOKEN or the same key in local gongfeng.env; no secret in settings."
				}
			},
			{
				key: "observeMrs",
				type: "switch",
				label: {
					zh: "接收未 @ 的 MR 变化",
					en: "Observe unaddressed MR changes"
				}
			},
			{
				key: "observeComments",
				type: "switch",
				label: {
					zh: "接收未 @ 的评论",
					en: "Observe unaddressed comments"
				}
			},
			{
				key: "bots",
				type: "rows",
				label: {
					zh: "机器人账号（不得作为人工授权）",
					en: "Bot accounts (never human authority)"
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "用户名",
						en: "Username"
					}
				}]
			},
			{
				key: "api",
				type: "text",
				advanced: true,
				label: {
					zh: "工蜂 API v3 地址",
					en: "Gongfeng API v3 URL"
				}
			},
			{
				key: "pollSeconds",
				type: "number",
				advanced: true,
				min: 60,
				max: 3600,
				label: {
					zh: "轮询间隔 / 秒",
					en: "Poll interval / seconds"
				}
			},
			{
				key: "failuresBeforeError",
				type: "number",
				advanced: true,
				min: 1,
				max: 20,
				label: {
					zh: "连续失败阈值",
					en: "Failure threshold"
				}
			}
		],
		scope: ({ meta }, config) => {
			if (meta.project !== config.project || meta.kind !== "mr" && meta.kind !== "comment") return {
				listened: false,
				reason: "gongfeng_project_mismatch"
			};
			return {
				listened: true,
				observed: !meta.addressed,
				row: meta.kind === "comment" ? "comments" : "mrs"
			};
		},
		policy: {
			schema: object({ allowed: array(object({
				id: string().min(1),
				name: string().optional()
			})).default([]) }).strict(),
			fields: [{
				key: "allowed",
				type: "rows",
				label: {
					zh: "可发起工作的工蜂账号",
					en: "Gongfeng users allowed to request work"
				},
				columns: [{
					key: "id",
					type: "text",
					label: {
						zh: "用户名",
						en: "Username"
					}
				}]
			}],
			explicit: {
				zh: "名单中的人，在 MR 或评论里 @ 执行账号。机器人不产生人工授权。",
				en: "An allowed human mentions the execution account in an MR/note; bots never authorize work."
			},
			rows: () => ["mrs", "comments"].map((id) => ({
				id,
				label: id === "mrs" ? "MR" : {
					zh: "评论",
					en: "Comments"
				},
				note: {
					zh: "按配置接收",
					en: "Configured intake"
				},
				cells: {
					listedUnaddressed: true,
					unlistedAddressed: true,
					unlistedUnaddressed: true
				}
			}))
		},
		channel: {
			allowed: (addr, config) => addr.project === config.project && !!gongfengRef(`${addr.project}:${addr.iid}`),
			send: async (_host, message) => {
				const config = active();
				if (!config) throw new Error("Gongfeng Source is disabled");
				const ref = gongfengRef(`${message.channel.address.project}:${message.channel.address.iid}`);
				if (!ref || ref.project !== config.project) throw new Error("Gongfeng reply project mismatch");
				const ctx = context(), api = apiOf(config);
				await api.verify(config.agent);
				const mr = await api.mr(ref.iid);
				const marker = `<!-- dsh-superagent:${key("gongfeng-reply", message.id)} -->`;
				const record = KV.gongfeng.reply(config.project, message.id);
				const found = (await allNotes(api, mr.id)).some((note) => note.author.username === config.agent && note.body.includes(marker));
				if (JSON.stringify(active()) !== JSON.stringify(config)) throw new Error("Gongfeng configuration changed before reply");
				if (found || ctx.state.get(record) === "sent") {
					ctx.state.set(record, "sent");
					return "sent";
				}
				if (ctx.state.get(record) === "pending") throw new Error("Previous Gongfeng reply outcome is uncertain; inspect the MR before any manual retry");
				if (mr.state === "closed" || mr.state === "merged") return "gone";
				ctx.state.set(record, "pending");
				await api.note(mr.id, `${message.text}\n\n${marker}`);
				ctx.state.set(record, "sent");
				return "sent";
			},
			link: (addr) => {
				const config = active(), path = context()?.threads.get(`${GONGFENG_SOURCE}:${addr.project}:${addr.iid}`)?.meta.projectPath;
				return {
					url: config && typeof path === "string" ? gongfengPage(config, { iid: Number(addr.iid) }, path) : "",
					label: {
						zh: `工蜂 MR !${addr.iid}`,
						en: `Gongfeng MR !${addr.iid}`
					}
				};
			}
		},
		threadContext: {
			messageId: (trigger) => String(trigger.meta.noteId ?? `mr:${trigger.meta.iid}`),
			read: async (_commands, trigger, part, cursor, config) => {
				if (trigger.meta.project !== config.project) throw new Error("Gongfeng context project mismatch");
				const api = apiOf(config), mr = await api.mr(Number(trigger.meta.iid));
				if (part === "parent") return {
					messages: [],
					body: {},
					status: "No parent-note identity is available"
				};
				if (part === "root") return {
					messages: [{
						id: `mr:${mr.iid}`,
						from: mr.author.username,
						at: mr.created_at,
						text: `${mr.title}\n${mr.description ?? ""}`,
						...mr.author.bot ? { bot: true } : {}
					}],
					body: {
						iid: mr.iid,
						state: mr.state
					}
				};
				const page = cursor ? Number(cursor) : 1, notes = await api.notes(mr.id, page);
				return {
					messages: notes.items.filter((note) => !note.system).map((note) => ({
						id: String(note.id),
						from: note.author.username,
						at: note.created_at,
						text: note.body,
						...note.author.bot || config.bots.some((bot) => bot.id === note.author.username) ? { bot: true } : {}
					})),
					body: {
						iid: mr.iid,
						state: mr.state
					},
					...notes.next ? { next: String(notes.next) } : {}
				};
			}
		}
	};
}
const name = "dsh-superagent-gongfeng";
const inject = ["orchestrator"];
function apply(ctx) {
	let source;
	const kind = makeGongfengKind(() => source);
	ctx.effect(() => ctx.orchestrator.sources.register(kind), "gongfeng: source kind");
	ctx.effect(() => {
		source = sourceContext(ctx.orchestrator, kind);
		const cancel = new AbortController(), current = source;
		const running = watchGongfeng(current, cancel.signal).catch((error) => {
			if (!cancel.signal.aborted) current.report(GONGFENG_SOURCE, {
				state: "error",
				detail: String(error)
			});
		});
		return async () => {
			cancel.abort();
			await running;
			source = void 0;
		};
	});
}
async function watchGongfeng(ctx, signal) {
	await ctx.ready;
	let failures = 0;
	while (!signal.aborted) {
		const config = ctx.config(GONGFENG_SOURCE);
		try {
			if (!config || !config.project || !config.agent || !ctx.configured()) ctx.report(GONGFENG_SOURCE, {
				state: "paused",
				detail: !config ? "Off" : "Configure Gongfeng project ID, execution username and Host token; existing history is not ingested"
			});
			else {
				await pollGongfeng(ctx, config, new GongfengOpenApi(config), signal);
				ctx.report(GONGFENG_SOURCE, {
					state: "ready",
					detail: "MR/comment polling ready; no automatic merge"
				});
			}
			failures = 0;
		} catch (error) {
			if (!signal.aborted && ++failures >= (config?.failuresBeforeError ?? 1)) ctx.report(GONGFENG_SOURCE, {
				state: "error",
				detail: String(error)
			});
		}
		await pause((config?.pollSeconds ?? 120) * 1e3, signal);
	}
}
//#endregion
export { gongfengTrigger as a, name as c, watchGongfeng as d, GongfengConfigSchema as f, gongfengThread as i, observeGongfengMr as l, claimGongfengMr as n, inject as o, GongfengOpenApi as p, gongfengRef as r, makeGongfengKind as s, apply as t, pollGongfeng as u };
