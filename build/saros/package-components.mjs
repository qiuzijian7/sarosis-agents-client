// @ts-check
/**
 * 生成可选组件包 + 清单：
 *   media  = ffmpeg.exe / ffprobe.exe / yt-dlp.exe
 *   office = .build/office-runtime 的 primary-runtime + office-skills
 *   whisper= ggml-base.bin
 *
 * 产物默认写到 build/saros/update-server/downloads/components/，由
 * update-server 的 /api/components 和 /downloads/components/** 对外提供。
 *
 * 用法：
 *   node build/saros/package-components.mjs
 *   node build/saros/package-components.mjs --version 2.2.26245
 *   node build/saros/package-components.mjs --out D:/vssaros-components
 *   node build/saros/package-components.mjs --only media,whisper
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import yazl from 'yazl';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const product = JSON.parse(fs.readFileSync(path.join(ROOT, 'product.json'), 'utf8'));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const version = arg('version', product.version || 'dev');
const platform = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
const outDir = path.resolve(arg('out', path.join(ROOT, 'build/saros/update-server/downloads/components')));
const only = new Set(String(arg('only', 'media,office,whisper')).split(',').map(x => x.trim()).filter(Boolean));
const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, '_');

function sha256(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const input = fs.createReadStream(file);
		input.on('data', chunk => hash.update(chunk));
		input.once('error', reject);
		input.once('end', () => resolve(hash.digest('hex')));
	});
}

function walk(root, dir = '') {
	const out = [];
	for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) { out.push(...walk(root, rel)); }
		else if (entry.isFile()) { out.push(rel); }
	}
	return out.sort();
}

async function makeZip(sourceFiles, target) {
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	const temp = `${target}.part-${process.pid}`;
	await fs.promises.rm(temp, { force: true });
	const zip = new yazl.ZipFile();
	for (const [from, rel] of sourceFiles) {
		zip.addFile(from, rel);
	}
	await new Promise((resolve, reject) => {
		const output = fs.createWriteStream(temp);
		zip.outputStream.once('error', reject);
		output.once('error', reject);
		output.once('close', resolve);
		zip.outputStream.pipe(output);
		zip.end();
	});
	await fs.promises.rm(target, { force: true });
	await fs.promises.rename(temp, target);
}

function componentFromFile(id, file, format) {
	return {
		id,
		version,
		url: `/downloads/components/${path.basename(file)}`,
		format,
	};
}

async function main() {
	await fs.promises.mkdir(outDir, { recursive: true });
	const components = {};

	if (only.has('media')) {
		const bin = path.join(ROOT, 'build/saros/bin');
		const names = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe'];
		const files = names.map(name => [path.join(bin, name), name]);
		const missing = files.filter(([file]) => !fs.existsSync(file));
		if (missing.length) {
			console.warn(`[components] media skipped; missing: ${missing.map(([file]) => path.basename(file)).join(', ')}`);
		} else {
			const target = path.join(outDir, `media-${safeVersion}-${platform}.zip`);
			await makeZip(files, target);
			components.media = componentFromFile('media', target, 'zip');
		}
	}

	if (only.has('office')) {
		const office = path.join(ROOT, '.build/office-runtime');
		if (!fs.existsSync(path.join(office, 'primary-runtime/runtime.json')) || !fs.existsSync(path.join(office, 'office-skills'))) {
			console.warn('[components] office skipped; .build/office-runtime/primary-runtime/runtime.json or office-skills is missing');
		} else {
			const target = path.join(outDir, `office-${safeVersion}-${platform}.zip`);
			await makeZip(walk(office).map(rel => [path.join(office, rel), rel]), target);
			components.office = componentFromFile('office', target, 'zip');
		}
	}

	if (only.has('whisper')) {
		const model = path.join(ROOT, 'build/saros/models/ggml-base.bin');
		if (!fs.existsSync(model)) {
			console.warn('[components] whisper skipped; build/saros/models/ggml-base.bin is missing');
		} else {
			const target = path.join(outDir, 'whisper-base.bin');
			await fs.promises.copyFile(model, target);
			components.whisper = componentFromFile('whisper', target, 'file');
		}
	}

	const manifest = {
		schemaVersion: 1,
		platform,
		generatedAt: new Date().toISOString(),
		components: {},
	};
	for (const [id, component] of Object.entries(components)) {
		const file = path.join(outDir, path.basename(component.url));
		const size = (await fs.promises.stat(file)).size;
		const digest = await sha256(file);
		manifest.components[id] = { ...component, size, sha256: digest };
	}
	const manifestFile = path.join(outDir, 'manifest.json');
	await fs.promises.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

	console.log(`[components] version=${version} platform=${platform}`);
	for (const [id, c] of Object.entries(manifest.components)) {
		console.log(`[components] ${id.padEnd(7)} ${String((c.size / 1024 / 1024).toFixed(1)).padStart(7)} MiB  ${c.sha256.slice(0, 12)}…  ${path.basename(c.url)}`);
	}
	console.log(`[components] manifest: ${manifestFile}`);
}

main().catch(error => {
	console.error(`[components] ${error?.stack || error}`);
	process.exitCode = 1;
});
