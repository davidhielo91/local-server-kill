// Prueba a qué proceso apunta "Detener" con árboles de procesos reales de Windows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { isSameProcess, kill, killTarget } from '../dist/main/killer.js';

const NODE = '"C:\\Program Files\\nodejs\\node.exe"';
const NPM = `${NODE} "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev`;

/** Arma la lista de procesos. Cada uno: [pid, ppid, nombre, comando, segundo en que arrancó]. */
function tree(rows) {
  return new Map(rows.map(([pid, ppid, name, cmd, t]) => [pid, { pid, ppid, name, exe: null, cmd, started: t * 1000, ws: 0, cpu: 0 }]));
}

/** El servidor tal como lo mostraría el panel. */
const server = (procs, pid) => ({ pid, startedAt: procs.get(pid).started, commandLine: procs.get(pid).cmd });

test('npm run dev: sube hasta npm para no dejar la terminal colgada', () => {
  const procs = tree([
    [1, 0, 'pwsh', 'pwsh.exe', 1],
    [2, 1, 'node', NPM, 2],
    [3, 2, 'cmd', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite', 3],
    [4, 3, 'node', `${NODE} C:\\web\\node_modules\\vite\\bin\\vite.js`, 4],
  ]);
  assert.equal(killTarget(server(procs, 4), procs, [4]), 2);
});

test('next dev: el puerto lo tiene un worker; se sube a "next dev" y a npm', () => {
  const procs = tree([
    [1, 0, 'pwsh', 'pwsh.exe', 1],
    [2, 1, 'node', NPM, 2],
    [3, 2, 'cmd', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c next dev', 3],
    [4, 3, 'node', `${NODE} "C:\\tienda\\node_modules\\.bin\\..\\next\\dist\\bin\\next" dev`, 4],
    [5, 4, 'node', `${NODE} C:\\tienda\\node_modules\\next\\dist\\server\\lib\\start-server.js`, 5],
  ]);
  assert.equal(killTarget(server(procs, 5), procs, [5]), 2);
});

test('next dev en un workspace de pnpm: el worker vive en node_modules\\.pnpm de la raíz, igual se sube', () => {
  const procs = tree([
    [1, 0, 'pwsh', 'pwsh.exe', 1],
    [2, 1, 'node', `${NODE} "C:\\Users\\yo\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" dev`, 2],
    [3, 2, 'cmd', 'cmd.exe /d /s /c next dev', 3],
    [4, 3, 'node', `${NODE} "C:\\mono\\apps\\web\\node_modules\\.bin\\..\\next\\dist\\bin\\next" dev`, 4],
    [5, 4, 'node', `${NODE} C:\\mono\\node_modules\\.pnpm\\next@16.4.5\\node_modules\\next\\dist\\server\\lib\\start-server.js`, 5],
  ]);
  assert.equal(killTarget(server(procs, 5), procs, [5]), 2);
});

test('next dev de otro proyecto no cuenta como lanzador de este servidor', () => {
  const procs = tree([
    [4, 1, 'node', `${NODE} "C:\\otro\\node_modules\\next\\dist\\bin\\next" dev`, 4],
    [5, 4, 'node', `${NODE} C:\\tienda\\server.js`, 5],
  ]);
  assert.equal(killTarget(server(procs, 5), procs), 5);
});

test('pnpm -r --parallel dev: no sube a pnpm, que tiene debajo a otro proceso con puertos', () => {
  const procs = tree([
    [1, 0, 'pwsh', 'pwsh.exe', 1],
    [2, 1, 'node', `${NODE} "C:\\Users\\yo\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" -r --parallel dev`, 2],
    [3, 2, 'cmd', 'cmd.exe /d /s /c vite', 3],
    [4, 3, 'node', `${NODE} C:\\mono\\apps\\web\\node_modules\\vite\\bin\\vite.js`, 4],
    [5, 2, 'cmd', 'cmd.exe /d /s /c vite', 3],
    [6, 5, 'node', `${NODE} C:\\mono\\apps\\api\\node_modules\\vite\\bin\\vite.js`, 4],
  ]);
  assert.equal(killTarget(server(procs, 4), procs, [4, 6]), 3);
  // Aunque los otros paquetes no tengan puertos (un tsc -w), pnpm -r es un orquestador: no se sube a él.
  assert.equal(killTarget(server(procs, 4), procs, [4]), 3);
});

test('pnpm dev de un solo paquete (también vía corepack) sí es un envoltorio', () => {
  for (const pnpm of [
    `${NODE} "C:\\Users\\yo\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" dev`,
    `${NODE} "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js" dev`,
  ]) {
    const procs = tree([
      [1, 0, 'pwsh', 'pwsh.exe', 1],
      [2, 1, 'node', pnpm, 2],
      [3, 2, 'cmd', 'cmd.exe /d /s /c vite', 3],
      [4, 3, 'node', `${NODE} C:\\web\\node_modules\\vite\\bin\\vite.js`, 4],
    ]);
    assert.equal(killTarget(server(procs, 4), procs, [4]), 2, pnpm);
  }
});

test('un CLI instalado con pnpm add -g, o una carpeta llamada "pnpm-…", no cuenta como envoltorio', () => {
  for (const cli of [
    `${NODE} C:\\Users\\yo\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
    `${NODE} C:\\proyectos\\pnpm-demo\\supervisor.js`,
    `${NODE} C:\\proyectos\\yarn\\tools\\runner.js`,
  ]) {
    const procs = tree([
      [2, 1, 'node', cli, 2],
      [3, 2, 'cmd', 'cmd.exe /d /s /c "node server.js"', 3],
      [4, 3, 'node', `${NODE} server.js`, 4],
    ]);
    assert.equal(killTarget(server(procs, 4), procs, [4]), 3, cli);
  }
});

test('nodemon / ts-node-dev con -r (instalados con pnpm o yarn berry) siguen siendo envoltorios, no orquestadores', () => {
  for (const tool of [
    `${NODE} C:\\api\\node_modules\\.pnpm\\nodemon@3.1.0\\node_modules\\nodemon\\bin\\nodemon.js -r dotenv/config src/index.js`,
    `${NODE} C:\\api\\node_modules\\.pnpm\\ts-node-dev@2.0.0\\node_modules\\ts-node-dev\\lib\\bin.js -r tsconfig-paths/register src/index.ts`,
    `${NODE} C:\\api\\.yarn\\unplugged\\nodemon-npm-3.1.0\\node_modules\\nodemon\\bin\\nodemon.js -r dotenv/config src/index.js`,
  ]) {
    const procs = tree([
      [1, 0, 'pwsh', 'pwsh.exe', 1],
      [2, 1, 'node', NPM, 2],
      [3, 2, 'cmd', 'cmd.exe /d /s /c nodemon', 3],
      [4, 3, 'node', tool, 4],
      [5, 4, 'node', `${NODE} C:\\api\\src\\index.js`, 5],
    ]);
    assert.equal(killTarget(server(procs, 5), procs, [5]), 2, tool);
  }
});

test('un .bat que lanzó varias cosas: no se sube a él si tiene otro hijo vivo (tailwind -w)', () => {
  const procs = tree([
    [1, 0, 'explorer', 'explorer.exe', 1],
    [2, 1, 'cmd', 'cmd.exe /c ""C:\\web\\dev.bat" "', 2],
    [3, 2, 'conhost', 'conhost.exe 0xffffffff -ForceV1', 2],
    [4, 2, 'node', `${NODE} C:\\web\\node_modules\\tailwindcss\\lib\\cli.js -w`, 3],
    [5, 2, 'node', NPM, 4],
    [6, 5, 'cmd', 'cmd.exe /d /s /c vite', 5],
    [7, 6, 'node', `${NODE} C:\\web\\node_modules\\vite\\bin\\vite.js`, 6],
  ]);
  // Sube hasta npm, pero no al cmd del .bat (que tiene a tailwind debajo).
  assert.equal(killTarget(server(procs, 7), procs, [7]), 5);
});

test('un hijo del propio servidor con puerto (HMR, worker) no impide subir a npm', () => {
  const procs = tree([
    [1, 0, 'pwsh', 'pwsh.exe', 1],
    [2, 1, 'node', NPM, 2],
    [3, 2, 'cmd', 'cmd.exe /d /s /c next dev', 3],
    [4, 3, 'node', `${NODE} "C:\\tienda\\node_modules\\next\\dist\\bin\\next" dev`, 4],
    [5, 4, 'node', `${NODE} C:\\tienda\\node_modules\\next\\dist\\server\\lib\\start-server.js`, 5],
    [6, 5, 'node', `${NODE} C:\\tienda\\node_modules\\next\\dist\\compiled\\jest-worker\\processChild.js`, 6],
  ]);
  assert.equal(killTarget(server(procs, 5), procs, [5, 6]), 2);
});

test('concurrently: nunca se sube a él', () => {
  const procs = tree([
    [1, 0, 'pwsh', 'pwsh.exe', 1],
    [2, 1, 'node', NPM, 2],
    [3, 2, 'cmd', 'cmd.exe /d /s /c concurrently "vite" "tsc -w"', 3],
    [4, 3, 'node', `${NODE} C:\\app\\node_modules\\concurrently\\dist\\bin\\concurrently.js vite "tsc -w"`, 4],
    [5, 4, 'cmd', 'cmd.exe /d /s /c vite', 5],
    [6, 5, 'node', `${NODE} C:\\app\\node_modules\\vite\\bin\\vite.js`, 6],
  ]);
  assert.equal(killTarget(server(procs, 6), procs, [6]), 5);
});

test('PID reciclado: un "padre" que arrancó después que el servidor no es su padre', () => {
  const procs = tree([
    // El cmd /c que lanzó al servidor ya terminó y Windows le dio su PID a otro cmd /c, más nuevo.
    [3, 1, 'cmd', 'cmd.exe /d /c npm run test:watch', 50],
    [4, 3, 'node', `${NODE} C:\\web\\server.js`, 10],
  ]);
  assert.equal(killTarget(server(procs, 4), procs), 4);
});

test('una herramienta node que lanzó al servidor no se mata, aunque Node esté fuera de Program Files (nvm4w)', () => {
  const nvm = 'C:\\nvm4w\\nodejs\\node.exe';
  const procs = tree([
    [2, 1, 'node', `${nvm} C:\\nvm4w\\nodejs\\node_modules\\some-agent\\cli.js`, 2],
    [3, 2, 'node', `${nvm} server.js`, 3],
    [5, 1, 'node', `${nvm} C:\\web\\node_modules\\@playwright\\test\\cli.js test --ui`, 5],
    [6, 5, 'node', `${nvm} C:\\web\\node_modules\\vite\\bin\\vite.js`, 6],
  ]);
  assert.equal(killTarget(server(procs, 3), procs), 3);
  assert.equal(killTarget(server(procs, 6), procs), 6);
});

test('un script de Python que lanzó al servidor no se mata (Python fuera de Program Files)', () => {
  const procs = tree([
    [2, 1, 'python', 'C:\\Python312\\python.exe bot.py', 2],
    [3, 2, 'python', 'C:\\Python312\\python.exe -m http.server 8000', 3],
  ]);
  assert.equal(killTarget(server(procs, 3), procs), 3);
});

test('isSameProcess: detecta que el PID ya es de otro proceso', () => {
  const before = tree([[4, 1, 'node', `${NODE} C:\\web\\server.js`, 10]]);
  const shown = server(before, 4);
  assert.equal(isSameProcess(shown, before), true);
  assert.equal(isSameProcess(shown, tree([[4, 1, 'code', 'Code.exe', 40]])), false);
  assert.equal(isSameProcess(shown, new Map()), false);
});

test('kill no toca un proceso vivo que heredó el PID del servidor', async () => {
  // Un proceso real: si kill lo matara por error, el test lo notaría.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const procs = tree([[child.pid, 1, 'node', 'node.exe otro-proceso.js', 99]]);
    // El panel mostraba otro proceso con ese PID: arrancó en otro momento y con otro comando.
    const shown = { pid: child.pid, startedAt: 10_000, commandLine: `${NODE} C:\\web\\server.js` };
    assert.deepEqual(await kill(shown, procs, []), { ok: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(child.exitCode, null, 'el proceso ajeno no debió morir');
    assert.equal(child.signalCode, null);
  } finally {
    child.kill();
  }
});
