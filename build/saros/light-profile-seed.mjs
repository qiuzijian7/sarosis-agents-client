#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const LIGHT_SEED_REVISION = 1;
const METADATA_FILES = ['cordis.yml', 'cordis.patch.yml', 'compatibility.json', 'pnpm-workspace.yaml'];
const REQUIRED_RESOURCES = {
	'@vssaros/dsh-dashboard': ['lib/app/dist/dashboard-app.js'],
	'@vssaros/dsh-agents': ['lib/adapters/vendor/deps/ws/index.js', 'cordis.presets.yml'],
	'@vssaros/dsh-skill-bundle': ['skills'],
};

function readJson(file) {
	let value;
	try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
		throw new Error(`Invalid or unreadable package metadata: ${file}`, { cause: error });
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`Invalid JSON object: ${file}`); }
	return value;
}

function packageName(name) {
	if (typeof name !== 'string' || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)
		|| name.split('/').some(part => part === '.' || part === '..')) { throw new Error(`Invalid package name: ${name}`); }
	return name;
}

function inside(file, root) {
	const relative = path.relative(root, file);
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertContained(file, roots) {
	const real = fs.realpathSync(file);
	if (!roots.some(root => inside(real, root))) { throw new Error(`Package/resource escapes seed or runtime: ${file}`); }
	return real;
}

function resolvePackage(anchor, name, roots) {
	packageName(name);
	for (const modules of createRequire(anchor).resolve.paths(name) ?? []) {
		const dir = path.join(modules, ...name.split('/'));
		if (!roots.some(root => inside(dir, root))) { continue; }
		if (fs.existsSync(path.join(dir, 'package.json'))) {
			assertContained(dir, roots);
			return dir;
		}
	}
	return undefined;
}

function dependencies(manifest) {
	const edges = new Map();
	for (const [name] of Object.entries(manifest.dependencies ?? {})) { edges.set(name, false); }
	for (const [name] of Object.entries(manifest.peerDependencies ?? {})) {
		if (!edges.has(name)) { edges.set(name, manifest.peerDependenciesMeta?.[name]?.optional === true); }
	}
	for (const [name] of Object.entries(manifest.optionalDependencies ?? {})) { edges.set(name, true); }
	return edges;
}

function runtimePackages(runtimeDir) {
	const anchor = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
	const cli = readJson(anchor);
	if (cli.name !== '@deepseek-ai/dsh' || typeof cli.version !== 'string') { throw new Error('Runtime CLI identity is invalid'); }
	const roots = [fs.realpathSync(runtimeDir)];
	const found = new Map([[cli.name, { dir: path.dirname(anchor), manifest: cli }]]);
	const queue = [{ anchor, manifest: cli }];
	for (let i = 0; i < queue.length; i++) {
		if (queue.length > 4_096) { throw new Error('Runtime dependency graph exceeds the safety limit'); }
		const current = queue[i];
		for (const [name, optional] of dependencies(current.manifest)) {
			if (found.has(name)) { continue; }
			const dir = resolvePackage(current.anchor, name, roots);
			if (!dir) {
				if (optional) { continue; }
				throw new Error(`Runtime dependency is missing: ${name}`);
			}
			const manifest = readJson(path.join(dir, 'package.json'));
			found.set(name, { dir, manifest });
			queue.push({ anchor: path.join(dir, 'package.json'), manifest });
		}
	}
	return { cli, found };
}

function installedPackages(modules, roots, out = [], visited = new Set()) {
	if (!fs.existsSync(modules)) { return out; }
	const real = assertContained(modules, roots);
	if (visited.has(real)) { return out; }
	visited.add(real);
	if (real.split(path.sep).includes('.pnpm')) { throw new Error('Light seed requires a hoisted full seed; live isolated .pnpm layouts are not supported'); }
	for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) { continue; }
		const folder = path.join(modules, entry.name);
		const candidates = entry.name.startsWith('@')
			? fs.readdirSync(assertContained(folder, roots), { withFileTypes: true }).map(child => path.join(folder, child.name))
			: [folder];
		for (const dir of candidates) {
			if (!fs.existsSync(path.join(dir, 'package.json'))) { continue; }
			const packageRealPath = assertContained(dir, roots);
			if (packageRealPath.split(path.sep).includes('.pnpm')) { throw new Error('Light seed requires a hoisted full seed; live isolated .pnpm packages are not supported'); }
			const manifest = readJson(path.join(dir, 'package.json'));
			out.push({ dir, manifest });
			installedPackages(path.join(dir, 'node_modules'), roots, out, visited);
		}
	}
	return out;
}

function entryPaths(value) {
	if (typeof value === 'string') { return value.startsWith('./') ? [value] : []; }
	if (!value || typeof value !== 'object') { return []; }
	return Object.entries(value).filter(([key]) => key !== 'types').flatMap(([, child]) => entryPaths(child));
}

function verifyPackage(dir, manifest, roots) {
	const exports = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.'];
	const entries = entryPaths(exports);
	if (!entries.length && typeof manifest.main === 'string') { entries.push(manifest.main); }
	const patches = manifest.dsh?.bundle?.patch;
	if (patches !== undefined) {
		if (typeof patches !== 'string' && !Array.isArray(patches)) { throw new Error(`Invalid bundle patch declaration: ${manifest.name}`); }
		entries.push(...(Array.isArray(patches) ? patches : [patches]));
	}
	for (const rel of [...entries, ...(REQUIRED_RESOURCES[manifest.name] ?? [])]) {
		if (typeof rel !== 'string' || path.isAbsolute(rel) || !inside(path.resolve(dir, rel), dir)) { throw new Error(`Invalid package resource: ${manifest.name}`); }
		const resource = path.resolve(dir, rel);
		if (!fs.existsSync(resource)) { throw new Error(`Required package resource is missing: ${manifest.name}/${rel}`); }
		assertContained(resource, roots);
	}
}

/** Read-only plan. Keep all third-party dependency pockets; omit only matching runtime-owned packages. */
export function planLightProfileSeed({ runtimeDir, profile = 'vssaros' }) {
	if (!path.isAbsolute(runtimeDir) || !/^[a-zA-Z0-9_-]+$/.test(profile)) { throw new Error('Absolute runtime directory and a valid profile name are required'); }
	runtimeDir = fs.realpathSync(runtimeDir);
	const fullSeedDir = path.join(runtimeDir, 'profile-seed');
	const fullProfile = path.join(fullSeedDir, 'profiles', profile);
	const sourceMarker = readJson(path.join(fullSeedDir, 'seed.json'));
	const manifest = readJson(path.join(fullProfile, 'package.json'));
	const runtime = runtimePackages(runtimeDir);
	if (typeof runtime.cli.version !== 'string' || sourceMarker.dsh !== runtime.cli.version || !sourceMarker.plugins || typeof sourceMarker.plugins !== 'object' || Array.isArray(sourceMarker.plugins)) { throw new Error('Full seed does not match the runtime version'); }
	const bundles = manifest.dsh?.profile?.bundles;
	if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) { throw new Error('Full seed bundle list is invalid'); }
	const roots = [runtimeDir];
	const packages = installedPackages(path.join(fullProfile, 'node_modules'), roots);
	const omitted = [];
	const providers = Object.create(null);
	for (const item of packages) {
		const name = packageName(item.manifest.name);
		const provider = runtime.found.get(name);
		if (!name.startsWith('@deepseek-ai/') || !provider) { continue; }
		if (provider.manifest.name !== name || typeof provider.manifest.version !== 'string' || provider.manifest.version !== item.manifest.version) { throw new Error(`Runtime/profile package version conflict: ${name}`); }
		verifyPackage(provider.dir, provider.manifest, roots);
		providers[name] = provider.manifest.version;
		omitted.push(item.dir);
	}
	const localDependencies = Object.create(null);
	const archives = [];
	for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
		packageName(name);
		if (providers[name]) { continue; }
		const local = path.join(fullProfile, 'node_modules', ...name.split('/'));
		const pkg = readJson(path.join(local, 'package.json'));
		if (pkg.name !== name || sourceMarker.plugins[name] !== pkg.version) { throw new Error(`Full seed plugin is missing or has the wrong version: ${name}`); }
		verifyPackage(local, pkg, roots);
		if (typeof spec !== 'string' || !spec.startsWith('file:.vssaros/plugins/') || !spec.endsWith('.tgz')) { throw new Error(`Non-portable local plugin archive: ${name}`); }
		const relative = spec.slice(5);
		const archive = path.resolve(fullProfile, relative);
		if (!inside(archive, path.join(fullProfile, '.vssaros', 'plugins')) || !fs.existsSync(archive)) { throw new Error(`Local plugin archive is missing: ${name}`); }
		assertContained(archive, [fs.realpathSync(fullProfile)]);
		archives.push({ relative, source: archive });
		localDependencies[name] = spec;
	}
	for (const name of bundles) {
		packageName(name);
		const provider = runtime.found.get(name);
		if (provider && name.startsWith('@deepseek-ai/')) {
			verifyPackage(provider.dir, provider.manifest, roots);
			providers[name] = provider.manifest.version;
		} else if (!localDependencies[name]) { throw new Error(`Bundle has no local or runtime provider: ${name}`); }
	}
	const retained = packages.filter(item => !omitted.some(dir => inside(item.dir, dir)));
	for (const item of retained) {
		for (const [name, optional] of dependencies(item.manifest)) {
			const resolved = resolvePackage(path.join(item.dir, 'package.json'), name, roots);
			if (resolved && inside(fs.realpathSync(resolved), fs.realpathSync(fullProfile))) { continue; }
			const provider = runtime.found.get(name);
			if (!provider) {
				if (optional) { continue; }
				if (Object.hasOwn(item.manifest.peerDependencies ?? {}, name) && !Object.hasOwn(item.manifest.dependencies ?? {}, name)) {
					throw new Error(`Unverified peer provider: ${item.manifest.name} needs ${name}; verify client injection or supply a qualified runtime package`);
				}
				throw new Error(`Dependency pocket is incomplete: ${item.manifest.name} needs ${name}`);
			}
			if (resolved && readJson(path.join(resolved, 'package.json')).version !== provider.manifest.version) { throw new Error(`Runtime resolution conflict: ${name}`); }
			verifyPackage(provider.dir, provider.manifest, roots);
			providers[name] = provider.manifest.version;
		}
	}
	const pnpm = Object.fromEntries(['onlyBuiltDependencies', 'ignoredBuiltDependencies', 'overrides']
		.filter(key => manifest.pnpm?.[key] !== undefined).map(key => [key, manifest.pnpm[key]]));
	return {
		runtimeDir, fullProfile, profile, dshVersion: runtime.cli.version, packages, omitted, providers, archives,
		manifest: { name: manifest.name, private: true, dependencies: localDependencies, dsh: { profile: { bundles: [...bundles] } }, pnpm },
		stats: { localPlugins: Object.keys(localDependencies).length, runtimeProviders: Object.keys(providers).length, omittedPackageCopies: packages.length - retained.length, retainedPackageCopies: retained.length },
	};
}

/** Validate static resolution and sentinels only; this does not qualify Host, HMR or subsequent pnpm mutations. */
export function validateLightProfileSeed(profileDir, plan) {
	const manifest = readJson(path.join(profileDir, 'package.json'));
	if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify(plan.manifest.dsh.profile.bundles)) { throw new Error('Light seed changed bundle order'); }
	if (JSON.stringify(manifest.dependencies) !== JSON.stringify(plan.manifest.dependencies)) { throw new Error('Light seed local dependency metadata differs'); }
	for (const relative of ['pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm', '.credentials.yaml']) {
		if (fs.existsSync(path.join(profileDir, relative))) { throw new Error(`Full-layout or credential metadata leaked into light seed: ${relative}`); }
	}
	const roots = [fs.realpathSync(profileDir), plan.runtimeDir];
	for (const item of plan.packages) {
		const local = path.join(profileDir, path.relative(plan.fullProfile, item.dir));
		if (plan.omitted.some(dir => inside(item.dir, dir))) {
			if (fs.existsSync(local)) { throw new Error(`Runtime package still has a profile copy: ${item.manifest.name}`); }
			continue;
		}
		const actual = readJson(path.join(local, 'package.json'));
		if (actual.name !== item.manifest.name || actual.version !== item.manifest.version) { throw new Error(`Retained dependency changed: ${item.manifest.name}`); }
		verifyPackage(local, actual, roots);
		for (const [name, optional] of dependencies(actual)) {
			if (!resolvePackage(path.join(local, 'package.json'), name, roots) && !plan.providers[name] && !optional) {
				throw new Error(`Light dependency is unreachable: ${actual.name} needs ${name}`);
			}
		}
	}
	for (const archive of plan.archives) {
		if (!fs.existsSync(path.join(profileDir, archive.relative))) { throw new Error(`Light archive is missing: ${archive.relative}`); }
	}
	return true;
}

function projectedRealPath(file) {
	let cursor = file;
	const tail = [];
	for (;;) {
		try { fs.lstatSync(cursor); break; } catch (error) {
			if (error.code !== 'ENOENT') { throw error; }
			tail.unshift(path.basename(cursor));
			const parent = path.dirname(cursor);
			if (parent === cursor) { throw error; }
			cursor = parent;
		}
	}
	return path.join(fs.realpathSync(cursor), ...tail);
}

/** Build a separate experimental candidate, never modifying the full seed or replacing an existing destination. */
export async function buildLightProfileSeed({ runtimeDir, outputDir, profile = 'vssaros' }) {
	if (!path.isAbsolute(outputDir)) { throw new Error('An absolute output directory is required'); }
	const plan = planLightProfileSeed({ runtimeDir, profile });
	outputDir = path.resolve(outputDir);
	const effectiveOutput = projectedRealPath(outputDir);
	if (inside(effectiveOutput, plan.runtimeDir) || inside(plan.runtimeDir, effectiveOutput)) { throw new Error('Light output must not overlap the existing runtime/full seed'); }
	fs.mkdirSync(path.dirname(outputDir), { recursive: true });
	fs.mkdirSync(outputDir);
	const profileDir = path.join(outputDir, 'profiles', profile);
	try {
		fs.mkdirSync(profileDir, { recursive: true });
		await fs.promises.cp(path.join(plan.fullProfile, 'node_modules'), path.join(profileDir, 'node_modules'), {
			recursive: true, dereference: true, errorOnExist: true, force: false,
			filter: source => {
				if (plan.omitted.some(dir => inside(source, dir)) || ['.modules.yaml', '.credentials.yaml', '.bin', '.pnpm'].includes(path.basename(source))) { return false; }
				assertContained(source, [plan.runtimeDir]);
				return true;
			},
		});
		for (const name of METADATA_FILES) {
			const source = path.join(plan.fullProfile, name);
			if (!fs.existsSync(source)) { continue; }
			assertContained(source, [plan.runtimeDir]);
			if (name === 'pnpm-workspace.yaml' && /dangerouslyAllowAllBuilds\s*:\s*true/i.test(fs.readFileSync(source, 'utf8'))) { throw new Error('Unsafe build-script policy in source seed'); }
			fs.copyFileSync(source, path.join(profileDir, name), fs.constants.COPYFILE_EXCL);
		}
		for (const archive of plan.archives) {
			const destination = path.join(profileDir, archive.relative);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(archive.source, destination, fs.constants.COPYFILE_EXCL);
		}
		fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(plan.manifest, null, 2) + '\n', { flag: 'wx' });
		validateLightProfileSeed(profileDir, plan);
		const metadata = {
			generatorRevision: LIGHT_SEED_REVISION, layout: 'runtime-core-experimental', dsh: plan.dshVersion,
			plugins: Object.fromEntries(Object.keys(plan.manifest.dependencies).map(name => [name, readJson(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')).version])),
			runtimePackages: plan.providers,
			qualification: { static: true, host: false, hmr: false, workers: false, packageManager: false },
			...plan.stats,
		};
		fs.writeFileSync(path.join(outputDir, 'seed.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
		return { outputDir, profileDir, ...plan.stats };
	} catch (error) {
		await fs.promises.rm(outputDir, { recursive: true, force: true });
		throw error;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		const options = {};
		let planOnly = false;
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '--plan') { planOnly = true; continue; }
			const name = { '--runtime': 'runtimeDir', '--output': 'outputDir', '--profile': 'profile' }[args[i]];
			if (!name || !args[i + 1] || args[i + 1].startsWith('--') || options[name]) { throw new Error('Usage: --runtime <absolute-dir> [--profile <name>] (--plan | --output <absolute-new-dir>)'); }
			options[name] = args[++i];
		}
		if (!options.runtimeDir || (!planOnly && !options.outputDir)) { throw new Error('Runtime and a separate output directory are required'); }
		const result = planOnly ? planLightProfileSeed(options).stats : await buildLightProfileSeed(options);
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(`[light-profile-seed] ${error.message}`);
		process.exitCode = 1;
	}
}
