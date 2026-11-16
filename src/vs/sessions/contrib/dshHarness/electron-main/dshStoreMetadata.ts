/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pnpm **虚拟店元数据**（`node_modules/.modules.yaml`）的两件事，都是纯函数便于单测：
 *
 * ① `normalizeExistingPath()`：把路径写法归一到 **长名**（Windows 8.3 短名 → 长名）；
 * ② `repairStoreMetadataContent()`：在不碰 store 内容的前提下，把记录里的 `virtualStoreDir`
 *    （必要时还有 `storeDir`）改成**本次 profile 实际使用**的值。
 *
 * ## 为什么要归一（真机实测，2026-10-11）
 *
 * pnpm 判断"虚拟店位置是否一致"是**字符串比较**。而同一目录在 Windows 上会有两种写法：
 *
 * ```
 *   C:\Users\QIUZIJ~1\AppData\Local\Temp\vssaros-dsh-gate-x\dsh-home\profiles\vssaros\node_modules\.pnpm   ← 8.3 短名
 *   C:\Users\qiuzijian\AppData\Local\Temp\vssaros-dsh-gate-x\dsh-home\profiles\vssaros\node_modules\.pnpm   ← 长名
 * ```
 *
 * `tmpdir()` / `TEMP` 在 Windows 上给的就是**短名**；而 pnpm 内部解析项目路径时拿到的是**长名**
 * ⇒ 记录值与请求值不同写法 ⇒ `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` ⇒ 伴生包（含**必装**的
 * `@deepseek-ai/dsh-web-app`，它提供 `webStartup`）装不上 ⇒ 需要这些服务的插件全部 pending
 * ⇒ `StartupError: … required plugins did not activate` ⇒ **Host 退出 code 1**。
 *
 * ★★ 关键坑：**`fs.realpathSync` 不展开 8.3 短名**（照原样返回短名），只有 `fs.realpathSync.native`
 *    才返回长名。本机实测（同一目录）：
 *
 * ```
 *   realpathSync(C:\Users\QIUZIJ~1\AppData\Local\Temp\probe-x)        = C:\Users\QIUZIJ~1\AppData\Local\Temp\probe-x
 *   realpathSync.native(C:\Users\QIUZIJ~1\AppData\Local\Temp\probe-x) = C:\Users\qiuzijian\AppData\Local\Temp\probe-x
 * ```
 *
 *    升级门套件里第一次只把测试改成 `realpathSync`，4 条红**一条没少**（日志里 `virtualStoreDir` 仍是短名）；
 *    换成 `.native` 才全绿。所以这里一律优先 `.native`。
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 归一用的 realpath（注入便于单测；默认 `fs.realpathSync.native`，缺失时退回普通版本）。 */
export type RealpathFn = (path: string) => string;

/** 平台默认的 long-form realpath：优先原生实现（它会展开 8.3 短名），退回普通版本。 */
export function longFormRealpath(): RealpathFn {
	// `realpathSync.native` 在 Node 9.2+ 都在，但类型上可能是可选字段。
	const native = (realpathSync as { native?: RealpathFn }).native;
	return typeof native === 'function' ? native.bind(realpathSync) : realpathSync;
}

/**
 * 把路径归一成**长名**；路径（或它的某段）还不存在时，归一**最长的已存在前缀**再拼回剩余部分。
 *
 * 为什么允许"不存在"：`DSH_HOME` 在首启时往往还没建（是本函数的下游去 mkdir），而**父目录**
 * （`userData` / `TEMP`）已经存在——短名只出现在已存在的那几段上，所以归一前缀就够了。
 * 任何一步失败都原样返回入参：归一只是"更好"，不该让启动失败。
 */
export function normalizeExistingPath(path: string, realpath: RealpathFn = longFormRealpath()): string {
	if (!path) {
		return path;
	}
	let current = resolve(path);
	const tail: string[] = [];
	for (;;) {
		if (existsSync(current)) {
			try {
				const real = realpath(current);
				return tail.length ? join(real, ...tail.reverse()) : real;
			} catch {
				return path;
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			return path; // 走到根都没找到已存在的段（极端情况：盘符不存在）
		}
		tail.push(current.slice(parent.length + 1));
		current = parent;
	}
}

export interface IStoreMetadataRepair {
	/** 修好后的文件内容（`changed === false` 时与入参相同）。 */
	readonly content: string;
	/** 是否真的需要写回（避免无谓改动与日志噪音）。 */
	readonly changed: boolean;
	readonly virtualStoreDir: string;
	readonly storeDir?: string;
}

/**
 * ★★ 2026-11-12（真机：升到 dsh 0.2.2-rc.2 后 `startSession: 控制桥不可用`）：
 *   `.modules.yaml` **不止 YAML 一种写法**。pnpm 11 写的是 **JSON**：
 *
 *       "storeDir": "G:\\.pnpm-store\\v11",
 *       "virtualStoreDir": "G:\\...\\profile-seed\\...\\node_modules\\.pnpm",
 *
 *   旧代码的 `/^storeDir:.*$/m` 只认 `storeDir: ...`，在 JSON 上**一条都匹配不到** ⇒
 *   `changed=false` 直接 return ⇒ 种子里的 G 盘 storeDir 原样留着 ⇒ 每次 `pnpm add` 都
 *   `ERR_PNPM_UNEXPECTED_STORE`（36 次）⇒ 37 个伴生插件装不上，其中 `vssaros-dsh-bridge`
 *   缺失 ⇒ Host `bridge: fallback` ⇒ 桌面窗口建会话三次全失败。
 *
 * ⇒ 读写都走下面这两个「格式无关」的函数，保持原有格式（YAML 仍是 YAML、JSON 仍是 JSON）。
 */

/** 读 `.modules.yaml` 里某个键的值；JSON（`"key": "value"`）与 YAML（`key: value`）都认。 */
export function readStoreMetadataValue(content: string, key: string): string | undefined {
	const json = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(content);
	if (json) {
		try { return JSON.parse(`"${json[1]}"`) as string; } catch { return json[1]; }
	}
	const yaml = new RegExp(`^\\s*${key}:[ \\t]*(.+)$`, 'm').exec(content);
	return yaml?.[1]?.trim();
}

/** 替换某个键的值并保留文件格式/缩进/尾逗号；键不存在时原样返回。 */
function replaceMetadataValue(content: string, key: string, value: string): string {
	// JSON：值里的反斜杠必须按 JSON 字符串转义，否则整个文件不再是合法 JSON ✗
	// ⚠ 分组里只能用 `[ \t]*`，不能用 `\s*`：后者会跨行吃掉 CRLF 与下一行缩进 ⇒ 两行被合并 ✗。
	// ⚠ 末尾的 `\r` 必须捕获并回写：CRLF 文件里 `$` 落在 `\r` 之后，不回写就会把该行变成 LF ⇒
	//   每修一个键少一个 `\r`（实测 8 行按 \r\n 切只剩 6 行）。
	const json = new RegExp(`^([ \\t]*)"${key}"([ \\t]*:[ \\t]*)"(?:[^"\\\\]|\\\\.)*"([ \\t]*,?[ \\t]*\\r?)$`, 'm');
	const jm = json.exec(content);
	if (jm) {
		const escaped = JSON.stringify(value).slice(1, -1);
		return content.replace(json, `${jm[1]}"${key}"${jm[2]}"${escaped}"${jm[3]}`);
	}
	const yaml = new RegExp(`^([ \\t]*)${key}:[^\\r\\n]*(\\r?)$`, 'm');
	const ym = yaml.exec(content);
	if (ym) {
		return content.replace(yaml, `${ym[1]}${key}: ${value}${ym[2]}`);
	}
	return content;
}

/**
 * 纯字符串改写：把 `.modules.yaml` 里的 `virtualStoreDir`（以及给了就一起改的 `storeDir`）换成期望值。
 *
 * 用法（调用方负责读/写文件与日志）：
 * ```ts
 * const expectedVirtual = join(normalizeExistingPath(profileDir), 'node_modules', '.pnpm');
 * const r = repairStoreMetadataContent(before, expectedVirtual, resolveExpectedStoreDir(...));
 * if (r.changed) { await writeFile(file, r.content); }
 * ```
 */
export function repairStoreMetadataContent(before: string, virtualStoreDir: string, storeDir?: string): IStoreMetadataRepair {
	let content = replaceMetadataValue(before, 'virtualStoreDir', virtualStoreDir);
	if (storeDir) {
		content = replaceMetadataValue(content, 'storeDir', storeDir);
	}
	return {
		content,
		changed: content !== before,
		virtualStoreDir,
		...(storeDir ? { storeDir } : {}),
	};
}
