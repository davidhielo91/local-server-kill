import { execFile } from 'node:child_process';
import type { DevServer, KillResult } from '../shared/types';
import { listProcesses, type ProcInfo } from './scanner';

/** Lo que hace falta del servidor para reconocerlo en una lista de procesos nueva. */
export type KillRequest = Pick<DevServer, 'pid' | 'startedAt' | 'commandLine'>;

/** Procesos que solo lanzan al servidor (npm run dev, nodemon...). Si quedan vivos dejan la terminal colgada o reinician el servidor. */
function isWrapper(proc: ProcInfo): boolean {
  const cmd = proc.cmd.toLowerCase();
  // Solo el cmd que npm usa para ejecutar el script ("cmd /d /s /c vite"), nunca una terminal interactiva.
  if (proc.name === 'cmd') return /\s\/c\s/.test(cmd);
  if (['npm', 'npx', 'pnpm', 'yarn'].includes(proc.name)) return true;
  // Solo el archivo de arranque de cada herramienta, no cualquier ruta que pase por una carpeta "pnpm" o "yarn":
  // un CLI instalado con `pnpm add -g` vive en ...\pnpm\global\...\node_modules y no es un envoltorio.
  if (proc.name === 'node') return WRAPPER_SCRIPT.test(cmd);
  return false;
}

const WRAPPER_SCRIPT = new RegExp(
  [
    String.raw`[\\/]npm[\\/]bin[\\/]np[mx]-cli\.js`,
    String.raw`[\\/]pnpm[\\/](bin|dist)[\\/]pnpm\.c?js`,
    String.raw`[\\/]yarn[\\/]bin[\\/]yarn\.js`,
    String.raw`[\\/]\.yarn[\\/]releases[\\/]yarn-[^\\/]+\.cjs`,
    String.raw`[\\/]corepack[\\/]dist[\\/](pnpm|yarn|npm|npx)\.js`,
    String.raw`[\\/]nodemon[\\/]bin[\\/]nodemon\.js`,
    String.raw`[\\/]ts-node-dev[\\/]lib[\\/]bin\.js`,
    String.raw`[\\/]tsx[\\/]dist[\\/]cli\.m?js`,
  ].join('|'),
  'i',
);

/** Corren varios procesos a la vez: matarlos apagaría también lo que no es este servidor. Nunca se sube a ellos. */
const ORCHESTRATOR = /concurrently|[\\/]turbo[\\/]|npm-run-all|[\\/]run-p\b|[\\/]nx[\\/]|[\\/]lerna[\\/]/i;
/** pnpm/yarn sobre varios paquetes del monorepo (`pnpm -r dev`, `yarn workspaces foreach`): también son orquestadores. */
const WORKSPACE_RUN = /\s(-r|--recursive|--parallel|--filter|-F)(\s|=|$)|\sworkspaces\s+foreach\b/;
/** El proceso es pnpm o yarn mismo (no algo que solo vive en node_modules\.pnpm o .yarn, como nodemon con `-r dotenv/config`). */
const PACKAGE_MANAGER = /[\\/]pnpm[\\/](bin|dist)[\\/]pnpm\.c?js|[\\/]yarn[\\/]bin[\\/]yarn\.js|[\\/]\.yarn[\\/]releases[\\/]|[\\/]corepack[\\/]dist[\\/](pnpm|yarn)\.js/i;

function isOrchestrator(proc: ProcInfo): boolean {
  if (ORCHESTRATOR.test(proc.cmd)) return true;
  const isPackageManager = proc.name === 'pnpm' || proc.name === 'yarn' || (proc.name === 'node' && PACKAGE_MANAGER.test(proc.cmd));
  return isPackageManager && WORKSPACE_RUN.test(proc.cmd);
}

/** El padre arrancó antes que el hijo. Si no, Windows le dio el PID del padre verdadero (que ya terminó) a otro proceso. */
function startedBefore(parent: ProcInfo, child: ProcInfo): boolean {
  return parent.started === null || child.started === null || parent.started <= child.started;
}

/** ¿`ancestor` está más arriba que `pid` en el árbol de procesos? */
function isAncestor(ancestor: ProcInfo, pid: number, procs: Map<number, ProcInfo>): boolean {
  const seen = new Set<number>();
  let child = procs.get(pid);
  while (child && !seen.has(child.pid)) {
    seen.add(child.pid);
    const parent = procs.get(child.ppid);
    if (!parent || !startedBefore(parent, child)) return false;
    if (parent.pid === ancestor.pid) return true;
    child = parent;
  }
  return false;
}

/**
 * Lanzador y worker de Next.js: "next dev" crea con fork next/dist/server/lib/start-server.js, que es el que abre
 * el puerto, y le manda su configuración por IPC. Relanzar solo el worker no hace nada: hay que apagar y relanzar "next dev".
 * Se reconoce por los dos scripts, no por carpetas: con pnpm el worker vive en node_modules\.pnpm de la raíz del monorepo
 * y el lanzador en la carpeta de la app.
 */
const NEXT_LAUNCHER = /[\\/]next[\\/]dist[\\/]bin[\\/]next\b/i;
const NEXT_WORKER = /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js/i;

/** ¿Apagar a `parent` sigue siendo apagar solo este servidor? */
function belongsToServer(parent: ProcInfo, child: ProcInfo): boolean {
  if (!startedBefore(parent, child) || isOrchestrator(parent)) return false;
  if (isWrapper(parent)) return true;
  return parent.name === 'node' && NEXT_LAUNCHER.test(parent.cmd) && NEXT_WORKER.test(child.cmd);
}

/**
 * ¿`parent` tiene otro hijo vivo además de `child`? Entonces /T se lo llevaría también: un `dev.bat` que lanzó
 * `tailwindcss -w` y `npm run dev`, o un orquestador que la lista no conoce. conhost es la consola del propio cmd.
 */
function hasOtherChildren(parent: ProcInfo, child: ProcInfo, children: Map<number, ProcInfo[]>): boolean {
  return (children.get(parent.pid) ?? []).some((p) => p.pid !== child.pid && p.name !== 'conhost' && startedBefore(parent, p));
}

/**
 * Sube desde el servidor mientras el padre sea parte de él (envoltorio, o "next dev" sobre su worker)
 * y devuelve el proceso más alto a matar. No sube a un padre que tenga otros hijos, ni uno que tenga debajo
 * a otro proceso con puertos abiertos (`listening`), porque /T los apagaría a todos.
 */
export function killTarget(server: KillRequest, procs: Map<number, ProcInfo>, listening: number[] = []): number {
  let target = procs.get(server.pid);
  if (!target) return server.pid;
  const own = target;
  // Los hijos del propio servidor que abren puertos (un worker, un websocket de HMR) no son "otros".
  const others = listening.filter((pid) => pid !== own.pid && !isAncestor(own, pid, procs));
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs.values()) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const seen = new Set<number>([target.pid]);
  let parent = procs.get(target.ppid);
  while (
    parent &&
    !seen.has(parent.pid) &&
    belongsToServer(parent, target) &&
    !hasOtherChildren(parent, target, children) &&
    !others.some((pid) => pid === parent!.pid || isAncestor(parent!, pid, procs))
  ) {
    target = parent;
    seen.add(parent.pid);
    parent = procs.get(parent.ppid);
  }
  return target.pid;
}

/** ¿El PID sigue siendo el mismo proceso que mostró el panel? Si no, ya se apagó y quizá Windows le dio el PID a otro. */
export function isSameProcess(server: KillRequest, procs: Map<number, ProcInfo>): boolean {
  const proc = procs.get(server.pid);
  return !!proc && proc.started === server.startedAt && proc.cmd === server.commandLine;
}

/** process.kill(pid, 0) no mata: solo pregunta si el proceso existe (EPERM = existe pero es de otro usuario o admin). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function taskkill(pid: number): Promise<KillResult> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, (err, _stdout, stderr) => {
      // El mensaje de taskkill viene en el idioma de Windows; lo que importa es si el proceso sigue vivo.
      if (!err || !isAlive(pid)) return resolve({ ok: true });
      const msg = String(stderr).trim().split(/\r?\n/)[0];
      if (/acceso denegado|access is denied/i.test(msg)) {
        resolve({ ok: false, error: 'Windows no dejó detenerlo: se inició como administrador. Abre esta app como administrador para detenerlo.' });
      } else if (err.killed) {
        resolve({ ok: false, error: 'Windows tardó demasiado en detenerlo. Vuelve a intentarlo.' });
      } else {
        resolve({ ok: false, error: msg || `No se pudo detener (código ${err.code ?? '?'}).` });
      }
    });
  });
}

/**
 * Apaga el servidor y lo que lo lanzó. `procs` y `listening` deben estar recién leídos:
 * con una lista vieja se podría matar a un proceso que heredó el PID.
 */
export async function kill(server: KillRequest, procs: Map<number, ProcInfo>, listening: number[] = []): Promise<KillResult> {
  if (!isSameProcess(server, procs)) return { ok: true };
  const target = killTarget(server, procs, listening);
  const result = await taskkill(target);
  // Lo que importa es que el servidor muera: si al apagar el envoltorio quedó vivo, se intenta con él directamente.
  if (target !== server.pid && isAlive(server.pid)) {
    // Antes de un segundo /T /F se vuelve a confirmar que es el mismo proceso: pudo morir y su PID pasar a otro.
    if (!isSameProcess(server, await listProcesses())) return { ok: true };
    return taskkill(server.pid);
  }
  return result;
}
