import { Project, SyntaxKind, Node } from 'ts-morph';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/vs/sessions');
const proj = new Project({ tsConfigFilePath: path.resolve(__dirname, '../src/tsconfig.json'), skipAddingFilesFromTsConfig: true });

proj.addSourceFilesAtPaths([
  `${SRC}/contrib/agentStudio/node/checkpointService.ts`,
  `${SRC}/contrib/agentStudio/node/checkpointStorage.ts`,
  `${SRC}/contrib/tdbam/browser/tdbamViewPane.ts`,
  `${SRC}/browser/parts/chatBarPart.ts`,
]);

const files = proj.getSourceFiles().filter(f => f.getFullText().includes('employeeId'));
console.log(`${files.length} files loaded`);

let dc = 0, rc = 0, sc = 0;
for (const sf of files) {
  // Step 1: shorthands
  sf.forEachDescendant((node) => {
    if (Node.isShorthandPropertyAssignment(node) && node.getName() === 'employeeId') {
      node.replaceWithText('employeeId: agentId'); sc++;
    }
  });

  // Step 2: rename
  const todo: any[] = [];
  sf.forEachDescendant((node) => {
    if (!Node.isIdentifier(node) || node.getText() !== 'employeeId') return;
    const p = node.getParent(); if (!p) return;
    if (Node.isPropertySignature(p) || Node.isPropertyDeclaration(p)) return;
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === node) return;
    if (Node.isPropertyAssignment(p) && p.getNameNode() === node) return;
    todo.push(node);
  });
  for (const node of todo.reverse()) {
    node.replaceWithText('agentId');
    const p = node.getParent();
    if (p && (Node.isParameterDeclaration(p) || Node.isVariableDeclaration(p) || Node.isBindingElement(p))) dc++; else rc++;
  }
  console.log(`  ${sf.getBaseName()}: ${sc > 0 ? sc+'s ' : ''}${dc + rc} renames`);
}

console.log(`Done: ${sc} shorthands, ${dc} decls, ${rc} refs`);
proj.saveSync();
