import { Notification } from 'electron';
import type { DevServer, ScanResult } from '../shared/types';
import type { Settings } from './settings';

const key = (s: DevServer) => `${s.pid}:${s.startedAt}`;

let known: Set<string> | null = null;
const alertedForgotten = new Set<string>();
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
 * Marca los servidores olvidados y lanza los avisos de servidor nuevo / olvidado.
 * Se llama después de cada búsqueda que salió bien.
 */
export function processScan(result: ScanResult, settings: Settings, onClick: () => void) {
  const now = Date.now();
  const limitMs = settings.forgottenHours * 3_600_000;
  const servers = result.servers.filter((s) => !s.docker);

  for (const s of servers) {
    s.forgotten = limitMs > 0 && s.startedAt !== null && now - s.startedAt > limitMs;
    if (s.forgotten && !alertedForgotten.has(key(s))) {
      alertedForgotten.add(key(s));
      const hours = Math.floor((now - s.startedAt!) / 3_600_000);
      notify(
        `${describe(s)} lleva ${hours >= 1 ? `${hours} h` : formatHours(settings.forgottenHours)} prendido`,
        `Puerto :${s.ports[0]}. Haz clic para revisarlo.`,
        onClick,
      );
    }
  }

  const current = new Set(servers.map(key));
  // En la primera búsqueda solo se toma nota: no se avisa de lo que ya estaba corriendo al abrir la app.
  if (known && settings.notifyNew) {
    for (const s of servers) {
      if (known.has(key(s))) continue;
      notify(`${s.framework} arrancó en :${s.ports[0]}`, s.project ?? 'Haz clic para verlo en el panel.', onClick);
    }
  }
  known = current;
}
