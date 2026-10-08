import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { DevServer, ScanResult } from '../shared/types';
import { groupToServer, listDockerGroups } from './docker';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  exe: string | null;
  cmd: string;
  started: number | null;
  /** Memoria en uso (working set), en bytes. */
  ws: number;
  /** Tiempo de CPU acumulado, en unidades de 100 ns. */
  cpu: number;
}

interface Listener {
  pid: number;
  port: number;
  address: string;
}

const DEV_PROCESSES = new Set([
  'node', 'bun', 'deno', 'python', 'python3', 'pythonw', 'py', 'php', 'php-cgi',
  'ruby', 'java', 'go', 'dotnet', 'uvicorn', 'gunicorn', 'flask', 'hugo', 'caddy',
]);
const DOCKER_PROCESSES = new Set(['com.docker.backend', 'wslrelay', 'vpnkit']);

const PS_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object {
  $t = $null
  if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }
  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine; started = $t; ws = [double]$_.WorkingSetSize; cpu = [double]($_.KernelModeTime + $_.UserModeTime) }
} | ConvertTo-Json -Compress
`;

/**
 * Lee la carpeta de trabajo de cada proceso desde su PEB (Windows no la expone de otra forma).
 * Sirve para comandos sin rutas como "node server.js" o "python -m http.server".
 */
const CWD_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Cwd {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr[] info, int size, out int len);
  static byte[] Read(IntPtr h, IntPtr addr, int size) {
    var buf = new byte[size]; IntPtr n;
    if (!ReadProcessMemory(h, addr, buf, size, out n)) throw new Exception();
    return buf;
  }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new IntPtr[6]; int len;
      if (NtQueryInformationProcess(h, 0, pbi, IntPtr.Size * 6, out len) != 0) return null;
      var parameters = (IntPtr)BitConverter.ToInt64(Read(h, pbi[1] + 0x20, 8), 0);
      var str = Read(h, parameters + 0x38, 16);
      int length = BitConverter.ToUInt16(str, 0);
      var buffer = (IntPtr)BitConverter.ToInt64(str, 8);
      return System.Text.Encoding.Unicode.GetString(Read(h, buffer, length));
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
$out = @{}
foreach ($id in $env:LSK_PIDS.Split(',')) { $out[$id] = [Cwd]::Get([int]$id) }
$out | ConvertTo-Json -Compress
`;

const cwdCache = new Map<string, string | null>();

export async function getCwds(procs: ProcInfo[]): Promise<Map<number, string | null>> {
  // La clave incluye la hora de inicio para no reutilizar el resultado si Windows recicla el PID.
  const key = (p: ProcInfo) => `${p.pid}:${p.started}`;
  const missing = procs.filter((p) => !cwdCache.has(key(p)));
  if (missing.length) {
    try {
      const encoded = Buffer.from(CWD_SCRIPT, 'utf16le').toString('base64');
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        LSK_PIDS: missing.map((p) => p.pid).join(','),
      });
      const parsed: Record<string, string | null> = JSON.parse(out.trim() || '{}');
      for (const p of missing) cwdCache.set(key(p), parsed[String(p.pid)]?.replace(/\\$/, '') || null);
    } catch {
      for (const p of missing) cwdCache.set(key(p), null);
    }
  }
  return new Map(procs.map((p) => [p.pid, cwdCache.get(key(p)) ?? null]));
}

function run(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env };
    execFile(file, args, options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** netstat es rápido; su columna de estado viene traducida, así que "en escucha" se detecta por la dirección remota con puerto 0. */
export async function listListeners(): Promise<Listener[]> {
  const [v4, v6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])]);
  const listeners: Listener[] = [];
  for (const line of (v4 + v6).split(/\r?\n/)) {
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

export async function listProcesses(): Promise<Map<number, ProcInfo>> {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  const raw = JSON.parse(out.trim() || '[]');
  const list: any[] = Array.isArray(raw) ? raw : [raw];
  const map = new Map<number, ProcInfo>();
  for (const p of list) {
    map.set(p.pid, {
      pid: p.pid,
      ppid: p.ppid,
      name: String(p.name ?? '').replace(/\.exe$/i, '').toLowerCase(),
      exe: p.exe ?? null,
      cmd: p.cmd ?? '',
      started: typeof p.started === 'number' ? p.started : null,
      ws: Number(p.ws) || 0,
      cpu: Number(p.cpu) || 0,
    });
  }
  return map;
}

function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) tokens.push(m[1] ?? m[2]);
  return tokens;
}

/** Rutas que nunca son la carpeta de un proyecto: Windows, Program Files, cachés globales de npm/npx, etc. */
const SYSTEM_PATH = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)\\|\\appdata\\|\\scoop\\|\\\.bun\\bin\\|\\\.deno\\bin\\/i;

function projectFromPath(p: string, isDir = false): string | null {
  const norm = p.replace(/\//g, '\\');
  if (!/^[a-z]:\\/i.test(norm) || SYSTEM_PATH.test(norm)) return null;
  const marker = norm.search(/\\(node_modules|\.venv|venv|env|vendor)\\/i);
  if (marker > 0) return norm.slice(0, marker);
  return !isDir && path.extname(norm) ? path.dirname(norm) : norm;
}

/** Busca la carpeta del proyecto en la línea de comandos del proceso y, si no aparece, en la de sus padres. */
function findProject(proc: ProcInfo, procs: Map<number, ProcInfo>): string | null {
  let current: ProcInfo | undefined = proc;
  for (let depth = 0; current && depth < 4; depth++) {
    const tokens = tokenize(current.cmd);
    for (const t of [...tokens.slice(1), ...tokens.slice(0, 1)]) {
      // Opciones tipo --root=C:\algo
      const value = t.includes('=') ? t.slice(t.indexOf('=') + 1) : t;
      const found = projectFromPath(value);
      if (found) return found;
    }
    current = procs.get(current.ppid);
  }
  return null;
}

const FRAMEWORKS: [RegExp, string][] = [
  [/[\\/]next[\\/]|\bnext dev\b/i, 'Next.js'],
  [/\bnuxi?\b/i, 'Nuxt'],
  [/\bastro\b/i, 'Astro'],
  [/\bremix\b/i, 'Remix'],
  [/svelte-?kit/i, 'SvelteKit'],
  [/@angular|\bng(\.js)? serve/i, 'Angular'],
  [/react-scripts/i, 'Create React App'],
  [/\bgatsby\b/i, 'Gatsby'],
  [/storybook/i, 'Storybook'],
  [/\bexpo\b/i, 'Expo'],
  [/\bvite\b/i, 'Vite'],
  [/\bparcel\b/i, 'Parcel'],
  [/webpack/i, 'Webpack'],
  [/json-server/i, 'json-server'],
  [/http-server/i, 'http-server'],
  [/live-server/i, 'live-server'],
  [/[\\/]serve[\\/]/i, 'serve'],
  [/nodemon/i, 'Nodemon'],
  [/manage\.py/i, 'Django'],
  [/\buvicorn\b/i, 'Uvicorn'],
  [/\bgunicorn\b/i, 'Gunicorn'],
  [/\bflask\b/i, 'Flask'],
  [/streamlit/i, 'Streamlit'],
  [/jupyter/i, 'Jupyter'],
  [/http\.server/i, 'Python http.server'],
  [/artisan/i, 'Laravel'],
  [/\s-S\s/, 'PHP'],
  [/\brails\b|\bpuma\b/i, 'Rails'],
  [/spring|gradle|maven|\bmvn\b/i, 'Spring / Java'],
];

const PROCESS_LABELS: Record<string, string> = {
  node: 'Node.js', bun: 'Bun', deno: 'Deno', python: 'Python', python3: 'Python', pythonw: 'Python', py: 'Python',
  php: 'PHP', 'php-cgi': 'PHP', ruby: 'Ruby', java: 'Java', go: 'Go', dotnet: '.NET',
};

function detectFramework(proc: ProcInfo): string {
  // La ruta del ejecutable no cuenta: "C:\Program Files\nodejs\node.exe" no dice nada del framework.
  const args = tokenize(proc.cmd).slice(1).join(' ');
  for (const [re, label] of FRAMEWORKS) if (re.test(` ${args} `)) return label;
  return PROCESS_LABELS[proc.name] ?? proc.name;
}

const isExposed = (address: string) => address === '0.0.0.0' || address === '[::]';

/** El servidor y todos sus descendientes (vite → esbuild, uvicorn → workers). */
function processTree(root: ProcInfo, procs: Map<number, ProcInfo>): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs.values()) {
    const arr = children.get(p.ppid) ?? [];
    arr.push(p);
    children.set(p.ppid, arr);
  }
  const tree: ProcInfo[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    tree.push(p);
    for (const c of children.get(p.pid) ?? []) {
      // Si Windows recicló el PID del padre, el "hijo" sería más viejo que él: no es descendiente.
      if (p.started === null || c.started === null || c.started >= p.started) stack.push(c);
    }
  }
  return tree;
}

const cpuSamples = new Map<string, { cpu: number; at: number }>();
const cores = os.availableParallelism();

/** % de CPU del árbol desde la búsqueda anterior (null en la primera). */
function cpuPercent(proc: ProcInfo, cpuTime: number, now: number): number | null {
  const key = `${proc.pid}:${proc.started}`;
  const prev = cpuSamples.get(key);
  cpuSamples.set(key, { cpu: cpuTime, at: now });
  if (!prev || now <= prev.at) return null;
  // cpu viene en unidades de 100 ns; el tiempo transcurrido en ms.
  const used = Math.max(0, cpuTime - prev.cpu) / 10_000;
  return Math.min(100, (used / ((now - prev.at) * cores)) * 100);
}

export async function scan(): Promise<{ result: ScanResult; procs: Map<number, ProcInfo> }> {
  const [listeners, procs] = await Promise.all([listListeners(), listProcesses()]);
  const now = Date.now();
  const byPid = new Map<number, Listener[]>();
  for (const l of listeners) {
    if (l.port < 1024 || l.pid <= 4) continue;
    const arr = byPid.get(l.pid) ?? [];
    arr.push(l);
    byPid.set(l.pid, arr);
  }

  const servers: DevServer[] = [];
  const pending: { server: DevServer; proc: ProcInfo }[] = [];
  let docker: DevServer | null = null;
  for (const [pid, ls] of byPid) {
    const proc = procs.get(pid);
    if (!proc) continue;
    const ports = [...new Set(ls.map((l) => l.port))];
    const exposed = ls.some((l) => isExposed(l.address));

    // Docker reparte sus puertos entre varios procesos (backend, wslrelay): se muestran como una sola fila.
    if (DOCKER_PROCESSES.has(proc.name)) {
      if (!docker) {
        docker = {
          pid, ports: [], processName: proc.name, framework: 'Docker', project: null, projectPath: null,
          commandLine: proc.cmd, startedAt: proc.started, exposed: false, docker: true,
          memoryBytes: 0, cpuPercent: null, forgotten: false,
        };
        servers.push(docker);
      }
      docker.ports = [...new Set([...docker.ports, ...ports])];
      docker.exposed ||= exposed;
      continue;
    }
    if (!DEV_PROCESSES.has(proc.name)) continue;

    const projectPath = findProject(proc, procs);
    const tree = processTree(proc, procs);
    const server: DevServer = {
      memoryBytes: tree.reduce((sum, p) => sum + p.ws, 0),
      cpuPercent: cpuPercent(proc, tree.reduce((sum, p) => sum + p.cpu, 0), now),
      forgotten: false,
      pid,
      ports,
      processName: proc.name,
      framework: detectFramework(proc),
      project: projectPath ? path.basename(projectPath) : null,
      projectPath,
      commandLine: proc.cmd,
      startedAt: proc.started,
      exposed,
      docker: false,
    };
    servers.push(server);
    if (!projectPath) pending.push({ server, proc });
  }

  if (pending.length) {
    const cwds = await getCwds(pending.map((p) => p.proc));
    for (const { server } of pending) {
      const cwd = cwds.get(server.pid);
      const projectPath = cwd ? projectFromPath(cwd, true) : null;
      if (projectPath) {
        server.projectPath = projectPath;
        server.project = path.basename(projectPath);
      }
    }
  }

  // Windows solo ve que Docker tiene los puertos; Docker sabe qué contenedor usa cada uno.
  // Si Docker responde, la fila única se reemplaza por una por proyecto, incluidos los contenedores
  // que no publican puertos (p. ej. una base de datos interna). Si no responde, se queda la fila única.
  let result = servers;
  const dockerRunning = docker !== null || [...procs.values()].some((p) => p.name === 'com.docker.backend');
  if (dockerRunning) {
    try {
      const groups = await listDockerGroups();
      result = [...servers.filter((s) => s !== docker), ...groups.map(groupToServer)];
    } catch {
      // Docker CLI no disponible o no responde.
    }
  }

  for (const s of result) s.ports.sort((a, b) => a - b);
  // Los que no tienen puerto van al final.
  result.sort((a, b) => (a.ports[0] ?? Infinity) - (b.ports[0] ?? Infinity));
  return { result: { servers: result, scannedAt: Date.now() }, procs };
}
