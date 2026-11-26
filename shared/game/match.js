// Reglas del partido sobre el motor de física. Isomórfico y determinista:
// el servidor lo usa como autoridad y el cliente para predecir.

import { createWorld, step, makeDisc } from '../physics/world.js';
import { FLAGS, PLAYER_CMASK } from '../stadium/load.js';

export const TICK_RATE = 60;
export const KICK_RANGE = 4;
export const GOAL_PAUSE_TICKS = 90; // 1,5 s de festejo antes del saque
export const INPUT = Object.freeze({ up: 1, down: 2, left: 4, right: 8, kick: 16 });
/** "Golpeo de primera fuerte": cuánto más fuerte sale la patada de primera (espacio mantenido). */
export const FIRST_TIME_BOOST = 1.25;
const DIAG = Math.SQRT1_2;

export const TEAM_COLORS = Object.freeze({ red: '#e5574a', blue: '#3f7be0' });

/**
 * @param {object} stadium normalizado (loadStadium)
 * @param {object} opts { timeLimit: minutos (0 = sin), scoreLimit (0 = sin), kickCooldown: ticks entre patadas }
 */
/** El mismo estadio con otro radio de pelota (la pelota siempre es el disco 0). Sin `r`, igual. */
/** El mismo estadio con otra fuerza de patada (null = la del estadio). */
export function withKickStrength(stadium, k) {
  if (!k || !stadium.playerPhysics || stadium.playerPhysics.kickStrength === k) return stadium;
  return { ...stadium, playerPhysics: { ...stadium.playerPhysics, kickStrength: k } };
}

export function withBallRadius(stadium, r) {
  if (!r || !stadium.discs.length || stadium.discs[0].radius === r) return stadium;
  return { ...stadium, discs: stadium.discs.map((d, i) => (i === 0 ? { ...d, radius: r } : d)) };
}

export function createMatch(stadium, opts = {}) {
  const m = {
    stadium,
    settings: { timeLimit: opts.timeLimit ?? 3, scoreLimit: opts.scoreLimit ?? 3, kickCooldown: opts.kickCooldown ?? 0, allowDraw: Boolean(opts.allowDraw), strongFirst: Boolean(opts.strongFirst) },
    world: null,
    players: [],
    phase: 'idle', // idle | kickoff | playing | goal | ended
    kickoffTeam: 'red',
    score: { red: 0, blue: 0 },
    ticks: 0, // tiempo jugado (ticks)
    tick: 0, // ticks totales simulados
    overtime: false,
    phaseTimer: 0,
    lastGoal: null,
    winner: null,
    lastTouch: null,
  };
  m.world = createWorld(stadium);
  m.mapDiscCount = m.world.discs.length;
  return m;
}

export function addPlayer(m, { id, name = '', team = 'spectator', avatar = '' }) {
  const p = { id, name, team, avatar, input: 0, kickHeld: false, kicking: false, cooldown: 0, disc: null, goals: 0, assists: 0 };
  m.players.push(p);
  if (team !== 'spectator' && m.phase !== 'idle') spawnPlayer(m, p, true);
  return p;
}

export function removePlayer(m, id) {
  const p = m.players.find((x) => x.id === id);
  if (!p) return;
  removeDisc(m, p);
  m.players = m.players.filter((x) => x.id !== id);
}

export function setTeam(m, id, team) {
  const p = m.players.find((x) => x.id === id);
  if (!p || p.team === team) return;
  removeDisc(m, p);
  p.team = team;
  if (team !== 'spectator' && m.phase !== 'idle') spawnPlayer(m, p, true);
}

export function setInput(m, id, bits) {
  const p = m.players.find((x) => x.id === id);
  if (p) p.input = bits & 31;
}

function removeDisc(m, p) {
  if (!p.disc) return;
  m.world.discs = m.world.discs.filter((d) => d !== p.disc);
  p.disc = null;
}

/** Posición de aparición del i-ésimo jugador de un equipo. */
export function spawnPosition(m, team, i, late = false) {
  const s = m.stadium;
  const points = team === 'red' ? s.redSpawnPoints : s.blueSpawnPoints;
  if (points.length) {
    const pt = late ? points[points.length - 1] : points[Math.min(i, points.length - 1)];
    return [pt[0], pt[1]];
  }
  const x = team === 'red' ? -s.spawnDistance : s.spawnDistance;
  const k = Math.ceil(i / 2);
  const y = i === 0 ? 0 : (i % 2 === 1 ? -1 : 1) * 55 * k;
  return [x, y];
}

/** Disco nuevo de jugador para un equipo (mismas propiedades en servidor y cliente). */
export function makePlayerDisc(m, team, playerId) {
  const pp = m.stadium.playerPhysics;
  const disc = makeDisc({
    pos: [0, 0], speed: [0, 0], gravity: pp.gravity, radius: pp.radius, invMass: pp.invMass, damping: pp.damping,
    bCoef: pp.bCoef, color: TEAM_COLORS[team], cMask: PLAYER_CMASK,
    cGroup: (pp.cGroup | (team === 'red' ? FLAGS.red : FLAGS.blue)) >>> 0,
  }, 'player');
  disc.playerId = playerId;
  disc.team = team;
  return disc;
}

function spawnPlayer(m, p, late = false) {
  const teamIdx = m.players.filter((x) => x.team === p.team && x !== p && x.disc).length;
  const [x, y] = spawnPosition(m, p.team, teamIdx, late);
  const disc = makePlayerDisc(m, p.team, p.id);
  disc.x = x;
  disc.y = y;
  removeDisc(m, p);
  p.disc = disc;
  m.world.discs.push(disc);
  applyKickoffMasks(m);
}

export function applyKickoffMasks(m) {
  const ko = m.phase === 'kickoff' ? (m.kickoffTeam === 'red' ? FLAGS.redKO : FLAGS.blueKO) : 0;
  for (const p of m.players) if (p.disc) p.disc.cMask = (PLAYER_CMASK | ko) >>> 0;
}

/** Saque: reubica jugadores y pelota(s); con kickOffReset "full", todos los discos. */
function resetForKickoff(m, team) {
  const initial = createWorld(m.stadium).discs;
  const full = m.stadium.kickOffReset === 'full';
  for (let i = 0; i < m.mapDiscCount; i += 1) {
    const d = m.world.discs[i];
    if (full || d.kind === 'ball' || (d.cGroup & FLAGS.score)) Object.assign(d, initial[i]);
  }
  m.world.discs = m.world.discs.slice(0, m.mapDiscCount);
  for (const p of m.players) {
    p.disc = null;
    p.kicking = false;
    p.cooldown = 0;
  }
  m.kickoffTeam = team;
  m.phase = 'kickoff';
  for (const t of ['red', 'blue']) {
    m.players.filter((p) => p.team === t).forEach((p) => spawnPlayer(m, p));
  }
  applyKickoffMasks(m);
}

export function startMatch(m) {
  m.score = { red: 0, blue: 0 };
  m.ticks = 0;
  m.overtime = false;
  m.winner = null;
  m.lastGoal = null;
  m.world = createWorld(m.stadium);
  for (const p of m.players) {
    p.disc = null;
    p.goals = 0;
  }
  resetForKickoff(m, 'red');
}

export function stopMatch(m) {
  m.phase = 'idle';
  m.world = createWorld(m.stadium);
  for (const p of m.players) p.disc = null;
}

// ---------------------------------------------------------------- entrada y patada

function applyInputs(m, events) {
  const pp = m.stadium.playerPhysics;
  for (const p of m.players) {
    const d = p.disc;
    if (!d) continue;
    const bits = p.input;
    const kickDown = (bits & INPUT.kick) !== 0;
    const fresh = kickDown && !p.kickHeld; // recién apretada (no "de primera")
    if (fresh) p.kicking = true; // cada apretada permite una patada
    if (!kickDown) p.kicking = false;
    p.kickHeld = kickDown;
    let ax = ((bits & INPUT.right) ? 1 : 0) - ((bits & INPUT.left) ? 1 : 0);
    let ay = ((bits & INPUT.down) ? 1 : 0) - ((bits & INPUT.up) ? 1 : 0);
    if (ax !== 0 && ay !== 0) {
      ax *= DIAG;
      ay *= DIAG;
    }
    const acc = p.kicking ? pp.kickingAcceleration : pp.acceleration;
    d.vx += ax * acc;
    d.vy += ay * acc;
    d.damping = p.kicking ? pp.kickingDamping : pp.damping;
    if (p.cooldown > 0) p.cooldown -= 1;
    // De primera: la patada sale con la tecla ya apretada de antes (la pelota llegó sola).
    const boost = !fresh && m.settings.strongFirst ? FIRST_TIME_BOOST : 1;
    if (p.kicking && p.cooldown === 0 && tryKick(m, p, pp, boost)) {
      p.kicking = false;
      p.cooldown = m.settings.kickCooldown;
      events.push({ type: 'kick', playerId: p.id });
    }
  }
}

function tryKick(m, p, pp, boost = 1) {
  const d = p.disc;
  let kicked = false;
  for (const b of m.world.discs) {
    if (b === d || !(b.cGroup & FLAGS.kick)) continue;
    const dx = b.x - d.x;
    const dy = b.y - d.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist - b.r - d.r >= KICK_RANGE || dist === 0) continue;
    const nx = dx / dist;
    const ny = dy / dist;
    b.vx += nx * pp.kickStrength * boost * b.invMass;
    b.vy += ny * pp.kickStrength * boost * b.invMass;
    d.vx -= nx * pp.kickback * d.invMass;
    d.vy -= ny * pp.kickback * d.invMass;
    if (b.kind === 'ball') m.lastTouch = p.id;
    kicked = true;
  }
  return kicked;
}

// ---------------------------------------------------------------- goles

/** ¿El segmento p→q cruza el segmento a→b? */
export function crosses(px, py, qx, qy, ax, ay, bx, by) {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0) || (d1 === 0 && d2 === 0)) return false;
  const d3 = (qx - px) * (ay - py) - (qy - py) * (ax - px);
  const d4 = (qx - px) * (by - py) - (qy - py) * (bx - px);
  return !((d3 > 0 && d4 > 0) || (d3 < 0 && d4 < 0));
}

function detectGoal(m, prev) {
  const { discs } = m.world;
  for (let i = 0; i < prev.length; i += 1) {
    const [idx, px, py] = prev[i];
    const d = discs[idx];
    for (const g of m.stadium.goals) {
      if (crosses(px, py, d.x, d.y, g.p0[0], g.p0[1], g.p1[0], g.p1[1])) return { goal: g, disc: d };
    }
  }
  return null;
}

/** Último jugador que tocó una pelota (para saber quién hizo el gol). */
function trackTouches(m) {
  for (const p of m.players) {
    const d = p.disc;
    if (!d) continue;
    for (const b of m.world.discs) {
      if (b.kind !== 'ball' && !(b.cGroup & FLAGS.score)) continue;
      const dx = b.x - d.x;
      const dy = b.y - d.y;
      const rr = b.r + d.r + 0.5;
      if (dx * dx + dy * dy <= rr * rr) m.lastTouch = p.id;
    }
  }
}

// ---------------------------------------------------------------- tick

/** Avanza el partido un tick. Devuelve eventos: kick, goal, kickoff, end, overtime. */
export function tick(m) {
  const events = [];
  m.tick += 1;
  if (m.phase === 'idle' || m.phase === 'ended') {
    if (m.phase === 'ended') step(m.world);
    return events;
  }
  applyInputs(m, events);
  const scoring = [];
  m.world.discs.forEach((d, i) => {
    if (d.cGroup & FLAGS.score) scoring.push([i, d.x, d.y]);
  });
  step(m.world);
  trackTouches(m);

  if (m.phase === 'kickoff') {
    const moved = scoring.some(([i]) => {
      const d = m.world.discs[i];
      return d.vx !== 0 || d.vy !== 0;
    });
    if (moved) {
      m.phase = 'playing';
      applyKickoffMasks(m);
    }
  }

  const limit = m.settings.timeLimit * 60 * TICK_RATE;
  const wasGoalPhase = m.phase === 'goal';
  if (m.phase === 'playing') m.ticks += 1;

  // 1) Goles (antes que el reloj: un gol en el último tick cuenta).
  if (m.phase === 'playing' || m.phase === 'kickoff') {
    const hit = detectGoal(m, scoring);
    if (hit) {
      const team = hit.goal.team === 'red' ? 'blue' : 'red';
      m.score[team] += 1;
      const scorer = m.players.find((p) => p.id === m.lastTouch) || null;
      if (scorer && scorer.team === team) scorer.goals += 1;
      m.lastGoal = { team, scorerId: scorer ? scorer.id : null, ownGoal: Boolean(scorer && scorer.team !== team), conceded: hit.goal.team };
      m.phase = 'goal';
      m.phaseTimer = GOAL_PAUSE_TICKS;
      events.push({ type: 'goal', ...m.lastGoal });
    }
  }

  // 2) Reloj: al terminar el tiempo, gana quien va arriba; si hay empate, gol de oro.
  // (allowDraw: partidos de liga de un torneo, donde el empate vale; sin eso, empate → gol de oro.)
  if (m.phase === 'playing' && limit > 0 && m.ticks >= limit && !m.overtime) {
    if (m.score.red !== m.score.blue || m.settings.allowDraw) finish(m, events);
    else {
      m.overtime = true;
      events.push({ type: 'overtime' });
    }
  }

  // 3) Después del festejo: fin del partido o nuevo saque.
  if (wasGoalPhase && m.phase === 'goal') {
    m.phaseTimer -= 1;
    if (m.phaseTimer <= 0) {
      const sl = m.settings.scoreLimit;
      const timeUp = limit > 0 && m.ticks >= limit;
      const tied = m.score.red === m.score.blue;
      if ((sl > 0 && (m.score.red >= sl || m.score.blue >= sl)) || m.overtime || (timeUp && (!tied || m.settings.allowDraw))) {
        finish(m, events);
      } else {
        if (timeUp && tied) {
          m.overtime = true;
          events.push({ type: 'overtime' });
        }
        resetForKickoff(m, m.lastGoal.conceded);
        events.push({ type: 'kickoff', team: m.kickoffTeam });
      }
    }
  }
  return events;
}

function finish(m, events) {
  m.phase = 'ended';
  m.winner = m.score.red > m.score.blue ? 'red' : m.score.blue > m.score.red ? 'blue' : null;
  for (const p of m.players) if (p.disc) p.disc.cMask = PLAYER_CMASK;
  events.push({ type: 'end', winner: m.winner });
}

export function formatClock(m) {
  const limit = m.settings.timeLimit * 60 * TICK_RATE;
  const t = m.overtime ? m.ticks - limit : m.ticks;
  const s = Math.floor(Math.max(0, t) / TICK_RATE);
  return `${m.overtime ? '+' : ''}${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
