// Servidor de HaxBort: sirve la página, guarda la lista de salas y conecta a los jugadores.
//
// Dos tipos de sala:
//  · "p2p" (por defecto): el partido corre en el navegador de quien creó la sala, como en HaxBall.
//    El servidor solo presenta a los jugadores (señalización WebRTC) y, si la conexión directa
//    no se puede armar, reenvía los mensajes (relay).
//  · "server": el partido corre acá (útil si el anfitrión tiene mala conexión).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, cleanText, cleanName, cleanAvatar } from '../shared/room/room.js';
import { createTicker } from '../shared/room/ticker.js';
import { decodeInput } from '../shared/net/protocol.js';
import { createStore, createTorneosApi } from './torneos.js';
import { createIceProvider } from './ice.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RELAY = 0xfe;
const MSGS_PER_SEC = 40; // mensajes de texto por conexión (las entradas binarias van aparte)

export function createServer({ port = PORT, html = null, log = console.log, store = createStore(), torneoRates = {}, ice = createIceProvider({ log }) } = {}) {
  const torneos = createTorneosApi({ store, log, rates: torneoRates });
  torneos.warm();
  log(ice.configured ? 'Relevo TURN: Cloudflare configurado (para redes donde la conexión directa no anda).' : 'Relevo TURN: no configurado (faltan CF_TURN_KEY_ID y CF_TURN_API_TOKEN): solo STUN y el relevo del servidor.');
  if (ice.configured) ice.get();
  const page = () => html ?? fs.readFileSync(path.join(ROOT, 'dist/index.html'));
  const rooms = new Map(); // code → { kind: 'server', room, sockets: Map(id → ws) } | { kind: 'p2p', host: ws, summary, links: Set }
  const links = new Map(); // linkId → { code, guest: ws }
  let linkSeq = 0;

  const newCode = () => {
    for (let i = 0; i < 200; i += 1) {
      let c = '';
      for (let j = 0; j < 5; j += 1) c += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  };
  const cleanCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '');
  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' || msg instanceof ArrayBuffer || ArrayBuffer.isView(msg) ? msg : JSON.stringify(msg));
  };

  function publicList() {
    const out = [];
    for (const [code, e] of rooms) {
      if (e.kind === 'server' && e.room.isPublic && !e.room.empty) out.push({ ...e.room.summary(), mode: 'server' });
      if (e.kind === 'p2p' && e.summary?.isPublic) out.push({ code, mode: 'p2p', ...e.summary });
    }
    return out.sort((a, b) => b.players - a.players).slice(0, 100);
  }

  // ---------------------------------------------------------------- HTTP
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/torneos')) {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      torneos.handle(req, res, url, ip).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
      return;
    }
    if (p === '/api/ice') {
      // Servidores para conectar las compus (con relevo TURN de Cloudflare si está configurado).
      ice.get().then((out) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(out));
      }).catch(() => { res.writeHead(500); res.end(); });
      return;
    }
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else if (p === '/api/version') {
      // La versión de la página que se está sirviendo ahora (la escribe el build en dist/index.html).
      const build = /<meta name="haxbort-build" content="([^"]*)"/.exec(String(page()))?.[1] || '';
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ build }));
    } else if (p === '/api/salas') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rooms: publicList(), total: rooms.size }));
    } else if (p.startsWith('/sala/')) {
      res.writeHead(302, { location: `/?sala=${encodeURIComponent(cleanCode(p.slice(6)))}` });
      res.end();
    } else if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(page());
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('No existe');
    }
  });

  // ---------------------------------------------------------------- salas en el servidor
  function serverTransport(entry) {
    return {
      send(id, msg) {
        const ws = entry.sockets.get(id);
        if (!ws || ws.readyState !== 1) return;
        if (msg instanceof ArrayBuffer) {
          if (ws.bufferedAmount < 16 * 1024) ws.send(msg); // conexión atorada: se saltea la foto (no se apilan fotos viejas)
        } else ws.send(JSON.stringify(msg));
      },
      close(id, reason) {
        const ws = entry.sockets.get(id);
        entry.sockets.delete(id);
        if (ws) {
          send(ws, { t: 'kicked', reason });
          ws.ctx.code = null;
          ws.ctx.id = null;
        }
      },
    };
  }

  function enterServerRoom(ws, entry, res, rejoin = false, rid = undefined) {
    const prev = entry.sockets.get(res.id);
    if (prev && prev !== ws) {
      send(prev, { t: 'kicked', reason: 'Abriste la sala en otra pestaña.' });
      prev.ctx.code = null;
    }
    entry.sockets.set(res.id, ws);
    ws.ctx.code = entry.room.code;
    ws.ctx.id = res.id;
    entry.room.greet(res.id, { rejoin, rid });
  }

  function leaveCurrent(ws) {
    const { code, id } = ws.ctx;
    if (!code) return;
    const e = rooms.get(code);
    ws.ctx.code = null;
    ws.ctx.id = null;
    if (!e) return;
    if (e.kind === 'server') {
      if (e.sockets.get(id) === ws) e.sockets.delete(id);
      e.room.handle(id, { t: 'leave' });
    } else if (e.host === ws) closeP2P(code, 'El anfitrión cerró la sala.');
  }

  // ---------------------------------------------------------------- salas p2p
  function closeP2P(code, reason) {
    const e = rooms.get(code);
    if (!e || e.kind !== 'p2p') return;
    rooms.delete(code);
    torneos.roomClosed(code); // si era un partido de torneo, se define el resultado
    for (const l of e.links) {
      const link = links.get(l);
      links.delete(l);
      if (link) send(link.guest, { t: 'unlink', link: l, reason });
    }
    log(`[sala] ${code} cerrada (p2p)`);
  }

  function openLink(ws, code) {
    const e = rooms.get(code);
    if (!e || e.kind !== 'p2p') return null;
    linkSeq = (linkSeq % 65000) + 1;
    while (links.has(linkSeq)) linkSeq = (linkSeq % 65000) + 1;
    const id = linkSeq;
    links.set(id, { code, guest: ws });
    e.links.add(id);
    ws.ctx.links.add(id);
    send(e.host, { t: 'guest', link: id });
    return id;
  }

  function dropLink(id, reason, { notifyHost = true, notifyGuest = true, left = false } = {}) {
    const link = links.get(id);
    if (!link) return;
    links.delete(id);
    link.guest.ctx.links.delete(id);
    const e = rooms.get(link.code);
    if (e?.kind === 'p2p') {
      e.links.delete(id);
      if (notifyHost) send(e.host, { t: 'unlink', link: id, ...(left ? { left: true } : {}) });
    }
    if (notifyGuest) send(link.guest, { t: 'unlink', link: id, reason });
  }

  /** ¿Puede este socket hablar por este link? Devuelve el otro extremo. */
  function peerOf(ws, id) {
    const link = links.get(id);
    if (!link) return null;
    const e = rooms.get(link.code);
    if (!e || e.kind !== 'p2p') return null;
    if (link.guest === ws) return e.host;
    if (e.host === ws) return link.guest;
    return null;
  }

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });

  function onJSON(ws, msg) {
    const ctx = ws.ctx;
    switch (msg.t) {
      case 'pong': {
        const rtt = Date.now() - Number(msg.ts);
        if (!(rtt >= 0 && rtt < 60000)) return;
        ctx.rtt = rtt;
        const e = ctx.code && rooms.get(ctx.code);
        if (e?.kind === 'server') e.room.setPing(ctx.id, rtt);
        return;
      }
      case 'list':
        send(ws, { t: 'list', rooms: publicList(), total: rooms.size });
        return;
      case 'create': {
        leaveCurrent(ws);
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'busy', text: 'El servidor está lleno de salas. Probá en un rato.' });
        const code = newCode();
        if (!code) return send(ws, { t: 'error', code: 'busy', text: 'No se pudo crear la sala.' });
        const cfg = msg.room || {};
        if (msg.mode === 'server') {
          const entry = { kind: 'server', sockets: new Map(), room: null };
          entry.room = new Room({ code, name: cfg.name, password: cfg.password, maxPlayers: cfg.maxPlayers, isPublic: cfg.isPublic !== false }, serverTransport(entry));
          entry.room.build = /<meta name="haxbort-build" content="([^"]*)"/.exec(String(page()))?.[1] || '';
          rooms.set(code, entry);
          const res = entry.room.addMember({ name: msg.name, avatar: msg.avatar, password: cfg.password, ip: ctx.ip, clientId: msg.clientId });
          enterServerRoom(ws, entry, res);
          log(`[sala] ${code} creada (servidor)`);
        } else {
          rooms.set(code, {
            kind: 'p2p', host: ws, links: new Set(), createdAt: Date.now(),
            summary: { name: cleanText(cfg.name, 32) || 'Sala de HaxBort', players: 1, bots: 0, max: Math.min(30, Math.max(2, Math.round(Number(cfg.maxPlayers)) || 10)), hasPassword: Boolean(cfg.password), map: 'Clásica', playing: false, isPublic: cfg.isPublic !== false },
          });
          ctx.code = code;
          ctx.hosting = code;
          send(ws, { t: 'hosted', code });
          log(`[sala] ${code} creada (p2p)`);
        }
        return;
      }
      case 'join':
      case 'resume': {
        // rid: identificador del pedido; vuelve en la respuesta para que el cliente no confunda
        // la respuesta de un pedido viejo (que tardó) con la del actual.
        const rid = typeof msg.rid === 'string' ? msg.rid.slice(0, 16) : undefined;
        const fail = (code, text) => send(ws, { t: 'error', code, text, rid });
        const code = cleanCode(msg.code);
        const e = rooms.get(code);
        if (!e) return fail('not_found', `No existe la sala ${code || ''}. Revisá el código.`);
        if (e.kind === 'p2p') {
          if (e.host === ws) return fail('own_room', 'Ya estás en esta sala (sos el anfitrión).');
          const link = openLink(ws, code);
          return send(ws, { t: 'p2p', code, link, rid });
        }
        if (msg.t === 'resume' && e.room.resume(String(msg.id), String(msg.secret))) {
          if (ctx.code !== code || ctx.id !== String(msg.id)) leaveCurrent(ws);
          return enterServerRoom(ws, e, { id: String(msg.id) }, true, rid);
        }
        if (msg.t === 'resume') return fail('expired', 'Tu lugar en la sala ya no está guardado.');
        const res = e.room.addMember({ name: cleanName(msg.name), avatar: cleanAvatar(msg.avatar), password: msg.password, ip: ctx.ip, clientId: msg.clientId });
        if (!res.ok) return fail(res.error, errorText(res.error));
        // Si es el mismo jugador pidiendo entrar otra vez desde este mismo socket, no se lo saca de la sala.
        if (ctx.code !== code || ctx.id !== res.id) leaveCurrent(ws);
        return enterServerRoom(ws, e, res, Boolean(res.rejoin), rid);
      }
      case 'leave':
        leaveCurrent(ws);
        for (const l of [...ctx.links]) dropLink(l, null, { notifyGuest: false });
        return;
      // ---- p2p: señalización, relay y datos de la sala
      case 'signal': {
        const peer = peerOf(ws, Number(msg.link));
        if (peer) send(peer, { t: 'signal', link: Number(msg.link), data: msg.data });
        return;
      }
      case 'relay': {
        const peer = peerOf(ws, Number(msg.link));
        if (peer) send(peer, { t: 'relay', link: Number(msg.link), msg: msg.msg });
        return;
      }
      case 'unlink': {
        const id = Number(msg.link);
        const link = links.get(id);
        if (!link) return;
        const e = rooms.get(link.code);
        if (e?.host === ws) dropLink(id, msg.reason || null, { notifyHost: false });
        // left: el invitado tocó "Salir" (no se le cortó la conexión): el anfitrión lo saca de la sala.
        else if (link.guest === ws) dropLink(id, null, { notifyGuest: false, left: msg.left === true });
        return;
      }
      case 'summary': {
        const e = ctx.hosting && rooms.get(ctx.hosting);
        if (!e || e.host !== ws || !msg.summary) return;
        const s = msg.summary;
        e.summary = {
          name: cleanText(s.name, 32) || e.summary.name, players: Math.max(1, Math.min(30, Number(s.players) || 1)), bots: Math.min(30, Number(s.bots) || 0),
          max: Math.min(30, Number(s.max) || 10), hasPassword: Boolean(s.hasPassword), map: cleanText(s.map, 40), playing: Boolean(s.playing), isPublic: Boolean(s.isPublic),
        };
        return;
      }
      default: {
        // Acciones dentro de una sala del servidor.
        const e = ctx.code && rooms.get(ctx.code);
        if (e?.kind === 'server') e.room.handle(ctx.id, msg);
      }
    }
  }

  function onBinary(ws, buf) {
    const ctx = ws.ctx;
    if (buf.length >= 3 && buf[0] === RELAY) {
      const id = buf.readUInt16BE(1);
      const peer = peerOf(ws, id);
      if (peer && peer.readyState === 1 && peer.bufferedAmount < 16 * 1024) peer.send(buf);
      return;
    }
    const e = ctx.code && rooms.get(ctx.code);
    if (e?.kind !== 'server') return;
    const list = decodeInput(buf);
    if (list) e.room.input(ctx.id, list);
  }

  wss.on('connection', (ws, req) => {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    ws.ctx = { ip: fwd || req.socket.remoteAddress || '', code: null, id: null, hosting: null, links: new Set(), budget: MSGS_PER_SEC, rtt: null };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return onBinary(ws, data);
      if (ws.ctx.budget <= 0) return;
      ws.ctx.budget -= 1;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') {
        try {
          onJSON(ws, msg);
        } catch (err) {
          log('[ws] error', err);
        }
      }
    });
    ws.on('close', () => {
      const { code, id, hosting } = ws.ctx;
      if (hosting) closeP2P(hosting, 'El anfitrión cerró la sala.');
      else if (code) {
        const e = rooms.get(code);
        if (e?.kind === 'server' && e.sockets.get(id) === ws) {
          e.sockets.delete(id);
          e.room.disconnect(id);
        }
      }
      for (const l of [...ws.ctx.links]) dropLink(l, null, { notifyGuest: false });
    });
    send(ws, { t: 'hello', ts: Date.now() });
  });

  // Reloj de las salas del servidor (60 Hz) y limpieza.
  const ticker = createTicker(() => {
    for (const [code, e] of rooms) {
      if (e.kind !== 'server') continue;
      e.room.step();
      if (e.room.empty) {
        rooms.delete(code);
        log(`[sala] ${code} cerrada (servidor, vacía)`);
      }
    }
  });
  const slow = setInterval(() => {
    const ts = Date.now();
    for (const ws of wss.clients) {
      ws.ctx.budget = ws.ctx.hosting ? MSGS_PER_SEC * 20 : MSGS_PER_SEC; // el anfitrión reenvía a muchos
      send(ws, { t: 'ping', ts });
    }
  }, 1000);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);

  server.listen(port, () => log(`HaxBort escuchando en http://localhost:${server.address().port}`));
  return {
    server, wss, rooms, torneos,
    close() {
      store.close().catch(() => {});
      ticker.stop();
      clearInterval(slow);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close();
    },
  };
}

function errorText(code) {
  return {
    full: 'La sala está llena.', password: 'Esta sala tiene contraseña.', bad_password: 'La contraseña no es correcta.',
    banned: 'No podés entrar a esta sala.',
  }[code] || 'No se pudo entrar a la sala.';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) createServer();
