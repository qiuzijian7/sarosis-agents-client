const fs = require('fs');
const path = require('path');

function walkAndCount(dir, exts, excludeDirs) {
  let fileCount = 0;
  let lineCount = 0;
  
  function walk(currentDir) {
    let items;
    try {
      items = fs.readdirSync(currentDir);
    } catch(e) {
      return;
    }
    
    items.forEach(f => {
      const p = path.join(currentDir, f);
      let stat;
      try {
        stat = fs.statSync(p);
      } catch(e) {
        return;
      }
      
      if (stat.isDirectory()) {
        if (!excludeDirs.includes(f)) {
          walk(p);
        }
      } else if (exts.some(ext => f.endsWith(ext))) {
        fileCount++;
        try {
          const content = fs.readFileSync(p, 'utf8');
          lineCount += content.split('\n').length;
        } catch(e) {
          // ignore
        }
      }
    });
  }
  
  walk(dir);
  return [fileCount, lineCount];
}

const exclude = ['node_modules', 'out', 'dist', '.git'];

// 1. Count src/vs directory
const [vsFiles, vsLines] = walkAndCount('src/vs', ['.ts', '.tsx'], exclude);
console.log('=== src/vs ===');
console.log('Files:', vsFiles);
console.log('Lines:', vsLines);
console.log();

// 2. Count src (excluding src/vs)
const [srcFiles, srcLines] = walkAndCount('src', ['.ts', '.tsx'], exclude);
console.log('=== src (total) ===');
console.log('Files:', srcFiles);
console.log('Lines:', srcLines);
console.log();

// 3. Count key subdirectories in src/vs
const keyDirs = ['base', 'code', 'editor', 'platform', 'server', 'workbench'];
keyDirs.forEach(dir => {
  const dirPath = path.join('src/vs', dir);
  if (fs.existsSync(dirPath)) {
    const [files, lines] = walkAndCount(dirPath, ['.ts', '.tsx'], exclude);
    console.log(`=== src/vs/${dir} ===`);
    console.log('Files:', files);
    console.log('Lines:', lines);
    console.log();
  }
});

// 4. List all extensions
console.log('=== Extensions List ===');
const extDirs = fs.readdirSync('extensions').filter(d => {
  const p = path.join('extensions', d);
  try {
    return fs.statSync(p).isDirectory();
  } catch(e) {
    return false;
  }
});
console.log('Total extensions:', extDirs.length);
console.log('Extension names:', extDirs.join(', '));
