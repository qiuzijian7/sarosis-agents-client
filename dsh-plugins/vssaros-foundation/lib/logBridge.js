// 运行期 warn / error **落盘**（2026-11-02）。
//
// 为什么需要：cordis 的 `ctx.logger` 默认只往**内存环形缓冲**写（最多 1000 条），整个组合里没有
// 任何一处把它导出 ⇒ Host 运行期的告警**进程一退就没了**，磁盘日志里看不到。
// 真机事故（2026-11-02）：会话里技能目录 `<available_skills>` 完全没下发（模型因此回答"没有 Office
// 技能"），dsh 的判定是"某个技能来源 list() 抛错 / 监听启动失败 ⇒ 快照不完整 ⇒ 不发目录"，而原因
// 只写进了 `ctx.logger.warn('skill provider "…" skipped: …')` —— 内存里有、磁盘上没有，查不了 ✗。
//
// 做法（与 DSH Desktop 的 dsh-desktop-log-bridge 同构，但**不 import @deepseek-ai/***——本仓插件的约定）：
//   注册一个 logger exporter，把 `warn` / `error` 写到 **stderr**；supervisor 已把 Host 的 stderr 原样收进
//   `dsh-run/host-*.log` 与 harness 日志 ⇒ 从此能 grep。
//
// 防刷屏：每 60s 最多 100 条，超出计数、下个窗口开头报一句 "dropped N"。
// 每行前缀 `[dsh-log]`，便于 grep 也便于将来的解析器跳过它（不让运行期噪声改变"启动失败归因"）。

export const LINE_PREFIX = '[dsh-log]';
/** cordis 的级别：error 0 / info 1 / warn 2。默认 exporter 只收到 info ⇒ 必须显式放到 2，warn 才进得来。 */
const EXPORT_LEVEL = 2;
const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 200;
const MAX_LINE = 4000;

/** 把一个日志参数渲染成文本（Error 取栈；对象取 JSON，失败退回 String）。 */
function renderArg(arg) {
	if (arg instanceof Error) {
		return arg.stack || arg.message || String(arg);
	}
	if (arg && typeof arg === 'object') {
		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	}
	return String(arg);
}

/**
 * 按 cordis `Logger.format` 的语义做一个**够用**的近似：首参是字符串时替换 `%s/%d/%o/%c` 占位，
 * 其余参数空格拼接。不追求逐字一致（我们只为可读的落盘，不为再解析）。
 */
export function formatMessage(message) {
	const args = Array.isArray(message?.args) ? message.args.slice() : [];
	let head = args.length && typeof args[0] === 'string' ? args.shift() : '';
	head = head.replace(/%([sdioOjc%])/g, (match, char) => {
		if (char === '%') { return '%'; }
		if (char === 'c') { args.shift(); return ''; }
		return args.length ? renderArg(args.shift()) : match;
	});
	const tail = args.map(renderArg);
	return [head, ...tail].filter(part => part !== '').join(' ');
}

/** 一条消息 → 若干带前缀的行（栈的续行缩进）。 */
export function bridgeLines(type, source, text) {
	const [first = '', ...rest] = String(text).split(/\r?\n/);
	return [
		`${LINE_PREFIX} ${type} ${source}: ${first.slice(0, MAX_LINE)}`,
		...rest.filter(line => line.trim() !== '').slice(0, 40).map(line => `${LINE_PREFIX}   ${line.slice(0, MAX_LINE)}`),
	];
}

/**
 * 带窗口限流的写入器：超额就丢、下个窗口开头说丢了多少。
 *
 * ★ 2026-11-02：窗口内**同一首行**只写一次（重复不占配额）。真机首启一个窗口丢了 237 条 ——
 *   绝大多数是同一批 "skill file … ignored" 在多个技能来源 / 多次扫描里重复刷，而真正要找的那一行
 *   （技能目录为什么不下发）有可能正好在被丢的里面 ✗。去重后配额只花在"不同的事"上。
 */
export function createLimitedWriter(write, now = Date.now) {
	let windowStart = now();
	let written = 0;
	let dropped = 0;
	let repeated = 0;
	let seen = new Set();
	return lines => {
		const time = now();
		if (time - windowStart >= WINDOW_MS) {
			if (dropped > 0 || repeated > 0) {
				write(`${LINE_PREFIX} warn log-bridge: dropped ${dropped} message(s) over the rate limit, suppressed ${repeated} repeat(s)\n`);
			}
			windowStart = time;
			written = 0;
			dropped = 0;
			repeated = 0;
			seen = new Set();
		}
		const key = String(lines[0] ?? '').slice(0, 300);
		if (seen.has(key)) {
			repeated += 1;
			return;
		}
		seen.add(key);
		if (written >= WINDOW_LIMIT) {
			dropped += 1;
			return;
		}
		written += 1;
		write(`${lines.join('\n')}\n`);
	};
}

/**
 * 挂上导出器。`ctx.logger.exporter` 不存在（探针的假 ctx / 老版本 cordis）⇒ 什么都不做，返回 false。
 * 不抛：日志桥是诊断设施，它失败不该拖垮 foundation（所有插件的底座）。
 */
export function installLogBridge(ctx, write = text => process.stderr.write(text)) {
	let logger;
	try { logger = ctx.logger; } catch { return false; }
	if (!logger || typeof logger.exporter !== 'function') { return false; }
	const emit = createLimitedWriter(write);
	const exporter = {
		colors: 0,
		levels: { default: EXPORT_LEVEL },
		export(message) {
			if (message?.type !== 'error' && message?.type !== 'warn') { return; }
			try {
				emit(bridgeLines(message.type, message.name ?? '?', formatMessage(message)));
			} catch { /* 渲染失败不值得再报一次（会递归）*/ }
		},
	};
	// 本插件加载之前写下的 **error** 仍在环形缓冲里（warn 被默认级别滤掉了，找不回来）⇒ 补发一次。
	try {
		const buffered = logger.buffer;
		if (Array.isArray(buffered)) {
			for (const message of buffered) {
				if (message?.type === 'error') { exporter.export(message); }
			}
		}
	} catch { /* 读不到缓冲 ⇒ 只是少了启动前那几条 */ }
	try {
		logger.exporter(exporter);
	} catch {
		return false;
	}
	// 每次启动一行（stdout，非告警）：日志里**没有**这行 ⇒ 说明桥没生效，那时"没有告警"不能当证据。
	try { process.stdout.write(`${LINE_PREFIX} info log-bridge: runtime warnings and errors are recorded from here on\n`); } catch { /* 忽略 */ }
	return true;
}
