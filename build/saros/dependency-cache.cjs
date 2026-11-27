/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const RECEIPT = '.vssaros-install-receipt.json';
const relevant = ['name', 'type', 'cpu', 'os', 'config', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'engines', 'workspaces', 'bundledDependencies', 'bundleDependencies', 'packageManager', 'scripts'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function fileDigest(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		const hash = crypto.createHash('sha256');
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, count)); }
		for (const after of [fs.fstatSync(fd, { bigint: true }), fs.statSync(file, { bigint: true })]) {
			if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => after[key] !== before[key])) { throw new Error('Dependency changed during verification'); }
		}
		return hash.digest('hex');
	} finally { fs.closeSync(fd); }
}
function stable(value) {
	if (Array.isArray(value)) { return value.map(stable); }
	if (!value || typeof value !== 'object') { return value; }
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function manifestInput(value) { return Object.fromEntries(relevant.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }
function lockInput(value) {
	value = structuredClone(value);
	delete value.version;
	if (value.packages?.['']) { delete value.packages[''].version; }
	return value;
}
function scopePath(root, relative) {
	if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => ['..', '.'].includes(part))
		|| !(relative === '' || relative === 'build' || /^(?:extensions|\.vscode\/extensions)(?:\/[\w.-]+){0,3}$/.test(relative)
			|| relative === 'src/vs/sessions/contrib/agentStudio/webview')) { throw new Error('Invalid dependency scope'); }
	const target = path.resolve(root, relative);
	for (let current = target; current !== path.resolve(root); current = path.dirname(current)) {
		if (fs.lstatSync(current).isSymbolicLink()) { throw new Error(`Linked dependency scope: ${relative}`); }
	}
	return target;
}
function inputKey(root, relative, context = {}) {
	const scope = scopePath(root, relative);
	const inputs = {};
	for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
		const full = path.join(scope, file);
		if (!fs.existsSync(full)) { inputs[file] = null; continue; }
		inputs[file] = file === 'package.json' ? manifestInput(json(full)) : file === 'package-lock.json' ? lockInput(json(full)) : digest(fs.readFileSync(full));
	}
	// file: dependencies retain their dependency/lifecycle identity, not the product version or description.
	const manifest = json(path.join(scope, 'package.json'));
	const local = {};
	for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
		if (typeof spec !== 'string' || !spec.startsWith('file:')) { continue; }
		const directory = path.resolve(scope, spec.slice(5));
		if (!directory.startsWith(path.resolve(root) + path.sep) && directory !== path.resolve(root)) { throw new Error('Local dependency outside repository'); }
		local[name] = manifestInput(json(path.join(directory, 'package.json')));
		const lock = inputs['package-lock.json'];
		const key = path.relative(scope, directory).replace(/\\/g, '/');
		if (lock?.packages?.[key]) { lock.packages[key] = manifestInput(lock.packages[key]); }
	}
	for (const file of ['.npmrc', '.nvmrc', '.ci/scripts/install-deps.ps1', '.ci/scripts/extension-dependencies.ps1', '.ci/scripts/dependency-cache.ps1', 'build/saros/bin/rg-manifest.json']) {
		inputs[`root:${file}`] = fs.existsSync(path.join(root, file)) ? digest(fs.readFileSync(path.join(root, file))) : null;
	}
	inputs['root:package.json'] = manifestInput(json(path.join(root, 'package.json')));
	return digest(JSON.stringify(stable({ revision: 1, helper: digest(fs.readFileSync(__filename)), relative, inputs, local, context })));
}
function scopes(root) {
	const found = ['', 'build'];
	function visit(relative, depth) {
		const directory = path.join(root, relative);
		if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) { return; }
		if (fs.existsSync(path.join(directory, 'package.json'))) { found.push(relative); }
		if (!depth) { return; }
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && !['node_modules', 'out', 'dist', '.git'].includes(entry.name) && !entry.name.startsWith('.')) { visit(`${relative}/${entry.name}`, depth - 1); }
		}
	}
	visit('extensions', 2);
	visit('.vscode/extensions', 1);
	visit('src/vs/sessions/contrib/agentStudio/webview', 0);
	return [...new Set(found)].filter(relative => fs.existsSync(path.join(root, relative, 'package.json')));
}
function assertDirectDependencies(root, relative) {
	const directory = scopePath(root, relative);
	const manifest = json(path.join(directory, 'package.json'));
	for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
		if (manifest.optionalDependencies?.[name]) { continue; }
		if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) { throw new Error('Invalid dependency name'); }
		if (name === 'vssaros' && spec.startsWith('file:') && path.resolve(directory, spec.slice(5)) === path.resolve(root)) { continue; }
		let installed;
		for (let base = directory;; base = path.dirname(base)) {
			const candidate = path.join(base, 'node_modules', name, 'package.json');
			if (fs.existsSync(candidate)) { installed = json(candidate); break; }
			if (base === path.resolve(root)) { break; }
		}
		if (!installed?.name || !installed.version) { throw new Error(`Required dependency not installed: ${relative}/${name}`); }
	}
}
function inventory(root, relative) {
	assertDirectDependencies(root, relative);
	const directory = path.join(scopePath(root, relative), 'node_modules');
	if (!fs.existsSync(directory)) {
		const pkg = json(path.join(root, relative, 'package.json'));
		if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) { throw new Error('Dependency directory missing'); }
		return [];
	}
	if (fs.lstatSync(directory).isSymbolicLink()) { throw new Error('Linked node_modules root'); }
	const files = [];
	const stack = [directory];
	while (stack.length) {
		const current = stack.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const name = path.relative(directory, full).replace(/\\/g, '/');
			if (name === RECEIPT || (name === 'vssaros' && entry.isSymbolicLink())) { continue; }
			if (entry.isSymbolicLink()) {
				// Never traverse links (npm's vssaros self-junction otherwise recurses into the whole repo).
				fs.statSync(full);
				files.push([name, 'link', fs.readlinkSync(full)]);
			} else if (entry.isDirectory()) { stack.push(full); files.push([name, 'dir']); }
			else if (entry.isFile()) {
				const stat = fs.statSync(full);
				if (/\.(?:node|exe|dll|wasm)$/.test(name) && stat.size === 0) { throw new Error(`Empty native dependency: ${name}`); }
				files.push([name, stat.size, fileDigest(full)]);
			} else { throw new Error(`Unsupported dependency entry: ${name}`); }
		}
	}
	return files.sort((a, b) => a[0].localeCompare(b[0]));
}
function runProbe(executable, root, scope, target) {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
	delete env.NODE_OPTIONS;
	const result = spawnSync(executable, [__filename, '--probe', scope, target], { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
	if (result.error || result.status !== 0) { throw new Error(`Native probe failed for ${scope || 'root'}: ${(result.stderr || result.error?.message || '').slice(0, 500)}`); }
	const proof = JSON.parse(result.stdout.trim());
	if (proof.platform !== process.platform || proof.arch !== process.arch || !/^\d+$/.test(proof.modules)
		|| (scope === 'build' ? proof.electron !== null || proof.node !== target : proof.electron !== target)) { throw new Error('Native probe runtime identity mismatch'); }
	return proof;
}
function findElectron(root) {
	const directory = path.join(root, '.build/electron');
	if (!fs.existsSync(directory)) { return undefined; }
	return fs.readdirSync(directory).filter(name => /\.exe$/i.test(name)).map(name => path.join(directory, name))[0];
}
function nativeProof(root, relative, context) {
	if (relative !== '' && relative !== 'build') { return null; }
	const executable = relative === 'build' ? process.execPath : findElectron(root);
	if (!executable) { throw new Error('Target Electron unavailable; root native cache cannot be sealed'); }
	return runProbe(executable, root, relative, relative === 'build' ? context.node : context.electron);
}
function check(root, relative, context) {
	try {
		const directory = path.join(scopePath(root, relative), 'node_modules');
		if (fs.lstatSync(directory).isSymbolicLink()) { throw new Error('Linked node_modules root'); }
		const receipt = path.join(directory, RECEIPT);
		if (fs.lstatSync(receipt).isSymbolicLink()) { throw new Error('Linked dependency receipt'); }
		const saved = json(receipt);
		if (saved.key !== inputKey(root, relative, context)) { return { hit: false, reason: 'inputs changed' }; }
		if (saved.files !== digest(JSON.stringify(inventory(root, relative)))) { return { hit: false, reason: 'dependency bytes changed' }; }
		if (JSON.stringify(saved.native) !== JSON.stringify(nativeProof(root, relative, context))) { return { hit: false, reason: 'native proof changed' }; }
		return { hit: true, reason: 'verified' };
	} catch { return { hit: false, reason: 'missing or invalid receipt/closure/native proof' }; }
}
function seal(root, relative, key, context) {
	const proof = nativeProof(root, relative, context);
	const files = digest(JSON.stringify(inventory(root, relative)));
	const directory = path.join(root, relative, 'node_modules');
	fs.mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `${RECEIPT}.${process.pid}.tmp`);
	fs.writeFileSync(temporary, JSON.stringify({ key, files, native: proof }), { flag: 'wx' });
	fs.renameSync(temporary, path.join(directory, RECEIPT));
}
async function clean(root, relative) {
	const directory = path.join(scopePath(root, relative), 'node_modules');
	if (!fs.existsSync(directory)) { return; }
	if (fs.lstatSync(directory).isSymbolicLink()) { throw new Error('Refusing recursive removal of linked node_modules'); }
	// Remove every junction itself before recursive deletion; never traverse a link target.
	const stack = [directory];
	while (stack.length) {
		const current = stack.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isSymbolicLink()) {
				try { await fs.promises.unlink(full); } catch (error) {
					if (process.platform !== 'win32') { throw error; }
					await fs.promises.rmdir(full);
				}
			} else if (entry.isDirectory()) { stack.push(full); }
		}
	}
	await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
async function probe(scope, target) {
	const requireAt = createRequire(path.resolve(scope, 'package.json'));
	if (scope === 'build') {
		if (process.versions.electron || process.versions.node !== target) { throw new Error('Wrong build Node runtime'); }
		const Parser = requireAt('tree-sitter');
		const parser = new Parser();
		parser.setLanguage(requireAt('tree-sitter-typescript').typescript);
		if (parser.parse('const value: number = 1').rootNode.hasError) { throw new Error('Tree-sitter smoke failed'); }
	} else {
		if (process.versions.electron !== target) { throw new Error('Wrong target Electron runtime'); }
		for (const name of ['@parcel/watcher', '@vscode/native-watchdog', '@vscode/policy-watcher', '@vscode/spdlog', '@vscode/deviceid', '@vscode/windows-ca-certs', 'kerberos', 'native-keymap', 'node-pty', '@vscode/windows-mutex', '@vscode/windows-process-tree', '@vscode/windows-registry', 'windows-foreground-love']) { requireAt(name); }
		const sqlite = requireAt('@vscode/sqlite3');
		await new Promise((resolve, reject) => {
			const database = new sqlite.Database(':memory:', error => {
				if (error) { reject(error); return; }
				database.get('select 1 as value', (error, row) => database.close(closeError => {
					if (error || closeError || row?.value !== 1) { reject(error || closeError || new Error('SQLite native smoke failed')); } else { resolve(); }
				}));
			});
		});
	}
	return { node: process.versions.node, electron: process.versions.electron ?? null, modules: process.versions.modules, arch: process.arch, platform: process.platform };
}
function restoreRipgrep(root, execute = spawnSync) {
	const source = path.join(root, 'build/saros/bin/rg.exe');
	const manifest = json(path.join(root, 'build/saros/bin/rg-manifest.json'));
	const bytes = fs.readFileSync(source);
	if (process.platform !== manifest.platform || process.arch !== manifest.arch || bytes.length !== manifest.size || digest(bytes) !== manifest.sha256
		|| bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) { throw new Error('Vendored ripgrep identity mismatch'); }
	const result = execute(source, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
	if (result.error || result.status !== 0 || result.stdout.split(/\r?\n/)[0] !== manifest.version) { throw new Error('Vendored ripgrep smoke failed'); }
	const target = path.join(root, 'node_modules/@vscode/ripgrep/bin/rg.exe');
	for (let directory = target; directory !== path.resolve(root); directory = path.dirname(directory)) {
		try { if (fs.lstatSync(directory).isSymbolicLink()) { throw new Error('Linked ripgrep target'); } }
		catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== manifest.sha256) { fs.copyFileSync(source, target); }
	console.log('[RG] Verified vendored ripgrep; online download skipped');
}

function verifyRipgrep(root) {
	const file = path.resolve(root, 'node_modules/@vscode/ripgrep/bin/rg.exe');
	for (let directory = file; directory !== path.resolve(root); directory = path.dirname(directory)) {
		if (fs.lstatSync(directory).isSymbolicLink()) { throw new Error('Linked installed ripgrep'); }
	}
	const bytes = fs.readFileSync(file);
	if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) { throw new Error('Installed ripgrep architecture mismatch'); }
	const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
	if (result.error || result.status !== 0 || !/^ripgrep \d+\.\d+\.\d+/.test(result.stdout)) { throw new Error('Installed ripgrep not executable'); }
}

async function main() {
	const [command, argument, extra] = process.argv.slice(2);
	if (command === '--probe') { console.log(JSON.stringify(await probe(argument, extra))); return; }
	const root = process.cwd();
	if (command === '--plan') {
		const started = performance.now();
		const installEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^npm_config_(?:runtime|target|arch|target_arch|build_from_source|disturl|legacy_peer_deps|force_process_config|python|msvs_version)$/i.test(name)));
		const context = { node: process.versions.node, modules: process.versions.modules, platform: process.platform, arch: process.arch, electron: process.env.npm_config_target, npm: process.env.SAROS_DEPENDENCY_NPM, toolchain: process.env.SAROS_DEPENDENCY_TOOLCHAIN, installConfig: digest(JSON.stringify(stable(installEnv))) };
		const entries = scopes(root).map(relative => ({ relative, key: inputKey(root, relative, context), ...(process.env.SAROS_INSTALL_CACHE === '0' ? { hit: false, reason: 'forced clean install' } : check(root, relative, context)) }));
		console.log(JSON.stringify({ context, entries, durationMs: Math.round(performance.now() - started) }));
	} else if (command === '--rg') { restoreRipgrep(root); }
	else if (command === '--verify-rg') { verifyRipgrep(root); }
	else if (command === '--clean') { await clean(root, argument ?? ''); }
	else if (command === '--seal') {
		const plan = json(argument);
		for (const entry of plan.entries.filter(item => !item.hit && item.completed === true)) {
			try { seal(root, entry.relative, entry.key, plan.context); console.log(`[deps-cache] sealed ${entry.relative || 'root'}`); }
			catch (error) { console.log(`[deps-cache] not reusable ${entry.relative || 'root'}: ${error.message}`); }
		}
	} else { throw new Error('Unknown dependency-cache command'); }
}
module.exports = { inputKey, inventory, scopes, check, seal, clean, probe, restoreRipgrep, RECEIPT };
if (require.main === module) { main().catch(error => { console.error(error.message); process.exitCode = 1; }); }
