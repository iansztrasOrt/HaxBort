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

  it('cola de entradas: un pico de jitter se consume de a una (sin descartar nada)', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const m = room.members.get(a);
    room.input(a, [{ seq: 1, bits: INPUT.kick }, { seq: 2, bits: 0 }, { seq: 3, bits: 0 }, { seq: 4, bits: INPUT.up }]);
    for (const [seq, bits] of [[1, INPUT.kick], [2, 0], [3, 0], [4, INPUT.up]]) {
      room.consumeInput(m);
      expect(m.lastSeq).toBe(seq);
      expect(m.bits).toBe(bits);
    }
    room.consumeInput(m); // cola vacía: repite la última
    expect(m.lastSeq).toBe(4);
    expect(m.bits).toBe(INPUT.up);
  });

  it('cola de entradas: la demora que sobra de forma sostenida se recorta sin perder la patada', () => {
    for (let kickAt = 20; kickAt < 40; kickAt += 1) {
      const { room } = fakeRoom();
      const a = room.addMember({ name: 'A' }).id;
      const m = room.members.get(a);
      let seq = 0;
      room.input(a, [1, 2, 3].map(() => ({ seq: ++seq, bits: 0 })));
      let skipped = 0;
      let kicks = 0;
      for (let t = 0; t < 120; t += 1) {
        room.input(a, [{ seq: ++seq, bits: t === kickAt ? INPUT.kick : 0 }]);
        const before = m.lastSeq;
        room.consumeInput(m);
        if (m.lastSeq - before > 1) skipped += 1;
        if (m.bits & INPUT.kick) kicks += 1;
      }
      expect(skipped).toBeGreaterThan(0);
      expect(kicks).toBe(1);
      expect(m.queue.length).toBeLessThanOrEqual(2);
    }
  });

  it('cola de entradas: después de un corte largo se pone al día de golpe', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const m = room.members.get(a);
    const list = Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, bits: i === 3 ? INPUT.kick : 0 }));
    room.input(a, list);
    room.consumeInput(m);
    expect(m.queue.length).toBeLessThanOrEqual(2);
    expect(m.bits & INPUT.kick).toBe(INPUT.kick);
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

describe('reglas y cupo', () => {
  const admin = () => {
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'Admin' }).id;
    return { room, sent, a };
  };
  const lastSys = (sent, id) => [...sent].reverse().find((s) => s.id === id && s.msg.t === 'sys')?.msg.text || '';

  it('valores personalizados: 7 minutos y 13 goles', () => {
    const { room, a } = admin();
    expect(room.handle(a, { t: 'rules', time: 7, score: 13 })).toBe(true);
    expect(room.settings).toMatchObject({ timeLimit: 7, scoreLimit: 13 });
    expect(room.match.settings).toMatchObject({ timeLimit: 7, scoreLimit: 13 });
    expect(room.state().settings).toMatchObject({ timeLimit: 7, scoreLimit: 13 });
    room.handle(a, { t: 'chat', text: '/tiempo 7.5' });
    expect(room.settings.timeLimit).toBe(7.5);
    room.handle(a, { t: 'chat', text: '/goles 0' });
    expect(room.settings.scoreLimit).toBe(0);
  });

  it('rechaza valores inválidos o absurdos y avisa, sin cambiar nada', () => {
    const { room, sent, a } = admin();
    for (const bad of [{ time: -1 }, { time: 61 }, { time: 'abc' }, { time: Infinity }, { score: 100 }, { score: 2.5 }, { score: -3 }, { score: 'x' }]) {
      room.handle(a, { t: 'rules', ...bad });
      expect(room.settings).toMatchObject({ timeLimit: 3, scoreLimit: 3 });
      expect(lastSys(sent, a)).toMatch(/tiene que|tienen que/);
    }
  });

  it('el partido termina al llegar al límite de goles personalizado', () => {
    const { room, a } = admin();
    room.handle(a, { t: 'rules', time: 0, score: 13 });
    room.moveTo(a, 'red');
    room.addBot('blue');
    room.start();
    const m = room.match;
    m.score.red = 12;
    const ball = m.world.discs[0];
    m.phase = 'playing';
    ball.x = room.stadium.goals.find((g) => g.team === 'blue').p0[0] - 2;
    ball.y = 0;
    ball.vx = 8;
    for (let i = 0; i < 400 && m.phase !== 'ended'; i += 1) room.step();
    expect(m.score.red).toBe(13);
    expect(m.phase).toBe('ended');
    expect(m.winner).toBe('red');
  });

  it('el reloj respeta el tiempo personalizado (7 min)', () => {
    const { room, a } = admin();
    room.handle(a, { t: 'rules', time: 7, score: 0 });
    room.moveTo(a, 'red');
    room.start();
    const m = room.match;
    m.phase = 'playing';
    m.score.red = 1;
    m.ticks = 7 * 60 * 60 - 2;
    for (let i = 0; i < 5; i += 1) room.step();
    expect(m.phase).toBe('ended');
  });

  it('sin tope por equipo: todos pueden ir al mismo equipo; el cupo es de la sala entera', () => {
    const { room } = fakeRoom({ maxPlayers: 7 });
    const ids = [];
    for (let i = 0; i < 7; i += 1) ids.push(room.addMember({ name: `J${i}` }).id);
    for (const id of ids) expect(room.moveTo(id, 'red')).toBe(true);
    expect([...room.members.values()].filter((m) => m.team === 'red')).toHaveLength(7);
    expect(room.addMember({ name: 'J8' }).error).toBe('full');
  });
});
