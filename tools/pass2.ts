/** Pass 2: Rename employeeId→agentId, SKIPPING PropertySignatures */
import { Project, SyntaxKind, Node } from 'ts-morph';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/vs/sessions');
const proj = new Project({ tsConfigFilePath: path.resolve(__dirname, '../src/tsconfig.json'), skipAddingFilesFromTsConfig: true });
proj.addSourceFilesAtPaths([`${SRC}/**/*.ts`, `${SRC}/**/*.tsx`, `!${SRC}/**/test/**`, `!${SRC}/**/node_modules/**`, `!${SRC}/**/*.d.ts`]);

let total = 0;
for (const sf of proj.getSourceFiles()) {
  if (!sf.getFullText().includes('employeeId')) continue;
  
  let fileCount = 0;
  sf.forEachDescendant((node) => {
    if (!Node.isIdentifier(node) || node.getText() !== 'employeeId') return;
    
    // Skip PropertySignatures — types already have agentId from Pass 1
    if (Node.isPropertySignature(node.getParent())) return;
    
    node.replaceWithText('agentId');
    fileCount++;
  });
  
  if (fileCount > 0) {
    console.log(`  ${sf.getBaseName()}: ${fileCount}`);
    total += fileCount;
  }
}

console.log(`Pass 2: ${total} renames`);
proj.saveSync();
