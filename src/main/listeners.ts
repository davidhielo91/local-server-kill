import net from 'node:net';
import { powershell, run } from './run';

export interface Listener {
  pid: number;
  port: number;
  /** Como la escribe netstat: 0.0.0.0, 127.0.0.1, [::], [::1]. */
  address: string;
}

/** netstat es rápido; su columna de estado viene traducida, así que "en escucha" se detecta por la dirección remota con puerto 0. */
export function parseNetstat(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !parts[0].toUpperCase().startsWith('TCP')) continue;
    const [, local, remote, , pidStr] = parts;
    if (!/:0$/.test(remote)) continue;
    const sep = local.lastIndexOf(':');
    const port = Number(local.slice(sep + 1));
    const pid = Number(pidStr);
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue;
    listeners.push({ pid, port, address: local.slice(0, sep) });
  }
  return listeners;
}

async function netstatListeners(): Promise<Listener[]> {
  const [v4, v6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])]);
  return parseNetstat(v4 + v6);
}

/**
 * La misma tabla de conexiones vista por WMI. Se filtra por puerto remoto 0 y no por estado: en algunas versiones de
 * Windows el estado llega con valores al azar y netstat esconde esas filas, así que los servidores aparecían y desaparecían.
 */
const CIM_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'RemotePort = 0' | ForEach-Object {
  [pscustomobject]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
} | ConvertTo-Json -Compress
`;

export function parseCim(output: string): Listener[] {
  const raw = JSON.parse(output.trim() || '[]');
  const rows: { address: string; port: number; pid: number }[] = Array.isArray(raw) ? raw : [raw];
  // Mismo formato que netstat para IPv6 ("[::]"), que es el que entiende el resto de la app.
  return rows.map((r) => ({ pid: r.pid, port: r.port, address: r.address.includes(':') ? `[${r.address}]` : r.address }));
}

async function cimListeners(): Promise<Listener[]> {
  return parseCim(await powershell(CIM_SCRIPT));
}

/**
 * Todos los posibles puertos en escucha, de netstat y de WMI juntos. Pueden traer filas falsas cuando Windows reporta
 * mal la tabla: para mostrar servidores se confirman con `confirmListeners`. Solo falla si fallan las dos fuentes.
 */
export async function listListeners(): Promise<Listener[]> {
  const [fromNetstat, fromCim] = await Promise.allSettled([netstatListeners(), cimListeners()]);
  if (fromNetstat.status === 'rejected' && fromCim.status === 'rejected') throw fromNetstat.reason;
  const all = [fromNetstat, fromCim].flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set<string>();
  return all.filter((l) => {
    const key = `${l.pid}|${l.port}|${l.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A qué dirección conectarse para probar un puerto escuchado en `address`. */
export function probeHosts(address: string): string[] {
  const a = address.replace(/^\[|\]$/g, '');
  if (a === '0.0.0.0' || a.startsWith('127.')) return ['127.0.0.1'];
  if (a === '::') return ['::1', '127.0.0.1'];
  return [a];
}

/** ¿Algo acepta conexiones ahí? Se abre y se cierra sin enviar nada. */
export function accepts(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export type Prober = (listener: Listener) => Promise<boolean>;

const probe: Prober = async (l) => {
  for (const host of probeHosts(l.address)) if (await accepts(host, l.port)) return true;
  return false;
};

/**
 * Se queda con los puertos que de verdad aceptan conexiones. Cada uno se prueba una sola vez por proceso
 * (`identity` distingue PIDs reciclados): así no se le abre una conexión al servidor en cada búsqueda.
 */
export class ListenerConfirmer {
  private confirmed = new Set<string>();

  constructor(private readonly prober: Prober = probe) {}

  async confirm(candidates: Listener[], identity: (pid: number) => string): Promise<Listener[]> {
    const key = (l: Listener) => `${identity(l.pid)}|${l.port}`;
    const byKey = new Map<string, Listener[]>();
    for (const l of candidates) byKey.set(key(l), [...(byKey.get(key(l)) ?? []), l]);

    const ok = new Set<string>();
    await Promise.all(
      [...byKey].map(async ([k, ls]) => {
        if (this.confirmed.has(k)) return ok.add(k);
        for (const l of ls) {
          if (await this.prober(l)) return ok.add(k);
        }
      }),
    );
    // Solo se recuerdan los que siguen en la tabla: si el puerto se cierra y se vuelve a abrir, se prueba otra vez.
    this.confirmed = ok;
    return candidates.filter((l) => ok.has(key(l)));
  }
}
