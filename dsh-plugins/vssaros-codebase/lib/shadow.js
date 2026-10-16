// @vssaros/dsh-codebase — shadow：**产物落点、锁与原子写**（写侧的 I/O 半边，纯逻辑在 indexer.js ✓）。
//
// ## 落点有**两个** target（`config.indexTarget`；2026-10-12 决策 3 = 所有权从 IDE 交给 dsh ✓）
//
//   ① `'shadow'`（**缺省**，与从前逐字一致 ✓）：产物落到**我们自己的根**下，IDE 一行不用改 ✓
//
//         <indexDir>/codebase-index/<workspace 绝对路径的 sha256 前 16 位>/{artifact.json, graph.db.zst}
//
//      为什么空一格 `<indexDir>` 再散开：与其它模块同形（`config.X` 显式覆盖 → 环境/固定兜底），
//      且**多工作区互不干扰**（一个会话里挂多个仓库是常态 ✓）。
//
//   ② `'workspace'`（**交接后** ✓）：直接写 `<ws>/.codebase-memory/`（真源 IDE 那个目录 ✓）。
//      产物格式**逐字同形** ⇒ "换向"只是**换一个目录常量** ✓（这正是乙路线把交接推到最后一刻的回报 ✓）。
//      ⚠ 三条必须一起成立，否则不要打开这一档 ✗：
//        · **共用同一把锁**：谁在跑，另一个就等 ✓（见"锁"那节：阈值 5min 与 IDE 逐字对齐 + 60s 心跳 ✓）；
//        · **IDE 侧要先停写**（那是 `src/` 的变更，见 doc §5 P3 待办 ✓）—— 两边同时写**同一份产物**，
//          没有任何机制能救 ✗（锁只能挡"同时"，挡不住"轮流各写一半" ✓）；
//        · 缺省**不开**（不写 `indexTarget` ⇒ 还是影子 ✓）⇒ 打开它是**显式**动作，不是静默换向 ✓。
//
// ⚠ 转换期**两边都可能写过**那个目录：读侧因此保留"新鲜度纪律"（`store.js::graphDirOf` 的 `saved_at` 比较 ✓）
//   —— 交接完成后它退化成"谁最后写谁是真的"，但在 IDE 侧还没停写之前，它是唯一挡得住"读到旧图"的东西 ✓。
//
// ## `<indexDir>` 的链：`config.indexDir` → `<DSH_HOME>/codebase-index` → **未配置（拒绝）**
//
// ⚠ **刻意不引入其它模块那条数据根链**（kb / skills 读的那个键 ✗），两层原因：
//   ① 那会让本插件进 `dshPluginPackages` 的"**读数据根的模块**"名单 ⇒ 必须改 `src/` 的 `renderDataRootOverlay`
//      （并发会话区域 ✗）；
//   ② 本模块的图谱产物本来就该跟着 **dsh 自己的 home**（`DSH_HOME`）走 —— 与 `vssaros-dashboard` /
//      `vssaros-sessions` 的 `dshHomeOf` **同一条链** ✓（那条链已在真机上跑过 ✓）。
//   ⚠ 那个键的**字面量故意不写出来**（写成"其它模块那条数据根链"）：上面那个守卫是按 `lib/` 的**源码文本**
//      找它的，**注释也算** ✓ —— 我第一版就在这段注释里把它写全了 ⇒ 守卫报"vssaros-codebase 读数据根但
//      覆盖层里没有它的行" ✗（假红一次 ✓，教益：文本级守卫看不见"这是注释"）。真改回那条链时，
//      必须**同时**把本模块加进 `src/` 的覆盖层名单 ✓。
// 没配也没有 `DSH_HOME` ⇒ **不猜**，返回 `undefined` 并让工具如实报"未配置" ✓（与 `workspaceRootOf` 同一条纪律 ✓）。
//
// ## 三条写侧纪律（都是"慢一点没关系，坏了很难查"那类 ✓）
//
//   ① **先图后清单**：先落 `graph.db.zst`、再落 `artifact.json` ✓。读者（含我们自己）以**清单**为"图在不在"的
//      判据 ⇒ 反过来的顺序会出现"清单说有图、图还是半个/旧的"这种**最误导**的状态 ✗。
//   ② **原子替换**：都走 `<name>.tmp-<pid>-<rand>` + `rename` ✓（同目录 rename 是原子的 ✓）⇒ 读者**永远**
//      看不到半个文件（本仓真源 `codebaseGraphPersistence` 也是 `.tmp` + move ✓）。
//   ③ **锁有主**：`index.lock` 用 `O_EXCL`（`flag: 'wx'`）创建 ✓；持有者写进 token；**超时锁可接管**
//      （并**如实报出接管**而不是静默覆盖 ✓）。
//      ★ 判断"是不是崩溃残留"看的是**锁文件的 mtime**，不是内里的 `acquiredAt` ✓：
//        崩溃残留的真实特征就是"**这个文件很久没被碰过**" ✓；而"`acquiredAt` 很老、mtime 却是刚才"
//        的那把锁**不是**崩溃残留（那是"刚拿到锁的写者"✓，两个进程的时钟还可能不同步 ✓）——
//        第一版探针正是拿 `acquiredAt` 造夹具 ⇒ 假红 ✓（教益：夹具要造**真实的那种残骸** ✓）。
//      ★ **心跳（2026-10-12 交接时补上）**：P1 原本**刻意不做**（那次索引是"扫描 + 正则"，量级是秒 ✓，
//        代价只是"长于阈值的索引会被接管"，且在状态里显出来 ✓）。交接之后这条**不能再欠**：
//        ① 真解析（P2）一轮可能是分钟级；② 两边共用同一把锁与同一个 5min 阈值 ⇒ 没心跳必被对方判成残骸 ✗✗。
//        ⇒ `startLockHeartbeat`（每 60s 刷 mtime，与 IDE 同口径 ✓；一旦发现锁不是自己的就**停下**并回调 ✓）。
//        仍留一条**如实**的口径：状态工具输出里的 `lockStale`/`heartbeat` 会说明"这把锁有没有心跳" ✓。

import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { parseManifest } from './core/codebase.js';

/** 影子产物根目录名（在 `<indexDir>` 之下）。 */
export const SHADOW_SUBDIR = 'codebase-index';
/** 锁文件（与真源 IDE 侧**同名同格式** —— 2026-10-12 交接之后这不再只是"各自目录里不冲突" ✓）。 */
export const LOCK_FILE = 'index.lock';
/**
 * 超过这个时长没被更新的锁视为崩溃残留（可接管 ✓）。
 *
 * ★ 2026-10-12（交接）**从 10 分钟改成 5 分钟**，与 IDE 侧的 `INDEX_LOCK_STALE_MS` **逐字对齐**：
 *   两侧各自持一把锁写**同一个目录**时，"多久算残骸"必须是**同一个数** ✗ —— 否则会出现
 *   "IDE 认为我们的锁还活着、我们认为它们的锁是残骸"这种**互相接管**（两个写者同时写同一份产物 ✗✗）。
 *   ⚠ 前提是**我们有心跳**（见 `LOCK_HEARTBEAT_MS`）：没有心跳的话 5 分钟比原来的 10 分钟**更危险** ✓。
 */
export const LOCK_STALE_MS = 5 * 60_000;
/** 心跳间隔：索引期间刷新锁文件 mtime 的频率（与 IDE 侧的 `INDEX_LOCK_HEARTBEAT_MS` **同口径** ✓）。 */
export const LOCK_HEARTBEAT_MS = 60_000;
/** 写者标识（写进锁文件）—— 两边的诊断信息都靠它区分"谁在写" ✓。 */
export const WRITER_ID = 'vssaros-dsh';
/** 索引器的增量缓存（**不是产物**：读侧不认识它，丢了大不了全量重扫 ✓）。 */
export const CACHE_FILE = 'index-cache.json';
/** 产物落点：`shadow` = 我们自己的 `codebase-index/`（缺省 ✓）；`workspace` = `<ws>/.codebase-memory/`（**IDE 交接后** ✓）。 */
export const INDEX_TARGETS = ['shadow', 'workspace'];
/** 缺省落点（**不写 `config.indexTarget` 就与从前逐字一致** ✓ —— 交接是显式动作，不是静默换向 ✗）。 */
export const DEFAULT_INDEX_TARGET = 'shadow';

/**
 * 影子产物根：`config.indexDir` → `<DSH_HOME>/codebase-index` → `undefined`（未配置 ⇒ 不猜 ✓）。
 * @returns `{ root, source }` | `undefined`
 */
export function indexRootOf(config, { env = process.env } = {}) {
	const configured = typeof config?.indexDir === 'string' ? config.indexDir.trim() : '';
	if (configured) {
		return { root: configured, source: 'config.indexDir' };
	}
	const dshHome = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
	if (dshHome) {
		// 与 dashboard / sessions 的 `dshHomeOf` 同一条链（`config.dshHome` → `DSH_HOME` → `~/.dsh`）
		return { root: join(dshHome, SHADOW_SUBDIR), source: 'env DSH_HOME' };
	}
	return undefined;
}

/** 工作区键：绝对路径的 sha256 前 16 位（**同一台机器上多工作区互不干扰** ✓；改名后老目录不会被误用 ✓）。 */
export function workspaceKeyOf(root) {
	const normalized = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	return createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * 某个工作区的影子目录（**不创建**，纯算路径 ✓）。
 * @returns `{ dir, indexRoot, source, key }` | undefined（未配置 indexDir 且没有 DSH_HOME）
 */
export function shadowDirOf(config, root, options = {}) {
	const resolved = indexRootOf(config, options);
	if (!resolved || !root) {
		return undefined;
	}
	const key = workspaceKeyOf(root);
	return { dir: join(resolved.root, key), indexRoot: resolved.root, source: resolved.source, key };
}

/**
 * ★ 2026-10-12（决策 3 = **所有权从 IDE 交给 dsh**）：产物该写到**哪个目录**。
 *
 * 这条判断只有一处，写侧（indexService）与读侧（store）都调它 ✓ ⇒ **不可能出现"写的是一处、读的是另一处"** ✗
 * （那种错最难查：盘上明明有新产物、查询却一直给旧的 ✓）。
 *
 * @returns `{ target, dir, source, indexRoot?, key? }` | `{ error }`
 *   `target`：`'shadow'`（我们的 `codebase-index/<key>/`）| `'workspace'`（`<ws>/.codebase-memory/`，交接后 ✓）
 */
export function writeDirOf(config, root, options = {}) {
	const asked = indexTargetOf(config);
	if (asked.error) {
		return { error: asked.error };
	}
	if (!root) {
		return { error: '没有工作区根 ⇒ 不猜落点 ✗' };
	}
	if (asked.target === 'workspace') {
		// 交接之后这就是**我们的**目录了（IDE 侧不再写它 ⇒ 见 doc 的 P3 待办：IDE 索引器默认关闭 ✓）。
		// ⚠ 仍与 IDE 侧**共用同一把锁**：交接不是"可以同时写"的意思 ✓（谁在跑，另一个就等 ✓）。
		return { target: 'workspace', dir: join(root, '.codebase-memory'), source: `工作区 .codebase-memory（已交接给 dsh，config.indexTarget=${asked.target}）` };
	}
	const placed = shadowDirOf(config, root, options);
	if (!placed) {
		return { error: '未配置索引目录（`config.indexDir` 与 `DSH_HOME` 都没有）⇒ 影子产物无处可放，也不去猜 ✗' };
	}
	return { target: 'shadow', ...placed };
}

/**
 * 解析 `config.indexTarget`。**非法值不静默退回缺省** ✗ —— 那会让"我以为在写工作区、其实写在影子目录"
 * 变成一句查不出来的谜 ✓（本仓对这种静默错的纪律一贯是：当场拒 + 说清支持什么 ✓）。
 * @returns `{ target, source }` | `{ error }`
 */
export function indexTargetOf(config) {
	const raw = config?.indexTarget;
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return { target: DEFAULT_INDEX_TARGET, source: '缺省' };
	}
	const target = String(raw).trim().toLowerCase();
	if (!INDEX_TARGETS.includes(target)) {
		return { error: `不认识的 indexTarget「${String(raw)}」（支持：${INDEX_TARGETS.join(' / ')}；缺省 ${DEFAULT_INDEX_TARGET}）` };
	}
	return { target, source: 'config.indexTarget' };
}

export const graphPathOf = dir => join(dir, 'graph.db.zst');
export const manifestPathOf = dir => join(dir, 'artifact.json');
export const lockPathOf = dir => join(dir, LOCK_FILE);
export const cachePathOf = dir => join(dir, CACHE_FILE);

/** `stat` 的轻封装（不存在 ⇒ undefined ✓，不抛）。 */
async function statOf(path) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

/**
 * **一个产物目录的现状**（只读 ✓）—— 影子目录与工作区目录**同一份读法** ✓
 * （交接后两档只差"目录是谁的"，读法一模一样 ⇒ 不写第二份实现 ✗）。
 * @returns `{ dir, present, manifest?, manifestError?, bytes?, mtimeMs?, missing? }`
 */
export async function readArtifactInfo(dir) {
	const files = {};
	for (const [kind, path] of [['graph', graphPathOf(dir)], ['manifest', manifestPathOf(dir)]]) {
		const info = await statOf(path);
		if (info?.isFile()) {
			files[kind] = { bytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
		}
	}
	let manifest;
	let manifestError;
	if (files.manifest) {
		const parsed = parseManifest(await readFile(manifestPathOf(dir), 'utf8'));
		if (parsed.error) {
			manifestError = parsed.error;
		} else {
			manifest = parsed.manifest;
		}
	}
	return {
		dir,
		present: { graph: !!files.graph, manifest: !!files.manifest },
		...(files.graph ? { bytes: files.graph.bytes, mtimeMs: files.graph.mtimeMs } : {}),
		...(manifest ? { manifest } : {}),
		...(manifestError ? { manifestError } : {}),
		// 有清单**但没有图** = "清单说有图、其实图不在"（①②两条纪律就是为了让它不可能出现 ✓）
		...(files.manifest && !files.graph ? { missing: graphPathOf(dir) } : {}),
	};
}

/**
 * 影子产物现状（**只读**，页面/工具与探针共用 ✓）。
 * @returns `{ dir, key, indexRoot, source, present, manifest, manifestError, bytes, mtimeMs, missing }`
 */
export async function readShadowInfo(config, root, options = {}) {
	const placed = shadowDirOf(config, root, options);
	if (!placed) {
		return { error: '未配置索引目录（`config.indexDir` 与 `DSH_HOME` 都没有）⇒ 影子产物无处可放，也不去猜 ✗' };
	}
	return { ...placed, ...(await readArtifactInfo(placed.dir)) };
}

/** 影子产物"可被读侧采用"的判据（**唯一**判据：清单在**且**图在 ✓）。 */
export function shadowReadableOf(info) {
	return !!info && !info.error && info.present?.manifest === true && info.present?.graph === true;
}

/**
 * 原子写一份影子产物：**先图后清单**（见文件头纪律 ①）。
 * @returns `{ graphBytes, manifestBytes, dir }`
 */
export async function writeShadowArtifact(dir, { graphBytes, manifest }) {
	await mkdir(dir, { recursive: true });
	const suffix = `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	const writeAtomic = async (finalPath, data) => {
		const tempPath = finalPath + suffix;
		try {
			await writeFile(tempPath, data);
			await rename(tempPath, finalPath);
		} catch (e) {
			await rm(tempPath, { force: true }).catch(() => { });
			throw e;
		}
	};
	// ★ O3（2026-10-14，用户拍板 ✓）：**图内容没变 ⇒ 不重写 `graph.db.zst`** ✓ —— 否则每次建图都动它的 mtime，
	//   IDE 的轮询就每次都"发现换新" ✗（内容没变也重载 ✗）。序列化是**确定性**的（同一份图 ⇒ 逐字节相同 ✓，
	//   见索引器自证② ✓）⇒ 比对是可靠的 ✓。
	//   ⚠ **只跳过大文件** ✗：清单**照常写**（`saved_at` 的语义 = "上次索引的时刻" ✓ —— 不许为省一次写把它停更 ✗✗，
	//   否则"今天刚验证过、内容没变"会被变旧判决误报成"旧" ✗）。
	let graphUnchanged = false;
	try {
		const existing = await readFile(graphPathOf(dir));
		if (existing.length === graphBytes.length && existing.equals(graphBytes)) {
			graphUnchanged = true;
		}
	} catch { /* 没有 / 读不动 ⇒ 照常写 ✓ */ }
	if (!graphUnchanged) {
		await writeAtomic(graphPathOf(dir), graphBytes);
	}
	await writeAtomic(manifestPathOf(dir), Buffer.from(JSON.stringify(manifest, null, 1) + '\n', 'utf8'));
	return { dir, graphBytes: graphBytes.length, manifestBytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8'), graphUnchanged };
}

/**
 * 拿锁（`O_EXCL` ⇒ 同目录同时只有一个写者 ✓）。
 * @returns `{ ok: true, owner, tookOver? }` | `{ ok: false, heldBy, why }`
 */
export async function acquireIndexLock(dir, { owner, now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
	await mkdir(dir, { recursive: true });
	const path = lockPathOf(dir);
	// ★ 交接后锁文件是**两边共读**的：`token`/`acquiredAt` 是 IDE 侧 `parseIndexLock` 认的字段（必须有 ✓），
	//   另外两个是我们加上去让**两边诊断都看得懂"谁在写"**的 ✓（IDE 的解析器只校验前两个 ⇒ 多字段无害 ✓）。
	const payload = JSON.stringify({ token: owner, pid: process.pid, writer: WRITER_ID, instanceId: 'dsh', acquiredAt: now });
	try {
		await writeFile(path, payload, { flag: 'wx' });
		return { ok: true, owner };
	} catch (e) {
		if (e?.code !== 'EEXIST') {
			throw e;
		}
	}
	// 已有一把锁：读它、判它是否**崩溃残留**（mtime 太老）⇒ 可接管（并如实报出 ✓）
	let heldBy;
	let mtimeMs;
	try {
		heldBy = JSON.parse(await readFile(path, 'utf8'));
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		heldBy = undefined;
	}
	if (typeof mtimeMs === 'number' && now - mtimeMs > staleMs) {
		const tookOver = heldBy;
		await writeFile(path, payload);
		return { ok: true, owner, tookOver: { ...(tookOver ?? {}), staleMs: Math.round(now - mtimeMs) } };
	}
	// 交接之后这句话要能区分"谁"在写（`writer` 是我们写的；IDE 侧的锁没有这个字段 ⇒ 就是它 ✓）
	const who = heldBy?.writer ? `${heldBy.writer}${heldBy.instanceId ? `/${heldBy.instanceId}` : ''}` : 'IDE 侧（锁里没有 writer 字段）';
	return {
		ok: false,
		heldBy: heldBy ?? { token: '(锁文件读不动)' },
		why: `另一个写者正在索引这个工作区：${who}（锁 ${path}，token ${heldBy?.token ?? '未知'}，mtime ${Math.round((now - (mtimeMs ?? now)) / 1000)}s 前）⇒ 不排队、不抢（等它结束再来 ✓）`,
	};
}

/**
 * ★ 2026-10-12（交接）：**锁心跳** —— 索引期间每 `intervalMs` 刷新锁文件 mtime ✓。
 *
 * 为什么这条随交接变成**必须**（P1 时是"刻意不做"✓，见上面那段取舍）：
 *   ① 交接之后两边看的是**同一把锁**、同一个 5 分钟阈值 ⇒ 我们没心跳就会被 IDE 判成残骸**接管** ✗✗
 *      （而真解析一轮可能是分钟级 ⇒ 这不是理论风险 ✓）；
 *   ② 心跳只刷 mtime（IDE 侧判残骸用的正是 mtime ✓，它自己也只刷 mtime ✓）。
 *
 * ⚠ 丢失时必须**自己停下**：每跳之前先核 token —— 一旦发现锁已经不是自己的（被人接管了 ✓），
 *   就停止刷 mtime 并回调 `onLost` ✓（继续刷等于给别人的锁续命 ✗，那比没心跳更坏 ✓）。
 *
 * @returns `{ stop, state }`；`state` 里有 `touches` / `lost` / `lastTouchAt`（页面与状态工具可展示 ✓）
 */
export function startLockHeartbeat(dir, owner, { intervalMs = LOCK_HEARTBEAT_MS, onLost = () => { }, now = () => Date.now() } = {}) {
	const path = lockPathOf(dir);
	const state = { intervalMs, touches: 0, lost: false, lastTouchAt: undefined, error: undefined, startedAt: now() };
	let timer;
	let stopped = false;
	const stop = () => {
		stopped = true;
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const beat = async () => {
		if (stopped || state.lost) {
			return;
		}
		try {
			const held = JSON.parse(await readFile(path, 'utf8'));
			if (held?.token !== owner) {
				state.lost = true;
				state.error = `锁已不是自己的（文件里=${held?.token ?? '未知'}，写者=${held?.writer ?? '未知'}）⇒ 停止心跳`;
				stop();
				onLost({ reason: 'taken-over', heldBy: held });
				return;
			}
			const at = new Date(now());
			await utimes(path, at, at);
			state.touches += 1;
			state.lastTouchAt = at.getTime();
		} catch (e) {
			// 锁文件读不到/写不动：**不假装还在心跳** ✗（但也别把一次成功的索引搞崩 ⇒ 记下来 ✓）
			state.error = `心跳失败：${String(e?.code ?? e?.message ?? e)}`;
		}
	};
	// ⚠ 下限 100ms（**不是 1000**）：第一版写 `Math.max(1000, intervalMs)` ⇒ 传 120ms 会被**静默**改成 1s，
	//   探针等 500ms 看到的是"一次都没跳" ✗✗（教益：接受一个参数就得真用它 —— 偷偷夹紧等于撒谎 ✓）。
	//   100ms 的作用只是"别让人把宿主事件循环刷爆"，与"心跳频率"无关 ✓。
	timer = setInterval(() => { void beat(); }, Math.max(100, intervalMs));
	if (typeof timer.unref === 'function') {
		timer.unref(); // 别让心跳把进程吊住 ✓（与 watcher 的定时器同理 ✓）
	}
	return { stop, state };
}

/** 放锁：**只放自己那把**（token 不符 ⇒ 不动别人的锁 ✓）。 */
export async function releaseIndexLock(dir, owner) {
	const path = lockPathOf(dir);
	try {
		const held = JSON.parse(await readFile(path, 'utf8'));
		if (held?.token !== owner) {
			return { released: false, why: `锁已不是自己的（文件里=${held?.token ?? '未知'}）⇒ 不删别人的锁 ✓` };
		}
	} catch {
		return { released: false, why: '锁文件读不到（已被清掉？）' };
	}
	await rm(path, { force: true });
	return { released: true };
}

/** 目录里现在有哪些文件（页面/状态工具展示用 ✓）。 */
export async function listShadowFiles(dir) {
	try {
		return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort();
	} catch {
		return [];
	}
}
