import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wwwDir = path.join(root, 'www');
const vendorRhwpDir = path.join(wwwDir, 'vendor', 'rhwp');

fs.rmSync(wwwDir, { recursive: true, force: true });
fs.mkdirSync(vendorRhwpDir, { recursive: true });

for (const file of ['index.html', 'app.js', 'style.css', 'pdf-utils.js', 'scanner.js']) {
  fs.copyFileSync(path.join(root, file), path.join(wwwDir, file));
}

const rhwpSrc = path.join(root, 'node_modules', '@rhwp', 'core');
for (const file of ['rhwp.js', 'rhwp_bg.wasm']) {
  fs.copyFileSync(path.join(rhwpSrc, file), path.join(vendorRhwpDir, file));
}

console.log('Prepared www/ with offline @rhwp/core WASM assets.');
