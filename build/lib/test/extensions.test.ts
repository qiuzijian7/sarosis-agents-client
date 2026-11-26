/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import es from 'event-stream';
import File from 'vinyl';
import buffer from 'gulp-buffer';
import vzip from 'gulp-vinyl-zip';
import { esbuildExtensions, fromGithub, fromMarketplace, fromVsix, getBuildRootsForExtension, isWebExtension, scanBuiltinExtensions, typeCheckExtension } from '../extensions.ts';
import type { IExtensionDefinition } from '../builtInExtensions.ts';
import { spawnTsgo } from '../tsgo.ts';
import type { Stream } from 'node:stream';

function fixture(t: TestContext): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-build test-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function collect(input: Stream): Promise<File[]> {
	return new Promise((resolve, reject) => {
		const files: File[] = [];
		input.on('data', file => files.push(file));
		input.once('error', reject);
		input.once('end', () => resolve(files));
	});
}

const definition: IExtensionDefinition = {
	name: 'sample', version: '1.0.0', sha256: '', repo: 'https://github.com/example/sample',
	metadata: {
		id: 'sample', publisherDisplayName: 'Example',
		publisherId: { publisherId: 'example', publisherName: 'example', displayName: 'Example', flags: '' }
	}
};

test('extension build exports satisfy existing gulp and downloader contracts', () => {
	for (const fn of [esbuildExtensions, fromGithub, fromMarketplace, fromVsix, getBuildRootsForExtension, scanBuiltinExtensions, typeCheckExtension]) {
		assert.equal(typeof fn, 'function');
	}
});

test('build root discovery parses JSONC and inherited options without silently ignoring invalid configs', t => {
	const directory = fixture(t);
	fs.writeFileSync(path.join(directory, 'base.json'), '{ "compilerOptions": { "target": "es2024", "types": [] } }');
	fs.writeFileSync(path.join(directory, 'index.ts'), 'export {};');
	const project = path.join(directory, 'tsconfig.json');
	fs.writeFileSync(project, '{ // valid JSONC\n "extends": "./base.json", "files": ["index.ts"], }');
	assert.deepEqual(getBuildRootsForExtension(directory), [project]);
	fs.writeFileSync(project, '{ "extends": "./base.json", "compilerOptions": { "noEmit": true }, "files": ["index.ts"] }');
	assert.deepEqual(getBuildRootsForExtension(directory), []);
	fs.writeFileSync(project, '{ invalid');
	assert.throws(() => getBuildRootsForExtension(directory), /tsconfig\.json/);
});

test('VSIX extraction verifies checksum and removes only the archive extension prefix', async t => {
	const directory = fixture(t);
	const files = await collect(es.readArray([
		new File({ base: directory, path: path.join(directory, 'extension/package.json'), contents: Buffer.from('{"name":"sample","scripts":{"compile":"tsc"},"devDependencies":{"typescript":"6"}}') }),
		new File({ base: directory, path: path.join(directory, 'extension/dist/extension.js'), contents: Buffer.from('export {};') }),
		new File({ base: directory, path: path.join(directory, 'extension.vsixmanifest'), contents: Buffer.from('manifest') }),
	]).pipe(vzip.zip('sample.vsix')).pipe(buffer()));
	const contents = files[0].contents as Buffer;
	const vsix = path.join(directory, 'sample.vsix');
	fs.writeFileSync(vsix, contents);
	const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
	const extracted = await collect(fromVsix(vsix, { ...definition, sha256 }).pipe(buffer()));
	assert.deepEqual(extracted.map(file => file.relative.replaceAll('\\', '/')).sort(), ['dist/extension.js', 'package.json']);
	assert.throws(() => fromVsix(vsix, { ...definition, sha256: '0'.repeat(64) }), /Checksum mismatch/);
	let requestedUrl = '';
	t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
		requestedUrl = url;
		assert.equal((options.headers as Record<string, string>)['User-Agent'], 'VSCode Build');
		return new Response(new Uint8Array(contents), { status: 200 });
	});
	const downloaded = await collect(fromMarketplace('https://example.test', { ...definition, sha256 }).pipe(buffer()));
	assert.ok(requestedUrl.endsWith('/publishers/example/vsextensions/sample/1.0.0/vspackage'));
	const packageJSON = downloaded.find(file => file.relative === 'package.json');
	assert.ok(packageJSON?.isBuffer());
	assert.deepEqual(JSON.parse(packageJSON.contents!.toString()), { name: 'sample' });
});

test('builtin scan emits relative resources and supports capability object forms', t => {
	const directory = fixture(t);
	for (const [name, manifest] of [
		['web', { name: 'web', browser: './dist/browser.js' }],
		['desktop', { name: 'desktop', main: './dist/extension.js' }],
		['limited', { name: 'limited', browser: './dist/browser.js', capabilities: { virtualWorkspaces: { supported: 'limited' } } }],
	] as const) {
		fs.mkdirSync(path.join(directory, name));
		fs.writeFileSync(path.join(directory, name, 'package.json'), JSON.stringify(manifest));
	}
	fs.writeFileSync(path.join(directory, 'web/package.nls.json'), '{"displayName":"Web"}');
	fs.writeFileSync(path.join(directory, 'web/README.md'), 'README');
	fs.writeFileSync(path.join(directory, 'web/CHANGELOG.md'), 'Changes');
	const scanned = scanBuiltinExtensions(directory);
	assert.equal(scanned.length, 1);
	assert.equal(scanned[0].extensionPath, 'web');
	assert.equal(scanned[0].readmePath, 'web/README.md');
	assert.equal(scanned[0].changelogPath, 'web/CHANGELOG.md');
	assert.deepEqual(scanned[0].packageNLS, { displayName: 'Web' });
	assert.equal(isWebExtension({ browser: './browser.js', capabilities: { virtualWorkspaces: { supported: true } } }), true);
	assert.equal(isWebExtension({ browser: './browser.js', capabilities: { untrustedWorkspaces: { supported: false } } }), false);
	assert.deepEqual(scanBuiltinExtensions(path.join(directory, 'missing')), []);
});

test('esbuild wrapper forwards watch and propagates configuration failure', async t => {
	const directory = fixture(t);
	const config = path.join(directory, 'config.mjs');
	const capture = path.join(directory, 'args.json');
	fs.writeFileSync(config, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv));`);
	await esbuildExtensions('fixture', true, [{ script: config }]);
	assert.ok(JSON.parse(fs.readFileSync(capture, 'utf8')).includes('--watch'));
	fs.writeFileSync(config, 'process.exit(19);');
	await assert.rejects(esbuildExtensions('fixture', false, [{ script: config }]), /exit code 19/);
});

test('noEmit gates refresh cached diagnostics after type roots change', async t => {
	const directory = fixture(t);
	const project = path.join(directory, 'tsconfig.json');
	const source = path.join(directory, 'index.ts');
	const config = { compilerOptions: { target: 'es2024', types: [] as string[], typeRoots: ['./types'] }, files: ['index.ts'] };
	fs.writeFileSync(project, JSON.stringify(config));
	fs.writeFileSync(source, 'export const value: string = fixtureGlobal;');
	const compiler = path.resolve(import.meta.dirname, '../../../node_modules/@typescript/native-preview/bin/tsgo.js');
	const seeded = spawnSync(process.execPath, [compiler, '--project', project, '--incremental', '--noEmit'], { encoding: 'utf8', timeout: 60000 });
	assert.equal(seeded.status, 2, seeded.stderr || seeded.error?.message);
	assert.match(seeded.stdout, /TS2304/);
	fs.mkdirSync(path.join(directory, 'types/custom'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'types/custom/index.d.ts'), 'declare const fixtureGlobal: string;');
	config.compilerOptions.types = ['custom'];
	fs.writeFileSync(project, JSON.stringify(config));
	await spawnTsgo(project, { taskName: 'fresh type roots', noEmit: true });
	assert.equal(fs.existsSync(path.join(directory, 'index.js')), false);
});

test('tsgo errors reject without invoking completion and spaced project paths work', async t => {
	const directory = fixture(t);
	const project = path.join(directory, 'tsconfig.json');
	const source = path.join(directory, 'index.ts');
	fs.writeFileSync(project, JSON.stringify({ compilerOptions: { target: 'es2024', types: [], skipLibCheck: true }, files: ['index.ts'] }));
	fs.writeFileSync(source, 'export const value: string = 1;');
	let completed = false;
	await assert.rejects(spawnTsgo(project, { taskName: 'fixture', noEmit: true }, () => { completed = true; }), /TS2322/);
	assert.equal(completed, false);
	fs.writeFileSync(source, 'export const value: string = "ok";');
	await typeCheckExtension(project, true);
	assert.equal(fs.existsSync(path.join(directory, 'index.js')), false);
	await assert.rejects(spawnTsgo(project, { taskName: 'fixture', noEmit: true }, () => { throw new Error('completion failed'); }), /completion failed/);
});
