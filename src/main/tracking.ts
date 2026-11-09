import type { DevServer } from '../shared/types';

/**
 * Un servidor se reconoce por su carpeta y su puerto principal, no por su PID: nodemon, node --watch
 * o el autoreload de Django lo relanzan con un PID nuevo cada vez que guardas.
 */
export const serverKey = (s: Pick<DevServer, 'projectPath' | 'processName' | 'ports'>) =>
  `${(s.projectPath ?? s.processName).toLowerCase()}|${s.ports[0]}`;

interface Seen {
  since: number;
  lastSeen: number;
  /** Ya se avisó que está "olvidado" en esta racha de encendido. */
  alerted: boolean;
}

/**
 * Un relanzamiento puede caer justo cuando el puerto está cerrado (o un tsc lento lo deja cerrado unos segundos).
 * Si el servidor vuelve dentro de este tiempo, es el mismo y no uno nuevo. Es más que una búsqueda en segundo plano (30 s).
 */
export const GRACE_MS = 45_000;

export interface TrackResult {
  /** Servidores que no estaban antes. Vacío en la primera búsqueda. */
  started: DevServer[];
}

export class ServerTracker {
  private seen: Map<string, Seen> | null = null;

  /** Anota los servidores de esta búsqueda y les pone `runningSince`. No toca las filas de Docker. */
  update(servers: DevServer[], now = Date.now()): TrackResult {
    const first = this.seen === null;
    const previous = this.seen ?? new Map<string, Seen>();
    const next = new Map<string, Seen>();
    const started: DevServer[] = [];

    for (const s of servers) {
      if (s.docker) continue;
      const key = serverKey(s);
      const own = s.startedAt ?? now;
      const known = next.get(key) ?? previous.get(key);
      if (!known && !first) started.push(s);
      // Si ya se conocía, conserva su inicio aunque el proceso sea otro (o el reloj se haya reiniciado con resetClock).
      const since = known ? known.since : own;
      next.set(key, { since, lastSeen: now, alerted: known?.alerted ?? false });
      s.runningSince = since;
    }
    for (const [key, entry] of previous) {
      if (!next.has(key) && now - entry.lastSeen <= GRACE_MS) next.set(key, entry);
    }

    this.seen = next;
    return { started };
  }

  /**
   * El usuario lo apagó o reinició desde la app: su tiempo prendido empieza de cero. Si vuelve dentro de
   * GRACE_MS (el reinicio que pidió) no se avisa como "nuevo", porque ya sabe que arrancó.
   */
  resetClock(server: Pick<DevServer, 'projectPath' | 'processName' | 'ports'>, now = Date.now()) {
    this.seen?.set(serverKey(server), { since: now, lastSeen: now, alerted: false });
  }

  /** Devuelve true solo la primera vez por racha de encendido: así el aviso de "olvidado" sale una sola vez. */
  claimForgottenAlert(server: Pick<DevServer, 'projectPath' | 'processName' | 'ports'>): boolean {
    const entry = this.seen?.get(serverKey(server));
    if (!entry || entry.alerted) return false;
    entry.alerted = true;
    return true;
  }
}
