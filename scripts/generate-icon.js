#!/usr/bin/env node
/**
 * Gera os ícones do aplicativo sem dependências externas.
 *
 *   node scripts/generate-icon.js
 *
 * Saídas:
 *   build/icon.png  (256x256)
 *   build/icon.ico  (container ICO com PNG 256x256, aceito pelo Windows/NSIS)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4; // supersampling para suavizar as bordas
const BIG = SIZE * SS;

// ── Cores ─────────────────────────────────────────────────────────────────────
const BG_TOP = [11, 18, 32];        // #0b1220
const BG_BOTTOM = [17, 28, 51];     // #111c33
const NEON = [34, 197, 94];         // #22c55e
const NEON_LIGHT = [134, 239, 172]; // #86efac
const RIM = [74, 222, 128];         // #4ade80

// ── Formas (coordenadas em 256x256) ──────────────────────────────────────────
function insideRoundedRect(x, y, left, top, right, bottom, r) {
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insidePawn(x, y) {
  // Cabeça
  const hx = x - 128;
  const hy = y - 92;
  if (hx * hx + hy * hy <= 27 * 27) return true;

  // Corpo (cone suave entre o pescoço e a base)
  if (y >= 110 && y <= 172) {
    const t = (y - 110) / 62;
    const halfWidth = 13 + t * 21;
    if (Math.abs(x - 128) <= halfWidth) return true;
  }

  // Base arredondada
  if (insideRoundedRect(x, y, 70, 168, 186, 196, 12)) return true;

  return false;
}

function insidePawnGlow(x, y) {
  // Versão expandida usada para o brilho neon
  const hx = x - 128;
  const hy = y - 92;
  if (hx * hx + hy * hy <= 33 * 33) return true;
  if (y >= 104 && y <= 176) {
    const t = (y - 104) / 72;
    const halfWidth = 18 + t * 24;
    if (Math.abs(x - 128) <= halfWidth) return true;
  }
  return insideRoundedRect(x, y, 64, 162, 192, 200, 16);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Render em alta resolução ─────────────────────────────────────────────────
const big = Buffer.alloc(BIG * BIG * 4);

for (let py = 0; py < BIG; py++) {
  const y = (py + 0.5) / SS;
  for (let px = 0; px < BIG; px++) {
    const x = (px + 0.5) / SS;
    const i = (py * BIG + px) * 4;

    // Fundo: cartão arredondado com gradiente vertical
    if (!insideRoundedRect(x, y, 6, 6, 250, 250, 54)) {
      continue; // transparente fora do cartão
    }

    const [br, bg, bb] = mix(BG_TOP, BG_BOTTOM, clamp01((y - 6) / 244));
    let r = br;
    let g = bg;
    let b = bb;

    // Brilho neon ao redor do peão
    if (insidePawnGlow(x, y)) {
      const glow = insidePawn(x, y) ? 0.18 : 0.34;
      r = Math.round(r + (NEON[0] - r) * glow);
      g = Math.round(g + (NEON[1] - g) * glow);
      b = Math.round(b + (NEON[2] - b) * glow);
    }

    // Peão com gradiente claro -> neon
    if (insidePawn(x, y)) {
      const t = clamp01((y - 65) / 130);
      [r, g, b] = mix(NEON_LIGHT, NEON, t);
      // Aresta mais escura na base dá profundidade
      if (y > 168) {
        r = Math.round(r * 0.86);
        g = Math.round(g * 0.9);
        b = Math.round(b * 0.86);
      }
    }

    // Aro fino neon na borda do cartão
    const edge = !insideRoundedRect(x, y, 10, 10, 246, 246, 50)
      && insideRoundedRect(x, y, 6, 6, 250, 250, 54);
    if (edge) {
      r = Math.round(r + (RIM[0] - r) * 0.35);
      g = Math.round(g + (RIM[1] - g) * 0.35);
      b = Math.round(b + (RIM[2] - b) * 0.35);
    }

    big[i] = r;
    big[i + 1] = g;
    big[i + 2] = b;
    big[i + 3] = 255;
  }
}

// Downsample box filter (SS x SS)
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * BIG + (x * SS + sx)) * 4;
        const alpha = big[i + 3] / 255;
        r += big[i] * alpha;
        g += big[i + 1] * alpha;
        b += big[i + 2] * alpha;
        a += big[i + 3];
      }
    }
    const total = SS * SS;
    const aAvg = a / total;
    const o = (y * SIZE + x) * 4;
    if (aAvg > 0) {
      const weight = a / 255;
      rgba[o] = Math.round(r / weight);
      rgba[o + 1] = Math.round(g / weight);
      rgba[o + 2] = Math.round(b / weight);
    }
    rgba[o + 3] = Math.round(aAvg);
  }
}

// ── Encoder PNG mínimo (RGBA 8-bit) ──────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = encodePng(SIZE, SIZE, rgba);

// ── Container ICO (entrada única 256x256 com payload PNG) ────────────────────
function encodeIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: ícone
  header.writeUInt16LE(1, 4); // quantidade de imagens

  const entry = Buffer.alloc(16);
  entry[0] = 0; // largura 0 => 256
  entry[1] = 0; // altura 0 => 256
  entry[2] = 0; // paleta
  entry[3] = 0; // reservado
  entry.writeUInt16LE(1, 4);  // planos
  entry.writeUInt16LE(32, 6); // bits por pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12); // offset após header + entrada

  return Buffer.concat([header, entry, pngBuffer]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png));

// Ícone da bandeja/janela reutiliza o PNG maior disponível
console.log(`[icon] build/icon.png (${png.length} bytes)`);
console.log('[icon] build/icon.ico gerado');
