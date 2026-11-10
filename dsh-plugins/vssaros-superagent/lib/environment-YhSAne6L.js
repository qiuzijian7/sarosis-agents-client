import { S as string, T as unknown, b as object, g as boolean, h as array, m as _enum, u as fill, v as looseObject, y as number } from "./poll-Btx7A8Qk.js";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
//#region src/limits.ts
/** Validation bounds shared between host schemas and management panel forms. */
const LIMITS = {
	ruleName: 100,
	ruleInstruction: 2e3,
	evalTimeoutSeconds: {
		min: 30,
		max: 600
	},
	maxWorkers: {
		min: 1,
		max: 16
	},
	prepareCommand: 4e3,
	promptMaxChars: {
		min: 1e3,
		max: 1e6
	},
	admissionContextMaxPages: {
		min: 1,
		max: 100
	},
	admissionContextTimeoutMs: {
		min: 1,
		max: 9e4
	}
};
//#endregion
//#region src/setup.ts
/** Structured startup and configuration errors with the settings location where the operator can fix them. */
const SETUP_PROBLEMS = {
	foreignFile: ["deployment", "{file} was not written by dsh-superagent; move it, or choose another state directory."],
	gitTooOld: ["deployment", "git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later."],
	environmentFailed: ["deployment", "Preparing the agent environment failed."],
	repositoryUnset: ["github", "The GitHub Source names no repository."],
	agentCliUnset: ["github", "The agent GitHub CLI is not set."],
	agentCliMissing: ["github", "The agent GitHub CLI was not found."],
	agentCliSignedOut: ["github", "The agent GitHub CLI cannot read its account."],
	agentCliNoAccount: ["github", "The agent GitHub CLI did not report a GitHub account."],
	repositoryUnreadable: ["github", "@{account} cannot read {repository}."],
	repositoryUnreported: ["github", "The agent GitHub CLI did not return {repository}."],
	repositoryReadOnly: ["github", "@{account} cannot push to {repository}."],
	feishuCliFailed: ["feishu", "The bot lark-cli does not work."],
	feishuNoApp: ["feishu", "auth status of the bot lark-cli did not report the app."],
	feishuBotNotReady: ["feishu", "The bot identity of app {app} is {status}; configure the app secret with lark-cli."],
	feishuUserIdentity: ["feishu", "The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes."],
	feishuNoBot: ["feishu", "The Feishu bot API did not return the bot's open_id."],
	feishuAppMissing: ["feishu", "lark-cli has no profile for Feishu app {app}, and the VsSaros Bots do not keep its secret; add the app in the Bots channel settings, or run lark-cli profile add --name {app} --app-id {app} --app-secret-stdin."],
	feishuProfileFailed: ["feishu", "lark-cli could not add a bot-only profile for Feishu app {app}: {output}"],
	feishuAppMismatch: ["feishu", "lark-cli profile {profile} belongs to app {actual}, not {app}."]
};
/**
* Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
* `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
*/
var SetupError = class extends Error {
	code;
	values;
	place;
	constructor(code, values = {}) {
		const [place, text] = SETUP_PROBLEMS[code];
		const sentence = fill(text, values);
		super(values.output ? `${sentence}\n${values.output}` : sentence);
		this.code = code;
		this.values = values;
		this.place = place;
	}
	get problem() {
		return {
			place: this.place,
			code: this.code,
			values: this.values,
			detail: this.message
		};
	}
};
/**
* VsSaros addition: the Feishu app shipped with the product, so a fresh install can connect without setting up
* credentials in the Bots channel. It is the **lowest-priority** source: a secret in the Bots' `agent-im-accounts.json`
* wins. The app ID is also the default of the Feishu Source's `appId` field (see `feishu.ts`).
* The secret is plain text compiled into `lib/`; rotating it needs a code change and a version bump.
*/
const BUNDLED_FEISHU_APP = Object.freeze({
	appId: "cli_a860911d2e7f5013",
	appSecret: "ieEN6Jp4m4l0RTUDBPPROfpo1n3sc7Iz"
});
const json = (file) => {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
	} catch {
		return;
	}
};
const alive = (pid) => {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};
/** The app ID the Bots in `dataRoot` connect with, if their credentials file names one. */
function botsFeishuApp(dataRoot) {
	const appId = (json(join(dataRoot, "agent-im-accounts.json"))?.accounts)?.feishu?.appId;
	return typeof appId === "string" && appId.trim() ? appId.trim() : void 0;
}
/**
* The secret VsSaros Bots keep for `appId` (their default app or one of their extra apps), read where the Bots read it:
* `VSSAROS_DATA_ROOT`, which the IDE gives the Host, else `~/.vssaros`. It only ever goes to lark-cli's stdin.
*/
function botsAppSecret(appId, env = process.env, home = homedir()) {
	const root = env.VSSAROS_DATA_ROOT?.trim() || join(home, ".vssaros");
	const accounts = json(join(root, "agent-im-accounts.json"))?.accounts;
	const secretOf = (entry) => {
		const value = entry?.appSecret;
		return typeof value === "string" && value.trim() ? value.trim() : void 0;
	};
	if (!appId) return void 0;
	return (accounts && accounts.feishu?.appId === appId ? secretOf(accounts.feishu) : accounts && accounts.feishuApps && typeof accounts.feishuApps === "object" ? secretOf(accounts.feishuApps[appId]) : void 0) ?? (appId === BUNDLED_FEISHU_APP.appId ? BUNDLED_FEISHU_APP.appSecret : void 0);
}
/**
* The live Bots inbound connection that uses `appId`, or undefined when there is none, the lock is stale, or the
* holder uses another app. An unreadable app ID is not treated as a conflict, so a misread never blocks the Source.
* vssaros-agents 0.2.317+ holds one lock per app (`~/.vssaros-im-feishu-<appId>.lock`) and writes `appId` into the
* legacy platform lock; older versions hold only the legacy lock, whose app is then read from the holder's data root.
*/
function feishuAppHolder(appId, options = {}) {
	const home = options.home ?? homedir();
	const now = options.now ?? Date.now();
	const isAlive = options.isAlive ?? alive;
	const live = (lock) => {
		if (!lock) return false;
		const heartbeat = Number(lock.heartbeatAt);
		return Number.isFinite(heartbeat) && now - heartbeat < 9e4 && isAlive(Number(lock.pid));
	};
	const rootOf = (lock) => typeof lock.dataRoot === "string" && lock.dataRoot ? lock.dataRoot : join(home, ".vssaros");
	const id = String(appId ?? "").trim();
	if (/^cli_[A-Za-z0-9]+$/.test(id)) {
		const own = json(join(home, `.vssaros-im-feishu-${id.toLowerCase()}.lock`));
		if (live(own)) return {
			pid: Number(own.pid),
			dataRoot: rootOf(own),
			appId: id
		};
	}
	const lock = json(join(home, ".vssaros-im-feishu.lock"));
	if (!live(lock)) return void 0;
	const dataRoot = rootOf(lock);
	const held = typeof lock.appId === "string" && lock.appId.trim() ? lock.appId.trim() : botsFeishuApp(dataRoot);
	return held && held === id ? {
		pid: Number(lock.pid),
		dataRoot,
		appId: id
	} : void 0;
}
/** lark-cli exits with 2 when another event bus is already connected for the app. */
const busTaken = (code, diagnostic) => code === 2 && /another bus|already connected|bus .*(connected|running)/i.test(diagnostic);
const FEISHU_EVENTS_KEY = Symbol.for("vssaros.feishuEvents");
function sharedFeishuEvents(root = globalThis) {
	const bus = root[FEISHU_EVENTS_KEY];
	return bus && bus.version === 1 && typeof bus.active === "function" && typeof bus.subscribe === "function" ? bus : void 0;
}
/**
* Whether the Source should listen through the Bots' connection: the bus is here and either the Bots connection for
* the app is up, or the Bots in this very process hold the app's lock (reconnecting, so events will come through it).
*/
function listensShared(bus, appId, holder, pid = process.pid) {
	return !!bus && (bus.active(appId) || holder?.pid === pid);
}
const text = (value) => typeof value === "string" && value ? value : void 0;
/**
* A raw Feishu v2 `im.message.receive_v1` event (`{ header, event }`, as the Bots receive it) in the shape `lark-cli event
* consume` prints, so both paths make the same Trigger. Content is decoded the way history messages are; a sender
* without an ID cannot be told apart from this bot, so such an event is dropped rather than guessed at.
*/
function sharedEvent(payload) {
	const raw = payload;
	if (raw?.header?.event_type !== "im.message.receive_v1") return void 0;
	const message = raw.event?.message ?? {}, sender = raw.event?.sender ?? {};
	const senderId = text(sender.sender_id?.open_id) ?? text(sender.sender_id?.user_id) ?? text(sender.sender_id?.union_id);
	if (!senderId || !text(message.message_id) || !text(message.chat_id)) return void 0;
	let content;
	try {
		content = JSON.parse(String(message.content ?? ""));
	} catch {
		content = message.content ?? "";
	}
	const plain = content && typeof content === "object" && typeof content.text === "string" ? content.text : void 0;
	const mentions = (Array.isArray(message.mentions) ? message.mentions : []).flatMap((mention) => {
		const id = text(mention?.id?.open_id) ?? text(mention?.id?.user_id) ?? text(typeof mention?.id === "string" ? mention.id : void 0);
		return id ? [{
			id,
			...text(mention.key) ? { key: mention.key } : {},
			...text(mention.name) ? { name: mention.name } : {}
		}] : [];
	});
	return {
		message_id: message.message_id,
		chat_id: message.chat_id,
		chat_type: message.chat_type === "p2p" ? "p2p" : "group",
		create_time: String(message.create_time ?? ""),
		sender_id: senderId,
		sender_type: sender.sender_type === "user" ? "user" : "bot",
		content: typeof content === "string" ? content : plain ?? JSON.stringify(content),
		mentions,
		...text(message.root_id) ? { root_id: message.root_id } : {},
		...text(message.parent_id) ? { parent_id: message.parent_id } : {},
		...text(message.thread_id) ? { thread_id: message.thread_id } : {}
	};
}
/** A consumer run that ended on its own, with its exit code and last stderr line. */
var FeishuConsumerExit = class extends Error {
	code;
	ready;
	diagnostic;
	constructor(code, ready, diagnostic) {
		super(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`);
		this.code = code;
		this.ready = ready;
		this.diagnostic = diagnostic;
	}
};
//#endregion
//#region src/sources/feishu-profile.ts
/**
* VsSaros addition: a lark-cli profile per Feishu app, so the Feishu Source can be pointed at an app by its ID.
*
* lark-cli keeps several apps as named profiles and every command selects one with `--profile` (lark-cli names a profile
* after its app by default). When the Source names an app that has no profile yet, setup adds one from the secret the
* VsSaros Bots already keep for that app, so the secret is entered once, in the Bots channel settings. The secret goes to
* lark-cli through stdin only (never an argument, a log line or a setting), and the new profile is restricted to the bot
* identity at once: Executors call this CLI too, and a profile that also allowed a user identity would let them act as
* that user. Profiles that already exist are never changed; setup only checks them.
*/
const ENV = {
	LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
	LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
};
/** Runs lark-cli with `input` on stdin; a failure names the command and lark-cli's message, never the input. */
function runLark(argv, args, input = "", timeoutMs = 6e4) {
	return new Promise((resolve, reject) => {
		const [program, ...prefix] = argv;
		const child = spawn(program, [...prefix, ...args], {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			env: {
				...process.env,
				...ENV
			}
		});
		let out = "", err = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(/* @__PURE__ */ new Error(`lark-cli ${args.filter((arg) => !arg.startsWith("--")).slice(0, 2).join(" ")} exited with ${code}: ${(err || out).trim().slice(0, 400)}`));
		});
		child.stdin.end(input);
	});
}
const larkProfiles = () => ({
	secret: (appId) => botsAppSecret(appId),
	async create(argv, appId, secret) {
		await runLark(argv, [
			"profile",
			"add",
			"--name",
			appId,
			"--app-id",
			appId,
			"--app-secret-stdin",
			"--brand",
			"feishu"
		], `${secret}\n`);
		await runLark(argv, [
			"--profile",
			appId,
			"config",
			"strict-mode",
			"bot"
		]);
	}
});
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+cosmokit@1.8.6-alpha.1/node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+schemastery@3.18.5-alpha.1/node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region src/deployment.ts
/** Plugin configuration and startup verification for repository access and agent CLI identities. */
const reason = (error) => error instanceof Error ? error.message : String(error);
const absolute = (description) => Schema.string().pattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/).description(`${description} Absolute path.`);
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
const Config = Schema.object({
	stateDir: absolute("Directory for the database, locks, worker shims, the agent's git configuration and, by default, the ticket directories.").required(),
	promptMaxChars: Schema.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(1e5).description("Largest saved prompt configuration, in characters.").volatile(),
	admissionContextMaxPages: Schema.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10).description("Pages of thread context one assessment may read.").volatile(),
	admissionContextTimeoutMs: Schema.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1).default(15e3).description("Time limit of one context read during an assessment, in milliseconds.").volatile()
});
const MOVED = {
	repository: "on the GitHub Source",
	branchPrefix: "in the prepare command of the Execution settings",
	github: "on the GitHub Source",
	feishu: "on the Feishu Source",
	author: "prompt text",
	repositoryPath: "in the prepare command of the Execution settings",
	worktreeRoot: "the ticket directory of the Execution settings",
	blockedCommands: "in the Execution settings"
};
/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
function machineOf(config) {
	const unknown = Object.keys(config).filter((key) => !(key in (Config.dict ?? {})));
	if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map((key) => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(", ")}; docs/006-deployment.md lists the keys`);
	const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config;
	return {
		stateDir,
		promptMaxChars,
		admissionContextMaxPages,
		admissionContextTimeoutMs
	};
}
const GithubAccountsSchema = object({
	repository: string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "owner/name").default(""),
	cli: string().trim().default("")
});
/**
* VsSaros addition: `appId` picks the Feishu app by its lark-cli profile (lark-cli names a profile after its app by default).
* Empty keeps upstream behaviour: the CLI's active profile.
*/
const FeishuBotSchema = object({
	cli: string().trim().default(""),
	appId: string().trim().regex(/^(cli_[A-Za-z0-9]+)?$/, "cli_…").default("")
});
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
const SETUP_FIELDS = {
	github: Object.keys(GithubAccountsSchema.shape),
	feishu: Object.keys(FeishuBotSchema.shape),
	p4: [
		"cli",
		"port",
		"user",
		"submitUser",
		"submitClient"
	]
};
/** The shell-free argv of the bot's lark-cli, selecting its profile when it has one; every Host-side call and the worker shim use it. */
function larkArgv(bot, path = process.env.PATH ?? "", windows = WINDOWS) {
	return [...cliArgv(bot.cli, path, windows), ...profileArgs(bot.profile)];
}
const profileArgs = (profile) => profile ? ["--profile", profile] : [];
/** The deployment's GitHub repository and account, or an error naming what to configure when the GitHub Source is not set up. */
function githubOf(deployment) {
	const { repository, github } = deployment;
	if (!repository || !github) throw new Error("The GitHub Source is not set up: set its repository and account CLI, or leave it off");
	return {
		repository,
		github
	};
}
/** True when the operator configured the GitHub Source (any setup field set); an untouched GitHub Source is not set up and not checked. */
function githubConfigured(config) {
	const { repository, cli } = GithubAccountsSchema.parse(config ?? {});
	return repository !== "" || cli !== "";
}
const WINDOWS = process.platform === "win32";
/** Extensions Windows runs a bare command name with, in its order (PATHEXT). */
function pathExtensions() {
	return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
}
/**
* Resolve a command name or absolute path to an executable file, ignoring the worker shim directory.
* VsSaros patch (Windows): a name may use `\` as well as `/`. A bare name resolves through PATHEXT as cmd.exe does, so `gh`
* finds `gh.exe` and never the extensionless `gh` script npm puts beside a `gh.cmd`; an absolute path is taken as given,
* or with a PATHEXT extension added when no file has exactly that name.
*/
function executable(name, path, exclude, windows = WINDOWS) {
	if ((windows ? /[\\/]/.test(name) : name.includes("/")) && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`);
	const extensions = windows ? pathExtensions() : [];
	const named = windows && extensions.includes(extname(name).toLowerCase());
	const withExtensions = (base) => extensions.map((ext) => base + ext);
	const candidates = isAbsolute(name) ? windows && !named ? [name, ...withExtensions(name)] : [name] : path.split(delimiter).filter((dir) => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map((dir) => join(dir, name)).flatMap((base) => windows && !named ? withExtensions(base) : [base]);
	for (const candidate of candidates) try {
		if (statSync(candidate).isFile()) {
			accessSync(candidate, constants.X_OK);
			return candidate;
		}
	} catch {}
	throw new Error(`${name} is not an executable file${isAbsolute(name) ? "" : " on PATH"}`);
}
/**
* VsSaros patch (Windows): the argv that runs a CLI without a shell. Node refuses to spawn a `.cmd`/`.bat`
* directly (CVE-2024-27980) and `Commands` will not pass message text through cmd.exe, so an npm/pnpm launcher
* is replaced by the `.js` script it launches, run by the Host's own node. A `.js` path, a real executable and
* every POSIX command pass through unchanged. Used by the Feishu Source (the retired TAPD MCP transport used it too).
*/
function cliArgv(cli, path = process.env.PATH ?? "", windows = WINDOWS) {
	if (/\.[cm]?js$/i.test(cli)) return [process.execPath, cli];
	const found = isAbsolute(cli) ? cli : executable(cli, path, void 0, windows);
	if (!windows || !/\.(cmd|ps1|bat)$/i.test(found)) return [found];
	const launcher = found.replace(/\.(ps1|bat)$/i, ".cmd");
	const text = readFileSync(launcher, "utf8");
	const script = /"%dp0%\\([^"]+\.[cm]?js)"/i.exec(text)?.[1];
	if (!script) throw new Error(`${cli} is a launcher dsh-superagent cannot read; set the CLI to its .js script`);
	return [process.execPath, join(dirname(launcher), script)];
}
/**
* Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary.
* VsSaros patch (Windows): the variables go through the subprocess service's `env` instead of an `env NAME=value …` prefix,
* which needs a POSIX `env` program.
*/
function workerProbe(subprocess, stateDir, cwd, signal) {
	const path = withoutDirectory(process.env.PATH ?? "", workerBin(stateDir));
	return (argv, env) => runAsWorker(subprocess, argv, cwd, AbortSignal.any([signal, AbortSignal.timeout(6e4)]), {
		...env,
		PATH: path
	});
}
const GithubUser = object({
	login: string().regex(/^[A-Za-z0-9-]+$/),
	id: number().int().positive()
});
const RepositoryAccess = object({
	name: string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	push: boolean().nullable()
});
function parsed(schema, text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	const result = schema.safeParse(value);
	return result.success ? result.data : void 0;
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
async function resolveDeployment(machine, github, probe, path = process.env.PATH ?? "") {
	const { stateDir } = machine;
	const accounts = GithubAccountsSchema.parse(github ?? {});
	const remote = accounts.repository;
	if (!remote) throw new SetupError("repositoryUnset");
	if (!accounts.cli) throw new SetupError("agentCliUnset");
	let cli;
	try {
		cli = executable(accounts.cli, path, workerBin(stateDir));
	} catch (error) {
		throw new SetupError("agentCliMissing", { output: reason(error) });
	}
	const text = await probe([
		cli,
		"api",
		"user"
	]).catch((error) => {
		throw new SetupError("agentCliSignedOut", { output: reason(error) });
	});
	const agent = parsed(GithubUser, text);
	if (!agent) throw new SetupError("agentCliNoAccount");
	const access = parsed(RepositoryAccess, await probe([
		cli,
		"api",
		`repos/${remote}`,
		"--jq",
		"{name: .full_name, push: .permissions.push}"
	]).catch((error) => {
		throw new SetupError("repositoryUnreadable", {
			account: agent.login,
			repository: remote,
			output: reason(error)
		});
	}));
	if (!access) throw new SetupError("repositoryUnreported", { repository: remote });
	const repository = access.name;
	if (access.push !== true) throw new SetupError("repositoryReadOnly", {
		account: agent.login,
		repository
	});
	return {
		...machine,
		repository,
		github: {
			cli,
			login: agent.login,
			noreply: `${agent.id}+${agent.login}@users.noreply.github.com`
		}
	};
}
const AuthStatus = object({
	appId: string().regex(/^cli_[A-Za-z0-9]+$/),
	brand: _enum(["feishu", "lark"]).default("feishu"),
	identities: object({ bot: object({ status: string() }) })
});
const BotInfo = object({ bot: object({
	open_id: string().regex(/^ou_[A-Za-z0-9]+$/),
	app_name: string().default("")
}) });
/**
* Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
* Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
*/
async function resolveFeishuBot(machine, feishu, probe, path = process.env.PATH ?? "", profiles = larkProfiles()) {
	const { cli: name, appId } = FeishuBotSchema.parse(feishu ?? {});
	if (!name) return void 0;
	const fail = (error) => {
		throw error instanceof SetupError ? error : new SetupError("feishuCliFailed", { output: reason(error) });
	};
	let cli = "";
	try {
		cli = executable(name, path, workerBin(machine.stateDir));
	} catch (error) {
		fail(error);
	}
	const call = (...args) => probe([cli, ...args], {
		LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
		LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
	}).catch(fail);
	const profile = appId ? await larkProfileOf(appId, cli, call, path, profiles, fail) : void 0;
	const run = (...args) => call(...profileArgs(profile), ...args);
	const text = await run("auth", "status");
	const status = parsed(AuthStatus, text.slice(text.indexOf("{")));
	if (!status) return fail(new SetupError("feishuNoApp"));
	if (appId && status.appId !== appId) fail(new SetupError("feishuAppMismatch", {
		app: appId,
		profile: profile ?? "",
		actual: status.appId
	}));
	if (status.identities.bot.status !== "ready") fail(new SetupError("feishuBotNotReady", {
		app: status.appId,
		status: status.identities.bot.status
	}));
	const mode = /strict-mode:\s*(\w+)/.exec(await run("config", "strict-mode"))?.[1];
	if (mode !== "bot") fail(new SetupError("feishuUserIdentity", { mode: mode ?? "unknown" }));
	const info = parsed(BotInfo, (await run("api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "ndjson")).split("\n")[0] ?? "");
	if (!info) return fail(new SetupError("feishuNoBot"));
	return {
		cli,
		appId: status.appId,
		brand: status.brand,
		botId: info.bot.open_id,
		name: info.bot.app_name,
		...profile ? { profile } : {}
	};
}
const ProfileList = array(looseObject({
	name: string(),
	appId: string().optional()
}));
/** The lark-cli profile of `appId`: an existing one (by app, then by name), else one added from the Bots' secret for it. */
async function larkProfileOf(appId, cli, call, path, profiles, fail) {
	const text = await call("profile", "list");
	const listed = parsed(ProfileList, text.slice(Math.max(0, text.indexOf("[")))) ?? [];
	const found = listed.find((profile) => profile.appId === appId) ?? listed.find((profile) => profile.name === appId);
	if (found) return found.name;
	const secret = profiles.secret(appId);
	if (!secret) return fail(new SetupError("feishuAppMissing", { app: appId }));
	try {
		await profiles.create(cliArgv(cli, path), appId, secret);
	} catch (error) {
		fail(new SetupError("feishuProfileFailed", {
			app: appId,
			output: reason(error)
		}));
	}
	return appId;
}
//#endregion
//#region src/infra/commands.ts
/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
const exec = promisify(execFile);
const TIMEOUT_MS = 9e4;
/**
* Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
* Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
*/
var CliError = class extends Error {
	code;
	exitCode;
	constructor(message, code, exitCode) {
		super(message);
		this.code = code;
		this.exitCode = exitCode;
	}
};
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
function commandError(error, program = "command") {
	if (error instanceof Error && error.name === "AbortError") return error;
	const exitCode = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : void 0;
	if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
		const stderr = error.stderr.trim();
		let parsed;
		try {
			parsed = JSON.parse(stderr.slice(stderr.indexOf("{")));
		} catch {}
		const code = parsed?.error?.code;
		if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ""}`, code, exitCode);
		if (stderr) return new CliError(stderr.slice(0, 2e3), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || void 0, exitCode);
	}
	const p4 = p4Failure(error);
	if (p4) return new CliError(p4.slice(0, 2e3), void 0, exitCode);
	return new CliError(`${basename(program)} ${ended(error)}`, void 0, exitCode);
}
/** VsSaros patch (p4): `p4 -Mj` prints its errors as JSON records on stdout, with `severity` 3 or 4, and nothing on stderr. */
function p4Failure(error) {
	const messages = (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "").split(/\r?\n/).flatMap((line) => {
		try {
			const record = JSON.parse(line);
			return typeof record.data === "string" && typeof record.severity === "number" && record.severity >= 3 ? [record.data.trim()] : [];
		} catch {
			return [];
		}
	});
	return messages.length ? messages.join("\n") : void 0;
}
function ended(error) {
	const { killed, signal, code } = error ?? {};
	if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "printed more output than it may";
	if (killed && signal === "SIGTERM") return `timed out after ${TIMEOUT_MS / 1e3} s`;
	if (signal) return `was stopped by ${signal}`;
	if (typeof code === "number") return `exited with code ${code}`;
	return typeof code === "string" ? `could not run: ${code}` : "failed";
}
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
function validItems(item, list, tally) {
	const items = list.flatMap((value) => {
		const parsed = item.safeParse(value);
		return parsed.success ? [parsed.data] : [];
	});
	if (tally) tally.skipped += list.length - items.length;
	return items;
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error) {
	if (!(error instanceof CliError) || error.code !== 232011) return error;
	return new CliError("The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.", error.code, error.exitCode);
}
/**
* Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
* Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
*/
var Commands = class Commands {
	resolved;
	environment;
	signal;
	/**
	* @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
	* @param environment - variables overriding `process.env` for every command (such as isolated git settings).
	*/
	constructor(resolved, environment, signal) {
		this.resolved = resolved;
		this.environment = environment;
		this.signal = signal;
	}
	get deployment() {
		return this.resolved();
	}
	/** VsSaros patch (optional GitHub): throws a message naming what to configure when the GitHub Source is not set up. */
	get repository() {
		return githubOf(this.deployment).repository;
	}
	withSignal(signal) {
		return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this;
	}
	async run(program, args, cwd, input) {
		if (process.platform === "win32" && /\.(cmd|bat)$/i.test(program)) throw new CliError(`${basename(program)} is a Windows batch file, which dsh-superagent does not run; set the CLI to its .exe instead`);
		try {
			const running = exec(program, args, {
				cwd,
				signal: this.signal,
				timeout: TIMEOUT_MS,
				maxBuffer: 16777216,
				windowsHide: true,
				env: {
					...process.env,
					...this.environment,
					GH_PROMPT_DISABLED: "1",
					LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
					LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
				}
			});
			if (input !== void 0) running.child.stdin?.end(input);
			const { stdout } = await running;
			return stdout;
		} catch (error) {
			throw commandError(error, program);
		}
	}
	/** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
	async gh(args) {
		return JSON.parse(await this.run(githubOf(this.deployment).github.cli, args));
	}
	async api(schema, ...rest) {
		if (typeof schema === "string") return this.run(githubOf(this.deployment).github.cli, [
			"api",
			this.path(schema),
			...rest
		]);
		const [path = "", ...flags] = rest;
		return schema.parse(await this.gh([
			"api",
			this.path(path),
			...flags
		]));
	}
	/** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
	async pages(item, path, tally) {
		return validItems(item, array(array(unknown())).parse(await this.gh([
			"api",
			this.path(path),
			"--paginate",
			"--slurp"
		])).flat(), tally);
	}
	path(path) {
		if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error("GitHub calls are restricted to the configured repository");
		return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`;
	}
	/**
	* Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
	* @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
	*/
	async lark(args, cwd) {
		const bot = this.deployment.feishu;
		if (!bot) throw new Error("The Feishu Source has no working bot CLI");
		const [program, ...prefix] = larkArgv(bot);
		const output = await this.run(program, [
			...prefix,
			...args,
			"--as",
			"bot",
			"--format",
			"json"
		], cwd).catch((error) => {
			throw membership(error);
		});
		const result = JSON.parse(output);
		const code = result.error?.code;
		if (!result.ok) throw membership(new CliError(`${result.error?.message ?? "Feishu command failed"}${code ? ` (${code})` : ""}`, code));
		return result.data;
	}
	/** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
	async git(args, cwd) {
		return this.run("git", args, cwd);
	}
};
//#endregion
//#region src/infra/environment.ts
/**
* Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
* Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
* Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
*/
const MARKER = "# Written by dsh-superagent on every start; edits are lost.";
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = [
	"dsh-tag",
	"dsh-go",
	"dsh-freelancer"
].map((name) => `# Written by ${name} on every start; edits are lost.`);
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
const WORKER_COMMANDS = [
	"gh",
	"git",
	"lark-cli"
];
const workerBin = (stateDir) => join(stateDir, "worker-bin");
const workerGitConfig = (stateDir) => join(stateDir, "worker-gitconfig");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const gitQuote = (value) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
const credentialHelper = (cli) => `!${shellQuote(cli)} auth git-credential`;
function sameDirectory(a, b) {
	const real = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return real(a) === real(b);
}
function withoutDirectory(path, dir) {
	return path.split(delimiter).filter((entry) => !sameDirectory(entry, dir)).join(delimiter);
}
/**
* The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
* `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
* kept: it names no repository, and it stops git's search for one where the operator chose.
*/
const GIT_LOCATION = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_PREFIX",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE"
];
/**
* Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
* environment may name, and operator git identity/config overrides.
*/
function agentVariables(stateDir) {
	return {
		GH_TOKEN: void 0,
		GITHUB_TOKEN: void 0,
		...Object.fromEntries(GIT_LOCATION.map((name) => [name, void 0])),
		GIT_CONFIG_GLOBAL: workerGitConfig(stateDir),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: void 0,
		GIT_CONFIG_PARAMETERS: void 0,
		GIT_ASKPASS: "",
		SSH_ASKPASS: void 0,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: void 0,
		GIT_COMMITTER_NAME: void 0,
		GIT_AUTHOR_EMAIL: void 0,
		GIT_COMMITTER_EMAIL: void 0
	};
}
/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file) {
	if (!(await lstat(file)).isFile()) return false;
	const head = (await readFile(file, "utf8")).split("\n", 2).map((line) => line.replace(/\r$/, "").replace(/^@rem /, ""));
	return [MARKER, ...LEGACY_MARKERS].some((marker) => head.includes(marker));
}
async function own(file, text, mode = 420) {
	let foreign = false;
	try {
		foreign = !await written(file);
	} catch {}
	if (foreign) throw new SetupError("foreignFile", { file });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, text, { mode });
	await rename(temporary, file);
}
/** Characters a `.cmd` shim cannot carry safely in its shim directory path (they act inside `%PATH:…=…%` and `set "…"`). */
const CMD_UNSAFE = /[%!"^=&|<>]/;
/** Escapes text for `echo` in a `.cmd` file. */
const cmdEcho = (text) => text.replace(/[\^&|<>()%!]/g, (char) => char === "%" ? "%%" : `^${char}`);
function shimFile(name, dir, action, windows = process.platform === "win32") {
	const leading = "run" in action ? action.with ?? [] : [];
	if (!windows) {
		const withoutShims = [
			`self=${shellQuote(dir)}`,
			"rest=",
			"IFS=:",
			"set -f",
			"for entry in $PATH; do [ \"$entry\" = \"$self\" ] || rest=\"${rest:+$rest:}$entry\"; done",
			"set +f",
			"unset IFS",
			"PATH=$rest",
			"export PATH"
		].join("\n");
		const body = "run" in action ? `${withoutShims}\nexec ${[action.run, ...leading].map(shellQuote).join(" ")} "$@"` : `echo ${shellQuote(action.fail)} >&2\nexit 1`;
		return {
			file: name,
			text: `#!/bin/sh\n${MARKER}\n${body}\n`
		};
	}
	if (CMD_UNSAFE.test(dir)) throw new SetupError("environmentFailed", { output: `The state directory ${dir} has a character a Windows command shim cannot carry (one of % ! " ^ = & | < >); choose another stateDir.` });
	const lines = [
		"@echo off",
		`@rem ${MARKER}`,
		"setlocal"
	];
	if ("run" in action) {
		const unsafe = [action.run, ...leading].find((part) => /["%]/.test(part));
		if (unsafe !== void 0) throw new SetupError("environmentFailed", { output: `The program path ${unsafe} has a character a Windows command shim cannot carry.` });
		const call = /\.(cmd|bat)$/i.test(action.run) ? "call " : "";
		lines.push(`set "PATH=%PATH:${dir};=%"`, `${call}${[action.run, ...leading].map((part) => `"${part}"`).join(" ")} %*`, "exit /b %ERRORLEVEL%");
	} else lines.push(`>&2 echo ${cmdEcho(action.fail)}`, "exit /b 1");
	return {
		file: `${name}.cmd`,
		text: `${lines.join("\r\n")}\r\n`
	};
}
const p4GuardFile = (stateDir) => join(stateDir, "p4-guard.mjs");
/**
* Commands a worker may run with p4: reading, opening and shelving files in its own workspace. Left out on purpose: submit,
* populate, obliterate, protect, admin, set, tickets, logout, triggers and every other spec or admin command.
*/
const P4_ALLOWED = [
	"add",
	"annotate",
	"change",
	"changelist",
	"changes",
	"changelists",
	"client",
	"clients",
	"delete",
	"describe",
	"diff",
	"diff2",
	"dirs",
	"edit",
	"filelog",
	"files",
	"fstat",
	"grep",
	"have",
	"help",
	"info",
	"integrated",
	"login",
	"move",
	"opened",
	"print",
	"reconcile",
	"reopen",
	"resolve",
	"resolved",
	"revert",
	"shelve",
	"status",
	"sync",
	"unshelve",
	"where",
	"workspace",
	"workspaces"
];
/**
* The guard script `p4` runs through: a plain ES module run by the Host's node, so it needs nothing installed. It refuses a
* command off `P4_ALLOWED`, a forbidden option (another account, server, password or host, an argument file `-x`, a denied
* workspace, or `-f`/`-d` on workspace and changelist specs), then runs the real p4 with the guard's server and account.
*/
function p4GuardScript(guard) {
	return `/*
${MARKER}
*/
// The p4 guard of dsh-superagent's workers. It is a guardrail on the default path, not a security boundary: the execution
// account's server permissions are what keep a worker from submitting.
import { spawnSync } from 'node:child_process'
const guard = ${JSON.stringify(guard)}
const allowed = new Set(${JSON.stringify(P4_ALLOWED)})
const refuse = message => { process.stderr.write(\`p4 (dsh-superagent): \${message}\\n\`); process.exit(1) }
const valued = new Set(['b', 'c', 'C', 'd', 'H', 'L', 'M', 'p', 'P', 'Q', 'r', 'u', 'v', 'x', 'z'])
const args = process.argv.slice(2)
const globals = {}
let index = 0
while (index < args.length && args[index].startsWith('-') && args[index].length > 1) {
  const flag = args[index][1]
  if (valued.has(flag)) {
    const value = args[index].length > 2 ? args[index].slice(2) : args[++index]
    if (value === undefined) refuse(\`-\${flag} needs a value\`)
    globals[flag] = value
  }
  index++
}
if ('x' in globals) refuse('argument files (-x) are not allowed')
if ('P' in globals || 'H' in globals) refuse('-P and -H are not allowed')
if ('u' in globals && globals.u !== guard.user) refuse(\`workers act only as \${guard.user}\`)
if ('p' in globals && globals.p !== guard.port) refuse(\`workers use only \${guard.port}\`)
if ('c' in globals && guard.deniedClients.includes(globals.c)) refuse(\`the workspace \${globals.c} is not a worker's\`)
const command = args[index]
const rest = args.slice(index + 1)
if (command === undefined) refuse('name a command')
if (command === 'submit') refuse('workers never submit: shelve the changelist and report it ready, and a person reviews and approves the submit')
if (!allowed.has(command)) refuse(\`\${command} is not allowed for workers\`)
// An option given alone (-f) or in a group of letters (-df); a refusal by mistake is safer than a bypass.
const has = (...options) => rest.some(arg => options.includes(arg) || (/^-[a-zA-Z]{2,}$/.test(arg) && options.some(option => arg.includes(option[1]))))
if (['client', 'workspace'].includes(command) && has('-d', '-f')) refuse(\`\${command} -d and -f are not allowed for workers\`)
if (['change', 'changelist'].includes(command) && has('-f', '-u', '-U', '-t')) refuse(\`\${command} -f, -u, -U and -t are not allowed for workers\`)
if (command === 'login' && (rest.length !== 1 || rest[0] !== '-s')) refuse('login only as login -s')
const [program, ...prefix] = guard.program
const result = spawnSync(program, [...prefix, '-p', guard.port, '-u', guard.user, ...args], { stdio: 'inherit', windowsHide: true })
if (result.error) refuse(String(result.error))
process.exit(result.status ?? 1)
`;
}
/**
* Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
* Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
* VsSaros patch (optional GitHub): without a GitHub account `gh` fails with a message, and git gets no GitHub credential helper.
*/
async function writeEnvironment(deployment, blockedCommands, windows = process.platform === "win32", p4) {
	const { stateDir, github, feishu } = deployment;
	const dir = workerBin(stateDir);
	await mkdir(dir, { recursive: true });
	const before = await readdir(dir);
	for (const name of before) {
		const file = join(dir, name);
		if (!await written(file)) throw new SetupError("foreignFile", { file });
	}
	const kept = /* @__PURE__ */ new Set();
	const shim = async (name, action) => {
		const { file, text } = shimFile(name, dir, action, windows);
		const temporary = join(dir, `.${file}.${process.pid}.tmp`);
		await writeFile(temporary, text, { mode: 493 });
		await rename(temporary, join(dir, file));
		kept.add(file);
	};
	await shim("gh", github ? { run: github.cli } : { fail: "gh is unavailable: this installation has no GitHub account." });
	await shim("lark-cli", feishu ? {
		run: feishu.cli,
		with: feishu.profile ? ["--profile", feishu.profile] : []
	} : { fail: "lark-cli is unavailable: this installation has no Feishu bot." });
	for (const name of new Set(blockedCommands.filter((name) => !WORKER_COMMANDS.includes(name)))) await shim(name, { fail: github ? `${name} is blocked in this installation; use gh, which acts as ${github.login}.` : `${name} is blocked in this installation.` });
	if (p4 && !blockedCommands.includes("p4")) {
		await own(p4GuardFile(stateDir), p4GuardScript(p4));
		await shim("p4", {
			run: process.execPath,
			with: [p4GuardFile(stateDir)]
		});
	}
	for (const name of before) if (!kept.has(name)) await unlink(join(dir, name));
	await own(workerGitConfig(stateDir), [
		MARKER,
		"[user]",
		"	useConfigOnly = true",
		"[credential]",
		"	helper =",
		...github ? [
			"[credential \"https://github.com\"]",
			`\thelper = ${gitQuote(credentialHelper(github.cli))}`,
			"[url \"https://github.com/\"]",
			"	insteadOf = git@github.com:",
			"	insteadOf = ssh://git@github.com/"
		] : [],
		"[filter \"lfs\"]",
		"	clean = git-lfs clean -- %f",
		"	smudge = git-lfs smudge -- %f",
		"	process = git-lfs filter-process",
		"	required = true"
	].join("\n") + "\n");
}
/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
function applyEnvironment(variables, stateDir, path) {
	const values = {
		...variables,
		PATH: [workerBin(stateDir), path].join(delimiter)
	};
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	const apply = (env) => {
		for (const [name, value] of Object.entries(env)) if (value === void 0) delete process.env[name];
		else process.env[name] = value;
	};
	apply(values);
	return () => {
		apply(previous);
	};
}
/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
async function runAsWorker(subprocess, argv, cwd, signal, env) {
	const handle = subprocess.spawn({
		argv,
		cwd,
		graceMs: 2e3,
		signal,
		...env ? { env } : {},
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: 1 << 20 },
			stderr: { maxBytes: 65536 }
		}
	});
	const { exitCode } = await handle.done;
	const read = (reader) => reader?.readFrom(0).text ?? "";
	if (exitCode === 0) return read(handle.collected.stdout);
	const ended = exitCode === null ? "was stopped before it finished" : `exited with ${exitCode}`;
	throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(" ")} ${ended}`, void 0, exitCode ?? void 0);
}
/**
* The file a `git config --show-origin` origin names. VsSaros patch (Windows): Git for Windows quotes a path that has a
* backslash (`file:"C:\\Users\\…"`) even with `-z`, so the origin is unquoted before it is compared.
*/
function originFile(origin) {
	const quoted = /^file:"((?:[^"\\]|\\.)*)"$/.exec(origin);
	return quoted ? `file:${quoted[1].replace(/\\(.)/g, "$1")}` : origin;
}
/** Verifies that worker git invocations resolve the deployment's GitHub credential helper; without a GitHub account there is none to verify. */
async function verifyEnvironment(deployment, subprocess, signal) {
	const { github, stateDir } = deployment;
	if (!github) return;
	const helpers = (await runAsWorker(subprocess, [
		"git",
		"config",
		"-z",
		"--show-origin",
		"--get-all",
		"credential.https://github.com.helper"
	], stateDir, AbortSignal.any([signal, AbortSignal.timeout(6e4)])).catch(() => "")).split("\0");
	if (helpers[0] !== void 0) helpers[0] = originFile(helpers[0]);
	if (helpers.join("\0") !== [
		`file:${workerGitConfig(stateDir)}`,
		credentialHelper(github.cli),
		""
	].join("\0")) throw new SetupError("gitTooOld");
}
/**
* Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
* keys, which the agent's git would read from the repository's own config and act on.
*/
async function verifyDirectory(directory, subprocess, signal) {
	const scoped = (await runAsWorker(subprocess, [
		"git",
		"config",
		"-z",
		"--show-scope",
		"--get-regexp",
		"^(credential\\..*|http\\..*extraheader)$"
	], directory, AbortSignal.any([signal, AbortSignal.timeout(6e4)])).catch((error) => {
		if (error instanceof CliError && error.exitCode === 1) return "";
		throw error;
	})).split("\0");
	const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === "local" || scope === "worktree") ? [scoped[index + 1].split("\n")[0]] : []);
	if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(", ")}, which the agent's git would also read; remove them.`);
}
//#endregion
export { sharedEvent as A, resolveFeishuBot as C, busTaken as D, FeishuConsumerExit as E, SetupError as M, LIMITS as N, feishuAppHolder as O, resolveDeployment as S, BUNDLED_FEISHU_APP as T, executable as _, verifyDirectory as a, larkArgv as b, workerBin as c, Commands as d, validItems as f, SETUP_FIELDS as g, GithubAccountsSchema as h, runAsWorker as i, sharedFeishuEvents as j, listensShared as k, writeEnvironment as l, FeishuBotSchema as m, agentVariables as n, verifyEnvironment as o, Config as p, applyEnvironment as r, withoutDirectory as s, WORKER_COMMANDS as t, CliError as u, githubConfigured as v, workerProbe as w, machineOf as x, githubOf as y };
