// @vssaros/dsh-kb — `kb_organize` 的**纯逻辑**：路径归一化 + 围栏 + 上限 + 备份落点命名。
//
// 真源：IDE `browser/providers/tool/kbOrganizeTools.ts`（2026-10-12 逐条核对 ✓）。照抄的语义：
//   · 只能在 **`笔记/` 区**内操作 ✗（不是整个 vault ✓ —— 资料库正文 `库/` 不许动 ✓）；
//   · `moves` 自动建父目录 ✓、`from === to` / `from 不存在` / **`to` 已存在**（**不覆盖** ✓）⇒ 逐项拒；
//   · `deletes` **不是真删** ⇒ 移进 **vault 之外**的备份目录（回收站语义 ✓）；
//   · 一次最多 `MAX_OPS` 项 ✓；结果里含一行 `KB_ORGANIZE_RESULT {json}` ✓。
// **差异（必须诚实写进工具描述 ✓）**：IDE 版还为每个文件写聊天页签的 checkpoint（可 `undoAll` ✓），
//   dsh 侧没有那套会话回滚 ⇒ 我们的"还原点"**只有备份目录** ✓（这也是"备份失败就不搬"的原因 ✓）。
//
// 纯函数：不 import fs ✓ ⇒ 归一化/围栏/上限可直测（`p3-08` ✓），真正的写盘在 `lib/organize.js` ✓。

/** 允许操作的区域（相对 vault 根 ✓）：**只有**「笔记」区 ✓。 */
export const NOTES_DIR = '笔记';

/** 单次操作项上限（照真源 ✓：防模型一次吐上千条）。 */
export const MAX_OPS = 50;

/** 统一成分隔符 `/` 的字符串（Windows 上是反斜杠 ⇒ 比对前必须归一 ✓）。 */
const slashes = p => String(p ?? '').replace(/\\/g, '/');
/** 去掉结尾多余的 `/`（`C:/a/` ⇒ `C:/a` ✓），但保留根 `/` ✓。 */
const trimTrailing = p => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * 归一化调用方给的路径：trim ✓、`\` → `/` ✓、去前导 `./` ✓。
 * ⚠ 与真源的**一处刻意差异** ✗：真源用 `s.includes('..')` 一律拒 ⇒ 会连**合法文件名** `a..b.md` 一起拒 ✗。
 *   这里改成**按段**判（任一段 === `..` 才拒 ✓）⇒ 围栏安全性不变 ✓、误拒更少 ✓。
 * @returns 归一化后的字符串；非法（空 / 含 `..` 段）⇒ `undefined`
 */
export function normalizeRelPath(p) {
	const s = slashes(p).trim().replace(/^\.\//, '');
	if (!s) { return undefined; }
	if (s.split('/').some(seg => seg === '..')) { return undefined; }
	return s;
}

/**
 * 把调用方给的路径解析成绝对路径 + 围栏判定（**纯字符串运算** ✓，不碰 fs ✓）。
 * 接受相对 vault 根的（`笔记/01_学习/x.md` ✓）或绝对的（`D:/…/笔记/y.md` ✓）——与真源同口径 ✓。
 * ⚠ 围栏是 **`<vault>/笔记/` 之内**（含前缀斜杠 ✓）⇒ 「笔记」目录**本身**也在围栏外 ✓
 *   （不允许把整个笔记区搬走/改名 ✗）。
 * @returns `{ abs, rel, inside, why }`；非法路径 ⇒ `{ why: '路径无效' }`
 */
export function resolveOrganizePath(vaultRoot, p) {
	const rel = normalizeRelPath(p);
	if (rel === undefined) { return { why: '路径无效' }; }
	const root = trimTrailing(slashes(vaultRoot));
	const isAbs = /^[a-zA-Z]:\//.test(rel) || rel.startsWith('/');
	const abs = trimTrailing(isAbs ? rel : `${root}/${rel}`);
	const prefix = `${root}/${NOTES_DIR}/`.toLowerCase();
	const inside = abs.toLowerCase().startsWith(prefix);
	return { abs, rel, inside, why: inside ? '' : `越出「${NOTES_DIR}」区` };
}

/** 备份目录：**vault 的兄弟目录** ✓（真源同款 ✓）—— vault 文件树会把 vault 内的一切列出来，
 *  备份放进 vault 里就会被当成知识库内容 ✗ ⇒ 必须在 vault **之外** ✓。 */
export function backupDirFor(vaultRoot, stamp) {
	const root = trimTrailing(slashes(vaultRoot));
	const cut = root.lastIndexOf('/');
	const parent = cut > 0 ? root.slice(0, cut) : root;
	const vaultName = root.slice(cut + 1) || 'vault';
	return `${parent}/${vaultName}-backup-kborganize-${stamp}`;
}

/** 备份目录的时间戳：ISO 去掉 `-`/`:`/`T` 取前 12 位（`202610121530` ✓，照真源 ✓）。 */
export function stampOf(date = new Date()) {
	return new Date(date).toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

/**
 * 一次调用的项数与上限判定（纯 ✓）。
 * ⚠ 新增动词时**必须**加进来 ✗：审批闸的判据就是 `planCounts(args).total > 0`
 *   （`index.js` 的 `writeIntentOf` ✓）⇒ 漏一个 ⇒ 带那个动词的调用会**不弹窗就写盘** ✗✗
 *   （2026-10-14 加 `copies` 时正是靠这条注释＋p3-08 的"全空不拦"断言把门对齐的 ✓）。
 */
export function planCounts({ moves, creates, deletes, copies } = {}) {
	const m = Array.isArray(moves) ? moves.length : 0;
	const c = Array.isArray(creates) ? creates.length : 0;
	const d = Array.isArray(deletes) ? deletes.length : 0;
	const p = Array.isArray(copies) ? copies.length : 0;
	const total = m + c + d + p;
	return { moves: m, creates: c, deletes: d, copies: p, total, empty: total === 0, tooMany: total > MAX_OPS };
}

/**
 * 复制撞名时的增量名 —— **逐字照真源** `knowledgeBaseView.ts:4160-4171` 的 `_incrementalCopyName` ✓：
 *   `甲.md` ⇒ `甲 copy.md` ⇒ `甲 copy 2.md` ⇒ … ⇒ `甲 copy 99.md` ✓；99 个都被占 ⇒
 *   退到 `甲 copy <时间戳>.md` ✓（真源的兜底那句 ✓）。
 * 扩展名的取法也照真源（`uriExtname` ✓）：**最后一个点**之后那截（`甲.md` ⇒ `.md` ✓）；
 *   ⚠ 点在下标 0（`.gitignore` ✓）**不算扩展名** ⇒ 整名当 base ✓。
 * 纯函数 ✓：`isTaken` 由调用方注入（同步判定 ✓，调用方读一次 readdir 就够 ⇒ 比真源的 99 次 stat 省 ✓）；
 *   `now` 也可注入（只有兜底那一支用得到 ⇒ 可测 ✓）。
 * @returns 候选文件名（**不含目录** ✓）
 */
export function incrementalCopyName(name, isTaken, now = Date.now()) {
	const text = String(name ?? '');
	const dot = text.lastIndexOf('.');
	const ext = dot > 0 ? text.slice(dot) : '';
	const base = dot > 0 ? text.slice(0, dot) : text;
	for (let i = 1; i < 100; i++) {
		const candidate = i === 1 ? `${base} copy${ext}` : `${base} copy ${i}${ext}`;
		if (!isTaken(candidate)) { return candidate; }
	}
	return `${base} copy ${now}${ext}`;
}
