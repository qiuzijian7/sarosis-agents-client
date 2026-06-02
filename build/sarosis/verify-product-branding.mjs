// @ts-check
/**
 * VsSarosis 品牌校验 / 修复脚本
 * ------------------------------------------------------------
 * 背景：product.json 的品牌字段会被 git 操作或上游构建脚本还原成
 *      "Code - OSS"，并把 AppId 写成单大括号格式，导致打包出错误品牌或
 *      触发 Inno Setup 的 "Unknown constant" 报错。
 *
 * 用法：
 *   node build/sarosis/verify-product-branding.mjs            # 仅检测，不一致则退出码 1
 *   node build/sarosis/verify-product-branding.mjs --fix      # 检测并自动修复
 *
 * 退出码：
 *   0  全部一致（或 --fix 成功修复）
 *   1  存在不一致且未修复（CI / 打包前应中断）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const productJsonPath = path.join(repoRoot, 'product.json');

const FIX = process.argv.includes('--fix');

/**
 * 期望的品牌基准字段（VsSarosis）。
 * AppId 必须是 Inno Setup 要求的双大括号格式 {{...}}。
 */
const EXPECTED = {
	nameShort: 'VsSarosis',
	nameLong: 'VsSarosis',
	applicationName: 'vssarosis',
	dataFolderName: '.vssarosis',
	sharedDataFolderName: '.vssarosis-shared',
	win32MutexName: 'vssarosis',
	// 热更新配置（quality 用自定义值，避免触发 code.iss 的 appx 打包分支）
	quality: 'sarosis',
	serverApplicationName: 'vssarosis-server',
	serverDataFolderName: '.vssarosis-server',
	tunnelApplicationName: 'vssarosis-tunnel',
	win32DirName: 'VsSarosis',
	win32NameVersion: 'VsSarosis',
	win32RegValueName: 'VsSarosis',
	win32x64AppId: '{{89BECFC9-67A9-4ED0-A91E-643CEFE58C71}}',
	win32arm64AppId: '{{ADAAC19C-C02A-4DD2-8A7B-DBBBDCA82048}}',
	win32x64UserAppId: '{{007F569F-0EC1-443E-B300-8B33C515C7D7}}',
	win32arm64UserAppId: '{{1923881D-C3FF-49EE-B978-F037664E0938}}',
	win32AppUserModelId: 'Microsoft.VsSarosis',
	win32ShellNameShort: 'Vs&Sarosis',
	win32TunnelServiceMutex: 'vssarosis-tunnelservice',
	win32TunnelMutex: 'vssarosis-tunnel',
	darwinBundleIdentifier: 'com.vssarosis.vssarosis',
	linuxIconName: 'vssarosis',
	urlProtocol: 'vssarosis'
};

/** AppId 字段，需额外校验是否为双大括号 */
const APP_ID_KEYS = ['win32x64AppId', 'win32arm64AppId', 'win32x64UserAppId', 'win32arm64UserAppId'];

function log(symbol, msg) {
	console.log(`${symbol} ${msg}`);
}

function main() {
	if (!fs.existsSync(productJsonPath)) {
		log('✗', `找不到 product.json: ${productJsonPath}`);
		process.exit(1);
	}

	const raw = fs.readFileSync(productJsonPath, 'utf8');
	/** @type {Record<string, any>} */
	let product;
	try {
		product = JSON.parse(raw);
	} catch (e) {
		log('✗', `product.json 不是合法 JSON: ${/** @type {Error} */(e).message}`);
		process.exit(1);
	}

	const mismatches = [];

	for (const [key, expected] of Object.entries(EXPECTED)) {
		const actual = product[key];
		if (actual !== expected) {
			mismatches.push({ key, expected, actual });
		}
	}

	// 额外校验 AppId 双大括号格式（即使值匹配也兜底检查格式）
	for (const key of APP_ID_KEYS) {
		const actual = product[key];
		if (typeof actual === 'string' && actual.length > 0) {
			const isDoubleBrace = actual.startsWith('{{') && actual.endsWith('}}');
			if (!isDoubleBrace && !mismatches.some(m => m.key === key)) {
				mismatches.push({ key, expected: EXPECTED[key], actual, reason: 'AppId 必须为双大括号 {{...}} 格式' });
			}
		}
	}

	if (mismatches.length === 0) {
		log('✓', 'product.json 品牌字段全部一致（VsSarosis）');
		// 软校验：updateUrl 存在性（值不固定，仅提醒，不影响退出码）
		if (!product.updateUrl) {
			log('!', '提示：未配置 updateUrl，自动热更新将被禁用（仅提示，不影响打包）');
		}
		process.exit(0);
	}

	log('✗', `发现 ${mismatches.length} 个品牌字段不一致：`);
	for (const m of mismatches) {
		const reason = m.reason ? ` [${m.reason}]` : '';
		console.log(`    - ${m.key}: 实际="${m.actual}" 期望="${m.expected}"${reason}`);
	}

	if (!FIX) {
		console.log('');
		log('!', '运行 `node build/sarosis/verify-product-branding.mjs --fix` 可自动修复');
		process.exit(1);
	}

	// 修复：仅覆盖品牌字段，保留 product.json 其余内容与字段顺序
	for (const m of mismatches) {
		product[m.key] = m.expected;
	}
	fs.writeFileSync(productJsonPath, JSON.stringify(product, null, '\t') + '\n', 'utf8');
	log('✓', `已修复 ${mismatches.length} 个字段并写回 product.json`);
	process.exit(0);
}

main();
