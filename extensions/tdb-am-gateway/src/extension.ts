/*---------------------------------------------------------------------------------------------
 *  TDB-AM Gateway — capability extension stub（renderer 侧）
 *
 *  ⚠ 历史变更：
 *    早期版本本扩展在 renderer 进程里直接拉起 vendor TdaiGateway。
 *    但 vendor 依赖 fs/sqlite/http server 等 Node 原生模块，根本无法在
 *    sarosis renderer ESM 环境加载（试过显式 import('vscode') 也失败）。
 *
 *    现在的架构是：
 *      sarosis Electron 主进程 → spawn extensions/tdb-am-gateway/host/host.mjs
 *                                  → 子进程内加载 vendor TdaiGateway
 *                                  → 监听 127.0.0.1:8420 (HTTP)
 *      sarosis renderer 各扩展 → fetch http://127.0.0.1:8420/* 访问
 *
 *  本文件保留为"占位 stub"：
 *    - 只在被 capability framework 加载时打个日志、宣称就绪
 *    - 不做任何 vendor 加载、不依赖 vscode/fs/path/url
 *    - 如果 sarosis 主进程 spawn 失败，gateway 端口 fetch 会自然失败，
 *      和"扩展未启用"的表现一致；renderer 不需要任何错误处理
 *
 *  → 真正的 gateway 启动逻辑见 src/vs/code/electron-main/app.ts 的
 *    CodeApplication.startTdbamGateway()
 *--------------------------------------------------------------------------------------------*/

/** sarosis capability framework 期望 default export 是一个有 activate/deactivate 的类。 */
export class TdbAmGatewayPlugin {
	async activate(): Promise<void> {
		// renderer 不再做任何事——gateway 由主进程负责启动。
		try {
			// eslint-disable-next-line no-console
			console.log('[tdb-am-gateway] capability stub activated; vendor gateway由主进程负责');
		} catch { /* ignore */ }
	}

	async deactivate(): Promise<void> {
		// 同样，renderer 没有需要清理的东西。
	}
}

export default TdbAmGatewayPlugin;
