/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Host 监听端口的**偏好记录**（`$DSH_HOME/host-port.json`）。
 *
 * ## 为什么必须有它（2026-10-14 实测根因）
 *
 * dsh 会把 `http://127.0.0.1:<port>` 写进**每一条 system 提示**：
 *
 * > You are interacting with the user through the DeepSeek Harness Web GUI at
 * > http://127.0.0.1:4953. When the user refers to "this page"…
 *
 * 而 `--port 0` 让 OS 每次分配不同端口（见 `dshCli.buildHostArgs` 的历史注释）
 * ⇒ **每次 Host 重启，system 提示的字节都不同** ⇒ provider 侧的 **prompt 前缀缓存
 * 整段失效**（缓存命中要求前缀逐字节一致）。
 *
 * 真机实证（`sess-mu21tmwy-ygx8dy--vssaros-standard`，hy4-preview-ioa）：
 *   · 6 次模型请求的 system 提示里 **302 行有 299 行逐字相同**，唯一差异是那一行的端口
 *     （`127.0.0.1:4953` → `127.0.0.1:3075`）；
 *   · 对应地每次请求 `cacheReadTokens` 恒为 256（≈ 两条 system 的公共开头），
 *     累计命中率 **6.4%**，而同会话内偶发的"端口未变"调用能到 98.6%。
 *
 * ## 归谁管
 *
 * 端口**不是** dsh 的语义要求（它接受任何可用端口），而是**启动器的选择** ⇒
 * 修在选择侧：记住上次真正用到的端口，下次优先复用。**这不是让端口恒定**
 * （多实例/占用冲突时仍可能变），而是**消除"每次重启都变"这一必然漂移**。
 *
 * 本文件是**纯逻辑** ✓（不碰文件、不探测端口）⇒ 解析与序列化可被单测直接钉住 ✓；
 * 读写与端口探测在 `electron-main/dshHostSupervisor.ts`。
 */

/** 偏好记录的文件名（与 dsh 自己的 `host.json` 同目录、同层）。 */
export const HOST_PORT_PREFERENCE_FILE = 'host-port.json';

/** 一次端口偏好记录。 */
export interface IHostPortPreference {
	readonly format: 1;
	/** 上次 Host 真正监听的端口（1..65535）。 */
	readonly port: number;
	readonly updatedAt: number;
}

/** 端口合法区间（TCP 用户端口；0 是"由 OS 分配"，不作为偏好值保存）。 */
function isValidPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

/**
 * 解析偏好文件文本。任何异常（空、坏 JSON、坏端口）**一律 `undefined`**
 * —— 偏好只是优化，缺了就当没有（回落 `--port 0`），绝不因此让 Host 起不来。
 */
export function parseHostPortPreference(text: string | undefined): number | undefined {
	if (!text) { return undefined; }
	try {
		const parsed = JSON.parse(text) as Partial<IHostPortPreference> | undefined;
		const port = parsed?.port;
		return isValidPort(port) ? port : undefined;
	} catch {
		return undefined;
	}
}

/** 序列化偏好记录（写入端与解析端**同一口径**：只存格式、端口、时间戳）。 */
export function serializeHostPortPreference(port: number, updatedAt: number): string {
	if (!isValidPort(port)) {
		throw new Error(`serializeHostPortPreference: invalid port ${String(port)}`);
	}
	const record: IHostPortPreference = { format: 1, port, updatedAt };
	return JSON.stringify(record);
}

/**
 * 从租约/origin 的 `http://127.0.0.1:<port>` 取端口。
 *
 * 用它而不是解析启动输出的另一种原因：`connection.origin` 就是随后写进 `host.json`
 * 的那一份 ⇒ 与"模型看到的 URL"**同源**，不存在两处各解析一遍而漂移的问题。
 */
export function portOfOrigin(origin: string | undefined): number | undefined {
	if (!origin) { return undefined; }
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
	const port = Number(url.port);
	return isValidPort(port) ? port : undefined;
}
