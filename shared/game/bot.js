// Bot simple: se pone detrás de la pelota mirando al arco rival y patea.
import { INPUT } from './match.js';

export function botInput(m, playerId, { skill = 0.8 } = {}) {
  const p = m.players.find((x) => x.id === playerId);
  if (!p || !p.disc) return 0;
  const me = p.disc;
  const ball = m.world.discs.find((d) => d.kind === 'ball');
  if (!ball) return 0;
  const attack = m.stadium.goals.find((g) => g.team !== p.team) || m.stadium.goals[0];
  const defend = m.stadium.goals.find((g) => g.team === p.team);
  const gx = attack ? (attack.p0[0] + attack.p1[0]) / 2 : (p.team === 'red' ? 500 : -500);
  const gy = attack ? (attack.p0[1] + attack.p1[1]) / 2 : 0;
  // No apurarse en el saque rival: la barrera no deja entrar igual.
  if (m.phase === 'kickoff' && m.kickoffTeam !== p.team) return 0;
  let tdx = gx - ball.x;
  let tdy = gy - ball.y;
  const tl = Math.hypot(tdx, tdy) || 1;
  tdx /= tl;
  tdy /= tl;
  const reach = ball.r + me.r;
  // Posición ideal: detrás de la pelota, alineado con el arco rival.
  const lead = 6 * skill;
  const bx = ball.x + ball.vx * lead;
  const by = ball.y + ball.vy * lead;
  const behindX = bx - tdx * (reach + 6);
  const behindY = by - tdy * (reach + 6);
  const toBallX = bx - me.x;
  const toBallY = by - me.y;
  const dBall = Math.hypot(toBallX, toBallY) || 1;
  const aligned = (toBallX * tdx + toBallY * tdy) / dBall;
  let tx;
  let ty;
  if (aligned > 0.7 || dBall < reach + 8) {
    tx = bx;
    ty = by;
  } else {
    tx = behindX;
    ty = behindY;
    // Si la pelota está entre el bot y su propio arco, rodearla por el costado.
    if (defend) {
      const ox = (defend.p0[0] + defend.p1[0]) / 2;
      if (Math.sign(ball.x - ox) !== Math.sign(me.x - ox) || Math.abs(me.x - ox) > Math.abs(ball.x - ox)) {
        ty += (me.y > ball.y ? 1 : -1) * reach * 1.5;
      }
    }
  }
  let bits = 0;
  const dx = tx - me.x;
  const dy = ty - me.y;
  const dead = 4;
  if (dx > dead) bits |= INPUT.right;
  else if (dx < -dead) bits |= INPUT.left;
  if (dy > dead) bits |= INPUT.down;
  else if (dy < -dead) bits |= INPUT.up;
  const gap = Math.hypot(ball.x - me.x, ball.y - me.y) - reach;
  if (gap < 6 && aligned > 0.35) {
    // Suelta y vuelve a apretar para poder patear de nuevo.
    if (!p.kickHeld) bits |= INPUT.kick;
  }
  // Un poco de torpeza según la habilidad.
  if (((m.tick * 7 + playerId.length * 13) % 100) / 100 > skill + 0.15) bits &= ~(INPUT.left | INPUT.right);
  return bits;
}
