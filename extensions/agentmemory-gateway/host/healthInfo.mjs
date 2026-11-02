// agentmemory-gateway — `/health` 的附加信息（记忆工作台 v2 · P3 状态条，2026-11-02）。
//
// 为什么放进网关而不是让插件自己拼：版本行、迁移备份、sweep 时间都是**网关进程**才知道的事实；
// 插件侧没有数据目录的读权限口径（两边的 dataRoot 不是同一个目录），硬拼只会拼出错的数字。
//
// 纯函数、零 I/O ⇒ 可直接单测。调用方负责把 fs / sqlite 读到的原始值传进来。
//
// ⚠ 全部字段都是**附加**的：旧网关没有它们 ⇒ 插件必须能降级（状态条只显示拿得到的项），
//   所以这里宁可给 null 也不编默认值（"没有数据"和"值为 0"在状态条上必须分得清）。

/** 迁移备份文件名：`state_store.v<from>.<ISO 时间戳，冒号和点被换成短横>.bak.db` */
const BACKUP_RE = /^state_store\.v(\d+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak\.db$/;

/**
 * 解析备份文件名里的时间戳。
 * @param {string} stamp 形如 `2026-11-02T03-08-29-101Z`
 * @returns {string|null} ISO 字符串；格式不对 ⇒ null
 */
export function parseBackupStamp(stamp) {
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(String(stamp ?? ''));
	if (!m) { return null; }
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * 汇总迁移备份。
 * @param {readonly string[]} names `migrations/` 目录下的文件名（调用方已 readdir；读不到就传 []）
 * @returns {{count: number, latest: string|null, latestAt: string|null}} 只数**符合命名**的备份，别的文件不算
 */
export function summarizeBackups(names) {
	const list = (Array.isArray(names) ? names : [])
		.map(name => ({ name: String(name), m: BACKUP_RE.exec(String(name)) }))
		.filter(x => x.m)
		.map(x => ({ name: x.name, at: parseBackupStamp(x.m[2]) }))
		.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
	return { count: list.length, latest: list[0]?.name ?? null, latestAt: list[0]?.at ?? null };
}

/**
 * 解析 `mem:meta`/`schema` 的原始 JSON。
 * @param {string|null|undefined} raw
 * @returns {{version: number, migratedAt: string|null, applied: string[]}|null} 没有版本行 ⇒ null（= 从未迁移，不是错误）
 */
export function parseSchemaRow(raw) {
	if (typeof raw !== 'string' || !raw) { return null; }
	try {
		const row = JSON.parse(raw);
		const version = Number(row?.version);
		if (!Number.isInteger(version) || version < 0) { return null; }
		return {
			version,
			migratedAt: typeof row?.migratedAt === 'string' ? row.migratedAt : null,
			applied: Array.isArray(row?.applied) ? row.applied.map(String) : [],
		};
	} catch {
		return null;
	}
}

/**
 * 组装 `/health` 的附加字段。
 * @param {{schemaRaw?: string|null, expectedVersion?: number, backupNames?: readonly string[], lastSweepAt?: number}} input
 * @returns {{schema: object, backups: object, lastSweepAt: number|null}}
 */
export function buildHealthExtras(input = {}) {
	const row = parseSchemaRow(input.schemaRaw);
	const expected = Number.isInteger(input.expectedVersion) ? input.expectedVersion : null;
	const version = row ? row.version : 0;
	return {
		schema: {
			version,
			expected,
			// 库版本落后于进程期望 ⇒ 迁移没跑成（备份失败 / 写入回滚）；高于期望 ⇒ 进程比库旧（不降级）
			state: expected === null ? 'unknown' : (version === expected ? 'current' : (version < expected ? 'behind' : 'ahead')),
			migratedAt: row?.migratedAt ?? null,
			applied: row?.applied ?? [],
		},
		backups: summarizeBackups(input.backupNames),
		lastSweepAt: Number.isFinite(input.lastSweepAt) && input.lastSweepAt > 0 ? input.lastSweepAt : null,
	};
}
