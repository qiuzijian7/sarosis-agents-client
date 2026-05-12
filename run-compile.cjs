const { execSync } = require('child_process');
const cwd = 'G:\\CustomWorkspaces\\AIProjects\\sarosis-agents-client';
let output = '';
try {
    output = execSync('npm run compile', { cwd, encoding: 'utf8', timeout: 300000 });
} catch (e) {
    output = e.stdout || '';
}
const lines = output.split('\n');
const lastLines = lines.slice(-20).join('\n');
console.log('=== Last 20 lines of compile output ===');
console.log(lastLines);
const hasError = output.includes('Error:');
const finished = output.includes('Finished compilation');
console.log('\n=== Summary ===');
console.log('Finished compilation:', finished);
if (hasError) {
    const errorLines = output.split('\n').filter(l => l.includes('Error:'));
    console.log('Errors found:', errorLines.length);
    errorLines.slice(0, 10).forEach(l => console.log(l));
}
