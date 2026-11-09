import { execFile } from 'node:child_process';
import path from 'node:path';

/** Si PowerShell o netstat se cuelgan (p. ej. WMI dañado), se cortan aquí para que la búsqueda no quede esperando para siempre. */
const RUN_TIMEOUT = 20_000;

export function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = { windowsHide: true, timeout: RUN_TIMEOUT, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env };
    execFile(file, args, options, (err, stdout) => {
      if (!err) return resolve(stdout);
      // El mensaje original trae el comando completo (con kilobytes de base64): al usuario solo le sirve esto.
      const name = path.basename(file, '.exe');
      reject(new Error(err.killed ? `${name} tardó demasiado en responder.` : `${name} falló (código ${err.code ?? '?'}).`));
    });
  });
}

/** Ejecuta un script de PowerShell. Va codificado para no pelear con comillas; los datos viajan en variables de entorno. */
export function powershell(script: string, env?: Record<string, string>): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], env);
}
