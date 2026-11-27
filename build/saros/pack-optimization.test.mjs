/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PRUNE_LIST, VIRTUAL_STORE_HEAVY_RE } from './prune-list.mjs';
import policy from './pack-policy.cjs';
import * as tar from 'tar';
import { SEED_GENERATOR_REVISION, archiveSeedPlugin, SEED_PATH_FILES, relativizeSeedPaths } from './seed-package.mjs';
import { compressionSettings, compareInstallerReports } from './pack-comparison.mjs';
import { scanFiles, auditStaging, cleanStaging, recordInstallers, verifyInstallers, recordStaging, verifyStaging, invalidateStaging, stageWhisperModel, checkStagedWhisperModel, checkBundledSeed } from './pack-optimization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIB = 1024 * 1024;
function extensionDependencyFixture(t) {
	const f = fixture(t);
	const helper = fs.readFileSync(path.join(ROOT, '.ci/scripts/extension-dependencies.ps1'), 'utf8');
	f.write('repo/.ci/scripts/extension-dependencies.ps1', helper);
	for (const [, file] of helper.matchAll(/^\s*'((?:extensions|dsh-plugins)\\[^']+)'/gm)) { f.write(`repo/${file.replace(/\\/g, '/')}`); }
	return f;
}

function cleanupFixture(root, remove = fs.promises.rm) {
	return remove(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-pack-'));
	t.after(() => cleanupFixture(root));
	const write = (relative, content = 'keep') => {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		return target;
	};
	write('repo/package.json', '{}');
	write('staging/resources/app/package.json', '{}');
	write('staging/resources/app/dsh-plugins/dsh-compat.json', JSON.stringify({ bundled: '0.2.2-rc.2' }));
	write('staging/resources/app/dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js');
	write('staging/resources/app/out/vs/sessions/electron-browser/dshDesktop.html');
	write('staging/resources/app/out/vs/sessions/electron-browser/dshDesktop.js');
	return { root, write, staging: path.join(root, 'staging'), repo: path.join(root, 'repo') };
}

function sparseFile(file, size) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fd = fs.openSync(file, 'wx');
	try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
}

function assertOrdered(source, first, second, message = 'required tokens are missing or out of order') {
	const a = source.indexOf(first);
	const b = source.indexOf(second);
	assert.ok(a >= 0 && b >= 0 && a < b, `${message}: ${first}@${a}, ${second}@${b}`);
}

/** Each wrapper remains a real isolated process; cap concurrent subprocesses and drain on failure. */
async function checkPowerShellWrappers(cases) {
	let next = 0;
	let failure;
	await Promise.all(Array.from({ length: Math.min(3, cases.length) }, async () => {
		for (;;) {
			const entry = cases[next++];
			if (!entry) { return; }
			const { run, code } = entry;
			const child = Buffer.from(`exit ${code}`, 'utf16le').toString('base64');
			const wrapper = run.replace(/^powershell [^\r\n]+/, `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${child}`);
			let status = 0;
			let detail;
			try {
				const result = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
				detail = result.stderr;
			} catch (error) { status = error.code; detail = error.stderr || error.message; }
			try { assert.equal(status, code, detail); } catch (error) { failure ??= error; }
		}
	}));
	if (failure) { throw failure; }
}

test('fixture cleanup waits for bounded asynchronous removal', async () => {
	let complete;
	const pending = new Promise(resolve => { complete = resolve; });
	const result = cleanupFixture('fixture-root', (root, options) => {
		assert.equal(root, 'fixture-root');
		assert.deepEqual(options, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		return pending;
	});
	assert.equal(result, pending);
	complete();
	await result;
});

test('fixture cleanup propagates permanent deletion errors', async () => {
	const error = Object.assign(new Error('fixture still locked'), { code: 'EPERM' });
	await assert.rejects(cleanupFixture('fixture-root', () => Promise.reject(error)), failure => failure === error);
});

test('sparse fixtures are created once and cannot truncate an existing file', t => {
	const f = fixture(t);
	const file = path.join(f.root, 'write-once.dat');
	sparseFile(file, 4_096);
	assert.throws(() => sparseFile(file, 1_024), { code: 'EEXIST' });
	assert.equal(fs.statSync(file).size, 4_096);
});

test('targets only allow user and reject system, both and invalid values', () => {
	assert.deepEqual(policy.resolvePackPolicy({}).assets.map(item => item.target), ['user']);
	assert.deepEqual(policy.resolvePackPolicy({ SAROS_SETUP_TARGETS: 'user' }).assets.map(item => item.platform), ['win32-x64-user']);
	for (const target of ['system', 'both', 'all']) {
		assert.throws(() => policy.resolvePackPolicy({ SAROS_SETUP_TARGETS: target }), /SAROS_SETUP_TARGETS/);
	}
	assert.equal(policy.resolvePackPolicy({}).mode, 'offline');
	assert.equal(policy.resolvePackPolicy({ SAROS_PACK_MODE: 'standard' }).mode, 'standard');
	assert.throws(() => policy.resolvePackPolicy({ SAROS_PACK_MODE: 'wrong' }), /SAROS_PACK_MODE/);
	for (const value of ['NaN', '-1', '0', 'Infinity']) {
		assert.throws(() => policy.resolvePackPolicy({ SAROS_MAX_EXE_MB: value }), /positive number/);
	}
});

test('budget rejects oversized/truncated installers and excessive growth', () => {
	const config = policy.resolvePackPolicy({});
	policy.checkExeBudget(Math.round(762.71 * MIB), config);
	policy.checkExeBudget(850 * MIB, config);
	assert.throws(() => policy.checkExeBudget(850 * MIB + 1, config), /exceeds/);
	assert.throws(() => policy.checkExeBudget(9 * MIB, config), /truncated/);
	policy.checkExeBudget(110 * MIB, config, 100 * MIB);
	assert.throws(() => policy.checkExeBudget(111 * MIB, config, 100 * MIB), /growth/);
	assert.throws(() => policy.checkExeBudget(20 * MIB, config, 0), /baseline/);
});

test('audit separates hard links from independent duplicates and compares hashes', t => {
	const f = fixture(t);
	const first = f.write('staging/resources/saros/models/first.bin', Buffer.alloc(65536, 1));
	const hardlink = path.join(f.staging, 'resources/saros/models/hardlink.bin');
	fs.linkSync(first, hardlink);
	f.write('staging/resources/saros/models/copy.bin', Buffer.alloc(65536, 1));
	f.write('staging/resources/saros/models/different.bin', Buffer.alloc(65536, 2));
	const before = fs.readFileSync(first);
	const report = auditStaging(f.staging);
	assert.equal(report.hardlinkRepeatedBytes, 65536);
	assert.equal(report.independentDuplicateBytes, 65536);
	assert.equal(report.duplicates.length, 1);
	assert.equal(report.duplicates[0].copies, 2);
	assert.equal(report.duplicates[0].paths.length, 3);
	assert.equal(report.groups.find(group => group.name === 'media-models').bytes, 4 * 65536);
	assert.deepEqual(fs.readFileSync(first), before);
});

test('audit and cleanup do not traverse junctions or delete their targets', t => {
	const f = fixture(t);
	f.write('outside/test.pdb', 'outside');
	fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.staging, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
	const report = auditStaging(f.staging);
	assert.equal(report.skippedLinks.length, 1);
	assert.equal(scanFiles(f.staging).files.some(file => file.path.includes('test.pdb')), false);
	cleanStaging(f.staging, f.repo);
	assert.equal(fs.readFileSync(path.join(f.root, 'outside/test.pdb'), 'utf8'), 'outside');
});

test('cleanup removes only old staged runtimes and dependency symbols, preserving all features', t => {
	const f = fixture(t);
	f.write('staging/resources/app/dsh-runtime/0.2.1/node_modules/unused.js');
	f.write('staging/resources/app/dsh-runtime/0.2.2-rc.2/node_modules/x/debug.PDB');
	f.write('staging/resources/app/dsh-runtime/0.2.2-rc.2/profile-seed/node_modules/x/index.js.map');
	const retained = [
		'resources/app/dsh-runtime/0.2.2-rc.2/node_modules/libreoffice-kit/engine.dll',
		'resources/app/dsh-runtime/0.2.2-rc.2/node_modules/sherpa-onnx/speech.node',
		'resources/app/dsh-runtime/0.2.2-rc.2/profile-seed/seed.json',
		'resources/app/office-runtime/python.exe',
		'resources/saros/bin/ffmpeg.exe', 'resources/saros/bin/whisper.dll',
		'resources/saros/models/ggml-base.bin',
		'resources/app/dsh-plugins/plugin/skills/template.pdb',
		'resources/app/dsh-plugins/plugin/LICENSE',
	];
	for (const file of retained) { f.write(`staging/${file}`); }
	const result = cleanStaging(f.staging, f.repo);
	assert.equal(result.removed.length, 3);
	for (const file of retained) { assert.equal(fs.existsSync(path.join(f.staging, file)), true, file); }
	assert.equal(cleanStaging(f.staging, f.repo).removed.length, 0);
});

test('cleanup rejects repository directories and invalid/missing runtime before any removal', t => {
	const f = fixture(t);
	assert.throws(() => cleanStaging(f.repo, f.repo), /restricted/);
	f.write('repo/source/debug.pdb');
	assert.throws(() => cleanStaging(path.join(f.repo, 'source'), f.repo), /restricted/);
	assert.throws(() => cleanStaging(f.root, f.repo), /restricted/);
	const old = f.write('staging/resources/app/dsh-runtime/0.1.0/keep.js');
	const compat = path.join(f.staging, 'resources/app/dsh-plugins/dsh-compat.json');
	fs.writeFileSync(compat, JSON.stringify({ bundled: '../outside' }));
	assert.throws(() => cleanStaging(f.staging, f.repo), /invalid bundled/);
	assert.equal(fs.existsSync(old), true);
	fs.writeFileSync(compat, JSON.stringify({ bundled: '9.0.0' }));
	assert.throws(() => cleanStaging(f.staging, f.repo));
	assert.equal(fs.existsSync(old), true);
});

test('cleanup rejects linked staging root', t => {
	const f = fixture(t);
	const link = path.join(f.root, 'staging-link');
	fs.symlinkSync(f.staging, link, process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(() => cleanStaging(link, f.repo), /symlink or junction/);
});

test('installer inspection uses selected targets and fails closed on missing baselines', t => {
	const f = fixture(t);
	const config = policy.resolvePackPolicy({ SAROS_SETUP_TARGETS: 'user' });
	const file = path.join(f.repo, config.assets[0].rel);
	sparseFile(file, 10 * MIB);
	const artifacts = policy.inspectInstallers(f.repo, config);
	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0].sha256.length, 64);
	assert.throws(() => policy.inspectInstallers(f.repo, config, { artifacts: [] }), /baseline is missing/);
	assert.equal(policy.inspectInstallers(f.repo, policy.resolvePackPolicy({})).length, 1);
	const missing = fixture(t);
	assert.equal(fs.existsSync(path.join(missing.repo, config.assets[0].rel)), false);
	assert.throws(() => policy.inspectInstallers(missing.repo, policy.resolvePackPolicy({})), /ENOENT/);
	assert.equal(fs.statSync(file).size, 10 * MIB);
});

test('recorded installers reject target/version/commit changes and same-size tampering', t => {
	const f = fixture(t);
	const env = { SAROS_SETUP_TARGETS: 'user' };
	const identity = { commit: 'a'.repeat(40), productVersion: '2.2.26241' };
	const file = path.join(f.repo, policy.resolvePackPolicy(env).assets[0].rel);
	sparseFile(file, 10 * MIB);
	const report = recordInstallers(f.repo, env, identity);
	assert.equal(verifyInstallers(f.repo, env, identity).artifacts.length, 1);
	const reportPath = path.join(f.repo, '.build/pack-reports/installers.json');
	fs.writeFileSync(reportPath, JSON.stringify({ ...report, artifacts: [...report.artifacts, { target: 'system' }] }));
	assert.throws(() => verifyInstallers(f.repo, env, identity), /only the user installer/);
	fs.writeFileSync(reportPath, JSON.stringify(report));
	assert.throws(() => verifyInstallers(f.repo, { SAROS_SETUP_TARGETS: 'system' }, identity), /SAROS_SETUP_TARGETS/);
	assert.throws(() => verifyInstallers(f.repo, env, { ...identity, productVersion: 'other' }), /does not match/);
	assert.throws(() => verifyInstallers(f.repo, env, { ...identity, commit: 'b'.repeat(40) }), /does not match/);
	const fd = fs.openSync(file, 'r+');
	try { fs.writeSync(fd, Buffer.from([1]), 0, 1, 0); } finally { fs.closeSync(fd); }
	assert.throws(() => verifyInstallers(f.repo, env, identity), /changed since size gate/);
});

test('CLI rejects unknown targets and publication gates missing artifacts before network', () => {
	const script = path.join(ROOT, 'build/saros/pack-optimization.mjs');
	const result = spawnSync(process.execPath, [script, '--targets-json'], { encoding: 'utf8', env: { ...process.env, SAROS_SETUP_TARGETS: 'wrong' }, timeout: 30000 });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /SAROS_SETUP_TARGETS/);
	for (const target of ['system', 'both']) {
		const targets = spawnSync(process.execPath, [script, '--targets-json'], { encoding: 'utf8', env: { ...process.env, SAROS_SETUP_TARGETS: target }, timeout: 30000 });
		assert.equal(targets.status, 1);
		assert.match(targets.stderr, /SAROS_SETUP_TARGETS/);
	}
	const release = fs.readFileSync(path.join(ROOT, 'build/saros/create-release.cjs'), 'utf8');
	assertOrdered(release, "'--check-exes'", 'const changelog = buildChangelog');
	const upload = fs.readFileSync(path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1'), 'utf8');
	assertOrdered(upload, '--check-exes', 'Invoke-UploadCurl -Executable $curlExe');
});

test('staging requires successful packaging, current identity and unchanged entry hashes', t => {
	const f = fixture(t);
	const identity = { commit: 'a'.repeat(40), productVersion: '2.2.26241' };
	f.write('staging/resources/app/out/main.js', 'current-main');
	f.write('staging/resources/app/out/vs/sessions/sessions.desktop.main.js', 'current-sessions');
	f.write('staging/resources/app/extensions/agent-studio/out/extension.js', 'current-extension');
	assert.throws(() => verifyStaging(f.staging, f.repo, identity), /ENOENT/);
	recordStaging(f.staging, f.repo, identity);
	assert.equal(verifyStaging(f.staging, f.repo, identity).files.length, 6);
	assert.throws(() => verifyStaging(f.staging, f.repo, { ...identity, commit: 'b'.repeat(40) }), /not packaged successfully/);
	assert.throws(() => verifyStaging(f.staging, f.repo, { ...identity, productVersion: 'other' }), /not packaged successfully/);
	f.write('staging/resources/app/out/main.js', 'previous-build');
	assert.throws(() => verifyStaging(f.staging, f.repo, identity), /staging changed/);
	f.write('repo/.build/pack-reports/installers.json', '{}');
	f.write('repo/.build/pack-reports/installer-comparison.json', '{}');
	f.write('repo/.build/pack-reports/staging-verified.json', '{}');
	invalidateStaging(f.repo);
	assert.equal(fs.existsSync(path.join(f.repo, '.build/pack-reports/staging-build.json')), false);
	assert.equal(fs.existsSync(path.join(f.repo, '.build/pack-reports/installers.json')), false);
	assert.equal(fs.existsSync(path.join(f.repo, '.build/pack-reports/installer-comparison.json')), false);
	assert.equal(fs.existsSync(path.join(f.repo, '.build/pack-reports/staging-verified.json')), false);
});

test('baseline errors invalidate previous success and verification enforces growth', t => {
	const f = fixture(t);
	const env = { SAROS_SETUP_TARGETS: 'user' };
	const identity = { commit: 'a'.repeat(40), productVersion: '2.2.26241' };
	const file = path.join(f.repo, policy.resolvePackPolicy(env).assets[0].rel);
	sparseFile(file, 12 * MIB);
	recordInstallers(f.repo, env, identity);
	const baseline = f.write('baseline.json', JSON.stringify({ artifacts: [{ target: 'user', size: 10 * MIB }] }));
	assert.throws(() => verifyInstallers(f.repo, { ...env, SAROS_PACK_BASELINE_REPORT: baseline }, identity), /growth/);
	assert.throws(() => recordInstallers(f.repo, { ...env, SAROS_PACK_BASELINE_REPORT: path.join(f.root, 'missing.json') }, identity), /ENOENT/);
	assert.equal(fs.existsSync(path.join(f.repo, '.build/pack-reports/installers.json')), false);
	assert.throws(() => verifyInstallers(f.repo, env, identity), /ENOENT/);
	recordInstallers(f.repo, env, identity);
	fs.writeFileSync(baseline, 'invalid-json');
	assert.throws(() => recordInstallers(f.repo, { ...env, SAROS_PACK_BASELINE_REPORT: baseline }, identity), SyntaxError);
	assert.equal(fs.existsSync(path.join(f.repo, '.build/pack-reports/installers.json')), false);
});

test('production compile defaults to no mangling, supports opt-in and propagates failure in PowerShell 5.1', { skip: process.platform !== 'win32' }, t => {
	const f = extensionDependencyFixture(t);
	const source = fs.readFileSync(path.join(ROOT, '.ci/scripts/compile-build.ps1'), 'utf8');
	const script = f.write('repo/.ci/scripts/compile-build.ps1', '\uFEFF' + source.replace(/^\uFEFF/, ''));
	const commands = path.join(f.root, 'commands');
	for (const [name, output] of [['nvm', '22.22.1'], ['node', 'v22.22.1'], ['npm', '10.9.4']]) {
		f.write(`commands/${name}.cmd`, `@echo off\r\necho ${output}\r\nexit /b 0\r\n`);
	}
	const capture = path.join(f.root, 'gulp-args.txt');
	const gulpPath = 'repo/node_modules/.bin/gulp.cmd';
	const env = { ...process.env, PATH: `${commands}${path.delimiter}${process.env.PATH ?? ''}`, SAROS_BUILD_MANGLE: '' };
	const run = (mangle, args = [], code = 0) => {
		f.write(gulpPath, `@echo off\r\necho %* > "${capture}"\r\nexit /b ${code}\r\n`);
		return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
			env: { ...env, SAROS_BUILD_MANGLE: mangle }, encoding: 'utf8', timeout: 30000,
		});
	};
	for (const [mangle, args, task] of [
		['', [], 'compile-build-without-mangling'],
		['1', [], 'compile-build-with-mangling'],
		['0', ['-Mangle'], 'compile-build-with-mangling'],
	]) {
		const result = run(mangle, args);
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.equal(fs.readFileSync(capture, 'utf8').trim(), `${task} --verbose`, JSON.stringify({ mangle, args, stdout: result.stdout, stderr: result.stderr }));
	}
	assert.equal(run('0', [], 37).status, 37);
	assert.equal(run('invalid').status, 1);
	assert.ok(!source.includes('npm run compile'), 'Production failure must not fall back to dev compilation');
	const pipeline = fs.readFileSync(path.join(ROOT, '.ci/package-win-exe.yml'), 'utf8');
	assert.match(pipeline, /SAROS_BUILD_MANGLE:\s+value: '0'/);
});

test('markdown notebook type dependencies are declared, locked and pass native type checking', () => {
	const extensionRoot = path.join(ROOT, 'extensions/markdown-math');
	const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
	const lock = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package-lock.json'), 'utf8'));
	for (const name of ['@types/node', '@types/markdown-it']) {
		assert.equal(lock.packages[''].devDependencies[name], manifest.devDependencies[name]);
		assert.ok(lock.packages[`node_modules/${name}`]?.integrity);
	}
	assert.match(manifest.devDependencies['@types/node'], /^\^22\./);
	assert.match(manifest.devDependencies['@types/markdown-it'], /^\^14\./);
	for (const project of [
		'extensions/markdown-math/notebook/tsconfig.json',
		'extensions/markdown-language-features/notebook/tsconfig.json',
		'extensions/simple-browser/preview-src/tsconfig.json',
	]) {
		const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/@typescript/native-preview/bin/tsgo.js'), '--project', path.join(ROOT, project), '--noEmit', '--incremental', 'false'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
		assert.equal(result.status, 0, `${project}: ${result.stdout || result.stderr || result.error?.message}`);
	}
});

test('CI creates staging marker only after successful package/strip and checks before cleanup', () => {
	const pack = fs.readFileSync(path.join(ROOT, '.ci/scripts/package-vscode.ps1'), 'utf8');
	const generate = fs.readFileSync(path.join(ROOT, '.ci/scripts/generate-exe.ps1'), 'utf8');
	assertOrdered(pack, '--invalidate-staging', 'node build/prepack-dsh-runtime.mjs');
	assertOrdered(pack, 'strip-before-pack failed', '--record-staging');
	assertOrdered(generate, '--check-staging', '--audit');
	assert.match(generate, /--record-exes \$vsOutRoot/);
});

test('PowerShell 5.1 target parsing and Inno retries return one boolean without deleting another target', { skip: process.platform !== 'win32' }, () => {
	const file = path.join(ROOT, '.ci/scripts/generate-exe.ps1').replace(/'/g, "''");
	const script = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Expected Windows PowerShell 5.1' }
$assetsJson = '${JSON.stringify(policy.shellAssets(policy.WINDOWS_ASSETS))}'
$setupAssets = ConvertFrom-Json -InputObject ($assetsJson -join "\`n")
if (@($setupAssets).Count -ne 1) { throw 'Nested JSON array' }
foreach ($asset in $setupAssets) {
  if ($asset.target -isnot [string] -or $asset.rel -isnot [string]) { throw 'Target must be scalar' }
}
$upload = Get-Content -LiteralPath '${path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1').replace(/'/g, "''")}' -Raw
$tokens = $null; $errors = $null
$uploadAst = [System.Management.Automation.Language.Parser]::ParseInput($upload, [ref]$tokens, [ref]$errors)
$uploadAssign = $uploadAst.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$setupAssets' }, $true)
. ([scriptblock]::Create($uploadAssign.Extent.Text))
if (@($setupAssets).Count -ne 1 -or $setupAssets[0].target -isnot [string]) { throw 'Upload nested array regression' }
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$tokens, [ref]$errors)
$generateAssign = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$setupAssets' }, $true)
. ([scriptblock]::Create($generateAssign.Extent.Text))
if (@($setupAssets).Count -ne 1 -or $setupAssets[0].target -isnot [string]) { throw 'Installer nested array regression' }
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-InnoTask' }, $true)
. ([scriptblock]::Create($fn.Extent.Text))
function Start-Sleep { param($Seconds) }
$script:removed = @()
function Remove-InstallerArtifact { param($RelativePath) $script:removed += $RelativePath }
$script:fakeExit = 1
function Invoke-FakeGulp { param($Task, $verbose) Write-Output 'gulp diagnostic'; $global:LASTEXITCODE = $script:fakeExit }
$gulp = 'Invoke-FakeGulp'
$value = Invoke-InnoTask 'vscode-win32-x64-user-setup'
if ($value -isnot [bool] -or $value -ne $false) { throw 'Inno failure hidden by stdout' }
if ($script:removed.Count -ne 3 -or ($script:removed | Where-Object { $_ -ne @($setupAssets)[0].rel })) { throw 'Another target removed during retry' }
$script:fakeExit = 0
$value = Invoke-InnoTask 'vscode-win32-x64-user-setup'
if ($value -isnot [bool] -or $value -ne $true) { throw 'Inno success polluted by stdout' }
Write-Output 'PS51_POLICY_OK'
`;
	const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.match(result.stdout, /PS51_POLICY_OK/);
});

test('actual prepack pruning removes seed engine copies but keeps runtime engines and speech', t => {
	const f = fixture(t);
	const source = fs.readFileSync(path.join(ROOT, 'build/prepack-dsh-runtime.mjs'), 'utf8');
	const start = source.indexOf('function prune(');
	const end = source.indexOf('\n}', start) + 2;
	assert.ok(start > 0 && end > start);
	const cleanupCalls = [];
	const prune = runInNewContext(`(${source.slice(start, end)})`, {
		PRUNE_LIST, VIRTUAL_STORE_HEAVY_RE, join: path.join,
		existsSync: fs.existsSync, readdirSync: fs.readdirSync,
		dirSize: directory => scanFiles(directory).files.reduce((sum, file) => sum + file.size, 0),
		removeTree: directory => { fs.rmSync(directory, { recursive: true }); return true; },
		pruneDanglingLinks: directory => cleanupCalls.push(directory),
		console: { log() {} },
	});
	const runtime = path.join(f.staging, 'resources/app/dsh-runtime/0.2.2-rc.2');
	const profile = path.join(runtime, 'profile-seed/profiles/vssaros');
	const engineRel = 'node_modules/.pnpm/@deepseek-ai+libreoffice-kit-win32-x64@1.0/node_modules/engine/program.dll';
	const runtimeEngine = f.write(`staging/resources/app/dsh-runtime/0.2.2-rc.2/${engineRel}`);
	const seedEngine = f.write(`staging/resources/app/dsh-runtime/0.2.2-rc.2/profile-seed/profiles/vssaros/${engineRel}`);
	const runtimeWasm = f.write('staging/resources/app/dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/engine.wasm');
	const seedWasm = f.write('staging/resources/app/dsh-runtime/0.2.2-rc.2/profile-seed/profiles/vssaros/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/engine.wasm');
	const seedVirtualWasm = f.write('staging/resources/app/dsh-runtime/0.2.2-rc.2/profile-seed/profiles/vssaros/node_modules/.pnpm/@deepseek-ai+libreoffice-kit-wasm@1.0/node_modules/engine.wasm');
	const speech = f.write('staging/resources/app/dsh-runtime/0.2.2-rc.2/profile-seed/profiles/vssaros/node_modules/.pnpm/sherpa-onnx-win-x64@1.0/speech.node');
	prune(runtime);
	prune(runtime, 'profile seed');
	assert.equal(fs.existsSync(runtimeEngine), true);
	assert.equal(fs.existsSync(runtimeWasm), false);
	prune(profile, 'profile seed');
	assert.equal(fs.existsSync(seedEngine), false);
	assert.equal(fs.existsSync(seedWasm), false);
	assert.equal(fs.existsSync(seedVirtualWasm), false);
	assert.equal(fs.existsSync(runtimeEngine), true);
	assert.equal(fs.existsSync(speech), true);
	assert.deepEqual(cleanupCalls, [profile]);
	const cacheStart = source.indexOf('if (existsSync(markerPath))');
	const cacheEnd = source.indexOf("console.log('[prepack-dsh] profile seed 已是最新，跳过')", cacheStart);
	assert.match(source.slice(cacheStart, cacheEnd), /prune\(profileDir, 'profile seed'\)/);
	assert.match(source.slice(cacheStart, cacheEnd), /seedPluginGaps\(profileDir, wantPlugins\)/);
});

test('release guard checks engine duplicates in seed only, not runtime pnpm layout', t => {
	const f = fixture(t);
	const source = fs.readFileSync(path.join(ROOT, 'build/saros/check-dsh-release.mjs'), 'utf8');
	const start = source.indexOf('const scanHeavy =');
	const end = source.indexOf('\n};', start) + 3;
	assert.ok(start > 0 && end > start);
	const problems = [];
	const scanHeavy = runInNewContext(`${source.slice(start, end)}\nscanHeavy`, {
		fs, path, pruneTargets: PRUNE_LIST.map(relative => relative[0] === 'node_modules' ? relative.slice(1) : relative),
		VIRTUAL_STORE_HEAVY_RE, problem: message => problems.push(message),
	});
	const modules = path.join(f.root, 'node_modules');
	f.write('node_modules/.pnpm/@deepseek-ai+libreoffice-kit-win32-x64@1.0/engine.dll');
	scanHeavy(modules, 'runtime');
	assert.equal(problems.length, 0);
	scanHeavy(modules, 'seed', true);
	assert.equal(problems.length, 1);
	assert.match(source, /scanHeavy\(nm, `种子 profile \$\{p.name\}`, true\)/);
});

test('standard staging removes exactly the large model and validates the descriptor', t => {
	const f = fixture(t);
	const model = f.write('staging/resources/saros/models/ggml-base.bin', 'old-model');
	const other = f.write('staging/resources/saros/models/custom.bin', 'user-model');
	f.write('staging/resources/saros/bin/whisper.dll', 'keep-cli-libraries');
	const env = { SAROS_PACK_MODE: 'standard' };
	assert.equal(stageWhisperModel(f.staging, env).removedBytes, 9);
	assert.equal(fs.existsSync(model), false);
	assert.equal(fs.readFileSync(other, 'utf8'), 'user-model');
	assert.equal(checkStagedWhisperModel(f.staging, env).mode, 'standard');
	assert.throws(() => checkStagedWhisperModel(f.staging, { SAROS_PACK_MODE: 'offline' }), /does not match/);
	f.write('staging/resources/saros/models/ggml-base.bin', 'unexpected');
	assert.throws(() => checkStagedWhisperModel(f.staging, env), /still contains/);
});

test('clean offline CI can defer model until bundle step but final gate never accepts missing/corrupt model', t => {
	const f = fixture(t);
	const absent = path.join(f.root, 'not-downloaded.bin');
	const env = { SAROS_PACK_MODE: 'offline' };
	assert.equal(stageWhisperModel(f.staging, env, absent, { deferMissingOffline: true }).mode, 'offline');
	assert.throws(() => checkStagedWhisperModel(f.staging, env), /ENOENT/);
	assert.throws(() => stageWhisperModel(f.staging, env, absent), /ENOENT/);
	const corrupt = f.write('corrupt.bin', 'bad');
	assert.throws(() => stageWhisperModel(f.staging, env, corrupt, { deferMissingOffline: true }), /pinned Whisper model/);
});

test('offline staging roundtrips the actual pinned model without altering it', { skip: !fs.existsSync(path.join(ROOT, 'build/saros/models/ggml-base.bin')) }, t => {
	const f = fixture(t);
	const result = stageWhisperModel(f.staging, { SAROS_PACK_MODE: 'offline' });
	assert.equal(result.modelBytes, 147951465);
	assert.equal(checkStagedWhisperModel(f.staging, { SAROS_PACK_MODE: 'offline' }).mode, 'offline');
	assert.equal(stageWhisperModel(f.staging, { SAROS_PACK_MODE: 'standard' }).removedBytes, result.modelBytes);
	assert.equal(checkStagedWhisperModel(f.staging, { SAROS_PACK_MODE: 'standard' }).mode, 'standard');
});

test('model staging cannot follow directory junctions or use repository source as staging', t => {
	const f = fixture(t);
	assert.throws(() => stageWhisperModel(f.repo, { SAROS_PACK_MODE: 'standard' }), /staged application/);
	const external = path.join(f.root, 'external');
	fs.mkdirSync(path.join(f.staging, 'resources/saros'), { recursive: true });
	fs.mkdirSync(external);
	fs.symlinkSync(external, path.join(f.staging, 'resources/saros/models'), process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(() => stageWhisperModel(f.staging, { SAROS_PACK_MODE: 'standard' }), /must not be a link/);
});

test('installer report mode mismatch requires rebuilding even at same commit and size', t => {
	const f = fixture(t);
	const env = { SAROS_SETUP_TARGETS: 'user', SAROS_PACK_MODE: 'offline' };
	const identity = { commit: 'a'.repeat(40), productVersion: '2.2.26241' };
	sparseFile(path.join(f.repo, policy.resolvePackPolicy(env).assets[0].rel), 10 * MIB);
	recordInstallers(f.repo, env, identity);
	assert.throws(() => verifyInstallers(f.repo, { ...env, SAROS_PACK_MODE: 'standard' }, identity), /does not match/);
});

test('all model copy points use one policy, with strict final check after deferred strip', () => {
	const strip = fs.readFileSync(path.join(ROOT, 'build/saros/strip-before-pack.mjs'), 'utf8');
	const bundle = fs.readFileSync(path.join(ROOT, '.ci/scripts/bundle-whisper.ps1'), 'utf8');
	const generate = fs.readFileSync(path.join(ROOT, '.ci/scripts/generate-exe.ps1'), 'utf8');
	assert.match(strip, /'--prepare-model', buildDir/);
	assert.match(bundle, /--stage-model \$buildOut/);
	assert.match(bundle, /'standard'\) \{ \$extraArgs \+= '--skip-model'/);
	assertOrdered(generate, '--check-model', "Invoke-InnoTask 'vscode-win32-x64-inno-updater'");
});

test('compression probe reads all formal Inno settings and rejects missing/duplicate keys', () => {
	const source = fs.readFileSync(path.join(ROOT, 'build/win32/code.iss'), 'utf8');
	const settings = compressionSettings(source);
	assert.deepEqual(settings, ['Compression=lzma2/ultra64', 'SolidCompression=yes', 'LZMAUseSeparateProcess=yes', 'LZMANumBlockThreads=4', 'LZMADictionarySize=262144']);
	assert.throws(() => compressionSettings(source.replace('SolidCompression=yes', '')), /SolidCompression/);
	assert.throws(() => compressionSettings(source + '\nCompression=none\n'), /Compression/);
});

test('successful builds preserve separate standard/offline report history for a controlled comparison', t => {
	const offlineFixture = fixture(t);
	const standardFixture = fixture(t);
	const identity = { commit: 'a'.repeat(40), productVersion: '2.2.26241' };
	const asset = policy.WINDOWS_ASSETS[0];
	const offlineFile = path.join(offlineFixture.repo, asset.rel);
	const standardFile = path.join(standardFixture.repo, asset.rel);
	sparseFile(offlineFile, 12 * MIB);
	recordInstallers(offlineFixture.repo, { SAROS_SETUP_TARGETS: 'user', SAROS_PACK_MODE: 'offline' }, identity);
	const offlineHistory = path.join(offlineFixture.repo, '.build/pack-reports/history', identity.commit);
	const offlineText = fs.readFileSync(path.join(offlineHistory, 'offline-user.json'), 'utf8');
	const history = path.join(standardFixture.repo, '.build/pack-reports/history', identity.commit);
	fs.cpSync(offlineHistory, history, { recursive: true, errorOnExist: true, force: false });
	sparseFile(standardFile, 10 * MIB);
	recordInstallers(standardFixture.repo, { SAROS_SETUP_TARGETS: 'user', SAROS_PACK_MODE: 'standard' }, identity);
	assert.equal(fs.readFileSync(path.join(history, 'offline-user.json'), 'utf8'), offlineText);
	assert.equal(fs.statSync(offlineFile).size, 12 * MIB);
	assert.equal(fs.statSync(standardFile).size, 10 * MIB);
	const offline = JSON.parse(fs.readFileSync(path.join(history, 'offline-user.json'), 'utf8'));
	const standard = JSON.parse(fs.readFileSync(path.join(history, 'standard-user.json'), 'utf8'));
	const report = compareInstallerReports(offline, standard);
	assert.equal(report.scope, 'reported-full-installers');
	assert.equal(report.artifacts[0].savedBytes, 2 * MIB);
	assert.equal(report.artifacts[0].savedPercent, 2 / 12 * 100);
	assert.throws(() => compareInstallerReports(standard, offline), /requires offline\/standard/);
	assert.throws(() => compareInstallerReports(offline, { ...standard, commit: 'b'.repeat(40) }), /same commit/);
	assert.throws(() => compareInstallerReports(offline, { ...standard, productVersion: 'wrong' }), /same commit/);
	assert.throws(() => compareInstallerReports({ ...offline, productVersion: undefined }, { ...standard, productVersion: undefined }), /requires/);
	assert.throws(() => compareInstallerReports({ ...offline, target: undefined }, { ...standard, target: undefined }), /requires/);
	assert.throws(() => compareInstallerReports({ ...offline, target: '' }, { ...standard, target: '' }), /requires/);
	assert.throws(() => compareInstallerReports(offline, { ...standard, artifacts: [] }), /missing or duplicate/);
	assert.throws(() => compareInstallerReports(offline, { ...standard, artifacts: [{ ...standard.artifacts[0], platform: 'wrong' }] }), /invalid installer/);
	assert.equal(compareInstallerReports(offline, { ...standard, artifacts: [{ ...standard.artifacts[0], size: 14 * MIB }] }).artifacts[0].savedBytes, -2 * MIB);
});

test('filtered staging refresh replaces stale plugin files and excludes development dependencies', t => {
	const f = fixture(t);
	const source = fs.readFileSync(path.join(ROOT, 'build/saros/strip-before-pack.mjs'), 'utf8');
	const start = source.indexOf('function ensureDir(');
	const end = source.indexOf('\n}', start) + 2;
	assert.ok(start > 0 && end > start);
	const ensure = runInNewContext(`${source.slice(start, end)}\nensureDir`, {
		path, buildDir: f.staging, repoRoot: f.repo, toStagingRel: relative => relative,
		existsSync: fs.existsSync, rmSync: fs.rmSync, mkdirSync: fs.mkdirSync, cpSync: fs.cpSync,
		console: { log() {} }, criticalMissing: 0,
	});
	f.write('repo/dsh-plugins/demo/package.json', '{}');
	f.write('repo/dsh-plugins/demo/lib/index.js', 'new-version');
	f.write('repo/dsh-plugins/demo/lib/whisperModel.js', 'new-model-installer');
	f.write('repo/dsh-plugins/demo/node_modules/development/index.js', 'must-not-ship');
	f.write('staging/resources/app/dsh-plugins/demo/package.json', '{}');
	f.write('staging/resources/app/dsh-plugins/demo/lib/index.js', 'old-version');
	f.write('staging/resources/app/dsh-plugins/demo/stale.js', 'obsolete');
	ensure('dsh-plugins', 'resources/app/dsh-plugins', 'dsh-plugins', 'demo/package.json', {
		refresh: true, filter: relative => !relative.split(/[\\/]/).includes('node_modules'),
	});
	const result = path.join(f.staging, 'resources/app/dsh-plugins/demo');
	assert.equal(fs.readFileSync(path.join(result, 'lib/index.js'), 'utf8'), 'new-version');
	assert.equal(fs.existsSync(path.join(result, 'lib/whisperModel.js')), true);
	assert.equal(fs.existsSync(path.join(result, 'stale.js')), false);
	assert.equal(fs.existsSync(path.join(result, 'node_modules')), false);
	assert.match(source, /refresh: true, filter: shippedDshPluginPath/);
});

test('CI only publishes standard/user and archives JSON reports', () => {
	const source = fs.readFileSync(path.join(ROOT, '.ci/package-win-exe.yml'), 'utf8');
	assert.match(source, /SAROS_PACK_MODE:\s*\n\s*value: standard/);
	assert.match(source, /SAROS_SETUP_TARGETS:\s*\n\s*value: user\s*\n\s*allow-modify-at-startup: false/);
	assert.match(source, /SAROS_MAX_EXE_MB:/);
	assert.match(source, /SAROS_MAX_EXE_GROWTH_PERCENT:/);
	assert.match(source, /SAROS_MAX_UPLOAD_MB:\s*\n\s*value: '2048'/);
	assert.match(source, /SAROS_MEDIA_MODE:\s*\n\s*value: external/);
	// 2026-11-21：Office 改为随包，组件不再依赖自有服务器；只有显式改回 1 才裁剪。
	assert.match(source, /VSSAROS_SKIP_OFFICE_RUNTIME:\s*\n\s*value: '0'/);
	assert.match(source, /SAROS_PACK_BASELINE_REPORT:/);
	assert.match(source, /SAROS_RELEASE_DOWNLOAD_BASE_URL:/);
	assert.match(source, /filePath: \.build\/pack-reports\/\*\*\/\*\.json/);
	// 复用构建机工作区时，checkout 的 -x clean 会删除 node_modules/.build/dsh-runtime，
	// 实测占用 11m41s；应改由 align-workspace 的 git clean -fd 保留 ignored 缓存。
	assert.match(source, /enableGitClean: false/);
	assert.match(source, /enableGitCleanIgnore: false/);
	assert.match(source, /align-workspace\.ps1/);
});

test('prepack pins compatible official tools, disables optional peer auto-install, and keeps final config portable', () => {
	const source = fs.readFileSync(path.join(ROOT, 'build/prepack-dsh-runtime.mjs'), 'utf8');
	const seed = fs.readFileSync(path.join(ROOT, 'build/saros/seed-package.mjs'), 'utf8');
	assert.equal(SEED_GENERATOR_REVISION, 4);
	assert.match(seed, /SEED_GENERATOR_REVISION = 4/);
	assert.match(source, /pnpm_config_package_import_method: 'copy'/);
	assert.match(source, /pnpm_config_node_linker: 'hoisted'/);
	assert.match(source, /pnpm_config_auto_install_peers: 'false'/);
	assert.match(source, /pnpm_config_strict_peer_dependencies: 'false'/);
	assert.match(source, /pnpm_config_verify_deps_before_run: 'false'/);
	assert.doesNotMatch(source, /[\s,{]npm_config_package_import_method:/);
	assertOrdered(source, "pnpm_config_package_import_method: 'copy'", "dsh(['--profile', 'vssaros', '--from-default-profile'");
	assert.equal([...source.matchAll(/'packageImportMethod: copy'/g)].length, 2);
	assert.equal([...source.matchAll(/'nodeLinker: hoisted'/g)].length, 2);
	assert.equal([...source.matchAll(/'autoInstallPeers: false'/g)].length, 2);
	assert.equal([...source.matchAll(/'overrides:'/g)].length, 2);
	assert.equal([...source.matchAll(/@deepseek-ai\/dsh-tools/g)].length, 2);
	assert.match(source, /\$\{dshVersion\}/);
	const finalStart = source.indexOf("'# Shipped seed policy");
	const finalEnd = source.indexOf("].join('\\n')", finalStart);
	assert.ok(finalStart > 0 && finalEnd > finalStart);
	const finalBlock = source.slice(finalStart, finalEnd);
	assert.doesNotMatch(finalBlock, /dangerouslyAllowAllBuilds/);
	assert.match(finalBlock, /'autoInstallPeers: false'/);
	assert.match(finalBlock, /'overrides:'/);
	assert.match(finalBlock, /@deepseek-ai\/dsh-tools/);
});

test('seed preflight rejects partial/mismatched seeds and checks every registered plugin', t => {
	const f = fixture(t);
	const bundled = '0.2.2-rc.2';
	const prefix = `repo/dsh-runtime/${bundled}/profile-seed`;
	f.write('repo/dsh-plugins/dsh-compat.json', JSON.stringify({ bundled }));
	assert.throws(() => checkBundledSeed(f.repo), /ENOENT/);
	f.write(`repo/dsh-runtime/${bundled}/node_modules/@deepseek-ai/dsh/lib/bin.js`, 'runtime-entry');
	f.write(`${prefix}/profiles/vssaros/package.json`, '{}');
	const safeWorkspace = [
		'autoInstallPeers: false',
		'strictPeerDependencies: false',
		'verifyDepsBeforeRun: false',
		'packageImportMethod: copy',
		'nodeLinker: hoisted',
		'overrides:',
		`  "@deepseek-ai/dsh-tools": "${bundled}"`,
		'allowBuilds:',
		'  koffi: true',
		'',
	].join('\n');
	const workspaceFile = f.write(`${prefix}/profiles/vssaros/pnpm-workspace.yaml`, safeWorkspace);
	const plugins = { '@vssaros/dsh-foundation': '0.2.7', '@vssaros/dsh-bridge': '0.2.50', '@deepseek-ai/dsh-web-app': bundled };
	const marker = { generatorRevision: SEED_GENERATOR_REVISION, dsh: bundled, plugins };
	const markerFile = f.write(`${prefix}/seed.json`, JSON.stringify(marker));
	assert.throws(() => checkBundledSeed(f.repo), /ENOENT/);
	for (const [name, version] of Object.entries(plugins)) {
		f.write(`${prefix}/profiles/vssaros/node_modules/${name}/package.json`, JSON.stringify({ name, version }));
	}
	assert.deepEqual(checkBundledSeed(f.repo), { bundled, plugins: 3 });
	fs.writeFileSync(workspaceFile, `${safeWorkspace}\ndangerouslyAllowAllBuilds: true\n`);
	assert.throws(() => checkBundledSeed(f.repo), /workspace/);
	fs.writeFileSync(workspaceFile, safeWorkspace.replace('autoInstallPeers: false', 'autoInstallPeers: true'));
	assert.throws(() => checkBundledSeed(f.repo), /workspace/);
	fs.writeFileSync(workspaceFile, safeWorkspace.replace('nodeLinker: hoisted\n', ''));
	assert.throws(() => checkBundledSeed(f.repo), /workspace/);
	fs.writeFileSync(workspaceFile, safeWorkspace);
	fs.writeFileSync(markerFile, JSON.stringify({ ...marker, generatorRevision: 0 }));
	assert.throws(() => checkBundledSeed(f.repo), /different runtime/);
	fs.writeFileSync(markerFile, JSON.stringify(marker));
	const repositoryPlugin = f.write('repo/dsh-plugins/new-plugin/package.json', JSON.stringify({ name: '@vssaros/new-plugin', version: '1.0.0' }));
	assert.throws(() => checkBundledSeed(f.repo), /repository plugin/);
	fs.unlinkSync(repositoryPlugin);
	f.write(`${prefix}/profiles/vssaros/node_modules/@vssaros/dsh-bridge/package.json`, JSON.stringify({ name: '@vssaros/dsh-bridge', version: 'old' }));
	assert.throws(() => checkBundledSeed(f.repo), /does not match/);
	fs.writeFileSync(markerFile, JSON.stringify({ ...marker, dsh: '0.1.0' }));
	assert.throws(() => checkBundledSeed(f.repo), /different runtime/);
	fs.writeFileSync(markerFile, JSON.stringify({ ...marker, plugins: {} }));
	assert.throws(() => checkBundledSeed(f.repo), /incomplete/);
	fs.writeFileSync(markerFile, JSON.stringify({ ...marker, plugins: { '@vssaros/dsh-foundation': '0.2.7' } }));
	assert.throws(() => checkBundledSeed(f.repo), /missing a required plugin/);
	fs.writeFileSync(markerFile, JSON.stringify({ ...marker, plugins: { ...plugins, '../../outside': '1' } }));
	assert.throws(() => checkBundledSeed(f.repo), /does not match|Invalid plugin identity/);
});

test('CI seed preflight must stop before Office preparation when prepack only warns', () => {
	const source = fs.readFileSync(path.join(ROOT, '.ci/scripts/package-vscode.ps1'), 'utf8');
	assertOrdered(source, 'node build/prepack-dsh-runtime.mjs', 'pack-optimization.mjs --check-seed');
	assertOrdered(source, 'pack-optimization.mjs --check-seed', 'node build/prepare-office-runtime.mjs');
	const check = source.indexOf('pack-optimization.mjs --check-seed');
	assert.match(source.slice(check, check + 240), /if \(\$LASTEXITCODE -ne 0\).*exit 1/);
});

test('gulp plugin packaging includes both agents bundle patches', async t => {
	const f = fixture(t);
	const source = fs.readFileSync(path.join(ROOT, 'build/gulpfile.vscode.ts'), 'utf8');
	const match = /const dshPlugins = gulp\.src\((\[[\s\S]*?\]), \{ base: '\.', allowEmpty: true \}\)/.exec(source);
	assert.ok(match);
	const globs = Array.from(runInNewContext(match[1]));
	const files = ['package.json', 'cordis.patch.yml', 'cordis.presets.yml', 'lib/index.js'];
	for (const file of files) { f.write(`repo/dsh-plugins/vssaros-agents/${file}`); }
	const gulp = (await import('gulp')).default;
	const shipped = [];
	await new Promise((resolve, reject) => {
		gulp.src(globs, { cwd: f.repo, base: f.repo, allowEmpty: true })
			.on('data', file => { if (!file.isDirectory()) { shipped.push(file.relative.replaceAll('\\', '/')); } })
			.on('error', reject)
			.on('end', resolve);
	});
	assert.deepEqual(shipped.sort(), files.map(file => `dsh-plugins/vssaros-agents/${file}`).sort());
});

test('seed archives preserve complete plugin payload and are immutable pnpm inputs', async t => {
	const f = fixture(t);
	const source = path.join(f.repo, 'dsh-plugins/demo');
	f.write('repo/dsh-plugins/demo/package.json', JSON.stringify({ name: '@vssaros/demo', version: '1.0.0', files: ['lib/index.js'] }));
	f.write('repo/dsh-plugins/demo/lib/index.js', 'runtime-module');
	f.write('repo/dsh-plugins/demo/skills/deep/nested/resource.txt', 'needed-at-runtime');
	f.write('repo/dsh-plugins/demo/LICENSE', 'license-text');
	f.write('repo/dsh-plugins/demo/node_modules/dev/index.js', 'excluded');
	const archive = path.join(f.root, 'profile/.vssaros/plugins/demo-1.0.0.tgz');
	await archiveSeedPlugin(source, archive);
	const names = [];
	await tar.t({ file: archive, onReadEntry: entry => names.push(entry.path.replace('/./', '/')) });
	assert.ok(names.includes('package/package.json'));
	assert.ok(names.includes('package/skills/deep/nested/resource.txt'));
	assert.ok(names.includes('package/LICENSE'));
	assert.ok(names.every(name => !name.split('/').includes('node_modules')));
	await assert.rejects(archiveSeedPlugin(source, archive), /already exists/);
	const prepack = fs.readFileSync(path.join(ROOT, 'build/prepack-dsh-runtime.mjs'), 'utf8');
	assert.match(prepack, /await archiveSeedPlugin\(src, archive\)/);
	assert.match(prepack, /marker.generatorRevision === SEED_GENERATOR_REVISION/);
	assert.match(prepack, /generatorRevision: SEED_GENERATOR_REVISION/);
});

test('seed path rewrite synchronizes wanted/current lockfiles and is idempotent', t => {
	const f = fixture(t);
	const profile = path.join(f.root, 'profile');
	const prefix = profile.replace(/\\/g, '/');
	const raw = `file:${prefix}/.vssaros/plugins/demo.tgz\nfile:/other/untouched.tgz\n`;
	for (const relative of SEED_PATH_FILES) { f.write(`profile/${relative}`, raw); }
	assert.equal(relativizeSeedPaths(profile), 3);
	for (const relative of SEED_PATH_FILES) {
		assert.equal(fs.readFileSync(path.join(profile, relative), 'utf8'), 'file:.vssaros/plugins/demo.tgz\nfile:/other/untouched.tgz\n');
	}
	assert.equal(relativizeSeedPaths(profile), 0);
});

test('fresh and reused runtime entry paths discover every unscoped vendored plugin before seed work', async t => {
	const f = fixture(t);
	const source = fs.readFileSync(path.join(ROOT, 'build/prepack-dsh-runtime.mjs'), 'utf8');
	const discoveryStart = source.indexOf('function discoverRepoPluginDirs(');
	const discoveryEnd = source.indexOf('\n}', discoveryStart) + 2;
	assert.ok(discoveryStart > 0 && discoveryEnd > discoveryStart);
	const calls = [...source.slice(0, discoveryEnd).matchAll(/await safeBuildProfileSeed\([^;]+;/g)];
	assert.equal(calls.length, 2, 'must cover existing-runtime and clean-install entry paths');
	const unscopedAt = source.indexOf('const UNSCOPED_VENDORED =');
	assert.ok(unscopedAt >= 0 && unscopedAt < calls[0].index);
	const program = source.slice(0, discoveryEnd)
		.replace(/^#![^\n]*\n/, '')
		.replace(/^import .+;\r?$/gm, '')
		.replaceAll('import.meta.url', "'probe'")
		.replace(/await safeBuildProfileSeed\([^;]+;/g, "return discoverRepoPluginDirs(join(root, 'dsh-plugins'));");
	f.write('repo/dsh-plugins/dsh-compat.json', JSON.stringify({ bundled: '0.2.2-rc.2', versions: [{ version: '0.2.2-rc.2' }] }));
	const names = ['@vssaros/dsh-foundation', '@tt-a1i/archify-dsh', 'dsh-ego-browser', 'dsh-vision-router', 'dsh-better-sidebar'];
	const directories = ['vssaros-foundation', 'vssaros-archify', 'dsh-ego-browser', 'dsh-vision-router', 'dsh-better-sidebar'];
	for (let i = 0; i < names.length; i++) { f.write(`repo/dsh-plugins/${directories[i]}/package.json`, JSON.stringify({ name: names[i], version: '1.0.0' })); }
	f.write('repo/dsh-plugins/not-shipped/package.json', JSON.stringify({ name: 'unapproved-package', version: '1.0.0' }));
	for (const reused of [false, true]) {
		let installed = reused;
		const discover = () => runInNewContext(`(async () => {\n${program}\n})()`, {
			join: path.join, dirname: path.dirname, sep: path.sep, delimiter: path.delimiter,
			fileURLToPath: () => path.join(f.repo, 'build/prepack-dsh-runtime.mjs'),
			readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
			existsSync: candidate => candidate.endsWith(`${path.sep}dsh${path.sep}lib${path.sep}bin.js`) ? installed : fs.existsSync(candidate),
			execFileSync: (_file, args) => { if (args.includes('--version')) { return '0.2.2-rc.2\n'; } installed = true; return ''; },
			patchPiAiUsage() {}, prune() {}, dirSize: () => 0,
			process: { argv: [], platform: 'win32', execPath: 'node.exe', exit: () => { throw new Error('unexpected early exit'); } },
			console: { log() {}, error() {} },
		});
		const result = await discover();
		assert.equal(result.length, names.length);
		assert.equal(path.basename(result[0]), 'vssaros-foundation');
		assert.deepEqual(Array.from(result, directory => JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name).sort(), [...names].sort());
		const broken = f.write('repo/dsh-plugins/broken/package.json', '{invalid-json');
		await assert.rejects(discover(), { name: 'SyntaxError' });
		fs.unlinkSync(broken);
	}
});

test('Windows CI executable steps use ASCII names and explicit UTF8 charset', () => {
	const source = fs.readFileSync(path.join(ROOT, '.ci/package-win-exe.yml'), 'utf8');
	const steps = source.split(/\n\s{6}-\s/).slice(1).filter(block => /\n\s+run:/.test(block));
	assert.equal(steps.length, 15);
	for (const step of steps) {
		const name = /(?:^|\n)\s*name: ([^\r\n]+)/.exec(step)?.[1];
		assert.ok(name && /^[\x00-\x7f]+$/.test(name), 'step name must not inject GBK-sensitive bytes');
		assert.match(step, /charsetType: UTF_8/);
		assert.match(step, /shell: powershell/);
		assert.match(step, /continue-on-error: false/);
		const run = step.match(/run: \|\r?\n((?:          [^\r\n]*\r?\n)+)/)?.[1]?.replace(/^          /gm, '').trim();
		assert.ok(run, `${name}: missing multiline PowerShell wrapper`);
		assert.match(run, /^powershell -ExecutionPolicy Bypass -File [^\r\n]+\.ps1\r?\nexit \$LASTEXITCODE$/);
	}
});

test('all Windows pipeline PowerShell wrappers preserve child success and failure', { skip: process.platform !== 'win32' }, async () => {
	const source = fs.readFileSync(path.join(ROOT, '.ci/package-win-exe.yml'), 'utf8');
	const steps = source.split(/\n\s{6}-\s/).slice(1).filter(block => /\n\s+run:/.test(block));
	assert.equal(steps.length, 15);
	const cases = steps.flatMap(step => {
		const run = step.match(/run: \|\r?\n((?:          [^\r\n]*\r?\n)+)/)?.[1]?.replace(/^          /gm, '');
		assert.ok(run);
		return [0, 23].map(code => ({ run, code }));
	});
	await checkPowerShellWrappers(cases);
});

test('PowerShell target CLI output is ASCII-only and contains no localization fields', () => {
	const cli = path.join(ROOT, 'build/saros/pack-optimization.mjs');
	for (const [flag, targets, expected] of [['--targets-json', 'user', 1], ['--all-targets-json', 'user', 1]]) {
		const result = spawnSync(process.execPath, [cli, flag], {
			cwd: ROOT, env: { ...process.env, SAROS_PACK_MODE: 'offline', SAROS_SETUP_TARGETS: targets }, encoding: 'utf8', timeout: 30000,
		});
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.doesNotMatch(result.stdout, /[^\x00-\x7f]/);
		const assets = JSON.parse(result.stdout);
		assert.equal(assets.length, expected);
		for (const asset of assets) { assert.deepEqual(Object.keys(asset).sort(), ['platform', 'rel', 'target']); }
	}
});

test('PowerShell 5.1 parses the actual target CLI output without mojibake', { skip: process.platform !== 'win32' }, () => {
	const cli = path.join(ROOT, 'build/saros/pack-optimization.mjs').replace(/'/g, "''");
	const node = process.execPath.replace(/'/g, "''");
	const script = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Expected Windows PowerShell 5.1' }
$assetsJson = & '${node}' '${cli}' --targets-json
if ($LASTEXITCODE -ne 0) { throw 'Target CLI failed' }
$assetsText = [string]::Join([Environment]::NewLine, [string[]]$assetsJson)
$setupAssets = ConvertFrom-Json -InputObject $assetsText
if (@($setupAssets).Count -ne 1 -or @($setupAssets)[0].target -ne 'user' -or @($setupAssets)[0].PSObject.Properties.Name -contains 'kind') { throw 'ASCII target JSON regression' }
$env:SAROS_SETUP_TARGETS = 'user'
$singleJson = & '${node}' '${cli}' --targets-json
if ($LASTEXITCODE -ne 0) { throw 'Single-target CLI failed' }
$singleText = [string]::Join([Environment]::NewLine, [string[]]$singleJson)
$singleAssets = ConvertFrom-Json -InputObject $singleText
if (@($singleAssets).Count -ne 1 -or @($singleAssets)[0].target -ne 'user') { throw 'Single-target JSON regression' }
Write-Output 'PS51_ASCII_TARGETS_OK'
`;
	const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
		cwd: ROOT, env: { ...process.env, SAROS_PACK_MODE: 'offline', SAROS_SETUP_TARGETS: 'user' }, encoding: 'utf8', timeout: 30000,
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.match(result.stdout, /PS51_ASCII_TARGETS_OK/);
});

test('EXE generation hard gate and target parsing fail closed after earlier stage errors', () => {
	const generate = fs.readFileSync(path.join(ROOT, '.ci/scripts/generate-exe.ps1'), 'utf8');
	const upload = fs.readFileSync(path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1'), 'utf8');
	const whisper = fs.readFileSync(path.join(ROOT, '.ci/scripts/bundle-whisper.ps1'), 'utf8');
	assertOrdered(generate, '--check-seed', 'node --test');
	assertOrdered(generate, '--check-staging', 'node --test');
	assertOrdered(generate, '--check-model', 'node --test');
	assertOrdered(generate, 'staging-verified.json', 'node --test');
	assert.match(generate, /Staging verification receipt is stale/);
	const verify = fs.readFileSync(path.join(ROOT, '.ci/scripts/verify-staging.ps1'), 'utf8');
	assert.match(verify, /Staging verification receipt written/);
	assert.doesNotMatch(verify, /kb-feishu-sync|kb-build/);
	const strip = fs.readFileSync(path.join(ROOT, 'build/saros/strip-before-pack.mjs'), 'utf8');
	assert.match(strip, /SAROS_MEDIA_MODE === 'external'/);
	assert.match(strip, /VSSAROS_SKIP_OFFICE_RUNTIME/);
	const media = fs.readFileSync(path.join(ROOT, '.ci/scripts/bundle-ffmpeg.ps1'), 'utf8');
	assert.match(media, /SAROS_MEDIA_MODE -eq 'external'/);
	assert.match(generate, /--test-timeout=\d+/);
	assert.match(generate, /--test-concurrency=1/);
	assert.match(generate, /try \{ \$setupAssets = ConvertFrom-Json/);
	assert.match(generate, /Assert-SetupAssets \$setupAssets \$expectedTargetCount/);
	assert.match(upload, /try \{ \$setupAssets = ConvertFrom-Json/);
	assert.match(upload, /Exactly one user installer is required/);
	assert.match(upload, /\$maxUploadMB = 2048/);
	assert.match(upload, /\[int\]::TryParse\(\$env:SAROS_MAX_UPLOAD_MB/);
	assert.match(upload, /\$uploadLimitText = \[string\]\$maxUploadMB/);
	assertOrdered(whisper, '--check-staging', '$stagingBin');
});

test('product installer entry points reject system before any build or manifest write', { skip: process.platform !== 'win32' }, () => {
	for (const [file, parameter, value] of [['deploy-package/scripts/build-installer.ps1', '-BuildType', 'system'], ['.ci/scripts/pack-dsh-only.ps1', '-Target', 'system'], ['deploy-package/scripts/update-manifest.ps1', '-Platform', 'win32-x64']]) {
		const source = path.join(ROOT, file).replace(/'/g, "''");
		const script = `$source = [IO.File]::ReadAllText('${source}', [Text.Encoding]::UTF8); & ([scriptblock]::Create($source)) ${parameter} '${value}'`;
		const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /ValidateSet|validation|user|验证/i);
	}
});

function uploadHelpers() {
	const file = path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1').replace(/'/g, "''");
	return `
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Invalid upload script syntax' }
foreach ($name in @('Resolve-UploadCurl', 'ConvertTo-UploadArgument', 'Invoke-UploadCurl')) {
    $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    if (-not $fn) { throw 'Missing upload helper' }
    . ([scriptblock]::Create($fn.Extent.Text))
}
`;
}

test('upload process captures native stdout stderr and exit codes through refs without changing caller preference', { skip: process.platform !== 'win32' }, t => {
	const f = fixture(t);
	const native = f.write('native process/args.cjs', 'process.stdout.write(JSON.stringify(process.argv.slice(3))); process.stderr.write("native warning"); process.exit(Number(process.argv[2]));');
	const slow = f.write('native process/slow.cjs', 'setTimeout(() => process.exit(0), 5000);');
	const script = `
$ErrorActionPreference = 'Stop'
${uploadHelpers()}
$expected = @('', 'space path', '中文', 'quote"value', 'C:\\trailing\\', 'https://example.test/api?a=1&b=2')
foreach ($preference in @('Stop', 'Continue')) {
    foreach ($code in @(0, 55)) {
        $ErrorActionPreference = $preference
        $LASTEXITCODE = 99
        $value = $null
        $stream = @(Invoke-UploadCurl -Executable '${process.execPath.replace(/'/g, "''")}' -Arguments (@('${native.replace(/'/g, "''")}', [string]$code) + $expected) -Result ([ref]$value))
        if ($stream.Count -ne 0) { throw 'Result leaked into success stream' }
        if ($null -eq $value -or $value.ExitCode -ne $code) { throw 'Native exit code lost' }
        if ($value.StandardError -ne 'native warning') { throw 'Native stderr lost' }
        $actual = ConvertFrom-Json -InputObject $value.StandardOutput
        if ($actual.Count -ne $expected.Count) { throw 'Argument count changed' }
        for ($i = 0; $i -lt $actual.Count; $i++) { if ($actual[$i] -ne $expected[$i]) { throw 'Argument quoting changed' } }
        if ($ErrorActionPreference -ne $preference -or $LASTEXITCODE -ne 99) { throw 'Caller state changed' }
    }
}
$value = $null
Invoke-UploadCurl -Executable '${path.join(f.root, 'missing.exe').replace(/'/g, "''")}' -Arguments @() -Result ([ref]$value)
if ($null -eq $value -or $value.ExitCode -ne -1 -or -not $value.StandardError) { throw 'Missing executable not diagnosed' }
Invoke-UploadCurl -Executable '${process.execPath.replace(/'/g, "''")}' -Arguments @('${slow.replace(/'/g, "''")}') -TimeoutSeconds 1 -Result ([ref]$value)
if ($value.ExitCode -ne 28 -or $value.StandardError -notmatch 'timed out') { throw 'Timeout not diagnosed' }
Write-Output 'UPLOAD_NATIVE_PROCESS_OK'
`;
	const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.match(result.stdout, /UPLOAD_NATIVE_PROCESS_OK/);
	const source = fs.readFileSync(path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1'), 'utf8');
	assert.match(source, /-Result \(\[ref\]\$curlResult\)/);
	assert.match(source, /Upload process returned an invalid result/);
	assert.doesNotMatch(source, /\$prevErrorAction/);
});

test('upload output EOF wait expires instead of blocking after process exit', { skip: process.platform !== 'win32' }, () => {
	const script = `
$ErrorActionPreference = 'Stop'
${uploadHelpers()}
$assign = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$outputComplete' }, $true)
$guard = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if (-not $outputComplete)') }, $true)
if (-not $assign -or -not $guard) { throw 'Missing bounded output wait' }
$stdoutTask = (New-Object 'Threading.Tasks.TaskCompletionSource[string]').Task
$stderrTask = (New-Object 'Threading.Tasks.TaskCompletionSource[string]').Task
$remaining = 50
$value = $null
$Result = [ref]$value
$elapsed = [Diagnostics.Stopwatch]::StartNew()
. ([scriptblock]::Create($assign.Extent.Text + [Environment]::NewLine + $guard.Extent.Text))
if ($value.ExitCode -ne 28 -or $value.StandardError -notmatch 'output timed out' -or $elapsed.ElapsedMilliseconds -gt 2000) { throw 'Output EOF wait did not expire' }
Write-Output 'UPLOAD_EOF_BOUND_OK'
`;
	const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.match(result.stdout, /UPLOAD_EOF_BOUND_OK/);
});

test('invalid upload results fail before retrying or recording a receipt', { skip: process.platform !== 'win32' }, () => {
	const script = `
$ErrorActionPreference = 'Stop'
${uploadHelpers()}
$guard = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains('Upload process returned an invalid result') }, $true)
if (-not $guard) { throw 'Missing result validation' }
$curlResult = $null
. ([scriptblock]::Create($guard.Extent.Text))
throw 'Invalid result was accepted'
`;
	const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 1);
	assert.match(result.stdout, /invalid result; retry aborted/);
});

test('PowerShell 5.1 uploads bytes with resolved curl including PATH fallback and reads HTTP status independently of response JSON', { skip: process.platform !== 'win32' }, async t => {
	const f = fixture(t);
	const payload = Buffer.alloc(2 * MIB, 65);
	const installer = f.write('upload path/VsSarosUserSetup.exe', payload);
	const responseFile = path.join(f.root, 'response.json');
	const formatFile = f.write('upload path/status.txt', '\\n%{http_code}');
	let received = 0;
	const server = http.createServer((request, response) => {
		assert.equal(request.method, 'POST');
		assert.equal(request.url, '/admin/upload?platform=user&commit=test');
		assert.equal(request.headers['x-upload-token'], 'fixture-token');
		request.on('data', bytes => { received += bytes.length; });
		request.on('end', () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); });
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
	const url = `http://127.0.0.1:${server.address().port}/admin/upload?platform=user&commit=test`;
	const script = `
$ErrorActionPreference = 'Stop'
${uploadHelpers()}
$env:SAROS_CURL_BIN = ''
$savedRoot = $env:SystemRoot
try {
    foreach ($forceFallback in @($false, $true)) {
        $env:SystemRoot = $savedRoot
        if ($forceFallback) { $env:SystemRoot = '${f.root.replace(/'/g, "''")}' }
        $native = Join-Path $env:SystemRoot 'System32\\curl.exe'
        $expected = if (Test-Path -LiteralPath $native -PathType Leaf) { $native } else { (Get-Command curl.exe -ErrorAction Stop).Source }
        $curl = Resolve-UploadCurl
        if (-not $curl -or $curl -ne $expected) { throw 'Curl resolver did not honor native/PATH availability' }
        $env:SystemRoot = $savedRoot
        $value = $null
        Invoke-UploadCurl -Executable $curl -Arguments @('-q', '-sS', '--globoff', '--noproxy', '*', '-X', 'POST', '-H', 'Expect:', '-H', 'X-Upload-Token: fixture-token', '--upload-file', '${installer.replace(/'/g, "''")}', '-o', '${responseFile.replace(/'/g, "''")}', '-w', '@${formatFile.replaceAll('\\', '/').replace(/'/g, "''")}', '${url}') -Result ([ref]$value)
        if ($null -eq $value -or $value.ExitCode -ne 0 -or $value.StandardOutput.Trim() -ne '200') { throw ('Upload failed: ' + $value.StandardError) }
        if ((Get-Content -Raw '${responseFile.replace(/'/g, "''")}' | ConvertFrom-Json).ok -ne $true) { throw 'Response JSON not preserved' }
        $env:SAROS_CURL_BIN = '  ' + $curl + '  '
        if ((Resolve-UploadCurl) -ne $curl) { throw 'Explicit curl override not honored' }
        $env:SAROS_CURL_BIN = ''
    }
} finally {
    $env:SystemRoot = $savedRoot
}
Write-Output 'UPLOAD_LOOPBACK_OK'
`;
	const result = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 });
	assert.match(result.stdout, /UPLOAD_LOOPBACK_OK/);
	assert.equal(received, 2 * payload.length);
});

test('complete upload script consumes native process results and verifies the receipt before success', { skip: process.platform !== 'win32' }, async t => {
	const f = fixture(t);
	const asset = policy.resolvePackPolicy({}).assets[0];
	const payload = Buffer.alloc(MIB, 66);
	f.write(`repo/${asset.rel}`, payload);
	f.write('repo/product.json', '{"version":"2.2.26285"}');
	const source = fs.readFileSync(path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1'), 'utf8');
	const script = f.write('repo/upload.ps1', '\uFEFF' + source.replace(/^\uFEFF/, ''));
	const targetsJSON = JSON.stringify(policy.shellAssets([asset]));
	assert.match(targetsJSON, /^[\x00-\x7f]+$/, 'Shell target metadata must be ASCII-only');
	const cli = f.write('commands/cli.cjs', [
		'const fs = require("node:fs"); const args = process.argv.slice(2);',
		`if (args.includes('--targets-json')) console.log(${JSON.stringify(targetsJSON)});`,
		'if (args.includes("--record-upload")) { const i = args.indexOf("--record-upload"); if (JSON.parse(fs.readFileSync(args[i + 2], "utf8")).ok !== true) process.exit(1); fs.writeFileSync("verified-upload.json", JSON.stringify({platform:args[i + 1]})); }',
		'if (args.includes("--complete-upload") && !fs.existsSync("verified-upload.json")) process.exit(1);',
	].join('\n'));
	f.write('commands/node.cmd', `@echo off\r\n"${process.execPath}" "${cli}" %*\r\nexit /b %errorlevel%\r\n`);
	f.write('commands/git.cmd', `@echo off\r\nif "%1"=="rev-parse" (echo ${'a'.repeat(40)}) else (echo 42)\r\nexit /b 0\r\n`);
	let received = 0;
	const server = http.createServer((request, response) => {
		assert.equal(request.method, 'POST');
		assert.equal(request.headers['x-upload-token'], 'fixture-token');
		request.on('data', bytes => { received += bytes.length; });
		request.on('end', () => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); });
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
	for (const codePage of [65001, 936]) {
		const wrapper = `$OutputEncoding = [Text.Encoding]::GetEncoding(${codePage}); [Console]::OutputEncoding = $OutputEncoding; Set-Location '${f.repo.replace(/'/g, "''")}'; [Environment]::CurrentDirectory = '${f.root.replace(/'/g, "''")}'; & '${script.replace(/'/g, "''")}'; exit $LASTEXITCODE`;
		const result = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')], {
			cwd: f.root, encoding: 'utf8', timeout: 30000,
			env: { ...process.env, PATH: `${path.join(f.root, 'commands')}${path.delimiter}${process.env.PATH ?? ''}`, SAROS_CURL_BIN: '', SAROS_UPLOAD_TOKEN: 'fixture-token', SAROS_UPDATE_SERVER: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
		});
		assert.match(result.stdout, /Success: 1, Failed: 0/);
		assert.ok(!result.stdout.includes('fixture-token'));
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.repo, 'verified-upload.json'), 'utf8')), { platform: 'win32-x64-user' });
	}
	assert.equal(received, 2 * payload.length);
});

function installerPipelineSteps(file, buildName) {
	const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
	const buildStart = source.indexOf(`name: ${buildName}`);
	assert.ok(buildStart >= 0);
	const buildEnd = source.indexOf('\n      -', buildStart);
	const build = source.slice(buildStart, buildEnd);
	const archiveStart = source.indexOf('name: Archive installers', buildEnd);
	assert.ok(archiveStart >= 0);
	const archiveEnd = source.indexOf('\n      -', archiveStart);
	const archive = source.slice(archiveStart, archiveEnd);
	const run = build.match(/run: \|\r?\n((?:          [^\r\n]*\r?\n)+)/)?.[1]?.replace(/^          /gm, '');
	assert.ok(run, 'Installer step must use a multiline PowerShell wrapper');
	return { build, archive, run };
}

const installerPipelines = [
	['.ci/package-win-exe.yml', 'Generate EXE installers (selected targets)', '.ci/scripts/generate-exe.ps1'],
	['.ci/package-dsh-patch.yml', 'Quick pack (plugins only, no compile)', '.ci/scripts/pack-dsh-only.ps1'],
];

test('installer pipelines propagate build failure and only archive after success', () => {
	for (const [file, buildName, script] of installerPipelines) {
		const { build, archive, run } = installerPipelineSteps(file, buildName);
		assert.match(build, /continue-on-error: false/);
		assert.equal(run.trim(), `powershell -ExecutionPolicy Bypass -File ${script}\nexit $LASTEXITCODE`);
		assert.doesNotMatch(archive, /^\s*if:/m, 'BK-CI archive must use the default previous-success condition');
		assert.match(archive, /continue-on-error: false/);
		assert.match(archive, /filePath: \.build\/win32-x64\/user-setup\/VsSarosUserSetup\.exe/);
	}
});

test('actual installer PowerShell wrappers preserve child exit codes', { skip: process.platform !== 'win32' }, async () => {
	const cases = installerPipelines.flatMap(([file, buildName]) => {
		const { run } = installerPipelineSteps(file, buildName);
		return [0, 7].map(code => ({ run, code }));
	});
	await checkPowerShellWrappers(cases);
});

test('mangler preserves exports from generated files imported by compiled sources', () => {
	const source = fs.readFileSync(path.join(ROOT, 'build/lib/mangle/index.ts'), 'utf8');
	assert.match(source, /'comfyTVStageMeta\.generated'/);
});
