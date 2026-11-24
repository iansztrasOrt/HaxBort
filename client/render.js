// Render en Canvas 2D: fondo (grass / hockey / none), segmentos rectos y en arco,
// uniones, discos y jugadores. Cámara según width/height/maxViewWidth/cameraFollow.
import { insideArc } from '../shared/physics/world.js';

const TAU = Math.PI * 2;

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + amt * 255)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Límites de la cámara (medio ancho / medio alto) del estadio. */
export function cameraBounds(stadium) {
  if (stadium.width > 0 && stadium.height > 0) return { w: stadium.width, h: stadium.height };
  let w = Math.max(stadium.bg.width, 100);
  let h = Math.max(stadium.bg.height, 80);
  for (const v of stadium.vertexes) {
    w = Math.max(w, Math.abs(v.x));
    h = Math.max(h, Math.abs(v.y));
  }
  for (const d of stadium.discs) {
    w = Math.max(w, Math.abs(d.pos[0]) + d.radius);
    h = Math.max(h, Math.abs(d.pos[1]) + d.radius);
  }
  return { w: w + 20, h: h + 20 };
}

// ---------------------------------------------------------------- camisetas
/** Pinta el diseño de una camiseta dentro de un círculo (x, y, r). La bolita sigue siendo un
 *  círculo: el diseño se recorta al borde y encima van el borde y el número del jugador. */
export function drawKit(ctx, kit, x, y, r) {
  const c = (kit.colors || []).map((h) => `#${h}`);
  const [a, b, d] = [c[0] || '#888888', c[1] || '#ffffff', c[2] || '#000000'];
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(((kit.angle || 0) * Math.PI) / 180);
  const R = r * 1.5; // cubre todo el círculo aunque esté girado
  const rect = (color, x0, y0, w, h) => { ctx.fillStyle = color; ctx.fillRect(x0, y0, w, h); };
  rect(a, -R, -R, 2 * R, 2 * R);
  switch (kit.pattern) {
    case 'franjas': { // tres franjas verticales iguales
      const w = (2 * r) / 3;
      rect(a, -r, -R, w, 2 * R);
      rect(b, -r + w, -R, w, 2 * R);
      rect(d, -r + 2 * w, -R, w, 2 * R);
      rect(a, -R, -R, R - r, 2 * R);
      rect(d, r, -R, R - r, 2 * R);
      break;
    }
    case 'bastones': { // rayas finas alternadas
      const w = (2 * r) / 7;
      for (let i = -4; i <= 4; i += 1) if (i % 2 === 0) rect(b, -w / 2 + i * w, -R, w, 2 * R);
      break;
    }
    case 'mitades': rect(b, 0, -R, R, 2 * R); break;
    case 'banda': rect(b, -R, -r * 0.24, 2 * R, r * 0.48); break;
    case 'faja': rect(b, -R, -r * 0.3, 2 * R, r * 0.6); rect(d, -R, -r * 0.08, 2 * R, r * 0.16); break;
    case 'cuartos': rect(b, 0, -R, R, R); rect(b, -R, 0, R, R); break;
    case 'cuadros': {
      const w = (2 * r) / 4;
      for (let i = -3; i < 3; i += 1) for (let j = -3; j < 3; j += 1) if ((i + j) % 2 === 0) rect(b, i * w, j * w, w, w);
      break;
    }
    case 'cruz': rect(b, -r * 0.2, -R, r * 0.4, 2 * R); rect(b, -R, -r * 0.2, 2 * R, r * 0.4); break;
    case 'v': {
      ctx.fillStyle = b;
      ctx.beginPath();
      ctx.moveTo(-R, -r * 0.55); ctx.lineTo(0, r * 0.25); ctx.lineTo(R, -r * 0.55);
      ctx.lineTo(R, -r * 0.15); ctx.lineTo(0, r * 0.65); ctx.lineTo(-R, -r * 0.15);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'centro': ctx.fillStyle = b; ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, TAU); ctx.fill(); break;
    case 'aro':
      ctx.strokeStyle = b; ctx.lineWidth = r * 0.24; ctx.beginPath(); ctx.arc(0, 0, r * 0.72, 0, TAU); ctx.stroke();
      break;
    case 'degradado': {
      const g = ctx.createLinearGradient(-r, 0, r, 0);
      g.addColorStop(0, a); g.addColorStop(0.5, b); g.addColorStop(1, d);
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R, 2 * R, 2 * R);
      break;
    }
    case 'lunares': {
      ctx.fillStyle = b;
      const s = r * 0.62;
      for (let i = -2; i <= 2; i += 1) {
        for (let j = -2; j <= 2; j += 1) {
          ctx.beginPath();
          ctx.arc(i * s + (j % 2 ? s / 2 : 0), j * s * 0.87, r * 0.15, 0, TAU);
          ctx.fill();
        }
      }
      break;
    }
    case 'estrella': {
      ctx.fillStyle = b;
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const rr = i % 2 ? r * 0.36 : r * 0.88;
        const t = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(Math.cos(t) * rr, Math.sin(t) * rr);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'rayo': {
      ctx.fillStyle = b;
      ctx.beginPath();
      ctx.moveTo(r * 0.15, -R); ctx.lineTo(-r * 0.35, r * 0.1); ctx.lineTo(0, r * 0.1);
      ctx.lineTo(-r * 0.2, R); ctx.lineTo(r * 0.4, -r * 0.15); ctx.lineTo(r * 0.05, -r * 0.15); ctx.lineTo(r * 0.45, -R);
      ctx.closePath();
      ctx.fill();
      break;
    }
    default: break; // liso
  }
  ctx.restore();
}

/** Número/avatar del jugador encima de la camiseta, con contorno para que se lea sobre cualquier diseño. */
export function drawDiscLabel(ctx, text, x, y, r, color = '#ffffff') {
  ctx.font = `700 ${Math.round(r * 1.05)}px "Saira Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.strokeStyle = luminance(color) > 0.55 ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.55)';
  ctx.strokeText(text, x, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 1);
}
function luminance(c) {
  const h = c.replace('#', '');
  if (h.length !== 6) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const cam = { x: 0, y: 0, s: 1, ready: false };

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  /**
   * zoom = 1 → se ve toda la cancha, centrada. zoom > 1 → más cerca y la cámara
   * sigue al jugador (y a la pelota, sin perder de vista al jugador).
   */
  function updateCamera(m, focusDisc, zoom, dt = 1000 / 60) {
    const st = m.stadium;
    const b = cameraBounds(st);
    const cw = canvas.width;
    const ch = canvas.height;
    let s = Math.min(cw / (2 * b.w), ch / (2 * b.h)) * zoom;
    if (st.maxViewWidth > 0 && cw / s > st.maxViewWidth) s = cw / st.maxViewWidth;
    const vw = cw / s / 2;
    const vh = ch / s / 2;
    let tx = 0;
    let ty = 0;
    if (vw < b.w - 0.5 || vh < b.h - 0.5) {
      const ball = m.world.discs.find((d) => d.kind === 'ball');
      if (focusDisc && (st.cameraFollow === 'player' || !ball)) {
        tx = focusDisc.x;
        ty = focusDisc.y;
      } else if (focusDisc && ball) {
        tx = (focusDisc.x + ball.x) / 2;
        ty = (focusDisc.y + ball.y) / 2;
        // Si la pelota está lejos, prioriza al jugador: siempre queda en pantalla.
        const mx = vw * 0.7;
        const my = vh * 0.7;
        tx = Math.max(focusDisc.x - mx, Math.min(focusDisc.x + mx, tx));
        ty = Math.max(focusDisc.y - my, Math.min(focusDisc.y + my, ty));
      } else if (ball) {
        tx = ball.x;
        ty = ball.y;
      }
    }
    const clamp = (v, half, bound) => (half >= bound ? 0 : Math.max(-bound + half, Math.min(bound - half, v)));
    const nx = clamp(tx, vw, b.w);
    const ny = clamp(ty, vh, b.h);
    // Suavizado de cámara y de zoom.
    const first = !cam.ready;
    cam.ready = true;
    // Suavizado por tiempo (no por cuadro): la cámara se mueve igual a 60 que a 144 Hz.
    const k = (base) => (first ? 1 : 1 - (1 - base) ** (dt * 0.06));
    cam.x += (nx - cam.x) * k(0.14);
    cam.y += (ny - cam.y) * k(0.14);
    cam.s += (s - cam.s) * k(0.2);
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawBackground(st) {
    const bg = st.bg;
    const { w, h } = { w: canvas.width / cam.s, h: canvas.height / cam.s };
    ctx.fillStyle = bg.type === 'none' ? bg.color : shade(bg.color, -0.08);
    ctx.fillRect(cam.x - w, cam.y - h, w * 2, h * 2);
    if (bg.type === 'none' || !(bg.width > 0 && bg.height > 0)) return;
    const W = bg.width;
    const H = bg.height;
    ctx.save();
    roundRect(-W, -H, W * 2, H * 2, bg.cornerRadius);
    ctx.fillStyle = bg.color;
    ctx.fill();
    ctx.clip();
    if (bg.type === 'grass') {
      // Franjas de césped cortado.
      const band = Math.max(40, W / 7);
      ctx.fillStyle = shade(bg.color, 0.035);
      for (let x = -W, k = 0; x < W; x += band, k += 1) if (k % 2 === 0) ctx.fillRect(x, -H, band, H * 2);
    } else {
      // Hielo: brillo y rayones suaves.
      const g = ctx.createLinearGradient(-W, -H, W, H);
      g.addColorStop(0, shade(bg.color, 0.12));
      g.addColorStop(0.5, shade(bg.color, 0.04));
      g.addColorStop(1, shade(bg.color, 0.1));
      ctx.fillStyle = g;
      ctx.fillRect(-W, -H, W * 2, H * 2);
    }
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = bg.type === 'grass' ? 'rgba(244, 248, 236, .62)' : 'rgba(255, 255, 255, .55)';
    roundRect(-W, -H, W * 2, H * 2, bg.cornerRadius);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -H);
    ctx.lineTo(0, H);
    ctx.stroke();
    if (bg.kickOffRadius > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, bg.kickOffRadius, 0, TAU);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, TAU);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    if (bg.type === 'hockey' && bg.goalLine > 0) {
      ctx.strokeStyle = 'rgba(229, 87, 74, .55)';
      for (const x of [-bg.goalLine, bg.goalLine]) {
        ctx.beginPath();
        ctx.moveTo(x, -H);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawSegment(s) {
    if (!s.vis || !s.color) return;
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    if (s.straight) {
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
    } else {
      const a0 = Math.atan2(s.ay - s.cy, s.ax - s.cx);
      const a1 = Math.atan2(s.by - s.cy, s.bx - s.cx);
      let sweep = a1 - a0;
      while (sweep <= 0) sweep += TAU;
      const mid = a0 + sweep / 2;
      const inside = insideArc(s, Math.cos(mid), Math.sin(mid));
      ctx.arc(s.cx, s.cy, s.R, a0, a1, !inside);
    }
    ctx.stroke();
  }

  function render(m, { focusId = null, names = true, zoom = 1, dt = 1000 / 60, kits = null } = {}) {
    const dpr = resize();
    const focus = m.players.find((p) => p.id === focusId)?.disc || null;
    updateCamera(m, focus, zoom, Math.min(100, Math.max(0, dt)));
    const { world, stadium } = m;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(cam.s, 0, 0, cam.s, canvas.width / 2 - cam.x * cam.s, canvas.height / 2 - cam.y * cam.s);
    drawBackground(stadium);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (const s of world.segments) drawSegment(s);
    ctx.lineWidth = 2;
    for (const j of world.joints) {
      const a = world.discs[j.d0];
      const b = world.discs[j.d1];
      if (!a || !b || !j.color) continue;
      ctx.strokeStyle = j.color;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const playerByDisc = new Map(m.players.filter((p) => p.disc).map((p) => [p.disc, p]));
    for (const d of world.discs) {
      const p = playerByDisc.get(d);
      const kit = p && kits ? kits[p.team] : null;
      if (kit) drawKit(ctx, kit, d.x, d.y, d.r);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TAU);
      if (d.color && !kit) {
        ctx.fillStyle = d.color;
        ctx.fill();
      }
      if (d.color || p) {
        ctx.lineWidth = p && p.kicking ? 3 : 2;
        ctx.strokeStyle = p && p.kicking ? '#ffffff' : (kit ? `#${kit.border}` : '#0b0f10');
        ctx.stroke();
      }
      if (p && p.avatar) drawDiscLabel(ctx, p.avatar.slice(0, 2), d.x, d.y, d.r, kit ? `#${kit.text}` : '#ffffff');
    }
    if (names) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${Math.max(9, 12 * dpr / cam.s)}px "Rubik", system-ui, sans-serif`;
      for (const p of m.players) {
        if (!p.disc || !p.name) continue;
        const y = p.disc.y + p.disc.r + 4;
        ctx.lineWidth = 3 / cam.s * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.strokeText(p.name, p.disc.x, y);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(p.name, p.disc.x, y);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Miniatura estática de un estadio (vista previa e ícono de la biblioteca). */
  function thumbnail(m) {
    const b = cameraBounds(m.stadium);
    const s = Math.min(canvas.width / (2 * b.w), canvas.height / (2 * b.h));
    cam.x = 0;
    cam.y = 0;
    cam.s = s;
    cam.ready = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(s, 0, 0, s, canvas.width / 2, canvas.height / 2);
    drawBackground(m.stadium);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const seg of m.world.segments) drawSegment(seg);
    for (const d of m.world.discs) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TAU);
      if (d.color) {
        ctx.fillStyle = d.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#0b0f10';
        ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return { render, thumbnail, resize, cam };
}
