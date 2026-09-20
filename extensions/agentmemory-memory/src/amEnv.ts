/*---------------------------------------------------------------------------------------------
 *  环境变量读取（2026-09-20）
 *
 *  背景：本扩展的代码运行在**两处**，`process` 的可见性不同：
 *    · **网关侧**（Node 子进程，host.mjs 导入同一份编译产物）⇒ 有 `globalThis.process` ✓
 *    · **渲染侧**（capability plugin / provider 代理）⇒ **没有** `globalThis.process`
 *      （CDP 实测 `hasProcess:false`），但 Electron sandbox 暴露了
 *      `globalThis.vscode.process`（见 `src/vs/base/parts/sandbox/electron-browser/globals.ts`；
 *      宿主先例 `providers/tool/gitBashProvider.ts:49`）。
 *
 *  ⇒ 凡是读环境变量的地方都走本函数：优先 `process.env`（网关侧正常路径），
 *    回退 `globalThis.vscode.process.env`（渲染侧）。**不要**直接写 `process.env[...]`，
 *    否则渲染侧静默读到 `undefined`（此前 `AGENTMEMORY_INJECT_CONTEXT` 就是这样失效的）。
 *--------------------------------------------------------------------------------------------*/

interface EnvCarrier {
	process?: { env?: Record<string, string | undefined> };
	vscode?: { process?: { env?: Record<string, string | undefined> } };
}

/** 读环境变量（网关侧 `process.env` → 渲染侧 `globalThis.vscode.process.env`）。 */
export function readEnv(key: string): string | undefined {
	const g = globalThis as unknown as EnvCarrier;
	return g.process?.env?.[key] ?? g.vscode?.process?.env?.[key];
}

/**
 * 布尔型环境变量判据（大小写不敏感 + **trim**）。
 * ⚠ trim 是必需的：Windows cmd 的 `set X=true && ...` 会把尾随空格带进值
 * （实测 `"true "` ⇒ 直接 `=== 'true'` 判等失败，曾导致记忆注入被误判为关闭）。
 */
export function readEnvBool(key: string): boolean {
	return readEnv(key)?.trim().toLowerCase() === 'true';
}
