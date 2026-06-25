const fs = require('fs');
const path = require('path');

function walk(dir, exts, excludeDirs) {
  let files = [];
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) {
      if (!excludeDirs.includes(f)) files.push(...walk(p, exts, excludeDirs));
    } else if (exts.some(ext => f.endsWith(ext))) {
      files.push(p);
    }
  });
  return files;
}

function countLines(files) {
  let total = 0;
  files.forEach(f => {
    try {
      total += fs.readFileSync(f, 'utf8').split('\n').length;
    } catch(e) {}
  });
  return total;
}

const exclude = ['node_modules', 'out', 'dist', '.git'];
const tsFiles = walk('src', ['.ts', '.tsx'], exclude);
const tsLines = countLines(tsFiles);

console.log('src .ts/.tsx count:', tsFiles.length);
console.log('src .ts/.tsx lines (excl .d.ts):', tsLines);

// Count extensions src files
const extDirs = fs.readdirSync('extensions').filter(d => {
  const p = path.join('extensions', d);
  return fs.statSync(p).isDirectory();
});

let extFileCount = 0, extLineCount = 0;
extDirs.forEach(ext => {
  const extSrc = path.join('extensions', ext, 'src');
  if (fs.existsSync(extSrc)) {
    const files = walk(extSrc, ['.ts', '.tsx'], ['node_modules', 'out', 'dist']);
    const lines = countLines(files.filter(f => !f.endsWith('.d.ts')));
    extFileCount += files.filter(f => !f.endsWith('.d.ts')).length;
    extLineCount += lines;
    console.log(`  extensions/${ext}/src:`, files.filter(f => !f.endsWith('.d.ts')).length, 'files,', lines, 'lines');
  }
});

console.log('extensions total (src only, excl .d.ts):', extFileCount, 'files,', extLineCount, 'lines');
console.log('GRAND TOTAL (src + extensions/src):', tsFiles.length + extFileCount, 'files,', tsLines + extLineCount, 'lines');
