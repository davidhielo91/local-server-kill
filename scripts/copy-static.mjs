import { cpSync } from 'node:fs';
for (const f of ['index.html', 'styles.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
