/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import policy from './pack-policy.cjs';
import { SEED_GENERATOR_REVISION, isRepoSeedPlugin } from './seed-package.mjs';
import { WHISPER_MODEL, WHISPER_MANIFEST_FILE, validateModelSpec } from '../../dsh-plugins/vssaros-web-content-import/lib/whisperModel.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_REL = '.build/pack-reports/installers.json';
const MIB = 1024 * 1024;

function isWithin(parent, child) {
	const relative = path.relative(parent, child);
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function scanFiles(root) {
	const files = [];
	const links = [];
	const pending = [''];
	while (pending.length) {
		const directory = pending.pop();
		for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
			const relative = path.join(directory, entry.name);
			const absolute = path.join(root, relative);
			const stat = fs.lstatSync(absolute, { bigint: true });
			if (stat.isSymbolicLink()) {
				links.push({ path: relative.split(path.sep).join('/'), target: fs.readlinkSync(absolute) });
			} else if (stat.isDirectory()) {
				pending.push(relative);
			} else if (stat.isFile()) {
				files.push({ path: relative.split(path.sep).join('/'), size: Number(stat.size), identity: stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : relative });
			}
		}
	}
	return { files, links };
}

function groupOf(relative) {
	if (/^resources\/app\/dsh-runtime\/[^/]+\/profile-seed\//.test(relative)) { return 'dsh-profile-seed'; }
	if (relative.startsWith('resources/app/dsh-runtime/')) { return 'dsh-runtime'; }
	if (relative.startsWith('resources/app/office-runtime/')) { return 'office-runtime'; }
	if (relative.startsWith('resources/app/dsh-plugins/')) { return 'dsh-plugins'; }
	if (relative.startsWith('resources/saros/models/')) { return 'media-models'; }
	if (relative.startsWith('resources/saros/bin/')) { return 'media-binaries'; }
	if (relative.startsWith('resources/app/node_modules')) { return 'app-dependencies'; }
	if (relative.startsWith('resources/app/extensions/')) { return 'extensions'; }
	return relative.split('/')[0];
}

export function auditStaging(root, { minDuplicateBytes = 64 * 1024 } = {}) {
	const { files, links } = scanFiles(root);
	const groups = new Map();
	const identities = new Set();
	const bySize = new Map();
	let logicalBytes = 0;
	let uniqueFileBytes = 0;
	for (const file of files) {
		logicalBytes += file.size;
		if (!identities.has(file.identity)) { uniqueFileBytes += file.size; identities.add(file.identity); }
		const group = groupOf(file.path);
		const value = groups.get(group) || { name: group, bytes: 0, files: 0 };
		value.bytes += file.size;
		value.files++;
		groups.set(group, value);
		if (file.size >= minDuplicateBytes) {
			const candidates = bySize.get(file.size) || [];
			candidates.push(file);
			bySize.set(file.size, candidates);
		}
	}
	const hashes = new Map();
	const duplicates = [];
	for (const [size, candidates] of bySize) {
		if (candidates.length < 2) { continue; }
		const byHash = new Map();
		for (const file of candidates) {
			let digest = hashes.get(file.identity);
			if (!digest) { digest = policy.hashFile(path.join(root, file.path)); hashes.set(file.identity, digest); }
			const matches = byHash.get(digest) || [];
			matches.push(file);
			byHash.set(digest, matches);
		}
		for (const [sha256, matches] of byHash) {
			if (matches.length < 2) { continue; }
			const copies = new Set(matches.map(file => file.identity)).size;
			duplicates.push({ sha256, size, copies, independentDuplicateBytes: (copies - 1) * size, paths: matches.map(file => file.path) });
		}
	}
	duplicates.sort((a, b) => b.independentDuplicateBytes - a.independentDuplicateBytes || b.size - a.size);
	return {
		schemaVersion: 1, root: path.resolve(root), fileCount: files.length, logicalBytes, uniqueFileBytes,
		hardlinkRepeatedBytes: logicalBytes - uniqueFileBytes,
		independentDuplicateBytes: duplicates.reduce((sum, item) => sum + item.independentDuplicateBytes, 0),
		minDuplicateBytes, skippedLinks: links,
		notes: ['Symlinks/junctions are not traversed; their installer contribution is not included.', 'Unique file bytes are not physical disk allocation.', 'Duplicate bytes are candidates, not guaranteed EXE compression savings; nothing is deleted by hash.'],
		groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
		largestFiles: files.sort((a, b) => b.size - a.size).slice(0, 50).map(({ path: filePath, size }) => ({ path: filePath, size })),
		duplicates,
	};
}

export function cleanStaging(root, repoRoot = REPO_ROOT) {
	const absolute = path.resolve(root);
	const real = fs.realpathSync(absolute);
	const realRepo = fs.realpathSync(repoRoot);
	const buildRoot = path.join(realRepo, '.build');
	if (real === path.parse(real).root || isWithin(real, realRepo) || (isWithin(realRepo, real) && !isWithin(buildRoot, real))) {
		throw new Error('cleanup is restricted to staging, not repository source directories');
	}
	if (path.relative(real, absolute) !== '') { throw new Error('staging root must not be a symlink or junction'); }
	const app = path.join(real, 'resources/app');
	if (!isWithin(real, fs.realpathSync(app))) { throw new Error('application directory escapes staging'); }
	for (const relative of ['resources', 'resources/app', 'resources/app/package.json', 'resources/app/dsh-plugins', 'resources/app/dsh-plugins/dsh-compat.json']) {
		if (fs.lstatSync(path.join(real, relative)).isSymbolicLink()) { throw new Error(`cleanup cannot traverse link: ${relative}`); }
	}
	const { bundled } = JSON.parse(fs.readFileSync(path.join(app, 'dsh-plugins/dsh-compat.json'), 'utf8'));
	if (typeof bundled !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(bundled)) { throw new Error('invalid bundled dsh version'); }
	const runtimeRoot = path.join(app, 'dsh-runtime');
	if (fs.lstatSync(runtimeRoot).isSymbolicLink()) { throw new Error('runtime root must not be a link'); }
	const bundledRoot = path.join(runtimeRoot, bundled);
	if (fs.lstatSync(bundledRoot).isSymbolicLink()) { throw new Error('bundled runtime must not be a link'); }
	if (!fs.existsSync(path.join(bundledRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) { throw new Error('bundled dsh entry is missing; cleanup refused'); }
	const removed = [];
	for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
		if (entry.name !== bundled && entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(entry.name)) {
			const relative = `resources/app/dsh-runtime/${entry.name}`;
			const { files } = scanFiles(path.join(real, relative));
			const bytes = files.reduce((sum, file) => sum + file.size, 0);
			fs.rmSync(path.join(real, relative), { recursive: true });
			removed.push({ path: relative, bytes, reason: 'unselected-runtime-version' });
		}
	}
	for (const file of scanFiles(real).files) {
		const dependencySymbol = /(?:^|\/)node_modules\//.test(file.path) && /\.(?:map|pdb)$/i.test(file.path);
		const mediaSymbol = file.path.startsWith('resources/saros/bin/') && /\.pdb$/i.test(file.path);
		if (!dependencySymbol && !mediaSymbol) { continue; }
		fs.unlinkSync(path.join(real, file.path));
		removed.push({ path: file.path, bytes: file.size, reason: 'debug-symbol' });
	}
	return { removed, logicalBytesRemoved: removed.reduce((sum, item) => sum + item.bytes, 0) };
}

function stagingModelsDir(root) {
	const real = fs.realpathSync(root);
	const mac = fs.existsSync(path.join(real, 'Contents/Resources/app'));
	if (!fs.existsSync(path.join(real, mac ? 'Contents/Resources/app/package.json' : 'resources/app/package.json'))) { throw new Error('model policy requires a staged application root'); }
	const relative = mac ? 'Contents/Resources/saros/models' : 'resources/saros/models';
	let current = real;
	for (const segment of relative.split('/')) {
		current = path.join(current, segment);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) { throw new Error(`model staging path must not be a link: ${current}`); }
		} catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	}
	return current;
}

export function stageWhisperModel(root, env = process.env, source = path.join(REPO_ROOT, 'build/saros/models/ggml-base.bin'), { deferMissingOffline = false } = {}) {
	const { mode } = policy.resolvePackPolicy(env);
	const directory = stagingModelsDir(root);
	const file = path.join(directory, WHISPER_MODEL.fileName);
	const model = { ...WHISPER_MODEL, urls: env.SAROS_WHISPER_MODEL_URL ? [env.SAROS_WHISPER_MODEL_URL, ...WHISPER_MODEL.urls].slice(0, 3) : [...WHISPER_MODEL.urls] };
	validateModelSpec(model);
	fs.mkdirSync(directory, { recursive: true });
	let removedBytes = 0;
	let info;
	try { info = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	if (info && (!info.isFile() || info.isSymbolicLink())) { throw new Error('staged Whisper model must be a regular file'); }
	if (mode === 'standard') {
		if (info) {
			removedBytes = info.size;
			fs.unlinkSync(file);
		}
	} else {
		let sourceInfo;
		try { sourceInfo = fs.lstatSync(source); }
		catch (error) { if (!deferMissingOffline || error.code !== 'ENOENT') { throw error; } }
		if (sourceInfo) {
			if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== model.size || policy.hashFile(source) !== model.sha256) {
				throw new Error('offline package requires the pinned Whisper model; run fetch-whisper.mjs or restore the verified model');
			}
			const temporary = `${file}.${process.pid}.tmp`;
			try {
				fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
				fs.renameSync(temporary, file);
			} finally { fs.rmSync(temporary, { force: true }); }
		}
	}
	const manifest = { schemaVersion: 1, mode, model };
	const manifestFile = path.join(directory, WHISPER_MANIFEST_FILE);
	const temp = `${manifestFile}.${process.pid}.tmp`;
	try { fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', 'utf8'); fs.renameSync(temp, manifestFile); }
	finally { fs.rmSync(temp, { force: true }); }
	return { mode, removedBytes, modelBytes: model.size };
}

export function checkStagedWhisperModel(root, env = process.env) {
	const { mode } = policy.resolvePackPolicy(env);
	const directory = stagingModelsDir(root);
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, WHISPER_MANIFEST_FILE), 'utf8'));
	if (manifest.mode !== mode || manifest.schemaVersion !== 1 || manifest.model?.sha256 !== WHISPER_MODEL.sha256 || manifest.model?.size !== WHISPER_MODEL.size) { throw new Error('staged Whisper mode/model does not match packaging policy'); }
	validateModelSpec(manifest.model);
	const file = path.join(directory, WHISPER_MODEL.fileName);
	if (mode === 'standard') {
		try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') { return manifest; } throw error; }
		throw new Error('standard package still contains Whisper model');
	}
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== WHISPER_MODEL.size || policy.hashFile(file) !== WHISPER_MODEL.sha256) { throw new Error('offline package Whisper model is missing or corrupt'); }
	return manifest;
}

export function checkBundledSeed(repoRoot = REPO_ROOT) {
	const { bundled } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dsh-plugins/dsh-compat.json'), 'utf8'));
	if (typeof bundled !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(bundled)) { throw new Error('Invalid bundled runtime version'); }
	const runtime = path.join(repoRoot, 'dsh-runtime', bundled);
	const seed = path.join(runtime, 'profile-seed');
	const marker = JSON.parse(fs.readFileSync(path.join(seed, 'seed.json'), 'utf8'));
	if (marker.generatorRevision !== SEED_GENERATOR_REVISION || marker.dsh !== bundled || !marker.plugins || typeof marker.plugins !== 'object' || Array.isArray(marker.plugins)
		|| Object.keys(marker.plugins).length === 0) { throw new Error('Bundled seed marker is incomplete or from a different runtime'); }
	const profile = path.join(seed, 'profiles/vssaros');
	if (!fs.existsSync(path.join(profile, 'package.json')) || !fs.existsSync(path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
		throw new Error('Bundled seed or runtime entry is missing');
	}
	const workspace = fs.readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8');
	if (/dangerouslyAllowAllBuilds\s*:\s*true/.test(workspace)
		|| !/^autoInstallPeers:\s*false$/m.test(workspace)
		|| !/^strictPeerDependencies:\s*false$/m.test(workspace)
		|| !/^verifyDepsBeforeRun:\s*false$/m.test(workspace)
		|| !/^packageImportMethod:\s*copy$/m.test(workspace)
		|| !/^overrides:/m.test(workspace)
		|| !workspace.includes(`"@deepseek-ai/dsh-tools": "${bundled}"`)) {
		throw new Error('Bundled seed pnpm workspace policy is unsafe or incomplete');
	}
	for (const required of ['@vssaros/dsh-foundation', '@vssaros/dsh-bridge', '@deepseek-ai/dsh-web-app']) {
		if (!Object.hasOwn(marker.plugins, required)) { throw new Error(`Bundled seed marker is missing a required plugin: ${required}`); }
	}
	const pluginRoot = path.join(repoRoot, 'dsh-plugins');
	for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) { continue; }
		const manifestFile = path.join(pluginRoot, entry.name, 'package.json');
		if (!fs.existsSync(manifestFile)) { continue; }
		const expected = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		if (isRepoSeedPlugin(expected.name) && marker.plugins[expected.name] !== expected.version) {
			throw new Error(`Bundled seed is stale or missing repository plugin: ${expected.name}`);
		}
	}
	for (const [name, version] of Object.entries(marker.plugins)) {
		if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || typeof version !== 'string' || !version) { throw new Error('Invalid plugin identity in seed marker'); }
		const installed = JSON.parse(fs.readFileSync(path.join(profile, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
		if (installed.name !== name || installed.version !== version) { throw new Error(`Bundled seed plugin does not match its marker: ${name}`); }
	}
	return { bundled, plugins: Object.keys(marker.plugins).length };
}

function buildIdentity(root) {
	return {
		commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		productVersion: JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')).version,
	};
}

const STAGING_REPORT_REL = '.build/pack-reports/staging-build.json';
const STAGING_VERIFIED_REL = '.build/pack-reports/staging-verified.json';
// dshDesktopWindowMainService 被 electron-main/app.ts 和 dshHarnessChannel.ts 静态 import，
// esbuild 会把它内联进 out/main.js，不会产出独立 JS；不要把它列为 staging sentinel。
const STAGING_SENTINELS = ['resources/app/out/main.js', 'resources/app/out/vs/sessions/sessions.desktop.main.js', 'resources/app/out/vs/sessions/electron-browser/dshDesktop.html', 'resources/app/out/vs/sessions/electron-browser/dshDesktop.js', 'resources/app/dsh-plugins/dsh-compat.json', 'resources/app/extensions/agent-studio/out/extension.js'];

export function invalidateStaging(repoRoot) {
	for (const relative of [STAGING_REPORT_REL, STAGING_VERIFIED_REL, REPORT_REL, '.build/pack-reports/uploads.json', '.build/pack-reports/installer-comparison.json']) { fs.rmSync(path.join(repoRoot, relative), { force: true }); }
}

export function recordStaging(root, repoRoot, identity) {
	const reportPath = path.join(repoRoot, STAGING_REPORT_REL);
	fs.rmSync(reportPath, { force: true });
	identity ??= buildIdentity(repoRoot);
	const report = { schemaVersion: 1, ...identity, mode: policy.resolvePackPolicy().mode, root: fs.realpathSync(root), files: STAGING_SENTINELS.map(relative => ({ path: relative, sha256: policy.hashFile(path.join(root, relative)) })) };
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	return report;
}

export function verifyStaging(root, repoRoot, identity = buildIdentity(repoRoot)) {
	const report = JSON.parse(fs.readFileSync(path.join(repoRoot, STAGING_REPORT_REL), 'utf8'));
	if (report.schemaVersion !== 1 || report.commit !== identity.commit || report.productVersion !== identity.productVersion || report.mode !== policy.resolvePackPolicy().mode || path.relative(report.root, fs.realpathSync(root)) !== '') {
		throw new Error('staging was not packaged successfully for current commit/version; run package-vscode first');
	}
	for (const relative of STAGING_SENTINELS) {
		const expected = report.files?.find(file => file.path === relative);
		if (!expected || expected.sha256 !== policy.hashFile(path.join(root, relative))) { throw new Error(`staging changed after packaging: ${relative}`); }
	}
	return report;
}

function readBaseline(env) {
	return env.SAROS_PACK_BASELINE_REPORT ? JSON.parse(fs.readFileSync(env.SAROS_PACK_BASELINE_REPORT, 'utf8')) : undefined;
}

export function recordInstallers(root, env = process.env, identity) {
	const reportPath = path.join(root, REPORT_REL);
	fs.rmSync(reportPath, { force: true });
	identity ??= buildIdentity(root);
	const packPolicy = policy.resolvePackPolicy(env);
	const baseline = readBaseline(env);
	const report = { schemaVersion: 1, ...identity, target: packPolicy.target, mode: packPolicy.mode, policy: packPolicy, artifacts: policy.inspectInstallers(root, packPolicy, baseline) };
	fs.mkdirSync(path.dirname(reportPath), { recursive: true });
	const history = path.join(root, '.build/pack-reports/history', report.commit, `${report.mode}-${report.target}.json`);
	if (!/^[a-f0-9]{40}$/.test(report.commit)) { throw new Error('invalid build commit for report history'); }
	fs.mkdirSync(path.dirname(history), { recursive: true });
	fs.writeFileSync(history, JSON.stringify(report, null, 2) + '\n', 'utf8');
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	return report;
}

export function verifyInstallers(root, env = process.env, identity = buildIdentity(root)) {
	const report = JSON.parse(fs.readFileSync(path.join(root, REPORT_REL), 'utf8'));
	const packPolicy = policy.resolvePackPolicy(env);
	if (report.schemaVersion !== 1 || report.commit !== identity.commit || report.productVersion !== identity.productVersion || report.target !== packPolicy.target || report.mode !== packPolicy.mode) {
		throw new Error('installer report does not match current commit, version or setup targets; regenerate installers');
	}
	const artifacts = policy.inspectInstallers(root, packPolicy, readBaseline(env));
	for (const artifact of artifacts) {
		const expected = report.artifacts?.find(item => item.target === artifact.target);
		if (!expected || expected.size !== artifact.size || expected.sha256 !== artifact.sha256) { throw new Error(`installer changed since size gate: ${artifact.rel}`); }
	}
	return report;
}

function main(args) {
	if (args[0] === '--invalidate-staging') { invalidateStaging(REPO_ROOT); return; }
	const packPolicy = policy.resolvePackPolicy();
	if (args[0] === '--mode') { console.log(packPolicy.mode); return; }
	if (args[0] === '--check-seed') {
		const result = checkBundledSeed();
		console.log(`[pack-size] bundled seed verified: dsh=${result.bundled}, plugins=${result.plugins}`);
		return;
	}
	if (['--stage-model', '--prepare-model', '--check-model'].includes(args[0])) {
		if (!args[1]) { throw new Error('staging directory is required'); }
		const root = path.resolve(args[1]);
		const result = args[0] === '--check-model' ? checkStagedWhisperModel(root) : stageWhisperModel(root, process.env, undefined, { deferMissingOffline: args[0] === '--prepare-model' });
		console.log(`[pack-size] Whisper mode=${result.mode}${result.removedBytes ? ` removed=${(result.removedBytes / MIB).toFixed(2)} MiB` : ''}`);
		return;
	}
	if (args[0] === '--record-staging' || args[0] === '--check-staging') {
		if (!args[1]) { throw new Error('staging directory is required'); }
		const action = args[0] === '--record-staging' ? recordStaging : verifyStaging;
		action(path.resolve(args[1]), REPO_ROOT);
		console.log('[pack-size] staging build identity verified');
		return;
	}
	if (args[0] === '--targets-json') { console.log(JSON.stringify(policy.shellAssets(packPolicy.assets))); return; }
	if (args[0] === '--all-targets-json') { console.log(JSON.stringify(policy.shellAssets(policy.WINDOWS_ASSETS))); return; }
	if (args[0] === '--record-exes' || args[0] === '--check-exes') {
		if (args[0] === '--record-exes') {
			fs.rmSync(path.join(REPO_ROOT, REPORT_REL), { force: true });
			if (!args[1]) { throw new Error('--record-exes requires the staged application directory'); }
			verifyStaging(path.resolve(args[1]), REPO_ROOT);
			checkStagedWhisperModel(path.resolve(args[1]));
		}
		const report = args[0] === '--record-exes' ? recordInstallers(REPO_ROOT) : verifyInstallers(REPO_ROOT);
		for (const artifact of report.artifacts) { console.log(`[pack-size] ${artifact.target}: ${(artifact.size / MIB).toFixed(2)} MiB (max ${(packPolicy.maxExeBytes / MIB).toFixed(2)})`); }
		return;
	}
	if (args[0] !== '--audit' || !args[1]) { throw new Error('Usage: --audit <staging> [--clean] [--output <json>] | --targets-json | --record-exes <staging> | --check-exes'); }
	const root = path.resolve(args[1]);
	const outputIndex = args.indexOf('--output');
	if (outputIndex >= 0 && !args[outputIndex + 1]) { throw new Error('--output requires a file path'); }
	const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : path.join(REPO_ROOT, '.build/pack-reports/staging.json'));
	if (isWithin(root, output)) { throw new Error('audit output must not be inside staging'); }
	const cleanup = args.includes('--clean') ? cleanStaging(root) : undefined;
	const report = { ...auditStaging(root), cleanup };
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
	for (const group of report.groups) { console.log(`[pack-size] ${group.name}: ${(group.bytes / MIB).toFixed(2)} MiB / ${group.files} files`); }
	console.log(`[pack-size] logical=${(report.logicalBytes / MIB).toFixed(2)} MiB, independent duplicate candidates=${(report.independentDuplicateBytes / MIB).toFixed(2)} MiB, skipped links=${report.skippedLinks.length}`);
	if (cleanup) { console.log(`[pack-size] cleanup: ${cleanup.removed.length} entries / ${(cleanup.logicalBytesRemoved / MIB).toFixed(2)} logical MiB`); }
	console.log(`[pack-size] report: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(process.argv.slice(2)); } catch (error) { console.error(`[pack-size] ${error.message}`); process.exitCode = 1; }
}
