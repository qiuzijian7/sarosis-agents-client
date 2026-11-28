/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const guard = read('build/win32/update-lock-guard.iss');
const installer = read('build/win32/code.iss');
function method(file, name) {
	const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
	let result;
	const visit = node => {
		if (ts.isMethodDeclaration(node) && node.name.getText(ast) === name) { result = node.getText(ast); }
		ts.forEachChild(node, visit);
	};
	visit(ast);
	assert.ok(result, name);
	return result;
}

test('actual application mutex stays alive through shutdown joiners and repeated initialization is idempotent', async () => {
	const file = 'src/vs/code/electron-main/app.ts';
	const body = method(file, 'installMutex').replace("await import('@vscode/windows-mutex')", 'globalThis.WindowsMutex');
	const compiled = ts.transpileModule(`class App { ${body} } globalThis.App = App;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	let created = 0, released = 0;
	const listeners = [];
	const context = { App: undefined, isWindows: true, WindowsMutex: { Mutex: class { constructor() { created++; } release() { released++; } } }, Event: { once: event => fn => event(fn) } };
	vm.runInNewContext(compiled, context);
	const app = new context.App();
	Object.assign(app, { productService: { win32MutexName: 'vssaros' }, environmentMainService: { isBuilt: true }, lifecycleMainService: { onWillShutdown: fn => listeners.push(fn) }, logService: { error: assert.fail } });
	await app.installMutex(); await app.installMutex();
	for (const listener of listeners) { listener(); }
	assert.equal(created, 1);
	assert.equal(released, 0);
	assert.ok(app._processLifetimeMutex);
	assert.equal(listeners.length, 0, 'Application-exit proof must not be released in onWillShutdown');
});

test('installer captures original owner handle early, waits for termination and closes handles on cancellation', () => {
	assert.match(installer, /#include "update-lock-guard\.iss"/);
	assert.match(installer, /Result := CaptureUpdateOwner\(\);\s*if not Result then exit;/);
	assert.match(guard, /UpdateOpenProcess\(\$00100000, False, Owner\)/);
	assert.match(guard, /UpdateWaitForSingleObject\(UpdateOwnerHandle, 1000\)/);
	assert.match(guard, /\(Status <> 0\) and \(Status <> 258\)/);
	assert.match(guard, /until Status = 0/);
	assert.match(guard, /if UpdateLastError\(\) <> 87/);
	assert.match(guard, /procedure DeinitializeSetup\(\);[\s\S]*UpdateCloseHandle\(UpdateOwnerHandle\)/);
	assert.ok(!/TerminateProcess|taskkill|Stop-Process|PROCESS_TERMINATE/.test(guard));
	assert.match(read('src/vs/platform/update/electron-main/updateService.win32.ts'), /`\/updatepid=\$\{process\.pid\}`/);
});

test('archive preflight is read-only/exclusive and bounded; unsupported failures cannot authorize replacement', () => {
	assert.match(guard, /node_modules\.asar/);
	assert.match(guard, /UpdateCreateFile\(Archive, \$80000000, 0, 0, 3, 0, 0\)/);
	assert.match(guard, /for Attempt := 1 to 30/);
	assert.match(guard, /\(ErrorCode <> 32\) and \(ErrorCode <> 33\)/);
	assert.match(guard, /if UpdateCancelled\(\) then exit/);
	assert.ok(!/DeleteFile\(Archive|SaveStringToFile\(Archive|MoveFile|WriteFile|CREATE_ALWAYS|TRUNCATE_EXISTING/.test(guard));
	const part = installer.slice(installer.indexOf('UpdateReplacementFailed := True;'));
	assert.ok(part.indexOf('WaitForUpdateOwnerExit()') < part.indexOf('WaitForUpdateArchiveUnlock()'));
	assert.ok(part.indexOf('WaitForUpdateArchiveUnlock()') < part.indexOf("Log('Invoking inno_updater for background update')"));
});

test('helper startup or nonzero exit cannot be logged as success or launch an incomplete application', () => {
	const part = installer.slice(installer.indexOf('UpdateReplacementFailed := True;'));
	assert.match(part, /if not Exec\([\s\S]*?then\s*RaiseException\('Unable to start inno_updater/);
	assert.match(part, /if UpdateResultCode <> 0 then\s*RaiseException\('inno_updater failed/);
	assert.ok(part.indexOf('if UpdateResultCode <> 0') < part.indexOf('UpdateReplacementFailed := False;'));
	assert.ok(part.indexOf('UpdateReplacementFailed := False;') < part.indexOf("DeleteFile(ExpandConstant('{app}\\updating_version'))"));
	assert.match(installer, /function ShouldRunAfterUpdate\(\): Boolean;\s*begin\s*if UpdateReplacementFailed then begin\s*Result := False;/);
});

test('actual installer process failures are reported and late old-process events do not reset a new update', () => {
	const file = 'src/vs/platform/update/electron-main/updateService.win32.ts';
	const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
	const handlers = new Map();
	const visit = node => {
		if (ts.isCallExpression(node) && node.expression.getText(ast) === 'child.once' && ts.isStringLiteral(node.arguments[0]) && ['exit', 'error'].includes(node.arguments[0].text)) {
			const callback = node.arguments[1];
			handlers.set(node.arguments[0].text, `function (${callback.parameters.map(parameter => parameter.getText(ast)).join(',')}) ${callback.body.getText(ast)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	assert.equal(handlers.size, 2);
	const available = {};
	const context = { availableUpdate: available, StateType: { Restarting: 'restarting', Updating: 'updating' }, State: { Idle: (_type, error) => ({ type: 'idle', error }) }, getUpdateType: () => 'setup' };
	function invoke(kind, state, values, replacement = available) {
		const code = ts.transpileModule(`globalThis.handler = ${handlers.get(kind)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const callback = vm.runInNewContext(code + '\nhandler', context);
		const owner = { availableUpdate: replacement, state: { type: state }, logService: { error() {} }, setState(value) { this.state = value; } };
		callback.apply(owner, values);
		return owner;
	}
	assert.match(invoke('exit', 'ready', [7, null]).state.error, /code 7/);
	assert.match(invoke('exit', 'updating', [0, null]).state.error, /before completion/);
	assert.equal(invoke('exit', 'ready', [0, null]).state.error, undefined);
	assert.equal(invoke('exit', 'restarting', [0, null]).state.type, 'restarting');
	assert.equal(invoke('exit', 'updating', [7, null], {}).state.type, 'updating');
	assert.match(invoke('error', 'updating', [new Error('cannot start')]).state.error, /cannot start/);
});

test('actual Inno lock guard compiles against the packaged compiler without executing an installer', { skip: process.platform !== 'win32' }, () => {
	const root = fs.mkdtempSync(path.join(ROOT, '.build/updater-lock-compile-'));
	try {
		const file = path.join(root, 'check.iss');
		const start = installer.indexOf('UpdateReplacementFailed := True;');
		const end = installer.indexOf("Log('inno_updater completed successfully');", start);
		assert.ok(start > 0 && end > start);
		const replacement = installer.slice(start, end + "Log('inno_updater completed successfully');".length);
		fs.writeFileSync(file, [
			'#define VersionedResourcesFolder ""', '#define ExeBasename "Fixture"', '[Setup]', 'AppName=Update Lock Guard Syntax', 'AppVersion=1',
			'DefaultDirName={tmp}\\UpdateLockGuard', 'Uninstallable=no', 'OutputBaseFilename=check', '[CustomMessages]', 'UpdatingVisualStudioCode=Updating', '[Code]',
			'function IsBackgroundUpdate(): Boolean;', 'begin', 'Result := True;', 'end;',
			`#include "${path.join(ROOT, 'build/win32/update-lock-guard.iss')}"`,
			'procedure StopTunnelServiceIfNeeded(); begin end;', 'function LockFileExists(): Boolean; begin Result := True; end;',
			installer.match(/function BoolToStr\(Value: Boolean\): String;[\s\S]*?\nend;/)[0],
			'procedure CompileActualReplacement();', 'var UpdateResultCode: Integer;', 'begin', replacement, 'end;',
			'function InitializeSetup(): Boolean;', 'begin', 'Result := CaptureUpdateOwner();', 'end;',
		].join('\n'));
		const result = spawnSync(path.join(ROOT, 'node_modules/innosetup/bin/ISCC.exe'), ['/Q', `/O${root}`, file], { encoding: 'utf8', timeout: 45000, windowsHide: true });
		assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
		assert.ok(fs.existsSync(path.join(root, 'check.exe')));
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
