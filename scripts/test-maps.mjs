// Prueba estadios .hbs con el importador de HaxBort.
// Uso: node scripts/test-maps.mjs [archivos o carpetas...]   (por defecto: maps/)
import fs from 'node:fs';
import path from 'node:path';
import { loadStadium } from '../shared/stadium/load.js';
import { kickCheck } from '../shared/stadium/tune.js';
import { createMatch, addPlayer, startMatch, tick } from '../shared/game/match.js';

const args = process.argv.slice(2);
const roots = args.length ? args : [path.resolve(path.dirname(new URL(import.meta.url).pathname), '../maps')];
const files = [];
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  else if (/\.(hbs|json5?|txt)$/i.test(p)) files.push(p);
};
roots.forEach(walk);
let bad = 0;
for (const f of files) {
  const res = loadStadium(fs.readFileSync(f, 'utf8'));
  if (!res.ok) {
    bad += 1;
    console.log(`✗ ${f}\n   ${res.errors.slice(0, 5).map((e) => `${e.where}: ${e.msg}`).join('\n   ')}`);
    continue;
  }
  // Simula 10 segundos con dos jugadores para detectar valores que rompen la física.
  const m = createMatch(res.stadium, {});
  addPlayer(m, { id: 'r', team: 'red' });
  addPlayer(m, { id: 'b', team: 'blue' });
  startMatch(m);
  for (let i = 0; i < 600; i += 1) tick(m);
  const finite = m.world.discs.every((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
  if (!finite) bad += 1;
  const k = kickCheck(res.stadium);
  console.log(`${finite ? '✓' : '✗'} ${f} — "${res.stadium.name}"${res.warnings.length ? ` · ${res.warnings.length} advertencias` : ''} · patada ${k.before.toFixed(1)}${k.needed ? ' (se ajusta)' : ''}${finite ? '' : ' · la simulación dio NaN'}`);
}
console.log(`\n${files.length} estadios, ${bad} con problemas.`);
process.exit(bad ? 1 : 0);
