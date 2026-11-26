import { describe, it, expect } from 'vitest';
import {
  createTorneo, applyAction, roundRobin, standings, currentRoundIndex, playable, allMatches, publicView, teamOf, TorneoError, cleanFormat,
} from '../shared/tournament/logic.js';

let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const P = (n) => ({ pid: `p${n}`, name: `Jugador ${n}` });
const ADMIN = { pid: 'admin', name: 'Admin' };
const act = (t, who, a) => applyAction(t, who, a, { rng, now: 1 });
const nuevo = (format = {}) => createTorneo({ code: 'ABCDEF', name: 'Torneo', owner: 'admin', ownerName: 'Admin', format });

/** n equipos aprobados de `size` jugadores, armados por sus capitanes con código. */
function conEquipos(t, n, size = t.format.teamSize) {
  let k = 1;
  for (let i = 0; i < n; i += 1) {
    const cap = P(k++);
    const { team } = act(t, cap, { t: 'crear_equipo', name: `Eq ${i + 1}` });
    const code = t.teams.find((x) => x.id === team).joinCode;
    for (let j = 1; j < size; j += 1) act(t, P(k++), { t: 'unirse_codigo', code });
    act(t, ADMIN, { t: 'aprobar_equipo', team });
  }
  return t;
}
const jugarFecha = (t, score = (m, i) => [i % 3, (i + 1) % 2]) => {
  const r = t.rounds[currentRoundIndex(t)];
  r.matches.filter((m) => m.status === 'pendiente').forEach((m, i) => {
    const [gh, ga] = score(m, i);
    act(t, ADMIN, { t: 'cargar_resultado', match: m.id, gh, ga });
  });
};

describe('fixture todos contra todos', () => {
  for (const n of [2, 3, 4, 5, 8, 9]) {
    it(`${n} equipos: cada par se cruza una vez y nadie juega dos veces en la misma fecha`, () => {
      const ids = Array.from({ length: n }, (_, i) => `e${i}`);
      const rounds = roundRobin(ids);
      expect(rounds).toHaveLength(n % 2 ? n : n - 1);
      const seen = new Set();
      for (const r of rounds) {
        const inRound = r.flat();
        expect(new Set(inRound).size).toBe(inRound.length);
        for (const [a, b] of r) seen.add([a, b].sort().join('-'));
      }
      expect(seen.size).toBe((n * (n - 1)) / 2);
    });
  }
});

describe('inscripción', () => {
  it('equipo con código (entra directo), pedido a un equipo abierto (lo acepta el capitán) y suelto ubicado por el admin', () => {
    const t = nuevo({ teamSize: 3 });
    const { team } = act(t, P(1), { t: 'crear_equipo', name: 'Los Pibes' });
    const eq = t.teams[0];
    expect(eq.status).toBe('pendiente');
    act(t, P(2), { t: 'unirse_codigo', code: eq.joinCode.toLowerCase() });
    act(t, P(3), { t: 'pedir_unirse', team });
    expect(eq.requests).toEqual(['p3']);
    expect(() => act(t, P(2), { t: 'aceptar_jugador', team, pid: 'p3' })).toThrow(/capitán/);
    act(t, P(1), { t: 'aceptar_jugador', team, pid: 'p3' });
    expect(eq.members).toEqual(['p1', 'p2', 'p3']);
    act(t, P(4), { t: 'anotarse_solo' });
    expect(() => act(t, ADMIN, { t: 'ubicar_solo', pid: 'p4', team })).toThrow(/completo/);
    expect(() => act(t, P(4), { t: 'crear_equipo', name: 'Otro' })).toThrow(/solo/);
    act(t, P(4), { t: 'salir' });
    act(t, P(4), { t: 'crear_equipo', name: 'Otro' });
    expect(() => act(t, P(5), { t: 'crear_equipo', name: 'otro' })).toThrow(/nombre/);
  });

  it('nadie puede estar en dos equipos ni anotarse dos veces', () => {
    const t = nuevo({ teamSize: 2 });
    act(t, P(1), { t: 'crear_equipo', name: 'A' });
    const b = act(t, P(2), { t: 'crear_equipo', name: 'B' }).team;
    expect(() => act(t, P(1), { t: 'unirse_codigo', code: t.teams.find((x) => x.id === b).joinCode })).toThrow(/Ya estás/);
    expect(() => act(t, P(1), { t: 'anotarse_solo' })).toThrow(/Ya estás/);
    act(t, P(3), { t: 'anotarse_solo' });
    expect(() => act(t, P(3), { t: 'anotarse_solo' })).toThrow(/Ya estás/);
  });

  it('el admin aprueba o rechaza equipos; solo el admin', () => {
    const t = nuevo();
    const { team } = act(t, P(1), { t: 'crear_equipo', name: 'A' });
    expect(() => act(t, P(1), { t: 'aprobar_equipo', team })).toThrow(/admin/);
    act(t, ADMIN, { t: 'aprobar_equipo', team });
    expect(t.teams[0].status).toBe('aprobado');
    const r = act(t, P(2), { t: 'crear_equipo', name: 'B' }).team;
    act(t, ADMIN, { t: 'rechazar_equipo', team: r });
    expect(t.teams.map((x) => x.name)).toEqual(['A']);
    expect(teamOf(t, 'p2')).toBe(null);
  });

  it('armar equipos con los sueltos: completa los aprobados y arma equipos nuevos (ya aprobados)', () => {
    const t = nuevo({ teamSize: 2 });
    const { team } = act(t, P(1), { t: 'crear_equipo', name: 'A' });
    act(t, ADMIN, { t: 'aprobar_equipo', team });
    for (let i = 2; i <= 6; i += 1) act(t, P(i), { t: 'anotarse_solo' });
    const res = act(t, ADMIN, { t: 'armar_equipos' });
    expect(res).toEqual({ made: 2, left: 0 });
    expect(t.teams.every((x) => x.members.length === 2 && x.status === 'aprobado')).toBe(true);
    expect(new Set(t.teams.flatMap((x) => x.members)).size).toBe(6);
  });

  it('las formas de inscribirse se pueden apagar', () => {
    const t = nuevo({ inscripcion: { equipos: true, solos: false, unirse: false } });
    expect(() => act(t, P(1), { t: 'anotarse_solo' })).toThrow(/solo/);
    const { team } = act(t, P(1), { t: 'crear_equipo', name: 'A' });
    expect(() => act(t, P(2), { t: 'pedir_unirse', team })).toThrow(/pedir/);
    expect(() => cleanFormat({ inscripcion: { equipos: false, solos: false } })).toThrow(TorneoError);
  });

  it('el código de un equipo solo lo ven sus jugadores y el admin', () => {
    const t = nuevo();
    act(t, P(1), { t: 'crear_equipo', name: 'A' });
    expect(publicView(t, 'p9').teams[0].joinCode).toBe(null);
    expect(publicView(t, 'p1').teams[0].joinCode).toBeTruthy();
    expect(publicView(t, 'admin').teams[0].joinCode).toBeTruthy();
  });
});

describe('empezar', () => {
  it('hacen falta 2 equipos aprobados y completos; los no aprobados quedan afuera', () => {
    const t = nuevo({ teamSize: 2 });
    conEquipos(t, 1, 2);
    expect(() => act(t, ADMIN, { t: 'empezar' })).toThrow(/2 equipos/);
    const { team } = act(t, P(50), { t: 'crear_equipo', name: 'Incompleto' });
    act(t, ADMIN, { t: 'aprobar_equipo', team });
    expect(() => act(t, ADMIN, { t: 'empezar' })).toThrow(/Faltan jugadores en: Incompleto/);
    act(t, P(51), { t: 'unirse_codigo', code: t.teams.find((x) => x.id === team).joinCode });
    act(t, P(60), { t: 'crear_equipo', name: 'Sin aprobar' });
    act(t, ADMIN, { t: 'empezar' });
    expect(t.status).toBe('en_curso');
    expect(t.teams.map((x) => x.name)).toEqual(['Eq 1', 'Incompleto']);
    expect(() => act(t, P(70), { t: 'anotarse_solo' })).toThrow(/cerró/);
  });
});

describe('liga', () => {
  it('ida y vuelta: todas las fechas; no se adelanta una fecha sin terminar la anterior; tabla y campeón', () => {
    const t = conEquipos(nuevo({ type: 'liga', teamSize: 1, vueltas: 2 }), 4);
    act(t, ADMIN, { t: 'empezar' });
    expect(t.rounds).toHaveLength(6);
    const later = t.rounds[1].matches[0];
    expect(playable(t, later)).toBe(false);
    expect(() => act(t, ADMIN, { t: 'cargar_resultado', match: later.id, gh: 1, ga: 0 })).toThrow(/anterior/);
    // vuelta: local y visitante invertidos
    const ida = t.rounds[0].matches.map((m) => `${m.home}-${m.away}`);
    const vuelta = t.rounds[3].matches.map((m) => `${m.away}-${m.home}`);
    expect(vuelta).toEqual(ida);
    // gana siempre el local 2-1 salvo empates en la fecha 1
    jugarFecha(t, (m, i) => (i === 0 ? [1, 1] : [2, 1]));
    expect(currentRoundIndex(t)).toBe(1);
    while (t.status === 'en_curso') jugarFecha(t, () => [2, 1]);
    expect(t.status).toBe('terminado');
    const table = standings(t);
    expect(table.reduce((a, r) => a + r.pj, 0)).toBe(24);
    expect(table[0].pts).toBeGreaterThanOrEqual(table[1].pts);
    expect(t.champion).toBe(table[0].team);
  });

  it('número impar de equipos: uno queda libre cada fecha', () => {
    const t = conEquipos(nuevo({ type: 'liga', teamSize: 1 }), 5);
    act(t, ADMIN, { t: 'empezar' });
    expect(t.rounds).toHaveLength(5);
    for (const r of t.rounds) expect(r.matches).toHaveLength(2);
  });

  it('se puede corregir un resultado y la tabla se recalcula', () => {
    const t = conEquipos(nuevo({ type: 'liga', teamSize: 1 }), 2);
    act(t, ADMIN, { t: 'empezar' });
    const m = t.rounds[0].matches[0];
    act(t, ADMIN, { t: 'cargar_resultado', match: m.id, gh: 3, ga: 0 });
    expect(t.status).toBe('terminado');
    expect(t.champion).toBe(m.home);
    act(t, ADMIN, { t: 'cargar_resultado', match: m.id, gh: 0, ga: 1 });
    expect(t.champion).toBe(m.away);
  });
});

describe('copa', () => {
  it('5 equipos: 3 pasan directo, los que pasan directo no se cruzan entre ellos de entrada, y sale un campeón', () => {
    const t = conEquipos(nuevo({ type: 'copa', teamSize: 1 }), 5);
    act(t, ADMIN, { t: 'empezar' });
    const r1 = t.rounds[0];
    expect(r1.name).toBe('Cuartos de final');
    expect(r1.ties.filter((x) => !x.b)).toHaveLength(3);
    expect(r1.matches).toHaveLength(1);
    expect(() => act(t, ADMIN, { t: 'cargar_resultado', match: r1.matches[0].id, gh: 1, ga: 1 })).toThrow(/gol de oro/);
    act(t, ADMIN, { t: 'cargar_resultado', match: r1.matches[0].id, gh: 2, ga: 1 });
    expect(t.rounds).toHaveLength(2);
    expect(t.rounds[1].name).toBe('Semifinal');
    expect(t.rounds[1].ties.every((x) => x.a && x.b)).toBe(true);
    // Ya no se puede corregir la ronda cerrada
    expect(() => act(t, ADMIN, { t: 'cargar_resultado', match: r1.matches[0].id, gh: 0, ga: 1 })).toThrow(/cerró/);
    while (t.status === 'en_curso') jugarFecha(t, () => [1, 0]);
    expect(t.rounds.at(-1).name).toBe('Final');
    expect(t.champion).toBe(t.rounds.at(-1).ties[0].winner);
  });

  it('ida y vuelta: gana el global; si empatan, desempate a gol de oro', () => {
    const t = conEquipos(nuevo({ type: 'copa', teamSize: 1, idaVuelta: true }), 2);
    act(t, ADMIN, { t: 'empezar' });
    const [ida, vuelta] = t.rounds[0].matches;
    expect(vuelta.home).toBe(ida.away);
    act(t, ADMIN, { t: 'cargar_resultado', match: ida.id, gh: 2, ga: 1 });
    act(t, ADMIN, { t: 'cargar_resultado', match: vuelta.id, gh: 1, ga: 0 }); // global 2-2
    const des = t.rounds[0].matches.find((m) => m.desempate);
    expect(des).toBeTruthy();
    expect(t.status).toBe('en_curso');
    expect(() => act(t, ADMIN, { t: 'cargar_resultado', match: des.id, gh: 0, ga: 0 })).toThrow(/gol de oro/);
    act(t, ADMIN, { t: 'cargar_resultado', match: des.id, gh: 0, ga: 1 });
    expect(t.champion).toBe(des.away);
    // Corrección de la vuelta: ya no hay empate → se descarta el desempate y gana por global
    act(t, ADMIN, { t: 'cargar_resultado', match: vuelta.id, gh: 0, ga: 0 }); // global: ida.home 2-1
    expect(t.rounds[0].matches.some((m) => m.desempate)).toBe(false);
    expect(t.champion).toBe(ida.home);
  });

  it('8 equipos: cuartos, semis y final', () => {
    const t = conEquipos(nuevo({ type: 'copa', teamSize: 1 }), 8);
    act(t, ADMIN, { t: 'empezar' });
    while (t.status === 'en_curso') jugarFecha(t, () => [0, 2]);
    expect(t.rounds.map((r) => r.name)).toEqual(['Cuartos de final', 'Semifinal', 'Final']);
    expect(allMatches(t)).toHaveLength(7);
  });
});

describe('editar la modalidad', () => {
  it('la patada del torneo: 2 a 10 de a medio punto; vacía = la del estadio; llega a cada partido', async () => {
    const { matchRules } = await import('../shared/tournament/logic.js');
    expect(cleanFormat({ rules: { kick: 6.5 } }).rules.kick).toBe(6.5);
    expect(cleanFormat({ rules: { kick: 12 } }).rules.kick).toBe(null);
    expect(cleanFormat({ rules: { kick: null } }).rules.kick).toBe(null);
    const t = conEquipos(nuevo({ teamSize: 1, rules: { kick: 8 } }), 2);
    act(t, ADMIN, { t: 'empezar' });
    expect(matchRules(t, t.rounds[0].matches[0]).kick).toBe(8);
  });

  it('en inscripción se cambia todo; con equipos aprobados no se baja el máximo de equipos', () => {
    const t = conEquipos(nuevo({ teamSize: 1 }), 3);
    act(t, ADMIN, { t: 'editar', format: { type: 'copa', idaVuelta: true, rules: { time: 5, score: 7 } } });
    expect(t.format).toMatchObject({ type: 'copa', idaVuelta: true, rules: { time: 5, score: 7 } });
    expect(() => act(t, ADMIN, { t: 'editar', format: { maxTeams: 2 } })).toThrow(/máximo/);
    expect(() => act(t, P(1), { t: 'editar', format: { type: 'liga' } })).toThrow(/admin/);
  });

  it('empezado sin partidos jugados: se rearma el fixture; con partidos jugados solo reglas o más vueltas', () => {
    const t = conEquipos(nuevo({ type: 'liga', teamSize: 1 }), 4);
    act(t, ADMIN, { t: 'empezar' });
    act(t, ADMIN, { t: 'editar', format: { type: 'copa' } });
    expect(t.rounds[0].name).toBe('Semifinal');
    act(t, ADMIN, { t: 'editar', format: { type: 'liga', vueltas: 1 } });
    expect(t.rounds).toHaveLength(3);
    jugarFecha(t);
    expect(() => act(t, ADMIN, { t: 'editar', format: { type: 'copa' } })).toThrow(/reiniciá/);
    expect(() => act(t, ADMIN, { t: 'editar', format: { teamSize: 2 } })).toThrow(/por equipo/);
    act(t, ADMIN, { t: 'editar', format: { vueltas: 2, rules: { time: 4 } } });
    expect(t.rounds).toHaveLength(6);
    expect(t.format.rules.time).toBe(4);
    expect(currentRoundIndex(t)).toBe(1);
    act(t, ADMIN, { t: 'reiniciar' });
    expect(t.status).toBe('inscripcion');
    expect(t.rounds).toEqual([]);
  });
});
