// Genera los estadios integrados de HaxBort como archivos .hbs (JSON5) en maps/builtin/
// y un módulo JS con su texto (shared/builtinMaps.js) para usarlos sin red.
// Son diseños propios; pasan por el mismo importador que cualquier mapa de HaxMaps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'maps/builtin');

// Física de jugador de HaxBort: un poco más ágil que la clásica (0.1 / 0.96):
// acelera un 15% más y frena antes, así responde mejor a cada cambio de dirección.
const AGILE = { acceleration: 0.115, kickingAcceleration: 0.08, damping: 0.956, kickingDamping: 0.956 };

function field(o) {
  const {
    id, name, w, h, goal, depth = 45, corner = 0, barrier = true, kickR = 80, spawn = Math.round(w * 0.45),
    bg = 'grass', color = '6e9e58', hockey = false, ball = {}, player = AGILE, margin = 40,
  } = o;
  const V = [];
  const S = [];
  const v = (x, y, trait = 'ballArea') => {
    V.push({ x, y, trait });
    return V.length - 1;
  };
  const seg = (a, b, extra = {}) => S.push({ v0: a, v1: b, ...extra });
  // Línea de pelota: se recorre en sentido horario; las esquinas son arcos de +90°.
  const gx = hockey ? w - 60 : w; // en hockey los arcos están dentro de la pista
  if (corner > 0) {
    const p = [
      [-w + corner, -h], [w - corner, -h], [w, -h + corner], [w, -goal], [w, goal], [w, h - corner],
      [w - corner, h], [-w + corner, h], [-w, h - corner], [-w, goal], [-w, -goal], [-w, -h + corner],
    ];
    const idx = p.map(([x, y]) => v(x, y));
    seg(idx[0], idx[1], { trait: 'ballArea' });
    seg(idx[1], idx[2], { trait: 'ballArea', curve: 90 });
    if (hockey) seg(idx[2], idx[5], { trait: 'ballArea' });
    else {
      seg(idx[2], idx[3], { trait: 'ballArea' });
      seg(idx[4], idx[5], { trait: 'ballArea' });
    }
    seg(idx[5], idx[6], { trait: 'ballArea', curve: 90 });
    seg(idx[6], idx[7], { trait: 'ballArea' });
    seg(idx[7], idx[8], { trait: 'ballArea', curve: 90 });
    if (hockey) seg(idx[8], idx[11], { trait: 'ballArea' });
    else {
      seg(idx[8], idx[9], { trait: 'ballArea' });
      seg(idx[10], idx[11], { trait: 'ballArea' });
    }
    seg(idx[11], idx[0], { trait: 'ballArea', curve: 90 });
  } else {
    const a = v(-w, -h);
    const b = v(w, -h);
    const c = v(w, -goal);
    const d = v(w, goal);
    const e = v(w, h);
    const f = v(-w, h);
    const g = v(-w, goal);
    const k = v(-w, -goal);
    seg(a, b, { trait: 'ballArea' });
    seg(b, c, { trait: 'ballArea' });
    seg(d, e, { trait: 'ballArea' });
    seg(e, f, { trait: 'ballArea' });
    seg(f, g, { trait: 'ballArea' });
    seg(k, a, { trait: 'ballArea' });
  }
  // Redes de los arcos (con fondo levemente curvo).
  for (const side of [-1, 1]) {
    const x0 = side * gx;
    const x1 = side * (gx + depth);
    const p0 = v(x0, -goal, 'goalNet');
    const p1 = v(x1, -goal + 12, 'goalNet');
    const p2 = v(x1, goal - 12, 'goalNet');
    const p3 = v(x0, goal, 'goalNet');
    seg(p0, p1, { trait: 'goalNet', curve: side * 30 });
    seg(p1, p2, { trait: 'goalNet', curve: side * 20 });
    seg(p2, p3, { trait: 'goalNet', curve: side * 30 });
  }
  // Barrera de saque: línea media + medio círculo de cada lado.
  if (barrier) {
    const top = v(0, -h - margin, 'kickOffBarrier');
    const ct = v(0, -kickR, 'kickOffBarrier');
    const cb = v(0, kickR, 'kickOffBarrier');
    const bot = v(0, h + margin, 'kickOffBarrier');
    seg(top, ct, { trait: 'kickOffBarrier' });
    seg(cb, bot, { trait: 'kickOffBarrier' });
    // Con saque de rojo, todos tienen "redKO": el arco derecho cierra el círculo para el azul.
    seg(ct, cb, { trait: 'kickOffBarrier', cGroup: ['redKO'], curve: 180 });
    seg(ct, cb, { trait: 'kickOffBarrier', cGroup: ['blueKO'], curve: -180 });
  }
  const discs = [];
  for (const side of [-1, 1]) {
    discs.push({ pos: [side * gx, -goal], trait: 'goalPost', color: side < 0 ? 'f2b5ae' : 'aec8f2' });
    discs.push({ pos: [side * gx, goal], trait: 'goalPost', color: side < 0 ? 'f2b5ae' : 'aec8f2' });
  }
  const goals = [
    { p0: [-gx - 2, -goal + 8], p1: [-gx - 2, goal - 8], team: 'red' },
    { p0: [gx + 2, -goal + 8], p1: [gx + 2, goal - 8], team: 'blue' },
  ];
  const planes = [
    { normal: [0, 1], dist: -(h + margin), trait: 'playerArea' },
    { normal: [0, -1], dist: -(h + margin), trait: 'playerArea' },
    { normal: [1, 0], dist: -(w + margin + (hockey ? 0 : depth)), trait: 'playerArea' },
    { normal: [-1, 0], dist: -(w + margin + (hockey ? 0 : depth)), trait: 'playerArea' },
    { normal: [0, 1], dist: -(h + margin * 2), bCoef: 0.5, cMask: ['ball'] },
    { normal: [0, -1], dist: -(h + margin * 2), bCoef: 0.5, cMask: ['ball'] },
  ];
  const stadium = {
    name,
    width: w + margin + depth,
    height: h + margin,
    spawnDistance: spawn,
    maxViewWidth: 0,
    cameraFollow: 'ball',
    kickOffReset: 'partial',
    bg: { type: bg, width: w, height: h, kickOffRadius: kickR, cornerRadius: corner, goalLine: hockey ? gx : 0, color },
    traits: {
      ballArea: { vis: false, bCoef: 1, cMask: ['ball'] },
      goalNet: { vis: true, bCoef: 0.1, cMask: ['ball'], color: 'f4f1de' },
      goalPost: { radius: 8, invMass: 0, bCoef: 0.5 },
      kickOffBarrier: { vis: false, bCoef: 0.1, cGroup: ['redKO', 'blueKO'], cMask: ['red', 'blue'] },
      playerArea: { bCoef: 0.1, cMask: ['red', 'blue'] },
    },
    vertexes: V,
    segments: S,
    goals,
    discs,
    planes,
    ballPhysics: { radius: 10, bCoef: 0.5, invMass: 1, damping: 0.99, color: 'fffdf5', ...ball },
  };
  if (player) stadium.playerPhysics = player;
  return { id, stadium };
}

const MAPS = [
  field({ id: 'clasica', name: 'Clásica', w: 380, h: 175, goal: 64, ball: { radius: 5 } }),
  field({ id: 'facil', name: 'Fácil', w: 380, h: 175, goal: 90, barrier: false }),
  field({ id: 'chica', name: 'Chica', w: 280, h: 130, goal: 55, kickR: 60, depth: 35 }),
  field({ id: 'grande', name: 'Grande', w: 560, h: 260, goal: 80, kickR: 100 }),
  field({ id: 'redondeada', name: 'Redondeada', w: 380, h: 175, goal: 64, corner: 70 }),
  field({
    id: 'hockey', name: 'Hockey', w: 420, h: 200, goal: 60, corner: 90, bg: 'hockey', color: '5b7a8c', hockey: true, depth: 30,
    ball: { radius: 7, damping: 0.995, bCoef: 0.8, color: '1d1d1d' },
    player: { damping: 0.983, acceleration: 0.078, kickingAcceleration: 0.056, kickingDamping: 0.983, kickStrength: 6 },
  }),
  field({
    id: 'hockey-grande', name: 'Hockey Grande', w: 600, h: 280, goal: 75, corner: 120, bg: 'hockey', color: '5b7a8c', hockey: true, depth: 32, kickR: 110,
    ball: { radius: 7, damping: 0.995, bCoef: 0.8, color: '1d1d1d' },
    player: { damping: 0.983, acceleration: 0.078, kickingAcceleration: 0.056, kickingDamping: 0.983, kickStrength: 6 },
  }),
  field({ id: 'grande-facil', name: 'Grande Fácil', w: 560, h: 260, goal: 110, kickR: 100, barrier: false }),
  field({ id: 'grande-redondeada', name: 'Grande Redondeada', w: 560, h: 260, goal: 80, kickR: 100, corner: 110 }),
  field({ id: 'gigante', name: 'Gigante', w: 800, h: 380, goal: 110, kickR: 140, depth: 55 }),
];

fs.mkdirSync(OUT, { recursive: true });
const texts = {};
for (const { id, stadium } of MAPS) {
  const text = `// Estadio integrado de HaxBort: ${stadium.name}\n// Diseño propio. Formato .hbs (JSON5), compatible con el importador.\n${JSON.stringify(stadium, null, 2)}\n`;
  fs.writeFileSync(path.join(OUT, `${id}.hbs`), text);
  texts[id] = text;
}
fs.writeFileSync(path.join(ROOT, 'shared/builtinMaps.js'),
  `// Generado por scripts/gen-builtin.mjs — no editar a mano.\nexport const BUILTIN_MAPS = ${JSON.stringify(MAPS.map(({ id, stadium }) => ({ id, name: stadium.name, text: texts[id] })))};\n`);
console.log(`${MAPS.length} estadios → maps/builtin/`);
