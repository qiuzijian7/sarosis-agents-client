/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import yazl from 'yazl';
import { DshComponentManager } from '../../electron-main/dshComponentManager.js';

function zipBytes(files: Record<string, string>): Promise<Buffer> {
	const zip = new yazl.ZipFile();
	for (const [name, content] of Object.entries(files)) {
		zip.addBuffer(Buffer.from(content), name);
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
		zip.outputStream.once('error', reject);
		zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
		zip.end();
	});
}

function sha256(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function response(data: Buffer) {
	return {
		ok: true,
		status: 200,
		text: async () => data.toString('utf8'),
		arrayBuffer: async () => Uint8Array.from(data).buffer,
		body: Readable.from(data),
	};
}

suite('dshComponentManager', () => {
	test('downloads a zip component, verifies SHA256 and publishes it atomically', async () => {
		const root = mkdtempSync(join(tmpdir(), 'vssaros-components-'));
		try {
			const archive = await zipBytes({ 'ffmpeg.exe': 'ffmpeg-test', 'ffprobe.exe': 'ffprobe-test', 'yt-dlp.exe': 'yt-dlp-test' });
			const manifest = Buffer.from(JSON.stringify({
				schemaVersion: 1,
				platform: `${process.platform}-${process.arch}`,
				components: {
					media: { version: 'test-1', url: '/downloads/components/media.zip', sha256: sha256(archive), size: archive.length, format: 'zip' },
				},
			}));
			const manager = new DshComponentManager({
				userDataPath: root,
				updateUrl: 'http://components.example',
				fetch: async (url: string) => response(url.endsWith('/api/components') ? manifest : archive),
				log: () => undefined,
				appPath: join(root, 'app'),
				resourcesPath: join(root, 'resources'),
				autoInstall: false,
				officialProviders: false,
				env: { PATH: '', LOCALAPPDATA: join(root, 'local-app-data') },
				home: root,
			});
			try {
				const initial = await manager.status();
				assert.equal(initial.find(item => item.id === 'media')?.state, 'missing');
				await manager.install('media');
				const deadline = Date.now() + 5_000;
				let media = (await manager.status()).find(item => item.id === 'media');
				while (media?.state === 'installing' && Date.now() < deadline) {
					await new Promise(resolve => setTimeout(resolve, 25));
					media = (await manager.status()).find(item => item.id === 'media');
				}
				assert.equal(media?.state, 'ready');
				assert.ok(media?.installedPath);
				const meta = JSON.parse(await import('fs/promises').then(fs => fs.readFile(join(media!.installedPath!, 'component.json'), 'utf8')));
				assert.equal(meta.version, 'test-1');
			} finally {
				manager.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('reports bundled office and official whisper without a component server', async () => {
		const root = mkdtempSync(join(tmpdir(), 'vssaros-components-offline-'));
		try {
			const appPath = join(root, 'app');
			mkdirSync(join(appPath, 'office-runtime', 'primary-runtime'), { recursive: true });
			mkdirSync(join(appPath, 'office-runtime', 'office-skills'), { recursive: true });
			writeFileSync(join(appPath, 'office-runtime', 'primary-runtime', 'runtime.json'), '{}');
			let fetched = false;
			const manager = new DshComponentManager({
				userDataPath: join(root, 'user-data'),
				fetch: async () => { fetched = true; return response(Buffer.from('{}')); },
				log: () => undefined,
				appPath,
				resourcesPath: join(root, 'resources'),
				autoInstall: false,
				officialProviders: false,
				env: { PATH: '', LOCALAPPDATA: join(root, 'local-app-data') },
				home: root,
			});
			try {
				const statuses = await manager.status();
				assert.equal(statuses.find(item => item.id === 'office')?.state, 'bundled');
				assert.equal(statuses.find(item => item.id === 'whisper')?.state, 'missing');
				assert.equal(statuses.find(item => item.id === 'whisper')?.source, 'huggingface');
				assert.equal(fetched, false, '无服务器时状态查询不应访问 /api/components');
			} finally {
				manager.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('uses official winget provider and discovers installed binaries from WinGet Links', async function () {
		if (process.platform !== 'win32') { this.skip(); }
		const root = mkdtempSync(join(tmpdir(), 'vssaros-components-official-'));
		const oldLocalAppData = process.env.LOCALAPPDATA;
		try {
			const localAppData = join(root, 'local-app-data');
			const links = join(localAppData, 'Microsoft', 'WinGet', 'Links');
			mkdirSync(links, { recursive: true });
			process.env.LOCALAPPDATA = localAppData;
			const manager = new DshComponentManager({
				userDataPath: join(root, 'user-data'),
				fetch: async () => response(Buffer.from('{}')),
				log: () => undefined,
				officialProviders: true,
				env: { PATH: '', LOCALAPPDATA: localAppData },
				home: root,
				commandRunner: async (file, args) => {
					if (args.includes('install')) {
						for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
							writeFileSync(join(links, name), name);
						}
					}
					return { code: 0, stdout: args.includes('install') ? 'installed' : (file.endsWith('yt-dlp.exe') ? '2026.11.21' : 'ffmpeg version 7.1.1'), stderr: '' };
				},
			});
			try {
				await manager.install('media');
				const deadline = Date.now() + 3000;
				let media = (await manager.status()).find(item => item.id === 'media');
				while (media?.state === 'installing' && Date.now() < deadline) {
					await new Promise(resolve => setTimeout(resolve, 25));
					media = (await manager.status()).find(item => item.id === 'media');
				}
				assert.equal(media?.state, 'ready');
				assert.equal(media?.source, 'winget');
				assert.equal(media?.version, '7.1.1');
			} finally {
				manager.dispose();
			}
		} finally {
			if (oldLocalAppData === undefined) { delete process.env.LOCALAPPDATA; } else { process.env.LOCALAPPDATA = oldLocalAppData; }
			rmSync(root, { recursive: true, force: true });
		}
	});
});
