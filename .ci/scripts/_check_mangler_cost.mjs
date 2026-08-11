import ts from 'typescript';
import path from 'node:path';

const projectPath = path.resolve('src/tsconfig.json');
const parsed = ts.readConfigFile(projectPath, ts.sys.readFile);
const existingOptions = {};
const cmdLine = ts.parseJsonConfigFileContent(parsed.config, ts.sys, path.dirname(projectPath), existingOptions);
const parsedNoExclude = ts.parseJsonConfigFileContent({ ...parsed.config, exclude: [] }, ts.sys, path.dirname(projectPath), existingOptions);
const excludedSet = new Set(cmdLine.fileNames.map(f => path.resolve(f).replace(/\\/g, '/')));
const extraFiles = [];
for (const f of parsedNoExclude.fileNames) {
	const normalized = path.resolve(f).replace(/\\/g, '/');
	if (!excludedSet.has(normalized)) extraFiles.push(normalized);
}
console.log('extra files:', extraFiles.length);

// Classify: which are test/webview (not actually compiled by srcPipe)?
const isTest = extraFiles.filter(f => /\/test\//.test(f) || /\.test\.ts$/.test(f) || /\.fixture\.ts$/.test(f));
const isWebview = extraFiles.filter(f => f.includes('sessions/contrib/agentStudio/webview'));
const isOther = extraFiles.filter(f => !/\/test\//.test(f) && !/\.test\.ts$/.test(f) && !/\.fixture\.ts$/.test(f) && !f.includes('sessions/contrib/agentStudio/webview'));
console.log('test files:', isTest.length);
console.log('webview files:', isWebview.length);
console.log('other (real entry points):', isOther.length);

// The real entry points that matter
console.log('\n=== real entry points (non-test/webview) ===');
isOther.forEach(f => console.log('  ', path.relative(process.cwd(), f).replace(/\\/g, '/')));

// Log4 vs log2 mangler stats
console.log('\n=== 对比 ===');
console.log('log2(修复前): classes=11079, symbols=14976, edits=6182 files, prepare ~36min');
console.log('log4(修复后): classes=11482, symbols=15336, edits=6546 files, prepare ~40.5min');
