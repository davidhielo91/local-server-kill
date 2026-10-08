import type { Api, DevServer, ScanResult } from '../shared/types';

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;
const list = document.getElementById('list') as HTMLElement;
const count = document.getElementById('count') as HTMLElement;
const errorBox = document.getElementById('error') as HTMLElement;
const killAllBtn = document.getElementById('kill-all') as HTMLButtonElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const rowTemplate = document.getElementById('row-template') as HTMLTemplateElement;

let current: ScanResult = { servers: [], scannedAt: 0 };
const stopping = new Set<number>();
const rowErrors = new Map<number, string>();
let confirmTimer: number | undefined;
/** Fila con la barra de acciones abierta (solo una a la vez). */
let openActions: number | null = null;
/** Acción en curso por servidor, p. ej. reiniciar. */
const busy = new Map<number, string>();
let copied: { pid: number; timer: number } | null = null;

function formatMemory(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

function formatCpu(percent: number): string {
  return percent > 0 && percent < 1 ? '<1 % CPU' : `${Math.round(percent)} % CPU`;
}

function uptime(startedAt: number | null): string {
  if (!startedAt) return '';
  const min = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (min < 1) return 'recién iniciado';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 día' : `${d} días`;
}

function span(text: string, className?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

function renderRow(server: DevServer): HTMLElement {
  const row = (rowTemplate.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
  const [mainPort, ...otherPorts] = server.ports;

  const port = row.querySelector('.port') as HTMLButtonElement;
  if (mainPort === undefined) {
    // Contenedor sin puertos publicados: está prendido pero no se puede abrir desde tu PC.
    port.textContent = '—';
    port.disabled = true;
    port.classList.add('no-port');
    port.title = 'No publica puertos hacia tu PC: solo lo usan otros contenedores.';
  } else {
    port.textContent = String(mainPort);
    port.title = `Abrir http://localhost:${mainPort}`;
    port.setAttribute('aria-label', `Abrir localhost:${mainPort} en el navegador`);
    port.addEventListener('click', () => api.open(mainPort));
  }

  (row.querySelector('.framework') as HTMLElement).textContent = server.framework;

  const project = row.querySelector('.project') as HTMLElement;
  project.textContent = server.project ?? (server.docker ? 'Contenedor de Docker' : 'Carpeta desconocida');
  project.title = server.containers
    ? [server.projectPath, `Contenedores:\n${server.containers.map((c) => c.name).join('\n')}`].filter(Boolean).join('\n\n')
    : [server.projectPath, server.commandLine].filter(Boolean).join('\n\n');

  const meta = row.querySelector('.meta') as HTMLElement;
  const parts: HTMLElement[] = [];
  const up = uptime(server.startedAt);
  if (up) {
    const upEl = span(up, server.forgotten ? 'forgotten' : undefined);
    if (server.forgotten) upEl.title = 'Lleva mucho tiempo prendido. ¿Lo sigues usando?';
    parts.push(upEl);
  }
  if (server.containers) {
    const n = server.containers.length;
    parts.push(span(n === 1 ? '1 contenedor' : `${n} contenedores`));
    if (mainPort === undefined) parts.push(span('sin puertos hacia tu PC'));
  }
  if (server.memoryBytes > 0) parts.push(span(formatMemory(server.memoryBytes)));
  if (server.cpuPercent !== null) parts.push(span(formatCpu(server.cpuPercent)));
  for (const p of otherPorts.slice(0, 2)) parts.push(span(`+${p}`, 'extra-port'));
  if (otherPorts.length > 2) parts.push(span(`y ${otherPorts.length - 2} puertos más`));
  if (server.exposed) parts.push(span('visible en tu red', 'exposed'));
  meta.append(...parts);
  meta.title = [
    otherPorts.length ? `Otros puertos: ${otherPorts.join(', ')}` : '',
    server.exposed ? 'Otros equipos de tu red pueden abrirlo.' : '',
  ].filter(Boolean).join('\n');

  const err = rowErrors.get(server.pid);
  if (err) {
    const rowError = row.querySelector('.row-error') as HTMLElement;
    rowError.textContent = err;
    rowError.hidden = false;
  }

  const stop = row.querySelector('.stop') as HTMLButtonElement;
  if (server.docker && !server.containers) {
    // No se pudo preguntar a Docker qué contenedor es cuál: apagar aquí tumbaría Docker completo.
    stop.textContent = 'Docker';
    stop.disabled = true;
    stop.title = 'Detén este contenedor desde Docker Desktop.';
  } else if (stopping.has(server.pid)) {
    stop.textContent = 'Deteniendo…';
    stop.disabled = true;
    row.classList.add('leaving');
  } else {
    if (server.containers) {
      const n = server.containers.length;
      stop.title = `Detiene ${n === 1 ? 'el contenedor' : `los ${n} contenedores`} de ${server.project}. Docker sigue funcionando.`;
    }
    stop.setAttribute('aria-label', `Detener ${server.project ?? server.framework}${mainPort === undefined ? '' : ` en el puerto ${mainPort}`}`);
    stop.addEventListener('click', () => stopServer(server.pid));
  }

  renderActions(row, server, mainPort);
  return row;
}

function renderActions(row: HTMLElement, server: DevServer, mainPort: number | undefined) {
  const more = row.querySelector('.more') as HTMLButtonElement;
  const bar = row.querySelector('.actions') as HTMLElement;
  const isOpen = openActions === server.pid;
  more.setAttribute('aria-expanded', String(isOpen));
  bar.hidden = !isOpen;
  more.addEventListener('click', () => {
    openActions = isOpen ? null : server.pid;
    render();
  });

  const button = (action: string) => bar.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
  const copy = button('copy');
  copy.hidden = mainPort === undefined;
  if (copied?.pid === server.pid) {
    copy.textContent = 'Copiada';
    copy.classList.add('done');
  }
  copy.addEventListener('click', async () => {
    if (mainPort === undefined) return;
    const result = await api.copyUrl(mainPort);
    if (!result.ok) return showRowError(server.pid, result.error);
    if (copied) window.clearTimeout(copied.timer);
    copied = { pid: server.pid, timer: window.setTimeout(() => ((copied = null), render()), 1500) };
    render();
  });

  // La fila única de Docker solo permite copiar la URL; sin carpeta conocida no hay editor ni carpeta.
  const local = !server.docker || !!server.containers;
  const editor = button('editor');
  const folder = button('folder');
  const restartBtn = button('restart');
  editor.hidden = folder.hidden = restartBtn.hidden = !local;
  editor.disabled = folder.disabled = !server.projectPath;
  if (!server.projectPath) editor.title = folder.title = 'No sé de qué carpeta es este servidor.';

  editor.addEventListener('click', () => runAction(server.pid, () => api.openEditor(server.pid)));
  folder.addEventListener('click', () => runAction(server.pid, () => api.openFolder(server.pid)));

  if (busy.get(server.pid) === 'restart') {
    restartBtn.textContent = 'Reiniciando…';
    restartBtn.disabled = true;
  }
  restartBtn.addEventListener('click', async () => {
    busy.set(server.pid, 'restart');
    render();
    await runAction(server.pid, () => api.restart(server.pid));
    busy.delete(server.pid);
    if (openActions === server.pid) openActions = null;
    render();
  });
}

function showRowError(pid: number, error = 'No se pudo completar la acción.') {
  // Si la fila ya desapareció (p. ej. tras reiniciar), el error va abajo del panel.
  if (current.servers.some((s) => s.pid === pid)) rowErrors.set(pid, error);
  else current = { ...current, error };
  render();
}

async function runAction(pid: number, action: () => Promise<{ ok: boolean; error?: string }>) {
  rowErrors.delete(pid);
  const result = await action();
  if (!result.ok) showRowError(pid, result.error);
}

function renderEmpty(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'empty';
  const title = document.createElement('strong');
  title.textContent = 'No hay servidores corriendo';
  const text = document.createElement('p');
  const example = document.createElement('code');
  example.textContent = 'npm run dev';
  text.append('Cuando arranques uno, por ejemplo con ', example, ', aparecerá aquí con su puerto.');
  box.append(title, text);
  return box;
}

function render() {
  const { servers } = current;
  list.replaceChildren(...(servers.length ? servers.map(renderRow) : [renderEmpty()]));

  count.textContent = servers.length === 0 ? '' : servers.length === 1 ? '1 activo' : `${servers.length} activos`;
  const killable = servers.filter((s) => !s.docker && !stopping.has(s.pid)).length;
  killAllBtn.hidden = killable < 2;

  errorBox.hidden = !current.error;
  errorBox.textContent = current.error ?? '';
}

async function stopServer(pid: number) {
  stopping.add(pid);
  rowErrors.delete(pid);
  render();
  const result = await api.kill(pid);
  stopping.delete(pid);
  if (!result.ok && result.error) rowErrors.set(pid, result.error);
  render();
}

function resetKillAll() {
  window.clearTimeout(confirmTimer);
  killAllBtn.classList.remove('confirm');
  killAllBtn.textContent = 'Apagar todos';
  killAllBtn.disabled = false;
}

killAllBtn.addEventListener('click', async () => {
  if (!killAllBtn.classList.contains('confirm')) {
    const n = current.servers.filter((s) => !s.docker).length;
    killAllBtn.classList.add('confirm');
    killAllBtn.textContent = `Sí, apagar los ${n}`;
    confirmTimer = window.setTimeout(resetKillAll, 4000);
    return;
  }
  window.clearTimeout(confirmTimer);
  killAllBtn.disabled = true;
  killAllBtn.textContent = 'Apagando…';
  current.servers.filter((s) => !s.docker).forEach((s) => stopping.add(s.pid));
  render();
  const result = await api.killAll();
  stopping.clear();
  resetKillAll();
  if (!result.ok) current = { ...current, error: result.error };
  render();
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  current = await api.list();
  render();
  refreshBtn.classList.remove('spinning');
});

api.onUpdate((result) => {
  current = result;
  // Olvida los errores de servidores que ya no existen.
  for (const pid of rowErrors.keys()) if (!result.servers.some((s) => s.pid === pid)) rowErrors.delete(pid);
  render();
});

api.list().then((result) => {
  current = result;
  render();
});
