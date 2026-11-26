import { describe, it, expect, afterAll } from 'vitest';
import { createIceProvider, normalizeIce, DEFAULT_ICE } from '../server/ice.js';
import { createServer } from '../server/index.js';
import { MemoryStore } from '../server/torneos.js';

const CF_ARRAY = { iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
] };
const CF_OBJECT = { iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u2', credential: 'c2' } };

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status ? r.status < 300 : true, status: r.status || 201, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

describe('servidores ICE (relevo TURN de Cloudflare)', () => {
  it('normaliza las dos formas de respuesta y saca el puerto 53', () => {
    const a = normalizeIce(CF_ARRAY);
    expect(a).toHaveLength(2);
    expect(a.flatMap((s) => s.urls).some((u) => /:53(\?|$)/.test(u))).toBe(false);
    expect(a[1].urls).toContain('turns:turn.cloudflare.com:5349?transport=tcp'); // el 5349 no es el 53
    expect(a[1]).toMatchObject({ username: 'u1', credential: 'c1' });
    expect(normalizeIce(CF_OBJECT)).toEqual([{ urls: CF_OBJECT.iceServers.urls, username: 'u2', credential: 'c2' }]);
    expect(normalizeIce({})).toEqual([]);
  });

  it('sin configurar: solo STUN, sin llamar a Cloudflare', async () => {
    const f = fakeFetch([]);
    const ice = createIceProvider({ keyId: '', token: '', fetchImpl: f });
    expect(await ice.get()).toEqual({ iceServers: DEFAULT_ICE, turn: false });
    expect(f.calls).toHaveLength(0);
  });

  it('configurado: pide credenciales con la clave (que no sale del servidor) y las guarda unas horas', async () => {
    let t = 0;
    const f = fakeFetch([{ body: CF_ARRAY }, { body: CF_OBJECT }]);
    const ice = createIceProvider({ keyId: 'KEY123', token: 'secreto-api', fetchImpl: f, now: () => t });
    const r1 = await ice.get();
    expect(r1.turn).toBe(true);
    expect(f.calls[0].url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/KEY123/credentials/generate-ice-servers');
    expect(f.calls[0].opts.headers.authorization).toBe('Bearer secreto-api');
    expect(JSON.parse(f.calls[0].opts.body)).toEqual({ ttl: 86400 });
    expect(JSON.stringify(r1)).not.toContain('secreto-api');
    t = 3 * 3600 * 1000;
    await ice.get();
    expect(f.calls).toHaveLength(1); // todavía vigentes: no se vuelve a pedir
    t = 13 * 3600 * 1000;
    const r3 = await ice.get(); // se responde con las vigentes y se renuevan de fondo
    expect(r3.turn).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toHaveLength(2);
    expect((await ice.get()).iceServers.some((s) => s.username === 'u2')).toBe(true);
  });

  it('si Cloudflare falla, el juego sigue con STUN y reintenta al minuto', async () => {
    let t = 0;
    const f = fakeFetch([{ status: 401, body: { error: 'no' } }, new Error('red caída'), { body: CF_ARRAY }]);
    const ice = createIceProvider({ keyId: 'K', token: 'T', fetchImpl: f, now: () => t });
    expect(await ice.get()).toEqual({ iceServers: DEFAULT_ICE, turn: false });
    t = 30 * 1000;
    expect((await ice.get()).turn).toBe(false);
    expect(f.calls).toHaveLength(1); // no insiste en seguida
    t = 61 * 1000;
    expect((await ice.get()).turn).toBe(false); // falló de nuevo
    t = 130 * 1000;
    expect((await ice.get()).turn).toBe(true);
  });

  describe('ruta /api/ice', () => {
    const srv = createServer({ port: 0, html: '<!doctype html>', log: () => {}, store: new MemoryStore(), ice: createIceProvider({ keyId: 'K', token: 'T', fetchImpl: fakeFetch([{ body: CF_ARRAY }]) }) });
    afterAll(() => srv.close());
    it('devuelve los servidores (sin cache del navegador)', async () => {
      if (!srv.server.listening) await new Promise((r) => srv.server.once('listening', r));
      const res = await fetch(`http://127.0.0.1:${srv.server.address().port}/api/ice`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.turn).toBe(true);
      expect(body.iceServers.some((s) => s.urls.some((u) => u.startsWith('turns:')))).toBe(true);
    });
  });
});
