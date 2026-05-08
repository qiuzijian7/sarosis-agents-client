// Try different electron module paths
const paths = ['electron', 'electron/main', 'electron/common', 'electron/renderer'];
for (const p of paths) {
  try {
    const m = require(p);
    console.log(`require('${p}'):`, typeof m, Object.keys(m || {}).slice(0, 5));
  } catch (e) {
    console.log(`require('${p}'): ERROR -`, e.code);
  }
}
