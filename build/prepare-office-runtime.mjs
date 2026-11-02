#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 构建 Office 运行时的 **Python 负载**（`primary-runtime/`）：给 `@deepseek-ai/dsh-tool-workspace-dependencies`
 * 提供"安装级只读解释器 + Office 库"，供 `@deepseek-ai/dsh-skill-office` 的 7 个技能使用。
 *
 * 为什么必须自带解释器（而不是用系统 Python）：官方 office 技能正文明确要求
 * `load_workspace_dependencies` 返回的解释器 + 随附库，禁止 `pip install`、禁止猜 PATH
 * （见 `dsh-skill-office/assets/office-docx/SKILL.md`）。用户机器上不一定有 Python，
 * 有也可能缺 python-docx —— 交付时才发现就太晚了。
 *
 * 负载内容与版本**全部来自 `build/office-runtime.lock.json`**（URL + SHA-256 双固定）：
 *   - Python 3.12.x standalone（python-build-standalone，`install_only_stripped`）
 *   - 13 个 wheel：python-docx / python-pptx / openpyxl / XlsxWriter / lxml / Pillow
 *     / numpy / pandas / python-dateutil / six / tzdata / typing_extensions / et_xmlfile
 *
 * 产物布局（与 `dsh-tool-workspace-dependencies` 的 payload 契约一致）：
 *   .build/office-runtime/primary-runtime/
 *   ├── runtime.json                     desktopVersion / platform / arch / payloadDigest / python / pythonPackages
 *   └── dependencies/python/
 *       ├── python.exe                   （POSIX 是 bin/python3 + 别名）
 *       └── Lib/site-packages/…          （POSIX 是 lib/python3.12/site-packages）
 *
 * 用法：
 *   node build/prepare-office-runtime.mjs [--target win-x64] [--output <dir>] [--cache <dir>] [--force]
 *
 * 幂等：缓存按 SHA-256 寻址（命中即校验），产物按 payloadDigest 跳过重建（`--force` 强制重建）。
 * 失败不破坏上一次产物（先 staging 再原子替换）。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { x as extractTar } from 'tar';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LOCK_PATH = join(HERE, 'office-runtime.lock.json');

/** 支持的 target（与 lock.json 的 targets 键一致）。 */
const TARGETS = new Set(['win-x64', 'mac-arm64', 'mac-x64']);

/** 与 dsh-tool-workspace-dependencies 的清单语义对齐：产物里的站点包目录。 */
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const target = option('--target', `${process.platform === 'win32' ? 'win' : 'mac'}-${process.arch}`);
const output = resolve(option('--output', join(ROOT, '.build', 'office-runtime')));
const cache = resolve(option('--cache', join(ROOT, '.build', 'office-downloads')));
const force = flag('--force');

if (!TARGETS.has(target)) {
	console.error(`[office-runtime] 不支持的 target: ${target}（可选 ${[...TARGETS].join(' / ')}）`);
	process.exit(1);
}

const lock = JSON.parse(await fsp.readFile(LOCK_PATH, 'utf8'));
const artifact = lock.targets[target];
if (!artifact) {
	console.error(`[office-runtime] lock.json 缺少 target ${target}`);
	process.exit(1);
}

/** 目标平台的产物路径：Windows 是 `python/python.exe` + `Lib/site-packages`，POSIX 是 `bin/python3` + `lib/pythonX.Y/site-packages`。 */
const windows = target === 'win-x64';
const pythonMinor = lock.pythonVersion.split('.').slice(0, 2).join('.');
const pythonLib = windows ? ['Lib'] : ['lib', `python${pythonMinor}`];

async function sha256(file) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(file), hash);
	return hash.digest('hex');
}

/** 下载并校验（缓存按 SHA 寻址）；返回本地文件路径。缓存命中也要校验 —— 半截文件永远不进构建。 */
async function downloadAsset(url, expected, cacheDir) {
	await fsp.mkdir(cacheDir, { recursive: true });
	const file = join(cacheDir, expected);
	if (existsSync(file) && await sha256(file) === expected) {
		console.log(`  · 缓存命中 ${expected.slice(0, 12)}…  ${url.split('/').pop()}`);
		return file;
	}
	console.log(`  ↓ 下载 ${url.split('/').pop()}`);
	const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${url}`);
	}
	const temporary = `${file}.${process.pid}.tmp`;
	await pipeline(response.body, createWriteStream(temporary));
	const actual = await sha256(temporary);
	if (actual !== expected) {
		await fsp.rm(temporary, { force: true });
		throw new Error(`校验和不符：期望 ${expected}，实际 ${actual}（${url}）`);
	}
	await fsp.rename(temporary, file);
	return file;
}

/** 解 wheel（zip）到站点包目录；`.data/{purelib,platlib}` 重映射，`.data/scripts` 跳过。 */
function unpackWheel(zipFile, destination) {
	return new Promise((resolvePromise, rejectPromise) => {
		yauzl.open(zipFile, { lazyEntries: true }, (error, zip) => {
			if (error) {
				rejectPromise(error);
				return;
			}
			const fail = err => { zip.close(); rejectPromise(err); };
			zip.on('error', fail);
			zip.on('end', resolvePromise);
			zip.readEntry();
			zip.on('entry', entry => {
				try {
					const raw = entry.fileName;
					if (raw.includes('\\') || raw.startsWith('/') || raw.split('/').includes('..')) {
						fail(new Error(`wheel 含不安全路径：${raw}`));
						return;
					}
					if (raw.endsWith('/')) {
						zip.readEntry();
						return;
					}
					// wheel 的 .data 段：purelib/platlib 落站点包，其余（scripts/headers/data）不带
					let relative = raw;
					const dataMatch = /^[^/]+\.data\/([^/]+)\/(.+)$/.exec(raw);
					if (dataMatch) {
						const [, scheme, rest] = dataMatch;
						if (scheme === 'purelib' || scheme === 'platlib') {
							relative = rest;
						} else {
							zip.readEntry();
							return;
						}
					}
					const target = join(destination, ...relative.split('/'));
					zip.openReadStream(entry, (streamError, stream) => {
						if (streamError) {
							fail(streamError);
							return;
						}
						fsp.mkdir(dirname(target), { recursive: true })
							.then(() => pipeline(stream, createWriteStream(target)))
							.then(() => zip.readEntry())
							.catch(fail);
					});
				} catch (unexpected) {
					fail(unexpected);
				}
			});
		});
	});
}

/** 裁剪与运行无关的负载（标准库开发件、GUI、包管理器、C 头文件）。 */
async function stripPayload(dependencies) {
	const lib = join(dependencies, 'python', ...pythonLib);
	const unused = windows
		? ['test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'turtle.py', 'lib2to3']
		: ['test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'turtle.py', 'lib2to3'];
	for (const name of unused) {
		await fsp.rm(join(lib, name), { recursive: true, force: true });
	}
	// C 头文件与静态库：写 Office 文件完全用不到
	for (const name of ['include', 'libs']) {
		await fsp.rm(join(dependencies, 'python', name), { recursive: true, force: true });
	}
	// standalone 自带的 pip / setuptools：技能正文禁止 pip install
	for (const pattern of ['pip', 'pip-*', 'setuptools', 'setuptools-*', 'pkg_resources', 'wheel', 'wheel-*', '_distutils_hack', 'distutils-precedence.pth']) {
		if (pattern.includes('*')) {
			const prefix = pattern.replace('*', '');
			const siteDir = join(lib, 'site-packages');
			if (existsSync(siteDir)) {
				for (const entry of await fsp.readdir(siteDir)) {
					if (entry.startsWith(prefix)) {
						await fsp.rm(join(siteDir, entry), { recursive: true, force: true });
					}
				}
			}
		} else {
			await fsp.rm(join(lib, 'site-packages', pattern), { recursive: true, force: true });
		}
	}
}

async function directorySize(dir) {
	let total = 0;
	const walk = async current => {
		for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				total += (await fsp.stat(full)).size;
			}
		}
	};
	await walk(dir);
	return total;
}

const digest = createHash('sha256')
	.update(JSON.stringify({ format: 1, target, python: lock.pythonVersion, release: lock.pythonRelease, wheels: lock.wheels, platformWheels: artifact.wheels, packages: lock.pythonPackages }))
	.digest('hex');

const runtimeDir = join(output, 'primary-runtime');
const manifestPath = join(runtimeDir, 'runtime.json');

if (!force && existsSync(manifestPath)) {
	const existing = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
	if (existing.payloadDigest === digest) {
		console.log(`[office-runtime] 产物已是最新（${target}，payloadDigest ${digest.slice(0, 12)}…），跳过。--force 可强制重建。`);
		process.exit(0);
	}
}

console.log(`[office-runtime] target=${target} python=${lock.pythonVersion} output=${output}`);
await fsp.mkdir(output, { recursive: true });
// staging 放在 output 的**父目录**：最后要 `rm output` 再整体 rename（否则会把自己删掉）。
const staging = await fsp.mkdtemp(join(dirname(output), '.office-runtime-'));
try {
	const runtime = join(staging, 'primary-runtime');
	const dependencies = join(runtime, 'dependencies');
	await fsp.mkdir(dependencies, { recursive: true });

	const archiveName = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`;
	const archiveUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(archiveName)}`;
	const archive = await downloadAsset(archiveUrl, artifact.pythonSha256, cache);
	console.log('  · 解包 Python …');
	await extractTar({ file: archive, cwd: dependencies });

	const sitePackages = join(dependencies, 'python', ...pythonLib, 'site-packages');
	await fsp.mkdir(sitePackages, { recursive: true });
	const interpreter = join(dependencies, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']));
	if (!existsSync(interpreter)) {
		throw new Error(`解包后找不到解释器：${interpreter}（lock 的 pythonTarget 与目录布局不符？）`);
	}

	for (const wheel of [...artifact.wheels, ...lock.wheels]) {
		const file = await downloadAsset(wheel.url, wheel.sha256, cache);
		await unpackWheel(file, sitePackages);
	}

	console.log('  · 裁剪无关负载 …');
	await stripPayload(dependencies);

	const manifest = {
		desktopVersion: JSON.parse(await fsp.readFile(join(ROOT, 'package.json'), 'utf8')).version,
		platform: windows ? 'win32' : 'darwin',
		arch: target.endsWith('arm64') ? 'arm64' : 'x64',
		payloadDigest: digest,
		python: lock.pythonVersion,
		pythonPackages: lock.pythonPackages,
	};
	await fsp.writeFile(join(runtime, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

	// 负载侧的许可提示：解释器自带的 `LICENSE.txt`（PSF）原样保留在上面的裁剪里
	// （`stripPayload` 只删库与开发件），这里只写"哪份是许可、产品级汇总在哪"。
	const notice = [
		'本目录是 VsSaros 随包的 Office 运行时 Python 负载（由 build/prepare-office-runtime.mjs 生成，勿手改）。',
		'',
		`Python ${manifest.python}：许可证全文见 dependencies/python/LICENSE.txt（PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2）。`,
		`站点包：${Object.entries(manifest.pythonPackages).map(([name, version]) => `${name} ${version}`).join('、')}。`,
		'LibreOffice 引擎不在这里 —— 它随 dsh-runtime 分发（@deepseek-ai/libreoffice-kit-win32-x64/licenses/LibreOffice-MPL-2.0.txt）。',
		'产品级第三方声明汇总：安装包根目录 ThirdPartyNotices.txt（由 build/append-office-notices.mjs 追加）。',
		'',
	].join('\n');
	await fsp.writeFile(join(runtime, 'NOTICE.txt'), notice, 'utf8');

	// 自检：用产物里的解释器导入 Office 库（构建期能发现缺 wheel / 缺 DLL）
	const { execFileSync } = await import('node:child_process');
	const probe = [
		'import docx, pptx, openpyxl, xlsxwriter, lxml, PIL',
		'print("docx", docx.__version__ if hasattr(docx, "__version__") else "ok")',
		'print("openpyxl", openpyxl.__version__)',
	].join('\n');
	const probeOut = execFileSync(interpreter, ['-c', probe], { encoding: 'utf8' });
	console.log(`  · 自检通过：${probeOut.trim().replace(/\r?\n/g, ' | ')}`);

	// 7 个 Office 技能副本：与 payload 放**同一个基目录**（Host 侧只注入一个 `officeBase`，
	// 见 `dshHostSupervisor` 的 `officeBase` 计算）。技能来自本仓 `resources/office-skills`
	// （已把 DSH Desktop 专属的 `present` 交付改成"存工作区 + 回路径"）。
	const skillsSrc = join(ROOT, 'resources', 'office-skills');
	if (!existsSync(join(skillsSrc, 'office-docx', 'SKILL.md'))) {
		throw new Error(`缺少技能副本：${skillsSrc}（7 个 office 技能必须在仓库里）`);
	}
	await fsp.cp(skillsSrc, join(staging, 'office-skills'), { recursive: true });

	// 原子替换：整目录换掉（同卷 rename）—— 产物里同时有 primary-runtime 与 office-skills
	const size = await directorySize(staging);
	console.log(`  · 负载体积 ${(size / 1024 / 1024).toFixed(1)} MiB`);
	await fsp.rm(output, { recursive: true, force: true });
	await fsp.rename(staging, output);
	console.log(`[office-runtime] ✓ 完成 ${output}（payloadDigest ${digest.slice(0, 12)}…）`);
} finally {
	await fsp.rm(staging, { recursive: true, force: true });
}
