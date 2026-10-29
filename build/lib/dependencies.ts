/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import cp from 'child_process';
const root = fs.realpathSync(path.dirname(path.dirname(import.meta.dirname)));

/**
 * 依赖路径 → 包名（取最后一个 `node_modules/` 之后的段；带 scope 的算两段）。
 */
function packageNameOf(depPath: string): string {
	const parts = depPath.replace(/\\/g, '/').split('/');
	const i = parts.lastIndexOf('node_modules');
	if (i < 0) {
		return '';
	}
	const rest = parts.slice(i + 1);
	return rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : (rest[0] ?? '');
}

/**
 * 收集「可选依赖」的**包名闭包**。
 *
 * 为什么不用 `npm ls --json`（它每个节点都带 optional 标记，最精确）：
 *   ★ 2026-10-29 实测 —— 在这个仓（根 1853 个包 / node_modules 4.7 万文件）跑 `npm ls --all --json`
 *     会被**直接杀掉**（exit -1、stdout 空）⇒ 用不了。
 * 为什么不用 `npm ls --omit=optional`（最省事）：
 *   ⚠ `--omit` 只影响**安装**，不影响 `npm ls` 的**列举** ⇒ optionalDependencies 的整条闭包
 *     （onnxruntime 157MB / opentelemetry 42MB / @xenova/transformers）照样出现在结果里。
 * ⇒ 折中：读扩展自己的 package.json 里的 optionalDependencies，按**包名**收集它们的依赖闭包，
 *   再按名字把结果里的这些包剔掉。扁平化（hoist）不影响判定（按名字，不按路径）。
 */
function collectOptionalPackageNames(folder: string, depthLimit = 8): Set<string> {
	const names = new Set<string>();
	const readPkg = (dir: string): { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } | undefined => {
		try {
			return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		} catch {
			return undefined;
		}
	};
	let own: { optionalDependencies?: Record<string, string> } | undefined;
	try {
		own = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
	} catch { /* 读不到就没有 optional */ }

	const visit = (name: string, depth: number): void => {
		if (!name || depth > depthLimit || names.has(name)) {
			return;
		}
		names.add(name);
		// 依次尝试：扩展自己的 node_modules → 仓库根 node_modules（npm 提升后的位置）
		for (const base of [path.join(folder, 'node_modules', name), path.join(root, 'node_modules', name)]) {
			const pkg = readPkg(base);
			if (!pkg) {
				continue;
			}
			for (const d of Object.keys(pkg.dependencies ?? {})) {
				visit(d, depth + 1);
			}
			for (const d of Object.keys(pkg.optionalDependencies ?? {})) {
				visit(d, depth + 1);
			}
			break;
		}
	};

	for (const name of Object.keys(own?.optionalDependencies ?? {})) {
		visit(name, 0);
	}
	return names;
}

function getNpmProductionDependencies(folder: string, omitOptional = false): string[] {
	// ★ 2026-10-29：改回 `--parseable`（`npm ls --json` 在这个仓会被直接杀掉，见上面的说明），
	//   但**必须从 err.stdout 取结果** —— `npm ls` 在树有问题（ELSPROBLEMS / 缺包）时退出码为 1，
	//   而树照样打印在 stdout。旧写法靠 err.message 里逐行匹配 `npm ERR!` 白名单，
	//   npm 的输出格式一变（甚至只是多一行别的 ERR）就 `throw` ⇒ 这个扩展的**全部**运行期依赖消失
	//   ⇒ 产物缺件 ⇒ 运行期 ERR_MODULE_NOT_FOUND（2026-10-29 CI 现场就是这条路径）。
	const args = ['ls', '--all', '--omit=dev', '--parseable'];
	let raw: string;

	try {
		raw = cp.execSync(`npm ${args.join(' ')}`, { cwd: folder, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }, stdio: [null, null, null], maxBuffer: 128 * 1024 * 1024 });
	} catch (err) {
		raw = (err as { stdout?: string }).stdout ?? '';
	}

	const lines = raw.split(/\r?\n/).filter(line => {
		return !!line.trim() && path.relative(root, line) !== path.relative(root, folder);
	});

	if (!omitOptional) {
		return lines;
	}

	// 剔掉 optional 依赖的整条闭包（按**包名**判定 ⇒ 不受 hoist 影响）。
	const optionalNames = collectOptionalPackageNames(folder);
	return lines.filter(line => !optionalNames.has(packageNameOf(line)));
}

export function getProductionDependencies(folderPath: string, options: { omitOptional?: boolean } = {}): string[] {
	const result = getNpmProductionDependencies(folderPath, options.omitOptional);
	// Account for distro npm dependencies
	const realFolderPath = fs.realpathSync(folderPath);
	const relativeFolderPath = path.relative(root, realFolderPath);
	const distroFolderPath = `${root}/.build/distro/npm/${relativeFolderPath}`;

	if (fs.existsSync(distroFolderPath)) {
		result.push(...getNpmProductionDependencies(distroFolderPath, options.omitOptional));
	}

	return [...new Set(result)];
}

if (import.meta.main) {
	console.log(JSON.stringify(getProductionDependencies(root), null, '  '));
}
