// @vssaros/dsh-foundation — 数据根 / dsh Home 解析（重构 1.3：全插件唯一真源）。
//
// 历史：这两份曾以「逐字节复制」散在 9 个插件里（守卫 check-host-config.mjs 钉同形）。
// 复制的原因是"插件是独立安装的包，profile 里没有互相解析的路径"；现在改由本插件经 cordis
// 服务下发（`ctx.vssarosFoundation`），消费插件的本地文件只剩**委托**（见各自 lib/ 下的
// foundationRef.js 注释）。
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 数据根：config.dataRoot → $VSSAROS_DATA_ROOT → ~/.vssaros。 */
export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

/** dsh Home：config.dshHome → $DSH_HOME → ~/.dsh。 */
export function dshHomeOf(config) {
	const configured = typeof config?.dshHome === 'string' ? config.dshHome.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
	return fromEnv || join(homedir(), '.dsh');
}
