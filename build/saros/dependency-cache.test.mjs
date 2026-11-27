/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const cache = require('./dependency-cache.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'build/saros/dependency-cache.cjs');
const CONTEXT = { node: process.versions.node, modules: process.versions.modules, platform: process.platform, arch: process.arch, electron: '39.8.8', npm: '11.1.0', toolchain: 'msvc-fixture' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-install-cache-'));
	t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const write = (relative, value = 'bytes') => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
		return file;
	};
	write('package.json', { name: 'vssaros', version: '1.0.0', dependencies: {} });
	write('build/package.json', { name: 'build-tools', version: '1.0.0', dependencies: {} });
	write('extensions/demo/package.json', { name: 'demo', version: '1.0.0', dependencies: { tiny: '1.0.0' } });
	write('extensions/demo/package-lock.json', { lockfileVersion: 3, version: '1.0.0', packages: { '': { name: 'demo', version: '1.0.0', dependencies: { tiny: '1.0.0' } }, 'node_modules/tiny': { name: 'tiny', version: '1.0.0', integrity: 'sha512-fixture' } } });
	write('extensions/demo/node_modules/tiny/package.json', { name: 'tiny', version: '1.0.0' });
	write('extensions/demo/node_modules/tiny/index.js', 'same-length-000');
	return { root, write };
}
function run(args, root, env = {}) {
	const environment = { ...process.env, ...env };
	delete environment.NODE_OPTIONS;
	return spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 15000 });
}
function ps(script) {
	return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; try {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 });
}

test('verified layer is reusable; version-only and description changes do not reinstall it', t => {
	const f = fixture(t);
	const key = cache.inputKey(f.root, 'extensions/demo', CONTEXT);
	cache.seal(f.root, 'extensions/demo', key, CONTEXT);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, true);
	f.write('extensions/demo/package.json', { name: 'demo', version: '2.0.0', description: 'changed docs', dependencies: { tiny: '1.0.0' } });
	assert.equal(cache.inputKey(f.root, 'extensions/demo', CONTEXT), key);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, true);
});

test('real dependencies, lock resolutions, npm config, ABI and compiler changes invalidate only matching receipts', t => {
	const f = fixture(t);
	const key = cache.inputKey(f.root, 'extensions/demo', CONTEXT);
	cache.seal(f.root, 'extensions/demo', key, CONTEXT);
	for (const [name, value] of [['node', '99.0.0'], ['modules', '999'], ['electron', '99.0.0'], ['npm', '99.0.0'], ['arch', 'arm64'], ['toolchain', 'other-msvc']]) {
		assert.equal(cache.check(f.root, 'extensions/demo', { ...CONTEXT, [name]: value }).hit, false);
	}
	const lock = JSON.parse(fs.readFileSync(path.join(f.root, 'extensions/demo/package-lock.json')));
	lock.packages['node_modules/tiny'].version = '2.0.0';
	f.write('extensions/demo/package-lock.json', lock);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
	lock.packages['node_modules/tiny'].version = '1.0.0';
	f.write('extensions/demo/package-lock.json', lock);
	f.write('extensions/demo/.npmrc', 'legacy-peer-deps=true');
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
});

test('file dependency product versions are ignored but their dependency identities are retained', t => {
	const f = fixture(t);
	f.write('extensions/demo/package.json', { name: 'demo', dependencies: { vssaros: 'file:../..' } });
	f.write('extensions/demo/package-lock.json', { packages: { '': { name: 'demo' }, '../..': { name: 'vssaros', version: '1.0.0', dependencies: {} } } });
	const key = cache.inputKey(f.root, 'extensions/demo', CONTEXT);
	f.write('package.json', { name: 'vssaros', version: '2.0.0', dependencies: {} });
	f.write('extensions/demo/package-lock.json', { packages: { '': { name: 'demo' }, '../..': { name: 'vssaros', version: '2.0.0', dependencies: {} } } });
	assert.equal(cache.inputKey(f.root, 'extensions/demo', CONTEXT), key);
	f.write('package.json', { name: 'vssaros', version: '2.0.0', dependencies: { changed: '1.0.0' } });
	assert.notEqual(cache.inputKey(f.root, 'extensions/demo', CONTEXT), key);
});

test('same-size same-mtime corruption, missing files and unexpected files invalidate cache', t => {
	const f = fixture(t);
	const file = path.join(f.root, 'extensions/demo/node_modules/tiny/index.js');
	const key = cache.inputKey(f.root, 'extensions/demo', CONTEXT);
	cache.seal(f.root, 'extensions/demo', key, CONTEXT);
	const time = fs.statSync(file).mtime;
	f.write('extensions/demo/node_modules/tiny/index.js', 'same-length-111');
	fs.utimesSync(file, time, time);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
	f.write('extensions/demo/node_modules/tiny/index.js', 'same-length-000');
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, true);
	fs.unlinkSync(file);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
	f.write('extensions/demo/node_modules/tiny/index.js', 'same-length-000');
	f.write('extensions/demo/node_modules/tiny/unexpected.js');
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
});

test('partial installs, empty native binaries and malformed receipts cannot be sealed or reused', t => {
	const f = fixture(t);
	const key = cache.inputKey(f.root, 'extensions/demo', CONTEXT);
	fs.unlinkSync(path.join(f.root, 'extensions/demo/node_modules/tiny/package.json'));
	assert.throws(() => cache.seal(f.root, 'extensions/demo', key, CONTEXT), /not installed/);
	f.write('extensions/demo/node_modules/tiny/package.json', { name: 'tiny', version: '1.0.0' });
	f.write('extensions/demo/node_modules/tiny/broken.node', '');
	assert.throws(() => cache.seal(f.root, 'extensions/demo', key, CONTEXT), /Empty native/);
	f.write(`extensions/demo/node_modules/${cache.RECEIPT}`, 'broken-json');
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
});

test('cache discovery never descends into modules, generated outputs or junctions', t => {
	const f = fixture(t);
	f.write('extensions/demo/node_modules/fake/package.json', '{}');
	f.write('extensions/demo/out/package.json', '{}');
	f.write('.vscode/extensions/dev/package.json', '{}');
	fs.symlinkSync(f.root, path.join(f.root, 'extensions/demo/node_modules/vssaros'), 'junction');
	assert.deepEqual(cache.scopes(f.root).sort(), ['', '.vscode/extensions/dev', 'build', 'extensions/demo']);
	cache.seal(f.root, 'extensions/demo', cache.inputKey(f.root, 'extensions/demo', CONTEXT), CONTEXT);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, true);
});

test('invalidated cleanup removes junctions themselves and preserves every target', async t => {
	const f = fixture(t);
	const outside = f.write('outside/keep.txt', 'KEEP');
	fs.symlinkSync(path.dirname(outside), path.join(f.root, 'extensions/demo/node_modules/linked'), 'junction');
	await cache.clean(f.root, 'extensions/demo');
	assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP');
	assert.equal(fs.existsSync(path.join(f.root, 'extensions/demo/node_modules')), false);
	for (const relative of ['../outside', '/tmp', 'extensions/../outside', 'extensions\\demo']) {
		await assert.rejects(cache.clean(f.root, relative), /Invalid dependency scope/);
	}
});

test('linked scopes, dependency roots and receipts are rejected', async t => {
	const f = fixture(t);
	cache.seal(f.root, 'extensions/demo', cache.inputKey(f.root, 'extensions/demo', CONTEXT), CONTEXT);
	const receipt = path.join(f.root, 'extensions/demo/node_modules', cache.RECEIPT);
	const other = f.write('other-receipt.json', fs.readFileSync(receipt));
	fs.unlinkSync(receipt);
	if (process.platform !== 'win32') {
		fs.symlinkSync(other, receipt);
		assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, false);
	}
	fs.symlinkSync(path.join(f.root, 'extensions/demo'), path.join(f.root, 'extensions/linked'), 'junction');
	assert.throws(() => cache.inputKey(f.root, 'extensions/linked', CONTEXT), /Linked dependency scope/);
});

test('only successful completed layers get receipts; failed or skipped layers remain cold', t => {
	const f = fixture(t);
	f.write('extensions/failure/package.json', '{}');
	const entries = ['extensions/demo', 'extensions/failure'].map(relative => ({ relative, key: cache.inputKey(f.root, relative, CONTEXT), hit: false, completed: relative.endsWith('demo') }));
	const plan = f.write('plan.json', { context: CONTEXT, entries });
	const result = run(['--seal', plan], f.root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(cache.check(f.root, 'extensions/demo', CONTEXT).hit, true);
	assert.equal(fs.existsSync(path.join(f.root, 'extensions/failure/node_modules', cache.RECEIPT)), false);
});

test('root native layer cannot be sealed without its target Electron', t => {
	const f = fixture(t);
	assert.throws(() => cache.seal(f.root, '', cache.inputKey(f.root, '', CONTEXT), CONTEXT), /Electron unavailable/);
	assert.equal(fs.existsSync(path.join(f.root, 'node_modules', cache.RECEIPT)), false);
});

test('wrong Node runtime is rejected by the real native probe before module loading', t => {
	const f = fixture(t);
	const result = run(['--probe', 'build', '999.0.0'], f.root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Wrong build Node runtime/);
	const electron = run(['--probe', '', '39.8.8'], f.root);
	assert.equal(electron.status, 1);
	assert.match(electron.stderr, /Wrong target Electron runtime/);
});

test('hot and dependency-change plans remain isolated by layer and a forced install cannot hit cache', t => {
	const f = fixture(t);
	const env = { npm_config_target: CONTEXT.electron, SAROS_DEPENDENCY_NPM: CONTEXT.npm, SAROS_DEPENDENCY_TOOLCHAIN: CONTEXT.toolchain };
	const cold = JSON.parse(run(['--plan'], f.root, env).stdout);
	assert.ok(cold.entries.every(entry => !entry.hit));
	const plan = f.write('plan.json', { ...cold, entries: cold.entries.map(entry => ({ ...entry, completed: entry.relative === 'extensions/demo' })) });
	assert.equal(run(['--seal', plan], f.root, env).status, 0);
	const hot = JSON.parse(run(['--plan'], f.root, env).stdout);
	assert.equal(hot.entries.find(entry => entry.relative === 'extensions/demo').hit, true);
	f.write('build/.npmrc', 'runtime=node');
	assert.equal(JSON.parse(run(['--plan'], f.root, env).stdout).entries.find(entry => entry.relative === 'extensions/demo').hit, true);
	const forced = JSON.parse(run(['--plan'], f.root, { ...env, SAROS_INSTALL_CACHE: '0' }).stdout);
	assert.ok(forced.entries.every(entry => !entry.hit));
});

test('vendored ripgrep verifies hash, platform, PE identity and executable version before copying', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, t => {
	const f = fixture(t);
	const bytes = Buffer.alloc(256);
	bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt16LE(0x8664, 68);
	const manifest = { platform: process.platform, arch: process.arch, size: bytes.length, sha256: hash(bytes), version: 'ripgrep fixture' };
	f.write('build/saros/bin/rg.exe', bytes);
	f.write('build/saros/bin/rg-manifest.json', manifest);
	let calls = 0;
	const execute = (_file, args, options) => { calls++; assert.deepEqual(args, ['--version']); assert.equal(options.timeout, 5000); return { status: 0, stdout: 'ripgrep fixture\n' }; };
	cache.restoreRipgrep(f.root, execute);
	assert.deepEqual(fs.readFileSync(path.join(f.root, 'node_modules/@vscode/ripgrep/bin/rg.exe')), bytes);
	bytes[200] = 1;
	f.write('build/saros/bin/rg.exe', bytes);
	assert.throws(() => cache.restoreRipgrep(f.root, execute), /identity mismatch/);
	assert.equal(calls, 1);
	bytes[200] = 0;
	f.write('build/saros/bin/rg.exe', bytes);
	assert.throws(() => cache.restoreRipgrep(f.root, () => ({ status: 0, stdout: 'wrong version' })), /smoke failed/);
});

test('vendored ripgrep refuses a linked destination directory', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, t => {
	const f = fixture(t);
	f.write('build/saros/bin/rg.exe', fs.readFileSync(path.join(ROOT, 'build/saros/bin/rg.exe')));
	f.write('build/saros/bin/rg-manifest.json', fs.readFileSync(path.join(ROOT, 'build/saros/bin/rg-manifest.json')));
	f.write('outside/keep.txt', 'KEEP');
	fs.mkdirSync(path.join(f.root, 'node_modules'), { recursive: true });
	fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'node_modules/@vscode'), 'junction');
	assert.throws(() => cache.restoreRipgrep(f.root, () => ({ status: 0, stdout: JSON.parse(fs.readFileSync(path.join(ROOT, 'build/saros/bin/rg-manifest.json'))).version })), /Linked ripgrep/);
	assert.equal(fs.existsSync(path.join(f.root, 'outside/ripgrep')), false);
});

test('PowerShell cache adapter preserves root empty arguments and exposes a scalar hit', { skip: process.platform !== 'win32' }, t => {
	const f = fixture(t);
	const helper = path.join(ROOT, '.ci/scripts/dependency-cache.ps1').replace(/'/g, "''");
	const result = ps(`
. '${helper}'
$script:dependencyEntries = @{ '' = [pscustomobject]@{hit=$true;reason='verified';completed=$false} }
$value = @(Test-DependencyLayer -Relative '')
if ($value.Count -ne 1 -or $value[0] -isnot [bool] -or -not $value[0]) { throw 'Hit polluted by logging output' }
Complete-DependencyLayer -Relative ''
if (-not $script:dependencyEntries[''].completed) { throw 'Root completion missing' }
$script:dependencyCacheTool = '${CLI.replace(/'/g, "''")}'
Set-Location '${f.root.replace(/'/g, "''")}'
Clear-DependencyLayer -Relative ''
Write-Output 'CACHE_ADAPTER_OK'
`);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /CACHE_ADAPTER_OK/);
});

test('PowerShell initializes and seals a cold layer, then hot planning makes no install or clean call', { skip: process.platform !== 'win32' }, t => {
	const f = fixture(t);
	f.write('build/saros/dependency-cache.cjs', fs.readFileSync(CLI));
	const helper = path.join(ROOT, '.ci/scripts/dependency-cache.ps1').replace(/'/g, "''");
	const result = ps(`
. '${helper}'
function npm { Write-Output '11.1.0'; $global:LASTEXITCODE = 0 }
function python { Write-Output 'Python 3.10.7'; $global:LASTEXITCODE = 0 }
Set-Location '${f.root.replace(/'/g, "''")}'
$env:npm_config_target = '39.8.8'
Initialize-DependencyCache -RepoRoot $pwd.Path
if (Test-DependencyLayer -Relative 'extensions/demo') { throw 'Cold layer hit' }
Complete-DependencyLayer -Relative 'extensions/demo'
Save-DependencyCache
if (Test-Path -LiteralPath $script:dependencyPlanFile) { throw 'Transient plan not cleaned' }
Initialize-DependencyCache -RepoRoot $pwd.Path
if (-not (Test-DependencyLayer -Relative 'extensions/demo')) { throw 'Verified layer missed' }
$env:SAROS_INSTALL_CACHE = '0'
Initialize-DependencyCache -RepoRoot $pwd.Path
if (Test-DependencyLayer -Relative 'extensions/demo') { throw 'Disabled cache hit' }
Write-Output 'PS51_CACHE_ROUNDTRIP_OK'
`);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /PS51_CACHE_ROUNDTRIP_OK/);
});

test('actual build layer uses host Node and restores Electron target, while hot cache skips both npm calls', { skip: process.platform !== 'win32' }, t => {
	const f = fixture(t);
	const file = path.join(ROOT, '.ci/scripts/install-deps.ps1').replace(/'/g, "''");
	const result = ps(`
Set-Location '${f.root.replace(/'/g, "''")}'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
$stage=$ast.Find({param($n) $n -is [System.Management.Automation.Language.TryStatementAst] -and $n.Extent.Text.Contains('$buildCacheHit = Test-DependencyLayer')},$true)
if (-not $stage) { throw 'Build cache stage missing' }
$script:hit=$false; $script:installs=0; $script:cleans=0
function Test-DependencyLayer {param($Relative); return $script:hit}
function Clear-DependencyLayer {param($Relative); if($Relative -ne 'build'){throw 'Wrong clean scope'}; $script:cleans++}
function Complete-DependencyLayer {param($Relative)}
function node {Write-Output '${process.versions.node}'; $global:LASTEXITCODE=0}
function npm {
  if($env:npm_config_runtime -ne 'node' -or $env:npm_config_target -ne '${process.versions.node}') {throw 'Electron target leaked into build'}
  $script:installs++; $global:LASTEXITCODE=0
}
$env:npm_config_runtime='electron'; $env:npm_config_target='39.8.8'; $env:npm_config_disturl='https://electronjs.org/headers'
. ([scriptblock]::Create($stage.Extent.Text))
if($script:installs -ne 2 -or $script:cleans -ne 1){throw 'Cold build install/rebuild missing'}
if($env:npm_config_runtime -ne 'electron' -or $env:npm_config_target -ne '39.8.8'){throw 'Caller runtime not restored'}
$script:hit=$true
. ([scriptblock]::Create($stage.Extent.Text))
if($script:installs -ne 2 -or $script:cleans -ne 1){throw 'Hot build did not skip install'}
Write-Output 'PS51_BUILD_ABI_CACHE_OK'
`);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /PS51_BUILD_ABI_CACHE_OK/);
});

test('install wiring skips verified root install/rebuild and prefers validated rg before network', () => {
	const source = fs.readFileSync(path.join(ROOT, '.ci/scripts/install-deps.ps1'), 'utf8');
	assert.match(source, /\$rootInstallOk = \$rootCacheHit/);
	assert.match(source, /\$nativeOk = \$rootCacheHit/);
	assert.equal((source.match(/-not \$rootCacheHit -and \$attempt -le 3/g) || []).length, 2);
	assert.ok(source.indexOf('dependency-cache.cjs --rg') < source.indexOf('ripgrep/lib/postinstall.js'));
	assert.ok(!source.includes('Copy-Item $vendoredRg'));
	assert.match(source, /if \(Test-DependencyLayer -Relative \$relative\) \{ continue \}/);
	assert.ok(source.indexOf('Save-DependencyCache') > source.indexOf('Assert-ExtensionBuildDependencies'));
});
