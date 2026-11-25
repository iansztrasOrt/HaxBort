// Camisetas de los equipos: diseño, colores, ángulo, color del número y del borde.
// Lo usan la sala (valida lo que manda el admin) y el navegador (dibuja las bolitas).

/** Diseños disponibles. `colors`: cuántos colores usa (el resto se ignora). */
export const KIT_PATTERNS = [
  { id: 'liso', name: 'Liso', colors: 1 },
  { id: 'franjas', name: 'Tres franjas', colors: 3 },
  { id: 'bastones', name: 'Bastones', colors: 2 },
  { id: 'mitades', name: 'Mitades', colors: 2 },
  { id: 'banda', name: 'Banda', colors: 2 },
  { id: 'faja', name: 'Faja', colors: 3 },
  { id: 'cuartos', name: 'Cuartos', colors: 2 },
  { id: 'cuadros', name: 'Cuadros', colors: 2 },
  { id: 'cruz', name: 'Cruz', colors: 2 },
  { id: 'v', name: 'V', colors: 2 },
  { id: 'centro', name: 'Círculo', colors: 2 },
  { id: 'aro', name: 'Aro', colors: 2 },
  { id: 'degradado', name: 'Degradado', colors: 3 },
  { id: 'lunares', name: 'Lunares', colors: 2 },
  { id: 'estrella', name: 'Estrella', colors: 2 },
  { id: 'rayo', name: 'Rayo', colors: 2 },
];
const PATTERN_IDS = new Set(KIT_PATTERNS.map((p) => p.id));

export const DEFAULT_KITS = Object.freeze({
  red: Object.freeze({ pattern: 'liso', colors: ['e5574a', 'ffffff', '1d1d1d'], angle: 0, text: 'ffffff', border: '0b0f10' }),
  blue: Object.freeze({ pattern: 'liso', colors: ['3f7be0', 'ffffff', '1d1d1d'], angle: 0, text: 'ffffff', border: '0b0f10' }),
});

/** Modelos listos para elegir con un toque. */
export const KIT_PRESETS = [
  { name: 'Rojo', kit: { pattern: 'liso', colors: ['e5574a', 'ffffff', '000000'], angle: 0, text: 'ffffff', border: '0b0f10' } },
  { name: 'Azul', kit: { pattern: 'liso', colors: ['3f7be0', 'ffffff', '000000'], angle: 0, text: 'ffffff', border: '0b0f10' } },
  { name: 'Celeste y blanco', kit: { pattern: 'bastones', colors: ['75aadb', 'ffffff', '000000'], angle: 0, text: '1d2b4f', border: '0b0f10' } },
  { name: 'Rojo y blanco', kit: { pattern: 'bastones', colors: ['d62828', 'ffffff', '000000'], angle: 0, text: '111111', border: '0b0f10' } },
  { name: 'Azul y oro', kit: { pattern: 'faja', colors: ['143d8c', 'f2c12e', '143d8c'], angle: 90, text: 'ffffff', border: '0b0f10' } },
  { name: 'Banda roja', kit: { pattern: 'banda', colors: ['ffffff', 'd62828', '000000'], angle: 45, text: '111111', border: '0b0f10' } },
  { name: 'Verde y negro', kit: { pattern: 'mitades', colors: ['1f8a4c', '111111', '000000'], angle: 0, text: 'ffffff', border: '0b0f10' } },
  { name: 'Tricolor', kit: { pattern: 'franjas', colors: ['1f4fa8', 'ffffff', 'd62828'], angle: 0, text: '111111', border: '0b0f10' } },
  { name: 'Ajedrez', kit: { pattern: 'cuadros', colors: ['111111', 'ffffff', '000000'], angle: 0, text: 'e5574a', border: '0b0f10' } },
  { name: 'Naranja', kit: { pattern: 'v', colors: ['f28c28', '111111', '000000'], angle: 0, text: 'ffffff', border: '0b0f10' } },
  { name: 'Fucsia', kit: { pattern: 'degradado', colors: ['e0218a', '7a1fa2', '2b2d8f'], angle: 45, text: 'ffffff', border: '0b0f10' } },
  { name: 'Amarillo', kit: { pattern: 'aro', colors: ['f5d50a', '1f4fa8', '000000'], angle: 0, text: '1f4fa8', border: '0b0f10' } },
  { name: 'Granate', kit: { pattern: 'cruz', colors: ['7b1e2b', 'f2c12e', '000000'], angle: 0, text: 'ffffff', border: '0b0f10' } },
  { name: 'Violeta', kit: { pattern: 'estrella', colors: ['5b2a86', 'f2c12e', '000000'], angle: 0, text: 'ffffff', border: '0b0f10' } },
  { name: 'Lunares', kit: { pattern: 'lunares', colors: ['ffffff', 'd62828', '000000'], angle: 0, text: '111111', border: '0b0f10' } },
  { name: 'Rayo', kit: { pattern: 'rayo', colors: ['1d1d1d', 'f5d50a', '000000'], angle: 0, text: 'ffffff', border: 'f5d50a' } },
  { name: 'Cuartos', kit: { pattern: 'cuartos', colors: ['1f8a4c', 'ffffff', '000000'], angle: 0, text: '111111', border: '0b0f10' } },
  { name: 'Negro', kit: { pattern: 'centro', colors: ['111111', '3a3a3a', '000000'], angle: 0, text: 'ffffff', border: 'ffffff' } },
];

const HEX = /^[0-9a-f]{6}$/;
const hex = (v, fallback) => {
  const s = typeof v === 'string' ? v.trim().replace(/^#/, '').toLowerCase() : '';
  if (/^[0-9a-f]{3}$/.test(s)) return s.split('').map((c) => c + c).join('');
  return HEX.test(s) ? s : fallback;
};

/** Devuelve una camiseta válida (o null si el pedido no sirve). Lo que falte toma lo de `base`. */
export function cleanKit(kit, base) {
  if (!kit || typeof kit !== 'object') return null;
  const b = base || DEFAULT_KITS.red;
  const pattern = PATTERN_IDS.has(kit.pattern) ? kit.pattern : (kit.pattern === undefined ? b.pattern : null);
  if (!pattern) return null;
  const list = Array.isArray(kit.colors) ? kit.colors : b.colors;
  const colors = [0, 1, 2].map((i) => hex(list[i], b.colors[i] || '000000'));
  const angle = Number.isFinite(Number(kit.angle)) ? ((Math.round(Number(kit.angle)) % 360) + 360) % 360 : b.angle;
  return { pattern, colors, angle, text: hex(kit.text, b.text), border: hex(kit.border, b.border) };
}

// ---------------------------------------------------------------- camisetas al azar (y que no se parezcan)
// Rojo siempre con colores cálidos y Azul con fríos: así nunca se confunden entre sí ni con su lado.
const WARM = ['e5574a', 'd62828', 'f28c28', 'f5d50a', 'e0218a', '7b1e2b', 'ff7a3d', 'c2185b', 'ffb300', 'b71c1c'];
const COOL = ['3f7be0', '143d8c', '75aadb', '1f8a4c', '5b2a86', '00a6a6', '2b2d8f', '26a69a', '7e57c2', '0d47a1'];
const NEUTRAL = ['ffffff', '111111', 'f4f1de', '2b2b2b'];
const RANDOM_PATTERNS = KIT_PATTERNS.map((p) => p.id).filter((id) => id !== 'degradado'); // el degradado mezcla demasiado

const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
export function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Color del número que se lee bien sobre un fondo. */
export const readableOn = (h) => (luminance(h) > 0.55 ? '111111' : 'ffffff');
const dist = (a, b) => {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2; // distancia "redmean": se parece más a cómo vemos los colores
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
};

/** Colores que más se ven de una camiseta (los que ocupan la mayor parte de la bolita). */
export function mainColors(k) {
  const [a, b, c] = k.colors;
  if (['mitades', 'cuartos', 'cuadros', 'bastones'].includes(k.pattern)) return [a, b];
  if (k.pattern === 'franjas' || k.pattern === 'degradado') return [a, b, c];
  return [a];
}

/** ¿Dos camisetas se pueden confundir? (algún color principal casi igual) */
export function kitsTooSimilar(x, y) {
  if (!x || !y) return false;
  for (const a of mainColors(x)) for (const b of mainColors(y)) if (dist(a, b) < 150) return true;
  return false;
}

/** Una camiseta al azar para ese lado (cálida para Rojo, fría para Azul), distinta de `avoid`. */
export function randomKit(team, rng = Math.random, avoid = null) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const fam = team === 'blue' ? COOL : WARM;
  let kit = null;
  for (let i = 0; i < 40; i += 1) {
    const pattern = pick(RANDOM_PATTERNS);
    const main = pick(fam);
    const second = pick(rng() < 0.65 ? NEUTRAL : fam.filter((c) => dist(c, main) > 120));
    const third = pick([...NEUTRAL, ...fam]);
    const angle = pick([0, 0, 0, 45, 90, 135]);
    const under = pattern === 'centro' || pattern === 'estrella' ? second : main; // lo que queda debajo del número
    kit = { pattern, colors: [main, second, third], angle, text: readableOn(under), border: '0b0f10' };
    if (!kitsTooSimilar(kit, avoid)) return kit;
  }
  return kit;
}
