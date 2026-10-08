import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionResult, DevServer } from '../shared/types';
import { kill, killTarget } from './killer';
import { getCwds, listListeners, type ProcInfo } from './scanner';

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
    execFile('cmd.exe', ['/d', '/c', 'code', folder], { windowsHide: true, env }, (err) => {
      resolve(err ? { ok: false, error: 'No encontré VS Code. Instálalo o agrega "code" al PATH.' } : { ok: true });
    });
  });
}

async function waitForPortFree(port: number, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const listeners = await listListeners();
    if (!listeners.some((l) => l.port === port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const LAUNCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Start-Process cmd.exe -WorkingDirectory $env:LSK_CWD -ArgumentList '/s', '/k', ('"' + $env:LSK_CMD + '"')
`;

/** Abre una terminal nueva y visible en la carpeta indicada que ejecuta el comando. */
function launchInTerminal(command: string, cwd: string): Promise<ActionResult> {
  const encoded = Buffer.from(LAUNCH_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, LSK_CMD: command, LSK_CWD: cwd } },
      (err, _stdout, stderr) => resolve(err ? { ok: false, error: `No se pudo volver a lanzar: ${String(stderr || err.message).trim()}` } : { ok: true }),
    );
  });
}

/**
 * Apaga el servidor (junto con su "npm run dev") y lo vuelve a lanzar con el mismo comando,
 * desde la misma carpeta, en una terminal nueva donde se ven los logs.
 */
export async function restart(server: DevServer, procs: Map<number, ProcInfo>): Promise<ActionResult> {
  const target = procs.get(killTarget(server.pid, procs));
  if (!target?.cmd) return { ok: false, error: 'No se puede reiniciar: no sé con qué comando se lanzó.' };
  const cwd = (await getCwds([target])).get(target.pid) ?? server.projectPath;
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'No se puede reiniciar: no sé desde qué carpeta se lanzó.' };

  const killed = await kill(server.pid, procs);
  if (!killed.ok) return killed;
  await waitForPortFree(server.ports[0], 5_000);
  return launchInTerminal(target.cmd, cwd);
}
