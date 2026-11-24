import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from '../server/index.js';
import { MemoryStore } from '../server/torneos.js';

describe('partidos de torneo en vivo', () => {
  const srv = createServer({ port: 0, html: '<!doctype html>', log: () => {}, store: new MemoryStore(), torneoRates: { create: 100, act: 10000 } });
  afterAll(() => srv.close());
  const base = async () => {
    if (!srv.server.listening) await new Promise((r) => srv.server.once('listening', r));
    return `http://127.0.0.1:${srv.server.address().port}/api/torneos`;
  };
  const call = async (path, key, body) => {
    const res = await fetch(`${await base()}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-hax-key': key }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json()) };
  };
  const K = (n) => `clave-de-prueba-numero-${n}`;
  const act = (code, who, action) => call(`/${code}`, K(who), { playerName: who, action });

  /** Torneo de 1 vs 1 empezado con los equipos de `players`. */
  async function torneo(format, players) {
    const c = await call('', K('admin'), { name: 'T', format: { teamSize: 1, ...format } });
    for (const p of players) {
      const r = await act(c.code, p, { t: 'crear_equipo', name: `Eq ${p}` });
      await act(c.code, 'admin', { t: 'aprobar_equipo', team: r.result.team });
    }
    const s = await act(c.code, 'admin', { t: 'empezar' });
    return { code: c.code, t: s.torneo };
  }
  const current = (t) => t.rounds[t.currentRound].matches.filter((m) => m.status === 'pendiente');
  const nameOf = (t, teamId) => t.teams.find((x) => x.id === teamId).name.replace('Eq ', '');

  it('todos listos → se elige quién corre el partido (el de menos demora), cada uno recibe su ticket', async () => {
    const { code, t } = await torneo({ type: 'liga' }, ['ana', 'beto']);
    const m = current(t)[0];
    const [h, a] = [nameOf(t, m.home), nameOf(t, m.away)];
    let r = await act(code, h, { t: 'listo', match: m.id, rtt: 80 });
    expect(r.torneo.live[m.id].ready).toHaveLength(1);
    expect(r.torneo.live[m.id].state).toBe(null);
    // Alguien que no juega ese partido no puede marcarse listo
    expect((await act(code, 'intruso', { t: 'listo', match: m.id })).status).toBe(400);
    r = await act(code, a, { t: 'listo', match: m.id, rtt: 20 });
    const lv = r.torneo.live[m.id];
    expect(lv.state).toBe('creando');
    expect(lv.myTicket).toBeTruthy();
    expect(lv.hostConfig).toBeTruthy(); // el de 20 ms corre el partido
    expect(lv.hostConfig.rules.allowDraw).toBe(true);
    expect(Object.keys(lv.hostConfig.tickets)).toHaveLength(2);
    const other = (await act(code, h, { t: 'listo', match: m.id, rtt: 80 })).torneo.live[m.id];
    expect(other.hostConfig).toBeUndefined();
    expect(other.myTicket).toBeTruthy();
    expect(JSON.stringify((await call(`/${code}`, K('mirón'))).torneo.live)).not.toContain(other.myTicket);
  });

  it('dos jugadores mandan el mismo resultado final → se carga solo y la fecha avanza', async () => {
    const { code, t } = await torneo({ type: 'liga' }, ['ana', 'beto']);
    const m = current(t)[0];
    const [h, a] = [nameOf(t, m.home), nameOf(t, m.away)];
    await act(code, h, { t: 'listo', match: m.id, rtt: 10 });
    const lv = (await act(code, a, { t: 'listo', match: m.id, rtt: 50 })).torneo.live[m.id];
    const host = lv.host === lv.hostConfig?.selfTicket ? a : h;
    const hostView = (await act(code, h, { t: 'listo', match: m.id })).torneo.live[m.id];
    expect(hostView.hostConfig).toBeTruthy();
    await act(code, h, { t: 'sala_creada', match: m.id, session: hostView.hostConfig.session, room: 'ABCDE' });
    expect((await call(`/${code}`, K('mirón'))).torneo.live[m.id]).toMatchObject({ state: 'jugando', room: 'ABCDE' });
    await act(code, a, { t: 'marcador', match: m.id, gh: 1, ga: 0 });
    expect((await call(`/${code}`, K('mirón'))).torneo.live[m.id].score).toEqual([1, 0]);
    await act(code, h, { t: 'marcador', match: m.id, gh: 2, ga: 1, final: true });
    let v = (await call(`/${code}`, K('mirón'))).torneo;
    expect(v.rounds[0].matches[0].status).toBe('pendiente'); // con un solo informe espera
    await act(code, a, { t: 'marcador', match: m.id, gh: 2, ga: 1, final: true });
    await new Promise((r) => setTimeout(r, 50));
    v = (await call(`/${code}`, K('mirón'))).torneo;
    expect(v.rounds[0].matches[0]).toMatchObject({ status: 'jugado', gh: 2, ga: 1 });
    expect(v.status).toBe('terminado');
    expect(host).toBeTruthy();
  });

  it('si los resultados no coinciden queda en disputa (lo carga el admin)', async () => {
    const { code, t } = await torneo({ type: 'liga' }, ['ana', 'beto']);
    const m = current(t)[0];
    const [h, a] = [nameOf(t, m.home), nameOf(t, m.away)];
    await act(code, h, { t: 'listo', match: m.id });
    await act(code, a, { t: 'listo', match: m.id });
    await act(code, h, { t: 'marcador', match: m.id, gh: 3, ga: 0, final: true });
    await act(code, a, { t: 'marcador', match: m.id, gh: 0, ga: 3, final: true });
    const v = (await call(`/${code}`, K('mirón'))).torneo;
    expect(v.live[m.id].dispute).toBe(true);
    expect(v.rounds[0].matches[0].status).toBe('pendiente');
  });

  it('se cae la sala a mitad del partido → gana el que iba ganando; en copa, si iban empatados, se vuelve a jugar', async () => {
    const { code, t } = await torneo({ type: 'copa' }, ['ana', 'beto']);
    const m = current(t)[0];
    const [h, a] = [nameOf(t, m.home), nameOf(t, m.away)];
    const ready = async () => {
      await act(code, h, { t: 'listo', match: m.id, rtt: 1 });
      const lv = (await act(code, a, { t: 'listo', match: m.id, rtt: 99 })).torneo.live[m.id];
      const cfg = (await act(code, h, { t: 'listo', match: m.id, rtt: 1 })).torneo.live[m.id].hostConfig;
      expect(cfg.rules.allowDraw).toBe(false);
      await act(code, h, { t: 'sala_creada', match: m.id, session: cfg.session, room: 'ROOM1' });
      return lv;
    };
    await ready();
    await act(code, a, { t: 'marcador', match: m.id, gh: 1, ga: 1 });
    srv.torneos.roomClosed('ROOM1');
    await new Promise((r) => setTimeout(r, 50));
    let v = (await call(`/${code}`, K('mirón'))).torneo;
    expect(v.rounds[0].matches[0].status).toBe('pendiente'); // empate en copa: se vuelve a jugar
    expect(v.live[m.id]?.ready ?? []).toEqual([]);
    await ready();
    await act(code, a, { t: 'marcador', match: m.id, gh: 0, ga: 2 });
    srv.torneos.roomClosed('ROOM1');
    await new Promise((r) => setTimeout(r, 50));
    v = (await call(`/${code}`, K('mirón'))).torneo;
    expect(v.rounds[0].matches[0]).toMatchObject({ status: 'jugado', gh: 0, ga: 2 });
    expect(v.champion).toBe(m.away);
  });
});
