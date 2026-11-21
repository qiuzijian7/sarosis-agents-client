/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MEDIA_COMPONENT } from '../../electron-main/dshComponentCatalog.js';
import { DshComponentLocator } from '../../electron-main/dshComponentLocator.js';
import { DshComponentProviderRegistry } from '../../electron-main/dshComponentProviders.js';

suite('dshComponentLocator / providers', () => {
	test('finds all three media binaries through configurable roots and probes versions', async () => {
		const root = mkdtempSync(join(tmpdir(), 'vssaros-media-locator-'));
		try {
			for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
				writeFileSync(join(root, name), name);
			}
			const locator = new DshComponentLocator({
				userDataPath: root,
				platform: 'win32',
				env: { PATH: '' },
				home: root,
				execFile: async (file) => ({
					code: 0,
					stdout: file.endsWith('yt-dlp.exe') ? '2026.11.21' : 'ffmpeg version 7.1.1',
					stderr: '',
				}),
			});
			const located = await locator.find(MEDIA_COMPONENT, [{ path: root, source: 'user' }]);
			assert.ok(located);
			assert.equal(located.source, 'user');
			assert.equal(located.version, '7.1.1');
			assert.deepEqual(Object.keys(located.binaries).sort(), ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('does not treat an existing file with a failing probe as installed', async () => {
		const root = mkdtempSync(join(tmpdir(), 'vssaros-media-bad-'));
		try {
			for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
				writeFileSync(join(root, name), name);
			}
			const locator = new DshComponentLocator({
				userDataPath: root,
				platform: 'win32',
				env: { PATH: '' },
				home: root,
				execFile: async () => ({ code: 1, stdout: '', stderr: 'broken' }),
			});
			assert.equal(await locator.find(MEDIA_COMPONENT, [{ path: root, source: 'user' }]), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('darwin uses Homebrew formulas and linux packages require explicit elevation', async () => {
		const brewCalls: string[][] = [];
		const brew = new DshComponentProviderRegistry({
			platform: 'darwin',
			env: { PATH: '' },
			run: async (file, args) => { brewCalls.push([file, ...args]); return { code: 0, stdout: 'ok', stderr: '' }; },
		}).find('brew');
		assert.ok(brew);
		const brewSpec = MEDIA_COMPONENT.providers.darwin.find(item => item.type === 'brew');
		assert.ok(brewSpec);
		await brew.install(MEDIA_COMPONENT, brewSpec, new AbortController().signal);
		assert.ok(brewCalls.some(call => call.includes('ffmpeg')));
		assert.ok(brewCalls.some(call => call.includes('yt-dlp')));

		const linux = new DshComponentProviderRegistry({ platform: 'linux', env: { PATH: '' }, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
		const apt = linux.find('apt');
		assert.ok(apt);
		assert.equal(apt.requiresElevation(), true);
	});

	test('provider install uses official winget package ids without hardcoded versions', async () => {
		const calls: string[][] = [];
		const registry = new DshComponentProviderRegistry({
			platform: 'win32',
			env: {},
			run: async (file, args) => {
				calls.push([file, ...args]);
				return { code: 0, stdout: 'ok', stderr: '' };
			},
		});
		const provider = registry.find('winget');
		assert.ok(provider);
		const spec = MEDIA_COMPONENT.providers.win32.find(item => item.type === 'winget');
		assert.ok(spec);
		await provider.install(MEDIA_COMPONENT, spec, new AbortController().signal);
		assert.ok(calls.some(call => call.includes('Gyan.FFmpeg')));
		assert.ok(calls.some(call => call.includes('yt-dlp.yt-dlp')));
		assert.ok(calls.every(call => !call.some(value => /^\d+\.\d+\.\d+$/.test(value))));
	});
});
