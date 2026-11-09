// Prueba cómo se encuentran y confirman los puertos en escucha cuando Windows reporta mal la tabla de conexiones.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { accepts, ListenerConfirmer, parseCim, parseNetstat, probeHosts } from '../dist/main/listeners.js';

test('netstat: toma las filas con puerto remoto 0, sin importar el idioma del estado', () => {
  const out = [
    '  Proto  Dirección local          Dirección remota        Estado           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              ESCUCHANDO       100',
    '  TCP    [::1]:5173             [::]:0                 LISTENING        200',
    '  TCP    [::1]:3000             [::1]:60470            ESTABLISHED      100',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(out), [
    { pid: 100, port: 3000, address: '0.0.0.0' },
    { pid: 200, port: 5173, address: '[::1]' },
  ]);
});

test('WMI: una fila o varias, y las direcciones IPv6 con el mismo formato que netstat', () => {
  assert.deepEqual(parseCim('{"address":"::1","port":5173,"pid":200}'), [{ pid: 200, port: 5173, address: '[::1]' }]);
  assert.deepEqual(parseCim('[{"address":"::","port":3000,"pid":1},{"address":"0.0.0.0","port":3123,"pid":2}]'), [
    { pid: 1, port: 3000, address: '[::]' },
    { pid: 2, port: 3123, address: '0.0.0.0' },
  ]);
  assert.deepEqual(parseCim(''), []);
});

test('a qué dirección conectarse según dónde escucha', () => {
  assert.deepEqual(probeHosts('0.0.0.0'), ['127.0.0.1']);
  assert.deepEqual(probeHosts('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(probeHosts('[::]'), ['::1', '127.0.0.1']);
  assert.deepEqual(probeHosts('[::1]'), ['::1']);
  assert.deepEqual(probeHosts('192.168.1.20'), ['192.168.1.20']);
});

test('accepts: true con un servidor real, false cuando el puerto está cerrado', async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await accepts('127.0.0.1', port), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(await accepts('127.0.0.1', port), false);
});

test('ListenerConfirmer: descarta filas falsas y no vuelve a probar un puerto ya confirmado', async () => {
  const probed = [];
  const open = new Set([3000, 5173]);
  const confirmer = new ListenerConfirmer(async (l) => (probed.push(l.port), open.has(l.port)));
  const id = (pid) => `${pid}:t`;
  const rows = [
    { pid: 1, port: 3000, address: '[::]' },
    { pid: 1, port: 3000, address: '0.0.0.0' },
    { pid: 2, port: 5173, address: '[::1]' },
    { pid: 3, port: 64640, address: '0.0.0.0' }, // fila basura: nadie escucha ahí
  ];
  const first = await confirmer.confirm(rows, id);
  assert.deepEqual(first.map((l) => l.port), [3000, 3000, 5173]);
  assert.deepEqual(probed.sort(), [3000, 5173, 64640]);

  probed.length = 0;
  await confirmer.confirm(rows, id);
  assert.deepEqual(probed, [64640], 'solo se vuelve a probar lo que no se confirmó');

  // Si un puerto deja de aparecer y luego vuelve, se prueba otra vez.
  await confirmer.confirm(rows.filter((l) => l.port !== 5173), id);
  probed.length = 0;
  await confirmer.confirm(rows, id);
  assert.ok(probed.includes(5173));
});

test('ListenerConfirmer: un PID reciclado (otro proceso) se vuelve a probar', async () => {
  const probed = [];
  const confirmer = new ListenerConfirmer(async (l) => (probed.push(l.port), true));
  const row = [{ pid: 7, port: 8000, address: '127.0.0.1' }];
  await confirmer.confirm(row, () => '7:100');
  await confirmer.confirm(row, () => '7:200');
  assert.deepEqual(probed, [8000, 8000]);
});
