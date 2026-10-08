import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionResult, DevServer, KillResult, ScanResult } from '../shared/types';
import { openInEditor, restart } from './actions';
import { restartContainers, stopContainers } from './docker';
import { kill } from './killer';
import { formatHours, processScan } from './notifier';
import { scan, type ProcInfo } from './scanner';
import { loadSettings, saveSettings, type Settings } from './settings';

const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 520;
const VISIBLE_INTERVAL = 5_000;
const BACKGROUND_INTERVAL = 30_000;
const SHORTCUT = 'Control+Alt+P';
const FORGOTTEN_OPTIONS = [1, 2, 3, 6];

const assetsDir = path.join(__dirname, '../../assets');

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let lastResult: ScanResult = { servers: [], scannedAt: 0 };
let lastProcs = new Map<number, ProcInfo>();
let scanning: Promise<ScanResult> | null = null;
let timer: NodeJS.Timeout | null = null;
let hiddenAt = 0;
let settings: Settings;
let shortcutOk = false;

const icons = {
  idle: nativeImage.createFromPath(path.join(assetsDir, 'tray.png')),
  active: nativeImage.createFromPath(path.join(assetsDir, 'tray-active.png')),
};

function refresh(): Promise<ScanResult> {
  // Una sola búsqueda a la vez; las llamadas que lleguen mientras tanto reciben el mismo resultado.
  scanning ??= scan()
    .then(({ result, procs }) => {
      processScan(result, settings, showPanel);
      lastResult = result;
      lastProcs = procs;
      return result;
    })
    .catch((err: Error): ScanResult => ({ ...lastResult, error: `No se pudo revisar los puertos: ${err.message}` }))
    .then((result) => {
      updateTray(result);
      win?.webContents.send('servers:update', result);
      return result;
    })
    .finally(() => {
      scanning = null;
    });
  return scanning;
}

function updateTray(result: ScanResult) {
  if (!tray) return;
  const n = result.servers.length;
  tray.setImage(n > 0 ? icons.active : icons.idle);
  tray.setToolTip(n === 0 ? 'Sin servidores activos' : n === 1 ? '1 servidor activo' : `${n} servidores activos`);
}

function schedule() {
  if (timer) clearInterval(timer);
  const visible = win?.isVisible() ?? false;
  timer = setInterval(refresh, visible ? VISIBLE_INTERVAL : BACKGROUND_INTERVAL);
}

function createWindow() {
  win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#1B1F27',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('blur', hidePanel);
  win.on('show', schedule);
  win.on('hide', schedule);
}

function hidePanel() {
  if (!win?.isVisible()) return;
  win.hide();
  hiddenAt = Date.now();
}

/** Coloca el panel junto al icono, del lado donde esté la barra de tareas. */
function positionPanel() {
  if (!win || !tray) return;
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  const gap = 8;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - PANEL_WIDTH / 2);
  let y = trayBounds.y > area.y + area.height / 2 ? area.y + area.height - PANEL_HEIGHT - gap : area.y + gap;
  // Barra de tareas a la izquierda o derecha.
  if (trayBounds.x < area.x) x = area.x + gap;
  if (trayBounds.x >= area.x + area.width) x = area.x + area.width - PANEL_WIDTH - gap;
  x = Math.min(Math.max(x, area.x + gap), area.x + area.width - PANEL_WIDTH - gap);
  y = Math.min(Math.max(y, area.y + gap), area.y + area.height - PANEL_HEIGHT - gap);
  win.setPosition(x, y);
}

function showPanel() {
  if (!win) return;
  positionPanel();
  win.show();
  win.focus();
  refresh();
}

/** Clic en el icono de la bandeja. */
function togglePanel() {
  if (!win) return;
  if (win.isVisible()) return hidePanel();
  // El clic en el icono quita el foco al panel y lo oculta justo antes de este evento: no lo reabrimos.
  if (Date.now() - hiddenAt < 250) return;
  showPanel();
}

/** Atajo de teclado: no pasa por el clic del icono, así que no necesita la espera de togglePanel. */
function toggleFromShortcut() {
  if (win?.isVisible()) hidePanel();
  else showPanel();
}

function updateSettings(change: Partial<Settings>) {
  settings = { ...settings, ...change };
  saveSettings(settings);
  void refresh();
}

function loginItemOptions() {
  // En desarrollo Electron necesita la ruta de la app como argumento.
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(app.getAppPath())] };
}

function showMenu() {
  const openAtLogin = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir panel', click: showPanel },
    { label: 'Refrescar', click: () => void refresh() },
    { type: 'separator' },
    {
      label: 'Avisar si un servidor lleva más de',
      submenu: [
        ...FORGOTTEN_OPTIONS.map((h) => ({
          label: formatHours(h),
          type: 'radio' as const,
          checked: settings.forgottenHours === h,
          click: () => updateSettings({ forgottenHours: h }),
        })),
        {
          label: 'Nunca',
          type: 'radio' as const,
          checked: settings.forgottenHours === 0,
          click: () => updateSettings({ forgottenHours: 0 }),
        },
      ],
    },
    {
      label: 'Avisar cuando arranque un servidor',
      type: 'checkbox',
      checked: settings.notifyNew,
      click: (item) => updateSettings({ notifyNew: item.checked }),
    },
    {
      label: shortcutOk ? 'Atajo: Ctrl+Alt+P' : 'Atajo Ctrl+Alt+P ocupado por otra app',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Iniciar con Windows',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() },
  ]);
  tray?.popUpContextMenu(menu);
}

async function killOne(pid: number): Promise<KillResult> {
  const server = lastResult.servers.find((s) => s.pid === pid);
  if (!server) return { ok: false, error: 'Ese servidor ya no está en la lista.' };
  const result = server.docker ? await stopContainers(server) : await kill(pid, lastProcs);
  await refresh();
  return result;
}

/** Docker queda fuera a propósito: suelen ser bases de datos y es mejor apagarlas una por una. */
async function killAll(): Promise<KillResult> {
  const targets = lastResult.servers.filter((s) => !s.docker);
  const results = await Promise.all(targets.map((s) => kill(s.pid, lastProcs)));
  await refresh();
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { ok: true };
  return { ok: false, error: failed.length === 1 ? failed[0].error : `${failed.length} servidores no se pudieron detener. ${failed[0].error ?? ''}` };
}

/** Busca el servidor por PID en la última lista; las acciones solo actúan sobre lo que el panel está mostrando. */
function findServer(pid: unknown): DevServer | ActionResult {
  const server = Number.isInteger(pid) ? lastResult.servers.find((s) => s.pid === pid) : undefined;
  if (!server) return { ok: false, error: 'Ese servidor ya no está en la lista.' };
  if (server.docker && !server.containers) return { ok: false, error: 'Esta acción no está disponible para Docker.' };
  return server;
}

const isServer = (v: DevServer | ActionResult): v is DevServer => 'pid' in v;

async function openFolder(pid: unknown): Promise<ActionResult> {
  const server = findServer(pid);
  if (!isServer(server)) return server;
  if (!server.projectPath) return { ok: false, error: 'No sé de qué carpeta es este servidor.' };
  const error = await shell.openPath(server.projectPath);
  return error ? { ok: false, error } : { ok: true };
}

async function openEditor(pid: unknown): Promise<ActionResult> {
  const server = findServer(pid);
  if (!isServer(server)) return server;
  if (!server.projectPath) return { ok: false, error: 'No sé de qué carpeta es este servidor.' };
  return openInEditor(server.projectPath);
}

async function restartOne(pid: unknown): Promise<ActionResult> {
  const server = findServer(pid);
  if (!isServer(server)) return server;
  const result = server.docker ? await restartContainers(server) : await restart(server, lastProcs);
  // El servidor nuevo tarda unos segundos en abrir su puerto.
  setTimeout(() => void refresh(), 3_000);
  await refresh();
  return result;
}

const isPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536;

function registerIpc() {
  ipcMain.handle('servers:list', () => refresh());
  ipcMain.handle('servers:kill', (_e, pid: unknown) =>
    Number.isInteger(pid) ? killOne(pid as number) : { ok: false, error: 'PID inválido.' },
  );
  ipcMain.handle('servers:killAll', () => killAll());
  ipcMain.handle('servers:open', (_e, port: unknown) => {
    if (isPort(port)) return shell.openExternal(`http://localhost:${port}`);
  });
  ipcMain.handle('servers:copyUrl', (_e, port: unknown): ActionResult => {
    if (!isPort(port)) return { ok: false, error: 'Puerto inválido.' };
    clipboard.writeText(`http://localhost:${port}`);
    return { ok: true };
  });
  ipcMain.handle('servers:openFolder', (_e, pid: unknown) => openFolder(pid));
  ipcMain.handle('servers:openEditor', (_e, pid: unknown) => openEditor(pid));
  ipcMain.handle('servers:restart', (_e, pid: unknown) => restartOne(pid));
}

/** Solo para desarrollo: LSK_SCREENSHOT=ruta.png guarda una captura del panel sin tener que abrirlo desde la bandeja. */
function captureForReview(file: string) {
  win?.webContents.once('did-finish-load', async () => {
    await refresh();
    win!.showInactive();
    // Dos búsquedas para que aparezca la CPU, y la barra de acciones del primer servidor abierta.
    await new Promise((r) => setTimeout(r, 6_000));
    await win!.webContents.executeJavaScript(`document.querySelector('.row:not(:has(.stop:disabled)) .more')?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    const image = await win!.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    fs.writeFileSync(`${file}.txt`, `icono idle vacío: ${icons.idle.isEmpty()}\nicono activo vacío: ${icons.active.isEmpty()}\n`);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', togglePanel);
  // La app vive en la bandeja: cerrar o esconder el panel no la termina.
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.davidhielo.localserverkill');
    settings = loadSettings();
    shortcutOk = globalShortcut.register(SHORTCUT, toggleFromShortcut);
    tray = new Tray(icons.idle);
    tray.setToolTip('Buscando servidores…');
    tray.on('click', togglePanel);
    tray.on('right-click', showMenu);
    registerIpc();
    createWindow();
    refresh();
    schedule();
    if (process.env.LSK_SCREENSHOT) captureForReview(process.env.LSK_SCREENSHOT);
  });
}
