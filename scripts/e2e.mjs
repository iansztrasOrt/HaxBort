// Prueba completa con navegadores reales (necesita Playwright: npm i -D playwright && npx playwright install chromium).
// Crea una sala p2p, se une otro jugador directo y otro por relay, juegan, termina el partido,
// echa a uno, y después prueba una sala en el servidor con reconexión.
import { createServer } from '../server/index.js';

const { chromium } = await import('playwright');
const srv = createServer({ port: 3100, log: () => {} });
const URL = 'http://localhost:3100';
const browser = await chromium.launch();
const errors = [];
async function newPage(name, { noRTC = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (noRTC) await ctx.addInitScript(() => { delete window.RTCPeerConnection; });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return p;
}
async function enter(p, name, url = URL) {
  await p.goto(url);
  await p.click('#btn-begin');
  await p.fill('#nick', name);
  await p.click('#name-form button[type=submit]');
}
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Sala P2P
const A = await newPage('A');
await enter(A, 'Ana');
await A.waitForSelector('#scr-lobby:not([hidden])');
await A.waitForFunction(() => !document.querySelector('#create-form button[type=submit]').disabled);
await A.click('#create-form button[type=submit]');
await A.waitForSelector('#room:not([hidden])');
const code = (await A.textContent('#room-code')).trim();
log('sala p2p', code);

const B = await newPage('B');
await enter(B, 'Beto', `${URL}/sala/${code}`);
await B.waitForSelector('#room:not([hidden])', { timeout: 15000 });
await sleep(1500);
log('B netinfo:', await B.textContent('#netinfo'));
log('A ve jugadores:', await A.$$eval('#teams .prow .nm', (els) => els.map((e) => e.textContent)));

// A al rojo, Beto al azul (menú ⋯), empezar
await A.click('.team.red .team-join');
await A.click('.prow:has-text("Beto") .more');
await A.click('.pmenu button:has-text("Mover a Azul")');
await sleep(200);
await A.click('#btn-start');
await A.waitForSelector('#room[hidden]', { state: 'attached' });
await B.waitForFunction(() => document.getElementById('room').hidden, null, { timeout: 5000 });
log('partido empezado; sala cerrada en ambos');

// Latencia: B empieza a moverse; cuánto tarda A en ver el disco de Beto moverse
await sleep(500);
const betoId = await B.evaluate(() => window.haxbort.app.me);
const t0 = Date.now();
await B.keyboard.down('ArrowLeft');
await A.waitForFunction((id) => { const p = window.haxbort.app.match.players.find((x) => x.id === id); return p && p.disc && Math.abs(p.disc.vx) > 0.05; }, betoId, { polling: 'raf' });
log('A vio moverse a Beto en', Date.now() - t0, 'ms (incluye el polling de Playwright)');
await sleep(800);
await B.keyboard.up('ArrowLeft');
await sleep(400);
const cmp = async () => {
  const a = await A.evaluate((id) => { const p = window.haxbort.app.match.players.find((x) => x.id === id); return [p.disc.x, p.disc.y]; }, betoId);
  const b = await B.evaluate((id) => { const p = window.haxbort.app.match.players.find((x) => x.id === id); return [p.disc.x, p.disc.y]; }, betoId);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
};
log('diferencia de posición de Beto entre A y B (quieto):', (await cmp()).toFixed(3));

// Chat
await B.keyboard.press('KeyT');
await B.keyboard.type('hola ana');
await B.keyboard.press('Enter');
await A.waitForFunction(() => [...document.querySelectorAll('#chat-log li')].some((l) => l.textContent.includes('hola ana')));
log('chat ok');

// Relay: C sin WebRTC
const C = await newPage('C', { noRTC: true });
await enter(C, 'Caro', `${URL}/sala/${code}`);
await C.waitForSelector('body:not(.outside)', { timeout: 20000 });
await sleep(1500);
log('C netinfo:', await C.textContent('#netinfo'));
const cSnap = await C.evaluate(() => window.haxbort.app.match?.players.length);
log('C ve jugadores en el partido:', cSnap);

// Fin del partido: gol forzado en el host con límite 1 gol → vuelve a la sala sola
await A.evaluate(() => {
  const room = window.haxbort.app.sess.room;
  room.match.settings.scoreLimit = 1;
  const ball = room.match.world.discs[0];
  const g = room.stadium.goals.find((x) => x.team === 'blue');
  room.match.phase = 'playing';
  ball.x = g.p0[0] - 3; ball.y = 0; ball.vx = 6; ball.vy = 0;
});
await B.waitForSelector('#room:not([hidden])', { timeout: 10000 });
await A.waitForSelector('#room:not([hidden])', { timeout: 10000 });
log('al terminar volvió a la sala en A y B; marcador B:', await B.textContent('#s-red'), '-', await B.textContent('#s-blue'));
await A.screenshot({ path: 'e2e-sala.png' });

// Echar a Caro
await A.click('.prow:has-text("Caro") .more');
await A.click('.pmenu button:has-text("Echar")');
await C.waitForSelector('#scr-lobby:not([hidden])', { timeout: 5000 });
log('Caro echada → volvió al lobby');

// Beto se va
await B.click('#btn-leave');
await A.waitForFunction(() => !window.haxbort.app.room.players.some((p) => p.name === 'Beto'));
log('Beto salió y desapareció de la sala');

// --- Sala en el servidor
const D = await newPage('D');
await enter(D, 'Dani');
await D.waitForSelector('#scr-lobby:not([hidden])');
await D.selectOption('#room-mode', 'server');
await D.waitForFunction(() => !document.querySelector('#create-form button[type=submit]').disabled);
await D.click('#create-form button[type=submit]');
await D.waitForSelector('#room:not([hidden])');
const code2 = (await D.textContent('#room-code')).trim();
const E = await newPage('E');
await enter(E, 'Eli');
await E.waitForSelector('#scr-lobby:not([hidden])');
await E.waitForFunction(() => document.querySelectorAll('#rooms-list .room-row').length >= 2, null, { timeout: 10000 });
log('lista pública:', await E.$$eval('#rooms-list .room-row strong', (els) => els.map((e) => e.textContent)));
await E.fill('#join-code', code2);
await E.click('#join-form button[type=submit]');
await E.waitForSelector('#room:not([hidden])');
await D.click('.team.red .team-join');
await E.click('.team.blue .team-join');
await sleep(200);
await D.click('#btn-start');
await sleep(1500);
await E.keyboard.down('ArrowUp'); await sleep(600); await E.keyboard.up('ArrowUp'); await sleep(500);
log('E netinfo:', await E.textContent('#netinfo'));
const eId = await E.evaluate(() => window.haxbort.app.me);
const ey = await D.evaluate((id) => window.haxbort.app.match.players.find((x) => x.id === id).disc.y, eId);
log('D ve a Eli movida hacia arriba (y<0):', ey.toFixed(1));
// Reconexión: E recarga la página
await E.reload();
await E.waitForSelector('body:not(.outside)', { timeout: 15000 });
await sleep(800);
log('E volvió tras recargar; equipo:', await E.evaluate(() => window.haxbort.app.names.get(window.haxbort.app.me)?.team));
await E.screenshot({ path: 'e2e-servidor.png' });

console.log(errors.length ? `ERRORES:\n${errors.join('\n')}` : 'sin errores');
await browser.close();
srv.close();
process.exit(0);
