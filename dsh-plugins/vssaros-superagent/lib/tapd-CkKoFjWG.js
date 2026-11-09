import { A as key, S as string, b as object, d as sameName, g as boolean, h as array, i as pollThreads, l as escapeRegExp, m as _enum, n as cursorAt, o as health, r as pause, s as sourceContext, y as number } from "./poll-BQME6Yxb.js";
import { t as KV } from "./kv-VTYpQIqw.js";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
		mode: _enum(["assigned", "all"]).default("assigned")
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
const tapdConfigured = (config) => config.watches.length > 0;
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
		iteration: record.iteration_id ?? ""
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
	const match = /^https?:\/\/[^/]*tapd[^/]*\/(?:tapd_fe\/)?(\d+)\/(prong\/stories|bugtrace\/bugs|prong\/tasks)\/view\/(\d+)/i.exec(url.trim());
	if (!match) return void 0;
	return {
		type: match[2].endsWith("stories") ? "story" : match[2].endsWith("bugs") ? "bug" : "task",
		workspace: match[1],
		id: match[3]
	};
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
				key: "members",
				type: "rows",
				advanced: true,
				group: {
					zh: "接收范围",
					en: "Reception scope"
				},
				label: {
					zh: "企微账号 → TAPD 中文名",
					en: "WeCom alias → TAPD name"
				},
				hint: {
					zh: "唯一的身份映射表（静态）。身份名和接收项的「处理人」都可以填企微账号，按这里换成 TAPD 中文名后再比较或查询；没配映射的别名会按原文匹配，容易漏单。已下线的内网成员表接口不再读取。",
					en: "The only identity mapping (static). The identity name and each watch owner may be a WeCom alias; it is turned into the TAPD Chinese name before comparing or querying. An unlisted alias is matched literally and can miss items. The retired intranet member endpoint is no longer read."
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
				await pollRound(ctx, apiOf(config), config, signal);
				ctx.report(TAPD_SOURCE, config.webhook && !config.webhookSecret ? health("error", "tapdWebhookUnset") : {
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
export { tapdCredentialStatus as A, TapdConfigSchema as C, TapdCredentialError as D, watchWorkspace as E, saveTapdCredential as O, TAPD_TYPES as S, tapdApi as T, watch as _, itemTrigger as a, resolveTapdName as b, name as c, pollWatch as d, replyMarker as f, threadItem as g, signatureOf as h, itemThread as i, tapdEnvironment as j, tapdCredential as k, pollComments as l, sendTapd as m, commentTrigger as n, makeTapdKind as o, resolvedConfig as p, inject as r, mentions as s, apply as t, pollRound as u, watchFilter as v, TapdOpenApi as w, TAPD_SOURCE as x, cleanOwner as y };
