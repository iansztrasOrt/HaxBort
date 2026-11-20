import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseJSON5, JSON5Error } from '../shared/json5.js';
import { loadStadium, FLAGS, ALL } from '../shared/stadium/load.js';
import {
  createWorld, step, collideDiscs, collidePlane, collideSegment, collideVertex, prepareSegment,
} from '../shared/physics/world.js';
import { createMatch, addPlayer, startMatch, tick, setInput, removePlayer, INPUT } from '../shared/game/match.js';

const disc = (o = {}) => ({
  x: 0, y: 0, vx: 0, vy: 0, gx: 0, gy: 0, r: 10, invMass: 1, damping: 1, bCoef: 0.5, cMask: ALL, cGroup: ALL, ...o,
});
const classic = () => loadStadium(fs.readFileSync(new URL('../maps/builtin/clasica.hbs', import.meta.url), 'utf8')).stadium;

describe('JSON5', () => {
  it('acepta comentarios, claves sin comillas, comas finales, comillas simples y hex', () => {
    const v = parseJSON5(`// hola\n{ a: 1, 'b': 'x\\ny', c: [1, 2,], d: 0x1F, e: .5, f: +3, /* fin */ }`);
    expect(v).toEqual({ a: 1, b: 'x\ny', c: [1, 2], d: 31, e: 0.5, f: 3 });
  });

  it('informa línea y columna del error', () => {
    try {
      parseJSON5('{\n  a: 1,\n  b: ?\n}');
      throw new Error('no falló');
    } catch (e) {
      expect(e).toBeInstanceOf(JSON5Error);
      expect(e.line).toBe(3);
      expect(e.column).toBe(6);
    }
  });

  it('rechaza __proto__, anidamiento excesivo y archivos enormes', () => {
    expect(() => parseJSON5('{ "__proto__": { "x": 1 } }')).toThrow(/no permitida/);
    expect(() => parseJSON5('['.repeat(500) + ']'.repeat(500))).toThrow(/profundo/);
    expect(() => parseJSON5(' '.repeat(100), { maxLength: 10 })).toThrow(/grande/);
  });
});

describe('importador de estadios', () => {
  it('traits anidados, trait inexistente y valores por defecto', () => {
    const r = loadStadium(`{
      name: 'T', width: 100, height: 100,
      traits: { base: { bCoef: 0.3, cMask: ['ball'] }, hijo: { trait: 'base', vis: false } },
      vertexes: [{ x: 0, y: 0, trait: 'hijo' }, { x: 10, y: 0, trait: 'noExiste' }],
      segments: [{ v0: 0, v1: 1, trait: 'hijo', bCoef: 0.9 }],
      goals: [{ p0: [0, 0], p1: [0, 10], team: 'red' }],
    }`);
    expect(r.ok).toBe(true);
    const s = r.stadium.segments[0];
    expect(s.bCoef).toBe(0.9); // lo propio pisa al trait
    expect(s.vis).toBe(false); // heredado del trait padre
    expect(s.cMask).toBe(FLAGS.ball);
    expect(r.stadium.vertexes[1].bCoef).toBe(1); // default de vértice
    expect(r.warnings.some((w) => w.msg.includes('noExiste'))).toBe(true);
    expect(r.stadium.discs[0].cGroup & FLAGS.kick).toBeTruthy(); // pelota por defecto, pateable
  });

  it('errores bloqueantes: vértice fuera de rango, NaN/Infinity, no numéricos', () => {
    const r = loadStadium('{ vertexes: [{ x: 0, y: 0 }], segments: [{ v0: 0, v1: 5 }], discs: [{ radius: NaN }, { pos: [Infinity, 0] }], planes: [{ normal: [0, 1], dist: "x" }] }');
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.where)).toEqual(expect.arrayContaining(['segments[0]', 'discs[0]', 'discs[1]', 'planes[0]']));
  });

  it('advertencias: propiedades desconocidas, sin arcos, más de 255 objetos', () => {
    const vx = Array.from({ length: 300 }, (_, i) => `{x:${i},y:0,foo:1}`).join(',');
    const r = loadStadium(`{ width: 10, height: 10, raro: true, vertexes: [${vx}] }`);
    expect(r.ok).toBe(true);
    const msgs = r.warnings.map((w) => w.msg).join(' | ');
    expect(msgs).toMatch(/raro/);
    expect(msgs).toMatch(/foo/);
    expect(msgs).toMatch(/sin arcos|no tiene arcos/);
    expect(msgs).toMatch(/255/);
  });

  it('curvas: 0 recta, negativa invierte, extremas (>340°) rectas, 180° es semicírculo', () => {
    const r = loadStadium('{ vertexes: [{x:0,y:-50},{x:0,y:50}], segments: [{v0:0,v1:1,curve:0},{v0:0,v1:1,curve:-90,bias:5},{v0:0,v1:1,curve:350},{v0:0,v1:1,curve:180}] }');
    const [a, b, c, d] = r.stadium.segments;
    expect(a.curveF).toBe(null);
    expect([b.v0, b.v1, b.bias]).toEqual([1, 0, -5]);
    expect(c.curveF).toBe(null);
    expect(Math.abs(d.curveF)).toBeLessThan(1e-9);
  });

  it('ballPhysics "disc0" usa el primer disco sin tocar su cGroup', () => {
    const r = loadStadium('{ ballPhysics: "disc0", discs: [{ radius: 7, cGroup: ["ball", "kick", "score"] }] }');
    expect(r.stadium.discs).toHaveLength(1);
    expect(r.stadium.discs[0].radius).toBe(7);
  });

  it('los 10 estadios integrados cargan sin errores ni advertencias', () => {
    const dir = new URL('../maps/builtin/', import.meta.url);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(10);
    for (const f of files) {
      const r = loadStadium(fs.readFileSync(new URL(f, dir), 'utf8'));
      expect(r.errors, f).toEqual([]);
      expect(r.warnings, f).toEqual([]);
    }
  });
});

describe('colisiones', () => {
  it('disco-disco: se separan y rebotan con bCoef combinado', () => {
    const a = disc({ x: -9, vx: 2 });
    const b = disc({ x: 9, vx: -2 });
    expect(collideDiscs(a, b)).toBe(true);
    expect(b.x - a.x).toBeCloseTo(20);
    expect(a.vx).toBeLessThan(0);
    expect(b.vx).toBeGreaterThan(0);
    expect(b.vx - a.vx).toBeCloseTo(4 * 0.25); // restitución = 0.5 × 0.5
  });

  it('disco-plano', () => {
    const d = disc({ y: 95, vy: 3 });
    collidePlane(d, { nx: 0, ny: -1, dist: -100, bCoef: 1, cMask: ALL, cGroup: ALL });
    expect(d.y).toBeCloseTo(90);
    expect(d.vy).toBeCloseTo(-1.5);
  });

  it('disco-vértice', () => {
    const d = disc({ x: 6, vx: -2 });
    collideVertex(d, { x: 0, y: 0, bCoef: 1 });
    expect(d.x).toBeCloseTo(10);
    expect(d.vx).toBeCloseTo(1);
  });

  it('disco-segmento recto, de los dos lados, y fuera de los extremos no choca', () => {
    const verts = [{ x: -50, y: 0 }, { x: 50, y: 0 }];
    const seg = prepareSegment({ v0: 0, v1: 1, curveF: null, bias: 0, bCoef: 1, cMask: ALL, cGroup: ALL, vis: true, color: null }, verts);
    const above = disc({ y: -5, vy: 2 });
    collideSegment(above, seg);
    expect(above.y).toBeCloseTo(-10);
    expect(above.vy).toBeLessThan(0);
    const below = disc({ y: 5, vy: -2 });
    collideSegment(below, seg);
    expect(below.y).toBeCloseTo(10);
    const outside = disc({ x: 70, y: 2 });
    expect(collideSegment(outside, seg)).toBe(false);
  });

  it('disco-segmento curvo (semicírculo): choca dentro del arco y no del lado abierto', () => {
    const verts = [{ x: 0, y: -50 }, { x: 0, y: 50 }];
    const seg = prepareSegment({ v0: 0, v1: 1, curveF: 1 / Math.tan(Math.PI / 2), bias: 0, bCoef: 1, cMask: ALL, cGroup: ALL, vis: true, color: null }, verts);
    const right = disc({ x: 45, y: 0, vx: 1 }); // dentro del arco derecho, cerca del borde
    expect(collideSegment(right, seg)).toBe(true);
    expect(right.x).toBeCloseTo(40);
    const left = disc({ x: -45, y: 0 }); // lado izquierdo: no hay arco
    expect(collideSegment(left, seg)).toBe(false);
  });

  it('bias: un segmento de un solo lado no deja pasar ni a una pelota rápida', () => {
    const r = loadStadium('{ vertexes: [{x:-100,y:0},{x:100,y:0}], segments: [{v0:0,v1:1,bias:30}], planes: [], discs: [] }');
    const w = createWorld(r.stadium);
    const ball = w.discs[0];
    Object.assign(ball, { x: 0, y: -15, vx: 0, vy: 30, damping: 1 });
    for (let i = 0; i < 10; i += 1) step(w);
    expect(ball.y).toBeLessThan(0);
  });

  it('una pelota muy rápida no atraviesa un poste ni una pared fina (sub-pasos)', () => {
    const r = loadStadium(`{ vertexes: [{x:100,y:-200},{x:100,y:200}], segments: [{v0:0,v1:1}],
      discs: [{ pos: [300, 0], radius: 4, invMass: 0 }] }`);
    const w = createWorld(r.stadium);
    const ball = w.discs[0];
    Object.assign(ball, { x: 0, y: 0, vx: 60, vy: 0, damping: 1 });
    for (let i = 0; i < 5; i += 1) step(w);
    expect(ball.x).toBeLessThan(100);
    // contra un poste chico
    const r2 = loadStadium('{ discs: [{ pos: [100, 0], radius: 3, invMass: 0 }] }');
    const w2 = createWorld(r2.stadium);
    Object.assign(w2.discs[0], { x: 0, y: 0, vx: 70, damping: 1, r: 4 });
    for (let i = 0; i < 4; i += 1) step(w2);
    expect(w2.discs[0].x).toBeLessThan(100);
  });

  it('cMask vacío no choca con nada; invMass 0 no se mueve; bCoef > 1 gana energía', () => {
    const ghost = disc({ x: 0, cMask: 0 });
    const other = disc({ x: 5 });
    const can = (a, b) => (a.cGroup & b.cMask) !== 0 && (b.cGroup & a.cMask) !== 0;
    expect(can(ghost, other)).toBe(false);
    const wall = disc({ x: 15, invMass: 0 });
    const ball = disc({ x: 0, vx: 2, bCoef: 1.5 });
    collideDiscs(ball, { ...wall, bCoef: 1.5 });
    expect(wall.x).toBe(15);
    expect(Math.abs(ball.vx)).toBeGreaterThan(2);
  });

  it('gravedad y uniones rígidas y elásticas', () => {
    const r = loadStadium(`{ discs: [
      { pos: [0, 0], invMass: 0, radius: 2, cMask: [] },
      { pos: [50, 0], invMass: 1, gravity: [0, 0.1], damping: 1, cMask: [] },
      { pos: [0, 100], invMass: 1, radius: 5, damping: 1, cMask: [] },
      { pos: [80, 100], invMass: 1, radius: 5, damping: 1, cMask: [] }],
      joints: [{ d0: 1, d1: 2, strength: 'rigid' }, { d0: 3, d1: 4, length: 40, strength: 0.1 }] }`);
    const w = createWorld(r.stadium);
    for (let i = 0; i < 300; i += 1) step(w);
    const [, anchor, bob, s1, s2] = w.discs;
    expect(Math.hypot(bob.x - anchor.x, bob.y - anchor.y)).toBeCloseTo(50, 0);
    expect(bob.y).toBeGreaterThan(0); // cayó por gravedad
    expect(Math.hypot(s2.x - s1.x, s2.y - s1.y)).toBeLessThan(80); // el resorte acortó
  });
});

describe('integración del paso (sub-pasos)', () => {
  const world = (discs, segments = []) => ({ discs, segments, planes: [], vertexes: [], joints: [] });
  const wall = (ax, ay, bx, by) => prepareSegment({ v0: 0, v1: 1, bias: 0, bCoef: 1, cMask: ALL, cGroup: ALL, curveF: null }, [{ x: ax, y: ay }, { x: bx, y: by }]);

  it('vuelo libre: recorre v por tick y frena con damping, sin importar los sub-pasos', () => {
    for (const v of [2, 7.4, 7.6, 15, 30, 120]) {
      const d = disc({ vx: v, damping: 0.99 });
      step(world([d]));
      expect(d.x).toBeCloseTo(v, 9);
      expect(d.vx).toBeCloseTo(v * 0.99, 9);
    }
  });

  it('con un solo sub-paso es exactamente el orden de HaxBall (pos += v; v = (v+g)·damping)', () => {
    const d = disc({ x: 1, y: 2, vx: 3, vy: -1, gx: 0.1, gy: 0.2, damping: 0.96 });
    step(world([d]));
    expect([d.x, d.y]).toEqual([4, 1]);
    expect(d.vx).toBeCloseTo((3 + 0.1) * 0.96, 12);
    expect(d.vy).toBeCloseTo((-1 + 0.2) * 0.96, 12);
  });

  it('rebote: ángulo de salida igual al de entrada y misma rapidez (bCoef 1), a cualquier velocidad', () => {
    for (const v of [3, 7.6, 20, 60]) {
      const d = disc({ x: 90 - v * 0.5, vx: v, vy: v, bCoef: 1, damping: 1 });
      const w = world([d], [wall(100, -1e4, 100, 1e4)]);
      for (let i = 0; i < 3; i += 1) step(w);
      expect(Math.atan2(d.vy, d.vx) * 180 / Math.PI).toBeCloseTo(135, 6);
      expect(Math.hypot(d.vx, d.vy)).toBeCloseTo(Math.hypot(v, v), 6);
      expect(d.x).toBeLessThanOrEqual(90 + 1e-9);
    }
  });

  it('a velocidad altísima no atraviesa una pared fina', () => {
    for (const v of [40, 80, 160, 190]) {
      const d = disc({ r: 6, vx: v, damping: 1 });
      const w = world([d], [wall(50, -100, 50, 100)]);
      for (let i = 0; i < 4; i += 1) step(w);
      expect(d.x).toBeLessThan(50);
    }
  });
});

describe('partido', () => {
  function playRight(m, id, ticks) {
    const ev = [];
    for (let i = 0; i < ticks; i += 1) {
      setInput(m, id, INPUT.right | INPUT.kick);
      ev.push(...tick(m));
    }
    return ev;
  }

  it('saque: el equipo que no saca no entra al círculo; el que saca sí', () => {
    const m = createMatch(classic());
    addPlayer(m, { id: 'r', team: 'red' });
    addPlayer(m, { id: 'b', team: 'blue' });
    startMatch(m);
    for (let i = 0; i < 400; i += 1) {
      setInput(m, 'b', INPUT.left);
      tick(m);
    }
    const blue = m.players[1].disc;
    expect(Math.hypot(blue.x, blue.y)).toBeGreaterThan(79); // radio del círculo central = 80
    expect(m.phase).toBe('kickoff');
  });

  it('gol: suma al equipo contrario al del arco y el saque es del que lo recibió', () => {
    const m = createMatch(classic(), { scoreLimit: 0 });
    addPlayer(m, { id: 'r', team: 'red' });
    startMatch(m);
    const ev = playRight(m, 'r', 900);
    const goal = ev.find((e) => e.type === 'goal');
    expect(goal).toMatchObject({ team: 'red', conceded: 'blue', scorerId: 'r' });
    expect(m.score.red).toBeGreaterThanOrEqual(1);
    const ko = ev.find((e) => e.type === 'kickoff');
    expect(ko.team).toBe('blue');
  });

  it('detección continua: una pelota rapidísima no se "salta" la línea de gol', () => {
    const m = createMatch(classic(), { scoreLimit: 0 });
    startMatch(m);
    const ball = m.world.discs[0];
    Object.assign(ball, { x: 300, y: 0, vx: 200, vy: 0 });
    m.phase = 'playing';
    const ev = tick(m);
    expect(ev.some((e) => e.type === 'goal')).toBe(true);
  });

  it('gol con dos pelotas: cuenta cualquier disco con bandera "score"', () => {
    const st = classic();
    st.discs.push({ ...st.discs[0], pos: [0, 100] });
    const m = createMatch(st, { scoreLimit: 0 });
    startMatch(m);
    m.phase = 'playing';
    const second = m.world.discs[m.world.discs.length - 1];
    Object.assign(second, { x: -300, y: 0, vx: -200, vy: 0 });
    const ev = tick(m);
    expect(ev.find((e) => e.type === 'goal')).toMatchObject({ team: 'blue', conceded: 'red' });
  });

  it('gol en el mismo tick en que termina el tiempo: cuenta; empate al final → gol de oro', () => {
    const m = createMatch(classic(), { timeLimit: 1, scoreLimit: 0 });
    addPlayer(m, { id: 'r', team: 'red' });
    startMatch(m);
    m.phase = 'playing';
    m.ticks = 60 * 60 - 1;
    Object.assign(m.world.discs[0], { x: 370, y: 0, vx: 40, vy: 0 });
    const ev = tick(m);
    expect(ev.some((e) => e.type === 'goal')).toBe(true);
    for (let i = 0; i < 200 && m.phase !== 'ended'; i += 1) tick(m);
    expect(m.phase).toBe('ended');
    expect(m.winner).toBe('red');

    const t = createMatch(classic(), { timeLimit: 1, scoreLimit: 0 });
    startMatch(t);
    t.phase = 'playing';
    t.ticks = 60 * 60 - 1;
    const ev2 = tick(t);
    expect(ev2.some((e) => e.type === 'overtime')).toBe(true);
    expect(t.phase).toBe('playing');
    Object.assign(t.world.discs[0], { x: -370, y: 0, vx: -40, vy: 0 });
    tick(t);
    for (let i = 0; i < 200 && t.phase !== 'ended'; i += 1) tick(t);
    expect(t.winner).toBe('blue');
  });

  it('jugador que se va a mitad del saque: el partido sigue sin errores', () => {
    const m = createMatch(classic());
    addPlayer(m, { id: 'r', team: 'red' });
    addPlayer(m, { id: 'b', team: 'blue' });
    startMatch(m);
    tick(m);
    removePlayer(m, 'r');
    expect(m.world.discs.filter((d) => d.kind === 'player')).toHaveLength(1);
    for (let i = 0; i < 100; i += 1) tick(m);
    expect(m.phase).toBe('kickoff');
  });

  it('determinismo: la misma secuencia de entradas da exactamente el mismo estado', () => {
    const run = () => {
      const m = createMatch(classic(), { scoreLimit: 0 });
      addPlayer(m, { id: 'r', team: 'red' });
      addPlayer(m, { id: 'b', team: 'blue' });
      startMatch(m);
      let seed = 7;
      for (let i = 0; i < 2000; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        setInput(m, 'r', seed & 31);
        setInput(m, 'b', (seed >> 5) & 31);
        tick(m);
      }
      return JSON.stringify(m.world.discs.map((d) => [d.x, d.y, d.vx, d.vy]));
    };
    expect(run()).toBe(run());
  });
});
