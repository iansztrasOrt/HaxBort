// Servidores ICE para WebRTC (cómo se conectan las compus entre sí).
//
// Siempre hay STUN (para conectarse directo). Si están configuradas las variables de Cloudflare
// Realtime TURN, además se dan credenciales TURN: cuando la conexión directa no se puede armar
// (redes de colegio, firewalls), el partido pasa por el servidor de Cloudflare más cercano
// (Buenos Aires, San Pablo, Santiago…) en vez de ir y volver por Estados Unidos.
//
//   CF_TURN_KEY_ID      "Turn Token ID" de la clave TURN (Cloudflare → Realtime → TURN)
//   CF_TURN_API_TOKEN   el "API Token" de esa clave (secreto: solo en Render → Environment)
//
// El secreto nunca sale del servidor: a los jugadores se les dan credenciales temporales.

export const DEFAULT_ICE = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
const TTL = 24 * 3600; // las credenciales duran 24 h…
const REFRESH_MS = 12 * 3600 * 1000; // …y se renuevan cada 12 h (nadie se queda con una vencida)
const RETRY_MS = 60 * 1000; // si Cloudflare falla, se reintenta al minuto (mientras tanto, solo STUN)

/** Deja la respuesta de Cloudflare como una lista de iceServers que el navegador acepta. */
export function normalizeIce(data) {
  const raw = Array.isArray(data?.iceServers) ? data.iceServers : data?.iceServers ? [data.iceServers] : [];
  const out = [];
  for (const s of raw) {
    if (!s || !s.urls) continue;
    // El puerto 53 (el de DNS) suele estar bloqueado y algunos navegadores lo cortan: se saca.
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    out.push({ urls, ...(s.username ? { username: s.username, credential: s.credential } : {}) });
  }
  return out;
}

export function createIceProvider({ keyId = process.env.CF_TURN_KEY_ID, token = process.env.CF_TURN_API_TOKEN, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const configured = Boolean(keyId && token);
  let cache = null; // { iceServers, turn, at }
  let failedAt = null; // cuándo falló el último pedido a Cloudflare
  let pending = null;

  async function fetchTurn() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TTL }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Cloudflare respondió ${res.status}`);
      const servers = normalizeIce(await res.json());
      if (!servers.some((s) => s.urls.some((u) => /^turns?:/.test(u)))) throw new Error('la respuesta no trae servidores TURN');
      return servers;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lista para mandar a los jugadores: { iceServers, turn } (turn = hay relevo de Cloudflare). */
  async function get() {
    if (!configured) return { iceServers: DEFAULT_ICE, turn: false };
    const t = now();
    if (cache && t - cache.at >= TTL * 1000) cache = null; // vencidas: no se reparten
    if (cache && t - cache.at < REFRESH_MS) return cache;
    if (failedAt !== null && t - failedAt < RETRY_MS) return cache || { iceServers: DEFAULT_ICE, turn: false };
    const refresh = pending ||= fetchTurn()
      .then((servers) => {
        // Cloudflare ya trae su STUN; se suman los de siempre por si acaso.
        cache = { iceServers: [...servers, ...DEFAULT_ICE.filter((d) => !servers.some((s) => s.urls.join() === d.urls.join()))], turn: true, at: now() };
        failedAt = null;
        log('ICE: credenciales TURN de Cloudflare renovadas.');
        return cache;
      })
      .catch((e) => {
        failedAt = now();
        console.error(`[ice] no se pudieron pedir credenciales TURN a Cloudflare: ${e.message}`);
        return cache || { iceServers: DEFAULT_ICE, turn: false };
      })
      .finally(() => { pending = null; });
    // Con credenciales todavía vigentes (duran 24 h) se responde ya y se renuevan de fondo.
    return cache ? cache : refresh;
  }

  return { get, configured };
}
