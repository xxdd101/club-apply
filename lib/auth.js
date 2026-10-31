'use strict';

/* =========================================================================
 * 认证：口令散列（scrypt） + 无状态签名令牌（HMAC-SHA256）
 * 令牌自包含，服务重启后仍有效（密钥持久化于 data/secret.key）
 * ========================================================================= */
const fs = require('fs');
const crypto = require('crypto');
const { SECRET_FILE, DATA_DIR, TOKEN_TTL_MS } = require('./config');
const { safeEqual } = require('./util');

fs.mkdirSync(DATA_DIR, { recursive: true });

let SECRET;
try {
  SECRET = fs.readFileSync(SECRET_FILE);
  if (!SECRET || SECRET.length < 16) throw new Error('bad secret');
} catch (e) {
  SECRET = crypto.randomBytes(48);
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

/* ---------------- 口令 ---------------- */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const { hash: h } = hashPassword(password, salt);
    return safeEqual(h, hash);
  } catch (e) { return false; }
}

/* ---------------- 令牌 ---------------- */
function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(payloadB64) {
  return b64u(crypto.createHmac('sha256', SECRET).update(payloadB64).digest());
}

/** @param {{id:string,username:string,role:string}} admin */
function issueToken(admin) {
  const payload = { sub: admin.id, u: admin.username, r: admin.role, exp: Date.now() + TOKEN_TTL_MS };
  const p = b64u(JSON.stringify(payload));
  return p + '.' + sign(p);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const p = token.slice(0, i), s = token.slice(i + 1);
  if (!safeEqual(sign(p), s)) return null;
  let payload;
  try { payload = JSON.parse(unb64u(p).toString('utf8')); } catch (e) { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/**
 * 通用 HMAC 签名（用于给上传附件签发带有效期的访问链接）
 * @param {string} data 待签名内容
 * @param {number} [len] 截取长度
 */
function hmacHex(data, len) {
  const h = crypto.createHmac('sha256', SECRET).update(String(data)).digest('hex');
  return len ? h.slice(0, len) : h;
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, hmacHex };
