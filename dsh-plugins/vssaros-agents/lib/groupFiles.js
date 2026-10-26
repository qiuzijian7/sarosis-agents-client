/**
 * 群聊**附件**（2026-10-26，用户要求「完善群聊中附件功能」）。
 *
 * 之前群消息只有 `text`，没有任何附件能力（全仓搜不到 upload/attachment/multipart）。
 * 这里补最小闭环：
 *   上传 `POST /x/agents/api/group-file?group=<gid>&name=<urlencoded>`  body = **原始字节**
 *   读取 `GET  /x/agents/api/group-file?id=<fileId>`                  返回字节 + content-type
 *
 * 为什么用「原始字节 + query 传文件名」而不是 multipart / base64：
 *   · multipart 要自己写解析器（没有第三方依赖可用），出错面大；
 *   · base64 塞 JSON 会让内存翻 ~1.33 倍、且 20MB 文件就是一个巨型 JSON 字符串；
 *   · octet-stream 直接 `req.pipe`/读 buffer 就落盘，最简单也最省。
 *
 * 存储（都在数据根下，跟 `agent-groups.json` 同级）：
 *   `<dataRoot>/group-files/<fileId>.blob`  文件本体
 *   `<dataRoot>/group-files/<fileId>.json`  元数据 { id, groupId, name, size, mime, at }
 *
 * ⚠ 安全边界：
 *   · `fileId` **必须是 uuid**（读写前都校验）—— 否则 `id=../../x` 就能穿出去；
 *   · 原始文件名只用于**展示**，绝不参与路径（落盘名就是 uuid）；
 *   · 单文件上限 20MB（超过 413，前端会看到明确原因）。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRootOf } from './store.js';

/** 单文件上限：20MB。超过直接 413（不做分片，群聊附件用不着）。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message, extra = {}) {
	return Object.assign(new Error(message), { httpStatus: status, ...extra });
}

function filesRootOf(config) {
	return join(dataRootOf(config), 'group-files');
}

/** 展示用文件名：去掉路径分隔符与控制字符，限长 120（不参与任何路径拼接）。 */
export function safeDisplayName(raw, fallback = '未命名文件') {
	const s = String(raw ?? '')
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return (s || fallback).slice(0, 120);
}

const MIME_BY_EXT = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
	webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
	pdf: 'application/pdf', json: 'application/json', txt: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
	zip: 'application/zip', log: 'text/plain; charset=utf-8',
	mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
};

/** 按扩展名猜 mime（前端给了就用前端的，猜不到给 octet-stream）。 */
export function guessMime(name) {
	const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
	if (!m) { return 'application/octet-stream'; }
	return MIME_BY_EXT[m[1].toLowerCase()] || 'application/octet-stream';
}

/** 是不是图片（前端据此决定显示缩略图还是文件卡片）。 */
export function isImageMime(mime) {
	return /^image\//i.test(String(mime || ''));
}

/**
 * 存一个附件。
 * @param {object} config
 * @param {string} groupId 所属群（只是归属标注；不做成员校验 —— 入口已经过群存在性检查）
 * @param {string} rawName 原始文件名（仅展示）
 * @param {Buffer} buf     文件字节
 * @param {string} [mime]  前端给的 mime（不合法则按扩展名猜）
 * @returns {Promise<{id,name,size,mime,at,groupId}>} 可直接塞进消息的 `files[]`
 */
export async function saveGroupFile(config, groupId, rawName, buf, mime) {
	if (!buf || !buf.length) { throw httpError(400, '文件是空的（0 字节）'); }
	if (buf.length > MAX_FILE_BYTES) {
		throw httpError(413, `文件太大：${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`);
	}
	const name = safeDisplayName(rawName);
	const id = randomUUID();
	const dir = filesRootOf(config);
	await mkdir(dir, { recursive: true });
	const meta = {
		id,
		groupId: String(groupId ?? ''),
		name,
		size: buf.length,
		mime: (typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(mime)) ? mime : guessMime(name),
		at: Date.now(),
	};
	// 先落 blob 再落 meta：顺序反了的话，读侧可能看到 meta 却没有 blob
	await writeFile(join(dir, id + '.blob'), buf);
	await writeFile(join(dir, id + '.json'), JSON.stringify(meta, null, 2), 'utf8');
	return meta;
}

/**
 * 读一个附件（元数据 + 字节）。id 不是 uuid ⇒ 400（防路径穿越）。
 * @returns {Promise<{meta:object, buf:Buffer}>}
 */
export async function readGroupFile(config, id) {
	const fid = String(id ?? '').trim();
	if (!UUID_RE.test(fid)) { throw httpError(400, `附件 id 不合法：${fid || '(空)'}`); }
	const dir = filesRootOf(config);
	let meta;
	try {
		meta = JSON.parse(await readFile(join(dir, fid + '.json'), 'utf8'));
	} catch {
		throw httpError(404, '这个附件不存在（或者元数据坏了）');
	}
	let buf;
	try {
		buf = await readFile(join(dir, fid + '.blob'));
	} catch {
		throw httpError(404, '附件本体不存在（元数据还在）');
	}
	return { meta, buf };
}

/**
 * 校验消息里带的 `files[]`：**只留 id/name/size/mime**，并把 id 过一遍 uuid 校验。
 *
 * 为什么不信前端整包：
 *   · 前端可能带上 `path` 之类的字段 ⇒ 落进 JSON 后会成为"看起来像真文件"的假数据；
 *   · id 不合法的话，点击时才会 404/400 ⇒ 发送时就该拦掉。
 */
export function normalizeFileRefs(input) {
	if (!Array.isArray(input)) { return []; }
	const out = [];
	for (const f of input) {
		if (!f || typeof f !== 'object') { continue; }
		const id = String(f.id ?? '').trim();
		if (!UUID_RE.test(id)) { continue; }
		out.push({
			id,
			name: safeDisplayName(f.name),
			size: Number.isFinite(Number(f.size)) ? Number(f.size) : 0,
			mime: String(f.mime ?? '') || guessMime(f.name),
		});
		if (out.length >= 10) { break; }   // 单条消息最多 10 个附件，防滥用
	}
	return out;
}
