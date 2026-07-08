// Offline TAPD extraction test
// -----------------------------------------------------------------------------
// Runs the EXACT same extraction algorithm that ships in production
// (`TAPD_EXTRACT_BODY` inside tapdImportService.ts) against a saved page HTML,
// so we can tune/verify the CSS selectors without repeatedly driving the live
// browser.
//
// How it works:
//   1. Reads tapdImportService.ts and extracts the `TAPD_EXTRACT_BODY` string
//      (the pure browser-side DOM logic), unescaping it the same way the TS
//      compiler would (\\. -> \.).
//   2. Loads a TAPD page HTML with jsdom.
//   3. Calls the body with (document, sourceMode) and prints the result.
//
// Usage:
//   node test/tapd/tapdExtract.test.mjs                 # auto-find latest dump
//   node test/tapd/tapdExtract.test.mjs <path.html>     # explicit HTML file
//   node test/tapd/tapdExtract.test.mjs <path.html> dialog|detail
//
// Dumps are produced by the app: trigger a TAPD import in the browser and the
// service writes <tmpDir>/saros-tapd-dump.html. Rebuild (transpile-client)
// first so the dump + latest selectors are active.
//
// Requires: npm install --no-save --ignore-scripts jsdom
// -----------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..'); // test/tapd -> repo root
const tsPath = join(repoRoot, 'src/vs/sessions/contrib/agentStudio/browser/tapdImportService.ts');

// ── 1. Extract TAPD_EXTRACT_BODY from the TS source ────────────────────────
const src = readFileSync(tsPath, 'utf8');
const m = src.match(/const TAPD_EXTRACT_BODY = `([\s\S]*?)`;/);
if (!m) {
	console.error(`[tapdExtract.test] Could not find TAPD_EXTRACT_BODY in ${tsPath}`);
	process.exit(2);
}
// Re-evaluate as a template literal so escape sequences (\\. -> \.) match the
// runtime string the browser actually receives.
const body = eval('`' + m[1] + '`');

// Build a callable that supplies `document` + `sourceMode` as params.
const extract = new Function('document', 'sourceMode',
	'return (async () => {\n' + body + '\n})();');

// ── 2. Locate the HTML dump ────────────────────────────────────────────────
function findDump(argv) {
	if (argv[2] && existsSync(argv[2])) return argv[2];
	const files = readdirSync(tmpdir())
		.filter(f => f.startsWith('saros-tapd-dump') && f.endsWith('.html'))
		.map(f => join(tmpdir(), f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return files[0] || null;
}

const mode = process.argv[3] || 'dialog';
let html;
let htmlLabel;

const dump = findDump(process.argv);
if (dump) {
	html = readFileSync(dump, 'utf8');
	htmlLabel = dump;
} else {
	// Self-test fixture: proves the harness (jsdom + body integration) works
	// even before a real dump exists. A dialog-style detail container.
	console.error('[tapdExtract.test] No dump found — running built-in fixture (dialog mode).');
	htmlLabel = '<built-in fixture>';
	html = `<!doctype html><html><body>
		<div class="list-page"><div class="title">需求-VsSaros-LIST-NOISE</div></div>
		<div class="detail-container">
			<div class="detail-container-header">
				<div class="title-wrap">
					<div class="tapd-inline-label-selectable" title="【VsSaros】真实需求-标签">
						<p class="label-selectable__tag"> 【VsSaros】真实需求-标签 </p>
					</div>
				</div>
			</div>
			<div class="content-wrap"><div class="cherry-editor-content">这是描述 <b>加粗</b> <img src="https://file.tapd.cn/x.png"></div></div>
			<div class="entity-detail-right">
				<div field-name="status"><button value="进行中" title="进行中"><span>进行中</span></button></div>
				<div field="priority" title="High"><span class="colorful-labels__item-text">High</span></div>
				<span field-name="owner" title="张三;">张三;</span>
			</div>
			<div class="entity-detail-attachment">
				<div class="attachment-content-detail">
					<div class="draggable-item">
						<div class="attachment-content-detail__item">
							<div class="title"><a class="link-title" file-name="a.zip" href="https://www.tapd.cn/30076258/attachments/download/1/story?"> a.zip </a></div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</body></html>`;
}

// ── 3. Run extraction ───────────────────────────────────────────────────────
const dom = new JSDOM(html);
const document = dom.window.document;
const result = await extract(document, mode);

console.log('=== TAPD extraction test ===');
console.log('mode     :', mode);
console.log('html     :', htmlLabel);
console.log('result   :');
console.log(JSON.stringify(result, null, 2));

// ── 4. Lightweight assertions / verdict ─────────────────────────────────────
const problems = [];
if (!result.title) problems.push('title is empty');
if (result.title === '附件' || ['附件', '评论', '标签', '基础信息', '工作流'].includes(result.title)) {
	problems.push('title matched a section header instead of the workitem title');
}
if (mode === 'dialog') {
	if (!result._debug || result._debug['__rootFound'] === 'none(fellback-to-document)') {
		problems.push('dialog mode did NOT locate the detail container (fell back to document)');
	}
	if (result.title && result.title.includes('LIST-NOISE')) {
		problems.push('title came from the list page, not the dialog');
	}
}
if (!result.priority) problems.push('priority is empty');
if (!result.owner) problems.push('owner is empty');
if (!result.status) problems.push('status is empty');
if (!result.attachments || result.attachments.length === 0) problems.push('no attachments extracted');
console.log('\nverdict  :', problems.length ? 'FAIL → ' + problems.join('; ') : 'OK');
process.exit(problems.length ? 1 : 0);
