// Reloj de simulación a 60 Hz con poco temblor: se despierta justo antes de cada tick
// (en vez de un setInterval fijo) y recupera ticks atrasados sin acumular desfase.
const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

export function createTicker(stepFn, hz = 60) {
  const STEP = 1000 / hz;
  let next = now() + STEP;
  let running = true;
  let timer = null;
  function loop() {
    if (!running) return;
    const t = now();
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
    if (t - next > STEP * 5) next = t + STEP; // si se colgó mucho, no intenta "ponerse al día"
    timer = setTimeout(loop, Math.max(0, next - now() - 0.5));
  }
  timer = setTimeout(loop, STEP);
  return {
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}
