/** Clean: Steps 1+2 only, no regex fix */
import { Project, SyntaxKind, Node } from 'ts-morph';
import path from 'path';

const SRC_DIR = path.resolve('src/vs/sessions');
const proj = new Project({ tsConfigFilePath: path.resolve('src/tsconfig.json'), skipAddingFilesFromTsConfig: true });
proj.addSourceFilesAtPaths([`${SRC_DIR}/**/*.ts`, `${SRC_DIR}/**/*.tsx`, `!${SRC_DIR}/**/test/**`, `!${SRC_DIR}/**/node_modules/**`, `!${SRC_DIR}/**/*.d.ts`]);

const files = proj.getSourceFiles().filter(f => f.getFullText().includes('employeeId'));
console.log(`${files.length} files loaded\n`);

let sh = 0, dec = 0, ref = 0;

for (const sf of files) {
  // Step 1: Convert shorthands { employeeId } → { employeeId: agentId }
  sf.forEachDescendant((node) => {
    if (Node.isShorthandPropertyAssignment(node) && node.getName() === 'employeeId') {
      node.replaceWithText('employeeId: agentId');
      sh++;
    }
  });

  // Step 2: Rename identifiers
  const toRename: any[] = [];
  sf.forEachDescendant((node) => {
    if (!Node.isIdentifier(node) || node.getText() !== 'employeeId') return;
    const p = node.getParent(); if (!p) return;
    if (Node.isPropertySignature(p) || Node.isPropertyDeclaration(p)) return;
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === node) return;
    if (Node.isPropertyAssignment(p) && p.getNameNode() === node) return;
    toRename.push(node);
  });
  for (const node of toRename.reverse()) {
    const p = node.getParent();
    const isDecl = p && (
      (Node.isParameterDeclaration(p) && p.getNameNode() === node) ||
      (Node.isVariableDeclaration(p) && p.getNameNode() === node) ||
      (Node.isBindingElement(p) && p.getNameNode() === node)
    );
    node.replaceWithText('agentId');
    if (isDecl) dec++; else ref++;
  }
}

// Add Agent type
for (const sf of files) {
  if (sf.getFilePath().includes('common/agentStudioTypes.ts') && !sf.getFullText().includes('export interface Agent {')) {
    const t = sf.getFullText();
    const idx = t.indexOf('export interface Employee {');
    if (idx > 0) {
      const at = `\nexport interface Agent {\n\treadonly id: string;\n\tname: string;\n\trole: string;\n\tdescription?: string;\n\ticon?: string;\n\tavatar?: string;\n\tcategory?: string;\n\tmodel?: string | string[] | { primary: string; fallbacks: string[] };\n\tproviderId?: string;\n\tmodelId?: string;\n\tsystemPrompt?: string;\n\ttemperature?: number;\n\tmaxTokens?: number;\n\tskills?: string[];\n\ttools?: string[];\n\thandOffs?: IAgentHandOff[];\n\thooks?: IAgentHooks;\n\tvisibility?: IAgentVisibility;\n\tagents?: string[];\n\tconfidenceThreshold?: number;\n\tparallelStrategy?: 'voting' | 'coverage';\n\tmemoryConfig?: any;\n\tsource?: string;\n\tworkspaceId?: string;\n\tstatus?: string;\n\tsortOrder?: number;\n\tcreatedAt: string;\n\tupdatedAt: string;\n}\n\n`;
      sf.replaceWithText(t.slice(0, idx) + at + t.slice(idx));
      console.log('+ Agent type');
    }
  }
}

console.log(`Step 1: ${sh} shorthands`);
console.log(`Step 2: ${dec} decl + ${ref} ref = ${dec+ref} renames`);
proj.saveSync();
