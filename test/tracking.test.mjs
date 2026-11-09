// Prueba cuándo un servidor cuenta como "nuevo" y desde cuándo está prendido.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GRACE_MS, ServerTracker } from '../dist/main/tracking.js';

const S = 1000;
const MIN = 60 * S;

function srv(pid, startedAt, { port = 3000, projectPath = 'C:\\web', docker = false } = {}) {
  return { pid, ports: [port], processName: 'node', projectPath, startedAt, runningSince: startedAt, docker };
}

test('la primera búsqueda no avisa de lo que ya estaba corriendo', () => {
  const t = new ServerTracker();
  assert.deepEqual(t.update([srv(1, 0)], 10 * MIN).started, []);
});

test('un servidor que aparece después sí cuenta como nuevo', () => {
  const t = new ServerTracker();
  t.update([srv(1, 0)], 10 * MIN);
  const s = srv(2, 11 * MIN, { port: 5173 });
  assert.deepEqual(t.update([srv(1, 0), s], 12 * MIN).started, [s]);
});

test('nodemon / node --watch: PID nuevo en la misma carpeta y puerto no es "nuevo" y conserva su tiempo', () => {
  const t = new ServerTracker();
  t.update([srv(1, 0)], 10 * MIN);
  const relaunched = srv(2, 15 * MIN);
  assert.deepEqual(t.update([relaunched], 16 * MIN).started, []);
  assert.equal(relaunched.runningSince, 0);
});

test('si el relanzamiento deja el puerto cerrado durante una búsqueda, al volver sigue siendo el mismo', () => {
  const t = new ServerTracker();
  t.update([srv(1, 0)], 10 * MIN);
  t.update([], 10 * MIN + 5 * S);
  t.update([], 10 * MIN + 10 * S);
  const back = srv(2, 10 * MIN + 12 * S);
  assert.deepEqual(t.update([back], 10 * MIN + 15 * S).started, []);
  assert.equal(back.runningSince, 0);
});

test('apagado más tiempo que la gracia: al volver es nuevo, con su tiempo desde cero', () => {
  const t = new ServerTracker();
  t.update([srv(1, 0)], 10 * MIN);
  t.update([], 10 * MIN + GRACE_MS + S);
  const again = srv(2, 11 * MIN);
  assert.deepEqual(t.update([again], 11 * MIN + S).started, [again]);
  assert.equal(again.runningSince, 11 * MIN);
});

test('reinicio pedido desde la app: el tiempo vuelve a cero y no avisa como nuevo', () => {
  const t = new ServerTracker();
  const old = srv(1, 0);
  t.update([old], 5 * 60 * MIN);
  t.resetClock(old, 5 * 60 * MIN + S);
  // Una búsqueda que empezó antes del reinicio todavía ve el proceso viejo: no debe devolver el reloj atrás.
  t.update([srv(1, 0)], 5 * 60 * MIN + 2 * S);
  const relaunched = srv(2, 5 * 60 * MIN + 3 * S);
  assert.deepEqual(t.update([relaunched], 5 * 60 * MIN + 5 * S).started, []);
  assert.equal(relaunched.runningSince, 5 * 60 * MIN + S);
});

test('el aviso de "olvidado" sale una vez por racha, aunque nodemon relance el proceso en medio', () => {
  const t = new ServerTracker();
  const s = srv(1, 0);
  t.update([s], 4 * 60 * MIN);
  assert.equal(t.claimForgottenAlert(s), true);
  assert.equal(t.claimForgottenAlert(s), false);
  t.update([], 4 * 60 * MIN + 5 * S); // relanzamiento: una búsqueda sin el puerto
  const back = srv(2, 4 * 60 * MIN + 6 * S);
  t.update([back], 4 * 60 * MIN + 10 * S);
  assert.equal(t.claimForgottenAlert(back), false);
  // Si lo reinicias desde la app empieza otra racha y puede volver a avisar.
  t.resetClock(back, 4 * 60 * MIN + 20 * S);
  assert.equal(t.claimForgottenAlert(back), true);
});

test('las filas de Docker no se rastrean ni se marcan como nuevas', () => {
  const t = new ServerTracker();
  t.update([], 0);
  assert.deepEqual(t.update([srv(-5, 0, { docker: true })], MIN).started, []);
});
