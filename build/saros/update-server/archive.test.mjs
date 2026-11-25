import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = [path.join(here, 'server.mjs'), path.resolve(here, '../../../deploy-package/update-server/server.mjs')];

for (const sourcePath of sources) {
  test('archive invariants: ' + path.relative(here, sourcePath), async () => {
    const root = fs.mkdtempSync(path.join(here, '.archive-test-'));
    const downloads = path.join(root, 'downloads');
    const archive = path.join(downloads, 'custom-archive');
    fs.mkdirSync(downloads);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const begin = source.indexOf('// ---- 历史版本归档');
    const end = source.indexOf('// ---- manifest 内存缓存', begin);
    const block = source.slice(begin, end);
    const api = vm.runInNewContext(block + '\n({ archiveUpload, listArchiveEntries, readVersionsFile, writeVersionsFile })', {
      fs, path, crypto, console: { log() {}, error() {} },
      DOWNLOADS_DIR: downloads, MANIFEST_PATH: path.join(root, 'manifest.json'),
      MAX_DOWNLOAD_SIZE: 512 * 1024 * 1024, ASSET_NAME_BY_PLATFORM: {},
      PUBLIC_BASE_URL: 'http://localhost:3030',
      process: { env: { ARCHIVE_DIR: archive } }
    });
    try {
      assert.equal(api.listArchiveEntries('http://localhost:3030').length, 0);
      const fileName = 'VsSarosSetup.exe';
      const base = { platform: 'win32-x64', commit: 'a'.repeat(40), productVersion: '2.2.1', fileName, baseUrl: 'http://localhost:3030' };
      async function put(text) {
        fs.writeFileSync(path.join(downloads, fileName), text);
        return api.archiveUpload({ ...base, sha256hash: crypto.createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) });
      }
      const first = await put('first payload');
      const second = await put('second payload');
      assert.notEqual(first.key, second.key);
      assert.equal(api.listArchiveEntries(base.baseUrl).length, 2);
      assert.equal(fs.readFileSync(path.join(archive, first.key, fileName), 'utf8'), 'first payload');
      assert.equal(fs.readFileSync(path.join(archive, second.key, fileName), 'utf8'), 'second payload');
      await put('first payload');
      assert.equal(api.listArchiveEntries(base.baseUrl).length, 2);
      assert.ok(api.listArchiveEntries(base.baseUrl).every(e => e.url.startsWith(base.baseUrl + '/downloads/custom-archive/')));
      await assert.rejects(api.archiveUpload({ ...base, sha256hash: '0'.repeat(64), size: 13 }), /content changed/);
      assert.equal(api.listArchiveEntries(base.baseUrl).length, 2);
      const normalDir = path.join(archive, 'v2.2.0');
      fs.mkdirSync(normalDir);
      fs.writeFileSync(path.join(normalDir, fileName), 'manually imported');
      let listed = api.listArchiveEntries(base.baseUrl);
      const imported = listed.find(e => e.key === 'v2.2.0');
      assert.equal(imported.sha256hash, null);
      assert.equal(imported.timestamp, null);
      const entries = api.readVersionsFile();
      api.writeVersionsFile([...entries, { key: first.key, fileName: '../../manifest.json' }, { key: '.', fileName }]);
      assert.equal(api.listArchiveEntries(base.baseUrl).length, 3);
      fs.unlinkSync(path.join(archive, second.key, fileName));
      listed = api.listArchiveEntries(base.baseUrl);
      assert.equal(listed.length, 2);
      assert.ok(!listed.some(e => e.key === second.key));
      assert.ok(fs.readdirSync(archive).every(dir => !fs.readdirSync(path.join(archive, dir)).some(name => name.startsWith('.partial-'))));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}
