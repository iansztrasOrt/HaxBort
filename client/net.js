// Conexiones del navegador.
//
//  Hub            WebSocket al servidor (lista de salas, códigos, señalización y relay).
//  ServerSession  sala que corre en el servidor.
//  HostSession    sala que corre en ESTE navegador (anfitrión); los demás se conectan directo (WebRTC).
//  GuestSession   unirse a la sala de otro navegador: canal directo, o por el servidor si no se puede.
//  LocalSession   práctica sin conexión.
//
// Todas exponen lo mismo a la app: send(obj), sendInput(buf), leave(), y llaman a
// onMessage(msg | ArrayBuffer) y onDown(motivo).

import { Room } from '../shared/room/room.js';
import { createTicker } from '../shared/room/ticker.js';
import { decodeInput } from '../shared/net/protocol.js';

const RELAY = 0xfe;
const CHUNK = 48 * 1024;
const DIRECT_TIMEOUT_MS = 6000;
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ---------------------------------------------------------------- reloj que no se frena en segundo plano
/** En el navegador, los timers de una pestaña oculta se frenan. Un Worker que avisa cada 4 ms no. */
export function createBrowserTicker(stepFn) {
  let worker = null;
  try {
    const src = 'setInterval(function(){postMessage(0)},4)';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch {
    worker = null;
  }
  if (!worker) return createTicker(stepFn);
  const STEP = 1000 / 60;
  let next = performance.now() + STEP;
  worker.onmessage = () => {
    const t = performance.now();
    let n = 0;
    while (t >= next && n < 5) {
      try {
        stepFn();
      } catch (e) {
        console.error('[tick]', e);
      }
      next += STEP;
      n += 1;
    }
    if (t - next > STEP * 5) next = t + STEP;
  };
  return { stop: () => worker.terminate() };
}

// ---------------------------------------------------------------- pedazos (mensajes grandes por WebRTC)
function sendRel(channel, msg) {
  const s = JSON.stringify(msg);
  if (s.length <= CHUNK) {
    channel.send(s);
    return;
  }
  const id = Math.random().toString(36).slice(2, 9);
  const n = Math.ceil(s.length / CHUNK);
  for (let i = 0; i < n; i += 1) channel.send(JSON.stringify({ t: '~', id, i, n, s: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
}
function chunkReader(onMsg) {
  const parts = new Map();
  return (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.t !== '~') return onMsg(msg);
    const p = parts.get(msg.id) || [];
    p[msg.i] = msg.s;
    parts.set(msg.id, p);
    if (p.filter((x) => x !== undefined).length === msg.n) {
      parts.delete(msg.id);
      try {
        onMsg(JSON.parse(p.join('')));
      } catch { /* roto */ }
    }
  };
}
function relayFrame(link, buf) {
  const src = new Uint8Array(buf);
  const out = new Uint8Array(src.length + 3);
  out[0] = RELAY;
  out[1] = (link >> 8) & 255;
  out[2] = link & 255;
  out.set(src, 3);
  return out.buffer;
}

// ---------------------------------------------------------------- Hub
export class Hub {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = new Map();
    this.binary = null; // (ArrayBuffer) => void   — fotos de una sala del servidor
    this.relayBinary = new Map(); // link → (ArrayBuffer) => void   — invitado
    this.relayAny = null; // (ArrayBuffer, link) => void              — anfitrión
    this.rtt = null;
    this.onClose = null;
  }

  connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.close(); } catch { /* nada */ }
        reject(new Error('timeout'));
      }, timeoutMs);
      ws.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve(this);
      };
      ws.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('error'));
      };
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.onClose?.();
        }
      };
      ws.onmessage = (e) => this.receive(e.data);
    });
  }

  get open() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  receive(data) {
    if (data instanceof ArrayBuffer) {
      const b = new Uint8Array(data);
      if (b[0] === RELAY && b.length >= 3) {
        const link = (b[1] << 8) | b[2];
        (this.relayBinary.get(link) || this.relayAny)?.(data.slice(3), link);
      } else this.binary?.(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'ping') {
      this.send({ t: 'pong', ts: msg.ts });
      return;
    }
    const fns = this.handlers.get(msg.t) || this.handlers.get('*');
    if (fns) for (const fn of fns) fn(msg);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  /** Espera un mensaje de alguno de estos tipos (o error). Con `match`, sólo cuentan los
   *  mensajes que cumplen la condición (p. ej. la respuesta a ESTE pedido y no a uno viejo). */
  wait(types, timeoutMs = 10000, match = null) {
    return new Promise((resolve, reject) => {
      const offs = [];
      const timer = setTimeout(() => {
        offs.forEach((f) => f());
        reject(Object.assign(new Error('El servidor no respondió. Probá de nuevo.'), { code: 'timeout' }));
      }, timeoutMs);
      for (const t of [...types, 'error']) {
        offs.push(this.on(t, (msg) => {
          if (match && !match(msg)) return;
          clearTimeout(timer);
          offs.forEach((f) => f());
          if (msg.t === 'error') reject(Object.assign(new Error(msg.text || 'error'), { code: msg.code }));
          else resolve(msg);
        }));
      }
    });
  }

  send(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    // Si la conexión está atorada, no se apilan fotos/entradas viejas (eso sería ping de más):
    // se saltea y va la próxima, que trae el estado completo.
    if (this.open && this.ws.bufferedAmount < 16 * 1024) this.ws.send(buf);
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* nada */ }
  }
}

// ---------------------------------------------------------------- sala en el servidor
const SERVER_ROOM_TYPES = ['welcome', 'map', 'room', 'history', 'chat', 'sys', 'help', 'ev', 'kicked'];

export class ServerSession {
  constructor(hub) {
    this.kind = 'server';
    this.hub = hub;
    this.onMessage = null;
    this.onDown = null;
    this.offs = SERVER_ROOM_TYPES.map((t) => hub.on(t, (m) => this.onMessage?.(m)));
    this.offs.push(hub.on('error', (m) => this.onMessage?.(m)));
    hub.binary = (buf) => this.onMessage?.(buf);
  }

  /** Crea o entra (o vuelve) a una sala del servidor. */
  async start(msg) {
    const wait = this.hub.wait(['welcome']);
    this.hub.send(msg);
    return wait;
  }

  send(obj) {
    this.hub.send(obj);
  }

  sendInput(buf) {
    this.hub.sendBinary(buf);
  }

  get transportLabel() {
    return 'servidor';
  }

  leave() {
    this.hub.send({ t: 'leave' });
    this.dispose();
  }

  dispose() {
    this.offs.forEach((f) => f());
    if (this.hub.binary) this.hub.binary = null;
  }
}

// ---------------------------------------------------------------- sala local (anfitrión y práctica)
class LocalRoomBase {
  constructor() {
    this.onMessage = null;
    this.onDown = null;
    this.room = null;
    this.selfId = null;
    this.ticker = null;
  }

  deliver(msg) {
    queueMicrotask(() => this.onMessage?.(msg));
  }

  /** Cada tick: primero la entrada de este jugador (beforeStep), después la sala. Así su tecla
   *  entra en el MISMO tick, sin esperar en la cola ni depender del refresco de la pantalla. */
  tick() {
    try {
      this.beforeStep?.();
    } catch (e) {
      console.error('[tick]', e);
    }
    this.room?.step();
  }

  send(obj) {
    if (obj?.t === 'pong') return;
    this.room?.handle(this.selfId, obj);
  }

  sendInput(buf) {
    const list = decodeInput(buf);
    if (list) this.room?.input(this.selfId, list);
  }

  get rtt() {
    return 0;
  }
}

export class LocalSession extends LocalRoomBase {
  constructor(profile) {
    super();
    this.kind = 'local';
    this.room = new Room({ code: 'PRACT', name: 'Práctica', isPublic: false, offline: true, maxPlayers: 30 }, {
      send: (id, msg) => { if (id === this.selfId) this.deliver(msg); },
      close: () => {},
    });
    this.selfId = this.room.addMember(profile).id;
    this.room.moveTo(this.selfId, 'red');
    this.room.addBot('blue');
    this.room.greet(this.selfId);
    this.ticker = createBrowserTicker(() => this.tick());
  }

  get transportLabel() {
    return 'práctica';
  }

  leave() {
    this.ticker.stop();
    this.room = null;
  }
}

/** Un jugador conectado a mi sala: por canal directo (WebRTC) o por el servidor (relay). */
class HostLink {
  constructor(host, id) {
    this.host = host;
    this.id = id;
    this.mode = 'pending';
    this.memberId = null;
    this.pc = null;
    this.rel = null;
    this.fast = null;
    this.pendingCands = [];
    this.readRel = chunkReader((m) => this.receive(m, 'dc'));
  }

  async onSignal(data) {
    try {
      if (data.sdp) {
        if (!this.pc) this.makePeer();
        await this.pc.setRemoteDescription(data.sdp);
        for (const c of this.pendingCands.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer') {
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.host.hub.send({ t: 'signal', link: this.id, data: { sdp: this.pc.localDescription.toJSON() } });
        }
      } else if (data.cand) {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(data.cand).catch(() => {});
        else this.pendingCands.push(data.cand);
      }
    } catch (e) {
      console.warn('[p2p] señalización', e);
    }
  }

  makePeer() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) this.host.hub.send({ t: 'signal', link: this.id, data: { cand: e.candidate.toJSON() } }); };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'rel') {
        this.rel = ch;
        ch.onmessage = (ev) => this.readRel(ev.data);
      } else if (ch.label === 'fast') {
        this.fast = ch;
        ch.onmessage = (ev) => this.receive(ev.data, 'dc');
      }
      ch.onclose = () => { if (this.mode === 'dc') this.lost(); };
    };
    pc.onconnectionstatechange = () => {
      if (this.mode === 'dc' && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) this.lost();
    };
  }

  /** Mensaje del invitado. El camino por el que llega su "join" define por dónde le respondo. */
  receive(msg, via) {
    const room = this.host.room;
    // Un canal reemplazado por otro del mismo jugador ya no habla por él (ni puede volver a entrar).
    if (!room || this.superseded) return;
    if (msg instanceof ArrayBuffer) {
      if (this.memberId) {
        const list = decodeInput(msg);
        if (list) room.input(this.memberId, list);
      }
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (!this.memberId) {
      if (msg.t !== 'join' && msg.t !== 'resume') return;
      this.mode = via;
      if (via === 'relay' && this.pc) {
        this.pc.close();
        this.pc = null;
      }
      const rid = typeof msg.rid === 'string' ? msg.rid.slice(0, 16) : undefined;
      if (msg.t === 'resume') {
        if (room.resume(String(msg.id), String(msg.secret))) {
          this.attach(String(msg.id), true, rid);
          return;
        }
        this.send({ t: 'error', code: 'expired', text: 'Tu lugar en la sala ya no está guardado.', rid });
        return;
      }
      const res = room.addMember({ name: msg.name, avatar: msg.avatar, password: msg.password, ip: '', clientId: msg.clientId, ticket: msg.ticket });
      if (!res.ok) {
        const text = { full: 'La sala está llena.', password: 'Esta sala tiene contraseña.', bad_password: 'La contraseña no es correcta.', banned: 'No podés entrar a esta sala.' }[res.error];
        this.send({ t: 'error', code: res.error, text: text || 'No se pudo entrar.', rid });
        return;
      }
      this.attach(res.id, Boolean(res.rejoin), rid);
      return;
    }
    if (msg.t === 'pong') {
      room.setPing(this.memberId, performance.now() - Number(msg.ts));
      return;
    }
    if (msg.t === 'leave') {
      room.handle(this.memberId, msg);
      this.host.links.delete(this.id);
      this.host.byMember.delete(this.memberId);
      this.memberId = null;
      this.close();
      return;
    }
    room.handle(this.memberId, msg);
  }

  /** Asocia este canal al jugador. Si el mismo jugador ya tenía otro canal (pedido repetido o
   *  reconexión), el viejo se cierra del todo: deja de mandar entradas y el servidor lo suelta. */
  attach(memberId, rejoin, rid) {
    const old = this.host.byMember.get(memberId);
    if (old && old !== this) {
      old.memberId = null;
      old.mode = 'closed';
      old.superseded = true;
      this.host.links.delete(old.id);
      this.host.hub.send({ t: 'unlink', link: old.id, reason: 'Entraste a la sala desde otra conexión.' });
      old.close();
    }
    this.memberId = memberId;
    this.host.byMember.set(memberId, this);
    this.host.room.greet(memberId, { rejoin, rid });
  }

  send(msg) {
    if (this.mode === 'dc') {
      if (msg instanceof ArrayBuffer) {
        // Canal rápido (sin reenvíos): si quedan fotos sin salir, la subida está llena; mandar
        // más solo las haría llegar tarde. Se saltea esta y la siguiente llega fresca.
        if (this.fast?.readyState === 'open' && this.fast.bufferedAmount < 4 * 1024) this.fast.send(msg);
      } else if (this.rel?.readyState === 'open') sendRel(this.rel, msg);
    } else if (msg instanceof ArrayBuffer) this.host.hub.sendBinary(relayFrame(this.id, msg));
    else this.host.hub.send({ t: 'relay', link: this.id, msg });
  }

  /** Se cortó este canal. `left`: el invitado se fue a propósito ("Salir") → sale de la sala;
   *  si no, queda desconectado un rato con el lugar guardado (por si vuelve). */
  lost(left = false) {
    if (this.memberId && this.host.byMember.get(this.memberId) === this) {
      if (left) this.host.room?.handle(this.memberId, { t: 'leave' });
      else this.host.room?.disconnect(this.memberId);
      this.host.byMember.delete(this.memberId);
    }
    this.host.links.delete(this.id);
    this.mode = 'closed';
    this.close();
  }

  close() {
    try { this.pc?.close(); } catch { /* nada */ }
    this.pc = null;
  }
}

export class HostSession extends LocalRoomBase {
  constructor(hub, code, cfg, profile) {
    super();
    this.kind = 'host';
    this.hub = hub;
    this.code = code;
    this.links = new Map(); // link → HostLink
    this.byMember = new Map(); // memberId → HostLink
    this.room = new Room({ code, name: cfg.name, password: cfg.password, maxPlayers: cfg.maxPlayers, isPublic: cfg.isPublic, torneo: cfg.torneo || null }, {
      send: (id, msg) => {
        if (id === this.selfId) this.deliver(msg);
        else this.byMember.get(id)?.send(msg);
      },
      close: (id, reason) => {
        const link = this.byMember.get(id);
        if (!link) return;
        link.send({ t: 'kicked', reason });
        this.hub.send({ t: 'unlink', link: link.id, reason });
        this.byMember.delete(id);
        this.links.delete(link.id);
        setTimeout(() => link.close(), 300);
      },
    });
    this.selfId = this.room.addMember({ ...profile, password: cfg.password, ticket: cfg.selfTicket || '' }).id;
    this.offs = [
      hub.on('guest', (m) => this.links.set(m.link, new HostLink(this, m.link))),
      hub.on('signal', (m) => this.links.get(m.link)?.onSignal(m.data || {})),
      hub.on('relay', (m) => this.links.get(m.link)?.receive(m.msg, 'relay')),
      hub.on('unlink', (m) => this.links.get(m.link)?.lost(m.left === true)),
    ];
    hub.relayAny = (buf, link) => this.links.get(link)?.receive(buf, 'relay');
    this.room.greet(this.selfId);
    this.ticker = createBrowserTicker(() => this.tick());
    this.pinger = setInterval(() => {
      const ts = performance.now();
      for (const l of this.byMember.values()) l.send({ t: 'ping', ts });
      const s = this.room.summary();
      this.hub.send({ t: 'summary', summary: { ...s, isPublic: this.room.isPublic } });
    }, 1000);
  }

  get transportLabel() {
    return 'anfitrión';
  }

  leave() {
    this.ticker.stop();
    clearInterval(this.pinger);
    for (const l of this.links.values()) {
      l.send({ t: 'kicked', reason: 'El anfitrión cerró la sala.' });
      l.close();
    }
    this.offs.forEach((f) => f());
    this.hub.relayAny = null;
    this.hub.send({ t: 'leave' });
    this.room = null;
  }
}

// ---------------------------------------------------------------- invitado
export class GuestSession {
  constructor(hub, code, link) {
    this.kind = 'guest';
    this.hub = hub;
    this.code = code;
    this.link = link;
    this.mode = 'pending';
    this.onMessage = null;
    this.onDown = null;
    this.pc = null;
    this.rel = null;
    this.fast = null;
    this.pendingCands = [];
    this.closed = false;
    this.readRel = chunkReader((m) => this.receive(m));
    this.offs = [
      hub.on('signal', (m) => { if (m.link === this.link) this.onSignal(m.data || {}); }),
      hub.on('relay', (m) => { if (m.link === this.link && this.mode === 'relay') this.receive(m.msg); }),
      hub.on('unlink', (m) => { if (m.link === this.link) this.down(m.reason || 'Se cortó la conexión con el anfitrión.'); }),
    ];
    hub.relayBinary.set(link, (buf) => { if (this.mode === 'relay') this.receive(buf); });
  }

  /** Arma el canal directo; si no se puede en unos segundos, usa el servidor. */
  async open() {
    const direct = this.tryDirect().catch(() => false);
    const ok = await Promise.race([direct, new Promise((r) => setTimeout(() => r(false), DIRECT_TIMEOUT_MS))]);
    if (this.closed) return this.mode;
    if (ok) this.mode = 'dc';
    else {
      this.mode = 'relay';
      try { this.pc?.close(); } catch { /* nada */ }
      this.pc = null;
    }
    return this.mode;
  }

  async tryDirect() {
    if (typeof RTCPeerConnection === 'undefined') return false;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const rel = pc.createDataChannel('rel', { ordered: true });
    const fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
    for (const ch of [rel, fast]) ch.binaryType = 'arraybuffer';
    this.rel = rel;
    this.fast = fast;
    rel.onmessage = (e) => this.readRel(e.data);
    fast.onmessage = (e) => this.receive(e.data);
    const opened = (ch) => new Promise((r) => { if (ch.readyState === 'open') r(); else ch.addEventListener('open', () => r(), { once: true }); });
    pc.onicecandidate = (e) => { if (e.candidate) this.hub.send({ t: 'signal', link: this.link, data: { cand: e.candidate.toJSON() } }); };
    const dropped = () => { if (this.mode === 'dc') this.down('Se cortó la conexión directa con el anfitrión.'); };
    rel.onclose = dropped;
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropped(); };
    await pc.setLocalDescription(await pc.createOffer());
    this.hub.send({ t: 'signal', link: this.link, data: { sdp: pc.localDescription.toJSON() } });
    await Promise.all([opened(rel), opened(fast)]);
    return pc === this.pc;
  }

  async onSignal(data) {
    if (!this.pc) return;
    try {
      if (data.sdp) {
        await this.pc.setRemoteDescription(data.sdp);
        for (const c of this.pendingCands.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      } else if (data.cand) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.cand).catch(() => {});
        else this.pendingCands.push(data.cand);
      }
    } catch (e) {
      console.warn('[p2p] señalización', e);
    }
  }

  receive(msg) {
    if (msg && msg.t === 'ping') {
      this.send({ t: 'pong', ts: msg.ts });
      return;
    }
    this.onMessage?.(msg);
  }

  send(obj) {
    if (this.mode === 'dc') {
      if (this.rel?.readyState === 'open') sendRel(this.rel, obj);
    } else if (this.mode === 'relay') this.hub.send({ t: 'relay', link: this.link, msg: obj });
  }

  sendInput(buf) {
    if (this.mode === 'dc') {
      // Cada entrada lleva también las 2 anteriores, así que saltear una con la red atorada no pierde teclas.
      if (this.fast?.readyState === 'open' && this.fast.bufferedAmount < 256) this.fast.send(buf);
    } else if (this.mode === 'relay') this.hub.sendBinary(relayFrame(this.link, buf));
  }

  get transportLabel() {
    return this.mode === 'dc' ? 'directo' : 'por servidor';
  }

  down(reason) {
    if (this.closed) return;
    this.dispose();
    this.onDown?.(reason);
  }

  leave() {
    this.send({ t: 'leave' });
    // "left": me voy a propósito. Así el anfitrión me saca aunque este aviso le llegue antes que el "leave".
    this.hub.send({ t: 'unlink', link: this.link, left: true });
    this.dispose();
  }

  dispose() {
    this.closed = true;
    this.mode = 'closed';
    this.offs.forEach((f) => f());
    this.hub.relayBinary.delete(this.link);
    setTimeout(() => { try { this.pc?.close(); } catch { /* nada */ } }, 200);
  }
}
