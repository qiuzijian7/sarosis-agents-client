/**
 * Store Migration: useEmployeeStore → useAgentStore
 * Replaces import + destructured field names in webview source files
 */
import { Project, SyntaxKind, Node } from 'ts-morph';
import path from 'path';

const SRC_DIR = path.resolve('src/vs/sessions/contrib/agentStudio/webview/src');
const proj = new Project({
  tsConfigFilePath: path.resolve('src/tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
});
proj.addSourceFilesAtPaths([`${SRC_DIR}/**/*.ts`, `${SRC_DIR}/**/*.tsx`]);

// Field name mappings: old → new
const FIELD_MAP: Record<string, string> = {
  'employees': 'agents',
  'selectedEmployeeId': 'selectedAgentId',
  'selectEmployee': 'selectAgent',
  'deleteEmployee': 'deleteAgent',
  'loadEmployees': 'loadAgents',
  'exportEmployee': 'exportAgent',
  'importEmployee': 'importAgent',
  'createEmployee': 'createAgent',
  'updateEmployee': 'updateAgent',
  'activeEmployeeId': 'activeAgentId',
  'filteredEmployees': 'filteredAgents',
  'setActiveEmployee': 'setActiveAgent',
};

let importCount = 0;
let fieldCount = 0;

for (const sf of proj.getSourceFiles()) {
  // Skip the store definitions themselves
  if (sf.getFilePath().includes('useEmployeeStore.ts')) continue;
  if (sf.getFilePath().includes('useAgentStore.ts')) continue;

  const text = sf.getFullText();
  if (!text.includes('useEmployeeStore')) continue;
  if (text.includes('// @keep-employee-store')) continue; // opt-out marker

  // Step 1: Replace import statement
  if (text.includes("from './useEmployeeStore'") || text.includes("from '../../store/useEmployeeStore'") || text.includes('from "../store/useEmployeeStore"')) {
    // Replace the module path
    let modified = text
      .replace(/from\s+['"]\.\/useEmployeeStore['"]/, "from './useAgentStore'")
      .replace(/from\s+['"]\.\.\/store\/useEmployeeStore['"]/, "from '../store/useAgentStore'")
      .replace(/from\s+['"]\.\.\/\.\.\/store\/useEmployeeStore['"]/, "from '../../store/useAgentStore'");
    
    // Replace import specifier
    modified = modified.replace(/import\s*\{\s*([^}]*)\}\s*from/g, (match, specifiers) => {
      // Don't change the 'type Employee' specifier
      const parts = specifiers.split(',').map((s: string) => s.trim());
      const newParts = parts.map((p: string) => {
        if (p === 'useEmployeeStore') return 'useAgentStore';
        return p;
      });
      return `import { ${newParts.join(', ')} } from`;
    });

    if (modified !== text) {
      sf.replaceWithText(modified);
      importCount++;
      console.log(`  Import: ${sf.getBaseName()}`);
    }
  }

  // Step 2: Rename field references in hook destructuring
  // Pattern: const { employees, selectEmployee, ... } = useEmployeeStore();
  // →        const { agents, selectAgent, ... } = useAgentStore();
  const updatedText = sf.getFullText();
  
  // Replace useEmployeeStore() calls with useAgentStore()
  let final = updatedText.replace(/\buseEmployeeStore\b/g, 'useAgentStore');
  
  // Replace field names in destructuring and standalone calls
  for (const [oldName, newName] of Object.entries(FIELD_MAP)) {
    // In destructuring: const { oldName, ... } = useAgentStore()
    final = final.replace(
      new RegExp(`\\b${oldName}\\b`, 'g'),
      (match, offset) => {
        // Don't change in comments or strings
        const lineStart = final.lastIndexOf('\n', offset) + 1;
        const line = final.substring(lineStart, final.indexOf('\n', offset));
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return match;
        // Don't change in import paths
        if (line.includes('from ') && line.includes(oldName.toLowerCase())) return match;
        return newName;
      }
    );
    fieldCount += (final.match(new RegExp(`\\b${newName}\\b`, 'g')) || []).length -
                 (updatedText.match(new RegExp(`\\b${newName}\\b`, 'g')) || []).length;
  }
  
  if (final !== updatedText) {
    sf.replaceWithText(final);
  }
}

console.log(`\nDone: ${importCount} imports changed, ~${fieldCount} field references renamed`);
proj.saveSync();
