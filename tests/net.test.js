import { describe, it, expect } from 'vitest';
import { loadStadium } from '../shared/stadium/load.js';
import { createMatch, addPlayer, startMatch, tick, setInput, INPUT, FIRST_TIME_BOOST } from '../shared/game/match.js';
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

describe('radio de la pelota', () => {
  const ballR = (room) => room.match.world.discs.find((d) => d.kind === 'ball').r;
  it('el admin lo elige de 3 a 10; se mantiene en el saque, después de un gol y al cambiar de estadio', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'Admin' }).id;
    const mapR = room.stadium.discs[0].radius;
    expect(ballR(room)).toBe(mapR);
    expect(room.handle(a, { t: 'rules', ball: 9 })).toBe(true);
    expect(room.settings.ballRadius).toBe(9);
    expect(ballR(room)).toBe(9);
    expect(room.state().settings.ballRadius).toBe(9);
    room.moveTo(a, 'red');
    room.start();
    expect(ballR(room)).toBe(9);
    // gol → nuevo saque: la pelota sigue con radio 9
    const m = room.match;
    m.phase = 'playing';
    const ball = m.world.discs[0];
    ball.x = room.stadium.goals.find((g) => g.team === 'blue').p0[0] - 2;
    ball.y = 0;
    ball.vx = 8;
    for (let i = 0; i < 400 && m.phase !== 'kickoff'; i += 1) room.step();
    expect(m.score.red).toBe(1);
    expect(ballR(room)).toBe(9);
    room.handle(a, { t: 'stop' });
    room.handle(a, { t: 'chat', text: '/mapa grande' });
    expect(ballR(room)).toBe(9);
    room.handle(a, { t: 'chat', text: '/pelota 3' });
    expect(ballR(room)).toBe(3);
    room.handle(a, { t: 'chat', text: '/pelota default' });
    expect(room.settings.ballRadius).toBe(null);
    expect(ballR(room)).toBe(room.stadium.discs[0].radius);
  });

  it('rechaza valores fuera de rango y no deja cambiarlo a otros ni con el partido en juego', () => {
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'Admin' }).id;
    const b = room.addMember({ name: 'Otro' }).id;
    for (const bad of [2, 11, 7.5, 'x', -1]) {
      room.handle(a, { t: 'rules', ball: bad });
      expect(room.settings.ballRadius).toBe(null);
    }
    expect([...sent].reverse().find((s) => s.id === a && s.msg.t === 'sys').msg.text).toMatch(/entre 3 y 10/);
    room.handle(b, { t: 'rules', ball: 6 });
    expect(room.settings.ballRadius).toBe(null);
    room.moveTo(a, 'red');
    room.start();
    room.handle(a, { t: 'rules', ball: 6 });
    expect(room.settings.ballRadius).toBe(null);
  });
});

describe('flechitas de equipos y fila de espera', () => {
  it('equipo → espera (al final de la fila) y primero de la fila → equipo', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'Admin' }).id;
    const ids = ['B', 'C', 'D'].map((n) => room.addMember({ name: n }).id);
    room.moveTo(ids[0], 'red');
    room.moveTo(ids[1], 'red');
    room.handle(a, { t: 'clearteam', team: 'red' });
    expect([...room.members.values()].filter((m) => m.team === 'red')).toHaveLength(0);
    expect(room.waitingLine().map((m) => m.name)).toEqual(['Admin', 'D', 'B', 'C']);
    room.handle(a, { t: 'pullnext', team: 'blue' });
    expect(room.members.get(a).team).toBe('blue');
    room.handle(a, { t: 'pullnext', team: 'red' });
    expect(room.members.get(ids[2]).team).toBe('red');
    expect(room.waitingLine().map((m) => m.name)).toEqual(['B', 'C']);
  });

  it('solo el admin puede usarlas', () => {
    const { room } = fakeRoom();
    room.addMember({ name: 'Admin' });
    const b = room.addMember({ name: 'B' }).id;
    room.handle(b, { t: 'pullnext', team: 'red' });
    expect(room.members.get(b).team).toBe('spectator');
  });
});

describe('fotos', () => {
  it('jugando: los que juegan reciben 60 por segundo y los que miran 30', () => {
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const s = room.addMember({ name: 'Mira' }).id;
    room.moveTo(a, 'red');
    room.start();
    sent.length = 0;
    for (let i = 0; i < 60; i += 1) room.step();
    const snaps = (id) => sent.filter((x) => x.id === id && x.msg instanceof ArrayBuffer).length;
    expect(snaps(a)).toBe(60);
    expect(snaps(s)).toBe(30);
  });
});

describe('camisetas y privacidad', async () => {
  const { cleanKit, DEFAULT_KITS, KIT_PATTERNS, KIT_PRESETS } = await import('../shared/game/kits.js');
  it('cleanKit valida diseño, colores, ángulo, número y borde', () => {
    expect(cleanKit({ pattern: 'bastones', colors: ['#75AADB', 'fff', 'zzz'], angle: 370, text: '000', border: '#123456' }, DEFAULT_KITS.red))
      .toEqual({ pattern: 'bastones', colors: ['75aadb', 'ffffff', DEFAULT_KITS.red.colors[2]], angle: 10, text: '000000', border: '123456' });
    expect(cleanKit({ pattern: 'inventado' }, DEFAULT_KITS.red)).toBe(null);
    expect(cleanKit('x', DEFAULT_KITS.red)).toBe(null);
    for (const p of KIT_PRESETS) expect(cleanKit(p.kit, DEFAULT_KITS.red)).toEqual(p.kit);
    expect(KIT_PATTERNS.length).toBeGreaterThanOrEqual(15);
  });

  it('solo el admin cambia la camiseta; todos la reciben en el estado; "Al azar" da otra distinta', async () => {
    const { kitsTooSimilar } = await import('../shared/game/kits.js');
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const b = room.addMember({ name: 'B' }).id;
    room.handle(a, { t: 'kit', team: 'blue', kit: { pattern: 'liso', colors: ['143d8c', '143d8c', '143d8c'], text: 'ffffff' } }); // azul oscuro fijo
    const before = { ...room.settings.kits.red };
    room.handle(b, { t: 'kit', team: 'red', kit: { pattern: 'cuadros' } });
    expect(room.settings.kits.red).toEqual(before);
    room.handle(a, { t: 'kit', team: 'red', kit: { pattern: 'cuadros', colors: ['111111', 'ffffff', '000000'] } });
    expect(room.state().settings.kits.red).toMatchObject({ pattern: 'cuadros', colors: ['111111', 'ffffff', '000000'] });
    for (let i = 0; i < 30; i += 1) {
      room.handle(a, { t: 'kit', team: 'blue', reset: true });
      expect(kitsTooSimilar(room.settings.kits.blue, room.settings.kits.red)).toBe(false);
    }
    // Una casi igual a la del otro equipo se rechaza
    const copy = { ...room.settings.kits.blue };
    room.handle(a, { t: 'kit', team: 'red', kit: copy });
    expect(room.settings.kits.red.pattern).toBe('cuadros');
    expect([...sent].reverse().find((x) => x.id === a && x.msg.t === 'sys').msg.text).toMatch(/se parece mucho/);
  });

  it('camisetas iniciales al azar: Rojo con colores cálidos, Azul con fríos, nunca parecidas', async () => {
    const { kitsTooSimilar, luminance } = await import('../shared/game/kits.js');
    const hue = (h) => {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
      if (!d) return null;
      const x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (x * 60 + 360) % 360;
    };
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const { room } = fakeRoom();
      const { red, blue } = room.settings.kits;
      expect(kitsTooSimilar(red, blue)).toBe(false);
      const hr = hue(red.colors[0]);
      const hb = hue(blue.colors[0]);
      expect(hr <= 60 || hr >= 300).toBe(true); // rojos, naranjas, amarillos, fucsias
      expect(hb >= 120 && hb <= 300).toBe(true); // verdes, celestes, azules, violetas
      expect(red.text === '111111' || red.text === 'ffffff').toBe(true);
      expect(luminance(red.colors[0])).toBeGreaterThanOrEqual(0);
      seen.add(`${red.pattern}:${red.colors[0]}`);
    }
    expect(seen.size).toBeGreaterThan(30); // de verdad al azar
  });
  it('privacidad: pública/privada, contraseña y cupo, solo el admin', () => {
    const { room, sent } = fakeRoom({ maxPlayers: 10 });
    const a = room.addMember({ name: 'A' }).id;
    const b = room.addMember({ name: 'B' }).id;
    room.handle(b, { t: 'roomcfg', isPublic: false });
    expect(room.isPublic).toBe(true);
    room.handle(a, { t: 'roomcfg', isPublic: false });
    expect(room.isPublic).toBe(false);
    expect(room.state().isPublic).toBe(false);
    room.handle(a, { t: 'roomcfg', password: 'secreta' });
    expect(room.state().hasPassword).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('secreta');
    expect(room.addMember({ name: 'C' }).error).toBe('password');
    room.handle(a, { t: 'roomcfg', password: '' });
    expect(room.addMember({ name: 'C' }).ok).toBe(true);
    room.handle(a, { t: 'roomcfg', maxPlayers: 2 });
    expect(room.maxPlayers).toBe(10);
    room.handle(a, { t: 'roomcfg', maxPlayers: 5 });
    expect(room.maxPlayers).toBe(5);
  });
});

describe('fuerza de la patada', () => {
  // Patea una vez con el jugador pegado a la pelota y devuelve la velocidad con que sale.
  function kickSpeed(room, id) {
    room.moveTo(id, 'red');
    room.start();
    const m = room.match;
    const p = m.players.find((x) => x.id === id);
    const ball = m.world.discs.find((d) => d.kind === 'ball');
    Object.assign(ball, { x: 0, y: 0, vx: 0, vy: 0 });
    Object.assign(p.disc, { x: -(p.disc.r + ball.r + 1), y: 0, vx: 0, vy: 0 });
    m.phase = 'playing';
    room.input(id, [{ seq: 1, bits: INPUT.kick }]);
    room.step();
    return Math.hypot(ball.vx, ball.vy);
  }

  it('la elige el admin (2 a 10, de a medio punto) y la pelota sale más fuerte', () => {
    const base = (() => { const { room } = fakeRoom(); const a = room.addMember({ name: 'A' }).id; return kickSpeed(room, a); })();
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    room.handle(a, { t: 'rules', kick: 8 });
    expect(room.settings.kickStrength).toBe(8);
    expect(room.match.stadium.playerPhysics.kickStrength).toBe(8);
    expect(room.state().settings.kickStrength).toBe(8);
    const strong = kickSpeed(room, a);
    expect(strong).toBeGreaterThan(base * 1.4);
  });

  it('rechaza valores raros; /patada y /patada default', () => {
    const { room, sent } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    for (const bad of [1, 11, 7.3, 'x', -2]) {
      room.handle(a, { t: 'rules', kick: bad });
      expect(room.settings.kickStrength).toBe(null);
    }
    expect([...sent].reverse().find((x) => x.id === a && x.msg.t === 'sys').msg.text).toMatch(/patada/);
    room.handle(a, { t: 'chat', text: '/patada 6,5' });
    expect(room.settings.kickStrength).toBe(6.5);
    room.handle(a, { t: 'chat', text: '/patada default' });
    expect(room.settings.kickStrength).toBe(null);
    expect(room.match.stadium.playerPhysics.kickStrength).toBe(room.stadium.playerPhysics.kickStrength);
    // y no rompe /kick (echar)
    const b = room.addMember({ name: 'Bruno' }).id;
    room.handle(a, { t: 'chat', text: '/kick Bruno' });
    expect(room.members.has(b)).toBe(false);
  });
});

describe('golpeo de primera fuerte', () => {
  // El jugador espera con la patada apretada y la pelota le llega (de primera),
  // o aprieta recién cuando la tiene al lado (normal). Devuelve la velocidad de la pelota.
  function shot(room, id, { held }) {
    room.moveTo(id, 'red');
    room.start();
    const m = room.match;
    const p = m.players.find((x) => x.id === id);
    const ball = m.world.discs.find((d) => d.kind === 'ball');
    m.phase = 'playing';
    Object.assign(p.disc, { x: -60, y: 0, vx: 0, vy: 0 });
    let seq = 0;
    if (held) {
      // Patada apretada con la pelota lejos: todavía no patea.
      Object.assign(ball, { x: 100, y: 0, vx: 0, vy: 0 });
      for (let i = 0; i < 3; i += 1) {
        room.input(id, [{ seq: ++seq, bits: INPUT.kick }]);
        room.step();
      }
      expect(Math.hypot(ball.vx, ball.vy)).toBe(0);
    }
    Object.assign(ball, { x: p.disc.x + p.disc.r + ball.r + 1, y: 0, vx: 0, vy: 0 });
    Object.assign(p.disc, { vx: 0, vy: 0 });
    room.input(id, [{ seq: ++seq, bits: INPUT.kick }]);
    room.step();
    return Math.hypot(ball.vx, ball.vy);
  }
  const fresh = () => { const { room } = fakeRoom(); const a = room.addMember({ name: 'A' }).id; return { room, a }; };

  it('viene activado: de primera sale un 25% más fuerte; apretando con la pelota al lado, igual que antes', () => {
    const x = fresh();
    expect(x.room.settings.strongFirst).toBe(true);
    const normal = shot(x.room, x.a, { held: false });
    const y = fresh();
    const primera = shot(y.room, y.a, { held: true });
    expect(normal).toBeGreaterThan(1);
    expect(primera / normal).toBeCloseTo(FIRST_TIME_BOOST, 5);
  });

  it('desactivado: todas las patadas iguales', () => {
    const x = fresh();
    const normal = shot(x.room, x.a, { held: false });
    const y = fresh();
    y.room.handle(y.a, { t: 'roomcfg', strongFirst: false });
    expect(y.room.state().settings.strongFirst).toBe(false);
    expect(shot(y.room, y.a, { held: true })).toBeCloseTo(normal, 9);
  });

  it('solo el admin lo cambia, se puede en pleno partido y viaja en la foto', () => {
    const { room } = fakeRoom();
    const a = room.addMember({ name: 'A' }).id;
    const b = room.addMember({ name: 'B' }).id;
    room.moveTo(a, 'red');
    room.start();
    room.handle(b, { t: 'roomcfg', strongFirst: false });
    expect(room.settings.strongFirst).toBe(true);
    room.handle(a, { t: 'roomcfg', strongFirst: false });
    expect(room.settings.strongFirst).toBe(false);
    expect(room.match.settings.strongFirst).toBe(false);
    // los invitados lo reciben en la foto (para predecir la patada igual que el anfitrión)
    const local = createMatch(stadium(), { strongFirst: true });
    applySnapshot(local, decodeSnapshot(withAck(snapshotBody(room.match), 0)));
    expect(local.settings.strongFirst).toBe(false);
    room.handle(a, { t: 'roomcfg', strongFirst: true });
    applySnapshot(local, decodeSnapshot(withAck(snapshotBody(room.match), 0)));
    expect(local.settings.strongFirst).toBe(true);
  });
});
