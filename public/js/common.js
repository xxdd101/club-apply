/* =========================================================================
 * 公共前端工具：请求封装 / 提示 / 弹窗 / 图片灯箱
 * 三个模块（填写端、查询页、管理后台）共用
 * ========================================================================= */
window.App = (function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- 提示条 ---------------- */
  let toastTimer = null;
  function toast(msg, type) {
    const el = $('#toast');
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast' + (type ? ' ' + type : ''); }, 2800);
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(id) { const m = typeof id === 'string' ? $('#' + id) : id; if (m) m.classList.add('show'); }
  function closeModal(id) { const m = typeof id === 'string' ? $('#' + id) : id; if (m) m.classList.remove('show'); }
  function closeAllModals() { $$('.modal-mask.show').forEach(m => m.classList.remove('show')); }

  /* ---------------- 令牌 ---------------- */
  const TOKEN_KEY = 'club_admin_token';
  const ADMIN_KEY = 'club_admin_info';
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setSession(token, admin) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      if (admin) localStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
    } catch (e) { /* 隐私模式 */ }
  }
  function getAdmin() {
    try { return JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ADMIN_KEY); } catch (e) { }
  }

  /* ---------------- 请求 ---------------- */
  /**
   * @param {string} method
   * @param {string} path
   * @param {object|FormData|null} body
   * @param {{auth?:boolean, raw?:BodyInit, headers?:object}} opts
   */
  async function api(method, path, body, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.auth !== false) {
      const t = getToken();
      if (t) headers['Authorization'] = 'Bearer ' + t;
    }
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload });
    } catch (e) {
      return { status: 0, data: { ok: false, error: '网络请求失败，请检查服务是否已启动' } };
    }
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) data = await res.json().catch(() => null);
    else data = await res.text().catch(() => '');
    if (res.status === 401 && opts.auth !== false && opts.silent401 !== true) {
      clearSession();
      if (!/\/admin$|\/admin\.html$|\/$/.test(location.pathname)) location.href = '/admin';
    }
    return { status: res.status, data, headers: res.headers };
  }

  /** 上传文件（原始二进制体） */
  async function upload(file, kind) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return api('POST', `/api/upload?kind=${encodeURIComponent(kind)}&ext=${encodeURIComponent(ext)}`, null, {
      raw: file,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  }

  /* ---------------- 图片灯箱 ---------------- */
  let lbList = [], lbIndex = 0;
  function lightbox(items, index) {
    lbList = items || [];
    lbIndex = index || 0;
    const mask = $('#lightbox');
    if (!mask || !lbList.length) return;
    renderLightbox();
    mask.classList.add('show');
  }
  function renderLightbox() {
    const item = lbList[lbIndex] || {};
    const img = $('#lightboxImg');
    if (img) img.src = item.url || '';
    const cap = $('#lightboxCap');
    if (cap) cap.textContent = (item.caption || '') + (lbList.length > 1 ? `（${lbIndex + 1}/${lbList.length}）` : '');
    const prev = $('.lb-prev'), next = $('.lb-next');
    const many = lbList.length > 1;
    if (prev) prev.style.display = many ? '' : 'none';
    if (next) next.style.display = many ? '' : 'none';
  }
  function lbStep(d) {
    if (lbList.length < 2) return;
    lbIndex = (lbIndex + d + lbList.length) % lbList.length;
    renderLightbox();
  }
  function closeLightbox() { const m = $('#lightbox'); if (m) m.classList.remove('show'); }

  document.addEventListener('click', e => {
    if (e.target.closest('.lb-close')) return closeLightbox();
    if (e.target.closest('.lb-prev')) return lbStep(-1);
    if (e.target.closest('.lb-next')) return lbStep(1);
    if (e.target.id === 'lightbox') return closeLightbox();
    const mask = e.target.closest('.modal-mask');
    if (mask && e.target === mask && mask.dataset.static !== '1') mask.classList.remove('show');
  });
  document.addEventListener('keydown', e => {
    if ($('#lightbox') && $('#lightbox').classList.contains('show')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') lbStep(-1);
      if (e.key === 'ArrowRight') lbStep(1);
      return;
    }
    if (e.key === 'Escape') closeAllModals();
  });

  /* ---------------- 格式化 ---------------- */
  function statusClass(status) { return 'badge badge-' + (status || 'submitted'); }
  function bytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  return {
    $, $$, esc, toast,
    openModal, closeModal, closeAllModals,
    getToken, setSession, getAdmin, clearSession,
    api, upload,
    lightbox, closeLightbox,
    statusClass, bytes
  };
})();
