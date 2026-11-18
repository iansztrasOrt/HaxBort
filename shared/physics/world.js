// Motor de física 2D de discos. Isomórfico (Node y navegador), sin DOM ni red.
// Paso fijo de 60 Hz. Mismo orden de operaciones en todos lados → determinista.
//
// Orden de un paso (como el juego original):
//   1) posición += velocidad;  velocidad = (velocidad + gravedad) × damping
//   2) colisiones: disco-disco, y para discos con masa: planos, segmentos, vértices
//   3) uniones (2 iteraciones)
// Extra: si un disco va más rápido que ~75% de su radio por tick, el paso se
// divide en sub-pasos para que no atraviese paredes finas ni postes.

export const MAX_SUBSTEPS = 8;

export function createWorld(stadium) {
  const vertexes = stadium.vertexes.map((v) => ({ ...v }));
  const segments = stadium.segments.map((s) => prepareSegment(s, vertexes));
  const planes = stadium.planes.map((p) => ({ nx: p.normal[0], ny: p.normal[1], dist: p.dist, bCoef: p.bCoef, cMask: p.cMask, cGroup: p.cGroup }));
  const discs = stadium.discs.map((d, i) => makeDisc(d, i === 0 && stadium.ballMode !== 'disc0' ? 'ball' : 'map'));
  if (stadium.ballMode === 'disc0' && discs[0]) discs[0].kind = 'ball';
  const joints = stadium.joints.map((j) => {
    const a = discs[j.d0];
    const b = discs[j.d1];
    let min;
    let max;
    if (j.length === null || j.length === undefined) {
      const d = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
      min = d;
      max = d;
    } else if (Array.isArray(j.length)) {
      [min, max] = j.length;
    } else {
      min = j.length;
      max = j.length;
    }
    return { d0: j.d0, d1: j.d1, min, max, strength: j.strength === 'rigid' ? Infinity : j.strength, color: j.color };
  });
  return { discs, vertexes, segments, planes, joints };
}

export function makeDisc(d, kind = 'map') {
  return {
    x: d.pos[0], y: d.pos[1], vx: d.speed[0], vy: d.speed[1], gx: d.gravity[0], gy: d.gravity[1],
    r: d.radius, invMass: d.invMass, damping: d.damping, bCoef: d.bCoef,
    cMask: d.cMask, cGroup: d.cGroup, color: d.color, kind,
  };
}

/** Precalcula la geometría de un segmento (recto o arco). */
export function prepareSegment(s, vertexes) {
  const a = vertexes[s.v0];
  const b = vertexes[s.v1];
  const seg = {
    ax: a.x, ay: a.y, bx: b.x, by: b.y, bias: s.bias, bCoef: s.bCoef, cMask: s.cMask, cGroup: s.cGroup,
    vis: s.vis, color: s.color, curveF: s.curveF, straight: true,
  };
  if (s.curveF !== null && s.curveF !== undefined && Number.isFinite(s.curveF)) {
    const cf = s.curveF;
    const hx = 0.5 * (b.x - a.x);
    const hy = 0.5 * (b.y - a.y);
    const cx = a.x + hx - hy * cf;
    const cy = a.y + hy + hx * cf;
    seg.straight = false;
    seg.cx = cx;
    seg.cy = cy;
    seg.R = Math.hypot(a.x - cx, a.y - cy);
    // Tangentes en los extremos: definen qué parte del círculo es el arco.
    let t0x = cy - a.y;
    let t0y = a.x - cx;
    let t1x = b.y - cy;
    let t1y = cx - b.x;
    if (cf <= 0) {
      t0x = -t0x; t0y = -t0y; t1x = -t1x; t1y = -t1y;
    }
    Object.assign(seg, { t0x, t0y, t1x, t1y });
  } else {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const len = Math.hypot(dx, dy);
    seg.len = len;
    seg.nx = len ? -dy / len : 0;
    seg.ny = len ? dx / len : 0;
  }
  return seg;
}

/** ¿El punto (relativo al centro) cae dentro del arco? (mismo criterio que la colisión) */
export function insideArc(seg, dx, dy) {
  const both = seg.t0x * dx + seg.t0y * dy > 0 && seg.t1x * dx + seg.t1y * dy > 0;
  return both !== seg.curveF <= 0;
}

const canCollide = (a, b) => (a.cGroup & b.cMask) !== 0 && (b.cGroup & a.cMask) !== 0;

// ---------------------------------------------------------------- colisiones

export function collideDiscs(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const d2 = dx * dx + dy * dy;
  const rs = a.r + b.r;
  if (!(d2 > 0 && d2 <= rs * rs)) return false;
  const total = a.invMass + b.invMass;
  if (total === 0) return false;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const fa = a.invMass / total;
  const overlap = rs - d;
  const pa = overlap * fa;
  a.x += nx * pa;
  a.y += ny * pa;
  const pb = overlap - pa;
  b.x -= nx * pb;
  b.y -= ny * pb;
  let rv = nx * (a.vx - b.vx) + ny * (a.vy - b.vy);
  if (rv < 0) {
    rv *= a.bCoef * b.bCoef + 1;
    const ia = rv * fa;
    a.vx -= nx * ia;
    a.vy -= ny * ia;
    const ib = rv - ia;
    b.vx += nx * ib;
    b.vy += ny * ib;
  }
  return true;
}

export function collidePlane(d, p) {
  const pen = p.dist - (p.nx * d.x + p.ny * d.y) + d.r;
  if (!(pen > 0)) return false;
  d.x += p.nx * pen;
  d.y += p.ny * pen;
  let vn = d.vx * p.nx + d.vy * p.ny;
  if (vn < 0) {
    vn *= d.bCoef * p.bCoef + 1;
    d.vx -= vn * p.nx;
    d.vy -= vn * p.ny;
  }
  return true;
}

export function collideSegment(d, s) {
  let dist;
  let nx;
  let ny;
  if (!s.straight) {
    const dx = d.x - s.cx;
    const dy = d.y - s.cy;
    if (!insideArc(s, dx, dy)) return false;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return false;
    dist = len - s.R;
    nx = dx / len;
    ny = dy / len;
  } else {
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const px = d.x - s.bx;
    const py = d.y - s.by;
    if ((d.x - s.ax) * ex + (d.y - s.ay) * ey <= 0 || px * ex + py * ey >= 0) return false;
    nx = s.nx;
    ny = s.ny;
    dist = nx * px + ny * py;
  }
  let bias = s.bias;
  if (bias === 0) {
    if (dist < 0) {
      dist = -dist;
      nx = -nx;
      ny = -ny;
    }
  } else {
    if (bias < 0) {
      bias = -bias;
      dist = -dist;
      nx = -nx;
      ny = -ny;
    }
    if (dist < -bias) return false;
  }
  if (dist >= d.r) return false;
  const pen = d.r - dist;
  d.x += nx * pen;
  d.y += ny * pen;
  let vn = nx * d.vx + ny * d.vy;
  if (vn < 0) {
    vn *= d.bCoef * s.bCoef + 1;
    d.vx -= nx * vn;
    d.vy -= ny * vn;
  }
  return true;
}

export function collideVertex(d, v) {
  let dx = d.x - v.x;
  let dy = d.y - v.y;
  const d2 = dx * dx + dy * dy;
  if (!(d2 > 0 && d2 <= d.r * d.r)) return false;
  const dist = Math.sqrt(d2);
  dx /= dist;
  dy /= dist;
  const pen = d.r - dist;
  d.x += dx * pen;
  d.y += dy * pen;
  let vn = dx * d.vx + dy * d.vy;
  if (vn < 0) {
    vn *= d.bCoef * v.bCoef + 1;
    d.vx -= dx * vn;
    d.vy -= dy * vn;
  }
  return true;
}

export function solveJoint(j, discs) {
  const a = discs[j.d0];
  const b = discs[j.d1];
  if (!a || !b) return;
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (!(dist > 0)) return;
  dx /= dist;
  dy /= dist;
  let ratio = a.invMass / (a.invMass + b.invMass);
  if (ratio !== ratio) ratio = 0.5; // NaN (ambos inmóviles)
  let target;
  let dir;
  if (j.min >= j.max) {
    target = j.min;
    dir = 0;
  } else if (dist <= j.min) {
    target = j.min;
    dir = 1;
  } else if (dist >= j.max) {
    target = j.max;
    dir = -1;
  } else return;
  const diff = target - dist;
  if (Number.isFinite(j.strength)) {
    const f = j.strength * diff * 0.5;
    a.vx += dx * f * a.invMass;
    a.vy += dy * f * a.invMass;
    b.vx -= dx * f * b.invMass;
    b.vy -= dy * f * b.invMass;
  } else {
    const ma = diff * ratio;
    a.x += dx * ma * 0.5;
    a.y += dy * ma * 0.5;
    const mb = diff - ma;
    b.x -= dx * mb * 0.5;
    b.y -= dy * mb * 0.5;
    const rv = dx * (a.vx - b.vx) + dy * (a.vy - b.vy);
    if (dir * rv <= 0) {
      const ia = ratio * rv;
      a.vx -= dx * ia;
      a.vy -= dy * ia;
      const ib = rv - ia;
      b.vx += dx * ib;
      b.vy += dy * ib;
    }
  }
}

function collideAll(world) {
  const { discs, planes, segments, vertexes } = world;
  const n = discs.length;
  for (let i = 0; i < n; i += 1) {
    const a = discs[i];
    for (let j = i + 1; j < n; j += 1) {
      const b = discs[j];
      if (canCollide(a, b)) collideDiscs(a, b);
    }
    if (a.invMass === 0) continue;
    for (const p of planes) if (canCollide(a, p)) collidePlane(a, p);
    for (const s of segments) if (canCollide(a, s)) collideSegment(a, s);
    for (const v of vertexes) if (canCollide(a, v)) collideVertex(a, v);
  }
}

/** Cantidad de sub-pasos necesarios para que nada atraviese paredes finas. */
export function substepsFor(world) {
  let n = 1;
  for (const d of world.discs) {
    if (d.invMass === 0) continue;
    const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    const safe = Math.max(0.5, d.r * 0.75);
    if (speed > safe) n = Math.max(n, Math.ceil(speed / safe));
  }
  return Math.min(MAX_SUBSTEPS, n);
}

/** Avanza el mundo un tick (1/60 s). */
export function step(world) {
  const n = substepsFor(world);
  const { discs } = world;
  for (let s = 0; s < n; s += 1) {
    const f = 1 / n;
    for (const d of discs) {
      const vx = d.vx;
      const vy = d.vy;
      d.x += vx * f;
      d.y += vy * f;
      if (s === 0) {
        d.vx = d.damping * (vx + d.gx);
        d.vy = d.damping * (vy + d.gy);
      }
    }
    collideAll(world);
  }
  for (let k = 0; k < 2; k += 1) for (const j of world.joints) solveJoint(j, discs);
}

/** Copia profunda y barata del estado dinámico (para predicción / repetición). */
export function snapshotDiscs(world) {
  return world.discs.map((d) => [d.x, d.y, d.vx, d.vy]);
}
