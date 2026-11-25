// Estadísticas del partido y nota de cada jugador (para el MVP).
// Las calcula la sala (la compu que corre el partido) tick a tick, mirando quién toca la pelota
// y hacia dónde sale. Sin IA: reglas fijas, iguales para todos y fáciles de explicar.
//
//   Pase        la toca A y la siguiente que la toca es un compañero (y la pelota viajó un poco)
//   Pérdida     la toca A y la siguiente que la toca es un rival (para el rival: intercepción)
//   Tiro        una patada (o un toque fuerte) que va hacia el arco rival
//   Al arco     ese tiro, si nadie lo tocara, entraría entre los palos
//   Atajada     un tiro al arco que corta un rival antes de que entre
//   Asistencia  el último pase de un compañero al goleador, sin que la toque un rival en el medio

export const RATING = {
  base: 6, goal: 1.0, assist: 0.7, save: 0.5, interception: 0.03, onTarget: 0.15, pass: 0.05, lost: -0.03, ownGoal: -0.8, win: 0.5, cleanSheet: 0.3,
};
const PASS_MIN_DIST = 40; // si la pelota viajó menos, es un rebote o una gambeta, no un pase
const SHOT_MIN_SPEED = 3.5; // más lento que esto no es un tiro
const SHOT_ARRIVE_SPEED = 1.5; // tiene que llegar al arco con algo de fuerza
const SHOT_MAX_SHARE = 0.6; // y salir desde no más lejos que el 60% de la distancia del medio al arco
const HOLD_TICKS = 5; // un cambio de dueño cuenta si se sostiene un instante (o si patea): en una pelota disputada no se cuenta cada roce
const SHOT_TTL = 3 * 60;
const SAVE_MIN_TICKS = 6; // un tiro cortado a quemarropa (en un forcejeo) no es atajada
const NARR_WAIT = 40; // el relator espera un instante: si el tiro termina en gol o atajada, lo cuenta junto

// ---- relator: lo que pasa, para contarlo en el chat (S.feed se vacía desde la sala)
function flushShot(S) {
  if (S.narr) S.feed.push({ type: 'shot', by: S.narr.by, onTarget: S.narr.onTarget });
  S.narr = null;
} // un tiro "vive" 3 segundos (después ya no cuenta como atajada)
const ASSIST_TTL = 8 * 60; // la asistencia vale si el gol llega dentro de 8 segundos del pase
const COUNTERS = ['g', 'a', 'og', 'sh', 'sot', 'sv', 'pc', 'pl', 'int', 'tch'];

export function createStats() {
  return { rows: new Map(), last: null, cand: null, pass: null, shot: null, poss: { red: 0, blue: 0 }, tick: 0, shotTick: -1, version: 0, feed: [], narr: null };
}

function rowFor(S, p) {
  let r = S.rows.get(p.id);
  if (!r) {
    r = { id: p.id, name: p.name, avatar: p.avatar, team: p.team };
    for (const k of COUNTERS) r[k] = 0;
    S.rows.set(p.id, r);
  }
  if (p.team !== 'spectator') r.team = p.team;
  r.name = p.name || r.name;
  r.avatar = p.avatar || r.avatar;
  return r;
}

const ballOf = (m) => m.world.discs.find((d) => d.kind === 'ball') || null;

/** ¿La pelota, sin que nadie la toque, cruzaría la línea de un arco rival? 'arco' | 'afuera' | null. */
export function shotTarget(m, ball, team) {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed < SHOT_MIN_SPEED) return null;
  const damping = ball.damping > 0 && ball.damping < 1 ? ball.damping : 0.99;
  const reach = speed / (1 - damping); // lo que recorre hasta frenarse
  const ux = ball.vx / speed;
  const uy = ball.vy / speed;
  let best = null;
  for (const g of m.stadium.goals) {
    if (g.team === team) continue; // es el arco propio
    const [ax, ay] = g.p0;
    const [bx, by] = g.p1;
    const ex = bx - ax;
    const ey = by - ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - ball.x) * ey - (ay - ball.y) * ex) / den; // distancia por la trayectoria
    const s = ((ax - ball.x) * uy - (ay - ball.y) * ux) / den; // posición sobre la línea del arco (0..1 = entre palos)
    if (t <= 0 || t > reach) continue;
    if (speed - t * (1 - damping) < SHOT_ARRIVE_SPEED) continue; // llegaría muerta
    const goalDist = Math.hypot((ax + bx) / 2, (ay + by) / 2) || 1; // del medio de la cancha al arco
    if (t > goalDist * SHOT_MAX_SHARE) continue; // de muy lejos (p. ej. el saque del medio) no es un tiro
    const len = Math.hypot(ex, ey) || 1;
    const margin = ball.r / len;
    if (s >= -margin && s <= 1 + margin) return 'arco';
    if (s >= -0.75 && s <= 1.75) best = 'afuera';
  }
  return best;
}

/** ¿Hay un rival pegado a la pelota? (entonces es un forcejeo, no un tiro) */
function contested(m, p, ball) {
  return m.players.some((o) => o.disc && o.team !== p.team && o.team !== 'spectator'
    && Math.hypot(o.disc.x - ball.x, o.disc.y - ball.y) <= o.disc.r + ball.r + 3);
}

function maybeShot(S, m, p, ball) {
  if (S.shotTick === S.tick || contested(m, p, ball)) return;
  const target = shotTarget(m, ball, p.team);
  if (!target) return;
  S.shotTick = S.tick;
  const r = rowFor(S, p);
  r.sh += 1;
  if (target === 'arco') r.sot += 1;
  S.shot = { by: p.id, team: p.team, tick: S.tick, onTarget: target === 'arco' };
  flushShot(S);
  S.narr = { by: p.id, onTarget: target === 'arco', tick: S.tick };
  S.version += 1;
}

function onTouch(S, m, p, ball) {
  const r = rowFor(S, p);
  r.tch += 1;
  const prev = S.last;
  if (prev && prev.id !== p.id) {
    const prevRow = S.rows.get(prev.id);
    if (prev.team === p.team) {
      if (Math.hypot(ball.x - prev.x, ball.y - prev.y) >= PASS_MIN_DIST) {
        if (prevRow) prevRow.pc += 1;
        S.pass = { from: prev.id, to: p.id, tick: S.tick };
      }
    } else {
      const shot = S.shot;
      if (shot && shot.team === prev.team && shot.onTarget && S.tick - shot.tick <= SHOT_TTL && S.tick - shot.tick >= SAVE_MIN_TICKS) {
        r.sv += 1; // ¡atajada!
        S.narr = null;
        S.feed.push({ type: 'save', by: p.id, shooter: shot.by });
      }
      else {
        r.int += 1;
        if (prevRow) prevRow.pl += 1;
      }
      S.pass = null;
    }
  }
  S.shot = null;
  S.last = { id: p.id, team: p.team, x: ball.x, y: ball.y, tick: S.tick };
  S.version += 1;
  maybeShot(S, m, p, ball); // un toque fuerte (sin patear) también puede ser un tiro
}

/** Llamar después de cada tick del partido, con los eventos que devolvió. */
export function updateStats(S, m, events) {
  S.tick += 1;
  const ball = ballOf(m);
  const byId = (id) => m.players.find((p) => p.id === id && p.team !== 'spectator') || null;
  for (const ev of events) {
    if (ev.type === 'kickoff') {
      S.last = null;
      S.pass = null;
      S.shot = null;
    }
  }
  if (ball && (m.phase === 'playing' || m.phase === 'kickoff')) {
    const cur = m.lastTouch ? byId(m.lastTouch) : null;
    if (cur && cur.id !== S.last?.id) {
      const kicked = events.some((ev) => ev.type === 'kick' && ev.playerId === cur.id);
      const blocksShot = S.shot && S.shot.onTarget && S.shot.team !== cur.team && S.tick - S.shot.tick >= SAVE_MIN_TICKS; // una atajada vale con un roce
      if (S.cand?.id !== cur.id) S.cand = { id: cur.id, since: S.tick };
      if (kicked || blocksShot || S.tick - S.cand.since >= HOLD_TICKS) {
        S.cand = null;
        onTouch(S, m, cur, ball);
      }
    } else S.cand = null;
    for (const ev of events) {
      if (ev.type !== 'kick') continue;
      const p = byId(ev.playerId);
      if (p && p.id === S.last?.id) maybeShot(S, m, p, ball);
    }
    if (S.last) S.poss[S.last.team] = (S.poss[S.last.team] || 0) + 1;
    if (S.shot && S.tick - S.shot.tick > SHOT_TTL) S.shot = null;
  }
  if (S.narr && S.tick - S.narr.tick >= NARR_WAIT && !events.some((ev) => ev.type === 'goal')) flushShot(S);
  for (const ev of events) {
    if (ev.type !== 'goal') continue;
    const scorer = m.players.find((p) => p.id === ev.scorerId);
    if (scorer) {
      const r = rowFor(S, scorer);
      S.narr = null;
      if (ev.ownGoal) {
        r.og += 1;
        S.feed.push({ type: 'goal', by: scorer.id, ownGoal: true });
      } else {
        r.g += 1;
        if (!(S.shot && S.shot.by === scorer.id)) { // gol sin tiro detectado (p. ej. empujándola): igual es un tiro al arco
          r.sh += 1;
          r.sot += 1;
        }
        const pass = S.pass;
        let assist = null;
        if (pass && pass.to === scorer.id && S.tick - pass.tick <= ASSIST_TTL) {
          const ar = S.rows.get(pass.from);
          if (ar) {
            ar.a += 1;
            assist = pass.from;
          }
        }
        S.feed.push({ type: 'goal', by: scorer.id, assist });
      }
    }
    S.last = null;
    S.pass = null;
    S.shot = null;
    S.version += 1;
  }
}

/** Nota de 1 a 10. Con `final`, suma lo que depende del resultado (ganar, valla invicta). */
export function ratingOf(r, m, final) {
  let x = RATING.base + RATING.goal * r.g + RATING.assist * r.a + RATING.save * r.sv + RATING.interception * r.int
    + RATING.onTarget * r.sot + RATING.pass * r.pc + RATING.lost * r.pl + RATING.ownGoal * r.og;
  if (final && (r.team === 'red' || r.team === 'blue')) {
    if (m.winner === r.team) x += RATING.win;
    const conceded = r.team === 'red' ? m.score.blue : m.score.red;
    if (conceded === 0) x += RATING.cleanSheet;
  }
  return Math.round(Math.min(10, Math.max(1, x)) * 10) / 10;
}

/** Resumen para mostrar (y para guardar en el torneo). */
export function statsSummary(S, m, { final = false } = {}) {
  // Todos los que juegan aparecen, aunque todavía no la hayan tocado.
  for (const p of m.players) if (p.team === 'red' || p.team === 'blue') rowFor(S, p);
  const rows = [...S.rows.values()].filter((r) => r.team === 'red' || r.team === 'blue').map((r) => ({ ...r, rating: ratingOf(r, m, final) }));
  rows.sort((a, b) => b.rating - a.rating || b.g - a.g || b.a - a.a || b.sv - a.sv || a.name.localeCompare(b.name));
  const total = (S.poss.red || 0) + (S.poss.blue || 0);
  const red = total ? Math.round(((S.poss.red || 0) / total) * 100) : 50;
  return {
    final, rows, mvp: final && rows.length ? rows[0].id : null,
    possession: { red, blue: 100 - red }, score: { red: m.score.red, blue: m.score.blue },
  };
}
