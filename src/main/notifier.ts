import { Notification } from 'electron';
import type { DevServer, ScanResult } from '../shared/types';
import type { Settings } from './settings';
import { ServerTracker } from './tracking';

const tracker = new ServerTracker();
// Windows pierde el clic de un aviso si el objeto Notification se recolecta antes: se guardan aquí.
const alive = new Set<Notification>();

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

const describe = (s: DevServer) => (s.project ? `${s.framework} (${s.project})` : s.framework);

function notify(title: string, body: string, onClick: () => void) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  alive.add(n);
  n.on('click', () => {
    alive.delete(n);
    onClick();
  });
  n.on('close', () => alive.delete(n));
  n.show();
}

/**
 * Pone `runningSince` y `forgotten` a cada servidor y lanza los avisos de servidor nuevo / olvidado.
 * Se llama después de cada búsqueda que salió bien. Docker queda fuera: suelen ser bases de datos que se dejan prendidas.
 */
export function processScan(result: ScanResult, settings: Settings, onClick: () => void) {
  const now = Date.now();
  // En la primera búsqueda solo se toma nota: no se avisa de lo que ya estaba corriendo al abrir la app.
  const { started } = tracker.update(result.servers, now);
  const limitMs = settings.forgottenHours * 3_600_000;

  for (const s of result.servers) {
    if (s.docker || s.runningSince === null) continue;
    s.forgotten = limitMs > 0 && now - s.runningSince > limitMs;
    // Una vez por racha de encendido: el tracker lo recuerda aunque nodemon relance el proceso.
    if (s.forgotten && tracker.claimForgottenAlert(s)) {
      const hours = Math.floor((now - s.runningSince) / 3_600_000);
      notify(
        `${describe(s)} lleva ${hours >= 1 ? `${hours} h` : formatHours(settings.forgottenHours)} prendido`,
        `Puerto :${s.ports[0]}. Haz clic para revisarlo.`,
        onClick,
      );
    }
  }

  if (settings.notifyNew) {
    for (const s of started) notify(`${s.framework} arrancó en :${s.ports[0]}`, s.project ?? 'Haz clic para verlo en el panel.', onClick);
  }
}

/** El usuario lo apagó o reinició desde la app: su tiempo prendido (y el aviso de "olvidado") empieza de cero. */
export function forgetServer(server: DevServer) {
  if (!server.docker) tracker.resetClock(server);
}
