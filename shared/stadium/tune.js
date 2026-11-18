// Ajustes de "sensación de juego" para estadios importados, sin tocar el archivo original.
//
// Patada: la velocidad que recibe la pelota es kickStrength × invMass de la pelota.
// En las canchas de HaxBort eso da 5. Si un mapa se aleja más de un 15%, se ajusta
// kickStrength para volver a 5, así la patada se siente parecida en todas las canchas.

export const KICK_REFERENCE = 5;
export const KICK_TOLERANCE = 0.15;

/** Impulso que recibe la pelota en una patada (velocidad por tick). */
export function kickPower(stadium) {
  const ball = stadium.discs[0];
  const inv = ball && ball.invMass > 0 ? ball.invMass : 1;
  return stadium.playerPhysics.kickStrength * inv;
}

/** ¿Hace falta ajustar la patada de este estadio? Devuelve { needed, before, after }. */
export function kickCheck(stadium) {
  const before = kickPower(stadium);
  const lo = KICK_REFERENCE * (1 - KICK_TOLERANCE);
  const hi = KICK_REFERENCE * (1 + KICK_TOLERANCE);
  const ball = stadium.discs[0];
  const needed = Boolean(ball && ball.invMass > 0) && (before < lo || before > hi);
  return { needed, before, after: needed ? KICK_REFERENCE : before };
}

/** Copia del estadio con la patada ajustada (si hacía falta). */
export function normalizeKick(stadium) {
  const check = kickCheck(stadium);
  if (!check.needed) return { stadium, ...check };
  const ball = stadium.discs[0];
  const tuned = {
    ...stadium,
    playerPhysics: { ...stadium.playerPhysics, kickStrength: KICK_REFERENCE / ball.invMass },
  };
  return { stadium: tuned, ...check };
}
