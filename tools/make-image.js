'use strict';

/* =========================================================================
 * 测试/演示素材生成：PNG 图片与 WAV 音频（纯 Node.js，无第三方依赖）
 * ========================================================================= */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/**
 * 生成 PNG 图片
 * @param {number} w 宽
 * @param {number} h 高
 * @param {[number,number,number]} from 起始 RGB
 * @param {[number,number,number]} [to] 结束 RGB（提供则生成对角渐变）
 */
function makePng(w, h, from, to) {
  const a = from || [120, 100, 220];
  const b = to || a;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const t = (x / Math.max(1, w - 1) + y / Math.max(1, h - 1)) / 2;
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.round(a[0] + (b[0] - a[0]) * t);
      raw[o + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
      raw[o + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 生成 8kHz 单声道 16bit PCM WAV（440Hz 正弦波） */
function makeWav(seconds, rate) {
  rate = rate || 8000;
  const n = Math.floor((seconds || 15) * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(2500 * Math.sin(i * 2 * Math.PI * 440 / rate)), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);   // PCM
  hdr.writeUInt16LE(1, 22);   // mono
  hdr.writeUInt32LE(rate, 24);
  hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

module.exports = { makePng, makeWav, crc32 };
