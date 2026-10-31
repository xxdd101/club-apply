'use strict';

/* =========================================================================
 * 音频时长探测（服务端校验 CV 部录音 ≥15 秒）
 *  - WAV：解析 fmt/data 块，精确计算
 *  - MP3：跳过 ID3v2，逐帧累加采样数，估算时长
 * 无法解析时返回 ok:false，由调用方决定是否放行（避免误伤）
 * ========================================================================= */

const MPEG_VERSIONS = { 0: '2.5', 2: '2', 3: '1' };
const BITRATES = {
  // [version][layer] -> kbps 表，index 0 表示 free，15 表示 invalid
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const SAMPLE_RATES = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };

function wavDuration(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let off = 12, byteRate = 0, dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === 'data') {
      dataSize = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

function mp3Duration(buf) {
  let off = 0;
  // 跳过 ID3v2
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }
  let samples = 0, sampleRate = 0, frames = 0;
  const limit = Math.min(buf.length - 4, off + 60 * 1024 * 1024);
  for (let i = off; i < limit; i++) {
    if (buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) continue;
    const b1 = buf[i + 1], b2 = buf[i + 2], b3 = buf[i + 3];
    const verBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    if (verBits === 1 || layerBits === 0) continue;          // reserved
    const version = MPEG_VERSIONS[verBits];
    const layer = 4 - layerBits;                              // 1/2/3
    const brIndex = (b2 >> 4) & 0x0F;
    const srIndex = (b2 >> 2) & 0x03;
    if (brIndex === 0 || brIndex === 15 || srIndex === 3) continue;
    const key = (version === '1' ? '1' : '2') + '-' + layer;
    const bitrate = BITRATES[key][brIndex] * 1000;
    const rate = SAMPLE_RATES[version][srIndex];
    if (!bitrate || !rate) continue;
    const padding = (b2 >> 1) & 0x01;
    let frameLen;
    if (layer === 1) frameLen = (Math.floor(12 * bitrate / rate) + padding) * 4;
    else if (layer === 3 && version !== '1') frameLen = Math.floor(72 * bitrate / rate) + padding;
    else frameLen = Math.floor(144 * bitrate / rate) + padding;
    if (frameLen < 24 || i + frameLen > buf.length) continue;
    const spf = layer === 1 ? 384 : (layer === 3 && version !== '1' ? 576 : 1152);
    samples += spf;
    sampleRate = rate;
    frames++;
    i += frameLen - 1;
    if (frames > 200000) break;
  }
  if (!frames || !sampleRate) return null;
  return samples / sampleRate;
}

/**
 * @returns {{ok:boolean, seconds:number, format:string, reason?:string}}
 */
function probeDuration(buf, ext) {
  const e = String(ext || '').toLowerCase().replace('jpeg', 'jpg');
  try {
    if (e === 'wav') {
      const s = wavDuration(buf);
      if (s === null) return { ok: false, seconds: 0, format: 'wav', reason: 'WAV 文件结构无法识别' };
      return { ok: true, seconds: s, format: 'wav' };
    }
    if (e === 'mp3') {
      const s = mp3Duration(buf);
      if (s === null) return { ok: false, seconds: 0, format: 'mp3', reason: 'MP3 文件结构无法识别' };
      return { ok: true, seconds: s, format: 'mp3' };
    }
  } catch (err) {
    return { ok: false, seconds: 0, format: e, reason: '音频解析异常' };
  }
  return { ok: false, seconds: 0, format: e, reason: '不支持的音频格式' };
}

module.exports = { probeDuration };
