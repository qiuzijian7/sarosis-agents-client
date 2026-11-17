/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
const LOG_DAYS = 14;
const RUNTIME_DAYS = 7;
const LOG_KEEP = 50;
const ROTATE_BYTES = 8 * 1024 * 1024;
const ARCHIVES = 3;
const FIXED_LOGS = ['app-exit.log', 'launcher.log', 'launcher-invoked.log'];
const OLD_RUNTIMES = ['0.2.1-alpha.3', '0.2.1-rc.2'];

export function isBackupProfile(name) {
	return /\.(?:bak|backup)(?:[-._]|$)/i.test(name) || /^(?:_.*backup|\.trash-|.*\.staging-)/i.test(name);
}

function stat(file) {
	try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') { return undefined; } throw e; }
}

function entries(dir) {
	if (!stat(dir)?.isDirectory()) { return []; }
	return fs.readdirSync(dir, { withFileTypes: true });
}

function safePath(root, relative) {
	if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) { throw new Error('Path outside maintenance root'); }
	let current = root;
	for (const part of ['', ...relative.split(/[\\/]/)]) {
		current = path.join(current, part);
		if (stat(current)?.isSymbolicLink()) { throw new Error(`Linked path is protected: ${relative}`); }
	}
	return current;
}

function snapshot(root, relative) {
	const file = safePath(root, relative);
	const s = stat(file);
	if (!s) { return undefined; }
	return { path: relative, dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
}

function treeSummary(dir) {
	let bytes = 0, newest = 0;
	for (const e of entries(dir)) {
		const file = path.join(dir, e.name), s = fs.lstatSync(file);
		if (s.isSymbolicLink()) { throw new Error(`Linked tree is protected: ${dir}`); }
		newest = Math.max(newest, s.mtimeMs);
		if (s.isDirectory()) {
			const child = treeSummary(file);
			bytes += child.bytes;
			newest = Math.max(newest, child.newest);
		} else if (s.isFile()) { bytes += s.size; }
	}
	return { bytes, newest };
}

export function planDiagnostics(root, now = Date.now()) {
	const plan = [];
	const collect = (dir, match) => {
		safePath(root, dir);
		const groups = new Map();
		for (const e of entries(path.join(root, dir))) {
			if (!e.isFile()) { continue; }
			const group = match(e.name);
			if (!group) { continue; }
			const file = snapshot(root, path.join(dir, e.name));
			const values = groups.get(group) ?? [];
			values.push(file);
			groups.set(group, values);
		}
		for (const values of groups.values()) {
			values.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
			for (const [index, file] of values.entries()) {
				if (file.mtimeMs < now - LOG_DAYS * DAY || (index >= LOG_KEEP && file.mtimeMs < now - DAY)) {
					plan.push({ ...file, action: 'delete-file', bytes: file.size, reason: 'diagnostic-retention' });
				}
			}
		}
	};
	collect('logs', name => /^(app-stdout-|app-stderr-)\d[\d.-]*\.log$/.exec(name)?.[1]);
	collect('dsh-run', name => /^(host-|harness-)[a-f\d]+\.log$/i.exec(name)?.[1]);
	collect('User/globalStorage/saros.saros-codebuddy-provider', name => /^http-debug-\d{4}-\d{2}-\d{2}\.log$/.test(name) ? 'http-debug' : undefined);
	for (const name of FIXED_LOGS) {
		const file = snapshot(root, path.join('logs', name));
		if (file && stat(path.join(root, file.path)).isFile() && file.size >= ROTATE_BYTES) {
			for (let i = 1; i <= ARCHIVES; i++) { safePath(root, `${file.path}.${i}`); }
			plan.push({ ...file, action: 'rotate', bytes: 0, reason: 'diagnostic-size-limit' });
		}
	}
	return plan;
}

export function planMaintenance(root, { now = Date.now(), startup = false, bundledVersion = '', references = '' } = {}) {
	const plan = planDiagnostics(root, now);
	if (startup) { return plan; }
	for (const name of OLD_RUNTIMES) {
		if (!bundledVersion || name === bundledVersion || references.replace(/[\\/]+/g, '/').includes(`dsh-runtime/${name}`)) { continue; }
		const relative = path.join('dsh-runtime', name), file = snapshot(root, relative);
		if (!file || !stat(path.join(root, relative)).isDirectory()) { continue; }
		const tree = treeSummary(path.join(root, relative));
		if (tree.newest < now - RUNTIME_DAYS * DAY) {
			plan.push({ ...file, action: 'delete-tree', bytes: tree.bytes, reason: 'obsolete-runtime' });
		}
	}
	for (const name of ['video-analyze', 'video-frames']) {
		const relative = path.join('tmp', name), file = snapshot(root, relative);
		if (!file || !stat(path.join(root, relative)).isDirectory()) { continue; }
		const tree = treeSummary(path.join(root, relative));
		if (Math.max(file.mtimeMs, tree.newest) < now - 30 * DAY) {
			plan.push({ ...file, action: 'delete-tree', bytes: tree.bytes, reason: 'expired-video-temporary' });
		}
	}
	return plan;
}

function isAllowed(item) {
	const p = item.path.replace(/\\/g, '/');
	if (item.action === 'rotate') { return FIXED_LOGS.some(name => p === `logs/${name}`); }
	if (item.action === 'delete-file') {
		return /^logs\/app-(?:stdout|stderr)-\d[\d.-]*\.log$/.test(p)
			|| /^dsh-run\/(?:host|harness)-[a-f\d]+\.log$/i.test(p)
			|| /^User\/globalStorage\/saros\.saros-codebuddy-provider\/http-debug-\d{4}-\d{2}-\d{2}\.log$/.test(p);
	}
	return item.action === 'delete-tree' && (OLD_RUNTIMES.some(name => p === `dsh-runtime/${name}`) || ['tmp/video-analyze', 'tmp/video-frames'].includes(p));
}

export function applyPlan(root, plan) {
	const result = { removedBytes: 0, removed: 0, rotated: 0, skipped: [] };
	for (const item of plan) {
		try {
			if (!isAllowed(item)) { throw new Error('Not in maintenance allowlist'); }
			const file = safePath(root, item.path), s = stat(file);
			if (!s || s.dev !== item.dev || s.ino !== item.ino || s.mtimeMs !== item.mtimeMs || s.size !== item.size) {
				throw new Error('Changed since audit');
			}
			if (item.action === 'rotate') {
				for (let i = 1; i <= ARCHIVES; i++) { safePath(root, `${item.path}.${i}`); }
				const last = `${file}.${ARCHIVES}`;
				if (stat(last)) { result.removedBytes += fs.statSync(last).size; fs.unlinkSync(last); }
				for (let i = ARCHIVES - 1; i >= 1; i--) {
					if (stat(`${file}.${i}`)) { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); }
				}
				fs.renameSync(file, `${file}.1`);
				result.rotated++;
			} else if (item.action === 'delete-tree') {
				const tree = treeSummary(file);
				if (tree.bytes !== item.bytes || tree.newest > Date.now() - (item.reason === 'obsolete-runtime' ? RUNTIME_DAYS : 30) * DAY) {
					throw new Error('Tree changed or no longer expired');
				}
				fs.rmSync(file, { recursive: true });
				result.removedBytes += tree.bytes;
				result.removed++;
			} else {
				fs.unlinkSync(file);
				result.removedBytes += s.size;
				result.removed++;
			}
		} catch (e) {
			result.skipped.push({ path: item.path, reason: e.message });
			if (String(e.message).includes('[safe-delete]')) {
				result.blocked = e.message;
				break;
			}
		}
	}
	return result;
}

function activity(root) {
	if (process.platform !== 'win32') { return { blocked: true, reason: 'Process guard is only available on Windows' }; }
	const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
	const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
	if (r.status !== 0 || !r.stdout.trim()) { return { blocked: true, reason: 'Process inventory unavailable; refusing cleanup' }; }
	const rows = JSON.parse(r.stdout), normalized = root.toLowerCase().replace(/\\/g, '/');
	const running = (Array.isArray(rows) ? rows : [rows]).filter(p => {
		if (p.ProcessId === process.pid) { return false; }
		const command = String(p.CommandLine ?? '').toLowerCase().replace(/\\/g, '/');
		return /^vssaros dev\.exe$/i.test(p.Name)
			|| (/^(?:node|vssaros|saroasis harness)\.exe$/i.test(p.Name) && command.includes(normalized))
			|| (/^node\.exe$/i.test(p.Name) && /(?:start-dev-app|spawn-detached)\.mjs/.test(command));
	});
	const lock = path.join(root, 'code.lock');
	if (stat(lock)?.isFile()) {
		const pid = Number((fs.readFileSync(lock, 'utf8').match(/\d+/) ?? [0])[0]);
		if (pid && (Array.isArray(rows) ? rows : [rows]).some(p => p.ProcessId === pid)) {
			return { blocked: true, reason: `Profile lock is held by pid ${pid}` };
		}
	}
	return { blocked: running.length > 0, reason: running.length ? `Active profile/launcher process(es): ${running.map(p => p.ProcessId).join(',')}` : '' };
}

function maintenanceContext(root) {
	const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const bundledVersion = JSON.parse(fs.readFileSync(path.join(repo, 'dsh-plugins/dsh-compat.json'), 'utf8')).bundled;
	let references = '';
	for (const relative of ['User/settings.json', 'dsh-home/profiles/vssaros/package.json', 'dsh-home/profiles/vssaros/pnpm-lock.yaml']) {
		const file = safePath(root, relative);
		if (stat(file)?.isFile()) { references += fs.readFileSync(file, 'utf8'); }
	}
	return { bundledVersion, references };
}

function withMaintenanceLock(root, run) {
	const lock = safePath(root, '.dev-storage-maintenance.lock');
	fs.mkdirSync(lock);
	try { return run(); } finally { fs.rmdirSync(lock); }
}

export function maintainStartupLogs(root) {
	try {
		return withMaintenanceLock(root, () => {
			const guard = activity(root);
			if (guard.blocked) { return { skipped: guard.reason }; }
			return applyPlan(root, planDiagnostics(root));
		});
	} catch (e) { return { skipped: e.message }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.some(a => !['--audit', '--apply', '--startup'].includes(a))) { throw new Error('Usage: node scripts/dev-storage-maintenance.mjs [--audit|--apply] [--startup]'); }
	const root = path.join(os.homedir(), '.vssaros-dev');
	const guard = activity(root);
	const plan = planMaintenance(root, { ...maintenanceContext(root), startup: args.includes('--startup') });
	const groups = new Map();
	for (const item of plan) {
		const g = groups.get(item.reason) ?? { count: 0, bytes: 0 };
		g.count++; g.bytes += item.bytes; groups.set(item.reason, g);
	}
	console.log(JSON.stringify({ root, mode: args.includes('--apply') ? 'apply' : 'audit', guard, candidates: Object.fromEntries(groups), trees: plan.filter(p => p.action === 'delete-tree').map(p => ({ path: p.path, bytes: p.bytes })), protected: ['current profile', 'profile/home backups', 'media', 'sessions', 'credentials', 'IndexedDB', 'managed Node'] }, null, 2));
	if (args.includes('--apply')) {
		if (guard.blocked) { throw new Error(guard.reason); }
		withMaintenanceLock(root, () => {
			const recheck = activity(root);
			if (recheck.blocked) { throw new Error(recheck.reason); }
			const result = applyPlan(root, plan);
			console.log(JSON.stringify({ ...result, skipped: result.skipped.slice(0, 20), skippedCount: result.skipped.length }, null, 2));
			if (result.blocked || result.skipped.length) { process.exitCode = 1; }
		});
	}
}
