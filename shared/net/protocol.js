// Protocolo de red de HaxBort.
//
// Mensajes de texto (JSON) para todo lo de la sala (chat, equipos, admin, mapa) y dos
// mensajes binarios para lo que viaja muchas veces por segundo:
//   · entrada del cliente:  [u8 1][u32 seq][u8 bits][u8 bits-1][u8 bits-2]  (8 bytes, 60 por segundo)
//   · foto del partido:     [u8 2][u32 ack][u32 largoMeta][meta JSON][relleno][f64 x,y,vx,vy por disco]
// "ack" es la última entrada de ese jugador que el servidor ya aplicó: el cliente vuelve
// a simular desde la foto con las entradas posteriores (predicción + reconciliación).

import { applyKickoffMasks, makePlayerDisc } from '../game/match.js';

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;
const TEAM_CODE = { spectator: 0, red: 1, blue: 2 };
const TEAM_NAME = ['spectator', 'red', 'blue'];

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Entrada del tick actual + las dos anteriores (por si se perdió un paquete en un canal rápido). */
export function encodeInput(seq, bits, prev1 = 0, prev2 = 0) {
  const b = new ArrayBuffer(8);
  const v = new DataView(b);
  v.setUint8(0, MSG_INPUT);
  v.setUint32(1, seq >>> 0);
  v.setUint8(5, bits & 31);
  v.setUint8(6, prev1 & 31);
  v.setUint8(7, prev2 & 31);
  return b;
}

/** Devuelve las entradas de menor a mayor seq: [{ seq, bits }, ...] o null si no es una entrada. */
export function decodeInput(buf) {
  const v = toView(buf);
  if (v.byteLength !== 8 || v.getUint8(0) !== MSG_INPUT) return null;
  const seq = v.getUint32(1);
  const out = [];
  if (seq > 2) out.push({ seq: seq - 2, bits: v.getUint8(7) & 31 });
  if (seq > 1) out.push({ seq: seq - 1, bits: v.getUint8(6) & 31 });
  out.push({ seq, bits: v.getUint8(5) & 31 });
  return out;
}

function toView(buf) {
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Cuerpo de la foto (igual para todos los jugadores). Después se le agrega el ack de cada uno. */
export function snapshotBody(m, { paused = false } = {}) {
  const discs = m.world.discs;
  const index = new Map(discs.map((d, i) => [d, i]));
  const meta = {
    k: m.tick, ph: m.phase, ko: m.kickoffTeam, sc: [m.score.red, m.score.blue], t: m.ticks, ot: m.overtime ? 1 : 0,
    pt: m.phaseTimer, lg: m.lastGoal, w: m.winner, lt: m.lastTouch, pa: paused ? 1 : 0,
    st: [m.settings.timeLimit, m.settings.scoreLimit, m.settings.kickCooldown, m.settings.allowDraw ? 1 : 0],
    p: m.players.map((p) => [p.id, TEAM_CODE[p.team] ?? 0, p.input, (p.kickHeld ? 1 : 0) | (p.kicking ? 2 : 0), p.cooldown, p.goals,
      p.disc ? index.get(p.disc) ?? -1 : -1]),
    n: discs.length,
  };
  const metaBytes = enc.encode(JSON.stringify(meta));
  const head = 9 + metaBytes.length;
  const pad = (8 - (head % 8)) % 8;
  const total = head + pad + discs.length * 32;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint32(5, metaBytes.length);
  out.set(metaBytes, 9);
  const f = new Float64Array(out.buffer, head + pad, discs.length * 4);
  discs.forEach((d, i) => {
    f[i * 4] = d.x;
    f[i * 4 + 1] = d.y;
    f[i * 4 + 2] = d.vx;
    f[i * 4 + 3] = d.vy;
  });
  return out;
}

/** Copia del cuerpo con el ack de un jugador. */
export function withAck(body, ack) {
  const out = new Uint8Array(body.length);
  out.set(body);
  new DataView(out.buffer).setUint32(1, ack >>> 0);
  return out.buffer;
}

export function decodeSnapshot(buf) {
  const v = toView(buf);
  if (v.byteLength < 9 || v.getUint8(0) !== MSG_SNAPSHOT) return null;
  const ack = v.getUint32(1);
  const len = v.getUint32(5);
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const meta = JSON.parse(dec.decode(bytes.subarray(9, 9 + len)));
  const head = 9 + len;
  const pad = (8 - (head % 8)) % 8;
  // Copia alineada (el buffer recibido puede no estar alineado a 8).
  const raw = bytes.slice(head + pad, head + pad + meta.n * 32);
  const discs = new Float64Array(raw.buffer, 0, meta.n * 4);
  return { ack, meta, discs };
}

/**
 * Pisa el estado de un partido local con la foto del servidor. El partido local tiene que
 * haberse creado con el mismo estadio. names: Map id → { name, avatar } para jugadores nuevos.
 */
export function applySnapshot(m, snap, names = new Map()) {
  const { meta, discs } = snap;
  m.tick = meta.k;
  m.phase = meta.ph;
  m.kickoffTeam = meta.ko;
  m.score = { red: meta.sc[0], blue: meta.sc[1] };
  m.ticks = meta.t;
  m.overtime = Boolean(meta.ot);
  m.phaseTimer = meta.pt;
  m.lastGoal = meta.lg;
  m.winner = meta.w;
  m.lastTouch = meta.lt;
  m.settings = { timeLimit: meta.st[0], scoreLimit: meta.st[1], kickCooldown: meta.st[2], allowDraw: Boolean(meta.st[3]) };

  const old = new Map(m.players.map((p) => [p.id, p]));
  const base = m.world.discs.slice(0, m.mapDiscCount);
  const list = new Array(meta.n);
  for (let i = 0; i < m.mapDiscCount && i < meta.n; i += 1) list[i] = base[i];
  m.players = meta.p.map(([id, tc, input, flags, cooldown, goals, di]) => {
    const info = names.get(id);
    const p = old.get(id) || { id, name: '', avatar: '', input: 0, kickHeld: false, kicking: false, cooldown: 0, disc: null, goals: 0, assists: 0 };
    if (info) {
      p.name = info.name;
      p.avatar = info.avatar;
    }
    p.team = TEAM_NAME[tc] || 'spectator';
    p.input = input;
    p.kickHeld = Boolean(flags & 1);
    p.kicking = Boolean(flags & 2);
    p.cooldown = cooldown;
    p.goals = goals;
    if (di >= m.mapDiscCount && di < meta.n && p.team !== 'spectator') {
      if (!p.disc || p.disc.team !== p.team) p.disc = makePlayerDisc(m, p.team, p.id);
      list[di] = p.disc;
    } else p.disc = null;
    return p;
  });
  const pp = m.stadium.playerPhysics;
  for (let i = 0; i < meta.n; i += 1) {
    const d = list[i];
    if (!d) continue; // no debería pasar; se descarta abajo
    d.x = discs[i * 4];
    d.y = discs[i * 4 + 1];
    d.vx = discs[i * 4 + 2];
    d.vy = discs[i * 4 + 3];
  }
  m.world.discs = list.filter(Boolean);
  for (const p of m.players) if (p.disc) p.disc.damping = p.kicking ? pp.kickingDamping : pp.damping;
  applyKickoffMasks(m);
  return { paused: Boolean(meta.pa), ack: snap.ack };
}
