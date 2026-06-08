/**
 * 完全清理 employeeId → agentId — 三步脚本
 * Pass 1: 所有类型定义添加 agentId? 字段
 * Pass 2: 全部代码重命名 employeeId → agentId  
 * Pass 3: 移除冗余 employeeId? 字段 (标记 deprecated)
 */
import { Project, SyntaxKind, Node } from 'ts-morph';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/vs/sessions');

const proj = new Project({
  tsConfigFilePath: path.resolve(__dirname, '../src/tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
});

console.log('Loading all files...');
proj.addSourceFilesAtPaths([
  `${SRC}/**/*.ts`,
  `${SRC}/**/*.tsx`,
  `!${SRC}/**/test/**`,
  `!${SRC}/**/node_modules/**`,
  `!${SRC}/**/*.d.ts`,
]);

const allFiles = proj.getSourceFiles();

// ====================================================================
// PASS 1: Add agentId to every type declaration containing employeeId
// ====================================================================
console.log('\n=== PASS 1: Add agentId to types ===');
let pass1Count = 0;

for (const sf of allFiles) {
  // Use text-based approach to find employeeId field declarations in types
  const text = sf.getFullText();
  const lines = text.split('\n');
  const inserts: { pos: number; indent: string }[] = [];

  // Detect if we're inside an interface/type block
  let inInterface = false, inTypeAlias = false;
  let braceDepth = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const lt = lines[i].trim();
    
    // Track interface/type block start
    if (/^(export\s+)?interface\s+\w+/.test(lt)) { inInterface = true; braceDepth = 0; continue; }
    if (/^(export\s+)?type\s+\w+\s*=/.test(lt)) { inTypeAlias = true; braceDepth = 0; continue; }
    
    // Track braces
    braceDepth += (lines[i].match(/{/g) || []).length;
    braceDepth -= (lines[i].match(/}/g) || []).length;
    if (braceDepth <= 0 && (inInterface || inTypeAlias)) {
      inInterface = false; inTypeAlias = false; continue;
    }
    
    if (!inInterface && !inTypeAlias) continue;
    
    // Match: employeeId?: string;  or  readonly employeeId: string;
    if (/^\s*(readonly\s+)?employeeId\??\s*:\s*string\s*[;,].*$/.test(lines[i])) {
      // Check if agentId already exists nearby
      const nextFew = lines.slice(i + 1, i + 5).join('\n');
      if (nextFew.includes('agentId')) continue;
      
      // Also check if THIS line says "employeeId" but is inside a function/method body
      // Skip if deeply nested (more than 2 tabs/8 spaces)
      const indent = (lines[i].match(/^(\s*)/)?.[1] || '');
      if (indent.length > 12) continue;
      
      // Calculate position
      const semiIdx = lines[i].indexOf(';');
      if (semiIdx === -1) continue;
      let pos = 0;
      for (let j = 0; j < i; j++) pos += lines[j].length + 1;
      pos += semiIdx + 1;
      
      inserts.push({ pos, indent: indent + '\t' });
    }
  }
  
  // Apply bottom-up
  inserts.sort((a, b) => b.pos - a.pos);
  for (const ins of inserts) {
    sf.insertText(ins.pos, `\n${ins.indent}/** @deprecated — use agentId */\n${ins.indent}agentId?: string;`);
    pass1Count++;
  }
  
  if (inserts.length > 0) console.log(`  ${sf.getBaseName()}: +${inserts.length} agentId?`);
}

console.log(`Pass 1 done: ${pass1Count} agentId fields added`);

// Also add agentId to inline object literal types in function params
// Pattern: { employeeId: string; ... } used as parameter/emitter type
for (const sf of allFiles) {
  const text = sf.getFullText();
  // Find all { employeeId: string; ... } patterns and add agentId?
  const re = /employeeId\??\s*:\s*string\s*;/g;
  let count = 0;
  let match;
  const positions: number[] = [];
  
  while ((match = re.exec(text)) !== null) {
    const pos = match.index + match[0].length;
    const context = text.substring(Math.max(0, pos - 200), Math.min(text.length, pos + 20));
    // Only add if in a type context (inside { ... } before => or : or >)
    if (/\{[^}]*$/.test(text.substring(Math.max(0, pos - 300), pos)) && 
        /[^}]*\}/.test(text.substring(pos, pos + 300))) {
      if (!text.substring(pos, pos + 50).includes('agentId')) {
        positions.push(pos);
      }
    }
  }
  
  if (positions.length > 0) console.log(`  ${sf.getBaseName()}: ${positions.length} inline types (to add agentId)`);
}

console.log('Pass 1 complete. Saving...');
proj.saveSync();

// ====================================================================
// PASS 2: Rename ALL employeeId → agentId
// ====================================================================
console.log('\n=== PASS 2: Rename ALL employeeId → agentId ===');

// Reload project to get fresh AST after Pass 1 modifications
proj.removeSourceFile(proj.getSourceFiles().map(f => f));
proj.addSourceFilesAtPaths([
  `${SRC}/**/*.ts`,
  `${SRC}/**/*.tsx`,
  `!${SRC}/**/test/**`,
  `!${SRC}/**/node_modules/**`,
  `!${SRC}/**/*.d.ts`,
]);

let pass2Count = 0;
const pass2Files = proj.getSourceFiles().filter(f => f.getFullText().includes('employeeId'));

for (const sf of pass2Files) {
  let fileCount = 0;
  
  // Process all identifiers
  sf.forEachDescendant((node) => {
    if (!Node.isIdentifier(node) || node.getText() !== 'employeeId') return;
    
    node.replaceWithText('agentId');
    fileCount++;
  });
  
  if (fileCount > 0) {
    console.log(`  ${sf.getBaseName()}: ${fileCount} renames`);
    pass2Count += fileCount;
  }
}

console.log(`Pass 2 done: ${pass2Count} total renames`);
proj.saveSync();
console.log('All done!');
