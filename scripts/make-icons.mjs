// Genera los iconos PNG (bandeja y app) sin dependencias externas.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const png = (size, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Anillo (un "conector") con un punto al centro. Antialias por distancia.
function draw(size, { ring, dot, bg }) {
  const out = Buffer.alloc(size * size * 4);
  const s = size / 16;
  const c = size / 2;
  const R = 6 * s, T = 1.9 * s, D = 2.3 * s;
  const radius = 3.5 * s;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x + 0.5 - c, py = y + 0.5 - c;
    const r = Math.hypot(px, py);
    let col = [0, 0, 0], a = 0;
    if (bg) {
      const qx = Math.max(Math.abs(px) - (c - radius), 0), qy = Math.max(Math.abs(py) - (c - radius), 0);
      const d = Math.hypot(qx, qy) - radius;
      const ba = Math.min(Math.max(0.5 - d, 0), 1);
      col = hex(bg); a = ba;
    }
    const layer = (rgb, cov) => {
      cov = Math.min(Math.max(cov, 0), 1);
      if (!cov) return;
      const na = cov + a * (1 - cov);
      col = col.map((v, i) => (rgb[i] * cov + v * a * (1 - cov)) / na);
      a = na;
    };
    layer(hex(ring), 0.5 - (Math.abs(r - R) - T / 2) / 1);
    layer(hex(dot), 0.5 - (r - D));
    const o = (y * size + x) * 4;
    out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = Math.round(a * 255);
  }
  return png(size, out);
}

mkdirSync('assets', { recursive: true });
const idle = { ring: '#9AA3B2', dot: '#9AA3B2' };
const active = { ring: '#F2B33D', dot: '#F2B33D' };
for (const [name, cfg] of [['tray', idle], ['tray-active', active]]) {
  writeFileSync(`assets/${name}.png`, draw(16, cfg));
  writeFileSync(`assets/${name}@2x.png`, draw(32, cfg));
}
writeFileSync('assets/icon.png', draw(256, { ...active, bg: '#1B1F27' }));
console.log('Iconos generados en assets/');
