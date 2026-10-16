/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 沙箱的**启动期探针**（I/O 半边；判据在 `common/dshSandboxCompat.ts`，那里有完整缘由）。
 *
 * ## ⚠ 必须在**真实目标路径**上探（2026-10-13 首版踩坑，实测）
 *
 * 首版把探针建在 `os.tmpdir()`（`C:\Users\…\Temp`）上 ⇒ 本机返回 **`ok=true`**，而 dsh 实际要写的是
 * **工作区所在的 `G:\SarosWorkspace\…`**，那里写标签一律 `Access is denied` ✗✗（两个卷都是 NTFS、
 * 都是固定盘，实测 `C:\…\Temp` 可以、`G:\SarosWorkspace\…` 不行 ⇒ 差异在**路径**，不在文件系统类型）。
 * ⇒ 探针给出的"一切正常"是**假阳性**，"启动时不降级"照旧 ✗。教训：**探针必须能被真实故障打红**
 * ——不能拿一个"环境差不多"的地方代替目标路径（同 `PAGE_ALIVE_PROBE` 那条旧账 ✓）。
 * 所以签名收**工作区根**（= dsh `sandbox-policy` 行里 `workspaceRoot` 指的那个目录 ✓），
 * 在它下面建临时目录探、探完立刻删 ✓。
 *
 * 缓存：**按路径**缓存（同一个工作区重复启动 Host 不重复起进程 ✓；换了工作区就重探 ✓）。
 */

import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from '../../../../base/common/path.js';
import { LABEL_PROBE_DIR_PREFIX, labelProbeArgs, labelProbeVerdict } from '../common/dshSandboxCompat.js';

/** 探针超时：`icacls` 正常在几十毫秒内返回；卡住就按"不可用"处理（宁可降级）。 */
const PROBE_TIMEOUT_MS = 5_000;

export interface IDshSandboxProbeResult {
	/** `true` = 目标路径允许写完整性标签 ⇒ dsh 默认的 `workspace-write`（windows-acl）可用 ✓。 */
	readonly ok: boolean;
	/** 判据说明（写进日志；失败时含 `icacls` 的 stderr，便于事后审计）。 */
	readonly detail: string;
}

/** 按**路径**缓存（键是小写化的绝对路径，Windows 大小写不敏感 ✓）。 */
const cache = new Map<string, Promise<IDshSandboxProbeResult>>();

/**
 * 解码 Windows 控制台工具的输出（`icacls` 等按 ANSI 代码页输出，中文系统上是 GBK）。
 *
 * 先按 GBK 解；解出替换字符（说明系统代码页不是 GBK）就退回 UTF-8 ✓。
 * 只为让日志里那句失败原因**可读**（乱码的 `�ܾ����ʡ�` 等于没写 ✗）。
 */
function decodeConsoleText(raw: unknown): string {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
	try {
		const gbk = new TextDecoder('gbk').decode(buf);
		return gbk.includes('\uFFFD') ? buf.toString('utf8') : gbk;
	} catch {
		return buf.toString('utf8');
	}
}

/**
 * 在 `workspaceRoot` 下探一次（同路径只真跑一次）。永不 reject —— 探针失败按"不可用"处理 ✓。
 *
 * @param workspaceRoot dsh `sandbox-policy` 行里的那个根（探针就在它下面建临时目录）。
 */
export function probeLabelWriteOnce(workspaceRoot: string): Promise<IDshSandboxProbeResult> {
	const key = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
	let hit = cache.get(key);
	if (!hit) {
		hit = run(workspaceRoot);
		cache.set(key, hit);
	}
	return hit;
}

/** 清空缓存（单测/显式重探用；生产路径只在换了工作区时才需要重探）。 */
export function forgetLabelWriteProbe(): void {
	cache.clear();
}

async function run(workspaceRoot: string): Promise<IDshSandboxProbeResult> {
	if (process.platform !== 'win32') {
		// 非 Windows 走 `dsh-sandbox-local` 的本地档（`win32: ["windows-acl"]` 只是 win32 那一档）⇒ 与标签无关 ✓。
		return { ok: true, detail: 'non-win32：dsh 不走 windows-acl 档，无需探针' };
	}
	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(workspaceRoot, LABEL_PROBE_DIR_PREFIX));
		const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
			// `encoding: 'buffer'`：`icacls` 在中文 Windows 上按 ANSI 代码页（GBK）输出，
			// 默认按 UTF-8 解码会得到一串 `�ܾ����ʡ�`（实测）⇒ 自己解，日志才是人读的 ✓。
			execFile('icacls', labelProbeArgs(dir as string), { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'buffer' }, (err, _stdout, stderr) => {
				const raw = (err as { code?: unknown } | null)?.code;
				const code = err ? (typeof raw === 'number' ? raw : 1) : 0;
				resolve({ code, stderr: decodeConsoleText(stderr) });
			});
		});
		const verdict = labelProbeVerdict(result.code, result.stderr);
		return verdict.ok ? verdict : { ok: false, detail: `${verdict.detail}（目标路径：${workspaceRoot}）` };
	} catch (e) {
		// 探针自己起不来（目标目录不存在/不可写、icacls 缺失）⇒ 也按"不可用"处理（见判据注释里的不对称代价）✓。
		return { ok: false, detail: `探针本身失败（目标路径：${workspaceRoot}）：${String((e as Error)?.message ?? e)}` };
	} finally {
		if (dir) {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
