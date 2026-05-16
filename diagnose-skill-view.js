// Diagnosis script for Skills View issue
// Run this in the developer tools console when the Skills page is open

console.log('=== Skills View Diagnosis ===');

// Check if SkillRegistry is instantiated
const skillRegistry = window.services?.skillRegistry || 
                  (window.getService && window.getService('ISkillRegistry'));

if (skillRegistry) {
    console.log('✓ SkillRegistry found');
    const skills = skillRegistry.getSkills();
    console.log(`  Skills count: ${skills.length}`);
    skills.forEach(s => console.log(`  - ${s.name} (${s.id}, ${s.activation})`));
} else {
    console.log('✗ SkillRegistry NOT found - it may not be instantiated yet');
}

// Check if SkillsViewPane is in the DOM
const skillsView = document.querySelector('.skills-view');
if (skillsView) {
    console.log('✓ Skills view DOM found');
    const header = skillsView.querySelector('.skills-header');
    const list = skillsView.querySelector('.skills-list');
    console.log(`  Header: ${header ? 'found' : 'NOT found'}`);
    console.log(`  List container: ${list ? 'found' : 'NOT found'}`);
    if (list) {
        console.log(`  List children: ${list.children.length}`);
    }
} else {
    console.log('✗ Skills view DOM NOT found - renderBody() may not have been called');
}

// Check activity bar registration
console.log('\n=== Activity Bar Registration ===');
const activityBar = document.querySelector('.activitybar');
if (activityBar) {
    const skillsIcon = activityBar.querySelector('[title*="Skills"]');
    console.log(`Skills icon in activity bar: ${skillsIcon ? 'found' : 'NOT found'}`);
}
