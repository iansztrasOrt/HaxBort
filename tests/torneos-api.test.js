import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from '../server/index.js';
import { MemoryStore, PgStore } from '../server/torneos.js';

// Con TEST_DATABASE_URL (un Postgres de prueba) se prueba también el guardado real.
const stores = [['memoria', () => new MemoryStore()]];
if (process.env.TEST_DATABASE_URL) stores.push(['postgres', () => new PgStore(process.env.TEST_DATABASE_URL)]);

for (const [kind, makeStore] of stores) {
  describe(`API de torneos (${kind})`, () => {
    const store = makeStore();
    const srv = createServer({ port: 0, html: '<!doctype html>', log: () => {}, store, torneoRates: { create: 100, act: 1000 } });
    afterAll(() => srv.close());
    const base = async () => {
      if (!srv.server.listening) await new Promise((r) => srv.server.once('listening', r));
      return `http://127.0.0.1:${srv.server.address().port}/api/torneos`;
    };
    const call = async (path, { key, body, method } = {}) => {
      const res = await fetch(`${await base()}${path}`, {
        method: method || (body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', ...(key ? { 'x-hax-key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, ...(await res.json()) };
    };
    const K = (n) => `clave-secreta-de-prueba-${n}`;

    it('crear, inscribirse, aprobar, empezar, cargar resultados y ver la tabla', async () => {
      const c = await call('', { key: K('admin'), body: { name: 'Liga de prueba', playerName: 'Ana', format: { type: 'liga', teamSize: 1, vueltas: 1 } } });
      expect(c.status).toBe(200);
      expect(c.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(c.torneo.admin).toBe(true);
      const code = c.code;
      const teams = [];
      for (let i = 1; i <= 3; i += 1) {
        const r = await call(`/${code}`, { key: K(i), body: { playerName: `Jugador ${i}`, action: { t: 'crear_equipo', name: `Equipo ${i}` } } });
        expect(r.status).toBe(200);
        teams.push(r.result.team);
      }
      // Otro no puede aprobar
      const deny = await call(`/${code}`, { key: K(1), body: { action: { t: 'aprobar_equipo', team: teams[0] } } });
      expect(deny.status).toBe(400);
      expect(deny.error).toMatch(/admin/);
      for (const team of teams) expect((await call(`/${code}`, { key: K('admin'), body: { action: { t: 'aprobar_equipo', team } } })).status).toBe(200);
      const start = await call(`/${code}`, { key: K('admin'), body: { action: { t: 'empezar' } } });
      expect(start.torneo.status).toBe('en_curso');
      expect(start.torneo.rounds).toHaveLength(3);
      // Se guarda: una lectura nueva trae lo mismo
      const view = await call(`/${code}`, { key: K(1) });
      expect(view.torneo.admin).toBe(false);
      expect(view.torneo.me).toBeTruthy();
      expect(JSON.stringify(view)).not.toContain('clave-secreta');
      let t = view.torneo;
      while (t.status === 'en_curso') {
        for (const m of t.rounds[t.currentRound].matches.filter((x) => x.status === 'pendiente')) {
          const r = await call(`/${code}`, { key: K('admin'), body: { action: { t: 'cargar_resultado', match: m.id, gh: 2, ga: 1 } } });
          expect(r.status).toBe(200);
          t = r.torneo;
        }
      }
      expect(t.status).toBe('terminado');
      expect(t.standings).toHaveLength(3);
      expect(t.champion).toBe(t.standings[0].team);
    });

    it('cambios al mismo tiempo no se pisan (20 jugadores anotándose a la vez)', async () => {
      const c = await call('', { key: K('admin2'), body: { name: 'Copa', format: { type: 'copa', teamSize: 1, maxTeams: 32 } } });
      const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call(`/${c.code}`, { key: K(`x${i}`), body: { playerName: `J${i}`, action: { t: 'anotarse_solo' } } })));
      expect(res.every((r) => r.status === 200)).toBe(true);
      const v = await call(`/${c.code}`);
      expect(v.torneo.solos).toHaveLength(20);
    });

    it('canchas propias: el admin la sube, se elige para el torneo y la puede bajar cualquiera', async () => {
      const { BUILTIN_MAPS } = await import('../shared/builtinMaps.js');
      const text = BUILTIN_MAPS.find((m) => m.id === 'hockey').text.replace('"Hockey"', '"Mi Cancha"');
      const c = await call('', { key: K('adm3'), body: { name: 'Con cancha', format: { teamSize: 1 } } });
      expect((await call(`/${c.code}`, { key: K('otro3'), body: { action: { t: 'subir_cancha', name: 'X', text } } })).status).toBe(400);
      const bad = await call(`/${c.code}`, { key: K('adm3'), body: { action: { t: 'subir_cancha', name: 'Rota', text: '{ "vertexes": [ {' } } });
      expect(bad.status).toBe(400);
      expect((await call(`/${c.code}`, { key: K('adm3'), body: { action: { t: 'editar', format: { rules: { map: 'c-0000000000' } } } } })).error).toMatch(/no está subida/);
      const up = await call(`/${c.code}`, { key: K('adm3'), body: { action: { t: 'subir_cancha', name: 'Mi Cancha', text, tune: true } } });
      expect(up.status).toBe(200);
      const id = up.result.map;
      expect(id).toMatch(/^c-[0-9a-f]{10}$/);
      expect(up.torneo.maps[id].name).toBe('Mi Cancha');
      const ed = await call(`/${c.code}`, { key: K('adm3'), body: { action: { t: 'editar', format: { rules: { map: id } } } } });
      expect(ed.torneo.format.rules.map).toBe(id);
      const got = await call(`/${c.code}/mapa/${id}`);
      expect(got.text).toBe(text);
      expect(got.name).toBe('Mi Cancha');
      expect((await call(`/${c.code}/mapa/c-1111111111`)).status).toBe(404);
    });

    it('errores claros: sin identificación, torneo inexistente, pedido inválido', async () => {
      expect((await call('', { body: { name: 'x' } })).status).toBe(400);
      const nf = await call('/ZZZZZZ');
      expect(nf.status).toBe(404);
      expect(nf.error).toMatch(/No existe/);
      const bad = await call('', { key: K('y'), body: { name: '' } });
      expect(bad.status).toBe(400);
      expect(bad.error).toMatch(/nombre/);
    });
  });
}
