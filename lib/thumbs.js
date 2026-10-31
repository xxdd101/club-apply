'use strict';

/* =========================================================================
 * 缩略图（用于 Excel 内嵌图片）
 * 导出时按需生成并缓存到 data/thumbs/，避免每次导出重复压缩
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { UPLOAD_DIR, THUMB_DIR } = require('./config');

const THUMB_MAX = 420;   // 缩略图最长边（px），保证 Excel 内预览清晰且体积可控
const THUMB_QUALITY = 80;

function thumbPathFor(fileName) {
  const base = String(fileName).replace(/\.[^.]+$/, '');
  return path.join(THUMB_DIR, base + '.jpg');
}

/**
 * 取得（或生成）图片缩略图
 * @param {string} fileName 上传目录下的文件名
 * @returns {Promise<Buffer|null>}
 */
async function getThumb(fileName) {
  const safe = path.basename(String(fileName || ''));
  if (!safe) return null;
  const src = path.join(UPLOAD_DIR, safe);
  const cache = thumbPathFor(safe);

  try {
    if (fs.existsSync(cache) && fs.statSync(cache).size > 0) return fs.readFileSync(cache);
  } catch (e) { /* 缓存不可用则重新生成 */ }

  if (!fs.existsSync(src)) return null;

  const img = await Jimp.read(src);
  img.scaleToFit(THUMB_MAX, THUMB_MAX);
  img.quality(THUMB_QUALITY);
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);

  try { fs.writeFileSync(cache, buf); } catch (e) { /* 缓存写入失败不影响导出 */ }
  return buf;
}

/** 并发受限的批量取图：返回 Map<fileName, Buffer> */
async function getThumbsMany(fileNames, concurrency) {
  const out = new Map();
  const queue = Array.from(new Set(fileNames.filter(Boolean)));
  const limit = Math.max(1, concurrency || 4);
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const name = queue[cursor++];
      try {
        const buf = await getThumb(name);
        if (buf) out.set(name, buf);
      } catch (e) {
        console.warn('[缩略图] 生成失败：', name, e && e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return out;
}

module.exports = { getThumb, getThumbsMany, THUMB_MAX };
