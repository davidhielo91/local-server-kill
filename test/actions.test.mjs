// Prueba el entorno de la terminal que abre "Reiniciar".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { launchEnv } from '../dist/main/actions.js';

test('Reiniciar pone node_modules\\.bin al inicio del PATH, sin duplicar la variable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsk-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    const env = launchEnv('cmd /d /s /c vite', dir);
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    assert.equal(keys.length, 1);
    assert.ok(env[keys[0]].startsWith(path.join(dir, 'node_modules', '.bin') + ';'));
    assert.equal(env.LSK_CMD, 'cmd /d /s /c vite');
    assert.equal(env.LSK_CWD, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sin node_modules\\.bin no toca el PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsk-test-'));
  try {
    const env = launchEnv('python -m http.server', dir);
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    assert.equal(env[key], process.env[key]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
