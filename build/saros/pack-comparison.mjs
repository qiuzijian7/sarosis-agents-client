/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import policy from './pack-policy.cjs';
import { WHISPER_MODEL } from '../../dsh-plugins/vssaros-web-content-import/lib/whisperModel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const COMPRESSION_KEYS = ['Compression', 'SolidCompression', 'LZMAUseSeparateProcess', 'LZMANumBlockThreads', 'LZMADictionarySize'];

export function compressionSettings(source) {
	const settings = [];
	for (const key of COMPRESSION_KEYS) {
		const matches = [...source.matchAll(new RegExp(`^${key}=([^\\r\\n]+)$`, 'gm'))];
		if (matches.length !== 1) { throw new Error(`Expected one Inno compression setting: ${key}`); }
		settings.push(`${key}=${matches[0][1].trim()}`);
	}
	return settings;
}

export function compareInstallerReports(offline, standard) {
	if (!offline || !standard || offline.schemaVersion !== 1 || standard.schemaVersion !== 1 || offline.mode !== 'offline' || standard.mode !== 'standard'
		|| offline.commit !== standard.commit || !/^[a-f0-9]{40}$/.test(offline.commit || '')
		|| typeof offline.productVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(offline.productVersion)
		|| !['both', 'user', 'system'].includes(offline.target)
		|| offline.productVersion !== standard.productVersion || offline.target !== standard.target) {
		throw new Error('Comparison requires offline/standard reports for the same commit, version and setup targets');
	}
	const selected = policy.resolvePackPolicy({ SAROS_SETUP_TARGETS: offline.target }).assets;
	for (const report of [offline, standard]) {
		if (!Array.isArray(report.artifacts) || report.artifacts.length !== selected.length) { throw new Error('Comparison report has missing or duplicate artifacts'); }
		for (const asset of selected) {
			const matches = report.artifacts.filter(item => item.target === asset.target && item.platform === asset.platform && item.rel === asset.rel);
			if (matches.length !== 1 || !Number.isSafeInteger(matches[0].size) || matches[0].size < 10 * 1048576 || !/^[a-f0-9]{64}$/.test(matches[0].sha256 || '')) {
				throw new Error(`Comparison report contains an invalid installer: ${asset.target}`);
			}
		}
	}
	return {
		schemaVersion: 1, scope: 'reported-full-installers', commit: offline.commit, productVersion: offline.productVersion,
		notes: ['Size comparison uses saved reports; installers are verified by the build/upload gates, not re-read by this command.'],
		artifacts: selected.map(asset => {
			const before = offline.artifacts.find(item => item.target === asset.target);
			const after = standard.artifacts.find(item => item.target === asset.target);
			const savedBytes = before.size - after.size;
			return { target: asset.target, offlineBytes: before.size, standardBytes: after.size, savedBytes, savedPercent: savedBytes / before.size * 100 };
		}),
	};
}

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** The probe installer is never run or published; it measures model payload compression only. */
export function measureWhisperCompression(root = ROOT) {
	if (process.platform !== 'win32') { throw new Error('Inno compression measurement requires Windows'); }
	const model = path.join(root, 'build/saros/models', WHISPER_MODEL.fileName);
	if (fs.statSync(model).size !== WHISPER_MODEL.size || policy.hashFile(model) !== WHISPER_MODEL.sha256) { throw new Error('Whisper model is missing or differs from pinned SHA256'); }
	const compiler = path.join(path.dirname(path.dirname(require.resolve('innosetup'))), 'bin/ISCC.exe');
	if (!fs.existsSync(compiler)) { throw new Error('Local Inno Setup compiler is missing'); }
	const settings = compressionSettings(fs.readFileSync(path.join(root, 'build/win32/code.iss'), 'utf8'));
	const reports = path.join(root, '.build/pack-reports');
	fs.mkdirSync(reports, { recursive: true });
	const temporary = fs.mkdtempSync(path.join(reports, '.compression-probe-'));
	try {
		const base = path.join(temporary, 'base.json');
		fs.writeFileSync(base, JSON.stringify({ purpose: 'compression probe only', model: WHISPER_MODEL.id }) + '\n', 'utf8');
		const results = [];
		for (const mode of ['standard', 'offline']) {
			const output = path.join(temporary, mode);
			fs.mkdirSync(output);
			const file = path.join(temporary, `${mode}.iss`);
			const body = [
				'[Setup]', 'AppName=VsSaros Model Compression Probe', 'AppVersion=1.0',
				'DefaultDirName={tmp}\\VsSaros-Compression-Probe', 'PrivilegesRequired=lowest',
				'Uninstallable=no', 'CreateAppDir=no', 'OutputBaseFilename=payload-probe', `OutputDir=${output}`,
				...settings, '[Files]', `Source: "${base}"; DestDir: "{app}"; Flags: ignoreversion`,
				...(mode === 'offline' ? [`Source: "${model}"; DestDir: "{app}"; Flags: ignoreversion`] : []),
			].join('\n');
			fs.writeFileSync(file, '\ufeff' + body + '\n', 'utf8');
			const start = performance.now();
			const result = spawnSync(compiler, ['/Qp', file], { encoding: 'utf8', timeout: 900000, maxBuffer: 4 * 1048576, windowsHide: true });
			if (result.error || result.status !== 0) { throw new Error(`Inno compression probe failed (${result.status}): ${result.error?.message || result.stderr || result.stdout}`); }
			results.push({ mode, bytes: fs.statSync(path.join(output, 'payload-probe.exe')).size, elapsedMs: Math.round(performance.now() - start) });
		}
		const report = {
			schemaVersion: 1, scope: 'whisper-payload-only', compression: settings,
			compilerPackage: JSON.parse(fs.readFileSync(require.resolve('innosetup/package.json'), 'utf8')).version,
			model: { id: WHISPER_MODEL.id, rawBytes: WHISPER_MODEL.size, sha256: WHISPER_MODEL.sha256 },
			results, compressedModelDeltaBytes: results[1].bytes - results[0].bytes,
			notes: ['This is an isolated model compression experiment, not a complete VsSaros installer.', 'Full EXE savings depend on file order and solid compression context; use same-build full-installer reports for release numbers.', 'Probe installers are removed and never executed or published.'],
		};
		writeJson(path.join(reports, 'whisper-compression.json'), report);
		return report;
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

function main(args) {
	if (args[0] === '--measure-whisper') {
		const report = measureWhisperCompression();
		console.log(`[pack-compare] model raw=${(report.model.rawBytes / 1048576).toFixed(2)} MiB; isolated compressed delta=${(report.compressedModelDeltaBytes / 1048576).toFixed(2)} MiB`);
		console.log('[pack-compare] payload experiment only; full installer savings are not yet measured');
		return;
	}
	if (args[0] === '--compare') { fs.rmSync(path.join(ROOT, '.build/pack-reports/installer-comparison.json'), { force: true }); }
	if (args[0] !== '--compare' || !args[1] || !args[2]) { throw new Error('Usage: --measure-whisper | --compare <offline-installers.json> <standard-installers.json>'); }
	const report = compareInstallerReports(JSON.parse(fs.readFileSync(args[1], 'utf8')), JSON.parse(fs.readFileSync(args[2], 'utf8')));
	writeJson(path.join(ROOT, '.build/pack-reports/installer-comparison.json'), report);
	for (const artifact of report.artifacts) { console.log(`[pack-compare] ${artifact.target}: saved ${(artifact.savedBytes / 1048576).toFixed(2)} MiB (${artifact.savedPercent.toFixed(2)}%)`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(process.argv.slice(2)); } catch (error) { console.error(`[pack-compare] ${error.message}`); process.exitCode = 1; }
}
