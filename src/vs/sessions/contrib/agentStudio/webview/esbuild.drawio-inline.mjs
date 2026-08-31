/**
 * drawio 内联渲染 bundle 构建配置（独立 entry，避免影响现有 media/webview.js）
 * 产出：media/index-render-drawio-inline.js（IIFE + 压缩，宿主以 URI.file 注入隐藏 webview）
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outfile = path.join(__dirname, 'media', 'index-render-drawio-inline.js');

await build({
	entryPoints: [path.join(__dirname, 'src/features/mindmap/index-render-drawio.ts')],
	bundle: true,
	format: 'iife',
	minify: true,
	sourcemap: false,
	entryNames: 'index-render-drawio-inline',
	outdir: path.join(__dirname, 'media'),
	platform: 'browser',
	loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
	define: { 'process.env.NODE_ENV': '"production"' },
	logLevel: 'info',
});

// 双写到运行时路径：renderer（drawioInlineRenderer.ts）通过 fileService 读取
// out/vs/sessions/contrib/agentStudio/webview/media/index-render-drawio-inline.js。
// 不依赖 gulp 是否拷贝 webview/media 目录，确保构建即生效。
const outTarget = path.join(
	__dirname, '..', '..', '..', '..', '..', '..', '..', 'out',
	'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media',
	'index-render-drawio-inline.js',
);
if (existsSync(path.dirname(outTarget))) {
	copyFileSync(outfile, outTarget);
	console.log(`[drawio-inline] synced to ${outTarget}`);
} else {
	console.log('[drawio-inline] out/ target dir not present, skipped sync (will rely on gulp copy)');
}
