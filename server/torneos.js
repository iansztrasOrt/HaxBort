// Torneos en el servidor: guardado (Postgres si hay DATABASE_URL, si no en memoria) y la API HTTP.
//
//   POST /api/torneos            crear              { name, format, playerName }
//   GET  /api/torneos/CODIGO     ver
//   POST /api/torneos/CODIGO     hacer algo         { action, playerName }
//
// Cada persona se identifica con una clave secreta que su navegador guarda (header x-hax-key);
// en el torneo solo queda un hash de esa clave, así que nadie puede hacerse pasar por otro.

import crypto from 'node:crypto';
import { createTorneo, applyAction, publicView, newCode, TorneoError } from '../shared/tournament/logic.js';

// ---------------------------------------------------------------- guardado
export class MemoryStore {
  constructor() {
    this.rows = new Map();
    this.kind = 'memoria';
  }
  async init() {}
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
  async close() {
    await this.pool?.end();
  }
}

export function createStore(url = process.env.DATABASE_URL) {
  return url ? new PgStore(url) : new MemoryStore();
}

// ---------------------------------------------------------------- API
const CODE = /^[A-Z0-9]{6}$/;
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

  /** Devuelve true si atendió el pedido. */
  async function handle(req, res, url, ip) {
    if (!url.pathname.startsWith('/api/torneos')) return false;
    const key = String(req.headers['x-hax-key'] || '');
    const pid = key.length >= 16 && key.length <= 128 ? pidOf(key) : null;
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'torneos', CODE?]
    const code = (parts[2] || '').toUpperCase();
    try {
      await ensure();
      if (parts.length === 2 && req.method === 'POST') {
        if (!pid) return json(res, 400, { error: 'Falta tu identificación (recargá la página).' }), true;
        if (!canCreate(ip)) return json(res, 429, { error: 'Creaste muchos torneos seguidos: esperá un rato.' }), true;
        const body = await readBody(req);
        for (let i = 0; i < 10; i += 1) {
          const c = newCode();
          const doc = createTorneo({ code: c, name: body.name, owner: pid, ownerName: body.playerName, format: body.format });
          if (await store.insert(c, doc)) {
            log(`[torneo] ${c} creado (${doc.format.type})`);
            return json(res, 200, { ok: true, code: c, torneo: publicView(doc, pid) }), true;
          }
        }
        return json(res, 503, { error: 'No se pudo crear el torneo. Probá de nuevo.' }), true;
      }
      if (parts.length === 3 && CODE.test(code)) {
        if (req.method === 'GET') {
          const row = await store.get(code);
          if (!row) return json(res, 404, { error: `No existe el torneo ${code}.` }), true;
          return json(res, 200, { ok: true, torneo: publicView(row.doc, pid) }), true;
        }
        if (req.method === 'POST') {
          if (!pid) return json(res, 400, { error: 'Falta tu identificación (recargá la página).' }), true;
          if (!canAct(ip)) return json(res, 429, { error: 'Demasiados pedidos seguidos: esperá un momento.' }), true;
          const body = await readBody(req);
          const out = await mutate(code, (doc) => applyAction(doc, { pid, name: body.playerName }, body.action));
          if (out.notFound) return json(res, 404, { error: `No existe el torneo ${code}.` }), true;
          return json(res, 200, { ok: true, result: out.result || {}, torneo: publicView(out.doc, pid) }), true;
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

  return { handle, store, warm };
}
