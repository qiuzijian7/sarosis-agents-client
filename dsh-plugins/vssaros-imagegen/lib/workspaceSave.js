/**
 * 落盘（宿主侧）：把出图写进**用户工作区** ⇒ 用户拿得到"我的图"。
 *
 * 为什么要它（2026-10-21，二批⑤）：图只活在 attachment 存储里 ⇒ 用户在文件管理器里
 * 找不到、也没法在别处引用 ⇒ "我生成的图"等于不存在（对比上游的 `workspace-save.ts`）。
 *
 * 三条纪律（每条都对应一种"看起来存了、其实没存或存错地方"的坑）：
 *   ① **内容寻址**：文件名 = `image-<sha256 前 8>.<ext>` ⇒ 同一张图永远同一个名字
 *      （重复生成不会堆一堆积重文件 ⇒ 幂等 ✓）。
 *   ② **原子写**：先写同目录的临时文件，再 `rename`（同目录 rename 是原子的）⇒
 *      读者永远看不到"写了一半"的文件。⚠ Windows 的 rename **不能覆盖已有文件**
 *      ⇒ 已存在时先删再改名（内容寻址 ⇒ 同名即同内容，删了重写不丢信息 ✓）。
 *   ③ **目录包含性 + 符号链接**：目标目录必须在工作区根**里面**（`..` 逃逸一律拒），
 *      且**解析软链后的真实路径**仍要在根里面（防"目录是软链 ⇒ 写到工作区外"）✓。
 *
 * ⚠ 本模块**不猜**工作区根：根由调用方给（`state.resolveWorkspaceRoot()` ⇒ 运行期工作区
 *   上下文优先，见 lib/index.js）⇒ 没有根就如实报"不知道工作区根"，不去 `~/.vssaros` 之类
 *   的地方乱写（上游那个坑 H4 就是"写死 dsh home"）。
 */

import { createHash } from 'node:crypto';
import {
	existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** 落盘目录（相对工作区根）。一个顶层文件夹，不散落在用户仓库里 ✓。 */
export const DEFAULT_IMAGE_DIR = '.vssaros-images';

/** 媒体类型 → 扩展名。 */
const EXT_BY_MEDIA = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
};

/** 扩展名 → 媒体类型（读盘时反查用）。 */
const MEDIA_BY_EXT = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
};

/**
 * 按魔数嗅探图片类型（不靠扩展名 ⇒ 改过名的文件也能认）。
 * @param {Uint8Array | Buffer} bytes
 * @returns {string | undefined} 媒体类型；认不出时是 undefined
 */
export function sniffImageMediaType(bytes) {
	const b = bytes ? Buffer.from(bytes) : undefined;
	if (!b || b.length < 12) { return undefined; }
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) { return 'image/png'; }
	// JPEG: FF D8 FF
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) { return 'image/jpeg'; }
	// GIF: 'GIF8'
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) { return 'image/gif'; }
	// WEBP: 'RIFF' .... 'WEBP'
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
		return 'image/webp';
	}
	return undefined;
}

/**
 * 媒体类型 → 扩展名（认不出时给 png，并在返回里带 `guessed` 标记）。
 * @param {string | undefined} mediaType
 * @returns {string}
 */
export function extensionFor(mediaType) {
	return EXT_BY_MEDIA[String(mediaType ?? '').trim().toLowerCase()] ?? 'png';
}

/**
 * 内容寻址的文件名：`image-<sha256 前 8>.<ext>`。
 * @param {Uint8Array | Buffer} bytes
 * @param {string} [mediaType]
 * @returns {string}
 */
export function contentAddressedName(bytes, mediaType) {
	const hash = createHash('sha256').update(Buffer.from(bytes ?? [])).digest('hex').slice(0, 8);
	return `image-${hash}.${extensionFor(mediaType)}`;
}

/**
 * 目标目录：必须在工作区根**里面**。
 *
 * @param {string} root 工作区根（绝对路径）
 * @param {string | undefined} relDir 相对目录（可空 ⇒ 根目录本身）
 * @returns {{ dir: string } | { error: string }}
 */
export function resolveTargetDir(root, relDir) {
	const base = resolve(String(root ?? '').trim());
	if (!base) { return { error: '工作区根是空的' }; }
	if (!existsSync(base)) { return { error: `工作区根不存在：${base}` }; }
	let rootStat;
	try {
		rootStat = lstatSync(base);
	} catch (e) {
		return { error: `工作区根读不了：${String(e?.message ?? e)}` };
	}
	if (!rootStat.isDirectory()) { return { error: `工作区根不是目录：${base}` }; }
	const rel = String(relDir ?? '').trim();
	if (!rel) { return { dir: base }; }
	// 绝对路径 / 带盘符的路径 ⇒ 一律拒（"落盘目录"只能是工作区内的相对目录）。
	if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
		return { error: `落盘目录必须是工作区内的相对路径（收到：${rel}）` };
	}
	const dir = resolve(base, rel);
	// 包含性：解析后必须仍在根里面（`..` 逃逸在此被挡住 ✓）。
	const inside = relative(base, dir);
	if (inside.startsWith('..') || isAbsolute(inside)) {
		return { error: `落盘目录跑出工作区了（${rel}）` };
	}
	return { dir };
}

/**
 * 真实路径包含性校验（防软链逃逸）：`target` 解析软链后必须仍在 `root` 解析软链后里面。
 *
 * ⚠ 判据的方向别写反：相对路径**不以 `..` 开头**（且不是绝对路径）⇒ 在根里面 ✓
 *   （`inside === ''` = 就是根本身，也算里面 ✓）。
 *
 * @param {string} root
 * @param {string} target
 * @returns {{ error: string } | undefined} undefined = 通过
 */
function checkRealPathInside(root, target) {
	let realRoot;
	let realTarget;
	try {
		realRoot = realpathSync(root);
		realTarget = realpathSync(target);
	} catch (e) {
		return { error: `目录解析失败：${String(e?.message ?? e)}` };
	}
	const inside = relative(realRoot, realTarget);
	if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) { return undefined; }
	return { error: `落盘目录经软链解析后跑出工作区了（${target}）` };
}

/**
 * 把一张图写进工作区。
 *
 * @param {object} input
 * @param {Uint8Array | Buffer} input.bytes 图字节
 * @param {string} [input.mediaType] 媒体类型（认不出时按魔数嗅探）
 * @param {string} input.root 工作区根
 * @param {string} [input.dir] 相对工作区根的目录（默认 `.vssaros-images`）
 * @returns {Promise<{ ok: true, path: string, name: string, dir: string, existed: boolean, mediaType: string }
 *   | { ok: false, error: string }>}
 */
export async function saveImageToWorkspace({ bytes, mediaType, root, dir } = {}) {
	const data = bytes ? Buffer.from(bytes) : undefined;
	if (!data || data.length === 0) { return { ok: false, error: '图字节是空的' }; }
	const type = String(mediaType ?? '').trim() || sniffImageMediaType(data) || 'image/png';
	const target = resolveTargetDir(root, dir ?? DEFAULT_IMAGE_DIR);
	if (target.error) { return { ok: false, error: target.error }; }
	const dirPath = target.dir;
	try {
		mkdirSync(dirPath, { recursive: true });
	} catch (e) {
		return { ok: false, error: `建目录失败：${String(e?.message ?? e)}` };
	}
	const real = checkRealPathInside(root, dirPath);
	if (real) { return { ok: false, error: real.error }; }
	const name = contentAddressedName(data, type);
	const path = resolve(dirPath, name);
	// 已在（内容寻址 ⇒ 同名即同内容）⇒ 不重写（幂等 ✓）。
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			return { ok: false, error: `目标位置是符号链接，拒绝写入：${path}` };
		}
		if (stat.isFile()) {
			return { ok: true, path, name, dir: dirPath, existed: true, mediaType: type };
		}
	} catch {
		/* 不存在 ⇒ 下面写 ✓ */
	}
	// 原子写：同目录临时文件 → rename（同目录 rename 是原子的 ✓）。
	const tmp = resolve(dirPath, `.tmp-${name}-${process.pid}-${Date.now().toString(36)}`);
	try {
		writeFileSync(tmp, data);
	} catch (e) {
		return { ok: false, error: `写临时文件失败：${String(e?.message ?? e)}` };
	}
	try {
		renameSync(tmp, path);
	} catch (e) {
		// Windows：目标已存在时 rename 报 EEXIST/EPERM ⇒ 先删再改名（内容寻址 ⇒ 不丢信息 ✓）。
		try { unlinkSync(tmp); } catch { /* 清理失败无所谓 ✓ */ }
		try {
			if (existsSync(path)) { unlinkSync(path); }
			writeFileSync(tmp, data);
			renameSync(tmp, path);
		} catch (e2) {
			try { if (existsSync(tmp)) { unlinkSync(tmp); } } catch { /* 清理失败无所谓 ✓ */ }
			return { ok: false, error: `落盘失败：${String(e2?.message ?? e2)}` };
		}
	}
	return { ok: true, path, name, dir: dirPath, existed: false, mediaType: type };
}

/**
 * 读一张盘上的图（`edit_image` 的 `source:'path'` 分支）。
 *
 * ⚠ 目录包含性：工作区根已知时，路径必须在根**里面**（软链逃逸同样挡住）⇒
 *   "让模型读任意盘上文件"这件事不成立（那属于文件工具的职责，不是改图工具的）✓。
 *
 * @param {object} input
 * @param {string} input.path 图路径
 * @param {string} [input.root] 工作区根（给了就做包含性校验）
 * @returns {Promise<{ ok: true, bytes: Buffer, mediaType: string, path: string }
 *   | { ok: false, error: string }>}
 */
export async function readImageFile({ path, root } = {}) {
	const raw = String(path ?? '').trim();
	if (!raw) { return { ok: false, error: '路径是空的' }; }
	const abs = resolve(raw);
	let stat;
	try {
		stat = lstatSync(abs);
	} catch (e) {
		return { ok: false, error: `文件读不了：${String(e?.message ?? e)}` };
	}
	if (stat.isSymbolicLink()) { return { ok: false, error: `目标是符号链接，拒绝读取：${abs}` }; }
	if (!stat.isFile()) { return { ok: false, error: `不是文件：${abs}` }; }
	const base = String(root ?? '').trim();
	if (base) {
		const inside = relative(resolve(base), abs);
		if (inside.startsWith('..') || isAbsolute(inside)) {
			return { ok: false, error: `路径在工作区外面，拒绝读取：${abs}` };
		}
		const real = checkRealPathInside(base, resolve(base, inside));
		if (real) { return { ok: false, error: real.error }; }
	}
	let bytes;
	try {
		bytes = readFileSync(abs);
	} catch (e) {
		return { ok: false, error: `文件读不了：${String(e?.message ?? e)}` };
	}
	const mediaType = sniffImageMediaType(bytes);
	if (!mediaType) {
		return { ok: false, error: `这个文件不是图片（认不出格式）：${abs}` };
	}
	return { ok: true, bytes, mediaType, path: abs };
}

/** 扩展名 → 媒体类型（读盘时兜底嗅探失败的情况）。 */
export function mediaTypeForExtension(filePath) {
	const dot = String(filePath ?? '').lastIndexOf('.');
	if (dot < 0) { return undefined; }
	return MEDIA_BY_EXT[String(filePath).slice(dot + 1).toLowerCase()];
}

/**
 * 按工具参数决定要不要落盘（⑤ 的统一入口，两个工具共用）。
 *
 * @param {object} input
 * @param {boolean | undefined} input.asked 参数 `save_to_workspace`（**缺省 = true**）
 * @param {Uint8Array | Buffer} input.bytes
 * @param {string} [input.mediaType]
 * @param {string | undefined} input.root 工作区根（没有 ⇒ 落不了盘，如实说）
 * @param {string | undefined} input.dir 相对工作区根的目录
 * @returns {Promise<{saved: boolean, path?: string, name?: string, existed?: boolean,
 *   error?: string, skipped?: string}>}
 */
export async function maybeSaveToWorkspace({ asked, bytes, mediaType, root, dir } = {}) {
	// 缺省 = 存（用户要的是"我的图"）；显式 false 才不存。
	if (asked === false) { return { saved: false, skipped: '按参数要求不落盘' }; }
	if (!bytes || bytes.length === 0) { return { saved: false, error: '图字节是空的' }; }
	if (!String(root ?? '').trim()) {
		return { saved: false, error: '不知道工作区根（Host 没拿到工作区上下文）' };
	}
	const result = await saveImageToWorkspace({ bytes, mediaType, root, dir });
	if (!result.ok) { return { saved: false, error: result.error }; }
	return { saved: true, path: result.path, name: result.name, existed: result.existed };
}

/**
 * 落盘结果的**一句话提示**（给工具结果文本用）。
 *
 * ⚠ 与 `maybeSaveToWorkspace` 的口径一致：只有真落成了才说"已存到工作区"，
 *   跳过就说跳过、失败就说原因 ⇒ 不静默、也不谎报成功 ✓。
 *
 * @param {object | string} saved `maybeSaveToWorkspace` 的返回值，或直接给路径
 * @returns {string}
 */
export function savedPathNote(saved) {
	if (typeof saved === 'string') { return saved ? `已存到工作区：${saved}` : ''; }
	const s = saved && typeof saved === 'object' ? saved : {};
	if (s.saved && s.path) { return `已存到工作区：${s.path}`; }
	if (s.skipped) { return `未落盘：${s.skipped}`; }
	if (s.error) { return `落盘失败：${s.error}`; }
	return '';
}

/** 路径分隔符（给外部拼相对路径用；Windows 上是 `\`）。 */
export const PATH_SEP = sep;
