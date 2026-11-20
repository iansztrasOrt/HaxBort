// Una sala de HaxBort: jugadores, admin, equipos, chat, estadio y el partido autoritativo.
// La usa el servidor (una por código) y también el modo práctica del navegador, así las
// reglas son exactamente las mismas en los dos lados.
//
// transport.send(id, msg) manda un objeto (JSON) o un ArrayBuffer (foto binaria) a un jugador.
// transport.close(id, reason) lo desconecta (echado / baneado).

import { loadStadium, MAX_FILE_BYTES } from '../stadium/load.js';
import { normalizeKick } from '../stadium/tune.js';
import { createMatch, withBallRadius, addPlayer, removePlayer, setTeam, setInput, startMatch, stopMatch, tick, INPUT, TICK_RATE } from '../game/match.js';
import { botInput } from '../game/bot.js';
import { BUILTIN_MAPS } from '../builtinMaps.js';
import { snapshotBody, withAck } from '../net/protocol.js';

export const MAX_PLAYERS = 30;
const END_DELAY_TICKS = Math.round(3.5 * TICK_RATE); // cartel de fin y vuelta a la sala
const AWAY_GRACE_TICKS = 30 * TICK_RATE; // tiempo para reconectarse sin perder el lugar
// Búfer de entradas (jitter buffer adaptativo). Se consume UNA entrada por tick, igual que la
// predicción del cliente, para que el servidor simule exactamente lo mismo que predijo el jugador.
// Si durante toda una ventana la cola nunca bajó de QUEUE_EXCESS, esa demora sobra: se salta una
// entrada (conservando la patada) y la demora baja de a poco, sin descartar entradas por un pico
// de jitter. QUEUE_HARD sólo actúa después de un corte largo (mucho atraso de golpe).
const QUEUE_WINDOW = 30; // ticks (0,5 s)
const QUEUE_EXCESS = 2;
const QUEUE_HARD = 12;
const HISTORY = 40;
const TEAMS = ['red', 'blue', 'spectator'];
const TEAM_ES = { red: 'Rojo', blue: 'Azul', spectator: 'Espectadores' };
const BOT_NAMES = ['Ramona', 'Tito', 'Chiqui', 'Pocho', 'Mirta', 'Coco', 'Beba', 'Tano', 'Nené', 'Toto', 'Cacho', 'Pirucha', 'Lalo', 'Pipa', 'Kuka', 'Fito'];

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(CONTROL, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}
export const cleanName = (v) => cleanText(v, 20);
export const cleanAvatar = (v) => cleanText(v, 2).replace(/\s/g, '');
/** Límites del partido. Tiempo en minutos (0–60, de a medio minuto) y goles (0–99); 0 = sin límite. */
export const RULE_LIMITS = { time: { min: 0, max: 60, step: 0.5 }, score: { min: 0, max: 99 }, ball: { min: 3, max: 10 } };
export function validRules(msg, current) {
  const time = msg.time === undefined ? current.timeLimit : Number(msg.time);
  const score = msg.score === undefined ? current.scoreLimit : Number(msg.score);
  const ball = msg.ball === undefined ? (current.ballRadius ?? null) : msg.ball === null || msg.ball === 'default' ? null : Number(msg.ball);
  const T = RULE_LIMITS.time;
  const S = RULE_LIMITS.score;
  const B = RULE_LIMITS.ball;
  if (!Number.isFinite(time) || time < T.min || time > T.max) return { error: `El tiempo tiene que ser entre ${T.min} y ${T.max} minutos (0 = sin límite).` };
  if (!Number.isInteger(score) || score < S.min || score > S.max) return { error: `Los goles tienen que ser un número entero entre ${S.min} y ${S.max} (0 = sin límite).` };
  if (ball !== null && (!Number.isInteger(ball) || ball < B.min || ball > B.max)) return { error: `El radio de la pelota tiene que ser un número entero entre ${B.min} y ${B.max}.` };
  return { time: Math.round(time / T.step) * T.step, score, ball };
}
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const randomId = () => Math.random().toString(36).slice(2, 10);
const randomSecret = () => Array.from({ length: 4 }, randomId).join('');

export class Room {
  constructor({ code, name, password = '', maxPlayers = 10, isPublic = true, offline = false } = {}, transport) {
    this.code = code;
    this.name = cleanText(name, 32) || 'Sala de HaxBort';
    this.password = cleanText(password, 20);
    this.maxPlayers = Math.min(MAX_PLAYERS, Math.max(2, Math.round(Number(maxPlayers)) || 10));
    this.isPublic = Boolean(isPublic);
    this.offline = offline;
    this.transport = transport;
    this.members = new Map();
    this.settings = { timeLimit: 3, scoreLimit: 3, ballRadius: null }; // ballRadius null = el del estadio
    this.locked = false;
    this.paused = false;
    this.botSkill = 0.8;
    this.banned = new Set();
    this.history = [];
    this.endTimer = 0;
    this.dirty = true;
    this.seq = 0;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.setBuiltinMap('clasica');
  }

  // ---------------------------------------------------------------- miembros

  humans() {
    return [...this.members.values()].filter((m) => !m.bot);
  }

  get playerCount() {
    return this.members.size;
  }

  /** Revisa contraseña, cupo y ban, y suma al jugador (como espectador). No manda nada todavía.
   *  `clientId` identifica a la pestaña que pide entrar: si ya tiene un lugar en la sala (pedido
   *  repetido, reintento después de un error de red, recarga), se le devuelve ESE lugar en vez de
   *  crear otro jugador. Así una persona nunca aparece dos veces. */
  addMember({ name, avatar, password = '', ip = '', clientId = '' }) {
    if (ip && this.banned.has(ip)) return { ok: false, error: 'banned' };
    const cid = typeof clientId === 'string' ? clientId.slice(0, 40) : '';
    if (cid) {
      const same = [...this.members.values()].find((x) => !x.bot && x.clientId === cid);
      if (same) {
        same.connected = true;
        same.awayTicks = 0;
        same.queue = [];
        this.dirty = true;
        this.touch();
        return { ok: true, id: same.id, secret: same.secret, member: same, rejoin: true };
      }
    }
    if (this.password && cleanText(password, 20) !== this.password) return { ok: false, error: password ? 'bad_password' : 'password' };
    if (this.members.size >= this.maxPlayers) {
      // Si hay bots, uno le deja el lugar a la persona.
      const bot = [...this.members.values()].reverse().find((m) => m.bot);
      if (!bot) return { ok: false, error: 'full' };
      this.removeMember(bot.id, null);
    }
    let nick = cleanName(name) || 'Jugador';
    const taken = new Set([...this.members.values()].map((m) => norm(m.name)));
    for (let i = 2; taken.has(norm(nick)); i += 1) nick = `${cleanName(name).slice(0, 17) || 'Jugador'} ${i}`;
    const m = {
      id: `p${++this.seq}${randomId().slice(0, 4)}`, secret: randomSecret(), name: nick, avatar: cleanAvatar(avatar) || nick.slice(0, 1).toUpperCase(),
      team: 'spectator', admin: !this.humans().length, bot: false, joinedAt: this.seq, connected: true, awayTicks: 0,
      queue: [], lastSeq: 0, bits: 0, ping: null, ip, chatTimes: [], clientId: cid,
    };
    this.members.set(m.id, m);
    addPlayer(this.match, { id: m.id, name: m.name, avatar: m.avatar, team: 'spectator' });
    this.touch();
    return { ok: true, id: m.id, secret: m.secret, member: m };
  }

  /** Primer envío a un jugador recién entrado (o reconectado). */
  greet(id, { rejoin = false, rid } = {}) {
    const m = this.members.get(id);
    if (!m) return;
    this.send(id, { t: 'welcome', id, secret: m.secret, code: this.code, offline: this.offline, ...(rid ? { rid } : {}) });
    this.send(id, this.mapMessage());
    this.send(id, this.state());
    this.send(id, { t: 'history', items: this.history });
    if (rejoin) this.sys(`${m.name} volvió.`);
    else if (m.admin && this.humans().length === 1) {
      this.tell(id, this.offline ? 'Práctica contra bots. Armá los equipos y tocá Empezar. Esc abre la sala, T el chat.' : `Creaste la sala. Pasá el código ${this.code} (o el link del botón Código) para que entren tus amigos.`);
    } else this.sys(`${m.name} entró a la sala.`);
  }

  resume(id, secret) {
    const m = this.members.get(id);
    if (!m || m.bot || m.secret !== secret) return false;
    m.connected = true;
    m.awayTicks = 0;
    m.queue = [];
    this.dirty = true;
    this.touch();
    return true;
  }

  /** Se cortó la conexión: el lugar queda guardado un rato. */
  disconnect(id) {
    const m = this.members.get(id);
    if (!m || !m.connected) return;
    m.connected = false;
    m.awayTicks = 0;
    m.queue = [];
    m.bits = 0;
    setInput(this.match, id, 0);
    this.dirty = true;
  }

  removeMember(id, reason = 'salió de la sala') {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    removePlayer(this.match, id);
    if (reason) this.sys(`${m.name} ${reason}.`);
    this.ensureAdmin();
    this.dirty = true;
  }

  ensureAdmin() {
    const humans = this.humans();
    if (!humans.length || humans.some((h) => h.admin)) return;
    const next = humans.filter((h) => h.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0] || humans[0];
    next.admin = true;
    this.sys(`${next.name} ahora es admin.`);
  }

  get empty() {
    return this.humans().length === 0;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---------------------------------------------------------------- envío

  send(id, msg) {
    this.transport.send(id, msg);
  }

  broadcast(msg) {
    for (const m of this.members.values()) if (!m.bot && m.connected) this.transport.send(m.id, msg);
  }

  remember(item) {
    this.history.push(item);
    if (this.history.length > HISTORY) this.history.shift();
  }

  sys(text) {
    const msg = { t: 'sys', text };
    this.remember(msg);
    this.broadcast(msg);
  }

  tell(id, text, kind = 'sys') {
    this.send(id, { t: kind, text });
  }

  state() {
    return {
      t: 'room', code: this.code, name: this.name, isPublic: this.isPublic, hasPassword: Boolean(this.password), maxPlayers: this.maxPlayers,
      locked: this.locked, paused: this.paused, phase: this.match.phase, settings: this.settings, botSkill: this.botSkill,
      map: { key: this.map.key, name: this.map.name, tuned: this.map.tuned }, offline: this.offline,
      players: [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({
        id: m.id, name: m.name, avatar: m.avatar, team: m.team, admin: m.admin, bot: m.bot, ping: m.ping, away: !m.connected,
      })),
    };
  }

  summary() {
    return {
      code: this.code, name: this.name, players: this.humans().length, bots: this.members.size - this.humans().length, max: this.maxPlayers,
      hasPassword: Boolean(this.password), map: this.map.name, playing: this.match.phase !== 'idle',
    };
  }

  mapMessage() {
    return { t: 'map', key: this.map.key, name: this.map.name, text: this.map.text, tune: this.map.tune };
  }

  // ---------------------------------------------------------------- estadio

  setBuiltinMap(id) {
    const b = BUILTIN_MAPS.find((x) => x.id === id);
    if (!b) return { ok: false, error: 'No existe ese estadio.' };
    return this.setMap({ key: `b:${b.id}`, text: b.text, tune: false });
  }

  setMap({ key, text, tune }) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'El estadio está vacío.' };
    if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) return { ok: false, error: 'El estadio supera 1 MB.' };
    const res = loadStadium(text);
    if (!res.ok) return { ok: false, error: `El estadio tiene errores: ${res.errors[0]?.where || ''} ${res.errors[0]?.msg || ''}`.trim() };
    const tuned = tune ? normalizeKick(res.stadium) : { stadium: res.stadium, needed: false };
    this.map = { key: cleanText(key, 40) || 'custom', name: res.stadium.name, text, tune: Boolean(tune), tuned: Boolean(tuned.needed) };
    this.stadium = tuned.stadium;
    this.rebuildMatch();
    return { ok: true };
  }

  rebuildMatch() {
    this.match = createMatch(withBallRadius(this.stadium, this.settings.ballRadius), { ...this.settings });
    for (const m of this.members.values()) addPlayer(this.match, { id: m.id, name: m.name, avatar: m.avatar, team: m.team });
    this.endTimer = 0;
    this.paused = false;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- equipos

  moveTo(id, team) {
    const m = this.members.get(id);
    if (!m || !TEAMS.includes(team) || m.team === team) return false;
    m.team = team;
    setTeam(this.match, id, team);
    this.dirty = true;
    return true;
  }

  addBot(team) {
    if (this.members.size >= this.maxPlayers) return null;
    const used = new Set([...this.members.values()].map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${this.seq + 1}`;
    const m = {
      id: `b${++this.seq}`, secret: '', name, avatar: name[0].toUpperCase(), team: 'spectator', admin: false, bot: true, joinedAt: this.seq,
      connected: true, awayTicks: 0, queue: [], lastSeq: 0, bits: 0, ping: null, ip: '', chatTimes: [],
    };
    this.members.set(m.id, m);
    addPlayer(this.match, { id: m.id, name: m.name, avatar: m.avatar, team: 'spectator' });
    this.moveTo(m.id, team);
    return m;
  }

  shuffle() {
    const playing = [...this.members.values()].filter((m) => m.team !== 'spectator');
    for (let i = playing.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [playing[i], playing[j]] = [playing[j], playing[i]];
    }
    const first = Math.random() < 0.5 ? 'red' : 'blue';
    const second = first === 'red' ? 'blue' : 'red';
    playing.forEach((m) => this.moveTo(m.id, 'spectator'));
    playing.forEach((m, i) => this.moveTo(m.id, i % 2 === 0 ? first : second));
  }

  autoPick() {
    const spec = [...this.members.values()].filter((m) => m.team === 'spectator').sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!spec) return null;
    const count = (t) => [...this.members.values()].filter((m) => m.team === t).length;
    const team = count('red') <= count('blue') ? 'red' : 'blue';
    this.moveTo(spec.id, team);
    return { member: spec, team };
  }

  // ---------------------------------------------------------------- partido

  start() {
    this.match.settings.timeLimit = this.settings.timeLimit;
    this.match.settings.scoreLimit = this.settings.scoreLimit;
    startMatch(this.match);
    this.paused = false;
    this.endTimer = 0;
    this.dirty = true;
  }

  stop() {
    stopMatch(this.match);
    this.paused = false;
    this.endTimer = 0;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- entradas

  /** Entradas recibidas (con redundancia): encola las que faltan, en orden. */
  input(id, list) {
    const m = this.members.get(id);
    if (!m || m.bot || !m.connected || !Array.isArray(list)) return;
    for (const { seq, bits } of list) {
      const last = m.queue.length ? m.queue[m.queue.length - 1].seq : m.lastSeq;
      if (seq <= last) continue;
      m.queue.push({ seq, bits });
    }
    if (m.queue.length > 30) m.queue.splice(0, m.queue.length - 30);
  }

  /** Toma la entrada de este tick (una por tick). La demora sobrante se recorta de a una entrada
   *  y sólo si se mantuvo toda una ventana; nunca se pierde una patada apretada. */
  consumeInput(m) {
    const len = m.queue.length;
    m.qMin = Math.min(m.qMin ?? len, len);
    m.qTicks = (m.qTicks || 0) + 1;
    let skip = 0;
    if (len > QUEUE_HARD) skip = len - QUEUE_EXCESS;
    else if (m.qTicks >= QUEUE_WINDOW) {
      if (m.qMin >= QUEUE_EXCESS) skip = 1;
      m.qTicks = 0;
      m.qMin = Infinity;
    }
    if (skip) { m.qTicks = 0; m.qMin = Infinity; }
    if (!len) return;
    let kick = false;
    for (let i = 0; i < skip; i += 1) {
      const old = m.queue.shift();
      if (old.bits & INPUT.kick) kick = true;
    }
    const next = m.queue.shift();
    m.bits = next.bits | (kick && !(next.bits & INPUT.kick) && !(m.bits & INPUT.kick) ? INPUT.kick : 0);
    m.lastSeq = next.seq;
  }

  // ---------------------------------------------------------------- tick

  step() {
    for (const m of this.members.values()) {
      if (m.bot) continue;
      if (!m.connected) {
        m.awayTicks += 1;
        if (m.awayTicks >= AWAY_GRACE_TICKS) this.removeMember(m.id, 'se desconectó');
        continue;
      }
      this.consumeInput(m);
    }
    const phase = this.match.phase;
    if (!this.paused && phase !== 'idle') {
      for (const m of this.members.values()) {
        if (m.team === 'spectator') continue;
        setInput(this.match, m.id, m.bot ? botInput(this.match, m.id, { skill: this.botSkill }) : m.connected ? m.bits : 0);
      }
      const events = tick(this.match);
      if (events.length) this.onEvents(events);
      if (this.endTimer > 0) {
        this.endTimer -= 1;
        if (this.endTimer === 0) {
          stopMatch(this.match);
          this.dirty = true;
        }
      }
    }
    // Una foto por tick (60 por segundo): lo más fresco posible para todos.
    const body = snapshotBody(this.match, { paused: this.paused });
    for (const m of this.members.values()) if (!m.bot && m.connected) this.send(m.id, withAck(body, m.lastSeq));
    if (this.dirty || phase !== this.match.phase) {
      this.dirty = false;
      this.broadcast(this.state());
    }
  }

  onEvents(events) {
    const out = [];
    for (const ev of events) {
      if (ev.type === 'goal') {
        const scorer = this.members.get(ev.scorerId);
        const sc = `${this.match.score.red} - ${this.match.score.blue}`;
        const msg = { t: 'sys', text: ev.ownGoal ? `Gol en contra de ${scorer?.name || '?'}. ${sc}` : `¡Gol de ${scorer?.name || TEAM_ES[ev.team]}! ${sc}` };
        this.remember(msg);
        out.push({ ...ev, scorerName: scorer?.name || null });
        this.broadcast(msg);
      } else if (ev.type === 'end') {
        this.endTimer = END_DELAY_TICKS;
        const txt = ev.winner ? `Ganó ${TEAM_ES[ev.winner]} ${this.match.score.red} a ${this.match.score.blue}.` : 'Terminó el partido.';
        this.sys(txt);
        out.push(ev);
      } else out.push(ev);
    }
    this.broadcast({ t: 'ev', events: out });
  }

  // ---------------------------------------------------------------- acciones

  /** Mensaje de texto de un jugador. Devuelve false si no lo entendió. */
  handle(id, msg) {
    const me = this.members.get(id);
    if (!me || !msg || typeof msg !== 'object') return false;
    this.touch();
    const admin = me.admin;
    const deny = () => this.tell(id, 'Eso lo puede hacer solo el admin.');
    const idle = this.match.phase === 'idle';
    switch (msg.t) {
      case 'chat':
        return this.chat(me, msg.text);
      case 'team': {
        const target = this.members.get(String(msg.id || id));
        if (!target || !TEAMS.includes(msg.team)) return true;
        if (target.id !== id && !admin) return deny();
        if (target.id === id && this.locked && !admin) return this.tell(id, 'Los equipos están bloqueados: pedile al admin que te mueva.');
        if (this.moveTo(target.id, msg.team) && target.id !== id) this.sys(`${target.name} pasó a ${TEAM_ES[msg.team]}.`);
        return true;
      }
      case 'start':
        if (!admin) return deny();
        this.start();
        this.sys(`${me.name} empezó el partido en ${this.map.name}.`);
        return true;
      case 'stop':
        if (!admin) return deny();
        if (!idle) {
          this.stop();
          this.sys(`${me.name} paró el partido.`);
        }
        return true;
      case 'pause':
        if (!admin) return deny();
        if (!idle) {
          this.paused = !this.paused;
          this.dirty = true;
          this.sys(this.paused ? `${me.name} pausó el partido.` : 'Sigue el partido.');
        }
        return true;
      case 'rules': {
        if (!admin) return deny();
        if (!idle) return this.tell(id, 'Pará el partido para cambiar las reglas.');
        const r = validRules(msg, this.settings);
        if (r.error) return this.tell(id, r.error);
        const fmtTime = (t) => (t ? `${String(t).replace('.', ',')} min` : 'sin límite');
        if (r.time !== this.settings.timeLimit) this.sys(`Tiempo: ${fmtTime(r.time)}.`);
        if (r.score !== this.settings.scoreLimit) this.sys(`Goles para ganar: ${r.score || 'sin límite'}.`);
        this.settings.timeLimit = r.time;
        this.settings.scoreLimit = r.score;
        this.match.settings.timeLimit = r.time;
        this.match.settings.scoreLimit = r.score;
        if (r.ball !== this.settings.ballRadius) {
          this.settings.ballRadius = r.ball;
          this.rebuildMatch(); // partido parado: se rearma con la pelota nueva
          this.sys(`Pelota: radio ${r.ball ?? `${this.stadium.discs[0]?.radius ?? '-'} (el del estadio)`}.`);
        }
        this.dirty = true;
        return true;
      }
      case 'map': {
        if (!admin) return deny();
        if (!idle) return this.tell(id, 'Pará el partido para cambiar el estadio.');
        const res = typeof msg.builtin === 'string' ? this.setBuiltinMap(msg.builtin) : this.setMap({ key: msg.key, text: msg.text, tune: msg.tune !== false });
        if (!res.ok) return this.tell(id, res.error, 'error');
        this.broadcast(this.mapMessage());
        this.sys(`Estadio: ${this.map.name}${this.map.tuned ? ' (patada ajustada)' : ''}.`);
        return true;
      }
      case 'lock':
        if (!admin) return deny();
        this.locked = !this.locked;
        this.dirty = true;
        this.sys(this.locked ? 'Equipos bloqueados: solo el admin los cambia.' : 'Equipos desbloqueados.');
        return true;
      case 'auto': {
        if (!admin) return deny();
        const r = this.autoPick();
        if (r) this.sys(`${r.member.name} pasó a ${TEAM_ES[r.team]}.`);
        return true;
      }
      case 'rand':
        if (!admin) return deny();
        this.shuffle();
        this.sys('Equipos mezclados.');
        return true;
      case 'reset':
        if (!admin) return deny();
        for (const m of this.members.values()) this.moveTo(m.id, 'spectator');
        this.sys('Todos a espectadores.');
        return true;
      case 'bot': {
        if (!admin) return deny();
        const team = msg.team === 'blue' ? 'blue' : 'red';
        const b = this.addBot(team);
        if (!b) return this.tell(id, 'La sala está llena.');
        this.sys(`${b.name} (bot) entró al ${TEAM_ES[team]}.`);
        return true;
      }
      case 'skill':
        if (!admin) return deny();
        this.botSkill = Math.min(1, Math.max(0.3, Number(msg.value) || 0.8));
        this.dirty = true;
        return true;
      case 'kick': {
        if (!admin) return deny();
        const target = this.members.get(String(msg.id));
        if (!target || target.id === id) return true;
        if (target.bot) {
          this.removeMember(target.id, 'salió de la sala');
          return true;
        }
        if (msg.ban && target.ip) this.banned.add(target.ip);
        this.transport.close(target.id, msg.ban ? 'Te banearon de la sala.' : 'Te echaron de la sala.');
        this.removeMember(target.id, msg.ban ? 'fue baneado' : 'fue echado');
        return true;
      }
      case 'admin': {
        if (!admin) return deny();
        const target = this.members.get(String(msg.id));
        if (!target || target.bot) return true;
        if (target.id === id && !msg.on && !this.humans().some((h) => h.admin && h.id !== id)) return this.tell(id, 'Tiene que quedar al menos un admin.');
        target.admin = Boolean(msg.on);
        this.dirty = true;
        this.sys(target.admin ? `${target.name} ahora es admin.` : `${target.name} ya no es admin.`);
        return true;
      }
      case 'avatar':
        me.avatar = cleanAvatar(msg.text) || me.name.slice(0, 1).toUpperCase();
        for (const p of this.match.players) if (p.id === id) p.avatar = me.avatar;
        this.dirty = true;
        return true;
      case 'roomcfg': {
        if (!admin) return deny();
        if (typeof msg.password === 'string') this.password = cleanText(msg.password, 20);
        if (typeof msg.isPublic === 'boolean') this.isPublic = msg.isPublic;
        if (msg.maxPlayers) this.maxPlayers = Math.min(MAX_PLAYERS, Math.max(this.members.size, 2, Number(msg.maxPlayers) || this.maxPlayers));
        this.dirty = true;
        return true;
      }
      case 'leave':
        this.removeMember(id);
        return true;
      default:
        return false;
    }
  }

  chat(me, raw) {
    const text = cleanText(raw, 140);
    if (!text) return true;
    const now = Date.now();
    me.chatTimes = me.chatTimes.filter((t) => now - t < 5000);
    if (me.chatTimes.length >= 6) return this.tell(me.id, 'Más despacio con el chat 🙂');
    me.chatTimes.push(now);
    if (text.startsWith('/')) return this.command(me, text);
    const msg = { t: 'chat', id: me.id, name: me.name, team: me.team, text };
    this.remember(msg);
    this.broadcast(msg);
    return true;
  }

  findMember(q) {
    const n = norm(q.replace(/^@/, ''));
    if (!n) return null;
    const list = [...this.members.values()];
    return list.find((m) => norm(m.name) === n) || list.find((m) => norm(m.name).startsWith(n)) || null;
  }

  command(me, text) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = norm(rawCmd || '');
    const arg = args.join(' ');
    const act = (msg) => this.handle(me.id, msg);
    const team = (t) => (['azul', 'blue', 'b'].includes(norm(t)) ? 'blue' : ['rojo', 'red', 'r'].includes(norm(t)) ? 'red' : ['espectador', 'espectadores', 'spec', 'e'].includes(norm(t)) ? 'spectator' : null);
    switch (cmd) {
      case 'help': case 'ayuda': case 'comandos':
        [
          '/avatar XX — tu avatar (1 o 2 caracteres)', '/rojo · /azul · /espectador — cambiarte de equipo',
          'Admin: /empezar · /parar · /pausa · /mezclar · /auto · /bloquear', 'Admin: /mapa nombre · /goles N · /tiempo N · /pelota N · /bot rojo|azul',
          'Admin: /echar nombre · /ban nombre · /admin nombre · /clave texto (vacío = sin clave)', 'En tu pantalla: /zoom N · /limpiar · /extrapolation [ms|default]',
        ].forEach((h) => this.tell(me.id, h, 'help'));
        return true;
      case 'avatar': return act({ t: 'avatar', text: arg });
      case 'rojo': case 'azul': case 'espectador': case 'red': case 'blue': case 'spec': return act({ t: 'team', id: me.id, team: team(cmd) });
      case 'empezar': case 'start': case 'reiniciar': case 'rr': return act({ t: 'start' });
      case 'parar': case 'stop': return act({ t: 'stop' });
      case 'pausa': case 'pause': case 'p': return act({ t: 'pause' });
      case 'mezclar': case 'rand': case 'random': return act({ t: 'rand' });
      case 'auto': return act({ t: 'auto' });
      case 'bloquear': case 'lock': return act({ t: 'lock' });
      case 'bot': {
        const t = team(arg);
        if (t !== 'red' && t !== 'blue') return this.tell(me.id, 'Usá /bot rojo o /bot azul.');
        return act({ t: 'bot', team: t });
      }
      case 'mapa': case 'map': {
        const q = norm(arg);
        const b = BUILTIN_MAPS.find((x) => norm(x.name) === q || x.id === q) || BUILTIN_MAPS.find((x) => q && norm(x.name).includes(q));
        if (!b) return this.tell(me.id, `Estadios: ${BUILTIN_MAPS.map((x) => x.name).join(', ')}. Los tuyos, desde "Elegir".`);
        return act({ t: 'map', builtin: b.id });
      }
      case 'goles': case 'score': {
        const n = Number(arg);
        if (!Number.isInteger(n)) return this.tell(me.id, 'Usá /goles N (0 = sin límite).');
        act({ t: 'rules', score: n, time: this.settings.timeLimit });
        return true;
      }
      case 'pelota': case 'ball': {
        if (!arg || ['default', 'defecto', 'normal'].includes(norm(arg))) {
          if (!arg) return this.tell(me.id, `Pelota: radio ${this.settings.ballRadius ?? `${this.stadium.discs[0]?.radius} (el del estadio)`}. Usá /pelota N (3 a 10) o /pelota default.`);
          act({ t: 'rules', ball: null });
          return true;
        }
        act({ t: 'rules', ball: Number(arg) });
        return true;
      }
      case 'tiempo': case 'time': {
        const n = Number(arg);
        if (!Number.isFinite(n)) return this.tell(me.id, 'Usá /tiempo N en minutos (0 = sin límite).');
        act({ t: 'rules', time: n, score: this.settings.scoreLimit });
        return true;
      }
      case 'echar': case 'kick': case 'ban': {
        const target = this.findMember(arg);
        if (!target) return this.tell(me.id, `No encontré a "${arg}".`);
        return act({ t: 'kick', id: target.id, ban: cmd === 'ban' });
      }
      case 'admin': {
        const target = this.findMember(arg);
        if (!target) return this.tell(me.id, `No encontré a "${arg}".`);
        return act({ t: 'admin', id: target.id, on: !target.admin });
      }
      case 'clave': case 'password': {
        if (!me.admin) return this.tell(me.id, 'Eso lo puede hacer solo el admin.');
        act({ t: 'roomcfg', password: arg });
        return this.tell(me.id, arg ? 'Contraseña cambiada.' : 'La sala quedó sin contraseña.');
      }
      default:
        return this.tell(me.id, `No conozco "/${rawCmd}". Escribí /help.`);
    }
  }

  setPing(id, ms) {
    const m = this.members.get(id);
    if (!m) return;
    const v = Math.max(0, Math.round(ms));
    if (m.ping !== v) {
      m.ping = v;
      this.dirty = true;
    }
  }
}
