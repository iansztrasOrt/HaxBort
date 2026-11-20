import { describe, it, expect, afterAll } from 'vitest';
import WebSocket from 'ws';
import { Room } from '../shared/room/room.js';
import { createServer } from '../server/index.js';

const fakeRoom = () => new Room({ code: 'TEST', name: 't' }, { send() {}, close() {} });

describe('entrar a una sala es idempotente', () => {
  it('el mismo clientId recibe el mismo jugador (nunca "Juan 2")', () => {
    const room = fakeRoom();
    room.addMember({ name: 'Host', clientId: 'h' });
    const ids = new Set();
    for (let i = 0; i < 5; i += 1) {
      const r = room.addMember({ name: 'Juan', clientId: 'tab-1' });
      expect(r.ok).toBe(true);
      ids.add(r.id);
      if (i > 0) expect(r.rejoin).toBe(true);
    }
    expect(ids.size).toBe(1);
    expect(room.members.size).toBe(2);
    expect([...room.members.values()].filter((m) => m.name.startsWith('Juan'))).toHaveLength(1);
  });

  it('otra pestaña (otro clientId) sí es otro jugador; un lugar guardado se recupera', () => {
    const room = fakeRoom();
    const a = room.addMember({ name: 'Juan', clientId: 'tab-1' });
    const b = room.addMember({ name: 'Juan', clientId: 'tab-2' });
    expect(a.id).not.toBe(b.id);
    room.disconnect(a.id);
    const again = room.addMember({ name: 'Juan', clientId: 'tab-1' });
    expect(again.id).toBe(a.id);
    expect(room.members.get(a.id).connected).toBe(true);
  });

  it('el clientId no se manda a los demás jugadores', () => {
    const room = fakeRoom();
    room.addMember({ name: 'Juan', clientId: 'secreto-123' });
    expect(JSON.stringify(room.state())).not.toContain('secreto-123');
  });
});

describe('servidor: pedidos repetidos', () => {
  const srv = createServer({ port: 0, html: '<!doctype html>', log: () => {} });
  afterAll(() => srv.close());
  const url = () => `ws://127.0.0.1:${srv.server.address().port}/ws`;
  const connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(url());
    ws.msgs = [];
    ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(String(d))); });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout');
  };
  const send = (ws, o) => ws.send(JSON.stringify(o));

  it('5 clics seguidos en "Entrar" (sala del servidor) dejan un solo jugador y cada respuesta trae su rid', async () => {
    if (!srv.server.listening) await new Promise((r) => srv.server.once('listening', r));
    const host = await connect();
    send(host, { t: 'create', mode: 'server', room: { name: 'S' }, name: 'Host', clientId: 'host' });
    const hosted = await until(() => host.msgs.find((m) => m.t === 'welcome'));
    const code = hosted.code;
    const guest = await connect();
    for (let i = 0; i < 5; i += 1) send(guest, { t: 'join', code, name: 'Juan', clientId: 'juan-tab', rid: `r${i}` });
    await until(() => guest.msgs.filter((m) => m.t === 'welcome').length === 5);
    const welcomes = guest.msgs.filter((m) => m.t === 'welcome');
    expect(new Set(welcomes.map((w) => w.id)).size).toBe(1);
    expect(welcomes.map((w) => w.rid)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    const room = srv.rooms.get(code).room;
    expect([...room.members.values()].filter((m) => !m.bot).map((m) => m.name).sort()).toEqual(['Host', 'Juan']);
    // y sigue en la sala (el pedido repetido no lo sacó)
    expect(room.members.get(welcomes[0].id).connected).toBe(true);
    host.close();
    guest.close();
  });

  it('un error vuelve con el rid del pedido', async () => {
    const ws = await connect();
    send(ws, { t: 'join', code: 'ZZZZZ', name: 'Juan', rid: 'abc' });
    const err = await until(() => ws.msgs.find((m) => m.t === 'error'));
    expect(err.code).toBe('not_found');
    expect(err.rid).toBe('abc');
    ws.close();
  });
});
