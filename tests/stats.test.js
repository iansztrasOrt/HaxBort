import { describe, it, expect } from 'vitest';
import { loadStadium } from '../shared/stadium/load.js';
import { BUILTIN_MAPS } from '../shared/builtinMaps.js';
import { createMatch, addPlayer, startMatch } from '../shared/game/match.js';
import { createStats, updateStats, statsSummary } from '../shared/game/stats.js';

// Cancha clásica: arcos en x = ±382 (rojo defiende el izquierdo, azul el derecho).
function escena() {
  const m = createMatch(loadStadium(BUILTIN_MAPS[0].text).stadium, {});
  for (const [id, team] of [['r1', 'red'], ['r2', 'red'], ['b1', 'blue'], ['b2', 'blue']]) addPlayer(m, { id, name: id.toUpperCase(), team });
  startMatch(m);
  m.phase = 'playing';
  const S = createStats();
  const ball = m.world.discs.find((d) => d.kind === 'ball');
  const disc = (id) => m.players.find((p) => p.id === id).disc;
  const far = () => { for (const p of m.players) { p.disc.x = -1000 + p.id.charCodeAt(1) * 3; p.disc.y = 900; } };
  far();
  /** La toca `id` (se queda con ella `hold` ticks); `kick` = pateó. */
  const toca = (id, { x, y, vx = 0, vy = 0, kick = false, hold = 6 } = {}) => {
    Object.assign(ball, { x, y, vx, vy });
    const d = disc(id);
    d.x = x - (vx >= 0 ? 1 : -1) * (d.r + ball.r);
    d.y = y;
    m.lastTouch = id;
    updateStats(S, m, kick ? [{ type: 'kick', playerId: id }] : []);
    for (let i = 1; i < hold; i += 1) updateStats(S, m, []);
    far();
  };
  const ticks = (n) => { for (let i = 0; i < n; i += 1) updateStats(S, m, []); };
  const row = (id) => S.rows.get(id);
  return { m, S, ball, toca, ticks, row };
}

describe('estadísticas del partido', () => {
  it('pase a un compañero e intercepción del rival', () => {
    const { toca, row } = escena();
    toca('r1', { x: 0, y: 0 });
    toca('r2', { x: 80, y: 30 });
    expect(row('r1').pc).toBe(1);
    toca('b1', { x: 120, y: 30 });
    expect(row('b1').int).toBe(1);
    expect(row('r2').pl).toBe(1);
  });

  it('un toque cerquita (menos de 40) no es pase', () => {
    const { toca, row } = escena();
    toca('r1', { x: 0, y: 0 });
    toca('r2', { x: 20, y: 0 });
    expect(row('r1').pc).toBe(0);
  });

  it('tiro al arco y atajada; tiro afuera', () => {
    const { toca, ticks, row } = escena();
    toca('r1', { x: 250, y: 0, vx: 8, vy: 0, kick: true, hold: 1 }); // hacia el arco azul (x = 382)
    expect(row('r1')).toMatchObject({ sh: 1, sot: 1 });
    ticks(10);
    toca('b1', { x: 340, y: 0, hold: 1 });
    expect(row('b1').sv).toBe(1);
    expect(row('b1').int).toBe(0);
    toca('r2', { x: 250, y: 0, vx: 7, vy: 3.3, kick: true, hold: 1 }); // abierto: pasa al costado del palo
    expect(row('r2')).toMatchObject({ sh: 1, sot: 0 });
  });

  it('el saque del medio o un pelotazo de lejos no es tiro', () => {
    const { toca, row } = escena();
    toca('r1', { x: 0, y: 0, vx: 9, vy: 0, kick: true });
    toca('b1', { x: 60, y: 0, vx: -9, vy: 0, kick: true }); // a 440 del arco rojo: muy lejos
    expect(row('r1').sh + row('b1').sh).toBe(0);
  });

  it('gol con asistencia (y el gol cuenta como tiro al arco)', () => {
    const { m, S, toca, row } = escena();
    toca('r1', { x: 100, y: 0 });
    toca('r2', { x: 250, y: 40 });
    m.lastTouch = 'r2';
    updateStats(S, m, [{ type: 'goal', team: 'red', scorerId: 'r2', ownGoal: false }]);
    expect(row('r2')).toMatchObject({ g: 1, sot: 1 });
    expect(row('r1').a).toBe(1);
  });

  it('si un rival la toca en el medio, no hay asistencia; gol en contra', () => {
    const { m, S, toca, row } = escena();
    toca('r1', { x: 100, y: 0 });
    toca('b2', { x: 180, y: 0 });
    toca('r2', { x: 250, y: 40 });
    updateStats(S, m, [{ type: 'goal', team: 'red', scorerId: 'r2', ownGoal: false }]);
    expect(row('r1').a).toBe(0);
    updateStats(S, m, [{ type: 'goal', team: 'blue', scorerId: 'r1', ownGoal: true }]);
    expect(row('r1').og).toBe(1);
  });

  it('una pelota disputada (los dos empujando) no suma cientos de toques', () => {
    const { m, S, ball, row } = escena();
    Object.assign(ball, { x: 0, y: 0, vx: 0, vy: 0 });
    for (let i = 0; i < 300; i += 1) {
      m.lastTouch = i % 2 ? 'r1' : 'b1';
      updateStats(S, m, []);
    }
    expect((row('r1')?.tch || 0) + (row('b1')?.tch || 0)).toBeLessThanOrEqual(1);
  });

  it('nota final y MVP: gana el que más aportó (con bonus de victoria y valla invicta)', () => {
    const { m, S, toca, ticks, row } = escena();
    toca('r1', { x: 100, y: 0 });
    toca('r2', { x: 250, y: 40 });
    updateStats(S, m, [{ type: 'goal', team: 'red', scorerId: 'r2', ownGoal: false }]);
    toca('b1', { x: 250, y: 0, vx: -8, kick: true, hold: 1 });
    ticks(10);
    m.score = { red: 1, blue: 0 };
    m.winner = 'red';
    const sum = statsSummary(S, m, { final: true });
    expect(sum.mvp).toBe('r2');
    const r2 = sum.rows.find((r) => r.id === 'r2');
    expect(r2.rating).toBe(8); // 6 + gol 1 + al arco 0,15 + ganó 0,5 + valla invicta 0,3 = 7,95 → 8,0
    expect(row('r1').a).toBe(1);
    expect(statsSummary(S, m, { final: false }).mvp).toBe(null);
  });
});

describe('relator', () => {
  it('tiro que termina en gol: un solo mensaje de gol con la asistencia', () => {
    const { m, S, toca } = escena();
    toca('r1', { x: 100, y: 0 });
    toca('r2', { x: 250, y: 40, vx: 8, vy: -1, kick: true, hold: 1 });
    for (let i = 0; i < 5; i += 1) updateStats(S, m, []);
    updateStats(S, m, [{ type: 'goal', team: 'red', scorerId: 'r2', ownGoal: false }]);
    m.phase = 'goal'; // como en el juego: después del gol, festejo
    for (let i = 0; i < 60; i += 1) updateStats(S, m, []);
    expect(S.feed).toEqual([{ type: 'goal', by: 'r2', assist: 'r1' }]);
  });

  it('tiro atajado: un mensaje de atajada que nombra al que pateó', () => {
    const { m, S, toca, ticks } = escena();
    toca('r1', { x: 250, y: 0, vx: 8, kick: true, hold: 1 });
    ticks(10);
    toca('b1', { x: 340, y: 0, hold: 1 });
    ticks(60);
    expect(S.feed).toEqual([{ type: 'save', by: 'b1', shooter: 'r1' }]);
    expect(m).toBeTruthy();
  });

  it('tiro sin final: se cuenta como remate al arco o afuera (después de un instante)', () => {
    const { S, toca, ticks } = escena();
    toca('r1', { x: 250, y: 0, vx: 8, kick: true, hold: 1 });
    ticks(10);
    expect(S.feed).toEqual([]);
    ticks(40);
    expect(S.feed).toEqual([{ type: 'shot', by: 'r1', onTarget: true }]);
  });
});
