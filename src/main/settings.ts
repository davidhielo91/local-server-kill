import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface Settings {
  /** Horas tras las que un servidor se considera olvidado; 0 = no avisar. */
  forgottenHours: number;
  /** Avisar cuando arranca un servidor nuevo. */
  notifyNew: boolean;
}

const DEFAULTS: Settings = { forgottenHours: 3, notifyNew: true };

const file = () => path.join(app.getPath('userData'), 'settings.json');

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return {
      forgottenHours: typeof raw.forgottenHours === 'number' && raw.forgottenHours >= 0 ? raw.forgottenHours : DEFAULTS.forgottenHours,
      notifyNew: typeof raw.notifyNew === 'boolean' ? raw.notifyNew : DEFAULTS.notifyNew,
    };
  } catch {
    // No existe o está dañado: se usan los valores por defecto.
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(settings, null, 2));
}
