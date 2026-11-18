// HaxBort en el navegador: pantallas (inicio → nombre → salas), la sala estilo vestuario,
// el chat, los estadios y el partido con predicción local (tus controles responden al instante;
// cuando llega la foto del anfitrión/servidor, se corrige y se vuelve a simular lo que falta).

import { loadStadium } from '../shared/stadium/load.js';
import { kickCheck, normalizeKick, KICK_REFERENCE } from '../shared/stadium/tune.js';
import { createMatch, addPlayer, startMatch, tick, setInput, INPUT, formatClock, TEAM_COLORS } from '../shared/game/match.js';
import { botInput } from '../shared/game/bot.js';
import { createWorld } from '../shared/physics/world.js';
import { BUILTIN_MAPS } from '../shared/builtinMaps.js';
import { encodeInput, decodeSnapshot, applySnapshot } from '../shared/net/protocol.js';
import { createRenderer } from './render.js';
import { SAMPLE_LAB } from './sample-lab.js';
import { Hub, ServerSession, HostSession, GuestSession, LocalSession } from './net.js';

const $ = (id) => document.getElementById(id);
const STEP_MS = 1000 / 60;
const TEAM_ES = { red: 'Rojo', blue: 'Azul', spectator: 'Espectadores' };
const K = { profile: 'haxbort.profile.v1', prefs: 'haxbort.prefs.v1', library: 'haxbort.library.v1', session: 'haxbort.session.v1' };

// ---------------------------------------------------------------- utilidades
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}
const fmtKB = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtDate = (t) => new Date(t).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function readJSON(store, key, def) {
  try {
    return JSON.parse(store.getItem(key) || 'null') ?? def;
  } catch {
    return def;
  }
}
function writeJSON(store, key, value) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

const prefs = { zoom: 1, sound: true, ...readJSON(localStorage, K.prefs, {}) };
const savePrefs = () => writeJSON(localStorage, K.prefs, prefs);
let profile = { name: '', avatar: '', ...readJSON(localStorage, K.profile, {}) };
let library = readJSON(localStorage, K.library, []);
if (!Array.isArray(library)) library = [];
const saveLibrary = () => { if (!writeJSON(localStorage, K.library, library)) toast('No se pudo guardar en este navegador (espacio lleno o bloqueado).'); };

let audio = null;
function beep(freq, dur = 0.08, type = 'square', gain = 0.05) {
  if (!prefs.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + dur);
  } catch { /* sin audio */ }
}

// ---------------------------------------------------------------- estado
const renderer = createRenderer($('game'));
const app = {
  screen: 'welcome',
  hub: null,
  serverOk: false,
  sess: null,
  me: null,
  room: null, // último estado de la sala
  map: null, // { key, name, text, tune }
  match: null, // partido local (predicho)
  names: new Map(),
  pending: [],
  seq: 0,
  prevBits: [0, 0],
  paused: false,
  offsets: new Map(),
  roomOpen: false,
  lastPhase: 'idle',
  myKickAt: -1e9,
  joinCode: '',
  reconnecting: false,
};

// ---------------------------------------------------------------- partido de fondo (inicio)
let demo = null;
function makeDemo() {
  const st = loadStadium(BUILTIN_MAPS[0].text).stadium;
  const m = createMatch(st, { timeLimit: 0, scoreLimit: 0 });
  [['d1', 'Tito', 'red', 'T'], ['d2', 'Mirta', 'red', 'M'], ['d3', 'Ramona', 'blue', 'R'], ['d4', 'Coco', 'blue', 'C']]
    .forEach(([id, name, team, avatar]) => addPlayer(m, { id, name, team, avatar }));
  startMatch(m);
  return m;
}
function demoStep() {
  if (!demo) demo = makeDemo();
  for (const p of demo.players) setInput(demo, p.id, botInput(demo, p.id, { skill: 0.75 }));
  tick(demo);
}

// ---------------------------------------------------------------- pantallas
function show(screen) {
  app.screen = screen;
  for (const s of ['welcome', 'name', 'lobby']) $(`scr-${s}`).hidden = s !== screen;
  document.body.classList.toggle('outside', screen !== 'game');
  if (screen !== 'game') {
    $('room').hidden = true;
    app.roomOpen = false;
    closeModals();
  }
  if (screen === 'name') {
    $('nick').value = profile.name || '';
    $('avatar').value = profile.avatar || '';
    updateAvatarPreview();
    setTimeout(() => $('nick').focus(), 50);
  }
  if (screen === 'lobby') {
    $('lobby-hello').textContent = `Hola, ${profile.name}`;
    if (!$('room-name').value) $('room-name').value = `Sala de ${profile.name}`;
    if (app.joinCode) $('join-code').value = app.joinCode;
    refreshRooms();
  }
}

function updateAvatarPreview() {
  const a = $('avatar').value.trim() || $('nick').value.trim().slice(0, 1).toUpperCase() || '?';
  $('avatar-preview').textContent = a;
}

// ---------------------------------------------------------------- servidor
const wsURL = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

async function ensureHub() {
  if (app.hub?.open) return app.hub;
  if (!/^https?:$/.test(location.protocol)) throw new Error('sin servidor');
  const hub = new Hub(wsURL());
  await hub.connect();
  hub.onClose = onHubClosed;
  app.hub = hub;
  app.serverOk = true;
  setServerState();
  return hub;
}

function onHubClosed() {
  app.serverOk = false;
  setServerState();
  const s = app.sess;
  if (!s) return;
  if (s.kind === 'server' || s.kind === 'guest') startReconnect('Se cortó la conexión con el servidor.');
  else if (s.kind === 'host') {
    // Los invitados por canal directo siguen; los que van por el servidor se cortan.
    sysLine('Se cortó la conexión con el servidor: nadie nuevo puede entrar hasta que vuelva.');
    retryHubForHost();
  }
}

async function retryHubForHost() {
  for (let i = 0; i < 10 && app.sess?.kind === 'host'; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await ensureHub();
      sysLine('Volvió la conexión con el servidor. Ojo: la sala tiene un código nuevo si el servidor se reinició.');
      return;
    } catch { /* sigue */ }
  }
}

function setServerState() {
  const box = $('server-state');
  box.replaceChildren();
  const online = app.serverOk;
  box.append(el('span', { class: `dot ${online ? 'live' : ''}`, style: 'display:inline-block;margin-right:6px' }),
    online ? 'Conectado al servidor' : (/^https?:$/.test(location.protocol) ? 'Sin conexión con el servidor' : 'Vista previa sin servidor: podés practicar contra bots'));
  for (const b of document.querySelectorAll('#create-form button[type=submit], #join-form button[type=submit]')) b.disabled = !online;
}

let roomsTimer = 0;
async function refreshRooms() {
  clearTimeout(roomsTimer);
  const list = $('rooms-list');
  if (app.screen !== 'lobby') return;
  try {
    await ensureHub();
    const wait = app.hub.wait(['list'], 5000);
    app.hub.send({ t: 'list' });
    const res = await wait;
    list.replaceChildren();
    if (!res.rooms.length) list.append(el('p', { class: 'small muted', text: 'No hay salas públicas ahora. ¡Creá una!' }));
    for (const r of res.rooms) {
      list.append(el('button', {
        type: 'button', class: 'room-row',
        onclick: () => {
          $('join-code').value = r.code;
          $('join-pass-field').hidden = !r.hasPassword;
          if (r.hasPassword) $('join-pass').focus();
          else joinRoom(r.code);
        },
      }, el('span', {}, el('strong', { text: r.name }), el('br'), el('span', { class: 'meta', text: `${r.map}${r.hasPassword ? ' · 🔒 con contraseña' : ''}${r.mode === 'p2p' ? '' : ' · en el servidor'}` })),
      el('span', { class: 'meta', text: r.playing ? 'jugando' : 'esperando' }), el('span', { class: 'count', text: `${r.players}/${r.max}` })));
    }
  } catch {
    list.replaceChildren(el('p', { class: 'small muted', text: app.serverOk ? 'No se pudo cargar la lista.' : 'Sin servidor no hay salas online.' }));
    setServerState();
  }
  roomsTimer = setTimeout(refreshRooms, 6000);
}

// ---------------------------------------------------------------- entrar y salir de salas
function resetGameState() {
  app.me = null;
  app.room = null;
  app.map = null;
  app.match = null;
  app.names = new Map();
  app.pending = [];
  app.seq = 0;
  app.prevBits = [0, 0];
  app.paused = false;
  app.offsets = new Map();
  app.lastPhase = 'idle';
  chat.length = 0;
  renderChat();
}

function attach(sess) {
  app.sess = sess;
  sess.onMessage = onNet;
  sess.onDown = (reason) => {
    if (app.sess !== sess) return;
    startReconnect(reason);
  };
}

async function createRoom(e) {
  e.preventDefault();
  const cfg = {
    name: $('room-name').value.trim() || `Sala de ${profile.name}`, password: $('room-pass').value.trim(),
    maxPlayers: Number($('room-max').value), isPublic: $('room-public').checked,
  };
  const mode = $('room-mode').value;
  try {
    const hub = await ensureHub();
    resetGameState();
    if (mode === 'server') {
      const s = new ServerSession(hub);
      attach(s);
      await s.start({ t: 'create', mode: 'server', room: cfg, name: profile.name, avatar: profile.avatar });
    } else {
      const wait = hub.wait(['hosted']);
      hub.send({ t: 'create', mode: 'p2p', room: cfg, name: profile.name, avatar: profile.avatar });
      const { code } = await wait;
      attach(new HostSession(hub, code, cfg, profile));
    }
    enterGame();
  } catch (err) {
    toast(err.message === 'sin servidor' ? 'Para jugar online abrí HaxBort desde tu servidor.' : `No se pudo crear la sala: ${err.message}`);
  }
}

async function joinRoom(code, { password = '', resume = null } = {}) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) {
    toast('Escribí el código de 5 letras de la sala.');
    $('join-code').focus();
    return false;
  }
  try {
    const hub = await ensureHub();
    const wait = hub.wait(['p2p', 'welcome']);
    let server = null;
    if (!resume || resume.mode === 'server') {
      // Puede ser una sala del servidor: preparo la sesión para no perder los primeros mensajes.
      server = new ServerSession(hub);
      server.onMessage = () => {};
    }
    const msg = resume ? { t: 'resume', code, id: resume.id, secret: resume.secret } : { t: 'join', code, name: profile.name, avatar: profile.avatar, password };
    hub.send(msg);
    let res;
    try {
      res = await wait;
    } catch (err) {
      server?.dispose();
      throw err;
    }
    if (res.t === 'welcome') {
      resetGameState();
      attach(server);
      onNet(res);
      enterGame();
      return true;
    }
    server?.dispose();
    const g = new GuestSession(hub, res.code, res.link);
    const mode = await g.open();
    if (g.closed) throw new Error('El anfitrión cerró la sala.');
    const welcome = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('El anfitrión no respondió.')), 10000);
      g.onMessage = (m) => {
        if (m?.t === 'welcome') {
          clearTimeout(timer);
          resolve(m);
        } else if (m?.t === 'error') {
          clearTimeout(timer);
          reject(Object.assign(new Error(m.text), { code: m.code }));
        }
      };
      g.onDown = (reason) => {
        clearTimeout(timer);
        reject(new Error(reason));
      };
    });
    g.send(resume ? { t: 'resume', id: resume.id, secret: resume.secret } : { t: 'join', name: profile.name, avatar: profile.avatar, password });
    let w;
    try {
      w = await welcome;
    } catch (err) {
      g.leave();
      throw err;
    }
    resetGameState();
    attach(g);
    onNet(w);
    enterGame();
    if (mode === 'relay') sysLine('No se pudo conectar directo con el anfitrión (red o firewall): vas por el servidor, con un poco más de ping.');
    return true;
  } catch (err) {
    if (err.code === 'password' || err.code === 'bad_password') {
      $('join-pass-field').hidden = false;
      $('join-code').value = code;
      $('join-pass').focus();
    }
    if (err.code === 'expired' && resume) return joinRoom(code);
    if (!resume) toast(err.message === 'sin servidor' ? 'Para jugar online abrí HaxBort desde tu servidor.' : err.message || 'No se pudo entrar.');
    return false;
  }
}

function practice() {
  resetGameState();
  attach(new LocalSession(profile));
  enterGame();
}

function enterGame() {
  clearTimeout(roomsTimer);
  show('game');
  openRoom();
  history.replaceState(null, '', app.sess.kind === 'local' ? location.pathname : `?sala=${app.sess.code || app.room?.code || ''}`);
}

function leaveRoom({ silent = false } = {}) {
  const s = app.sess;
  app.sess = null;
  app.reconnecting = false;
  try { s?.leave(); } catch { /* nada */ }
  writeJSON(sessionStorage, K.session, null);
  resetGameState();
  history.replaceState(null, '', location.pathname);
  app.joinCode = '';
  $('join-code').value = '';
  show('lobby');
  if (!silent) toast('Saliste de la sala.');
}

async function startReconnect(reason) {
  const saved = readJSON(sessionStorage, K.session, null);
  const s = app.sess;
  if (!saved || app.reconnecting || !s || s.kind === 'host' || s.kind === 'local') {
    endSession(reason);
    return;
  }
  app.reconnecting = true;
  showBanner('Reconectando…', 0);
  try { s.dispose?.(); } catch { /* nada */ }
  app.sess = null;
  for (let i = 0; i < 12 && app.reconnecting; i += 1) {
    await new Promise((r) => setTimeout(r, i === 0 ? 400 : 2000));
    if (!app.reconnecting) return;
    if (await joinRoom(saved.code, { resume: saved })) {
      app.reconnecting = false;
      $('banner').hidden = true;
      return;
    }
  }
  app.reconnecting = false;
  endSession(reason || 'No se pudo volver a la sala.');
}

function endSession(reason) {
  app.sess = null;
  writeJSON(sessionStorage, K.session, null);
  resetGameState();
  $('banner').hidden = true;
  show('lobby');
  toast(reason || 'Se terminó la sala.', 5000);
}

// ---------------------------------------------------------------- mensajes de la sala
function buildMatch() {
  const res = loadStadium(app.map.text);
  if (!res.ok) {
    toast('No se pudo leer el estadio de la sala.');
    return;
  }
  const st = app.map.tune ? normalizeKick(res.stadium).stadium : res.stadium;
  app.match = createMatch(st, {});
  app.pending = [];
  app.offsets = new Map();
}

function onNet(msg) {
  if (msg instanceof ArrayBuffer) return onSnapshot(msg);
  if (!msg || typeof msg !== 'object') return undefined;
  switch (msg.t) {
    case 'welcome':
      app.me = msg.id;
      if (app.sess) app.sess.code = msg.code;
      if (app.sess && (app.sess.kind === 'server' || app.sess.kind === 'guest')) {
        writeJSON(sessionStorage, K.session, { code: msg.code, id: msg.id, secret: msg.secret, mode: app.sess.kind });
      }
      break;
    case 'map':
      app.map = msg;
      buildMatch();
      renderRoom();
      break;
    case 'room': {
      const prev = app.room;
      app.room = msg;
      app.names = new Map(msg.players.map((p) => [p.id, p]));
      if (app.match) for (const p of app.match.players) {
        const info = app.names.get(p.id);
        if (info) { p.name = info.name; p.avatar = info.avatar; }
      }
      app.paused = msg.paused;
      $('paused-tag').hidden = !msg.paused;
      if (prev && prev.phase !== 'idle' && msg.phase === 'idle') openRoom();
      if (prev && prev.phase === 'idle' && msg.phase !== 'idle') {
        closeRoom();
        showBanner(`${msg.map.name} · ¡a jugar!`, 1300);
      }
      renderRoom();
      break;
    }
    case 'history':
      for (const item of msg.items) addChatItem(item, true);
      renderChat();
      break;
    case 'chat': case 'sys': case 'help':
      addChatItem(msg);
      if (msg.t === 'chat' && msg.id !== app.me) beep(880, 0.04, 'sine', 0.025);
      break;
    case 'error':
      addChatItem({ t: 'sys', text: msg.text });
      toast(msg.text);
      break;
    case 'ev':
      onEvents(msg.events);
      break;
    case 'kicked':
      app.sess?.dispose?.();
      endSession(msg.reason);
      break;
    default:
  }
  return undefined;
}

function discKey(d, i) {
  return d.playerId ? `p:${d.playerId}` : `m:${i}`;
}

function onSnapshot(buf) {
  const m = app.match;
  if (!m) return;
  const snap = decodeSnapshot(buf);
  if (!snap) return;
  const before = new Map(m.world.discs.map((d, i) => [discKey(d, i), [d.x, d.y]]));
  const { paused, ack } = applySnapshot(m, snap, app.names);
  app.paused = paused;
  while (app.pending.length && app.pending[0].seq <= ack) app.pending.shift();
  if (!paused && m.phase !== 'idle') {
    for (const inp of app.pending) {
      setInput(m, app.me, inp.bits);
      tick(m);
    }
  }
  // Suavizado: si la corrección movió algo un poquito, se ve deslizar en vez de saltar.
  m.world.discs.forEach((d, i) => {
    const key = discKey(d, i);
    const old = before.get(key);
    if (!old) return;
    const dx = old[0] - d.x;
    const dy = old[1] - d.y;
    const o = app.offsets.get(key) || [0, 0];
    if (dx * dx + dy * dy > 50 * 50) app.offsets.delete(key);
    else app.offsets.set(key, [o[0] + dx, o[1] + dy]);
  });
}

function onEvents(events) {
  for (const ev of events) {
    if (ev.type === 'kick') {
      if (ev.playerId !== app.me || performance.now() - app.myKickAt > 400) beep(220, 0.05, 'triangle', 0.08);
    } else if (ev.type === 'goal') {
      const team = TEAM_ES[ev.team];
      showBanner(ev.ownGoal ? `¡Gol en contra! Punto para ${team}` : `¡GOL de ${team}!${ev.scorerName ? ` · ${ev.scorerName}` : ''}`, 1500, ev.team);
      [523, 659, 784].forEach((f, i) => setTimeout(() => beep(f, 0.15, 'square', 0.06), i * 90));
    } else if (ev.type === 'overtime') showBanner('Empate al final: ¡gol de oro!', 2200);
    else if (ev.type === 'kickoff') showBanner(`Saque de ${TEAM_ES[ev.team]}`, 900);
    else if (ev.type === 'end') {
      const sc = app.match ? `${app.match.score.red} a ${app.match.score.blue}` : '';
      showBanner(ev.winner ? `¡Ganó ${TEAM_ES[ev.winner]}! ${sc}` : 'Fin del partido', 3300, ev.winner || '');
      [784, 659, 523, 784].forEach((f, i) => setTimeout(() => beep(f, 0.18, 'triangle', 0.07), i * 140));
    }
  }
}

// ---------------------------------------------------------------- teclado y entradas
const KEYS = { up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], kick: ['KeyX', 'Space', 'KeyK', 'ControlLeft', 'ShiftLeft', 'Numpad0'] };
const GAME_CODES = new Set(Object.values(KEYS).flat());
const pressed = new Set();
const touchState = { bits: 0 };

function inputBits() {
  if (app.roomOpen || chatOpen() || modalOpen() || document.hidden) return 0;
  let bits = 0;
  for (const [name, codes] of Object.entries(KEYS)) if (codes.some((c) => pressed.has(c))) bits |= INPUT[name];
  return bits | touchState.bits;
}

function gameStep() {
  const s = app.sess;
  if (!s || !app.match || !app.me) return;
  const bits = inputBits();
  app.seq += 1;
  s.sendInput(encodeInput(app.seq, bits, app.prevBits[0], app.prevBits[1]));
  app.prevBits = [bits, app.prevBits[0]];
  app.pending.push({ seq: app.seq, bits });
  if (app.pending.length > 120) app.pending.shift();
  const m = app.match;
  if (app.paused || m.phase === 'idle') return;
  setInput(m, app.me, bits);
  const evs = tick(m);
  if (evs.some((e) => e.type === 'kick' && e.playerId === app.me)) {
    app.myKickAt = performance.now();
    beep(220, 0.05, 'triangle', 0.08);
  }
}

// ---------------------------------------------------------------- bucle de dibujo
let last = performance.now();
let acc = 0;
let fpsT = 0;
let frames = 0;
let fpsShown = 0;
function loop(now) {
  acc += Math.min(250, now - last);
  last = now;
  let steps = 0;
  while (acc >= STEP_MS && steps < 6) {
    if (app.screen === 'game') gameStep();
    else demoStep();
    acc -= STEP_MS;
    steps += 1;
  }
  if (app.screen === 'game' && app.match) {
    drawWithOffsets(app.match);
    updateHud();
  } else if (demo) renderer.render(demo, { zoom: 1 });
  frames += 1;
  if (now - fpsT > 1000) {
    fpsShown = frames;
    frames = 0;
    fpsT = now;
    $('fps').textContent = `${fpsShown} FPS`;
    fadeChat();
    updateNetInfo();
    if (app.roomOpen) renderStateLine();
  }
  requestAnimationFrame(loop);
}

function drawWithOffsets(m) {
  const discs = m.world.discs;
  const applied = [];
  discs.forEach((d, i) => {
    const key = discKey(d, i);
    const o = app.offsets.get(key);
    if (!o) return;
    o[0] *= 0.8;
    o[1] *= 0.8;
    if (Math.abs(o[0]) + Math.abs(o[1]) < 0.05) {
      app.offsets.delete(key);
      return;
    }
    d.x += o[0];
    d.y += o[1];
    applied.push([d, o]);
  });
  const mine = m.players.find((p) => p.id === app.me);
  renderer.render(m, { focusId: mine && mine.team !== 'spectator' ? app.me : null, zoom: prefs.zoom });
  for (const [d, o] of applied) {
    d.x -= o[0];
    d.y -= o[1];
  }
}

function updateHud() {
  const m = app.match;
  $('s-red').textContent = m.score.red;
  $('s-blue').textContent = m.score.blue;
  $('clock').textContent = formatClock(m);
  $('clock').classList.toggle('ot', m.overtime);
}

function updateNetInfo() {
  const box = $('netinfo');
  const s = app.sess;
  if (!s || app.screen !== 'game') {
    box.replaceChildren();
    return;
  }
  const meInfo = app.names.get(app.me);
  let line;
  if (s.kind === 'local') line = 'Práctica';
  else if (s.kind === 'host') line = 'Sos el anfitrión · ping 0 ms';
  else line = `ping ${meInfo?.ping ?? '…'} ms · ${s.transportLabel}`;
  box.replaceChildren(s.kind === 'local' ? '' : el('b', { text: s.code || '' }), s.kind === 'local' ? '' : ' · ', line);
}

// ---------------------------------------------------------------- banner
let bannerTimer = 0;
function showBanner(text, ms = 1800, kind = '') {
  const b = $('banner');
  b.textContent = text;
  b.className = `banner ${kind}`;
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (ms > 0) bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
}

// ---------------------------------------------------------------- sala (Esc)
const myInfo = () => app.names.get(app.me);
const amAdmin = () => Boolean(myInfo()?.admin);

function openRoom() {
  if (app.screen !== 'game') return;
  app.roomOpen = true;
  pressed.clear();
  $('room').hidden = false;
  closeChatOverlay();
  $('room-chat-slot').append($('chat-log'), $('chat-bar'));
  $('chat-bar').hidden = false;
  renderChat();
  renderRoom();
}

function closeRoom() {
  if (!app.roomOpen) return;
  closePMenu();
  app.roomOpen = false;
  $('room').hidden = true;
  $('chat').append($('chat-log'), $('chat-bar'));
  $('chat-bar').hidden = true;
  $('chat').classList.remove('open');
  renderChat();
  $('pitch').focus({ preventScroll: true });
}

function act(msg) {
  app.sess?.send(msg);
}

function renderRoom() {
  const r = app.room;
  if (!r || !app.roomOpen) return;
  const admin = amAdmin();
  const s = app.sess;
  $('room-title').textContent = r.name;
  const admins = r.players.filter((p) => p.admin).map((p) => p.name);
  const humans = r.players.filter((p) => !p.bot).length;
  const where = s?.kind === 'host' ? 'Corre en tu compu' : s?.kind === 'guest' ? `Corre en la compu de ${admins[0] || 'el anfitrión'}` : s?.kind === 'server' ? 'Corre en el servidor' : 'Sin conexión';
  $('room-sub').replaceChildren(...[r.offline ? 'Práctica' : (r.isPublic ? 'Pública' : 'Privada'), `${humans}/${r.maxPlayers} jugadores`, r.hasPassword ? '🔒 con contraseña' : null,
    admin ? 'Vos sos admin 👑' : `Admin: ${admins.join(', ') || '—'}`, r.offline ? null : where].filter(Boolean)
    .flatMap((t, i) => (i ? [el('span', { text: '·' }), el('span', { text: t })] : [el('span', { text: t })])));
  $('btn-code').hidden = r.offline;
  $('room-code').textContent = r.code;
  for (const id of ['btn-auto', 'btn-rand', 'btn-lock', 'btn-reset']) $(id).disabled = !admin;
  $('btn-lock').classList.toggle('on', r.locked);
  $('lock-label').textContent = r.locked ? 'Bloqueado' : 'Bloquear';
  $('btn-lock').querySelector('.ic').textContent = r.locked ? '🔒' : '🔓';

  const teams = $('teams');
  teams.replaceChildren();
  const me = myInfo();
  for (const team of ['red', 'spectator', 'blue']) {
    const list = r.players.filter((p) => p.team === team);
    const canJoin = me && me.team !== team && (!r.locked || admin);
    const col = el('div', { class: `team ${team}`, 'data-team': team },
      el('div', { class: 'team-head' }, el('button', {
        class: 'team-join', type: 'button', disabled: !canJoin,
        title: canJoin ? `Pasarme a ${TEAM_ES[team]}` : (r.locked && !admin ? 'Equipos bloqueados por el admin' : ''),
        onclick: () => act({ t: 'team', id: app.me, team }),
      }, TEAM_ES[team], el('small', { text: String(list.length) }))));
    const ul = el('ul', { class: 'plist' });
    if (!list.length) ul.append(el('li', { class: 'empty', text: admin ? 'Arrastrá jugadores acá' : (team === 'spectator' ? 'Nadie mirando' : 'Sin jugadores') }));
    for (const p of list) {
      const color = team === 'spectator' ? '#5d6b66' : TEAM_COLORS[team];
      const li = el('li', { class: `prow${p.id === app.me ? ' me' : ''}${p.away ? ' away' : ''}`, draggable: admin ? 'true' : null, 'data-id': p.id },
        el('span', { class: 'av', style: `background:${color}`, text: (p.avatar || '?').slice(0, 2) }),
        el('span', { class: 'nm', text: p.name, title: p.name }),
        p.admin ? el('span', { class: 'crown', title: 'Admin', text: '👑' }) : null,
        p.bot ? el('span', { class: 'tag', text: 'bot' }) : null,
        p.away ? el('span', { class: 'tag', text: 'desconectado' }) : null,
        el('span', { class: `ping${p.ping > 150 ? ' bad' : ''}`, text: p.bot ? '' : (r.offline ? '' : (p.ping ?? '')) }),
        admin || p.id === app.me ? el('button', { class: 'more', type: 'button', 'aria-label': `Opciones de ${p.name}`, onclick: (e) => openPMenu(e, p) }, '⋯') : null);
      if (admin) {
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', p.id);
          e.dataTransfer.effectAllowed = 'move';
        });
      }
      ul.append(li);
    }
    col.append(ul);
    col.append(team !== 'spectator' && admin ? el('div', { class: 'team-foot' }, el('button', { class: 'btn', type: 'button', onclick: () => act({ t: 'bot', team }) }, '+ Bot')) : el('div'));
    if (admin) {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drop-on');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drop-on'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drop-on');
        const id = e.dataTransfer.getData('text/plain');
        if (id) act({ t: 'team', id, team });
      });
    }
    teams.append(col);
  }

  const idle = r.phase === 'idle';
  for (const [id, v] of [['time-select', r.settings.timeLimit], ['score-select', r.settings.scoreLimit]]) {
    const sel = $(id);
    if (![...sel.options].some((o) => Number(o.value) === v)) sel.append(el('option', { value: String(v), text: String(v) }));
    sel.value = String(v);
    sel.disabled = !admin || !idle;
  }
  $('stadium-name').textContent = `${r.map.name}${r.map.tuned ? ' · patada ajustada' : ''}`;
  $('btn-pick').textContent = admin && idle ? 'Elegir' : 'Ver';
  $('btn-start').hidden = !admin || !idle;
  $('btn-pause').hidden = !admin || idle;
  $('btn-stop').hidden = !admin || idle;
  $('btn-pause').textContent = r.paused ? '▶ Seguir' : '⏸ Pausar';
  $('bot-skill').value = String(r.botSkill);
  $('bot-skill').disabled = !admin;
  renderStateLine();
}

function renderStateLine() {
  const r = app.room;
  if (!r) return;
  const m = app.match;
  const idle = r.phase === 'idle';
  $('state-dot').className = `dot ${idle ? '' : 'live'}`;
  let text;
  if (idle) text = amAdmin() ? 'Sin partido. Armá los equipos y tocá Empezar.' : 'Sin partido. Esperando que el admin empiece.';
  else text = `${r.paused ? 'En pausa' : 'En juego'} · ${m ? `${m.score.red} - ${m.score.blue} · ${formatClock(m)}` : ''} · Esc para volver a la cancha`;
  $('state-text').textContent = text;
}

// menú de jugador (⋯)
function closePMenu() {
  document.querySelector('.pmenu')?.remove();
}
function openPMenu(e, p) {
  e.stopPropagation();
  closePMenu();
  const admin = amAdmin();
  const items = [];
  for (const team of ['red', 'spectator', 'blue']) {
    if (p.team !== team && (admin || (p.id === app.me && !app.room.locked))) items.push([`Mover a ${TEAM_ES[team]}`, () => act({ t: 'team', id: p.id, team })]);
  }
  if (admin && !p.bot && p.id !== app.me) items.push([p.admin ? 'Quitar admin' : 'Hacer admin', () => act({ t: 'admin', id: p.id, on: !p.admin })]);
  if (admin && p.id !== app.me) items.push([p.bot ? 'Sacar bot' : 'Echar', () => act({ t: 'kick', id: p.id })]);
  if (admin && !p.bot && p.id !== app.me && app.sess?.kind === 'server') items.push(['Banear', () => act({ t: 'kick', id: p.id, ban: true }), true]);
  if (!items.length) return;
  const menu = el('div', { class: 'pmenu', role: 'menu' }, el('b', { text: p.name }),
    items.map(([label, fn, danger]) => el('button', { type: 'button', role: 'menuitem', class: danger || /Echar|Sacar/.test(label) ? 'danger' : '', onclick: () => { closePMenu(); fn(); } }, label)));
  document.body.append(menu);
  const rect = e.currentTarget.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.right - w))}px`;
  menu.style.top = `${rect.bottom + h + 8 > window.innerHeight ? Math.max(8, rect.top - h - 4) : rect.bottom + 4}px`;
  menu.querySelector('button')?.focus();
}
document.addEventListener('click', (e) => { if (!e.target.closest('.pmenu')) closePMenu(); });

// ---------------------------------------------------------------- chat
const chat = [];
const chatOpen = () => !$('chat-bar').hidden && !app.roomOpen;

function addChatItem(m, silent = false) {
  chat.push({ ...m, at: performance.now() });
  if (chat.length > 120) chat.shift();
  if (!silent) renderChat();
}
const sysLine = (text) => addChatItem({ t: 'sys', text });

function renderChat() {
  const log = $('chat-log');
  log.replaceChildren();
  const full = app.roomOpen || $('chat').classList.contains('open');
  const now = performance.now();
  for (const m of chat.slice(full ? -80 : -8)) {
    const old = !full && now - m.at > 10000;
    const li = el('li', { class: `${m.t === 'chat' ? m.team || 'spectator' : m.t}${old ? ' old' : ''}` });
    if (m.t === 'chat') li.append(el('b', { text: `${m.name}: ` }), m.text);
    else li.textContent = m.text;
    log.append(li);
  }
  log.scrollTop = log.scrollHeight;
}

function fadeChat() {
  if (app.roomOpen || $('chat').classList.contains('open')) return;
  const now = performance.now();
  const items = [...$('chat-log').children];
  chat.slice(-8).forEach((m, i) => { if (items[i] && now - m.at > 10000) items[i].classList.add('old'); });
}

function openChatOverlay() {
  if (app.roomOpen) {
    $('chat-input').focus();
    return;
  }
  pressed.clear();
  $('chat-bar').hidden = false;
  $('chat').classList.add('open');
  renderChat();
  $('chat-input').focus();
}
function closeChatOverlay() {
  if (app.roomOpen) return;
  $('chat-bar').hidden = true;
  $('chat').classList.remove('open');
  $('chat-input').value = '';
  renderChat();
  $('pitch').focus({ preventScroll: true });
}

function setZoom(z, silent = false) {
  prefs.zoom = Math.round(Math.min(3, Math.max(1, z)) * 100) / 100;
  savePrefs();
  $('zoom-range').value = String(prefs.zoom);
  $('zoom-label').textContent = prefs.zoom <= 1.001 ? '(toda la cancha)' : `(×${prefs.zoom.toFixed(2)}, la cámara te sigue)`;
  if (!silent) toast(prefs.zoom <= 1.001 ? 'Zoom: toda la cancha' : `Zoom ×${prefs.zoom.toFixed(2)}`, 1200);
}

function submitChat(e) {
  e.preventDefault();
  const text = $('chat-input').value.trim().slice(0, 140);
  $('chat-input').value = '';
  if (text) {
    const c = norm(text.split(/\s+/)[0]);
    if (c === '/zoom') setZoom(Number(text.split(/\s+/)[1]) || 1);
    else if (c === '/limpiar' || c === '/clear') {
      chat.length = 0;
      renderChat();
    } else act({ t: 'chat', text });
  }
  if (!app.roomOpen) closeChatOverlay();
}

// ---------------------------------------------------------------- modales
const modalOpen = () => !$('maps-modal').hidden || !$('settings-modal').hidden;
function closeModals() {
  $('maps-modal').hidden = true;
  $('settings-modal').hidden = true;
}
function openMaps(tab = 'pick') {
  $('maps-modal').hidden = false;
  selectTab(tab);
}
function selectTab(name) {
  for (const x of document.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
  if (name === 'pick') {
    renderBuiltins();
    renderLibrary();
  }
}

/** Elegir estadio: solo el admin y con el partido parado. */
function chooseMap(payload) {
  if (!app.sess) {
    toast('Entrá a una sala para elegir el estadio.');
    return;
  }
  if (!amAdmin()) {
    toast('El estadio lo elige el admin.');
    return;
  }
  if (app.room?.phase !== 'idle') {
    toast('Pará el partido para cambiar el estadio.');
    return;
  }
  act({ t: 'map', ...payload });
  closeModals();
}

const thumbCache = new Map();
function thumbFor(stadium, key = null) {
  if (key && thumbCache.has(key)) return thumbCache.get(key);
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 140;
  createRenderer(c).thumbnail({ stadium, world: createWorld(stadium), players: [] });
  let url = '';
  try {
    url = c.toDataURL('image/png');
  } catch { /* sin miniatura */ }
  if (key) thumbCache.set(key, url);
  return url;
}

function renderBuiltins() {
  const grid = $('maps-builtin');
  grid.replaceChildren();
  for (const b of BUILTIN_MAPS) {
    const key = `b:${b.id}`;
    const res = loadStadium(b.text);
    grid.append(el('button', {
      type: 'button', class: `map-card ${app.room?.map.key === key ? 'on' : ''}`, 'aria-pressed': String(app.room?.map.key === key),
      onclick: () => chooseMap({ builtin: b.id }),
    }, el('img', { class: 'thumb', src: res.ok ? thumbFor(res.stadium, key) : '', alt: '' }), el('span', { text: b.name })));
  }
}

function reportList(items, cls) {
  if (!items.length) return null;
  const shown = items.slice(0, 12);
  return el('ul', { class: `report ${cls}` },
    shown.map((x) => el('li', {}, el('code', { text: x.where }), ` ${x.msg}`)),
    items.length > shown.length ? el('li', { class: 'muted', text: `… y ${items.length - shown.length} más` }) : null);
}
const stats = (st) => `${st.vertexes.length} vértices · ${st.segments.length} segmentos · ${st.discs.length} discos · ${st.planes.length} planos · ${st.joints.length} uniones · ${st.goals.length} arcos`;
function kickNote(st) {
  const k = kickCheck(st);
  if (!k.needed) return { k, text: `Patada: ${k.before.toFixed(1)} (normal, igual que las canchas de HaxBort).` };
  const how = k.before > KICK_REFERENCE ? 'más fuerte' : 'más débil';
  return { k, text: `Patada del mapa: ${k.before.toFixed(1)}, ${Math.round(Math.abs(k.before / KICK_REFERENCE - 1) * 100)}% ${how} que lo normal. Se ajusta a ${KICK_REFERENCE.toFixed(1)} para que se sienta como en las demás canchas.` };
}

function importText(text, fileName = 'texto pegado') {
  const size = new Blob([text]).size;
  const res = text ? loadStadium(text) : { ok: false, errors: [{ where: 'archivo', msg: 'supera 1 MB' }], warnings: [] };
  const box = el('article', { class: `import-card ${res.ok ? 'ok' : 'bad'}` });
  const results = $('import-results');
  if (results.firstElementChild?.tagName === 'P') results.replaceChildren();
  box.append(el('header', {},
    el('strong', { text: res.ok ? res.stadium.name : fileName }),
    el('span', { class: `pill ${res.ok ? 'good' : 'bad'}`, text: res.ok ? (res.warnings.length ? `cargó con ${res.warnings.length} advertencias` : 'cargó perfecto') : `${res.errors.length} errores` })),
  el('p', { class: 'muted small', text: `${fileName} · ${fmtKB(size)}` }));
  if (res.ok) box.append(el('img', { class: 'thumb', alt: `Vista previa de ${res.stadium.name}`, src: thumbFor(res.stadium) }), el('p', { class: 'small', text: stats(res.stadium) }));
  box.append(reportList(res.errors, 'errors'), reportList(res.warnings, 'warnings'));
  if (res.ok) {
    const { k, text: note } = kickNote(res.stadium);
    const tune = el('input', { type: 'checkbox', id: `tune-${Math.random().toString(36).slice(2)}`, checked: k.needed });
    box.append(el('p', { class: 'note', text: note }));
    if (k.needed) box.append(el('label', { class: 'check small', for: tune.id }, tune, 'Ajustar la fuerza de la patada (recomendado)'));
    const author = el('input', { class: 'input', placeholder: 'Autor u origen (ej: HaxMaps)', 'aria-label': 'Autor u origen' });
    let saved = null;
    const save = el('button', {
      class: 'btn primary', type: 'button',
      onclick: () => {
        saved = {
          id: Math.random().toString(36).slice(2, 10), name: res.stadium.name, author: author.value.trim() || 'Importado', createdAt: Date.now(), size,
          favorite: false, text, thumb: thumbFor(res.stadium), normalizeKick: tune.checked,
        };
        library.unshift(saved);
        saveLibrary();
        save.disabled = true;
        save.textContent = 'Guardado ✓';
        toast(`"${res.stadium.name}" quedó en tu biblioteca.`);
      },
    }, 'Guardar en mi biblioteca');
    const use = el('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        if (!save.disabled) save.click();
        chooseMap({ key: `l:${saved.id}`, text, tune: tune.checked });
      },
    }, 'Guardar y usar en la sala');
    box.append(author, el('div', { class: 'row' }, save, use));
  }
  results.prepend(box);
}

async function importFiles(files) {
  for (const f of files) {
    if (f.size > 1024 * 1024) importText('', `${f.name} (${fmtKB(f.size)})`);
    else importText(await f.text(), f.name);
  }
}

function renderLibrary() {
  const q = norm($('lib-search').value.trim());
  const list = $('lib-list');
  list.replaceChildren();
  const items = library
    .filter((m) => !q || norm(m.name).includes(q) || norm(m.author || '').includes(q))
    .sort((a, b) => (b.favorite - a.favorite) || b.createdAt - a.createdAt);
  $('lib-count').textContent = `${library.length} ${library.length === 1 ? 'mapa' : 'mapas'}`;
  if (!items.length) {
    list.append(el('p', { class: 'muted small', text: library.length ? 'Nada coincide con la búsqueda.' : 'Todavía no guardaste mapas. Importalos en la pestaña "Importar .hbs".' }));
    return;
  }
  for (const m of items) {
    const name = el('input', { class: 'input name', value: m.name, 'aria-label': 'Nombre del mapa' });
    name.addEventListener('change', () => {
      m.name = name.value.trim() || m.name;
      saveLibrary();
    });
    const author = el('input', { class: 'input small', value: m.author || '', 'aria-label': 'Autor u origen', placeholder: 'Autor u origen' });
    author.addEventListener('change', () => {
      m.author = author.value.trim();
      saveLibrary();
    });
    const res = loadStadium(m.text);
    const kc = res.ok ? kickCheck(res.stadium) : null;
    const tuneId = `lt-${m.id}`;
    const tune = el('input', { type: 'checkbox', id: tuneId, checked: m.normalizeKick !== false });
    tune.addEventListener('change', () => {
      m.normalizeKick = tune.checked;
      saveLibrary();
    });
    let confirmDel = false;
    const del = el('button', {
      class: 'btn ghost danger', type: 'button',
      onclick: () => {
        if (!confirmDel) {
          confirmDel = true;
          del.textContent = '¿Seguro? Tocá de nuevo';
          setTimeout(() => { confirmDel = false; del.textContent = 'Borrar'; }, 2500);
          return;
        }
        library = library.filter((x) => x.id !== m.id);
        saveLibrary();
        renderLibrary();
      },
    }, 'Borrar');
    const exportBox = el('div', { class: 'export', hidden: true });
    list.append(el('article', { class: 'lib-item' },
      m.thumb ? el('img', { class: 'thumb', src: m.thumb, alt: '' }) : el('div', { class: 'thumb' }),
      el('div', { class: 'lib-body' },
        el('div', { class: 'row' }, name,
          el('button', {
            class: `star ${m.favorite ? 'on' : ''}`, type: 'button', 'aria-pressed': String(Boolean(m.favorite)), 'aria-label': 'Favorito', title: 'Favorito',
            onclick: () => { m.favorite = !m.favorite; saveLibrary(); renderLibrary(); },
          }, m.favorite ? '★' : '☆')),
        author,
        el('p', { class: 'muted small', text: `${fmtDate(m.createdAt)} · ${fmtKB(m.size)}` }),
        kc && kc.needed ? el('label', { class: 'check small', for: tuneId }, tune, `Ajustar patada (${kc.before.toFixed(1)} → ${KICK_REFERENCE.toFixed(1)})`) : null,
        el('div', { class: 'row' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => chooseMap({ key: `l:${m.id}`, text: m.text, tune: m.normalizeKick !== false }) }, 'Usar en la sala'),
          el('button', {
            class: 'btn ghost', type: 'button',
            onclick: () => {
              exportBox.hidden = !exportBox.hidden;
              if (!exportBox.hidden && !exportBox.firstChild) {
                const ta = el('textarea', { class: 'input code', rows: 6, readonly: true, 'aria-label': 'Texto .hbs' });
                ta.value = m.text;
                exportBox.append(ta, el('button', {
                  class: 'btn', type: 'button',
                  onclick: async () => {
                    try {
                      await navigator.clipboard.writeText(m.text);
                      toast('Copiado. Pegalo en un archivo .hbs.');
                    } catch {
                      ta.select();
                      toast('Seleccioné el texto: copialo con Ctrl+C.');
                    }
                  },
                }, 'Copiar .hbs'));
              }
            },
          }, 'Exportar .hbs'),
          del),
        exportBox)));
  }
}

// ---------------------------------------------------------------- teclado global
function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (app.screen !== 'game') return;
  if (e.code === 'Escape') {
    e.preventDefault();
    closePMenu();
    if (modalOpen()) closeModals();
    else if (chatOpen()) closeChatOverlay();
    else if (app.roomOpen) {
      if (app.room?.phase !== 'idle') closeRoom();
      else if (typing(e)) e.target.blur();
    } else openRoom();
    return;
  }
  if (typing(e) || modalOpen()) return;
  if (e.code === 'KeyT' || e.code === 'Enter') {
    if (e.code === 'Enter' && !app.roomOpen) return;
    e.preventDefault();
    openChatOverlay();
    return;
  }
  if (app.roomOpen) return;
  if (['Equal', 'NumpadAdd'].includes(e.code) || e.key === '+') return setZoom(prefs.zoom * 1.15);
  if (['Minus', 'NumpadSubtract'].includes(e.code) || e.key === '-') return setZoom(prefs.zoom / 1.15);
  if (e.code === 'Digit0') return setZoom(1);
  if (GAME_CODES.has(e.code)) {
    pressed.add(e.code);
    e.preventDefault();
  }
  return undefined;
});
window.addEventListener('keyup', (e) => pressed.delete(e.code));
window.addEventListener('blur', () => pressed.clear());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  pressed.clear();
  touchState.bits = 0;
});
$('pitch').addEventListener('wheel', (e) => {
  if (app.screen !== 'game' || app.roomOpen) return;
  e.preventDefault();
  setZoom(prefs.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), true);
}, { passive: false });

function setupTouch() {
  if (!window.matchMedia?.('(pointer: coarse)').matches) return;
  document.body.classList.add('touch-on');
  $('touch').hidden = false;
  const stick = $('stick');
  const knob = $('knob');
  let sid = null;
  const update = (e) => {
    const r = stick.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    const max = r.width / 2;
    const k = len > max ? max / len : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    let bits = touchState.bits & INPUT.kick;
    if (len > max * 0.25) {
      const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      const dirs = { 0: 8, 1: 8 | 2, 2: 2, 3: 4 | 2, 4: 4, '-4': 4, '-3': 4 | 1, '-2': 1, '-1': 8 | 1 };
      bits |= dirs[oct] || 0;
    }
    touchState.bits = bits;
  };
  stick.addEventListener('pointerdown', (e) => {
    sid = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    update(e);
  });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) update(e); });
  const end = (e) => {
    if (e.pointerId !== sid) return;
    sid = null;
    knob.style.transform = '';
    touchState.bits &= INPUT.kick;
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
  const kick = $('kick');
  kick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    touchState.bits |= INPUT.kick;
    kick.classList.add('on');
  });
  const kend = () => {
    touchState.bits &= ~INPUT.kick;
    kick.classList.remove('on');
  };
  kick.addEventListener('pointerup', kend);
  kick.addEventListener('pointercancel', kend);
  kick.addEventListener('pointerleave', kend);
}

// ---------------------------------------------------------------- arranque
function bind() {
  $('btn-begin').addEventListener('click', () => show('name'));
  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => show(b.dataset.back));
  $('nick').addEventListener('input', updateAvatarPreview);
  $('avatar').addEventListener('input', updateAvatarPreview);
  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nick').value.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) {
      $('nick').focus();
      return;
    }
    profile = { name, avatar: $('avatar').value.trim().slice(0, 2) || name.slice(0, 1).toUpperCase() };
    writeJSON(localStorage, K.profile, profile);
    show('lobby');
    if (app.joinCode) joinRoom(app.joinCode);
  });
  $('create-form').addEventListener('submit', createRoom);
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom($('join-code').value, { password: $('join-pass').value });
  });
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    $('join-pass-field').hidden = true;
  });
  $('btn-refresh').addEventListener('click', refreshRooms);
  $('btn-practice').addEventListener('click', practice);

  $('btn-menu').addEventListener('click', () => (app.roomOpen ? closeRoom() : openRoom()));
  $('btn-chat').addEventListener('click', () => (chatOpen() ? closeChatOverlay() : openChatOverlay()));
  $('btn-zoom-in').addEventListener('click', () => setZoom(prefs.zoom * 1.15));
  $('btn-zoom-out').addEventListener('click', () => setZoom(prefs.zoom / 1.15));
  $('chat-bar').addEventListener('submit', submitChat);

  $('btn-code').addEventListener('click', async () => {
    const url = `${location.origin}/sala/${app.room?.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(`Link copiado: ${url}`);
    } catch {
      toast(`Pasales este link: ${url}`, 6000);
    }
  });
  $('btn-leave').addEventListener('click', () => leaveRoom());
  $('btn-settings').addEventListener('click', () => { $('settings-modal').hidden = false; });
  $('btn-auto').addEventListener('click', () => act({ t: 'auto' }));
  $('btn-rand').addEventListener('click', () => act({ t: 'rand' }));
  $('btn-lock').addEventListener('click', () => act({ t: 'lock' }));
  $('btn-reset').addEventListener('click', () => act({ t: 'reset' }));
  $('btn-start').addEventListener('click', () => act({ t: 'start' }));
  $('btn-pause').addEventListener('click', () => act({ t: 'pause' }));
  $('btn-stop').addEventListener('click', () => act({ t: 'stop' }));
  $('btn-pick').addEventListener('click', () => openMaps('pick'));
  for (const id of ['time-select', 'score-select']) {
    $(id).addEventListener('change', () => act({ t: 'rules', time: Number($('time-select').value), score: Number($('score-select').value) }));
  }

  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeModals);
  for (const m of ['maps-modal', 'settings-modal']) $(m).addEventListener('mousedown', (e) => { if (e.target === $(m)) closeModals(); });
  $('file-input').addEventListener('change', (e) => {
    importFiles([...e.target.files]);
    e.target.value = '';
  });
  $('btn-paste').addEventListener('click', () => {
    const t = $('paste-area').value;
    if (t.trim()) importText(t);
  });
  $('btn-sample').addEventListener('click', () => {
    $('paste-area').value = SAMPLE_LAB;
    importText(SAMPLE_LAB, 'laboratorio.hbs (ejemplo)');
  });
  $('lib-search').addEventListener('input', renderLibrary);
  const drop = $('drop');
  document.body.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    drop.classList.add('over');
  });
  document.body.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.body.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    drop.classList.remove('over');
    openMaps('import');
    importFiles(files);
  });

  $('zoom-range').addEventListener('input', (e) => setZoom(Number(e.target.value), true));
  $('bot-skill').addEventListener('change', (e) => act({ t: 'skill', value: Number(e.target.value) }));
  $('opt-sound').checked = prefs.sound;
  $('opt-sound').addEventListener('change', (e) => {
    prefs.sound = e.target.checked;
    savePrefs();
  });
}

async function init() {
  bind();
  setupTouch();
  setZoom(prefs.zoom, true);
  const params = new URLSearchParams(location.search);
  app.joinCode = (params.get('sala') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  show('welcome');
  setServerState();
  requestAnimationFrame(loop);
  try {
    await ensureHub();
  } catch {
    setServerState();
  }
  // Si recargaste la página en medio de una sala, volvés solo.
  const saved = readJSON(sessionStorage, K.session, null);
  if (saved && profile.name && app.serverOk) {
    showBanner('Volviendo a la sala…', 0);
    const ok = await joinRoom(saved.code, { resume: saved });
    $('banner').hidden = true;
    if (!ok) writeJSON(sessionStorage, K.session, null);
  }
}

init();
window.haxbort = { app };
