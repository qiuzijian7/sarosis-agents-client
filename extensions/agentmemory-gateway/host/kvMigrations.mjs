/*---------------------------------------------------------------------------------------------
 *  kvMigrations.mjs — KV 结构版本与迁移（2026-11-02）
 *
 *  背景：KV 是 schemaless 的 `kv_store(scope, key, value)`（value = JSON blob），
 *  没有表结构、没有版本号 ⇒ 历史上每次改数据口径都只能靠"一次性幂等补丁"，
 *  而补丁是否跑过**无处可查**。2026-10-20 的 strength 刻度混用止血
 *  （`evict` 里那条"只上报不删除"）正卡在这里：没有"迁移已完成"的判据，
 *  就不敢把删除逻辑放开。
 *
 *  纪律（照 dsh-memory-plus 的 application_id / user_version 三条实践）：
 *   ① 版本号单独一行 `mem:meta` / `schema`，不混进任何业务 scope；
 *   ② 迁移**只增不改语义、绝不整表重写** —— 用户的记忆是不可再生资产，
 *      一次整表重写失败就是全损；
 *   ③ 迁移前 `VACUUM INTO` 一份备份（调用方负责，见 host.mjs），保留最近 3 份；
 *   ④ 库版本**高于**本进程认识的上界 ⇒ 只 warn、不做迁移（不降级、不猜）。
 *
 *  本文件是**纯逻辑**（不碰 sqlite / fs），所以能直接被 `node --test` 覆盖。
 *--------------------------------------------------------------------------------------------*/

/** 当前进程认识的 KV 结构版本（每次新增迁移 +1）。 */
export const KV_SCHEMA_VERSION = 1;

/** 版本号存放位置（scope / key）。 */
export const KV_SCHEMA_SCOPE = 'mem:meta';
export const KV_SCHEMA_KEY = 'schema';

/**
 * 迁移表。每条 `migrate(row)` 收到 `{ scope, key, value }`（value 已 JSON.parse），
 * 返回**改写后的 value** 表示这一行变了；返回 `null`/`undefined` 表示不动。
 *
 * ⚠ 迁移必须**幂等**：同一份数据跑两遍结果相同（回归测试会验）。
 */
export const KV_MIGRATIONS = [
	{
		version: 1,
		id: 'strength-scale-unify',
		title: 'strength 刻度统一：0–1 刻度 ×10 归到 0–10',
		/**
		 * 背景：`autoPage` 曾写 `importance / 10`（0–1），而 `rememberMemory` 写 7、
		 * `reinforceMemory` 是 `+1`（0–10）⇒ 同一个 `strength` 字段两套刻度。
		 * 删除判据「strength ≤ 2」在 0–1 刻度下等于"全部"（实测 4027 条会整批硬删）。
		 * 写入侧已在 2026-11-02 统一到 0–10，这里把**存量**归一。
		 */
		migrate(row) {
			if (!row || typeof row.scope !== 'string' || !row.scope.startsWith('mem:memories:')) { return null; }
			const value = row.value;
			if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
			const strength = value.strength;
			if (typeof strength !== 'number' || !Number.isFinite(strength)) { return null; }
			// 0 保持 0（"从未评估"）；>1 已在 0–10 刻度
			if (strength <= 0 || strength > 1) { return null; }
			const next = { ...value, strength: Math.round(strength * 1000) / 100 };
			return next;
		},
	},
];

/**
 * 读取存的版本号（解析不出 ⇒ 0 = 从未迁移）。
 * @param raw `mem:meta`/`schema` 的原始 JSON 字符串（可为 null）
 * @returns 版本号（非负整数）
 */
export function readSchemaVersion(raw) {
	if (typeof raw !== 'string' || raw.length === 0) { return 0; }
	try {
		const parsed = JSON.parse(raw);
		const version = Number(parsed?.version);
		return Number.isInteger(version) && version >= 0 ? version : 0;
	} catch {
		return 0;
	}
}

/**
 * 依次应用 `fromVersion` 之后的所有迁移。
 *
 * @param rows `[{ scope, key, value }]`，`value` 已解析（会被就地改写）
 * @param fromVersion 当前库版本（0 = 从未迁移）
 * @returns `{ applied, changed, version }` —— `changed` 只含真的被改过的行（调用方只写这些）
 */
export function runKvMigrations(rows, fromVersion = 0) {
	const list = Array.isArray(rows) ? rows : [];
	const from = Number.isInteger(fromVersion) && fromVersion > 0 ? fromVersion : 0;
	const pending = KV_MIGRATIONS
		.filter(m => m.version > from)
		.sort((a, b) => a.version - b.version);
	const applied = [];
	const changed = [];
	if (pending.length === 0) {
		return { applied, changed, version: from };
	}
	for (const migration of pending) {
		let touched = 0;
		for (const row of list) {
			let next;
			try {
				next = migration.migrate(row);
			} catch {
				continue; // 单行异常不拖垮整次迁移（坏数据留在原处，下一版迁移还能再试）
			}
			if (next === null || next === undefined) { continue; }
			row.value = next;
			touched++;
			if (!changed.includes(row)) { changed.push(row); }
		}
		applied.push({ version: migration.version, id: migration.id, title: migration.title, rows: touched });
	}
	return { applied, changed, version: pending[pending.length - 1].version };
}

/**
 * 组装版本行的内容（调用方负责落盘）。
 * @param version 目标版本
 * @param applied `runKvMigrations` 的 applied
 */
export function buildSchemaRow(version, applied = []) {
	return {
		version,
		migratedAt: new Date().toISOString(),
		applied: applied.map(a => `${a.version}:${a.id}(${a.rows})`),
	};
}
