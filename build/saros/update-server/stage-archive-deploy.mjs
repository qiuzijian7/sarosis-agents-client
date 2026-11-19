import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [deployedPath, sourcePath, stagePath] = process.argv.slice(2);
if (!deployedPath || !sourcePath || !stagePath) throw new Error('Usage: node stage-archive-deploy.mjs <deployed> <source> <stage>');
const deployed = fs.readFileSync(deployedPath, 'utf8');
const expected = '4a016b3d8c1cf4b1fb0b7505f4d59a428381cd6ba41e5c4b2fd7652c8ad0bec5';
if (crypto.createHash('sha256').update(deployed).digest('hex') !== expected) throw new Error('Deployed source changed; inspect before staging');
const source = fs.readFileSync(sourcePath, 'utf8');
const begin = source.indexOf('// ---- 历史版本归档');
const end = source.indexOf('// ---- manifest 内存缓存', begin);
if (begin < 0 || end < 0) throw new Error('Archive block missing');
const archiveBlock = source.slice(begin, end);
const routeStart = source.indexOf('\t// 官网静态页跨域读取');
const routeEnd = source.indexOf('\t// 健康检查', routeStart);
const hookStart = source.indexOf('\t\t// 保留一份带版本标识的历史副本');
const hookEnd = source.indexOf('\n\t\tconsole.log(`[upload] 完成', hookStart);
if (routeStart < 0 || routeEnd < 0 || hookStart < 0 || hookEnd < 0) throw new Error('Integration hooks missing');
let next = deployed;
function once(old, value) {
  if (next.split(old).length !== 2) throw new Error('Unexpected deployed marker: ' + old.slice(0, 80));
  next = next.replace(old, value);
}
once('// ---- manifest 内存缓存', archiveBlock + '// ---- manifest 内存缓存');
once("\t// 健康检查\n", source.slice(routeStart, routeEnd) + '\t// 健康检查\n');
once("writeStream.on('finish', () => {", "writeStream.on('finish', async () => {");
once('\t\tconsole.log(`[upload] 完成', source.slice(hookStart, hookEnd) + '\n\t\tconsole.log(`[upload] 完成');
once('sha256hash, size: received }));', 'sha256hash, size: received, archive: archiveUrl }));');
fs.mkdirSync(stagePath, { recursive: true });
const candidate = path.join(stagePath, 'server.next.mjs');
fs.writeFileSync(candidate, next, { flag: 'wx' });
execFileSync(process.execPath, ['--check', candidate], { stdio: 'inherit' });
const seed = `import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const MANIFEST_PATH = process.argv[2];
const DOWNLOADS_DIR = process.argv[3];
const MAX_DOWNLOAD_SIZE = 512 * 1024 * 1024;
const PUBLIC_BASE_URL = process.argv[4];
const ASSET_NAME_BY_PLATFORM = {};
${archiveBlock}
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
for (const [platform, m] of Object.entries(manifest)) {
  if (!m.productVersion || !m.url || !m.version) continue;
  const fileName = path.basename(new URL(m.url).pathname);
  if (!/\\.(exe|zip|apk)$/i.test(fileName)) continue;
  const file = path.join(DOWNLOADS_DIR, fileName);
  if (!fs.existsSync(file)) { console.log('SKIP missing ' + platform + ' ' + fileName); continue; }
  const size = fs.statSync(file).size;
  const sha256hash = await hashArchiveFile(file);
  if (!m.sha256hash || m.sha256hash.toLowerCase() !== sha256hash) throw new Error('Manifest checksum mismatch: ' + platform);
  const entry = await archiveUpload({ platform, commit: m.version, productVersion: m.productVersion, fileName, sha256hash, size, baseUrl: PUBLIC_BASE_URL });
  upsertArchiveEntry({ ...entry, timestamp: m.timestamp || null });
  console.log('SEEDED ' + platform + ' ' + m.productVersion + ' ' + size);
}
`;
fs.writeFileSync(path.join(stagePath, 'seed-archives.mjs'), seed, { flag: 'wx' });
execFileSync(process.execPath, ['--check', path.join(stagePath, 'seed-archives.mjs')], { stdio: 'inherit' });
console.log(JSON.stringify({ candidate, bytes: Buffer.byteLength(next), preservedExistingRoutes: true }));
