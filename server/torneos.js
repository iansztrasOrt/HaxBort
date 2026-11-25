// Torneos en el servidor: guardado (Postgres si hay DATABASE_URL, si no en memoria) y la API HTTP.
//
//   POST /api/torneos            crear              { name, format, playerName }
//   GET  /api/torneos/CODIGO     ver
//   POST /api/torneos/CODIGO     hacer algo         { action, playerName }
//
// Cada persona se identifica con una clave secreta que su navegador guarda (header x-hax-key);
// en el torneo solo queda un hash de esa clave, así que nadie puede hacerse pasar por otro.

import crypto from 'node:crypto';
import { loadStadium } from '../shared/stadium/load.js';
import { createTorneo, applyAction, publicView, newCode, TorneoError, findMatch, playable, teamById, matchRules, setResult, isAdmin, listSummary } from '../shared/tournament/logic.js';

// ---------------------------------------------------------------- guardado
export class MemoryStore {
  constructor() {
    this.rows = new Map();
    this.kind = 'memoria';
  }
  async init() {}
  async list(limit = 100) {
    return [...this.rows.values()].map((r) => r.doc).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit).map((d) => structuredClone(d));
  }
  async get(code) {
    const r = this.rows.get(code);
    return r ? { doc: structuredClone(r.doc), version: r.version } : null;
  }
  async insert(code, doc) {
    if (this.rows.has(code)) return false;
    this.rows.set(code, { doc: structuredClone(doc), version: 1 });
    return true;
  }
  async update(code, doc, version) {
    const r = this.rows.get(code);
    if (!r || r.version !== version) return false;
    this.rows.set(code, { doc: structuredClone(doc), version: version + 1 });
    return true;
  }
  async putMap(code, id, text) {
    this.maps ||= new Map();
    this.maps.set(`${code}/${id}`, text);
  }
  async getMap(code, id) {
    return this.maps?.get(`${code}/${id}`) ?? null;
  }
  async close() {}
}

export class PgStore {
  constructor(url) {
    this.url = url;
    this.kind = 'postgres';
    this.pool = null;
  }
  async init() {
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    this.pool.on('error', (e) => console.error('[db]', e.message));
    await this.pool.query(`CREATE TABLE IF NOT EXISTS torneos (
      code text PRIMARY KEY,
      doc jsonb NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Canchas propias de un torneo (aparte, para no reescribir el texto del mapa en cada cambio del torneo).
    await this.pool.query(`CREATE TABLE IF NOT EXISTS torneo_mapas (
      code text NOT NULL,
      id text NOT NULL,
      text text NOT NULL,
      PRIMARY KEY (code, id)
    )`);
  }
  async list(limit = 100) {
    const { rows } = await this.pool.query('SELECT doc FROM torneos ORDER BY updated_at DESC LIMIT $1', [limit]);
    return rows.map((r) => r.doc);
  }
  async get(code) {
    const { rows } = await this.pool.query('SELECT doc, version FROM torneos WHERE code = $1', [code]);
    return rows[0] ? { doc: rows[0].doc, version: rows[0].version } : null;
  }
  async insert(code, doc) {
    const { rowCount } = await this.pool.query('INSERT INTO torneos (code, doc) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [code, doc]);
    return rowCount === 1;
  }
  async update(code, doc, version) {
    // Solo si nadie lo cambió desde que se leyó (si no, se vuelve a intentar con lo nuevo).
    const { rowCount } = await this.pool.query(
      'UPDATE torneos SET doc = $2, version = version + 1, updated_at = now() WHERE code = $1 AND version = $3',
      [code, doc, version],
    );
    return rowCount === 1;
  }
  async putMap(code, id, text) {
    await this.pool.query('INSERT INTO torneo_mapas (code, id, text) VALUES ($1, $2, $3) ON CONFLICT (code, id) DO NOTHING', [code, id, text]);
  }
  async getMap(code, id) {
    const { rows } = await this.pool.query('SELECT text FROM torneo_mapas WHERE code = $1 AND id = $2', [code, id]);
    return rows[0]?.text ?? null;
  }
  async close() {
    await this.pool?.end();
  }
}

export function createStore(url = process.env.DATABASE_URL) {
  return url ? new PgStore(url) : new MemoryStore();
}

// ---------------------------------------------------------------- API
const CODE = /^[A-Z0-9]{6}$/;
const MAP_MAX_BYTES = 512 * 1024; // una cancha propia del torneo
const pidOf = (key) => crypto.createHash('sha256').update(`haxbort:${key}`).digest('hex').slice(0, 16);

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('demasiado grande'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Limitador simple por IP: `n` pedidos cada `ms`. */
function limiter(n, ms) {
  const hits = new Map();
  return (ip) => {
    const t = Date.now();
    const list = (hits.get(ip) || []).filter((x) => t - x < ms);
    if (list.length >= n) return false;
    list.push(t);
    hits.set(ip, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < ms)) hits.delete(k);
    return true;
  };
}

export function createTorneosApi({ store, log = () => {}, rates = {} }) {
  const canCreate = limiter(rates.create ?? 5, 10 * 60 * 1000);
  const canAct = limiter(rates.act ?? 40, 10 * 1000);
  const queues = new Map(); // code → promesa: los cambios a un mismo torneo van de a uno
  let ready = null;
  const ensure = () => (ready ||= store.init().catch((e) => {
    ready = null;
    throw e;
  }));

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function serialize(code, fn) {
    const prev = queues.get(code) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    queues.set(code, run);
    run.finally(() => { if (queues.get(code) === run) queues.delete(code); }).catch(() => {});
    return run;
  }

  async function mutate(code, fn) {
    return serialize(code, async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const row = await store.get(code);
        if (!row) return { notFound: true };
        const doc = row.doc;
        const result = fn(doc);
        doc.updatedAt = Date.now();
        if (await store.update(code, doc, row.version)) return { doc, result };
      }
      throw Object.assign(new Error('conflicto'), { status: 409 });
    });
  }

  // ---------------------------------------------------------------- partidos en vivo (en memoria)
  // Quién está listo, quién corre el partido, el marcador y los resultados que mandan los jugadores.
  // No va a la base: es del momento (si el servidor se reinicia, los jugadores vuelven a tocar "Listo").
  const READY_TTL = 12000; // "listo" vence si no se renueva (la página lo renueva cada 4 s)
  const CREATE_TIMEOUT = 25000; // el elegido para correr el partido tiene este tiempo para armar la sala
  const SINGLE_REPORT_WAIT = 60000; // si solo un jugador mandó el resultado final, se espera esto
  const live = new Map(); // code → Map(matchId → estado)
  const token = (n = 12) => crypto.randomBytes(n).toString('hex');

  function liveOf(code, matchId, create = false) {
    let byMatch = live.get(code);
    if (!byMatch && create) live.set(code, (byMatch = new Map()));
    let L = byMatch?.get(matchId);
    if (!L && create) byMatch.set(matchId, (L = { ready: new Map(), session: null, reports: new Map(), score: null, excluded: new Set(), dispute: false }));
    return L || null;
  }
  function participants(t, m) {
    const home = teamById(t, m.home)?.members || [];
    const away = teamById(t, m.away)?.members || [];
    return { home, away, all: [...home, ...away] };
  }
  /** Limpia lo vencido y, si están todos listos, arma la sesión (elige quién corre el partido). */
  function tick(t) {
    const byMatch = live.get(t.code);
    if (!byMatch) return;
    const now = Date.now();
    for (const [id, L] of byMatch) {
      const m = findMatch(t, id);
      if (!m || m.status !== 'pendiente') {
        byMatch.delete(id);
        continue;
      }
      for (const [pid, r] of L.ready) if (now - r.at > READY_TTL) L.ready.delete(pid);
      if (L.session?.state === 'creando' && now - L.session.createdAt > CREATE_TIMEOUT) {
        L.excluded.add(L.session.host); // no pudo armar la sala: la próxima la arma otro
        L.session = null;
      }
      if (!L.session && playable(t, m)) {
        const { all } = participants(t, m);
        if (all.length && all.every((pid) => L.ready.has(pid))) {
          const candidates = all.filter((pid) => !L.excluded.has(pid));
          const pool = candidates.length ? candidates : all;
          // El de mejor conexión (menos demora con el servidor) corre el partido.
          const host = pool.reduce((best, pid) => ((L.ready.get(pid).rtt ?? 9999) < (L.ready.get(best).rtt ?? 9999) ? pid : best), pool[0]);
          const tickets = {};
          const ticketOf = {};
          const { home } = participants(t, m);
          for (const pid of all) {
            const tk = token();
            tickets[tk] = { pid, team: home.includes(pid) ? 'red' : 'blue' };
            ticketOf[pid] = tk;
          }
          L.session = { id: token(8), host, tickets, ticketOf, room: null, createdAt: now, state: 'creando' };
          L.reports.clear();
          L.score = null;
          L.dispute = false;
          log(`[torneo] ${t.code} partido ${id}: lo corre ${t.players[host]?.name || host}`);
        }
      }
      if (L.pendingSince && now - L.pendingSince > SINGLE_REPORT_WAIT) resolve(t.code, id, { force: true });
    }
  }
  /** Lo que cada uno ve de los partidos en vivo (el ticket propio y, al elegido, la configuración). */
  function liveView(t, pid) {
    const out = {};
    const byMatch = live.get(t.code);
    if (!byMatch) return out;
    for (const [id, L] of byMatch) {
      const m = findMatch(t, id);
      if (!m) continue;
      const s = L.session;
      const v = { ready: [...L.ready.keys()], state: s?.state || null, room: s?.room || null, host: s?.host || null, score: L.score, dispute: L.dispute };
      if (s && pid && s.ticketOf[pid]) v.myTicket = s.ticketOf[pid];
      if (s && pid === s.host) {
        const home = teamById(t, m.home);
        const away = teamById(t, m.away);
        const round = t.rounds.find((r) => r.matches.includes(m));
        v.hostConfig = {
          code: t.code, match: id, session: s.id, selfTicket: s.ticketOf[pid], tickets: s.tickets,
          title: `${t.name} · ${round?.name || ''}${m.desempate ? ' (desempate)' : m.leg === 2 ? ' (vuelta)' : m.leg === 1 && t.format.idaVuelta ? ' (ida)' : ''}`,
          home: { name: home?.name, kit: home?.kit }, away: { name: away?.name, kit: away?.kit }, rules: matchRules(t, m),
        };
      }
      out[id] = v;
    }
    return out;
  }
  const view = (doc, pid) => {
    tick(doc);
    return { ...publicView(doc, pid), live: liveView(doc, pid) };
  };

  /** Acciones del momento (no se guardan en la base). Devuelve null si no es una de estas. */
  function liveAction(doc, pid, a) {
    if (!a || !['listo', 'sala_creada', 'marcador'].includes(a.t)) return null;
    const m = findMatch(doc, String(a.match || ''));
    if (!m) throw new TorneoError('No existe ese partido.');
    const { all } = participants(doc, m);
    if (!all.includes(pid)) throw new TorneoError('No jugás ese partido.');
    const L = liveOf(doc.code, m.id, true);
    if (a.t === 'listo') {
      if (!playable(doc, m)) throw new TorneoError('Ese partido todavía no se puede jugar.');
      if (a.on === false) L.ready.delete(pid);
      else L.ready.set(pid, { at: Date.now(), rtt: Number.isFinite(Number(a.rtt)) ? Math.max(0, Math.min(5000, Number(a.rtt))) : null });
      tick(doc);
      return {};
    }
    const s = L.session;
    if (a.t === 'sala_creada') {
      if (!s || s.id !== a.session || s.host !== pid) throw new TorneoError('Esa partida ya no está.');
      s.room = String(a.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      s.state = 'jugando';
      roomIndex.set(s.room, { code: doc.code, match: m.id });
      return {};
    }
    // marcador: lo manda cada jugador en cada gol y al final (red = local, blue = visitante)
    const gh = Number(a.gh);
    const ga = Number(a.ga);
    if (!Number.isInteger(gh) || !Number.isInteger(ga) || gh < 0 || ga < 0 || gh > 99 || ga > 99) throw new TorneoError('Marcador inválido.');
    if (a.final) {
      L.reports.set(pid, { gh, ga, at: Date.now(), stats: cleanMatchStats(a.stats, all), host: L.session?.host === pid });
      resolve(doc.code, m.id);
    } else if (!L.score || gh + ga >= L.score[0] + L.score[1]) L.score = [gh, ga];
    return {};
  }

  /** ¿Ya se puede cargar el resultado? Dos jugadores que coinciden, o uno solo después de esperar. */
  function resolve(code, matchId, { force = false, fromClose = false } = {}) {
    const L = liveOf(code, matchId);
    if (!L || L.resolving) return;
    const groups = new Map();
    for (const [pid, r] of L.reports) {
      const k = `${r.gh}-${r.ga}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pid);
    }
    let result = null;
    if (groups.size > 1) {
      L.dispute = true; // no coinciden: lo resuelve el admin cargando el resultado a mano
      L.pendingSince = null;
      return;
    }
    if (groups.size === 1) {
      const [k, pids] = [...groups][0];
      if (pids.length >= 2 || force || fromClose) result = k.split('-').map(Number);
      else if (!L.pendingSince) L.pendingSince = Date.now();
    } else if (fromClose && L.score && L.session?.state === 'jugando') {
      result = L.score; // se cortó sin final: gana el que iba ganando
    }
    if (!result) {
      if (fromClose) { // se cortó antes de empezar o sin marcador: se vuelve a armar
        L.session = null;
        L.ready.clear();
      }
      return;
    }
    L.resolving = true;
    mutate(code, (doc) => {
      const m = findMatch(doc, matchId);
      if (!m || m.status !== 'pendiente') return null;
      try {
        setResult(doc, matchId, result[0], result[1]);
        // Estadísticas del partido: las de quien corrió la sala (si coinciden con el resultado), si no las de otro.
        const agree = [...L.reports.values()].filter((r) => r.stats && r.gh === result[0] && r.ga === result[1]);
        const src = agree.find((r) => r.host) || agree[0];
        if (src) m.stats = src.stats;
        return { ok: true };
      } catch (e) {
        if (e instanceof TorneoError) return { replay: true }; // p. ej. empate en copa a un partido: se juega de nuevo
        throw e;
      }
    }).then((out) => {
      L.resolving = false;
      if (out?.result?.replay) {
        L.session = null;
        L.ready.clear();
        L.reports.clear();
        L.score = null;
        L.pendingSince = null;
      } else live.get(code)?.delete(matchId);
      if (out?.result?.ok) log(`[torneo] ${code} partido ${matchId}: ${result[0]}-${result[1]}`);
    }).catch((e) => {
      L.resolving = false;
      console.error('[torneos] no se pudo guardar un resultado', e.message);
    });
  }

  /** Estadísticas que manda un jugador: solo números chicos y solo de los que juegan ese partido. */
  function cleanMatchStats(raw, participantsList) {
    if (!raw || typeof raw !== 'object') return null;
    const ok = new Set(participantsList);
    const n = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);
    const out = {};
    for (const [pid, r] of Object.entries(raw)) {
      if (!ok.has(pid) || !r || typeof r !== 'object') continue;
      const rating = Number(r.r);
      out[pid] = { g: n(r.g, 99), a: n(r.a, 99), sv: n(r.sv, 999), r: Number.isFinite(rating) ? Math.min(10, Math.max(1, Math.round(rating * 10) / 10)) : null, mvp: r.mvp === true };
    }
    if (Object.values(out).filter((x) => x.mvp).length > 1) for (const x of Object.values(out)) x.mvp = false;
    return Object.keys(out).length ? out : null;
  }

  /** El admin sube una cancha propia: se valida, se guarda aparte y queda disponible para la modalidad. */
  async function uploadMap(code, pid, a) {
    const text = typeof a.text === 'string' ? a.text : '';
    if (!text || Buffer.byteLength(text) > MAP_MAX_BYTES) throw new TorneoError(`La cancha tiene que pesar menos de ${MAP_MAX_BYTES / 1024} KB.`);
    const res = loadStadium(text);
    if (!res.ok) throw new TorneoError(`La cancha tiene errores: ${res.errors[0]?.where || ''} ${res.errors[0]?.msg || ''}`.trim());
    const tune = a.tune !== false;
    const id = `c-${crypto.createHash('sha256').update(`${tune ? 1 : 0}:${text}`).digest('hex').slice(0, 10)}`;
    const row = await store.get(code);
    if (!row) return { notFound: true };
    if (!isAdmin(row.doc, pid)) throw new TorneoError('Eso lo puede hacer solo el admin del torneo.');
    await store.putMap(code, id, text);
    return mutate(code, (doc) => {
      doc.maps = { ...(doc.maps || {}) };
      if (!doc.maps[id] && Object.keys(doc.maps).length >= 20) throw new TorneoError('El torneo ya tiene 20 canchas propias.');
      doc.maps[id] = { name: String(a.name || res.stadium.name || 'Cancha').slice(0, 40), tune };
      return id;
    });
  }

  const roomIndex = new Map(); // código de sala → { code, match }
  /** La sala de un partido se cerró (se fue quien la corría, o terminó). */
  function roomClosed(roomCode) {
    const ref = roomIndex.get(roomCode);
    if (!ref) return;
    roomIndex.delete(roomCode);
    const L = liveOf(ref.code, ref.match);
    if (!L || L.session?.room !== roomCode) return;
    resolve(ref.code, ref.match, { fromClose: true });
    if (L.session?.room === roomCode) L.session = null;
  }

  /** Devuelve true si atendió el pedido. */
  async function handle(req, res, url, ip) {
    if (!url.pathname.startsWith('/api/torneos')) return false;
    const key = String(req.headers['x-hax-key'] || '');
    const pid = key.length >= 16 && key.length <= 128 ? pidOf(key) : null;
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'torneos', CODE?]
    const code = (parts[2] || '').toUpperCase();
    try {
      await ensure();
      // Lista de torneos públicos (como la de salas): los que están en inscripción o en juego,
      // y los terminados en los últimos 3 días.
      if (parts.length === 2 && req.method === 'GET') {
        const now = Date.now();
        const docs = await store.list(150);
        const torneos = docs
          .filter((d) => d.format?.publico !== false)
          .filter((d) => d.status !== 'terminado' || now - (d.updatedAt || 0) < 3 * 24 * 3600 * 1000)
          .map((d) => {
            const s = listSummary(d);
            s.live = [...(live.get(d.code)?.values() || [])].filter((L) => L.session?.state === 'jugando').length;
            return s;
          })
          .sort((a, b) => ({ inscripcion: 0, en_curso: 1, terminado: 2 }[a.status] - { inscripcion: 0, en_curso: 1, terminado: 2 }[b.status]) || b.updatedAt - a.updatedAt)
          .slice(0, 60);
        return json(res, 200, { ok: true, torneos }), true;
      }
      if (parts.length === 2 && req.method === 'POST') {
        if (!pid) return json(res, 400, { error: 'Falta tu identificación (recargá la página).' }), true;
        if (!canCreate(ip)) return json(res, 429, { error: 'Creaste muchos torneos seguidos: esperá un rato.' }), true;
        const body = await readBody(req);
        for (let i = 0; i < 10; i += 1) {
          const c = newCode();
          const doc = createTorneo({ code: c, name: body.name, owner: pid, ownerName: body.playerName, format: body.format });
          if (await store.insert(c, doc)) {
            log(`[torneo] ${c} creado (${doc.format.type})`);
            return json(res, 200, { ok: true, code: c, torneo: view(doc, pid) }), true;
          }
        }
        return json(res, 503, { error: 'No se pudo crear el torneo. Probá de nuevo.' }), true;
      }
      // Texto de una cancha propia del torneo (la baja la compu que arma cada partido).
      if (parts.length === 5 && parts[3] === 'mapa' && CODE.test(code) && req.method === 'GET') {
        const id = parts[4];
        const row = await store.get(code);
        const info = row?.doc.maps?.[id];
        const text = info ? await store.getMap(code, id) : null;
        if (!text) return json(res, 404, { error: 'No existe esa cancha en el torneo.' }), true;
        return json(res, 200, { ok: true, id, name: info.name, tune: info.tune, text }), true;
      }
      if (parts.length === 3 && CODE.test(code)) {
        if (req.method === 'GET') {
          const row = await store.get(code);
          if (!row) return json(res, 404, { error: `No existe el torneo ${code}.` }), true;
          return json(res, 200, { ok: true, torneo: view(row.doc, pid) }), true;
        }
        if (req.method === 'POST') {
          if (!pid) return json(res, 400, { error: 'Falta tu identificación (recargá la página).' }), true;
          if (!canAct(ip)) return json(res, 429, { error: 'Demasiados pedidos seguidos: esperá un momento.' }), true;
          const body = await readBody(req, MAP_MAX_BYTES + 32 * 1024);
          if (body.action?.t === 'subir_cancha') {
            const out = await uploadMap(code, pid, body.action);
            if (out.notFound) return json(res, 404, { error: `No existe el torneo ${code}.` }), true;
            return json(res, 200, { ok: true, result: { map: out.result }, torneo: view(out.doc, pid) }), true;
          }
          if (['listo', 'sala_creada', 'marcador'].includes(body.action?.t)) {
            const row = await store.get(code);
            if (!row) return json(res, 404, { error: `No existe el torneo ${code}.` }), true;
            const result = liveAction(row.doc, pid, body.action);
            return json(res, 200, { ok: true, result, torneo: view(row.doc, pid) }), true;
          }
          const out = await mutate(code, (doc) => applyAction(doc, { pid, name: body.playerName }, body.action));
          if (out.notFound) return json(res, 404, { error: `No existe el torneo ${code}.` }), true;
          return json(res, 200, { ok: true, result: out.result || {}, torneo: view(out.doc, pid) }), true;
        }
      }
      json(res, 404, { error: 'No existe.' });
      return true;
    } catch (e) {
      if (e instanceof TorneoError) json(res, 400, { error: e.message });
      else if (e.status === 413 || e.status === 400) json(res, e.status, { error: 'Pedido inválido.' });
      else if (e.status === 409) json(res, 409, { error: 'Otro cambio se cruzó con el tuyo: probá de nuevo.' });
      else {
        console.error('[torneos]', e);
        json(res, 503, { error: 'No se pudo acceder a los torneos en este momento. Probá en un rato.' });
      }
      return true;
    }
  }

  /** Conecta la base al arrancar, para ver en los logs enseguida si anda. */
  function warm() {
    return ensure().then(() => log(`Torneos: se guardan en ${store.kind}${store.kind === 'memoria' ? ' (sin DATABASE_URL: se pierden al reiniciar)' : ''}.`))
      .catch((e) => console.error(`[torneos] no se pudo conectar a la base: ${e.message}`));
  }

  return { handle, store, warm, roomClosed };
}
