// @vssaros/dsh-agents — 最小 ZIP 读写（2026-10-19，供 agent 打包/导入用）。
//
// 为什么自己写而不引第三方：插件按 `file:` 装进 dsh profile，**不能在安装期再拉 registry 依赖**
// （离线/内网会装不上，整个插件消失 ✗）。dsh 运行时里虽然有 fflate，但它不在我们的解析路径上。
// 需要的能力只有两件：① 写一个小包（几十 KB 文本）② 读回来；`node:zlib` 的 deflateRaw/inflateRaw
// 刚好够 ⇒ 本文件 ~180 行，零依赖、零安装风险。
//
// 支持范围（刻意收窄，够用且好测）：
//   · 写入：method 0（store）/ 8（deflate），UTF-8 文件名（置通用位 11），无 zip64、无加密、无目录项；
//   · 读取：method 0/8，容忍额外的 extra/comment 字段，**不支持** zip64/分卷/加密（遇到就如实报错）。
//   · 路径安全**不在这里做**（不猜业务），由 `pack.js` 按白名单校验（`..`/绝对路径一律拒）。

import { deflateRawSync, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

/**
 * 解压走**异步**（libuv 线程池）：dsh Host 是单线程，同步解压大文件会把同进程的页面/工具/
 * 反向桥一起卡住（仓里守卫 `dshPluginPackages.test.ts` 的"插件不许用同步解压"钉的就是这条）。
 * 写入方向的 `deflateRawSync` 保留：只压几十 KB 的文本包，代价可忽略。
 */
const inflateRawAsync = promisify(inflateRaw);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;

/** CRC32（ZIP 用的就是这张表）。 */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		}
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** JS Date → DOS 时间/日期（zip 只支持 1980~2107，超出就夹到 1980-01-01）。 */
function dosDateTime(date) {
	const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
	const year = d.getFullYear();
	if (year < 1980) {
		return { time: 0, date: (1 << 5) | 1 };
	}
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
	const dt = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date: dt };
}

/**
 * 打包。
 * @param entries `Array<{ name: string, data: string|Buffer }>`
 * @param options `{ date?: Date, level?: number }`
 * @returns Buffer（可直接写盘 / 回给 HTTP）
 */
export function zipWrite(entries, options = {}) {
	const level = Number.isInteger(options.level) ? options.level : 9;
	const { time, date } = dosDateTime(options.date);
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const name = String(entry.name ?? '');
		if (!name) {
			throw new Error('zipWrite: entry name is required');
		}
		const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
		const nameBuf = Buffer.from(name, 'utf8');
		const deflated = deflateRawSync(raw, { level });
		const useDeflate = deflated.length < raw.length;   // 压不小就存原文（小文本常见）
		const payload = useDeflate ? deflated : raw;
		const method = useDeflate ? 8 : 0;
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(SIG_LOCAL, 0);
		local.writeUInt16LE(20, 4);              // version needed
		local.writeUInt16LE(FLAG_UTF8, 6);       // flags
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);              // extra len
		locals.push(local, nameBuf, payload);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(SIG_CENTRAL, 0);
		central.writeUInt16LE(20, 4);            // version made by
		central.writeUInt16LE(20, 6);            // version needed
		central.writeUInt16LE(FLAG_UTF8, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);            // extra
		central.writeUInt16LE(0, 32);            // comment
		central.writeUInt16LE(0, 34);            // disk start
		central.writeUInt16LE(0, 36);            // internal attrs
		central.writeUInt32LE(0, 38);            // external attrs
		central.writeUInt32LE(offset, 42);       // local header offset
		centrals.push(central, nameBuf);

		offset += local.length + nameBuf.length + payload.length;
	}
	const centralBuf = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(SIG_EOCD, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...locals, centralBuf, end]);
}

function findEocd(buf) {
	// EOCD 在尾部（最多 22 + 65535 字节注释）；从后往前扫签名
	const min = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === SIG_EOCD) {
			return i;
		}
	}
	return -1;
}

/**
 * 解包。
 * @param buf zip Buffer
 * @returns `Array<{ name: string, data: Buffer }>`
 */
export async function zipRead(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 22) {
		throw new Error('不是有效的 zip（文件太短）');
	}
	const eocd = findEocd(buf);
	if (eocd < 0) {
		throw new Error('不是有效的 zip（找不到目录尾）');
	}
	const total = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (total === 0xffff || cdOffset === 0xffffffff) {
		throw new Error('不支持 zip64（包太大）');
	}
	const out = [];
	let p = cdOffset;
	for (let i = 0; i < total; i++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
			throw new Error('zip 目录损坏（central directory 不连续）');
		}
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const rawSize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
		p += 46 + nameLen + extraLen + commentLen;
		if (flags & 0x0001) {
			throw new Error(`不支持加密条目：${name}`);
		}
		if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
			throw new Error(`zip 条目损坏：${name}`);
		}
		const localNameLen = buf.readUInt16LE(localOffset + 26);
		const localExtraLen = buf.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		const payload = buf.slice(dataStart, dataStart + compSize);
		if (payload.length !== compSize) {
			throw new Error(`zip 条目被截断：${name}`);
		}
		let data;
		if (method === 0) {
			data = payload;
		} else if (method === 8) {
			data = await inflateRawAsync(payload);
		} else {
			throw new Error(`不支持的压缩方式 ${method}（${name}）`);
		}
		if (rawSize !== 0 && data.length !== rawSize) {
			throw new Error(`zip 条目大小不符：${name}（声明 ${rawSize}，实际 ${data.length}）`);
		}
		out.push({ name, data });
	}
	return out;
}
