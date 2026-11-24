import { describe, it, expect } from 'vitest';
import { Room } from '../shared/room/room.js';
import { TICK_RATE } from '../shared/game/match.js';

const cfg = (extra = {}) => ({
  code: 'ABCDEF', match: 'p3', session: 's1', title: 'Liga · Fecha 1',
  home: { name: 'Halcones', kit: { pattern: 'bastones', colors: ['75aadb', 'ffffff', '000000'] } }, away: { name: 'Rayo FC' },
  tickets: { 'tk-local-1': { team: 'red', pid: 'a' }, 'tk-local-2': { team: 'red', pid: 'b' }, 'tk-visita-1': { team: 'blue', pid: 'c' }, 'tk-visita-2': { team: 'blue', pid: 'd' } },
  rules: { time: 2, score: 0, ballRadius: 6, map: 'chica', allowDraw: true },
  ...extra,
});
function sala(extra) {
  const sent = [];
  const room = new Room({ code: 'SALA1', name: 'x', maxPlayers: 30, torneo: cfg(extra) }, { send: (id, msg) => sent.push({ id, msg }), close() {} });
  return { room, sent };
}
const ticks = (room, n) => { for (let i = 0; i < n; i += 1) room.step(); };
const lastSys = (sent) => [...sent].reverse().find((s) => s.msg.t === 'sys')?.msg.text || '';

describe('sala de partido de torneo', () => {
  it('reglas, camisetas y estadio del torneo; nadie es admin; cada ticket va a su equipo', () => {
    const { room } = sala();
    expect(room.settings).toMatchObject({ timeLimit: 2, scoreLimit: 0, ballRadius: 6 });
    expect(room.settings.kits.red.pattern).toBe('bastones');
    expect(room.map.name).toBe('Chica');
    const a = room.addMember({ name: 'Ana', ticket: 'tk-local-1' });
    const c = room.addMember({ name: 'Caro', ticket: 'tk-visita-1' });
    const x = room.addMember({ name: 'Mirón', ticket: 'cualquiera' });
    expect(a.member.admin).toBe(false);
    expect(a.member.team).toBe('red');
    expect(c.member.team).toBe('blue');
    expect(x.member.team).toBe('spectator');
    expect(JSON.stringify(room.state())).not.toContain('tk-local');
  });

  it('nadie puede mover equipos, cambiar reglas ni terminar el partido', () => {
    const { room, sent } = sala();
    const a = room.addMember({ name: 'Ana', ticket: 'tk-local-1' }).id;
    for (const msg of [{ t: 'team', id: a, team: 'blue' }, { t: 'stop' }, { t: 'rules', time: 9 }, { t: 'start' }, { t: 'map', builtin: 'grande' }, { t: 'kick', id: a }]) {
      room.handle(a, msg);
      expect(lastSys(sent)).toMatch(/torneo/);
    }
    expect(room.members.get(a).team).toBe('red');
    room.handle(a, { t: 'chat', text: '/parar' });
    expect(room.match.phase).toBe('idle');
  });

  it('arranca solo cuando están todos (a los 3 s); el mismo jugador no se duplica', () => {
    const { room } = sala();
    for (const tk of ['tk-local-1', 'tk-local-2', 'tk-visita-1']) room.addMember({ name: tk, ticket: tk });
    ticks(room, 5 * TICK_RATE);
    expect(room.match.phase).toBe('idle');
    room.addMember({ name: 'D', ticket: 'tk-visita-2', clientId: 'otra-pestaña' });
    room.addMember({ name: 'D', ticket: 'tk-visita-2', clientId: 'otra-pestaña-2' });
    expect([...room.members.values()].filter((m) => m.team === 'blue')).toHaveLength(2);
    ticks(room, 3 * TICK_RATE + 2);
    expect(room.match.phase).not.toBe('idle');
    expect(room.torneo.state).toBe('jugando');
  });

  it('si falta alguien, arranca al minuto con al menos uno por equipo', () => {
    const { room } = sala();
    room.addMember({ name: 'A', ticket: 'tk-local-1' });
    ticks(room, 61 * TICK_RATE);
    expect(room.match.phase).toBe('idle');
    room.addMember({ name: 'C', ticket: 'tk-visita-1' });
    ticks(room, 2);
    expect(room.torneo.state).toBe('jugando');
  });

  it('pausa con 3 votos (sigue con 3 votos o solo al minuto); con menos de 3 jugadores no se puede', () => {
    const { room, sent } = sala();
    const ids = ['tk-local-1', 'tk-local-2', 'tk-visita-1', 'tk-visita-2'].map((tk) => room.addMember({ name: tk, ticket: tk }).id);
    ticks(room, 4 * TICK_RATE);
    room.handle(ids[0], { t: 'pausevote' });
    room.handle(ids[1], { t: 'pausevote' });
    expect(room.paused).toBe(false);
    expect(lastSys(sent)).toMatch(/2\/3/);
    room.handle(ids[2], { t: 'chat', text: '/pausa' });
    expect(room.paused).toBe(true);
    ticks(room, 61 * TICK_RATE);
    expect(room.paused).toBe(false);
    const { room: r2, sent: s2 } = sala({ tickets: { 'tk-local-1': { team: 'red' }, 'tk-visita-1': { team: 'blue' } } });
    const p = r2.addMember({ name: 'A', ticket: 'tk-local-1' }).id;
    r2.addMember({ name: 'C', ticket: 'tk-visita-1' });
    ticks(r2, 4 * TICK_RATE);
    r2.handle(p, { t: 'pausevote' });
    expect(r2.paused).toBe(false);
    expect(lastSys(s2)).toMatch(/menos de 3/);
  });

  it('con empate permitido termina empatado al final del tiempo y no vuelve a empezar', () => {
    const { room } = sala({ rules: { time: 0.5, score: 0, map: 'chica', allowDraw: true } });
    room.addMember({ name: 'A', ticket: 'tk-local-1' });
    room.addMember({ name: 'C', ticket: 'tk-visita-1' });
    room.addMember({ name: 'B', ticket: 'tk-local-2' });
    room.addMember({ name: 'D', ticket: 'tk-visita-2' });
    ticks(room, 4 * TICK_RATE);
    room.match.score = { red: 1, blue: 1 };
    room.match.phase = 'playing';
    room.match.ticks = 30 * TICK_RATE - 5;
    ticks(room, 10);
    expect(room.match.phase).toBe('ended');
    expect(room.match.winner).toBe(null);
    expect(room.torneo.state).toBe('terminado');
    ticks(room, 20 * TICK_RATE);
    expect(room.match.phase).toBe('ended');
  });

  it('sin empate permitido (copa) sigue a gol de oro', () => {
    const { room } = sala({ rules: { time: 0.5, score: 0, map: 'chica', allowDraw: false } });
    for (const tk of ['tk-local-1', 'tk-local-2', 'tk-visita-1', 'tk-visita-2']) room.addMember({ name: tk, ticket: tk });
    ticks(room, 4 * TICK_RATE);
    room.match.phase = 'playing';
    room.match.ticks = 30 * TICK_RATE - 5;
    ticks(room, 10);
    expect(room.match.overtime).toBe(true);
    expect(room.match.phase).not.toBe('ended');
  });
});
