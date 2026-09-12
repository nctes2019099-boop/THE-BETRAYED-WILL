import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../src/core/constants.js';
const GROUPS = Object.keys(K).filter((k) => K[k] && typeof K[k] === 'object');
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.git') walk(p, out); }
    else if (e.endsWith('.js') || e.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const files = [...walk('src'), ...walk('tests'), ...walk('tools')].filter((f) => !f.includes('_const_audit'));
let bad = 0, checked = 0;
const seen = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const g of GROUPS) {
    const re = new RegExp('\\b' + g + '\\.([A-Z][A-Z0-9_]*)', 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const key = m[1];
      checked++;
      const id = `${g}.${key}`;
      if (!(key in K[g])) {
        bad++;
        const line = src.slice(0, m.index).split('\n').length;
        if (!seen.has(id + f)) { seen.add(id + f); console.log(`  MISSING  ${f}:${line}  ${id}`); }
      }
    }
  }
}
console.log(`\nchecked ${checked} constant references across ${files.length} files`);
console.log(bad === 0 ? 'CONST AUDIT PASS - every referenced constant exists' : `CONST AUDIT FAIL - ${bad} references to undefined constants`);
process.exit(bad === 0 ? 0 : 1);
