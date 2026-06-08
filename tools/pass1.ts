/** Pass 1: Add agentId? — collect positions first, then modify */
import { Project, SyntaxKind, Node } from 'ts-morph';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/vs/sessions');

const proj = new Project({ tsConfigFilePath: path.resolve(__dirname, '../src/tsconfig.json'), skipAddingFilesFromTsConfig: true });
proj.addSourceFilesAtPaths([`${SRC}/**/*.ts`, `${SRC}/**/*.tsx`, `!${SRC}/**/test/**`, `!${SRC}/**/node_modules/**`, `!${SRC}/**/*.d.ts`]);

let count = 0;

for (const sf of proj.getSourceFiles()) {
  if (!sf.getFullText().includes('employeeId')) continue;

  // Collect: { pos, indent } — position after employeeId; and indentation
  const inserts: { pos: number; indent: string }[] = [];

  sf.forEachDescendant((node) => {
    if (!Node.isPropertySignature(node)) return;
    if (node.getName() !== 'employeeId') return;

    // Verify parent is interface/type literal
    const parent = node.getParent();
    if (!parent || (!Node.isInterfaceDeclaration(parent) && !Node.isTypeLiteral(parent))) return;

    // Check if agentId already exists nearby
    const nextToken = node.getNextSibling();
    if (nextToken && Node.isPropertySignature(nextToken) && nextToken.getName() === 'agentId') return;

    const indent = (node.getText().match(/^(\s*)/) || ['', ''])[1];
    const pos = node.getEnd();  // position right after the semicolon
    
    inserts.push({ pos, indent });
  });

  // Apply bottom-up
  inserts.sort((a, b) => b.pos - a.pos);
  for (const ins of inserts) {
    sf.insertText(ins.pos, `\n${ins.indent}agentId?: string;`);
    count++;
  }

  if (inserts.length > 0) console.log(`  ${sf.getBaseName()}: +${inserts.length}`);
}

console.log(`Pass 1 done: ${count} agentId fields added`);
proj.saveSync();
