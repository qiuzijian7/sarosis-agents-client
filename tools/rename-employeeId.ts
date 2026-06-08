/**
 * ts-morph script: employeeId → agentId — Phase 1 + Phase 3 fix
 * Fixes: 1) collect-apply pattern for Phase 1  2) two-pass for Phase 3
 */
import { Project, SyntaxKind, Node } from 'ts-morph';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '../src/vs/sessions');

const project = new Project({
  tsConfigFilePath: path.resolve(__dirname, '../src/tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
});

console.log('Loading files...');
project.addSourceFilesAtPaths([
  `${SRC_DIR}/**/*.ts`,
  `${SRC_DIR}/**/*.tsx`,
  `!${SRC_DIR}/**/test/**`,
  `!${SRC_DIR}/**/node_modules/**`,
  `!${SRC_DIR}/**/*.d.ts`,
]);

const filesWithEmployeeId = project.getSourceFiles().filter(f =>
  f.getFullText().includes('employeeId')
);
console.log(`Found ${filesWithEmployeeId.length} files\n`);

// ========== PHASE 1: Add agentId? to type declarations ==========
console.log('=== Phase 1: Type declarations ===');
let typeAddCount = 0;

for (const sf of filesWithEmployeeId) {
  const text = sf.getFullText();
  const lines = text.split('\n');
  
  // Collect positions to insert (avoid AST invalidation)
  const inserts: { pos: number; indent: string }[] = [];
  
  let inBlock = false;
  let blockBraceDepth = 0;
  let blocks: { start: number; end: number; isTypeBlock: boolean }[] = [];
  
  // Find all interface/type blocks using line-by-line analysis
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    
    // Detect start of interface/type alias
    if (/^(export\s+)?interface\s+\w+/.test(l)) {
      blocks.push({ start: i, end: -1, isTypeBlock: true });
    }
    if (/^(export\s+)?type\s+\w+\s*=\s*\{/.test(l) || /^(export\s+)?type\s+\w+\s*=/.test(l)) {
      blocks.push({ start: i, end: -1, isTypeBlock: true });
    }
    
    // Track brace depth within blocks
    if (blocks.length > 0) {
      for (const b of blocks) {
        if (b.end >= 0) continue;
        const open = (lines[i].match(/{/g) || []).length;
        const close = (lines[i].match(/}/g) || []).length;
        b.start === i ? b.end === -1 : null; // track depth from start
      }
    }
  }
  
  // Simpler approach: just use position-based insertion for all employeeId lines
  // that look like type declarations
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Match lines like: employeeId: string;  or readonly employeeId?: string;
    if (!/^\s*(readonly\s+)?employeeId\??\s*:\s*string\s*[;,].*$/.test(line)) continue;
    
    // Quick check: is this inside a class/function body? Skip if the line is too indented
    // Type declarations are typically tab-indented once, implementations are more indented
    const indent = line.match(/^(\s*)/)?.[1] || '';
    if (indent.length > 8) continue; // Too deeply nested - likely implementation, not type
    
    // Avoid adding to lines that already have agentId nearby
    const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
    if (nextLine.includes('agentId')) continue;
    
    // Calculate the exact position to insert after
    const semicolonIdx = line.indexOf(';');
    if (semicolonIdx === -1) continue;
    
    // Find position of this line in original text
    let pos = 0;
    for (let j = 0; j < i; j++) pos += lines[j].length + 1;
    pos += semicolonIdx + 1; // after the semicolon
    
    inserts.push({ pos, indent: indent + '\t' });
  }
  
  // Apply bottom-up
  inserts.sort((a, b) => b.pos - a.pos);
  for (const ins of inserts) {
    sf.insertText(ins.pos, `\n${ins.indent}/** v2 unified agent ID */\n${ins.indent}agentId?: string;`);
    typeAddCount++;
  }
  
  if (inserts.length > 0)
    console.log(`  ${sf.getBaseName()}: +${inserts.length}`);
}

console.log(`Phase 1 done: ${typeAddCount} agentId? added\n`);

// ========== PHASE 3: Object literal fields ==========
console.log('=== Phase 3: Object literal bodies ===');
let objFieldCount = 0;

for (const sf of filesWithEmployeeId) {
  // Collect ALL nodes to modify first
  const shorthandReplacements: { node: any; replacement: string }[] = [];
  const propertyReplacements: { node: any; replacement: string }[] = [];
  
  sf.forEachDescendant((node) => {
    // Shorthand: { employeeId }
    if (Node.isShorthandPropertyAssignment(node)) {
      if (node.getName() === 'employeeId') {
        const parent = node.getParent();
        if (parent && Node.isObjectLiteralExpression(parent)) {
          const existingAgentId = parent.getProperty('agentId');
          if (!existingAgentId) {
            shorthandReplacements.push({ node, replacement: 'employeeId, agentId: employeeId' });
          }
        }
      }
    }
    
    // Named: { employeeId: value }
    if (Node.isPropertyAssignment(node)) {
      if (node.getName() === 'employeeId') {
        const parent = node.getParent();
        if (parent && Node.isObjectLiteralExpression(parent)) {
          const existingAgentId = parent.getProperty('agentId');
          if (!existingAgentId) {
            const valNode = node.getInitializer();
            if (valNode) {
              const valText = valNode.getText();
              propertyReplacements.push({ node, replacement: `employeeId: ${valText}, agentId: ${valText}` });
            }
          } else {
            // agentId already exists separately - just skip
          }
        }
      }
    }
  });
  
  // Apply collected changes
  for (const { node, replacement } of shorthandReplacements) {
    node.replaceWithText(replacement);
    objFieldCount++;
  }
  for (const { node, replacement } of propertyReplacements) {
    node.replaceWithText(replacement);
    objFieldCount++;
  }
  
  if (shorthandReplacements.length + propertyReplacements.length > 0)
    console.log(`  ${sf.getBaseName()}: ${shorthandReplacements.length}s + ${propertyReplacements.length}p`);
}

console.log(`Phase 3 done: ${objFieldCount} fields cloned\n`);

// ========== SAVE ==========
console.log('Saving...');
project.saveSync();
console.log(`Done! Phase1=${typeAddCount}, Phase3=${objFieldCount}`);
