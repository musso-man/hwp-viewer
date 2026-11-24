import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wwwDir = path.join(root, 'www');
const vendorRhwpDir = path.join(wwwDir, 'vendor', 'rhwp');
const vendorPdfjsDir = path.join(wwwDir, 'vendor', 'pdfjs');
const vendorFflateDir = path.join(wwwDir, 'vendor', 'fflate');

fs.rmSync(wwwDir, { recursive: true, force: true });
fs.mkdirSync(vendorRhwpDir, { recursive: true });
fs.mkdirSync(vendorPdfjsDir, { recursive: true });
fs.mkdirSync(vendorFflateDir, { recursive: true });

for (const file of ['index.html', 'app.js', 'style.css', 'pdf-utils.js', 'scanner.js', 'doc-adapters.js']) {
  fs.copyFileSync(path.join(root, file), path.join(wwwDir, file));
}

const rhwpSrc = path.join(root, 'node_modules', '@rhwp', 'core');
for (const file of ['rhwp.js', 'rhwp_bg.wasm']) {
  fs.copyFileSync(path.join(rhwpSrc, file), path.join(vendorRhwpDir, file));
}

const pdfjsSrc = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(pdfjsSrc, file), path.join(vendorPdfjsDir, file));
}

fs.copyFileSync(
  path.join(root, 'node_modules', 'fflate', 'esm', 'browser.js'),
  path.join(vendorFflateDir, 'browser.js')
);

console.log('Prepared www/ with offline @rhwp/core, pdfjs-dist, and fflate assets.');
