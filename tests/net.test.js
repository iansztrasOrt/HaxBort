import { describe, it, expect } from 'vitest';
import { loadStadium } from '../shared/stadium/load.js';
import { createMatch, addPlayer, startMatch, tick, setInput, INPUT } from '../shared/game/match.js';
import { botInput } from '../shared/game/bot.js';
import { BUILTIN_MAPS } from '../shared/builtinMaps.js';
import { snapshotBody, withAck, decodeSnapshot, applySnapshot, encodeInput, decodeInput } from '../shared/net/protocol.js';
import { Room } from '../shared/room/room.js';

const stadium = () => loadStadium(BUILTIN_MAPS[0].text).stadium;

function playMatch(n) {
  const m = createMatch(stadium(), {});
  const ids = [['a', 'red'], ['b', 'red'], ['c', 'blue'], ['d', 'blue'], ['e', 'spectator']];
  for (const [id, team] of ids) addPlayer(m, { id, name: id, team });
  startMatch(m);
  for (let i = 0; i < n; i += 1) {
    for (const [id] of ids) setInput(m, id, botInput(m, id, { skill: 0.9 }));
    tick(m);
  }
  return { m, ids };
}

describe('protocolo', () => {
  it('entrada con redundancia', () => {
    const list = decodeInput(encodeInput(10, INPUT.kick | INPUT.up, INPUT.up, 0));
    expect(list).toEqual([{ seq: 8, bits: 0 }, { seq: 9, bits: INPUT.up }, { seq: 10, bits: INPUT.kick | INPUT.up }]);
    expect(decodeInput(encodeInput(1, 4))).toEqual([{ seq: 1, bits: 4 }]);
  });

  it('la foto restaura el partido exacto y la simulación sigue idéntica', () => {
    const { m, ids } = playMatch(400);
    const snap = decodeSnapshot(withAck(snapshotBody(m), 77));
    expect(snap.ack).toBe(77);
    const c = createMatch(stadium(), {});
    applySnapshot(c, snap);
    expect(c.world.discs.length).toBe(m.world.discs.length);
    expect(c.phase).toBe(m.phase);
    expect(c.score).toEqual(m.score);
    for (let i = 0; i < 300; i += 1) {
      for (const [id] of ids) {
        const bits = botInput(m, id, { skill: 0.9 });
        setInput(m, id, bits);
        setInput(c, id, bits);
      }
      tick(m);
      tick(c);
    }
    const pos = (x) => x.world.discs.map((d) => [d.x, d.y, d.vx, d.vy]);
    expect(pos(c)).toEqual(pos(m));
    expect(c.score).toEqual(m.score);
    expect(c.ticks).toBe(m.ticks);
  });

  it('aplicar una foto sobre un partido ya en curso reusa discos y quita los que sobran', () => {
    const { m } = playMatch(100);
    const c = createMatch(stadium(), {});
    applySnapshot(c, decodeSnapshot(withAck(snapshotBody(m), 1)));
    const disc = c.players.find((p) => p.id === 'a').disc;
    applySnapshot(c, decodeSnapshot(withAck(snapshotBody(m), 2)));
    expect(c.players.find((p) => p.id === 'a').disc).toBe(disc);
    m.players = m.players.filter((p) => p.id !== 'b');
    m.world.discs = m.world.discs.filter((d) => d.playerId !== 'b');
    applySnapshot(c, decodeSnapshot(withAck(snapshotBody(m), 3)));
    expect(c.players.map((p) => p.id)).not.toContain('b');
    expect(c.world.discs.length).toBe(m.world.discs.length);
  });
});

function fakeRoom(opts = {}) {
  const sent = [];
  const closed = [];
  const room = new Room({ code: 'ABCDE', name: 'Prueba', ...opts }, {
    send: (id, msg) => sent.push({ id, msg }),
    close: (id, reason) => closed.push({ id, reason }),
  });
  return { room, sent, closed };
}

describe('sala', () => {
  it('el primero es admin; los demás entran como espectadores', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'Ian', avatar: '10' });
    const b = room.addMember({ name: 'ian', avatar: '' });
    expect(a.member.admin).toBe(true);
    expect(b.member.admin).toBe(false);
    expect(b.member.name).toBe('ian 2');
    expect(b.member.team).toBe('spectator');
  });

  it('contraseña y cupo', () => {
    const { room } = fakeRoom({ password: 'pelota', maxPlayers: 2 });
    expect(room.addMember({ name: 'A' }).error).toBe('password');
    expect(room.addMember({ name: 'A', password: 'x' }).error).toBe('bad_password');
    expect(room.addMember({ name: 'A', password: 'pelota' }).ok).toBe(true);
    expect(room.addMember({ name: 'B', password: 'pelota' }).ok).toBe(true);
    expect(room.addMember({ name: 'C', password: 'pelota' }).error).toBe('full');
  });

  it('permisos de admin, bloqueo de equipos y comandos', () => {
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'Admin' }).id;
    const b = room.addMember({ name: 'Beto' }).id;
    room.handle(b, { t: 'team', id: b, team: 'blue' });
    expect(room.members.get(b).team).toBe('blue');
    room.handle(b, { t: 'start' });
    expect(room.match.phase).toBe('idle');
    room.handle(a, { t: 'lock' });
    room.handle(b, { t: 'team', id: b, team: 'red' });
    expect(room.members.get(b).team).toBe('blue');
    room.handle(a, { t: 'chat', text: '/rojo' });
    expect(room.members.get(a).team).toBe('red');
    room.handle(a, { t: 'chat', text: '/bot azul' });
    expect([...room.members.values()].filter((m) => m.bot && m.team === 'blue').length).toBe(1);
    room.handle(a, { t: 'chat', text: '/mapa hockey' });
    expect(room.map.key).toBe('b:hockey');
    room.handle(a, { t: 'chat', text: '/empezar' });
    expect(room.match.phase).toBe('kickoff');
    room.handle(a, { t: 'map', builtin: 'chica' });
    expect(room.map.key).toBe('b:hockey'); // no se cambia en pleno partido
    expect(sent.some((s) => s.id === b && s.msg.t === 'sys' && /solo el admin/.test(s.msg.text))).toBe(true);
  });

  it('si el admin se va, pasa a otro; echar avisa por el transporte', () => {
    const { room, closed } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const b = room.addMember({ name: 'B' }).id;
    const c = room.addMember({ name: 'C', ip: '1.2.3.4' }).id;
    room.handle(a, { t: 'kick', id: c, ban: true });
    expect(closed[0].id).toBe(c);
    expect(room.addMember({ name: 'C', ip: '1.2.3.4' }).error).toBe('banned');
    room.handle(a, { t: 'leave' });
    expect(room.members.get(b).admin).toBe(true);
  });

  it('cada tick manda una foto con el ack de cada jugador y un gol se anuncia', () => {
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    room.handle(a, { t: 'team', id: a, team: 'red' });
    room.handle(a, { t: 'start' });
    room.input(a, decodeInput(encodeInput(1, INPUT.right)));
    room.input(a, decodeInput(encodeInput(2, INPUT.right, INPUT.right)));
    sent.length = 0;
    room.step();
    const snaps = sent.filter((s) => s.msg instanceof ArrayBuffer);
    expect(snaps.length).toBe(1);
    expect(decodeSnapshot(snaps[0].msg).ack).toBe(1);
    room.step();
    expect(decodeSnapshot(sent.filter((s) => s.msg instanceof ArrayBuffer)[1].msg).ack).toBe(2);
    // Gol: pelota justo antes de la línea, con velocidad hacia el arco azul.
    const ball = room.match.world.discs[0];
    room.match.phase = 'playing';
    ball.x = room.stadium.goals.find((g) => g.team === 'blue').p0[0] - 2;
    ball.y = 0;
    ball.vx = 8;
    for (let i = 0; i < 3; i += 1) room.step();
    expect(room.match.score.red).toBe(1);
    expect(sent.some((s) => s.msg.t === 'ev' && s.msg.events.some((e) => e.type === 'goal'))).toBe(true);
  });

  it('cola de entradas: si se juntan, salta a la más nueva sin perder la patada', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const m = room.members.get(a);
    room.input(a, [{ seq: 1, bits: INPUT.kick }, { seq: 2, bits: 0 }, { seq: 3, bits: 0 }, { seq: 4, bits: INPUT.up }]);
    room.consumeInput(m);
    expect(m.lastSeq).toBe(3);
    expect(m.bits & INPUT.kick).toBe(INPUT.kick);
    room.consumeInput(m);
    expect(m.lastSeq).toBe(4);
    expect(m.bits).toBe(INPUT.up);
  });

  it('desconectado: guarda el lugar y se puede volver con el secreto', () => {
    const { room } = fakeRoom();
    const r = room.addMember({ name: 'A' });
    room.disconnect(r.id);
    expect(room.resume(r.id, 'mal')).toBe(false);
    expect(room.resume(r.id, r.secret)).toBe(true);
    expect(room.members.get(r.id).connected).toBe(true);
  });
});
