// @vssaros/dsh-sessions — 页面级偏好（固定 pin / 最近使用）的真源。
//
// 为什么不再用 localStorage（2026-10-19 用户要求）：
//   localStorage 是**浏览器分区级**的 —— 换设备丢、清缓存丢、另一个窗口（不同 session 分区）看不到，
//   而"我固定了哪几条会话"明显是**用户的**偏好，不是某个 WebContents 的残余状态。
//   ⇒ 落到 `<dshHome>/storages/vssaros-sessions/prefs.json`：跨窗口、跨设备（只要 dshHome 同步/同机）一致 ✓
//
// 纪律：
//   · **原子写**（tmp + rename）：写到一半崩掉不会留下半截 JSON ⇒ 下次读不会把整份 prefs 丢掉 ✗
//   · **读坏不抛**：解析失败 / 结构不认识 ⇒ 当空偏好（页面照常工作，只是没 pin 状态）
//   · **只收能理解的字段**：多余字段一律丢弃（不做"原样透传"，否则脏数据会越滚越大）
import fs from 'node:fs';
import path from 'node:path';

/** prefs 文件路径（dshHome 由 foundation 给出）。 */
export function prefsFileOf(dshHome) {
	return path.join(dshHome, 'storages', 'vssaros-sessions', 'prefs.json');
}

export const MAX_PINNED = 500;
export const MAX_RECENT = 20;

const strList = (v, max) => {
	if (!Array.isArray(v)) {
		return [];
	}
	const out = [];
	for (const item of v) {
		if (typeof item !== 'string') {
			continue;
		}
		const s = item.trim();
		if (s && !out.includes(s)) {
			out.push(s);
		}
		if (out.length >= max) {
			break;
		}
	}
	return out;
};

/**
 * 归一化：只保留认识的字段。
 *
 * `clearedAt`（2026-10-19，用户要求「清空历史会话」）：一个时间戳，**早于它的会话不再列出**。
 * 为什么用"时间戳 + 隐藏"而不是删文件：
 *   · 删投影缓存只是删索引，dsh 里的会话数据还在 ⇒ 看起来"删了"其实没删（不诚实 ✗）；
 *   · 误点一次就不可逆（1691 条里 1681 条是空白会话，但真会话也在一起）；
 *   ⇒ 隐藏是**可逆**的（`resetCleared()` 一键恢复），且永远不会伤到用户数据 ✓。
 * 语义边界：只隐藏 `createdAt <= clearedAt` 的；之后**新建**的会话仍然出现在列表里 ✓。
 */
export function normalizePrefs(raw) {
	const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	const clearedAt = typeof src.clearedAt === 'number' && Number.isFinite(src.clearedAt) && src.clearedAt > 0
		? Math.floor(src.clearedAt)
		: 0;
	return {
		version: 1,
		pinned: strList(src.pinned, MAX_PINNED),
		recent: strList(src.recent, MAX_RECENT),
		clearedAt,
		// ★ 2026-10-19（B 方案）：「显示空白会话」开关。默认 **false**（不显示）——
		//   空白会话 = 没说过话（官方 `sessionListMetadata.blank`），它只该存在于"新建对话"流程里，
		//   不该混进"历史会话"（实测本机 1691 条里 1681 条是这种，列表几乎被它占满 ✗）。
		showBlank: src.showBlank === true,
	};
}

/** 读偏好：文件不存在 / 坏 JSON / 结构不认识 ⇒ 空偏好（不抛）。 */
export function readPrefs(dshHome) {
	try {
		const text = fs.readFileSync(prefsFileOf(dshHome), 'utf8');
		return normalizePrefs(JSON.parse(text));
	} catch {
		return normalizePrefs(undefined);
	}
}

/**
 * 原子写偏好。
 *
 * ⚠ 先写 `<file>.tmp` 再 `rename` 覆盖 ⇒ 读侧要么看到旧文件、要么看到新文件，
 *   不会读到写了一半的 JSON（那会让下次 `readPrefs` 退化成空偏好 ⇒ 用户的 pin 全丢 ✗）。
 *
 * @returns 成功与否（写不进时不抛：pin 是"锦上添花"，不该让页面报错）
 */
export function writePrefs(dshHome, prefs) {
	const file = prefsFileOf(dshHome);
	const next = normalizePrefs(prefs);
	const tmp = file + '.tmp';
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
		fs.renameSync(tmp, file);
		return true;
	} catch {
		try { fs.unlinkSync(tmp); } catch { /* 清理失败无所谓 */ }
		return false;
	}
}

/** 把一个 id 推到 `recent` 头部（去重、限长）；返回新偏好（不改入参）。 */
export function withRecent(prefs, id) {
	const base = normalizePrefs(prefs);
	if (typeof id !== 'string' || !id.trim()) {
		return base;
	}
	const key = id.trim();
	return normalizePrefs({
		...base,                      // ⚠ 透传（clearedAt / showBlank）：漏一个就会被"最近使用"抹掉
		recent: [key, ...base.recent.filter(x => x !== key)],
	});
}

/** 切换某个 id 的固定状态；返回新偏好（不改入参）。 */
export function withToggledPin(prefs, id) {
	const base = normalizePrefs(prefs);
	if (typeof id !== 'string' || !id.trim()) {
		return base;
	}
	const key = id.trim();
	const has = base.pinned.includes(key);
	return normalizePrefs({
		...base,                      // 同上：pin 一次不能把"已清空 / 显示空白"抹掉
		pinned: has ? base.pinned.filter(x => x !== key) : [key, ...base.pinned],
	});
}

/**
 * 「清空历史会话」：把 `clearedAt` 设成 now（**只隐藏、不删数据**，见 normalizePrefs 的注释）。
 * @param at 时间戳；缺省取 Date.now()（测试里注入固定值 ⇒ 结果可断言）。
 */
export function withClearedAt(prefs, at = Date.now()) {
	const base = normalizePrefs(prefs);
	const stamp = Number.isFinite(at) && at > 0 ? Math.floor(at) : Date.now();
	return normalizePrefs({ ...base, clearedAt: stamp });
}

/** 「恢复被清空的会话」：清掉 `clearedAt`（pin / recent / showBlank 原样保留）。 */
export function resetCleared(prefs) {
	const base = normalizePrefs(prefs);
	return normalizePrefs({ ...base, clearedAt: 0 });
}

/**
 * 「显示 / 不显示空白会话」开关（B 方案，2026-10-19）。
 * 空白会话 = 没说过话（官方 `sessionListMetadata.blank`）⇒ 默认不显示；用户想找"刚建的会话"时可打开。
 */
export function withShowBlank(prefs, show) {
	const base = normalizePrefs(prefs);
	return normalizePrefs({ ...base, showBlank: show === true });
}
