// Torneos (liga y copa): toda la lógica, sin red ni base de datos.
// El servidor guarda un documento por torneo y lo cambia SOLO con applyAction(), que valida
// quién pide qué. Así la misma lógica se prueba con tests y corre igual en el servidor.

import { cleanKit, DEFAULT_KITS } from '../game/kits.js';

export const LIMITS = { name: 40, teamName: 24, playerName: 20, maxTeams: 32, maxTeamSize: 8, maxSolos: 128, maxVueltas: 4 };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const clean = (v, max) => (typeof v === 'string' ? Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('') : '');
const int = (v, min, max, def) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

export class TorneoError extends Error {}
const fail = (msg) => {
  throw new TorneoError(msg);
};

export const DEFAULT_FORMAT = Object.freeze({
  type: 'liga', // 'liga' | 'copa'
  teamSize: 3, // jugadores por equipo
  maxTeams: 8,
  vueltas: 1, // liga: 1 = todos contra todos una vez; 2 = ida y vuelta; ...
  idaVuelta: false, // copa: cada llave a dos partidos (si empatan en el global, desempate a gol de oro)
  inscripcion: { equipos: true, solos: true, unirse: true },
  rules: { time: 3, score: 3, ballRadius: null, map: 'clasica' },
});

/** Formato válido a partir de lo que mande el creador (lo que falte o no sirva, queda como estaba). */
export function cleanFormat(f, base = DEFAULT_FORMAT) {
  const src = f && typeof f === 'object' ? f : {};
  const ins = src.inscripcion && typeof src.inscripcion === 'object' ? src.inscripcion : {};
  const rules = src.rules && typeof src.rules === 'object' ? src.rules : {};
  const out = {
    type: src.type === 'copa' || src.type === 'liga' ? src.type : base.type,
    teamSize: int(src.teamSize, 1, LIMITS.maxTeamSize, base.teamSize),
    maxTeams: int(src.maxTeams, 2, LIMITS.maxTeams, base.maxTeams),
    vueltas: int(src.vueltas, 1, LIMITS.maxVueltas, base.vueltas),
    idaVuelta: typeof src.idaVuelta === 'boolean' ? src.idaVuelta : base.idaVuelta,
    inscripcion: {
      equipos: typeof ins.equipos === 'boolean' ? ins.equipos : base.inscripcion.equipos,
      solos: typeof ins.solos === 'boolean' ? ins.solos : base.inscripcion.solos,
      unirse: typeof ins.unirse === 'boolean' ? ins.unirse : base.inscripcion.unirse,
    },
    rules: {
      time: Number.isFinite(Number(rules.time)) && Number(rules.time) >= 0 && Number(rules.time) <= 60 ? Math.round(Number(rules.time) * 2) / 2 : base.rules.time,
      score: int(rules.score, 0, 99, base.rules.score),
      ballRadius: rules.ballRadius === null ? null : int(rules.ballRadius, 3, 10, base.rules.ballRadius),
      map: typeof rules.map === 'string' && /^[a-z0-9-]{1,40}$/.test(rules.map) ? rules.map : base.rules.map,
    },
  };
  if (!out.inscripcion.equipos && !out.inscripcion.solos) fail('Tiene que haber al menos una forma de inscribirse: como equipo o solo.');
  if (out.rules.time === 0 && out.rules.score === 0) fail('Tiene que haber un límite de tiempo o de goles (si no, un partido no termina nunca).');
  return out;
}

export function newCode(rng = Math.random, len = 6) {
  let c = '';
  for (let i = 0; i < len; i += 1) c += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return c;
}

/** Torneo nuevo, en inscripción. `owner`: identificador público del creador. */
export function createTorneo({ code, name, owner, ownerName, format, now = Date.now() }) {
  const n = clean(name, LIMITS.name);
  if (!n) fail('Ponele un nombre al torneo.');
  return {
    v: 1, code, name: n, owner, createdAt: now, updatedAt: now,
    status: 'inscripcion', // 'inscripcion' | 'en_curso' | 'terminado'
    format: cleanFormat(format),
    players: { [owner]: { name: clean(ownerName, LIMITS.playerName) || 'Admin' } },
    teams: [],
    solos: [], // agentes libres: [{ pid, at }]
    rounds: [], // fechas (liga) o rondas (copa)
    champion: null,
    seq: 0,
    log: [],
  };
}

// ---------------------------------------------------------------- consultas
export const isAdmin = (t, pid) => pid === t.owner;
export const teamOf = (t, pid) => t.teams.find((x) => x.members.includes(pid)) || null;
export const teamById = (t, id) => t.teams.find((x) => x.id === id) || null;
const isSolo = (t, pid) => t.solos.some((s) => s.pid === pid);
const nextId = (t, prefix) => `${prefix}${(t.seq = (t.seq || 0) + 1)}`;
const approved = (t) => t.teams.filter((x) => x.status === 'aprobado');
const log = (t, text, now) => {
  t.log.push({ at: now, text });
  if (t.log.length > 60) t.log.splice(0, t.log.length - 60);
};
function uniqueTeamCode(t, rng) {
  for (let i = 0; i < 100; i += 1) {
    const c = newCode(rng, 5);
    if (!t.teams.some((x) => x.joinCode === c)) return c;
  }
  return newCode(rng, 7);
}

function assertNotPlaying(t, pid) {
  if (teamOf(t, pid)) fail('Ya estás en un equipo de este torneo.');
  if (isSolo(t, pid)) fail('Ya estás anotado solo: salí de la lista para entrar a un equipo.');
}
function assertInscripcion(t) {
  if (t.status !== 'inscripcion') fail('La inscripción ya cerró: el torneo empezó.');
}
const teamFull = (t, team) => team.members.length >= t.format.teamSize;

// ---------------------------------------------------------------- fixture
/** Todos contra todos por el método del círculo. Devuelve fechas [[ [local, visitante], ... ], ...]. */
export function roundRobin(ids) {
  const list = [...ids];
  if (list.length % 2) list.push(null); // libre
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r += 1) {
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop()); // rota todos menos el primero
  }
  return rounds;
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const newMatch = (t, home, away, extra = {}) => ({ id: nextId(t, 'p'), home, away, gh: null, ga: null, status: 'pendiente', ready: [], ...extra });

function buildLiga(t, ids) {
  const base = roundRobin(ids);
  const rounds = [];
  for (let v = 0; v < t.format.vueltas; v += 1) {
    for (const pairs of base) {
      const n = rounds.length + 1;
      rounds.push({ n, name: `Fecha ${n}`, matches: pairs.map(([h, a]) => (v % 2 ? newMatch(t, a, h) : newMatch(t, h, a))) });
    }
  }
  return rounds;
}

export function cupRoundName(teamsLeft) {
  if (teamsLeft <= 2) return 'Final';
  if (teamsLeft <= 4) return 'Semifinal';
  if (teamsLeft <= 8) return 'Cuartos de final';
  if (teamsLeft <= 16) return 'Octavos de final';
  return 'Dieciseisavos de final';
}

/** Una ronda de copa a partir de cruces [a, b] (b null = pasa directo). */
function cupRound(t, n, pairs, teamsLeft) {
  const round = { n, name: cupRoundName(teamsLeft), matches: [], ties: [] };
  for (const [a, b] of pairs) {
    const tie = { id: nextId(t, 'l'), a, b, matches: [], winner: b ? null : a };
    if (b) {
      const m1 = newMatch(t, a, b, { tie: tie.id, leg: 1 });
      round.matches.push(m1);
      tie.matches.push(m1.id);
      if (t.format.idaVuelta) {
        const m2 = newMatch(t, b, a, { tie: tie.id, leg: 2 });
        round.matches.push(m2);
        tie.matches.push(m2.id);
      }
    }
    round.ties.push(tie);
  }
  return round;
}

function buildCopa(t, ids, rng) {
  const order = shuffle(ids, rng); // sorteo
  let size = 1;
  while (size < order.length) size *= 2;
  const byes = size - order.length;
  // Los primeros `byes` sorteados pasan directo a la segunda ronda.
  const pairs = [];
  for (let i = 0; i < byes; i += 1) pairs.push([order[i], null]);
  const rest = order.slice(byes);
  for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
  // Se intercalan los que pasan directo para que no se crucen entre ellos en la ronda siguiente.
  const withBye = pairs.filter((p) => !p[1]);
  const played = pairs.filter((p) => p[1]);
  const mixed = [];
  while (withBye.length || played.length) {
    if (played.length) mixed.push(played.shift());
    if (withBye.length) mixed.push(withBye.shift());
  }
  return [cupRound(t, 1, mixed, size)];
}

function buildFixture(t, rng) {
  const ids = approved(t).map((x) => x.id);
  t.rounds = t.format.type === 'liga' ? buildLiga(t, ids) : buildCopa(t, ids, rng);
  t.champion = null;
  t.status = 'en_curso';
  advance(t);
}

// ---------------------------------------------------------------- avance
export const allMatches = (t) => t.rounds.flatMap((r) => r.matches);
const matchById = (t, id) => allMatches(t).find((m) => m.id === id) || null;
const roundDone = (r) => r.matches.every((m) => m.status !== 'pendiente') && (!r.ties || r.ties.every((x) => x.winner));

/** Índice de la fecha/ronda que se está jugando (la primera sin terminar), o -1 si no hay. */
export function currentRoundIndex(t) {
  return t.rounds.findIndex((r) => !roundDone(r));
}

/** ¿Se puede jugar este partido ahora? Solo los de la fecha/ronda actual. */
export function playable(t, match) {
  if (t.status !== 'en_curso' || match.status !== 'pendiente') return false;
  const i = currentRoundIndex(t);
  return i >= 0 && t.rounds[i].matches.includes(match);
}

function decideTie(t, round, tie) {
  if (tie.winner || !tie.b) return;
  const ms = tie.matches.map((id) => round.matches.find((m) => m.id === id));
  if (ms.some((m) => m.status === 'pendiente')) return;
  let ga = 0;
  let gb = 0;
  for (const m of ms) {
    if (m.home === tie.a) {
      ga += m.gh;
      gb += m.ga;
    } else {
      ga += m.ga;
      gb += m.gh;
    }
  }
  if (ga !== gb) {
    tie.winner = ga > gb ? tie.a : tie.b;
    return;
  }
  // Empate en el global (o en un partido único cargado a mano): desempate a gol de oro.
  const d = newMatch(t, tie.a, tie.b, { tie: tie.id, leg: ms.length + 1, desempate: true });
  round.matches.push(d);
  tie.matches.push(d.id);
}

/** Después de cada resultado: define llaves, arma la ronda siguiente o termina el torneo. */
function advance(t) {
  if (t.status !== 'en_curso') return;
  if (t.format.type === 'copa') {
    for (;;) {
      const round = t.rounds[t.rounds.length - 1];
      for (const tie of round.ties) decideTie(t, round, tie);
      if (!roundDone(round)) return;
      const winners = round.ties.map((x) => x.winner);
      if (winners.length === 1) {
        t.champion = winners[0];
        t.status = 'terminado';
        return;
      }
      const pairs = [];
      for (let i = 0; i < winners.length; i += 2) pairs.push([winners[i], winners[i + 1] ?? null]);
      t.rounds.push(cupRound(t, round.n + 1, pairs, winners.length));
    }
  }
  if (currentRoundIndex(t) === -1) {
    t.status = 'terminado';
    t.champion = standings(t)[0]?.team ?? null;
  }
}

/** Tabla de la liga: puntos, diferencia de gol, goles a favor. */
export function standings(t) {
  const rows = new Map(approved(t).map((x) => [x.id, { team: x.id, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0 }]));
  for (const m of allMatches(t)) {
    if (m.status === 'pendiente' || m.gh === null) continue;
    const h = rows.get(m.home);
    const a = rows.get(m.away);
    if (!h || !a) continue;
    h.pj += 1;
    a.pj += 1;
    h.gf += m.gh;
    h.gc += m.ga;
    a.gf += m.ga;
    a.gc += m.gh;
    if (m.gh > m.ga) {
      h.pg += 1;
      a.pp += 1;
      h.pts += 3;
    } else if (m.gh < m.ga) {
      a.pg += 1;
      h.pp += 1;
      a.pts += 3;
    } else {
      h.pe += 1;
      a.pe += 1;
      h.pts += 1;
      a.pts += 1;
    }
  }
  const out = [...rows.values()];
  for (const r of out) r.dg = r.gf - r.gc;
  const name = (id) => teamById(t, id)?.name || '';
  return out.sort((x, y) => y.pts - x.pts || y.dg - x.dg || y.gf - x.gf || name(x.team).localeCompare(name(y.team)));
}

// ---------------------------------------------------------------- acciones
/**
 * Aplica una acción de un jugador al torneo (lo modifica). Tira TorneoError con un mensaje
 * para mostrar si no se puede. `actor`: { pid, name }.
 */
export function applyAction(t, actor, action, { now = Date.now(), rng = Math.random } = {}) {
  const pid = actor?.pid;
  if (!pid) fail('Falta tu identificación.');
  const a = action && typeof action === 'object' ? action : {};
  const admin = isAdmin(t, pid);
  const needAdmin = () => {
    if (!admin) fail('Eso lo puede hacer solo el admin del torneo.');
  };
  const pname = clean(actor.name, LIMITS.playerName);
  if (pname) t.players[pid] = { name: pname };
  else if (!t.players[pid]) t.players[pid] = { name: 'Jugador' };
  const who = t.players[pid].name;
  const getTeam = (id) => teamById(t, String(id || '')) || fail('No existe ese equipo.');
  const captainOrAdmin = (team) => {
    if (team.captain !== pid && !admin) fail('Eso lo puede hacer el capitán del equipo o el admin.');
  };

  switch (a.t) {
    // ---- inscripción
    case 'crear_equipo': {
      assertInscripcion(t);
      if (!t.format.inscripcion.equipos) fail('En este torneo no se pueden anotar equipos armados.');
      assertNotPlaying(t, pid);
      if (t.teams.length >= LIMITS.maxTeams) fail('No entran más equipos.');
      const name = clean(a.name, LIMITS.teamName);
      if (!name) fail('Ponele un nombre al equipo.');
      if (t.teams.some((x) => x.name.toLowerCase() === name.toLowerCase())) fail('Ya hay un equipo con ese nombre.');
      const color = t.teams.length % 2 ? 'blue' : 'red';
      const team = {
        id: nextId(t, 'e'), name, captain: pid, members: [pid], requests: [], status: 'pendiente',
        open: a.open !== false, joinCode: uniqueTeamCode(t, rng), kit: cleanKit(a.kit, DEFAULT_KITS[color]) || { ...DEFAULT_KITS[color] },
      };
      t.teams.push(team);
      log(t, `${who} anotó al equipo ${name} (falta que el admin lo apruebe).`, now);
      return { team: team.id };
    }
    case 'anotarse_solo': {
      assertInscripcion(t);
      if (!t.format.inscripcion.solos) fail('En este torneo no se puede anotar solo.');
      assertNotPlaying(t, pid);
      if (t.solos.length >= LIMITS.maxSolos) fail('No entran más jugadores sueltos.');
      t.solos.push({ pid, at: now });
      log(t, `${who} se anotó solo (busca equipo).`, now);
      return {};
    }
    case 'unirse_codigo': { // con el código que pasa el capitán: entra directo
      assertInscripcion(t);
      const code = clean(a.code, 10).toUpperCase();
      const team = t.teams.find((x) => x.joinCode === code) || fail('No hay ningún equipo con ese código.');
      if (teamOf(t, pid) === team) fail('Ya estás en ese equipo.');
      assertNotPlaying(t, pid);
      if (teamFull(t, team)) fail('Ese equipo ya está completo.');
      team.members.push(pid);
      team.requests = team.requests.filter((r) => r !== pid);
      log(t, `${who} entró a ${team.name}.`, now);
      return { team: team.id };
    }
    case 'pedir_unirse': { // a un equipo abierto: el capitán (o el admin) lo acepta
      assertInscripcion(t);
      if (!t.format.inscripcion.unirse) fail('En este torneo no se puede pedir entrar a un equipo.');
      const team = getTeam(a.team);
      if (!team.open) fail('Ese equipo no recibe pedidos: pedile el código al capitán.');
      assertNotPlaying(t, pid);
      if (teamFull(t, team)) fail('Ese equipo ya está completo.');
      if (!team.requests.includes(pid)) team.requests.push(pid);
      return {};
    }
    case 'cancelar_pedido': {
      for (const team of t.teams) team.requests = team.requests.filter((r) => r !== pid);
      return {};
    }
    case 'aceptar_jugador': case 'rechazar_jugador': {
      assertInscripcion(t);
      const team = getTeam(a.team);
      captainOrAdmin(team);
      const target = String(a.pid || '');
      if (!team.requests.includes(target)) fail('Ese pedido ya no está.');
      team.requests = team.requests.filter((r) => r !== target);
      if (a.t === 'rechazar_jugador') return {};
      if (teamOf(t, target)) fail('Ese jugador ya entró a otro equipo.');
      if (teamFull(t, team)) fail('El equipo ya está completo.');
      t.solos = t.solos.filter((s) => s.pid !== target);
      for (const other of t.teams) other.requests = other.requests.filter((r) => r !== target);
      team.members.push(target);
      log(t, `${t.players[target]?.name || 'Un jugador'} entró a ${team.name}.`, now);
      return {};
    }
    case 'salir': { // del equipo o de la lista de sueltos (solo durante la inscripción)
      assertInscripcion(t);
      if (isSolo(t, pid)) {
        t.solos = t.solos.filter((s) => s.pid !== pid);
        return {};
      }
      const team = teamOf(t, pid) || fail('No estás anotado en este torneo.');
      team.members = team.members.filter((m) => m !== pid);
      if (!team.members.length) {
        t.teams = t.teams.filter((x) => x !== team);
        log(t, `${team.name} se dio de baja.`, now);
      } else if (team.captain === pid) team.captain = team.members[0];
      return {};
    }
    case 'editar_equipo': {
      const team = getTeam(a.team);
      captainOrAdmin(team);
      if (a.name !== undefined) {
        const name = clean(a.name, LIMITS.teamName);
        if (!name) fail('El equipo necesita un nombre.');
        if (t.teams.some((x) => x !== team && x.name.toLowerCase() === name.toLowerCase())) fail('Ya hay un equipo con ese nombre.');
        team.name = name;
      }
      if (a.kit !== undefined) team.kit = cleanKit(a.kit, team.kit) || fail('Esa camiseta no es válida.');
      if (typeof a.open === 'boolean') team.open = a.open;
      return {};
    }
    case 'quitar_jugador': { // capitán o admin, durante la inscripción
      assertInscripcion(t);
      const team = getTeam(a.team);
      captainOrAdmin(team);
      const target = String(a.pid || '');
      if (!team.members.includes(target)) fail('Ese jugador no está en el equipo.');
      if (target === team.captain && !admin) fail('El capitán no se puede sacar a sí mismo: usá "Salir".');
      team.members = team.members.filter((m) => m !== target);
      if (!team.members.length) t.teams = t.teams.filter((x) => x !== team);
      else if (team.captain === target) team.captain = team.members[0];
      return {};
    }

    // ---- admin
    case 'aprobar_equipo': case 'rechazar_equipo': {
      needAdmin();
      assertInscripcion(t);
      const team = getTeam(a.team);
      if (a.t === 'rechazar_equipo') {
        t.teams = t.teams.filter((x) => x !== team);
        log(t, `El admin no aceptó a ${team.name}.`, now);
        return {};
      }
      if (approved(t).length >= t.format.maxTeams && team.status !== 'aprobado') fail(`Ya hay ${t.format.maxTeams} equipos aprobados (el máximo).`);
      team.status = 'aprobado';
      log(t, `${team.name} fue aprobado: está en el torneo.`, now);
      return {};
    }
    case 'ubicar_solo': { // el admin pone a un jugador suelto en un equipo
      needAdmin();
      assertInscripcion(t);
      const target = String(a.pid || '');
      if (!isSolo(t, target)) fail('Ese jugador ya no está en la lista de sueltos.');
      const team = getTeam(a.team);
      if (teamFull(t, team)) fail('Ese equipo ya está completo.');
      t.solos = t.solos.filter((s) => s.pid !== target);
      for (const other of t.teams) other.requests = other.requests.filter((r) => r !== target);
      team.members.push(target);
      log(t, `${t.players[target]?.name || 'Un jugador'} pasó a ${team.name}.`, now);
      return {};
    }
    case 'armar_equipos': { // los sueltos, al azar, en equipos completos (quedan aprobados: los armó el admin)
      needAdmin();
      assertInscripcion(t);
      const size = t.format.teamSize;
      const pool = shuffle(t.solos.map((s) => s.pid), rng);
      // Primero completan equipos aprobados a los que les falta gente.
      for (const team of approved(t)) {
        while (!teamFull(t, team) && pool.length) team.members.push(pool.shift());
      }
      let made = 0;
      while (pool.length >= size && t.teams.length < LIMITS.maxTeams) {
        const members = pool.splice(0, size);
        let k = t.teams.length + 1;
        while (t.teams.some((x) => x.name === `Equipo ${k}`)) k += 1;
        const color = t.teams.length % 2 ? 'blue' : 'red';
        t.teams.push({
          id: nextId(t, 'e'), name: `Equipo ${k}`, captain: members[0], members, requests: [], status: 'aprobado',
          open: false, joinCode: uniqueTeamCode(t, rng), kit: { ...DEFAULT_KITS[color] },
        });
        made += 1;
      }
      const used = new Set(t.teams.flatMap((x) => x.members));
      t.solos = t.solos.filter((s) => !used.has(s.pid));
      for (const team of t.teams) team.requests = team.requests.filter((r) => !used.has(r) || team.members.includes(r));
      log(t, `El admin armó ${made} equipo${made === 1 ? '' : 's'} con los jugadores sueltos.`, now);
      return { made, left: t.solos.length };
    }
    case 'editar': { // nombre y modalidad
      needAdmin();
      if (a.name !== undefined) {
        const n = clean(a.name, LIMITS.name);
        if (!n) fail('El torneo necesita un nombre.');
        t.name = n;
      }
      if (a.format !== undefined) {
        const next = cleanFormat(a.format, t.format);
        if (t.status === 'inscripcion') {
          if (approved(t).length > next.maxTeams) fail(`Ya hay ${approved(t).length} equipos aprobados: el máximo no puede ser menos.`);
          if (t.teams.some((x) => x.members.length > next.teamSize)) fail('Hay equipos con más jugadores que eso: primero sacá jugadores.');
        } else {
          const played = allMatches(t).some((m) => m.status !== 'pendiente');
          const structural = next.type !== t.format.type
            || (next.type === 'copa' && next.idaVuelta !== t.format.idaVuelta)
            || (next.type === 'liga' && next.vueltas !== t.format.vueltas);
          if (next.teamSize !== t.format.teamSize) fail('Con el torneo empezado no se puede cambiar cuántos juegan por equipo.');
          if (structural) {
            if (played && !(t.format.type === 'liga' && next.type === 'liga' && next.vueltas > t.format.vueltas)) {
              fail('Ya se jugaron partidos: así solo se pueden cambiar las reglas o sumar vueltas a la liga. Para cambiar el resto, reiniciá el torneo.');
            }
          }
          const old = t.format;
          t.format = { ...next, maxTeams: Math.max(next.maxTeams, approved(t).length) };
          if (structural && !played) buildFixture(t, rng);
          else if (structural) { // liga con partidos jugados: se agregan las vueltas nuevas
            const base = roundRobin(approved(t).map((x) => x.id));
            for (let v = old.vueltas; v < next.vueltas; v += 1) {
              for (const pairs of base) {
                const n = t.rounds.length + 1;
                t.rounds.push({ n, name: `Fecha ${n}`, matches: pairs.map(([h, aw]) => (v % 2 ? newMatch(t, aw, h) : newMatch(t, h, aw))) });
              }
            }
            if (t.status === 'terminado') t.status = 'en_curso';
            t.champion = null;
            advance(t);
          }
          log(t, 'El admin cambió la modalidad del torneo.', now);
          return {};
        }
        t.format = next;
        log(t, 'El admin cambió la modalidad del torneo.', now);
      }
      return {};
    }
    case 'empezar': {
      needAdmin();
      assertInscripcion(t);
      const teams = approved(t);
      if (teams.length < 2) fail('Hacen falta al menos 2 equipos aprobados para empezar.');
      const incomplete = teams.filter((x) => x.members.length < t.format.teamSize);
      if (incomplete.length) fail(`Faltan jugadores en: ${incomplete.map((x) => x.name).join(', ')} (son de a ${t.format.teamSize}).`);
      const pending = t.teams.filter((x) => x.status !== 'aprobado');
      t.teams = teams; // los que no se aprobaron quedan afuera
      t.solos = [];
      for (const team of t.teams) team.requests = [];
      buildFixture(t, rng);
      log(t, `¡Empezó el torneo! ${teams.length} equipos.${pending.length ? ` Quedaron afuera (sin aprobar): ${pending.map((x) => x.name).join(', ')}.` : ''}`, now);
      return {};
    }
    case 'reiniciar': { // vuelve a la inscripción con los mismos equipos y borra el fixture
      needAdmin();
      t.status = 'inscripcion';
      t.rounds = [];
      t.champion = null;
      log(t, 'El admin reinició el torneo: vuelve a la inscripción.', now);
      return {};
    }
    case 'cargar_resultado': { // el admin carga (o corrige) un resultado
      needAdmin();
      if (t.status === 'inscripcion') fail('El torneo todavía no empezó.');
      const gh = int(a.gh, 0, 99, null);
      const ga = int(a.ga, 0, 99, null);
      if (gh === null || ga === null) fail('Los goles tienen que ser números enteros de 0 a 99.');
      setResult(t, String(a.match || ''), gh, ga, now);
      return {};
    }
    default:
      fail('Acción desconocida.');
  }
  return {};
}

/** Reglas del partido en el juego: en la liga y en la ida de una llave el empate vale;
 *  en un partido único de copa o en un desempate se sigue a gol de oro. */
export function matchRules(t, match) {
  const r = t.format.rules;
  const allowDraw = t.format.type === 'liga' || (t.format.idaVuelta && !match.desempate);
  return { time: r.time, score: r.score, ballRadius: r.ballRadius, map: r.map, allowDraw };
}

/** Carga (o corrige) el resultado de un partido y hace avanzar el torneo. Lo usan el admin y el servidor. */
export function setResult(t, matchId, gh, ga, now = Date.now()) {
  const m = matchById(t, matchId) || fail('No existe ese partido.');
  const round = t.rounds.find((r) => r.matches.includes(m));
  if (m.status === 'pendiente' && !playable(t, m)) fail('Ese partido todavía no se puede jugar: falta terminar la fecha/ronda anterior.');
  if (t.format.type === 'copa') {
    if (round !== t.rounds[t.rounds.length - 1]) fail('Esa ronda de la copa ya cerró: no se puede corregir.');
    if (!t.format.idaVuelta && gh === ga && !m.desempate) fail('En copa a un partido no hay empate: el partido sigue a gol de oro.');
    if (m.desempate && gh === ga) fail('El desempate es a gol de oro: tiene que haber un ganador.');
    const tie = round.ties.find((x) => x.id === m.tie);
    if (m.status !== 'pendiente' && tie) {
      // Corrección: la llave se vuelve a definir (y se descartan los desempates si era un partido de ida/vuelta).
      tie.winner = null;
      if (!m.desempate) {
        const drop = new Set(round.matches.filter((x) => x.tie === tie.id && x.desempate).map((x) => x.id));
        round.matches = round.matches.filter((x) => !drop.has(x.id));
        tie.matches = tie.matches.filter((id) => !drop.has(id));
      }
      if (t.status === 'terminado') {
        t.status = 'en_curso';
        t.champion = null;
      }
    }
  }
  m.gh = gh;
  m.ga = ga;
  m.status = 'jugado';
  m.playedAt = now;
  if (t.format.type === 'liga') {
    if (t.status === 'terminado') t.status = 'en_curso';
    t.champion = null;
  }
  log(t, `Resultado: ${teamById(t, m.home)?.name} ${gh} - ${ga} ${teamById(t, m.away)?.name}.`, now);
  advance(t);
  return m;
}

export const findMatch = (t, id) => matchById(t, id);

/** Goleadores, asistidores y más veces MVP del torneo (de las estadísticas de cada partido jugado). */
export function leaders(t) {
  const acc = new Map();
  for (const m of allMatches(t)) {
    if (m.status === 'pendiente' || !m.stats) continue;
    for (const [pid, r] of Object.entries(m.stats)) {
      const x = acc.get(pid) || { pid, team: teamOf(t, pid)?.id || null, g: 0, a: 0, mvp: 0, pj: 0 };
      x.g += r.g || 0;
      x.a += r.a || 0;
      x.mvp += r.mvp ? 1 : 0;
      x.pj += 1;
      acc.set(pid, x);
    }
  }
  const list = [...acc.values()];
  const top = (k) => list.filter((x) => x[k] > 0).sort((p, q) => q[k] - p[k] || p.pj - q.pj).slice(0, 10).map((x) => ({ ...x, name: t.players[x.pid]?.name || 'Jugador', value: x[k] }));
  return { goles: top('g'), asistencias: top('a'), mvps: top('mvp') };
}

/** Lo que ve cualquiera (no hay secretos en el documento: los jugadores se identifican con un hash). */
export function publicView(t, pid = null) {
  const cur = currentRoundIndex(t);
  return {
    ...t,
    me: pid,
    admin: pid ? isAdmin(t, pid) : false,
    currentRound: cur,
    standings: t.format.type === 'liga' && t.rounds.length ? standings(t) : null,
    leaders: t.rounds.length ? leaders(t) : null,
    // Los códigos para entrar a un equipo solo los ven sus jugadores y el admin.
    teams: t.teams.map((x) => ({ ...x, joinCode: pid && (x.members.includes(pid) || isAdmin(t, pid)) ? x.joinCode : null })),
  };
}
