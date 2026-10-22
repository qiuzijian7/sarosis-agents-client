/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 商城「外部发布源」的**下载与校验**（★ 2026-10-22，主进程侧）。
 * ============================================================
 *
 * ## 为什么在主进程
 *  - **sha256**：renderer 侧没有通用的 sha256 实现（`vs/base/common` 只有对象 hash）⇒ 算不了 ⇒
 *    主进程有 Node `createHash` ✓。
 *  - **下载**：主进程有 Node `fetch` ⇒ 不依赖扩展宿主命令（`marketplace.downloadToFile` 由**外部**
 *    内置扩展注册、不在本仓 ⇒ 商城链路不该把它当必需依赖 ✗）。
 *
 * ## 为什么走 `file:` tarball 而不是解包成目录
 *  `dsh plugin add file:/abs/path.tgz` 直接接受 tarball ✓（pnpm 语义）⇒ **不用解包**（省一份
 * tar 依赖，也省一次"解包出来的目录结构不对"的风险）⇒ 临时文件装完即删 ✓。
 *
 * ## 绝不做的事
 *  - **不校验就不装**：sha256 不匹配 ⇒ 删文件 + 如实报错（半个包进 profile 是最坏结果）✗；
 *  - **不自动换来源**：登记的 url 就是 url（换源 = 装到与商城登记不同的东西）✗；
 *  - **不装非 https**：http 会被中间人替换内容（sha256 能兜住，但 https 是底线）✗。
 */

/** 下载体积上限（默认 8 MiB，与 dsh 市场协议 v2 的 Release 包上限同档 ✓）。 */
export const MARKETPLACE_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** 一次下载的最长耗时（默认 2 分钟；慢网下宁可超时也不要挂死主进程）✓。 */
export const MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** 下载 + 校验的结果。 */
export interface IMarketplaceDownloadResult {
	/** 下载并校验通过（`filePath` 有效）✓ */
	readonly ok: boolean;
	/** 临时文件路径（`ok=true` 时有效；调用方**装完必须删**）✓ */
	readonly filePath?: string;
	/** 实际字节数（与登记的 `bytes` 不符时如实报出来）✓ */
	readonly bytes?: number;
	/** 算出来的 sha256（`ok=true` 时；便于与登记值比对留痕）✓ */
	readonly sha256?: string;
	readonly error?: string;
}

/** 校验一个 64 位十六进制 sha256 串的形状。 */
export function isSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim());
}

/** 只允许 https（本地开发用的 http 也不放行 ⇒ 底线一致）✓。 */
export function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== 'string') { return false; }
	try {
		return new URL(value.trim()).protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * 下载一个包并校验 sha256。
 *
 * @param url https 资源地址（GitHub Release 附件）
 * @param expectedSha256 登记的 64 位 sha256（**必填** ⇒ 没有就不下载、不装）✓
 * @param expectedBytes 登记的字节数（可选；给了就核对，不符即失败）✓
 * @param tmpDir 临时目录（主进程给；一般是 `<用户数据>/tmp/marketplace`）✓
 */
export async function downloadAndVerify(
	url: string,
	expectedSha256: string,
	expectedBytes: number | undefined,
	tmpDir: string,
): Promise<IMarketplaceDownloadResult> {
	if (!isHttpsUrl(url)) {
		return { ok: false, error: `下载地址不是 https（拒绝）：${String(url).slice(0, 160)}` };
	}
	if (!isSha256Hex(expectedSha256)) {
		return { ok: false, error: '登记的 sha256 缺失或格式不对（必须是 64 位十六进制）—— 没有校验值就不装' };
	}

	const { mkdir, writeFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { createHash } = await import('node:crypto');

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MARKETPLACE_DOWNLOAD_TIMEOUT_MS);
	try {
		await mkdir(tmpDir, { recursive: true });
		const res = await fetch(url.trim(), { signal: controller.signal, redirect: 'follow' });
		if (!res.ok) {
			return { ok: false, error: `下载失败：HTTP ${res.status} ${res.statusText}` };
		}
		const declared = Number(res.headers.get('content-length') ?? '0');
		const limit = MARKETPLACE_MAX_DOWNLOAD_BYTES;
		if (declared > limit) {
			return { ok: false, error: `包太大：${declared} 字节 > 上限 ${limit} 字节` };
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.byteLength > limit) {
			return { ok: false, error: `包太大：${buf.byteLength} 字节 > 上限 ${limit} 字节` };
		}
		if (expectedBytes && buf.byteLength !== expectedBytes) {
			return { ok: false, error: `字节数对不上：登记 ${expectedBytes}，实际 ${buf.byteLength}` };
		}
		const actual = createHash('sha256').update(buf).digest('hex');
		if (actual.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
			return { ok: false, error: `sha256 不匹配：登记 ${expectedSha256.trim().slice(0, 16)}…，实际 ${actual.slice(0, 16)}…（已拒绝安装）`, bytes: buf.byteLength, sha256: actual };
		}
		// 文件名只留安全字符（包名可能带 @ 与 /）✓
		const safe = url.trim().split('/').pop()?.replace(/[^A-Za-z0-9._-]/g, '_') || 'package.tgz';
		const filePath = join(tmpDir, safe);
		await writeFile(filePath, buf);
		return { ok: true, filePath, bytes: buf.byteLength, sha256: actual };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: /aborted/i.test(msg) ? `下载超时（${MARKETPLACE_DOWNLOAD_TIMEOUT_MS / 1000}s）` : `下载出错：${msg}` };
	} finally {
		clearTimeout(timer);
	}
}

/** 删掉临时文件（装完/失败都要删 ⇒ 不留垃圾）✓。 */
export async function removeDownloaded(filePath: string | undefined): Promise<void> {
	if (!filePath) { return; }
	try {
		const { rm } = await import('node:fs/promises');
		await rm(filePath, { force: true });
	} catch {
		/* 临时文件删不掉不影响安装结果 */
	}
}
