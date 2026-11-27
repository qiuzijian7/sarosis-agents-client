/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXTENSION_BUILD_FILES = [
	'extensions/markdown-math/node_modules/@types/node/index.d.ts',
	'extensions/markdown-math/node_modules/undici-types/index.d.ts',
	'extensions/markdown-math/node_modules/@types/markdown-it/index.d.ts',
	'extensions/mermaid-chat-features/node_modules/@types/node/index.d.ts',
	'extensions/mermaid-chat-features/node_modules/undici-types/index.d.ts',
	'extensions/mermaid-chat-features/node_modules/@vscode/codicons/dist/codicon.css',
	'extensions/mermaid-chat-features/node_modules/@vscode/codicons/dist/codicon.ttf',
	'extensions/mermaid-chat-features/node_modules/dompurify/dist/purify.es.mjs',
	'extensions/mermaid-chat-features/node_modules/dompurify/dist/purify.es.d.mts',
	'extensions/mermaid-chat-features/node_modules/dompurify/dist/purify.cjs.js',
	'extensions/mermaid-chat-features/node_modules/dompurify/dist/purify.cjs.d.ts',
	'dsh-plugins/vssaros-pele/assets/pele.global.js',
];

function extensionDependencyFixture(t, missing) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-extension-deps-'));
	t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const write = (relative, content = 'keep') => {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		return target;
	};
	write('repo/.ci/scripts/extension-dependencies.ps1', fs.readFileSync(path.join(ROOT, '.ci/scripts/extension-dependencies.ps1'), 'utf8'));
	for (const file of EXTENSION_BUILD_FILES) { if (file !== missing) { write(`repo/${file}`); } }
	return { root, write, repo: path.join(root, 'repo') };
}

function runPowerShell(script, timeout = 15000) {
	const wrapped = `$ErrorActionPreference = 'Stop'; try {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
	return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')], { encoding: 'utf8', timeout });
}

function assertOrdered(source, first, second) {
	const a = source.indexOf(first);
	const b = source.indexOf(second);
	assert.ok(a >= 0 && b >= 0 && a < b, `${first}@${a}, ${second}@${b}`);
}

test('required extension preflight rejects local missing or empty files even when root types exist', { skip: process.platform !== 'win32' }, t => {
	const cases = [undefined, ...EXTENSION_BUILD_FILES].map(missing => {
		const f = extensionDependencyFixture(t, missing);
		f.write('repo/node_modules/@types/node/index.d.ts');
		return { root: f.repo, missing: missing?.replace(/\//g, '\\') ?? null };
	});
	const empty = extensionDependencyFixture(t);
	empty.write(`repo/${EXTENSION_BUILD_FILES[3]}`, '');
	cases.push({ root: empty.repo, missing: EXTENSION_BUILD_FILES[3].replace(/\//g, '\\') });
	const helper = path.join(empty.repo, '.ci/scripts/extension-dependencies.ps1').replace(/'/g, "''");
	const result = runPowerShell(`
. '${helper}'
$cases = ConvertFrom-Json '${JSON.stringify(cases).replace(/'/g, "''")}'
foreach ($case in $cases) {
  $caught = $null
  try { Assert-ExtensionBuildDependencies -RepoRoot $case.root } catch { $caught = $_ }
  if ($case.missing) {
    if (-not $caught -or -not $caught.Exception.Message.Contains($case.missing)) { throw ('Missing dependency was accepted: ' + $case.missing) }
  } elseif ($caught) { throw $caught }
}
Write-Output ('DEPENDENCY_CASES_OK=' + $cases.Count)
`);
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	assert.match(result.stdout, /DEPENDENCY_CASES_OK=14/);
});

test('required extension install retries finitely, includes dev dependencies and restores location', { skip: process.platform !== 'win32' }, t => {
	const f = extensionDependencyFixture(t);
	const directory = f.write('repo/required extension/package.json', '{}');
	const helper = path.join(f.repo, '.ci/scripts/extension-dependencies.ps1').replace(/'/g, "''");
	for (const codes of [[0], [1, 0], [1, 1, 0], [1, 1, 1]]) {
		const result = runPowerShell(`
$ErrorActionPreference = 'Stop'
. '${helper}'
$script:attempts = 0; $script:delays = @(); $script:arguments = @(); $script:codes = @(${codes.join(',')})
function npm { $script:arguments += ,@($args); $global:LASTEXITCODE = $script:codes[$script:attempts]; $script:attempts++; Write-Output 'fake npm diagnostic' }
function Start-Sleep { param($Seconds); $script:delays += $Seconds }
$before = $pwd.Path; $caught = $null
try { Install-RequiredExtensionDependencies -Directory '${path.dirname(directory).replace(/'/g, "''")}' } catch { $caught = $_ }
if ($pwd.Path -ne $before) { throw 'Location was not restored' }
if ($script:attempts -ne ${codes.length}) { throw 'Wrong install retry count' }
if (($script:delays -join ',') -ne '${codes.length === 1 ? '' : codes.length === 2 ? '2' : '2,4'}') { throw 'Unbounded or wrong retry delays' }
for ($i = 0; $i -lt $script:arguments.Count; $i++) {
  $a = $script:arguments[$i]
  if ($a[0] -ne 'install' -or $a -notcontains '--include=dev' -or $a -notcontains '--ignore-scripts' -or $a -notcontains '--fetch-timeout=60000') { throw 'Required npm flags missing' }
  if ($i -gt 0 -and $a -notcontains '--prefer-offline') { throw 'Retry did not reuse cache' }
}
if (${codes.at(-1) === 0 ? '$null -ne $caught' : '$null -eq $caught'}) { throw 'Install failure was swallowed or success was rejected' }
if ($caught -and $caught.ToString() -notmatch 'failed after 3 attempts') { throw 'Wrong install failure' }
Write-Output 'PS51_EXTENSION_RETRY_OK'
`);
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.match(result.stdout, /PS51_EXTENSION_RETRY_OK/);
	}
});

test('required extension native npm stderr preserves retry exit code under PowerShell 5.1 Stop preference', { skip: process.platform !== 'win32' }, t => {
	const f = extensionDependencyFixture(t);
	const directory = path.dirname(f.write('repo/required extension/package.json', '{}'));
	const capture = path.join(f.root, 'npm-calls.txt');
	const npm = f.write('commands/npm.cmd', `@echo off\r\necho %* >> "${capture}"\r\necho fake ECONNRESET 1>&2\r\nexit /b 17\r\n`);
	const helper = path.join(f.repo, '.ci/scripts/extension-dependencies.ps1').replace(/'/g, "''");
	const result = runPowerShell(`
$ErrorActionPreference = 'Stop'
$env:PATH = '${path.dirname(npm).replace(/'/g, "''")};' + $env:PATH
. '${helper}'
function Start-Sleep { param($Seconds) }
$before = $pwd.Path; $caught = $null
try { Install-RequiredExtensionDependencies -Directory '${directory.replace(/'/g, "''")}' } catch { $caught = $_ }
if ($null -eq $caught -or $caught.ToString() -notmatch 'failed after 3 attempts.*exit 17') { throw 'Native npm failure was swallowed or retried incorrectly' }
if ($pwd.Path -ne $before -or $ErrorActionPreference -ne 'Stop') { throw 'Caller state was not restored' }
Write-Output 'PS51_NATIVE_EXTENSION_RETRY_OK'
`);
	assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
	assert.match(result.stdout, /PS51_NATIVE_EXTENSION_RETRY_OK/);
	const calls = fs.readFileSync(capture, 'utf8').trim().split(/\r?\n/);
	assert.equal(calls.length, 3);
	assert.ok(calls.every(call => call.includes('--include=dev')));
});

test('actual production and extension compile stop before commands when Mermaid local types are missing', { skip: process.platform !== 'win32' }, t => {
	for (const name of ['compile-build.ps1', 'compile-extensions.ps1']) {
		const f = extensionDependencyFixture(t, EXTENSION_BUILD_FILES[3]);
		f.write('repo/node_modules/@types/node/index.d.ts');
		const source = fs.readFileSync(path.join(ROOT, '.ci/scripts', name), 'utf8');
		const script = f.write(`repo/.ci/scripts/${name}`, '\uFEFF' + source.replace(/^\uFEFF/, ''));
		const result = runPowerShell(`
$env:SAROS_BUILD_MANGLE = '0'
function npm { throw 'UNEXPECTED_BUILD_COMMAND' }
function nvm { throw 'UNEXPECTED_BUILD_COMMAND' }
function node { throw 'UNEXPECTED_BUILD_COMMAND' }
function cmd { throw 'UNEXPECTED_BUILD_COMMAND' }
& '${script.replace(/'/g, "''")}'
`);
		assert.equal(result.status, 1, result.stderr || result.error?.message);
		assert.match(result.stderr, /Required extension build dependencies missing/);
		assert.ok(!result.stderr.includes('UNEXPECTED_BUILD_COMMAND'));
		assert.ok(!result.stdout.includes('[compile]') && !result.stdout.includes('[deps-heal]'));
	}
});

test('install stage routes required extensions through retries and verifies before success', () => {
	const source = fs.readFileSync(path.join(ROOT, '.ci/scripts/install-deps.ps1'), 'utf8');
	assert.match(source, /\$requiredExtensions = @\('markdown-math', 'mermaid-chat-features'\)/);
	assert.match(source, /if \(\$requiredExtensions -contains \$extDir.Name\) \{\s*try \{ Install-RequiredExtensionDependencies -Directory \$extDir.FullName \}\s*catch \{ Write-Error \$_; exit 1 \}/);
	assertOrdered(source, 'Install-RequiredExtensionDependencies -Directory', 'Assert-ExtensionBuildDependencies -RepoRoot');
	assertOrdered(source, 'Assert-ExtensionBuildDependencies -RepoRoot', '[OK] Extension dependencies installed');
	assert.match(source, /try \{ Assert-ExtensionBuildDependencies -RepoRoot \$repoRoot \}\s*catch \{ Write-Error \$_; exit 1 \}/);
	const generate = fs.readFileSync(path.join(ROOT, '.ci/scripts/generate-exe.ps1'), 'utf8');
	assert.ok(generate.includes('build/saros/extension-dependencies.test.mjs'));
});

test('actual install-stage extension loop cannot downgrade an exhausted required install to non-critical', { skip: process.platform !== 'win32' }, t => {
	const f = extensionDependencyFixture(t);
	const directory = path.dirname(f.write('repo/extensions/mermaid-chat-features/package.json', '{}'));
	const capture = f.write('npm-calls.txt', '');
	const file = path.join(ROOT, '.ci/scripts/install-deps.ps1').replace(/'/g, "''");
	const helper = path.join(f.repo, '.ci/scripts/extension-dependencies.ps1').replace(/'/g, "''");
	const result = runPowerShell(`
. '${helper}'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid install-deps.ps1 syntax' }
$names = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$requiredExtensions' }, $true)
$loop = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.ForEachStatementAst] -and $n.Condition.Extent.Text -eq '$extRoots' }, $true)
if (-not $names -or -not $loop) { throw 'Required extension loop missing' }
function npm { [IO.File]::AppendAllText('${capture.replace(/'/g, "''")}', 'call' + [Environment]::NewLine); $global:LASTEXITCODE = 1 }
function Start-Sleep { param($Seconds) }
$extRoots = @([pscustomobject]@{ Name = 'mermaid-chat-features'; FullName = '${directory.replace(/'/g, "''")}' })
. ([scriptblock]::Create($names.Extent.Text + [Environment]::NewLine + $loop.Extent.Text))
Write-Output 'UNEXPECTED_INSTALL_SUCCESS'
`);
	assert.equal(result.status, 1, result.stderr || result.error?.message);
	assert.match(result.stderr, /Required extension npm install failed after 3 attempts/);
	assert.ok(!result.stdout.includes('non-critical') && !result.stdout.includes('UNEXPECTED_INSTALL_SUCCESS'));
	assert.equal(fs.readFileSync(capture, 'utf8').trim().split(/\r?\n/).length, 3);
});

test('Mermaid local Node type dependencies remain declared, locked and typecheck without weakening tsconfig', () => {
	const extensionRoot = path.join(ROOT, 'extensions/mermaid-chat-features');
	const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
	const lock = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package-lock.json'), 'utf8'));
	for (const name of ['@types/node', '@vscode/codicons']) {
		assert.equal(lock.packages[''].devDependencies[name], manifest.devDependencies[name]);
		assert.ok(lock.packages[`node_modules/${name}`]?.integrity);
	}
	for (const project of ['tsconfig.json', 'chat-webview-src/tsconfig.json']) {
		const config = JSON.parse(fs.readFileSync(path.join(extensionRoot, project), 'utf8'));
		assert.deepEqual(config.compilerOptions.types, ['node']);
		assert.deepEqual(config.compilerOptions.typeRoots, [project.startsWith('chat-') ? '../node_modules/@types' : './node_modules/@types']);
	}
	for (const project of ['tsconfig.json', 'chat-webview-src/tsconfig.json', 'tsconfig.browser.json']) {
		const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/@typescript/native-preview/bin/tsgo.js'), '--project', path.join(extensionRoot, project), '--noEmit', '--incremental', 'false'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
		assert.equal(result.status, 0, `${project}: ${result.stdout || result.stderr || result.error?.message}`);
	}
});
