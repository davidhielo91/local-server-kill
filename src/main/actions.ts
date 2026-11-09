import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionResult, DevServer } from '../shared/types';
import { isSameProcess, kill, killTarget } from './killer';
import { getCwds, listListeners, listProcesses, type ProcInfo } from './scanner';

function vsCodeCandidates(): string[] {
  const { LOCALAPPDATA = '', ProgramFiles = 'C:\\Program Files' } = process.env;
  return [
    path.join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
  ];
}

/** Abre la carpeta en VS Code: primero la instalación conocida, luego el comando "code" del PATH. */
export function openInEditor(folder: string): Promise<ActionResult> {
  // Si esta variable llegara heredada, Code.exe arrancaría como Node en vez de abrir el editor.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const exe = vsCodeCandidates().find((p) => fs.existsSync(p));
  if (exe) {
    spawn(exe, [folder], { detached: true, stdio: 'ignore', env }).unref();
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/d', '/c', 'code', folder], { windowsHide: true, env, timeout: 15_000 }, (err) => {
      resolve(err ? { ok: false, error: 'No encontré VS Code. Instálalo o agrega "code" al PATH.' } : { ok: true });
    });
  });
}

/** Espera a que el puerto quede libre. Si netstat falla, sigue: lo peor es que el servidor nuevo tarde en tomar el puerto. */
async function waitForPortFree(port: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const listeners = await listListeners();
      if (!listeners.some((l) => l.port === port)) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

const LAUNCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Start-Process cmd.exe -WorkingDirectory $env:LSK_CWD -ArgumentList '/s', '/k', ('"' + $env:LSK_CMD + '"')
`;

/**
 * Entorno de la terminal nueva. npm pone node_modules\.bin en el PATH al correr un script; si se relanza
 * un "cmd /c vite" que lanzó pnpm o concurrently, sin esto "vite" no se encontraría.
 */
export function launchEnv(command: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LSK_CMD: command, LSK_CWD: cwd };
  const bin = path.join(cwd, 'node_modules', '.bin');
  if (fs.existsSync(bin)) {
    // En Windows la variable suele llamarse "Path"; hay que reemplazar esa, no agregar otra "PATH".
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = `${bin};${env[key] ?? ''}`;
  }
  return env;
}

/** Abre una terminal nueva y visible en la carpeta indicada que ejecuta el comando. */
function launchInTerminal(command: string, cwd: string): Promise<ActionResult> {
  const encoded = Buffer.from(LAUNCH_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15_000, env: launchEnv(command, cwd) },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const detail = err.killed ? 'PowerShell tardó demasiado en responder.' : String(stderr).trim().split(/\r?\n/)[0] || `código ${err.code ?? '?'}`;
        resolve({ ok: false, error: `No se pudo volver a lanzar: ${detail}` });
      },
    );
  });
}

/**
 * Apaga el servidor (junto con su "npm run dev") y lo vuelve a lanzar con el mismo comando,
 * desde la misma carpeta, en una terminal nueva donde se ven los logs.
 * Se relanza el proceso más alto que se apaga (p. ej. `npm run dev` o `next dev`), no el que tiene el puerto:
 * ese a veces es un worker que no arranca solo.
 * `procs` y `listening` deben estar recién leídos (ver kill).
 */
export async function restart(server: DevServer, procs: Map<number, ProcInfo>, listening: number[]): Promise<ActionResult> {
  if (!isSameProcess(server, procs)) return { ok: false, error: 'Ese servidor ya se apagó.' };
  const target = procs.get(killTarget(server, procs, listening));
  if (!target?.cmd) return { ok: false, error: 'No se puede reiniciar: no sé con qué comando se lanzó.' };
  const cwd = (await getCwds([target])).get(target.pid) ?? server.projectPath;
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'No se puede reiniciar: no sé desde qué carpeta se lanzó.' };

  // Leer la carpeta puede tardar unos segundos (compila C#): se vuelve a leer todo antes de matar.
  const [freshProcs, listeners] = await Promise.all([listProcesses(), listListeners()]);
  // Si mientras tanto se relanzó solo (nodemon), relanzarlo aquí dejaría dos copias peleando por el puerto.
  if (!isSameProcess(server, freshProcs)) return { ok: false, error: 'Ese servidor cambió mientras se reiniciaba. Vuelve a intentarlo.' };
  const killed = await kill(server, freshProcs, [...new Set(listeners.map((l) => l.pid))]);
  if (!killed.ok) return killed;
  await waitForPortFree(server.ports[0], 5_000);
  return launchInTerminal(target.cmd, cwd);
}
