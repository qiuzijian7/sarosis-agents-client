// @vssaros/dsh-marketplace — tar/tar.gz 读写（★ 2026-10-22 S2：让 dsh 侧能自己解包/打包）
//
// ★ 为什么要自己实现：
//   S2 要把 agent/skill/workflow 的**安装与发布**搬回 dsh 侧，而商城的包是 `package.tar.gz`。
//   dsh 侧**没有** tar 实现（只有 `node:zlib` 的 gzip 先例）⇒ 两条路：
//     ① 调系统 `tar` 命令 —— 用户机器上不一定有（Windows 10 以下没有）✗
//     ② 自己解析 ustar —— 格式简单稳定（512 字节头 + 512 对齐数据）✓ ⇒ 选 ②
//
// ★ 支持范围（够商城用，且**不支持就如实抛错**，绝不静默跳过）：
//   - ustar / posix 头（`magic = 'ustar\0'`）✓
//   - 普通文件（typeflag '0'/'\0'）、目录（'5'）、符号链接（'2'，解包时**跳过**并记一笔）✓
//   - pax 扩展头（'x'/'g'）与 GNU 长名（'L'/'K'）**跳过**（我们的包文件名都短；
//     真遇到超长名会走 pax ⇒ 跳过 pax 后名字截断会**报错**而不是写错文件 ✓）
//   - 打包只写 ustar（name ≤100 或 name+prefix ≤255），超长**抛错**（如实）
//   - ⚠ 安全：解包**挡住路径穿越**（`..` / 绝对路径 / 盘符），与服务端 `sanitizeRelPath` 同精神 ✓

// ⚠ **解压必须异步**：`gunzipSync` 会把 Host 主线程卡住（商城包可以几 MB，同步解压期间
//   整个 dsh 界面都在等）⇒ `dshPluginPackages.test.ts` 有一条守卫专门抓 `gunzipSync` ✗
//   打包（gzip）保持同步：它在发布路径上、且我们要返回 Buffer 给上传接口 ⇒
//   改成异步会污染一大片调用方，而发布是**低频人工操作** ⇒ 不值得（如实记在这里，不是忘了）。
import { gzipSync, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

const BLOCK = 512;

/** 取头里的字符串字段（NUL 结尾）。 */
function readStr(buf, offset, length) {
	const slice = buf.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** 取头里的八进制数字字段（允许前后空格/NUL；非八进制 ⇒ NaN）。 */
function readOctal(buf, offset, length) {
	const text = readStr(buf, offset, length).replace(/\0/g, ' ').trim();
	if (!text) { return 0; }
	if (!/^[0-7]+$/.test(text)) { return NaN; }
	return parseInt(text, 8);
}

/** 路径安全检查：不许绝对路径 / 盘符 / `..` 段 / NUL。返回规范化的 `/` 分隔相对路径。 */
export function sanitizeEntryPath(raw) {
	const normalized = String(raw ?? '').replace(/\\/g, '/');
	if (!normalized) { throw new Error('tar 条目路径为空'); }
	if (normalized.includes('\0')) { throw new Error(`tar 条目路径含 NUL：${raw}`); }
	if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`tar 条目是绝对路径（拒绝）：${raw}`);
	}
	const segments = normalized.split('/').filter(s => s !== '' && s !== '.');
	if (segments.some(s => s === '..')) {
		throw new Error(`tar 条目含路径穿越段（拒绝）：${raw}`);
	}
	if (segments.length === 0) { throw new Error(`tar 条目路径非法：${raw}`); }
	return segments.join('/');
}

/**
 * 解包一个 tar 缓冲区（**不落盘**：返回条目列表，由调用方决定写哪、写不写）。
 *
 * 把"解析"与"落盘"分开是为了**可单测**（不碰文件系统），也让安装逻辑能先校验再写 ✓。
 *
 * @param {Buffer} tarBuf
 * @returns {{ files: { path: string, mode: number, data: Buffer }[], dirs: string[], links: { path: string, target: string }[], skipped: string[] }}
 */
export function listTarEntries(tarBuf) {
	const files = [];
	const dirs = [];
	const links = [];
	const skipped = [];
	let offset = 0;
	let longName = '';
	while (offset + BLOCK <= tarBuf.length) {
		const header = tarBuf.subarray(offset, offset + BLOCK);
		// 结束标记：全零块（读两个，缺一个也当结束 ✓）
		if (header.every(byte => byte === 0)) { break; }
		offset += BLOCK;

		const size = readOctal(header, 124, 12);
		if (!Number.isFinite(size) || size < 0) {
			throw new Error(`tar 头里的 size 不是合法八进制（偏移 ${offset - BLOCK}）`);
		}
		const typeflag = String.fromCharCode(header[156] || 0x30);
		const name = readStr(header, 0, 100);
		const prefix = readStr(header, 345, 155);
		const fullName = prefix ? `${prefix}/${name}` : name;
		const dataSize = Math.ceil(size / BLOCK) * BLOCK;
		const data = tarBuf.subarray(offset, offset + size);
		offset += dataSize;

		// pax / GNU 长名：跳过（我们的包用不到；真用了名字会截断 ⇒ 下面 sanitize 会报错 ✓）
		if (typeflag === 'x' || typeflag === 'g') { skipped.push(`pax(${fullName})`); continue; }
		if (typeflag === 'L' || typeflag === 'K') {
			longName = data.toString('utf8').replace(/\0+$/, '');
			skipped.push(`gnu-long-name(${longName})`);
			continue;
		}

		const entryPath = longName || fullName;
		longName = '';
		if (!entryPath) { continue; }

		if (typeflag === '5') {
			dirs.push(sanitizeEntryPath(entryPath));
			continue;
		}
		if (typeflag === '2' || typeflag === '1') {
			// 符号链接 / 硬链接：商城包不该有 ⇒ 跳过并如实记（不落盘 ✓）
			links.push({ path: entryPath, target: readStr(header, 157, 100) });
			skipped.push(`link(${entryPath})`);
			continue;
		}
		if (typeflag !== '0' && typeflag !== '\0') {
			skipped.push(`type-${typeflag}(${entryPath})`);
			continue;
		}
		const mode = readOctal(header, 100, 8);
		files.push({ path: sanitizeEntryPath(entryPath), mode: Number.isFinite(mode) ? mode : 0o644, data: Buffer.from(data) });
	}
	return { files, dirs, links, skipped };
}

/**
 * 解包 `.tar.gz`（gunzip + listTarEntries）。
 *
 * ⚠ **async**：解压走 `promisify(gunzip)`（异步），不用 `gunzipSync` ——
 *   同步解压会把 Host 主线程卡死（几 MB 的包就是几百毫秒的界面冻结）✗
 */
export async function listTarGzEntries(gzBuf) {
	return listTarEntries(await gunzipAsync(gzBuf));
}

/** 写一个 512 字节头。 */
function writeHeader({ path: entryPath, size, mode = 0o644, typeflag = '0' }) {
	const header = Buffer.alloc(BLOCK, 0);
	let name = entryPath;
	let prefix = '';
	if (Buffer.byteLength(name) > 100) {
		// 尝试 prefix 拆分（ustar）：取末尾 ≤100 字节做 name，前面做 prefix
		const parts = entryPath.split('/');
		while (parts.length > 1 && Buffer.byteLength(parts.slice(-1)[0]) <= 100 && Buffer.byteLength(parts.join('/')) > 100) {
			prefix = parts.slice(0, -1).join('/');
			name = parts.slice(-1)[0];
			if (Buffer.byteLength(prefix) <= 155) { break; }
			parts.pop();
		}
		if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
			throw new Error(`tar 打包：路径太长（ustar 上限 name≤100 / prefix≤155）：${entryPath}`);
		}
	}
	header.write(name, 0, 100, 'utf8');
	header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
	header.write('0000000\0', 108, 8, 'ascii'); // uid
	header.write('0000000\0', 116, 8, 'ascii'); // gid
	header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
	header.write('00000000000\0', 136, 12, 'ascii'); // mtime = 0（可复现的包 ✓）
	header.write('        ', 148, 8, 'ascii'); // chksum 先填空格
	header.write(typeflag, 156, 1, 'ascii');
	header.write('ustar\0', 257, 6, 'ascii');
	header.write('00', 263, 2, 'ascii');
	if (prefix) { header.write(prefix, 345, 155, 'utf8'); }
	// checksum = 所有字节和无符号求和
	let sum = 0;
	for (const byte of header) { sum += byte; }
	header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
	return header;
}

/**
 * 打包成 `.tar.gz`（**确定性**：mtime 固定 0、按路径排序 ⇒ 同样的内容产出同样的字节，
 * 便于"发布前比对"和守卫断言 ✓）。
 *
 * @param {{ path: string, data: Buffer | string, mode?: number }[]} entries
 * @returns {Buffer}
 */
export function packTarGz(entries) {
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
	const blocks = [];
	for (const entry of sorted) {
		const path = sanitizeEntryPath(entry.path);
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
		blocks.push(writeHeader({ path, size: data.length, mode: entry.mode ?? 0o644 }));
		blocks.push(data);
		const pad = Math.ceil(data.length / BLOCK) * BLOCK - data.length;
		if (pad > 0) { blocks.push(Buffer.alloc(pad, 0)); }
	}
	// 两个全零块收尾
	blocks.push(Buffer.alloc(BLOCK * 2, 0));
	return gzipSync(Buffer.concat(blocks));
}

/** 便捷：把"路径 → 内容"的映射打包（发布用）。 */
export function packTarGzFromMap(fileMap) {
	return packTarGz(Object.entries(fileMap).map(([path, data]) => ({ path, data })));
}
