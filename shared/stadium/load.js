// Importador de estadios .hbs: JSON5 → traits → valores por defecto → validación.
// Devuelve un estadio NORMALIZADO (JSON plano, se puede mandar por red) más
// errores (bloqueantes) y advertencias (no bloqueantes).

import { parseJSON5, JSON5Error } from '../json5.js';

export const FLAGS = Object.freeze({
  ball: 1, red: 2, blue: 4, redKO: 8, blueKO: 16, wall: 32, kick: 64, score: 128,
  c0: 1 << 28, c1: 1 << 29, c2: 1 << 30, c3: 2 ** 31,
});
export const ALL = FLAGS.ball | FLAGS.red | FLAGS.blue | FLAGS.redKO | FLAGS.blueKO | FLAGS.wall; // 63
export const PLAYER_CMASK = FLAGS.ball | FLAGS.red | FLAGS.blue | FLAGS.wall; // 39
export const MAX_OBJECTS = 255;
export const MAX_FILE_BYTES = 1024 * 1024;

const DEG = Math.PI / 180;

const KNOWN = {
  root: ['name', 'width', 'height', 'maxViewWidth', 'cameraWidth', 'cameraHeight', 'cameraFollow', 'spawnDistance',
    'canBeStored', 'kickOffReset', 'bg', 'traits', 'vertexes', 'segments', 'goals', 'discs', 'planes', 'joints',
    'redSpawnPoints', 'blueSpawnPoints', 'playerPhysics', 'ballPhysics'],
  bg: ['type', 'width', 'height', 'kickOffRadius', 'cornerRadius', 'goalLine', 'color'],
  vertex: ['x', 'y', 'bCoef', 'cMask', 'cGroup', 'trait'],
  segment: ['v0', 'v1', 'bCoef', 'curve', 'curveF', 'bias', 'cMask', 'cGroup', 'vis', 'color', 'trait'],
  goal: ['p0', 'p1', 'team', 'trait'],
  disc: ['pos', 'speed', 'gravity', 'radius', 'invMass', 'damping', 'color', 'bCoef', 'cMask', 'cGroup', 'trait'],
  plane: ['normal', 'dist', 'bCoef', 'cMask', 'cGroup', 'trait'],
  joint: ['d0', 'd1', 'length', 'strength', 'color', 'trait'],
  playerPhysics: ['gravity', 'radius', 'invMass', 'bCoef', 'damping', 'cGroup', 'acceleration', 'kickingAcceleration',
    'kickingDamping', 'kickStrength', 'kickback'],
};

/** Valores por defecto (verificados contra el comportamiento del juego original). */
export const DEFAULTS = Object.freeze({
  vertex: { bCoef: 1, cMask: ALL, cGroup: FLAGS.wall },
  segment: { bCoef: 1, cMask: ALL, cGroup: FLAGS.wall, bias: 0, vis: true, color: '#000000' },
  plane: { bCoef: 1, cMask: ALL, cGroup: FLAGS.wall, dist: 0 },
  disc: { radius: 10, invMass: 1, damping: 0.99, bCoef: 0.5, color: '#ffffff', cMask: ALL, cGroup: ALL },
  ball: { radius: 10, invMass: 1, damping: 0.99, bCoef: 0.5, color: '#ffffff', cMask: ALL, cGroup: FLAGS.ball },
  player: {
    radius: 15, invMass: 0.5, damping: 0.96, bCoef: 0.5, acceleration: 0.1, kickingAcceleration: 0.07,
    kickingDamping: 0.96, kickStrength: 5, kickback: 0, gravity: [0, 0], cGroup: 0,
  },
  bg: { type: 'none', width: 0, height: 0, kickOffRadius: 0, cornerRadius: 0, goalLine: 0, color: '#718c5a' },
  spawnDistance: 200,
});

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.warnedKeys = new Set();
  }

  error(where, msg) {
    if (this.errors.length < 200) this.errors.push({ where, msg });
  }

  warn(where, msg, dedupeKey = null) {
    if (dedupeKey) {
      if (this.warnedKeys.has(dedupeKey)) return;
      this.warnedKeys.add(dedupeKey);
    }
    if (this.warnings.length < 200) this.warnings.push({ where, msg });
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function num(report, where, obj, key, def) {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    report.error(where, `"${key}" debe ser un número válido (llegó ${describe(v)})`);
    return def;
  }
  return v;
}

function describe(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `"${v.slice(0, 20)}"`;
  return Array.isArray(v) ? 'una lista' : v === null ? 'null' : typeof v;
}

function point(report, where, obj, key, def) {
  const v = obj[key];
  if (v === undefined) return def;
  if (!Array.isArray(v) || v.length < 2 || !v.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    report.error(where, `"${key}" debe ser [x, y] con números válidos`);
    return def;
  }
  return [v[0], v[1]];
}

function bool(obj, key, def) {
  const v = obj[key];
  return typeof v === 'boolean' ? v : def;
}

export function flagsFrom(report, where, value, def) {
  if (value === undefined) return def;
  if (!Array.isArray(value)) {
    report.error(where, 'las banderas de colisión deben ser una lista de textos');
    return def;
  }
  let bits = 0;
  for (const f of value) {
    if (f === 'all') bits |= ALL;
    else if (typeof f === 'string' && FLAGS[f] !== undefined) bits |= FLAGS[f];
    else report.warn(where, `bandera de colisión desconocida ${describe(f)} (se ignora)`, `flag:${f}`);
  }
  return bits >>> 0;
}

export function flagsToList(bits) {
  if ((bits & ALL) === ALL) {
    const rest = Object.entries(FLAGS).filter(([k, b]) => !['ball', 'red', 'blue', 'redKO', 'blueKO', 'wall'].includes(k) && (bits & b) >>> 0 === b >>> 0);
    return ['all', ...rest.map(([k]) => k)];
  }
  return Object.entries(FLAGS).filter(([, b]) => (bits & b) >>> 0 === b >>> 0).map(([k]) => k);
}

export function parseColor(report, where, value, def) {
  if (value === undefined) return def;
  if (value === 'transparent') return null;
  if (typeof value === 'string') {
    const s = value.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toLowerCase()}`;
    if (/^[0-9a-fA-F]{3}$/.test(s)) return `#${s.split('').map((c) => c + c).join('').toLowerCase()}`;
  }
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((n) => Number.isFinite(n))) {
    return `#${value.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
  }
  report.warn(where, `color inválido ${describe(value)} (se usa el color por defecto)`);
  return def;
}

/** Resuelve el trait de un objeto (soporta traits que heredan de otros traits). */
function applyTrait(report, where, obj, traits) {
  if (!isObj(obj)) return obj;
  let merged = { ...obj };
  let name = obj.trait;
  const seen = new Set();
  while (name !== undefined) {
    if (typeof name !== 'string') {
      report.warn(where, '"trait" debe ser un texto');
      break;
    }
    if (seen.has(name) || seen.size > 16) {
      report.warn(where, `ciclo de traits en "${name}"`);
      break;
    }
    seen.add(name);
    const t = traits[name];
    if (!isObj(t)) {
      report.warn(where, `el trait "${name}" no existe (se ignora)`, `trait:${name}`);
      break;
    }
    merged = { ...t, ...merged };
    name = t.trait !== undefined && t.trait !== name ? t.trait : undefined;
  }
  delete merged.trait;
  return merged;
}

function unknownKeys(report, kind, obj, where) {
  for (const k of Object.keys(obj)) {
    if (!KNOWN[kind].includes(k)) report.warn(where, `propiedad desconocida "${k}" (se conserva y se ignora)`, `unk:${kind}:${k}`);
  }
}

function list(report, raw, key) {
  const v = raw[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    report.error(key, 'debe ser una lista');
    return [];
  }
  if (v.length > MAX_OBJECTS) report.warn(key, `tiene ${v.length} elementos; el original admite hasta ${MAX_OBJECTS}`);
  return v;
}

function normDisc(report, where, d, defaults) {
  return {
    pos: point(report, where, d, 'pos', [0, 0]),
    speed: point(report, where, d, 'speed', [0, 0]),
    gravity: point(report, where, d, 'gravity', [0, 0]),
    radius: num(report, where, d, 'radius', defaults.radius),
    invMass: num(report, where, d, 'invMass', defaults.invMass),
    damping: num(report, where, d, 'damping', defaults.damping),
    bCoef: num(report, where, d, 'bCoef', defaults.bCoef),
    color: parseColor(report, where, d.color, defaults.color),
    cMask: flagsFrom(report, where, d.cMask, defaults.cMask),
    cGroup: flagsFrom(report, where, d.cGroup, defaults.cGroup),
  };
}

/**
 * Carga un estadio desde texto (o desde un objeto ya parseado).
 * @returns {{ ok: boolean, stadium: object|null, errors: {where,msg}[], warnings: {where,msg}[] }}
 */
export function loadStadium(input, { maxBytes = MAX_FILE_BYTES } = {}) {
  const report = new Report();
  let raw = input;
  if (typeof input === 'string') {
    const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(input).length : input.length;
    if (bytes > maxBytes) {
      report.error('archivo', `pesa ${Math.round(bytes / 1024)} KB; el máximo es ${Math.round(maxBytes / 1024)} KB`);
      return { ok: false, stadium: null, errors: report.errors, warnings: report.warnings };
    }
    try {
      raw = parseJSON5(input, { maxLength: maxBytes });
    } catch (e) {
      if (e instanceof JSON5Error) {
        report.error('JSON5', e.message);
        return { ok: false, stadium: null, errors: report.errors, warnings: report.warnings };
      }
      throw e;
    }
  }
  if (!isObj(raw)) {
    report.error('archivo', 'el estadio debe ser un objeto { ... }');
    return { ok: false, stadium: null, errors: report.errors, warnings: report.warnings };
  }
  unknownKeys(report, 'root', raw, 'estadio');
  const traits = isObj(raw.traits) ? raw.traits : {};
  if (raw.traits !== undefined && !isObj(raw.traits)) report.warn('traits', 'debe ser un objeto');
  const T = (obj, where) => applyTrait(report, where, obj, traits);

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Sin nombre';
  if (typeof raw.name !== 'string') report.warn('name', 'el estadio no tiene nombre');

  // Fondo
  const bgRaw = isObj(raw.bg) ? raw.bg : {};
  if (isObj(raw.bg)) unknownKeys(report, 'bg', bgRaw, 'bg');
  const bgType = ['grass', 'hockey', 'none'].includes(bgRaw.type) ? bgRaw.type : 'none';
  if (bgRaw.type !== undefined && bgType !== bgRaw.type) report.warn('bg.type', `tipo de fondo desconocido ${describe(bgRaw.type)}`);
  const bg = {
    type: bgType,
    width: num(report, 'bg', bgRaw, 'width', 0),
    height: num(report, 'bg', bgRaw, 'height', 0),
    kickOffRadius: num(report, 'bg', bgRaw, 'kickOffRadius', 0),
    cornerRadius: num(report, 'bg', bgRaw, 'cornerRadius', 0),
    goalLine: num(report, 'bg', bgRaw, 'goalLine', 0),
    color: parseColor(report, 'bg', bgRaw.color, DEFAULTS.bg.color) || DEFAULTS.bg.color,
  };

  // Vértices
  const vertexes = list(report, raw, 'vertexes').map((v0, i) => {
    const where = `vertexes[${i}]`;
    if (!isObj(v0)) {
      report.error(where, 'debe ser un objeto');
      return { x: 0, y: 0, ...DEFAULTS.vertex };
    }
    unknownKeys(report, 'vertex', v0, where);
    const v = T(v0, where);
    if (v.x === undefined || v.y === undefined) report.error(where, 'le falta "x" o "y"');
    return {
      x: num(report, where, v, 'x', 0),
      y: num(report, where, v, 'y', 0),
      bCoef: num(report, where, v, 'bCoef', DEFAULTS.vertex.bCoef),
      cMask: flagsFrom(report, where, v.cMask, DEFAULTS.vertex.cMask),
      cGroup: flagsFrom(report, where, v.cGroup, DEFAULTS.vertex.cGroup),
    };
  });

  // Segmentos (la curva se resuelve como en el original: curva negativa invierte
  // los vértices y el bias; fuera de 10°..340° la línea queda recta).
  const segments = [];
  list(report, raw, 'segments').forEach((s0, i) => {
    const where = `segments[${i}]`;
    if (!isObj(s0)) {
      report.error(where, 'debe ser un objeto');
      return;
    }
    unknownKeys(report, 'segment', s0, where);
    const s = T(s0, where);
    let v0 = s.v0;
    let v1 = s.v1;
    for (const [k, val] of [['v0', v0], ['v1', v1]]) {
      if (!Number.isInteger(val) || val < 0 || val >= vertexes.length) {
        report.error(where, `"${k}" = ${describe(val)} no es un vértice válido (hay ${vertexes.length})`);
      }
    }
    let bias = num(report, where, s, 'bias', 0);
    let curveF = null;
    if (s.curveF !== undefined) {
      const cf = s.curveF;
      if (typeof cf === 'number' && !Number.isNaN(cf)) curveF = Number.isFinite(cf) ? cf : null;
      else report.error(where, '"curveF" debe ser un número');
    } else {
      let curve = num(report, where, s, 'curve', 0) * DEG;
      if (curve < 0) {
        curve = -curve;
        [v0, v1] = [v1, v0];
        bias = -bias;
      }
      if (curve > 10 * DEG && curve < 340 * DEG) curveF = 1 / Math.tan(curve / 2);
      else if (curve !== 0) report.warn(where, `curva de ${Math.round(curve / DEG)}° fuera de 10°..340°: se dibuja recta`, `curve:${i}`);
    }
    segments.push({
      v0, v1, curveF, bias,
      bCoef: num(report, where, s, 'bCoef', DEFAULTS.segment.bCoef),
      cMask: flagsFrom(report, where, s.cMask, DEFAULTS.segment.cMask),
      cGroup: flagsFrom(report, where, s.cGroup, DEFAULTS.segment.cGroup),
      vis: bool(s, 'vis', true),
      color: parseColor(report, where, s.color, DEFAULTS.segment.color),
    });
  });

  // Arcos
  const goals = [];
  list(report, raw, 'goals').forEach((g0, i) => {
    const where = `goals[${i}]`;
    if (!isObj(g0)) {
      report.error(where, 'debe ser un objeto');
      return;
    }
    unknownKeys(report, 'goal', g0, where);
    const g = T(g0, where);
    if (g.team !== 'red' && g.team !== 'blue') report.error(where, '"team" debe ser "red" o "blue"');
    if (g.p0 === undefined || g.p1 === undefined) report.error(where, 'le falta "p0" o "p1"');
    goals.push({ p0: point(report, where, g, 'p0', [0, 0]), p1: point(report, where, g, 'p1', [0, 0]), team: g.team === 'blue' ? 'blue' : 'red' });
  });
  if (!goals.length) report.warn('goals', 'el estadio no tiene arcos: no se van a poder hacer goles');

  // Planos
  const planes = [];
  list(report, raw, 'planes').forEach((p0, i) => {
    const where = `planes[${i}]`;
    if (!isObj(p0)) {
      report.error(where, 'debe ser un objeto');
      return;
    }
    unknownKeys(report, 'plane', p0, where);
    const p = T(p0, where);
    const n = point(report, where, p, 'normal', null);
    if (!n) {
      report.error(where, 'le falta "normal"');
      return;
    }
    const len = Math.hypot(n[0], n[1]);
    if (!(len > 0)) {
      report.error(where, '"normal" no puede ser [0, 0]');
      return;
    }
    planes.push({
      normal: [n[0] / len, n[1] / len],
      dist: num(report, where, p, 'dist', 0),
      bCoef: num(report, where, p, 'bCoef', DEFAULTS.plane.bCoef),
      cMask: flagsFrom(report, where, p.cMask, DEFAULTS.plane.cMask),
      cGroup: flagsFrom(report, where, p.cGroup, DEFAULTS.plane.cGroup),
    });
  });

  // Discos y pelota (la pelota ocupa el índice 0, salvo con ballPhysics "disc0").
  const mapDiscs = list(report, raw, 'discs').map((d0, i) => {
    const where = `discs[${i}]`;
    if (!isObj(d0)) {
      report.error(where, 'debe ser un objeto');
      return normDisc(report, where, {}, DEFAULTS.disc);
    }
    unknownKeys(report, 'disc', d0, where);
    return normDisc(report, where, T(d0, where), DEFAULTS.disc);
  });
  let discs;
  let ballMode;
  if (raw.ballPhysics === 'disc0') {
    ballMode = 'disc0';
    if (!mapDiscs.length) {
      report.error('ballPhysics', '"disc0" pero el estadio no tiene discos');
      mapDiscs.push(normDisc(report, 'ballPhysics', {}, DEFAULTS.ball));
    }
    discs = mapDiscs;
  } else {
    ballMode = 'object';
    let ball;
    if (isObj(raw.ballPhysics)) {
      unknownKeys(report, 'disc', raw.ballPhysics, 'ballPhysics');
      ball = normDisc(report, 'ballPhysics', T(raw.ballPhysics, 'ballPhysics'), DEFAULTS.ball);
    } else {
      if (raw.ballPhysics !== undefined) report.warn('ballPhysics', 'valor inválido: se usa la pelota por defecto');
      else report.warn('ballPhysics', 'no definida: se usa la pelota por defecto');
      ball = normDisc(report, 'ballPhysics', {}, DEFAULTS.ball);
    }
    ball.cGroup = (ball.cGroup | FLAGS.kick | FLAGS.score) >>> 0;
    discs = [ball, ...mapDiscs];
  }

  // Uniones
  const joints = [];
  list(report, raw, 'joints').forEach((j0, i) => {
    const where = `joints[${i}]`;
    if (!isObj(j0)) {
      report.error(where, 'debe ser un objeto');
      return;
    }
    unknownKeys(report, 'joint', j0, where);
    const j = T(j0, where);
    const d0 = j.d0 ?? 0;
    const d1 = j.d1 ?? 0;
    for (const [k, val] of [['d0', d0], ['d1', d1]]) {
      if (!Number.isInteger(val) || val < 0 || val >= discs.length) report.error(where, `"${k}" = ${describe(val)} no es un disco válido (hay ${discs.length})`);
    }
    let length = null;
    if (typeof j.length === 'number') {
      if (!Number.isFinite(j.length)) report.error(where, '"length" debe ser un número válido');
      else length = j.length;
    } else if (Array.isArray(j.length)) {
      if (j.length.length >= 2 && j.length.slice(0, 2).every((n) => typeof n === 'number' && Number.isFinite(n))) length = [j.length[0], j.length[1]];
      else report.error(where, '"length" debe ser número, [mín, máx] o null');
    } else if (j.length !== undefined && j.length !== null) report.error(where, '"length" debe ser número, [mín, máx] o null');
    let strength = 'rigid';
    if (typeof j.strength === 'number') {
      if (Number.isFinite(j.strength)) strength = j.strength;
      else if (j.strength === Infinity) strength = 'rigid';
      else report.error(where, '"strength" debe ser un número o "rigid"');
    } else if (j.strength !== undefined && j.strength !== 'rigid') report.error(where, '"strength" debe ser un número o "rigid"');
    joints.push({ d0, d1, length, strength, color: parseColor(report, where, j.color, '#000000') });
  });

  // Física de jugador
  const ppRaw = isObj(raw.playerPhysics) ? raw.playerPhysics : {};
  if (isObj(raw.playerPhysics)) unknownKeys(report, 'playerPhysics', ppRaw, 'playerPhysics');
  const D = DEFAULTS.player;
  const playerPhysics = {
    radius: num(report, 'playerPhysics', ppRaw, 'radius', D.radius),
    invMass: num(report, 'playerPhysics', ppRaw, 'invMass', D.invMass),
    damping: num(report, 'playerPhysics', ppRaw, 'damping', D.damping),
    bCoef: num(report, 'playerPhysics', ppRaw, 'bCoef', D.bCoef),
    acceleration: num(report, 'playerPhysics', ppRaw, 'acceleration', D.acceleration),
    kickingAcceleration: num(report, 'playerPhysics', ppRaw, 'kickingAcceleration', D.kickingAcceleration),
    kickingDamping: num(report, 'playerPhysics', ppRaw, 'kickingDamping', D.kickingDamping),
    kickStrength: num(report, 'playerPhysics', ppRaw, 'kickStrength', D.kickStrength),
    kickback: num(report, 'playerPhysics', ppRaw, 'kickback', D.kickback),
    gravity: point(report, 'playerPhysics', ppRaw, 'gravity', [0, 0]),
    cGroup: flagsFrom(report, 'playerPhysics', ppRaw.cGroup, D.cGroup),
  };

  const spawns = (key) => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      report.error(key, 'debe ser una lista de [x, y]');
      return [];
    }
    return v.map((p, i) => point(report, `${key}[${i}]`, { p }, 'p', [0, 0]));
  };

  const stadium = {
    format: 'haxbort-stadium-1',
    name,
    width: num(report, 'width', raw, 'width', 0),
    height: num(report, 'height', raw, 'height', 0),
    maxViewWidth: num(report, 'maxViewWidth', raw, 'maxViewWidth', 0),
    cameraWidth: num(report, 'cameraWidth', raw, 'cameraWidth', 0),
    cameraHeight: num(report, 'cameraHeight', raw, 'cameraHeight', 0),
    cameraFollow: raw.cameraFollow === 'player' ? 'player' : 'ball',
    spawnDistance: num(report, 'spawnDistance', raw, 'spawnDistance', DEFAULTS.spawnDistance),
    canBeStored: raw.canBeStored !== false,
    kickOffReset: raw.kickOffReset === 'full' ? 'full' : 'partial',
    bg,
    vertexes,
    segments,
    goals,
    planes,
    discs,
    ballMode,
    joints,
    playerPhysics,
    redSpawnPoints: spawns('redSpawnPoints'),
    blueSpawnPoints: spawns('blueSpawnPoints'),
  };
  if (!(stadium.width > 0) || !(stadium.height > 0)) report.warn('width/height', 'sin "width"/"height": la cámara usa el tamaño de los objetos');
  return { ok: report.errors.length === 0, stadium: report.errors.length ? null : stadium, errors: report.errors, warnings: report.warnings };
}
