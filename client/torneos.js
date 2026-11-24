// Pantalla de torneos (liga y copa): crear, inscribirse, aprobar equipos, fixture, tabla y llave.
// Habla con el servidor por HTTP (/api/torneos). Toda la lógica vive en shared/tournament/logic.js;
// acá solo se muestra el estado y se mandan acciones.

import { KIT_PRESETS } from '../shared/game/kits.js';
import { drawKit, drawDiscLabel } from './render.js';

const KEY_STORE = 'haxbort.key.v1'; // clave secreta de esta compu (identifica al jugador en los torneos)
const MINE_STORE = 'haxbort.torneos.v1'; // torneos en los que participé o que creé
const POLL_MS = 4000;

function myKey() {
  try {
    let k = localStorage.getItem(KEY_STORE);
    if (!k || k.length < 24) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      k = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY_STORE, k);
    }
    return k;
  } catch {
    return null;
  }
}
function readMine() {
  try {
    const v = JSON.parse(localStorage.getItem(MINE_STORE) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.code === 'string') : [];
  } catch {
    return [];
  }
}
function rememberMine(t) {
  try {
    const list = readMine().filter((x) => x.code !== t.code);
    list.unshift({ code: t.code, name: t.name, type: t.format.type, at: Date.now() });
    localStorage.setItem(MINE_STORE, JSON.stringify(list.slice(0, 30)));
  } catch { /* nada */ }
}
function forgetMine(code) {
  try {
    localStorage.setItem(MINE_STORE, JSON.stringify(readMine().filter((x) => x.code !== code)));
  } catch { /* nada */ }
}

/** Para avisar cosas del partido desde el juego (marcador, sala armada). */
export async function postTorneo(code, action, playerName) {
  const key = myKey();
  const res = await fetch(`/api/torneos/${code}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-hax-key': key } : {}) },
    body: JSON.stringify({ action, playerName }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'No se pudo avisar al torneo.');
  return data;
}

const STATUS_ES = { inscripcion: 'Inscripción abierta', en_curso: 'En juego', terminado: 'Terminado' };

export function createTorneosUI({ $, el, toast, getProfile, show, maps, hostMatch, joinMatch, watchMatch, inRoom, busy }) {
  const state = { code: null, t: null, tab: null, timer: 0, busy: false, error: null, readyFor: null, rtt: null, handled: new Set() };
  const root = () => $('torneos-body');

  // ---------------------------------------------------------------- servidor
  async function api(path, body) {
    const key = myKey();
    const t0 = performance.now();
    const res = await fetch(`/api/torneos${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-hax-key': key } : {}) },
      body: body ? JSON.stringify({ ...body, playerName: getProfile().name }) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await res.json();
    } catch { /* nada */ }
    if (!res.ok || !data?.ok) throw new Error(data?.error || 'No se pudo conectar con el servidor.');
    // Demora con el servidor: sirve para elegir qué compu corre cada partido (la de mejor conexión).
    const ms = performance.now() - t0;
    state.rtt = state.rtt === null ? ms : state.rtt * 0.7 + ms * 0.3;
    return data;
  }

  async function act(action, { quiet = false } = {}) {
    if (!state.code || state.busy) return null;
    state.busy = true;
    try {
      const data = await api(`/${state.code}`, { action });
      state.t = data.torneo;
      rememberMine(state.t);
      render();
      return data.result;
    } catch (e) {
      if (!quiet) toast(e.message, 4200);
      return null;
    } finally {
      state.busy = false;
    }
  }

  async function load() {
    if (!state.code) return;
    try {
      // Si estoy "listo" para un partido, cada consulta lo renueva (si cierro la página, vence solo).
      const data = state.readyFor
        ? await api(`/${state.code}`, { action: { t: 'listo', match: state.readyFor, rtt: Math.round(state.rtt ?? 300) } })
        : await api(`/${state.code}`);
      state.error = null;
      const changed = JSON.stringify(data.torneo) !== JSON.stringify(state.t);
      state.t = data.torneo;
      if (state.t.me && involved(state.t)) rememberMine(state.t);
      // No se redibuja mientras escribís en un campo (perderías lo que estás escribiendo).
      if (changed && !editing()) render();
      autoPlay();
    } catch (e) {
      if (state.readyFor && /no se puede jugar|No jugás|No existe ese partido/.test(e.message)) state.readyFor = null;
      state.error = e.message;
      if (!state.t) render();
    }
  }

  // ---------------------------------------------------------------- jugar
  /** Mi partido de la fecha/ronda actual (si tengo uno sin jugar). */
  function myMatch(t) {
    const mt = myTeam(t);
    if (!mt || t.status !== 'en_curso' || t.currentRound < 0) return null;
    return t.rounds[t.currentRound].matches.find((m) => m.status === 'pendiente' && (m.home === mt.id || m.away === mt.id)) || null;
  }
  /** Cuando el juego arma el partido: si me toca correrlo, armo la sala; si no, entro con mi ticket. */
  function autoPlay() {
    const t = state.t;
    if (!t || $('scr-torneos').hidden || busy()) return;
    const m = myMatch(t);
    const lv = m && t.live?.[m.id];
    if (!lv?.myTicket) return;
    if (lv.hostConfig && lv.state === 'creando' && !state.handled.has(`host:${lv.hostConfig.session}`)) {
      state.handled.add(`host:${lv.hostConfig.session}`);
      state.readyFor = null;
      toast('¡Están todos! Armando el partido en tu compu…', 2500);
      hostMatch(lv.hostConfig);
    } else if (lv.state === 'jugando' && lv.room && lv.host !== t.me && inRoom() !== lv.room && !state.handled.has(`join:${lv.room}`)) {
      state.handled.add(`join:${lv.room}`);
      state.readyFor = null;
      toast('¡Están todos! Entrando al partido…', 2500);
      joinMatch({ room: lv.room, ticket: lv.myTicket });
    }
  }
  async function setReady(m, on) {
    state.readyFor = on ? m.id : null;
    await act({ t: 'listo', match: m.id, on, rtt: Math.round(state.rtt ?? 300) });
    autoPlay();
  }
  function renderMyMatch(t) {
    const m = myMatch(t);
    if (!m) return null;
    const lv = t.live?.[m.id] || { ready: [] };
    const round = t.rounds[t.currentRound];
    const home = teamById(t, m.home);
    const away = teamById(t, m.away);
    const amReady = lv.ready.includes(t.me);
    if (amReady && !state.readyFor) state.readyFor = m.id; // (p. ej. después de recargar)
    const people = (team) => el('ul', { class: 'tready' }, ...team.members.map((pid) => el('li', { class: lv.ready.includes(pid) ? 'on' : '' },
      el('span', { class: 'dotr', 'aria-hidden': 'true' }), `${playerName(t, pid)}${pid === t.me ? ' (vos)' : ''}`, el('span', { class: 'meta', text: lv.ready.includes(pid) ? 'listo' : 'esperando' }))));
    const total = home.members.length + away.members.length;
    let status;
    let action = null;
    if (lv.state === 'creando') status = lv.host === t.me ? 'Armando el partido en tu compu…' : `Armando el partido en la compu de ${playerName(t, lv.host)}…`;
    else if (lv.state === 'jugando') {
      status = 'El partido está en juego.';
      if (lv.room && inRoom() !== lv.room) action = el('button', { type: 'button', class: 'btn go', onclick: () => joinMatch({ room: lv.room, ticket: lv.myTicket }) }, 'Entrar al partido');
    } else {
      status = `${lv.ready.length} de ${total} listos. Cuando estén todos, el partido arranca solo.`;
      action = el('button', { type: 'button', class: `btn ${amReady ? 'ghost' : 'go big'}`, onclick: () => setReady(m, !amReady) }, amReady ? 'Ya no estoy listo' : '✓ Estoy listo');
    }
    return el('div', { class: 'tmy' },
      el('div', { class: 'tmy-head' }, el('h3', { text: `Tu partido · ${round.name}${m.desempate ? ' (desempate)' : m.leg === 2 ? ' (vuelta)' : ''}` }),
        lv.dispute ? el('span', { class: 'tbadge', text: 'Resultados distintos: lo carga el admin' }) : null),
      el('div', { class: 'tmy-teams' },
        el('div', {}, teamTag(t, m.home), people(home)),
        el('div', { class: 'tmy-vs', text: lv.score ? `${lv.score[0]} - ${lv.score[1]}` : 'vs' }),
        el('div', {}, teamTag(t, m.away), people(away))),
      el('p', { class: 'small muted', text: status }), action);
  }
  const editing = () => {
    const a = document.activeElement;
    return Boolean(a && root()?.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'));
  };
  function poll() {
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      if (state.code && !$('scr-torneos').hidden && !document.hidden) await load();
      if (state.code && !$('scr-torneos').hidden) poll();
    }, POLL_MS);
  }

  // ---------------------------------------------------------------- ayudas
  const teamById = (t, id) => t.teams.find((x) => x.id === id);
  const teamName = (t, id) => teamById(t, id)?.name || '—';
  const playerName = (t, pid) => t.players[pid]?.name || 'Jugador';
  const myTeam = (t) => t.teams.find((x) => x.members.includes(t.me)) || null;
  const amSolo = (t) => t.solos.some((s) => s.pid === t.me);
  const involved = (t) => t.admin || Boolean(myTeam(t)) || amSolo(t);
  function kitIcon(kit, size = 14, label = '') {
    const c = el('canvas', { width: String(size * 2), height: String(size * 2), class: 'kit-ico', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px` });
    if (!kit) return c;
    const ctx = c.getContext('2d');
    const r = size - 2;
    drawKit(ctx, kit, size, size, r);
    ctx.beginPath();
    ctx.arc(size, size, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, size / 10);
    ctx.strokeStyle = `#${kit.border}`;
    ctx.stroke();
    if (label) drawDiscLabel(ctx, label, size, size, r, `#${kit.text}`);
    return c;
  }
  const teamTag = (t, id) => (id ? el('span', { class: 'tteam' }, kitIcon(teamById(t, id)?.kit), el('span', { text: teamName(t, id) })) : el('span', { class: 'muted', text: 'Pasa directo' }));
  function formatSummary(f) {
    const parts = [f.type === 'liga' ? 'Liga' : 'Copa', `${f.teamSize} vs ${f.teamSize}`];
    if (f.type === 'liga') parts.push(f.vueltas === 1 ? 'una vuelta' : f.vueltas === 2 ? 'ida y vuelta' : `${f.vueltas} vueltas`);
    else parts.push(f.idaVuelta ? 'llaves ida y vuelta' : 'partido único');
    const r = f.rules;
    parts.push(r.time ? `${String(r.time).replace('.', ',')} min` : 'sin tiempo', r.score ? `a ${r.score} goles` : 'sin límite de goles');
    return parts.join(' · ');
  }
  const confirmBtn = (label, ask, fn, cls = 'btn') => el('button', { type: 'button', class: cls, onclick: () => { if (window.confirm(ask)) fn(); } }, label);

  // ---------------------------------------------------------------- formulario de modalidad (crear y editar)
  function formatForm(f, { submitLabel, onSubmit, withName = null, locked = false }) {
    const id = (s) => `tf-${s}`;
    const form = el('form', { class: 'tform', onsubmit: (e) => {
      e.preventDefault();
      const g = (s) => form.querySelector(`#${id(s)}`);
      const ball = g('ball').value.trim();
      onSubmit({
        name: withName !== null ? g('name').value : undefined,
        format: {
          type: g('type').value,
          teamSize: Number(g('size').value),
          maxTeams: Number(g('max').value),
          vueltas: Number(g('vueltas').value),
          idaVuelta: g('ida').checked,
          inscripcion: { equipos: g('i-eq').checked, solos: g('i-solo').checked, unirse: g('i-unirse').checked },
          rules: { time: Number(String(g('time').value).replace(',', '.')), score: Number(g('score').value), ballRadius: ball === '' ? null : Number(ball), map: g('map').value },
        },
      });
    } });
    const opt = (v, text, sel) => el('option', { value: String(v), selected: sel ? 'selected' : null }, text);
    const typeSel = el('select', { id: id('type'), disabled: locked ? 'disabled' : null }, opt('liga', 'Liga', f.type === 'liga'), opt('copa', 'Copa', f.type === 'copa'));
    const ligaRow = el('label', { class: 'field' }, 'Vueltas',
      el('select', { id: id('vueltas') }, opt(1, 'Una vuelta (todos contra todos una vez)', f.vueltas === 1), opt(2, 'Ida y vuelta', f.vueltas === 2), opt(3, 'Tres vueltas', f.vueltas === 3), opt(4, 'Cuatro vueltas (dos de ida y vuelta)', f.vueltas === 4)));
    const copaRow = el('label', { class: 'check' }, el('input', { type: 'checkbox', id: id('ida'), checked: f.idaVuelta ? 'checked' : null }), ' Llaves a dos partidos (ida y vuelta). Si empatan en el global: desempate a gol de oro.');
    const typeHint = el('p', { class: 'small muted' });
    const sync = () => {
      ligaRow.hidden = typeSel.value !== 'liga';
      copaRow.hidden = typeSel.value !== 'copa';
      typeHint.textContent = typeSel.value === 'liga' ? 'Liga: todos contra todos, suma puntos (3 ganar, 1 empatar).' : 'Copa: eliminación directa por sorteo; el que pierde queda afuera.';
    };
    typeSel.addEventListener('change', sync);
    form.append(
      withName !== null ? el('label', { class: 'field' }, 'Nombre del torneo', el('input', { class: 'input', id: id('name'), maxlength: '40', value: withName, required: 'required', placeholder: 'Copa de los pibes' })) : null,
      el('div', { class: 'tgrid' },
        el('label', { class: 'field' }, 'Tipo', typeSel),
        el('label', { class: 'field' }, 'Jugadores por equipo', el('input', { class: 'input', id: id('size'), type: 'number', min: '1', max: '8', step: '1', value: String(f.teamSize), disabled: locked ? 'disabled' : null })),
        el('label', { class: 'field' }, 'Máximo de equipos', el('input', { class: 'input', id: id('max'), type: 'number', min: '2', max: '32', step: '1', value: String(f.maxTeams) }))),
      typeHint, ligaRow, copaRow,
      el('h3', { text: 'Cómo se puede anotar la gente' }),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: id('i-eq'), checked: f.inscripcion.equipos ? 'checked' : null }), ' Como equipo: un capitán lo arma y les pasa un código a sus compañeros'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: id('i-unirse'), checked: f.inscripcion.unirse ? 'checked' : null }), ' Pidiendo entrar a un equipo que tenga lugar (lo acepta el capitán)'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: id('i-solo'), checked: f.inscripcion.solos ? 'checked' : null }), ' Solo: el admin lo pone en un equipo (o arma equipos con los que se anotaron solos)'),
      el('h3', { text: 'Reglas de los partidos' }),
      el('div', { class: 'tgrid four' },
        el('label', { class: 'field' }, 'Tiempo (min)', el('input', { class: 'input', id: id('time'), type: 'number', min: '0', max: '60', step: '0.5', value: String(f.rules.time) })),
        el('label', { class: 'field' }, 'Goles', el('input', { class: 'input', id: id('score'), type: 'number', min: '0', max: '99', step: '1', value: String(f.rules.score) })),
        el('label', { class: 'field' }, 'Pelota (radio)', el('input', { class: 'input', id: id('ball'), type: 'number', min: '3', max: '10', step: '1', value: f.rules.ballRadius ?? '', placeholder: 'auto' })),
        el('label', { class: 'field' }, 'Estadio', el('select', { id: id('map') }, ...maps.map((m) => opt(m.id, m.name, m.id === f.rules.map))))),
      el('p', { class: 'small muted', text: 'Tiempo y goles: 0 = sin límite. Pelota vacía = la del estadio.' }),
      el('button', { class: 'btn primary', type: 'submit' }, submitLabel));
    sync();
    return form;
  }

  // ---------------------------------------------------------------- inicio de torneos
  function renderHome() {
    const body = root();
    body.replaceChildren();
    const mine = readMine();
    const defaults = { type: 'liga', teamSize: 3, maxTeams: 8, vueltas: 1, idaVuelta: false, inscripcion: { equipos: true, solos: true, unirse: true }, rules: { time: 3, score: 3, ballRadius: null, map: 'clasica' } };
    const create = formatForm(defaults, {
      submitLabel: 'Crear torneo',
      withName: '',
      onSubmit: async ({ name, format }) => {
        try {
          const data = await api('', { name, format });
          rememberMine(data.torneo);
          open(data.code);
          toast(`Torneo creado. Código: ${data.code}`, 4000);
        } catch (e) {
          toast(e.message, 4200);
        }
      },
    });
    const codeInput = el('input', { class: 'input code-input', maxlength: '6', placeholder: 'ABC123', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Código del torneo',
      oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); } });
    body.append(el('div', { class: 'lobby' },
      el('div', { class: 'choice' }, el('h2', {}, el('i', { 'aria-hidden': 'true' }, '🏆'), 'Crear torneo'), create),
      el('div', { class: 'choice' },
        el('h2', {}, el('i', { 'aria-hidden': 'true' }, '#'), 'Entrar a un torneo'),
        el('form', { class: 'tform', onsubmit: (e) => {
          e.preventDefault();
          if (codeInput.value.length === 6) open(codeInput.value);
          else toast('El código del torneo tiene 6 letras o números.');
        } }, codeInput, el('button', { class: 'btn big', type: 'submit' }, 'Ver torneo')),
        el('h3', { text: 'Mis torneos' }),
        mine.length ? el('div', { class: 'rooms-list' }, ...mine.map((m) => el('button', { type: 'button', class: 'room-row', onclick: () => open(m.code) },
          el('span', {}, el('strong', { text: m.name }), el('br'), el('span', { class: 'meta', text: `${m.type === 'copa' ? 'Copa' : 'Liga'} · ${m.code}` })),
          el('span', { class: 'meta', text: '' }), el('span', { class: 'count', text: '›' }))))
          : el('p', { class: 'small muted', text: 'Todavía no estás en ningún torneo. Creá uno o entrá con el código que te pasaron.' }))));
  }

  // ---------------------------------------------------------------- torneo
  function render() {
    const body = root();
    if (!state.code) return renderHome();
    const t = state.t;
    if (!t) {
      body.replaceChildren(el('p', { class: 'muted', text: state.error || 'Cargando torneo…' }),
        state.error ? el('button', { type: 'button', class: 'btn', onclick: () => home() }, 'Volver') : null);
      return;
    }
    const tabs = [];
    if (t.status !== 'inscripcion') tabs.push(['tabla', t.format.type === 'liga' ? 'Tabla' : 'Llave'], ['partidos', 'Partidos']);
    tabs.push(['equipos', `Equipos (${t.teams.length})`]);
    if (t.status === 'inscripcion') tabs.unshift(['anotarse', 'Inscripción']);
    if (t.admin) tabs.push(['admin', 'Admin']);
    if (!tabs.some(([k]) => k === state.tab)) state.tab = tabs[0][0];

    const link = `${location.origin}${location.pathname}?torneo=${t.code}`;
    const head = el('div', { class: 'thead' },
      el('div', { class: 'thead-main' },
        el('h2', { text: t.name }),
        el('p', { class: 'small muted', text: formatSummary(t.format) })),
      el('span', { class: `tstatus ${t.status}`, text: STATUS_ES[t.status] }),
      el('button', { type: 'button', class: 'btn ghost tcode', title: 'Copiar el link del torneo', onclick: async () => {
        try {
          await navigator.clipboard.writeText(link);
          toast('Link del torneo copiado.', 1600);
        } catch {
          window.prompt('Copiá el link del torneo:', link);
        }
      } }, 'Código ', el('strong', { text: t.code }), ' 🔗'));
    const champion = t.champion ? el('div', { class: 'tchamp' }, '🏆 Campeón: ', teamTag(t, t.champion)) : null;
    const nav = el('div', { class: 'ttabs', role: 'tablist' }, ...tabs.map(([k, label]) => el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => { state.tab = k; render(); },
    }, label)));
    const panel = el('div', { class: 'tpanel' });
    ({ anotarse: renderSignup, tabla: t.format.type === 'liga' ? renderTable : renderBracket, partidos: renderMatches, equipos: renderTeams, admin: renderAdmin })[state.tab](t, panel);
    body.replaceChildren(...[head, champion, renderMyMatch(t), nav, panel, renderLog(t)].filter(Boolean));
  }

  function renderLog(t) {
    if (!t.log?.length) return null;
    return el('details', { class: 'tlog' }, el('summary', { text: 'Novedades' }),
      el('ul', {}, ...[...t.log].reverse().slice(0, 15).map((l) => el('li', { text: l.text }))));
  }

  // ---- inscripción
  function renderSignup(t, panel) {
    const ins = t.format.inscripcion;
    const mt = myTeam(t);
    if (mt) {
      panel.append(el('div', { class: 'tnote ok' }, 'Estás en ', teamTag(t, mt.id), mt.status === 'aprobado' ? ' (aprobado ✓).' : ' (esperando que el admin lo apruebe).',
        ' Mirá tu equipo en la pestaña Equipos.'));
      return;
    }
    if (amSolo(t)) {
      panel.append(el('div', { class: 'tnote' }, 'Estás anotado solo: el admin te va a poner en un equipo. ',
        el('button', { type: 'button', class: 'btn ghost', onclick: () => act({ t: 'salir' }) }, 'Darme de baja')));
    }
    const requested = t.teams.filter((x) => x.requests.includes(t.me));
    if (requested.length) {
      panel.append(el('div', { class: 'tnote' }, `Pediste entrar a ${requested.map((x) => x.name).join(', ')}: espera que el capitán te acepte. `,
        el('button', { type: 'button', class: 'btn ghost', onclick: () => act({ t: 'cancelar_pedido' }) }, 'Cancelar pedido')));
    }
    const cards = el('div', { class: 'tcards' });
    if (ins.equipos && !amSolo(t)) {
      const name = el('input', { class: 'input', maxlength: '24', placeholder: 'Nombre del equipo', required: 'required' });
      const open = el('input', { type: 'checkbox', checked: 'checked' });
      cards.append(el('form', { class: 'choice', onsubmit: async (e) => {
        e.preventDefault();
        const res = await act({ t: 'crear_equipo', name: name.value, open: open.checked });
        if (res) toast('Equipo anotado. Pasales el código a tus compañeros (está en Equipos).', 4500);
      } }, el('h3', { text: 'Armar mi equipo' }), el('p', { class: 'small muted', text: 'Sos el capitán. Te damos un código para que entren tus compañeros.' }),
      name, el('label', { class: 'check' }, open, ' Que otros puedan pedir entrar'), el('button', { class: 'btn primary', type: 'submit' }, 'Anotar equipo')));
    }
    if (!amSolo(t)) {
      const code = el('input', { class: 'input code-input', maxlength: '7', placeholder: 'CÓDIGO', autocomplete: 'off', oninput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); } });
      cards.append(el('form', { class: 'choice', onsubmit: (e) => {
        e.preventDefault();
        act({ t: 'unirse_codigo', code: code.value });
      } }, el('h3', { text: 'Tengo el código de mi equipo' }), el('p', { class: 'small muted', text: 'Te lo pasa el capitán. Entrás directo.' }), code, el('button', { class: 'btn', type: 'submit' }, 'Entrar al equipo')));
    }
    if (ins.solos && !amSolo(t)) {
      cards.append(el('div', { class: 'choice' }, el('h3', { text: 'Anotarme solo' }), el('p', { class: 'small muted', text: 'No tenés equipo: el admin te pone en uno.' }),
        el('button', { class: 'btn', type: 'button', onclick: () => act({ t: 'anotarse_solo' }) }, 'Anotarme solo')));
    }
    panel.append(cards);
    if (ins.unirse && !amSolo(t)) {
      const openTeams = t.teams.filter((x) => x.open && x.members.length < t.format.teamSize);
      panel.append(el('h3', { text: 'Equipos que buscan jugadores' }),
        openTeams.length ? el('div', { class: 'tlist' }, ...openTeams.map((x) => el('div', { class: 'trow' }, teamTag(t, x.id),
          el('span', { class: 'meta', text: `${x.members.length}/${t.format.teamSize}` }),
          x.requests.includes(t.me) ? el('span', { class: 'meta', text: 'pedido enviado' })
            : el('button', { type: 'button', class: 'btn ghost', onclick: () => act({ t: 'pedir_unirse', team: x.id }) }, 'Pedir entrar'))))
          : el('p', { class: 'small muted', text: 'Ningún equipo está buscando jugadores ahora.' }));
    }
  }

  // ---- equipos
  function renderTeams(t, panel) {
    const insc = t.status === 'inscripcion';
    if (!t.teams.length) panel.append(el('p', { class: 'muted', text: 'Todavía no se anotó ningún equipo.' }));
    const grid = el('div', { class: 'tteams' });
    for (const x of t.teams) {
      const captain = x.captain === t.me;
      const canManage = captain || t.admin;
      const head = el('div', { class: 'tteam-head' }, kitIcon(x.kit, 22, String(x.members.length)), el('strong', { text: x.name }),
        el('span', { class: `tbadge ${x.status}`, text: x.status === 'aprobado' ? 'Aprobado' : 'Esperando aprobación' }));
      const members = el('ul', { class: 'tmembers' }, ...x.members.map((pid) => el('li', {},
        el('span', { text: `${playerName(t, pid)}${pid === x.captain ? ' ★' : ''}${pid === t.me ? ' (vos)' : ''}` }),
        insc && canManage && pid !== t.me ? el('button', { type: 'button', class: 'linkbtn', onclick: () => act({ t: 'quitar_jugador', team: x.id, pid }) }, 'sacar') : null)),
      ...Array.from({ length: Math.max(0, t.format.teamSize - x.members.length) }, () => el('li', { class: 'muted', text: 'lugar libre' })));
      const card = el('div', { class: 'tteam-card' }, head, members);
      if (x.joinCode && insc) card.append(el('p', { class: 'small' }, 'Código para entrar: ', el('strong', { class: 'mono', text: x.joinCode })));
      if (insc && canManage && x.requests.length) {
        card.append(el('div', { class: 'treqs' }, el('h3', { text: 'Piden entrar' }), ...x.requests.map((pid) => el('div', { class: 'trow' },
          el('span', { text: playerName(t, pid) }),
          el('button', { type: 'button', class: 'btn ghost', onclick: () => act({ t: 'aceptar_jugador', team: x.id, pid }) }, 'Aceptar'),
          el('button', { type: 'button', class: 'linkbtn', onclick: () => act({ t: 'rechazar_jugador', team: x.id, pid }) }, 'rechazar')))));
      }
      const actions = el('div', { class: 'tactions' });
      if (t.admin && insc && x.status !== 'aprobado') actions.append(el('button', { type: 'button', class: 'btn primary', onclick: () => act({ t: 'aprobar_equipo', team: x.id }) }, 'Aprobar'));
      if (t.admin && insc) actions.append(confirmBtn(x.status === 'aprobado' ? 'Sacar del torneo' : 'Rechazar', `¿Sacar a ${x.name} del torneo?`, () => act({ t: 'rechazar_equipo', team: x.id }), 'btn ghost'));
      if (canManage) actions.append(el('button', { type: 'button', class: 'btn ghost', onclick: () => editTeam(t, x, card) }, 'Nombre y camiseta'));
      if (insc && canManage) actions.append(el('label', { class: 'check small' }, el('input', { type: 'checkbox', checked: x.open ? 'checked' : null, onchange: (e) => act({ t: 'editar_equipo', team: x.id, open: e.target.checked }) }), ' acepta pedidos'));
      if (insc && x.members.includes(t.me)) actions.append(confirmBtn('Salir del equipo', '¿Salir de este equipo?', () => act({ t: 'salir' }), 'btn ghost'));
      if (actions.childNodes.length) card.append(actions);
      grid.append(card);
    }
    panel.append(grid);
    if (insc && t.solos.length) {
      const spaced = t.teams.filter((x) => x.members.length < t.format.teamSize);
      panel.append(el('h3', { text: `Anotados solos (${t.solos.length})` }), el('div', { class: 'tlist' }, ...t.solos.map((s) => {
        const sel = el('select', {}, el('option', { value: '' }, 'Poner en…'), ...spaced.map((x) => el('option', { value: x.id }, x.name)));
        return el('div', { class: 'trow' }, el('span', { text: `${playerName(t, s.pid)}${s.pid === t.me ? ' (vos)' : ''}` }),
          t.admin && spaced.length ? sel : null,
          t.admin && spaced.length ? el('button', { type: 'button', class: 'btn ghost', onclick: () => { if (sel.value) act({ t: 'ubicar_solo', pid: s.pid, team: sel.value }); } }, 'Ubicar') : null);
      })));
      if (t.admin) panel.append(el('button', { type: 'button', class: 'btn', onclick: async () => {
        const r = await act({ t: 'armar_equipos' });
        if (r) toast(`Se armaron ${r.made} equipo${r.made === 1 ? '' : 's'}${r.left ? `; quedan ${r.left} sin equipo (no alcanzan para uno completo)` : ''}.`, 4500);
      } }, `Armar equipos al azar con los sueltos (de a ${t.format.teamSize})`));
    }
  }

  function editTeam(t, x, card) {
    const name = el('input', { class: 'input', maxlength: '24', value: x.name });
    let kit = x.kit;
    const preview = el('span', {}, kitIcon(kit, 26, String(x.members.length)));
    const presets = el('div', { class: 'kit-grid' }, ...KIT_PRESETS.map((p) => el('button', { type: 'button', class: 'kit-opt', title: p.name, onclick: () => {
      kit = p.kit;
      preview.replaceChildren(kitIcon(kit, 26, String(x.members.length)));
    } }, kitIcon(p.kit, 17), p.name)));
    const form = el('form', { class: 'tform', onsubmit: async (e) => {
      e.preventDefault();
      if (await act({ t: 'editar_equipo', team: x.id, name: name.value, kit })) toast('Equipo actualizado.', 1500);
    } }, el('div', { class: 'trow' }, preview, name), el('h3', { text: 'Camiseta' }), presets,
    el('div', { class: 'trow' }, el('button', { class: 'btn primary', type: 'submit' }, 'Guardar'), el('button', { class: 'btn ghost', type: 'button', onclick: () => render() }, 'Cancelar')));
    card.replaceChildren(form);
    name.focus();
  }

  // ---- tabla (liga)
  function renderTable(t, panel) {
    const rows = t.standings || [];
    panel.append(el('div', { class: 'ttable-wrap' }, el('table', { class: 'ttable' },
      el('thead', {}, el('tr', {}, ...['#', 'Equipo', 'Pts', 'PJ', 'PG', 'PE', 'PP', 'GF', 'GC', 'DG'].map((h, i) => el('th', { text: h, class: i >= 4 && i <= 6 ? 'opt' : null })))),
      el('tbody', {}, ...rows.map((r, i) => el('tr', { class: myTeam(t)?.id === r.team ? 'mine' : '' },
        el('td', { text: String(i + 1) }), el('td', {}, teamTag(t, r.team)), el('td', { class: 'pts', text: String(r.pts) }),
        ...[r.pj, r.pg, r.pe, r.pp, r.gf, r.gc, r.dg > 0 ? `+${r.dg}` : r.dg].map((v, k) => el('td', { text: String(v), class: k >= 1 && k <= 3 ? 'opt' : null }))))))));
  }

  // ---- llave (copa)
  function renderBracket(t, panel) {
    const cols = el('div', { class: 'tbracket' });
    for (const r of t.rounds) {
      const ties = el('div', { class: 'tbties' });
      const col = el('div', { class: 'tbcol' }, el('h3', { text: r.name }), ties);
      for (const tie of r.ties) {
        const ms = tie.matches.map((id) => r.matches.find((m) => m.id === id)).filter(Boolean);
        const goals = (team) => ms.filter((m) => m.status !== 'pendiente').map((m) => (m.home === team ? m.gh : m.ga));
        const line = (team) => el('div', { class: `tbteam${tie.winner && tie.winner === team ? ' win' : ''}${tie.winner && team && tie.winner !== team ? ' out' : ''}` },
          teamTag(t, team), el('span', { class: 'mono', text: team ? goals(team).join(' · ') : '' }));
        ties.append(el('div', { class: 'tbtie' }, line(tie.a), line(tie.b)));
      }
      cols.append(col);
    }
    panel.append(cols);
  }

  // ---- partidos
  function renderMatches(t, panel) {
    const cur = t.currentRound;
    t.rounds.forEach((r, i) => {
      const label = i === cur ? 'Se juega ahora' : (cur === -1 || i < cur ? 'Terminada' : 'Espera que termine la anterior');
      const box = el('div', { class: `tround${i === cur ? ' current' : ''}` }, el('div', { class: 'tround-head' }, el('h3', { text: r.name }), el('span', { class: 'meta', text: label })));
      for (const m of r.matches) {
        const done = m.status !== 'pendiente';
        const row = el('div', { class: `tmatch${done ? ' done' : ''}${[m.home, m.away].includes(myTeam(t)?.id) ? ' mine' : ''}` },
          el('span', { class: 'th' }, teamTag(t, m.home)),
          el('span', { class: 'tscore mono', text: done ? `${m.gh} - ${m.ga}` : 'vs' }),
          el('span', { class: 'ta' }, teamTag(t, m.away)),
          el('span', { class: 'meta', text: m.desempate ? 'desempate (gol de oro)' : m.leg === 2 ? 'vuelta' : m.leg === 1 && t.format.idaVuelta ? 'ida' : '' }));
        const lv = t.live?.[m.id];
        if (!done && lv?.state === 'jugando' && lv.room) {
          row.querySelector('.tscore').textContent = lv.score ? `${lv.score[0]} - ${lv.score[1]}` : '0 - 0';
          row.classList.add('livem');
          row.append(el('button', { type: 'button', class: 'btn ghost', onclick: () => watchMatch(lv.room) }, '● En juego · Mirar'));
        } else if (!done && lv?.ready?.length) {
          row.append(el('span', { class: 'meta', text: `${lv.ready.length} listo${lv.ready.length === 1 ? '' : 's'}` }));
        }
        if (!done && lv?.dispute && t.admin) row.append(el('span', { class: 'tbadge', text: 'en disputa: cargalo vos' }));
        const canLoad = t.admin && t.status !== 'inscripcion' && (done ? (t.format.type === 'liga' || i === t.rounds.length - 1) : i === cur);
        if (canLoad) {
          const gh = el('input', { class: 'input mini', type: 'number', min: '0', max: '99', value: done ? String(m.gh) : '', 'aria-label': `Goles de ${teamName(t, m.home)}` });
          const ga = el('input', { class: 'input mini', type: 'number', min: '0', max: '99', value: done ? String(m.ga) : '', 'aria-label': `Goles de ${teamName(t, m.away)}` });
          row.append(el('form', { class: 'tload', onsubmit: (e) => {
            e.preventDefault();
            if (gh.value === '' || ga.value === '') return toast('Poné los goles de los dos equipos.');
            act({ t: 'cargar_resultado', match: m.id, gh: Number(gh.value), ga: Number(ga.value) });
          } }, gh, ga, el('button', { class: 'btn ghost', type: 'submit' }, done ? 'Corregir' : 'Cargar')));
        }
        box.append(row);
      }
      panel.append(box);
    });
    if (t.status !== 'terminado') panel.append(el('p', { class: 'small muted', text: 'Cada partido se juega cuando todos los jugadores de los dos equipos tocan "Estoy listo" (sin fechas fijas): el juego lo arma solo en la compu con mejor conexión y el resultado se carga solo. La fecha/ronda siguiente se habilita cuando se jugaron todos los partidos de la actual. El admin puede cargar o corregir un resultado a mano.' }));
  }

  // ---- admin
  function renderAdmin(t, panel) {
    const insc = t.status === 'inscripcion';
    if (insc) {
      const ok = t.teams.filter((x) => x.status === 'aprobado');
      const pending = t.teams.filter((x) => x.status !== 'aprobado');
      const incomplete = ok.filter((x) => x.members.length < t.format.teamSize);
      panel.append(el('div', { class: 'tnote' },
        el('p', { text: `${ok.length} equipo${ok.length === 1 ? '' : 's'} aprobado${ok.length === 1 ? '' : 's'}${pending.length ? `, ${pending.length} esperando aprobación` : ''}${t.solos.length ? `, ${t.solos.length} anotado${t.solos.length === 1 ? '' : 's'} solo` : ''}.` }),
        incomplete.length ? el('p', { class: 'small', text: `Les faltan jugadores a: ${incomplete.map((x) => x.name).join(', ')}.` }) : null,
        pending.length ? el('p', { class: 'small muted', text: 'Los equipos sin aprobar no entran al torneo cuando empieza.' }) : null,
        confirmBtn('▶ Empezar el torneo', `¿Empezar el torneo con ${ok.length} equipos? Se cierra la inscripción y se arma el ${t.format.type === 'liga' ? 'fixture' : 'cuadro (por sorteo)'}.`, () => act({ t: 'empezar' }), 'btn go big')));
    } else {
      panel.append(el('div', { class: 'tnote' }, el('p', { class: 'small', text: 'Con el torneo empezado podés cambiar las reglas y, en la liga, sumar vueltas. Si todavía no se jugó ningún partido, también el tipo y las llaves. Para cambiar el resto, reiniciá.' }),
        confirmBtn('Reiniciar (volver a la inscripción)', 'Se borran el fixture y los resultados. Los equipos quedan. ¿Seguro?', () => act({ t: 'reiniciar' }), 'btn ghost')));
    }
    panel.append(el('h3', { text: 'Nombre y modalidad' }), formatForm(t.format, {
      submitLabel: 'Guardar cambios', withName: t.name, locked: false,
      onSubmit: async ({ name, format }) => {
        if (await act({ t: 'editar', name, format })) toast('Torneo actualizado.', 1600);
      },
    }));
    panel.append(el('div', { class: 'tactions' }, el('button', { type: 'button', class: 'linkbtn', onclick: () => { forgetMine(t.code); home(); } }, 'Quitar de "Mis torneos"')));
  }

  // ---------------------------------------------------------------- navegación
  function open(code) {
    state.code = String(code).toUpperCase();
    state.t = null;
    state.error = null;
    state.tab = null;
    show('torneos');
    try { history.replaceState(null, '', `?torneo=${state.code}`); } catch { /* nada */ }
    render();
    load();
    poll();
  }
  function home() {
    state.code = null;
    state.t = null;
    clearTimeout(state.timer);
    show('torneos');
    try { history.replaceState(null, '', location.pathname); } catch { /* nada */ }
    renderHome();
  }
  function leave() {
    state.code = null;
    state.readyFor = null;
    clearTimeout(state.timer);
    try { history.replaceState(null, '', location.pathname); } catch { /* nada */ }
  }
  return { open, home, leave, back: () => (state.code ? home() : (leave(), show('lobby'))) };
}
