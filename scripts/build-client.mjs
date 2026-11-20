// Empaqueta el cliente (motor compartido + interfaz) en un único HTML: dist/index.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  entryPoints: [path.join(ROOT, 'client/app.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['es2020'],
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8').replace('/*BUNDLE*/', () => js);
// Versión = versión del paquete + huella del contenido: cambia sola cada vez que cambia el juego.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build_id = `${pkg.version}-${crypto.createHash('sha1').update(html).digest('hex').slice(0, 7)}`;
html = html.replace('__BUILD_ID__', build_id);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/index.html'), html);
console.log(`dist/index.html (${(html.length / 1024).toFixed(0)} KB) · versión ${build_id}`);
