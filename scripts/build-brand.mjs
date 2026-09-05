import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = fileURLToPath(new URL('../', import.meta.url));
function exportPng(source, destination, width, height = width, background = null) {
  const data = readFileSync(root + source).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ''}<image href="data:image/png;base64,${data}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  mkdirSync(dirname(root + destination), { recursive: true });
  writeFileSync(root + destination, new Resvg(svg).render().asPng());
}

const icon = 'assets/brand/life-rings-icon.png';
exportPng(icon, 'assets/logos/infovore.png', 512);
exportPng(icon, 'assets/brand/favicon.png', 32);
exportPng(icon, 'assets/brand/apple-touch-icon.png', 180, 180, '#F4F1EB');
exportPng('assets/brand/life-rings-social.png', 'assets/og.png', 1200, 630);
for (const size of [16, 32, 48, 128]) {
  exportPng(icon, `chrome-extension/icons/icon-${size}.png`, size);
}
exportPng(icon, 'android/app/src/main/res/drawable-nodpi/infovore_logo.png', 512);
