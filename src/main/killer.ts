import { execFile } from 'node:child_process';
import type { KillResult } from '../shared/types';
import type { ProcInfo } from './scanner';

/** Procesos que solo lanzan al servidor (npm run dev, nodemon...). Si quedan vivos dejan la terminal colgada o reinician el servidor. */
function isWrapper(proc: ProcInfo): boolean {
  const cmd = proc.cmd.toLowerCase();
  // Solo el cmd que npm usa para ejecutar el script ("cmd /d /s /c vite"), nunca una terminal interactiva.
  if (proc.name === 'cmd') return /\s\/c\s/.test(cmd);
  if (['npm', 'npx', 'pnpm', 'yarn'].includes(proc.name)) return true;
  // concurrently y turbo quedan fuera a propósito: matarlos apagaría también a sus otros servidores.
  if (proc.name === 'node') return /npm-cli\.js|npx-cli\.js|[\\/]pnpm|[\\/]yarn|nodemon|ts-node-dev|[\\/]tsx[\\/]/.test(cmd);
  return false;
}

/** Sube desde el servidor mientras el padre sea un envoltorio y devuelve el proceso más alto a matar. */
export function killTarget(pid: number, procs: Map<number, ProcInfo>): number {
  let target = pid;
  const seen = new Set<number>([pid]);
  let parent = procs.get(procs.get(pid)?.ppid ?? -1);
  while (parent && !seen.has(parent.pid) && isWrapper(parent)) {
    target = parent.pid;
    seen.add(parent.pid);
    parent = procs.get(parent.ppid);
  }
  return target;
}

function taskkill(pid: number): Promise<KillResult> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const msg = String(stderr || err.message);
      if (/acceso denegado|access is denied/i.test(msg)) {
        resolve({ ok: false, error: 'Windows no dejó detenerlo: se inició como administrador. Abre esta app como administrador para detenerlo.' });
      } else if (/no se encontr|not found/i.test(msg)) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: msg.trim() });
      }
    });
  });
}

export async function kill(pid: number, procs: Map<number, ProcInfo>): Promise<KillResult> {
  const target = killTarget(pid, procs);
  const result = await taskkill(target);
  // Si el envoltorio no se pudo matar, al menos intentamos con el servidor.
  if (!result.ok && target !== pid) return taskkill(pid);
  return result;
}
