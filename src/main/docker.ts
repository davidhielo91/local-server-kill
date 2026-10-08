import { execFile } from 'node:child_process';
import type { ActionResult, DevServer } from '../shared/types';

/** Contenedores agrupados por proyecto (compose / Supabase); cada grupo se muestra como una fila. */
export interface DockerGroup {
  name: string;
  projectPath: string | null;
  ports: number[];
  exposed: boolean;
  startedAt: number | null;
  containers: { id: string; name: string }[];
}

function docker(args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const INSPECT_FORMAT = [
  '{{.Id}}',
  '{{.Name}}',
  '{{.State.StartedAt}}',
  '{{index .Config.Labels "com.docker.compose.project"}}',
  '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
  '{{index .Config.Labels "com.supabase.cli.workdir"}}',
  '{{json .NetworkSettings.Ports}}',
].join('\t');

type PortBindings = Record<string, { HostIp: string; HostPort: string }[] | null> | null;

/** Pregunta a Docker qué contenedores corren y qué puertos publican. Lanza error si Docker no responde. */
export async function listDockerGroups(): Promise<DockerGroup[]> {
  const ids = (await docker(['ps', '-q'])).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const out = await docker(['inspect', '--format', INSPECT_FORMAT, ...ids]);

  const groups = new Map<string, DockerGroup>();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Docker escribe "<no value>" cuando el contenedor no tiene esa etiqueta.
    const [id, rawName, started, project, composeDir, supabaseDir, portsJson] = line
      .split('\t')
      .map((v) => (v === '<no value>' ? '' : v));
    const name = rawName.replace(/^\//, '');
    const key = project || name;
    const group = groups.get(key) ?? {
      name: key, projectPath: null, ports: [], exposed: false, startedAt: null, containers: [],
    };
    groups.set(key, group);
    group.containers.push({ id: id.slice(0, 12), name });
    group.projectPath ??= composeDir || supabaseDir || null;

    const startedAt = Date.parse(started);
    if (!Number.isNaN(startedAt) && (group.startedAt === null || startedAt < group.startedAt)) group.startedAt = startedAt;

    let bindings: PortBindings = null;
    try {
      bindings = JSON.parse(portsJson);
    } catch {
      // Sin puertos publicados.
    }
    for (const list of Object.values(bindings ?? {})) {
      for (const b of list ?? []) {
        const port = Number(b.HostPort);
        if (Number.isInteger(port) && !group.ports.includes(port)) group.ports.push(port);
        if (b.HostIp === '0.0.0.0' || b.HostIp === '::' || b.HostIp === '') group.exposed = true;
      }
    }
  }
  return [...groups.values()];
}

/** Id estable y negativo para la fila: no choca con PIDs reales y no cambia entre búsquedas. */
export function dockerRowId(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return -(Math.abs(h) % 1_000_000_000) - 1;
}

export function groupToServer(g: DockerGroup): DevServer {
  return {
    pid: dockerRowId(g.name),
    ports: g.ports,
    processName: 'docker',
    framework: 'Docker',
    project: g.name,
    projectPath: g.projectPath,
    commandLine: g.containers.map((c) => c.name).join('\n'),
    startedAt: g.startedAt,
    exposed: g.exposed,
    docker: true,
    containers: g.containers,
    memoryBytes: 0,
    cpuPercent: null,
    forgotten: false,
  };
}

async function runOnContainers(verb: 'stop' | 'restart', server: DevServer): Promise<ActionResult> {
  if (!server.containers?.length) return { ok: false, error: 'No sé qué contenedores son. Detenlo desde Docker Desktop.' };
  try {
    await docker([verb, ...server.containers.map((c) => c.id)], 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Docker no pudo ${verb === 'stop' ? 'detenerlo' : 'reiniciarlo'}: ${(err as Error).message}` };
  }
}

export const stopContainers = (server: DevServer) => runOnContainers('stop', server);
export const restartContainers = (server: DevServer) => runOnContainers('restart', server);
