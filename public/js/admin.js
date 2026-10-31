/* =========================================================================
 * 审核管理后台逻辑
 *  - 登录（账号或密码错误提示）
 *  - 审核列表：序号 / CN / 部门 / 提交时间 / 状态，颜色标识、筛选、搜索
 *  - 申请详情：完整内容、图片放大、音频播放、打开即标记「审核员查看中」
 *  - 审核：通过（选推荐部门）/ 不通过（选拒绝理由），不可逆
 *  - 管理员账号管理（仅最高权限管理员）
 * ========================================================================= */
(function () {
  'use strict';
  const {
    $, $$, esc, toast, api, openModal, closeModal,
    getToken, setSession, getAdmin, clearSession, lightbox, statusClass
  } = window.App;

  let META = { departments: [], workRules: {}, rejectReasons: ['拥有其他社会性质社团', '不符合入社部门要求', '其他'] };
  /**
   * 该部门在申请阶段是否需要提交作品资料。
   *   · workRules 还没从服务端拿到（空对象）→ 一律按「需要」处理，避免误显示「无需资料」
   *   · 有规则 → 需要；没有规则（唱见部/舞见部/后勤部/妆娘部/宣传部…）→ 不需要
   */
  function deptNeedsWork(dept) {
    const keys = Object.keys(META.workRules || {});
    if (!keys.length) return true;
    return !!META.workRules[dept];
  }
  let ME = null;
  let LIST = [];
  let CURRENT = null;
  let confirmAction = null;

  const STATUS_TEXT = {
    submitted: '待审核', viewing: '审核员查看中', approved: '审核通过', rejected: '审核不通过',
    returned: '审核员退回', resubmitted: '复审待审核', escalated: '已移交主审核官',
    intervened: '主审核官介入中'
  };

  /* =====================================================================
   * 视图切换
   * ===================================================================== */
  function showLogin() {
    $('#viewLogin').style.display = '';
    $('#viewApp').style.display = 'none';
  }
  function showApp() {
    $('#viewLogin').style.display = 'none';
    $('#viewApp').style.display = '';
    /* 右上角登录信息：优先展示超管设置的备注名称，没有备注时回退到原始账号名 */
    const note = (ME && ME.note ? String(ME.note).trim() : '');
    const who = $('#whoAmI');
    who.textContent = note || ME.username;
    who.title = '账号：' + ME.username + (note ? '（备注：' + note + '）' : '');
    $('#whoRole').textContent = ME.roleLabel || (ME.role === 'super' ? '最高权限管理员' : '分管理员（审核员）');
    $('#whoRole').className = 'badge ' + (ME.role === 'super' ? 'badge-super' : 'badge-sub');
    /* 菜单可见性由权限决定：系统设置→system；管理员账号管理→超管 或 封禁账号权限 */
    const perms = ME.perms || {};
    $('#navSystem').style.display = perms.system ? '' : 'none';
    $('#navAdmins').style.display = (ME.role === 'super' || perms.ban) ? '' : 'none';
    $('#navReviewState').style.display = perms.openSystem ? '' : 'none';
  }
  /* 登录成功后的入场动画：遮住全屏 → 停留 → 淡出 → 收起
   * 只在「登录成功」分支调用，刷新页面（已有 token）不会重播。 */
  function playWelcome() {
    return new Promise(resolve => {
      const el = $('#welcomeOverlay');
      if (!el) { resolve(); return; }
      const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const hold = reduce ? 480 : 1480;
      const fade = reduce ? 120 : 420;
      el.classList.toggle('no-motion', reduce);
      el.classList.remove('is-hiding');
      el.style.display = 'grid';
      el.setAttribute('aria-hidden', 'false');
      void el.offsetWidth; /* 强制重排，保证动画从第一帧开始 */
      setTimeout(() => {
        el.classList.add('is-hiding');
        setTimeout(() => {
          el.style.display = 'none';
          el.classList.remove('is-hiding');
          el.setAttribute('aria-hidden', 'true');
          resolve();
        }, fade);
      }, hold);
    });
  }
  function showSection(name) {
    $('#viewList').style.display = name === 'list' ? '' : 'none';
    $('#viewDetail').style.display = name === 'detail' ? '' : 'none';
    $('#viewAdmins').style.display = name === 'admins' ? '' : 'none';
    $('#viewSystem').style.display = name === 'system' ? '' : 'none';
    $('#viewReviewState').style.display = name === 'rstate' ? '' : 'none';
    $('#navList').className = 'btn btn-sm' + (name === 'list' ? ' active' : '');
    $('#navAdmins').className = 'btn btn-sm' + (name === 'admins' ? ' active' : '');
    $('#navSystem').className = 'btn btn-sm' + (name === 'system' ? ' active' : '');
    $('#navReviewState').className = 'btn btn-sm' + (name === 'rstate' ? ' active' : '');
  }

  /* =====================================================================
   * 登录
   * ===================================================================== */
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const errBox = $('#loginError');
    errBox.style.display = 'none';
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) {
      errBox.textContent = '请输入账号和密码';
      errBox.style.display = '';
      return;
    }
    const btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = '登录中…';
    const res = await api('POST', '/api/admin/login', { username, password }, { auth: false });
    btn.disabled = false; btn.textContent = '登录';

    if (res.status === 200 && res.data && res.data.ok) {
      setSession(res.data.token, res.data.admin);
      ME = res.data.admin;
      /* 先把后台渲染好（此时被全屏入场动画遮住），动画结束再露出，
         这样既不会白屏闪烁，也不会让加载慢时干等。 */
      showApp();
      location.hash = '#/list';
      loadList().catch(() => {});
      const sub = $('#welcomeSub');
      if (sub) {
        const note = (ME.note ? String(ME.note).trim() : '');
        sub.textContent = '正在进入 · ' + (note || ME.username);
      }
      await playWelcome();
      toast('登录成功，欢迎 ' + ME.username, 'ok');
      return;
    }

    /* 账号已被停用：弹出专用提示（含停用开始时间 / 解封时间 / 封禁原因） */
    if (res.status === 403 && res.data && res.data.banned) {
      const b = res.data.ban || {};
      $('#bnStart').textContent = b.bannedAtText || '—';
      $('#bnUntil').textContent = b.banUntilText || '—';
      $('#bnReason').textContent = b.banReason || '—';
      $('#password').value = '';
      errBox.style.display = 'none';
      openModal('banNoticeModal');
      return;
    }

    errBox.textContent = (res.data && res.data.error) || '账号或密码错误';
    errBox.style.display = '';
    $('#password').value = '';
    $('#password').focus();
  });

  $('#bnOk').addEventListener('click', () => closeModal('banNoticeModal'));

  $('#navLogout').addEventListener('click', () => {
    clearSession();
    ME = null; LIST = []; CURRENT = null;
    location.hash = '';
    showLogin();
    toast('已退出登录');
  });

  /* =====================================================================
   * 审核列表
   * ===================================================================== */
  async function loadList() {
    const res = await api('GET', '/api/applications');
    if (res.status !== 200 || !res.data || !res.data.ok) {
      if (res.status !== 401) toast((res.data && res.data.error) || '加载列表失败', 'err');
      return;
    }
    LIST = res.data.applications || [];
    renderStats(res.data.stats);
    /* 普通审核员看不到已移交主审核官的申请，给出明确提示 */
    const hint = $('#escalatedHint');
    if (hint) {
      const n = res.data.hiddenEscalated || 0;
      hint.style.display = n > 0 ? '' : 'none';
      hint.textContent = n > 0 ? `另有 ${n} 份申请已移交主审核官，仅最高权限管理员可查看，不在您的审核范围内。` : '';
    }
    renderList();
  }

  function renderStats(stats) {
    stats = stats || {};
    const items = [
      ['全部申请', stats.total || 0, ''],
      ['待审核', stats.submitted || 0, 'var(--muted)'],
      ['复审待审核', stats.resubmitted || 0, 'var(--flow)'],
      ['审核员查看中', stats.viewing || 0, 'var(--warn)'],
      ['审核通过', stats.approved || 0, 'var(--ok)'],
      ['审核不通过', stats.rejected || 0, 'var(--err)'],
      ['审核员退回', stats.returned || 0, 'var(--warn)'],
      ['已移交主审核官', stats.escalated || 0, 'var(--brand)'],
      ['主审核官介入中', stats.intervened || 0, 'var(--flow)']
    ];
    $('#statsBar').innerHTML = items.map(([label, n, color]) =>
      `<div class="stat"><b style="color:${color || 'var(--brand)'}">${n}</b><span>${label}</span></div>`).join('');
  }

  function filteredList() {
    const dept = $('#fDept').value;
    const status = $('#fStatus').value;
    const q = $('#fQ').value.trim().toLowerCase();
    const onlyUrged = !!($('#onlyUrged') && $('#onlyUrged').checked);
    return LIST.filter(a =>
      (!dept || a.department === dept) &&
      (!status || a.status === status) &&
      (!onlyUrged || (a.urgeCount || 0) > 0) &&
      (!q || String(a.cn).toLowerCase().includes(q))
    );
  }

  function renderList() {
    const rows = filteredList();
    const body = $('#listBody');
    const showQq = $('#showQq').checked;
    const cols = showQq ? 7 : 6;
    /* 列表是否展示 QQ 号：由工具栏开关控制，状态记住在本地 */
    $('#thQq').style.display = showQq ? '' : 'none';
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="${cols}" class="empty">${LIST.length ? '没有符合筛选条件的申请记录' : '暂无申请记录'}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map(a => {
      /* 主审核官介入相关标签：
         · 介入中        → 该审核表已由主审核官接管
         · 介入后出结果  → 主审核官最终审核：审核通过 / 审核不通过 / 审核员退回 */
      const finalText = STATUS_TEXT[a.status] || a.status;
      const ivnTag = a.intervened
        ? '<span class="badge badge-intervened" title="主审核官已接管该审核表，其他审核员只能查看">该审核表已由主审核官接管</span>'
        : (a.reviewedViaIntervene
          ? `<span class="badge badge-intervened" title="介入人：${esc(a.intervenedBy || '-')}　复核时间：${esc(a.reviewedViaInterveneAtText || '-')}">主审核官最终审核：${esc(finalText)}</span>`
          : '');
      /* 催促审核：urge_count ≥ 1 就显示红色警告标签（卡片顶部） */
      const urgeTag = (a.urgeCount || 0) > 0
        ? `<span class="badge badge-urge" title="最近一次催促：${esc(a.lastUrgeAtText || '-')}">⚠️ 申请人已催促${a.urgeCount}次</span>`
        : '';
      /* 标签统一放进 .tag-stack：PC 端内联（与之前一致），手机端自动换行、永不超出卡片 */
      const tags = [
        a.referralCode ? '<span class="badge badge-referral">内推</span>' : '',
        a.resubmitUsed ? '<span class="badge badge-resubmit" title="该申请提交过复审，请谨慎审核">复审申请表，请谨慎审核</span>' : '',
        a.escalated ? '<span class="badge badge-escalated">已移交主审核官</span>' : '',
        urgeTag,
        ivnTag
      ].filter(Boolean).join('');
      return `
      <tr data-id="${esc(a.id)}">
        <td class="col-idx" data-label="序号">${a.seq}</td>
        <td data-label="CN代称"><span class="cn-cell">
          <b class="cn-name">${esc(a.cn)}</b>
          ${tags ? `<span class="tag-stack cn-tags">${tags}</span>` : ''}
        </span></td>
        ${showQq ? `<td data-label="QQ号">${esc(a.qq || '—')}</td>` : ''}
        <td data-label="申请部门">${esc(a.department)}</td>
        <td class="muted" data-label="提交时间">${esc(a.createdAtText || '')}</td>
        <td data-label="审核状态"><span class="${statusClass(a.status)}">${esc(a.statusLabel || STATUS_TEXT[a.status] || a.status)}</span></td>
        <td class="muted small" data-label="附件">${a.imageCount ? a.imageCount + ' 图' : ''}${a.imageCount && a.hasAudio ? ' · ' : ''}${a.hasAudio ? '1 音频' : ''}${!a.imageCount && !a.hasAudio ? (deptNeedsWork(a.department) ? '—' : '<span class="badge badge-nowork" title="该部门在申请阶段无需提交任何作品资料">无需资料</span>') : ''}</td>
      </tr>`;
    }).join('');

    $$('#listBody tr[data-id]').forEach(tr => {
      tr.addEventListener('click', () => { location.hash = '#/detail/' + tr.dataset.id; });
    });
  }

  ['#fDept', '#fStatus'].forEach(sel => $(sel).addEventListener('change', renderList));
  $('#fQ').addEventListener('input', renderList);
  /* 「仅显示被催促过的申请」筛选 */
  $('#onlyUrged').addEventListener('change', renderList);
  $('#showQq').addEventListener('change', () => {
    try { localStorage.setItem('club_show_qq', $('#showQq').checked ? '1' : '0'); } catch (e) { }
    renderList();
  });
  $('#btnRefresh').addEventListener('click', async () => { await loadList(); toast('列表已刷新', 'ok'); });

  /* =====================================================================
   * 导出 Excel（图片内嵌）
   * ===================================================================== */
  $('#btnExport').addEventListener('click', async () => {
    const btn = $('#btnExport');
    btn.disabled = true; btn.textContent = '导出中…';
    let url = '/api/export';
    if ($('#expFiltered').checked) {
      const qs = new URLSearchParams({ filtered: '1' });
      if ($('#fDept').value) qs.set('department', $('#fDept').value);
      if ($('#fStatus').value) qs.set('status', $('#fStatus').value);
      if ($('#fQ').value.trim()) qs.set('q', $('#fQ').value.trim());
      if ($('#onlyUrged').checked) qs.set('urged', '1');
      url += '?' + qs.toString();
    }
    try {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        toast((d && d.error) || '导出失败', 'err');
        return;
      }
      const blob = await res.blob();
      let filename = '示例动漫社-入社申请导出.xlsx';
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (m) { try { filename = decodeURIComponent(m[1]); } catch (e) { } }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      toast('导出完成，图片已内嵌在 Excel 中', 'ok');
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '导出Excel';
    }
  });

  /* =====================================================================
   * 申请详情
   * ===================================================================== */
  async function openDetail(id) {
    showSection('detail');
    $('#detailBody').innerHTML = '<div class="card muted">加载中…</div>';
    const res = await api('GET', '/api/applications/' + encodeURIComponent(id));
    if (res.status !== 200 || !res.data || !res.data.ok) {
      $('#detailBody').innerHTML = `<div class="notice notice-err">${esc((res.data && res.data.error) || '加载失败')}</div>`;
      return;
    }
    CURRENT = res.data.application;
    renderDetail(res.data);
    if (res.data.autoViewed) {
      await loadList();
      toast('已自动标记为「审核员查看中」', 'ok');
    }
  }

  function locality(a) {
    if (a.province === a.city) return a.province || a.city || '';
    return [a.province, a.city].filter(Boolean).join(' / ');
  }

  function renderDetail(resp) {
    const a = CURRENT;
    $('#detailSeq').textContent = `第 ${a.seq} 号申请 · ${a.id}`;

    const rows = [
      ['CN 代称', a.cn],
      ['QQ 号', a.qq || '—'],
      ['真实年龄', a.age + ' 岁'],
      ['入圈年龄', a.joinYears],
      ['所在地', locality(a)],
      ['性别', a.gender],
      ['身高', a.height + ' 厘米'],
      ['日常兴趣或特长', a.hobbies],
      ['是否有相关经验', a.hasExperience],
      ['相关经验简述', a.experienceDesc],
      ['喜欢／保有兴趣的二次元动漫·人物·游戏', a.favoriteWorks],
      ['是否参加其他社会性质动漫社团', a.otherClub],
      ['其他社会性质社团名称', a.otherClubName],
      ['申请部门', a.department],
      ['自我介绍', a.introduction],
      ['对二次元的看法', a.viewOn2D],
      ['能否遵守并理解管理规章制度', a.agreeRules],
      ['内推码', a.referralCode],
      ['邀请人 CN', a.inviterCn],
      ['提交时间', a.createdAtText]
    ].filter(([, v]) => v !== '' && v !== undefined && v !== null);

    const gridHtml = rows.map(([k, v]) =>
      `<div class="detail-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

    /* 审核结果 / 退回 / 移交 提示 */
    let reviewHtml = '';
    if (a.status === 'approved' || a.status === 'rejected') {
      reviewHtml = `<div class="notice ${a.status === 'approved' ? 'notice-ok' : 'notice-err'}">
        <b>审核结果：${esc(STATUS_TEXT[a.status])}</b><br>
        ${a.status === 'approved' ? `推荐进入部门：<b>${esc(a.recommendedDepartment || '-')}</b><br>` : ''}
        ${a.status === 'rejected' ? `拒绝理由：<b>${esc(a.rejectReason || '-')}</b><br>` : ''}
        审核人：${esc(a.reviewedBy || '-')}　审核时间：${esc(a.reviewedAtText || '-')}
      </div>`;
    } else if (a.status === 'returned') {
      reviewHtml = `<div class="notice notice-warn">
        <b>已退回给申请人修改</b><br>
        退回原因：<b>${esc(a.returnReason || '-')}</b><br>
        操作人：${esc(a.returnedBy || a.reviewedBy || '-')}　退回时间：${esc(a.returnedAtText || a.reviewedAtText || '-')}
      </div>`;
    } else if (a.status === 'escalated') {
      reviewHtml = `<div class="notice notice-info">
        <b>已移交主审核官</b>（该申请仅最高权限管理员可见与审核）<br>
        移交人：${esc(a.escalatedBy || '-')}　移交时间：${esc(a.escalatedAtText || '-')}
      </div>`;
    } else if (a.status === 'intervened') {
      reviewHtml = `<div class="notice notice-info">
        <b>该审核表已由主审核官接管</b>（主审核官介入中，其他审核员只能查看内容，所有审核按钮已置灰）<br>
        介入人：${esc(a.intervenedBy || '-')}　介入时间：${esc(a.intervenedAtText || '-')}
        ${a.intervenedFromStatus ? `<br>介入前状态：<b>${esc(STATUS_TEXT[a.intervenedFromStatus] || a.intervenedFromStatus)}</b>（已按需求清空）${a.intervenedFromText ? '　原审核时间：' + esc(a.intervenedFromText) : ''}` : ''}
      </div>`;
    }
    /* 最终结论由主审核官介入后给出：任何管理员打开都能看到"已接管 + 主审核官最终审核结果" */
    if (a.reviewedViaIntervene && ['approved', 'rejected', 'returned'].includes(a.status)) {
      reviewHtml += `<div class="notice notice-info">
        <b>该审核表已由主审核官接管</b><br>
        <b>主审核官最终审核：${esc(STATUS_TEXT[a.status] || a.status)}</b><br>
        主审核官：${esc(a.reviewedViaInterveneBy || a.intervenedBy || '-')}
        　复核时间：${esc(a.reviewedViaInterveneAtText || a.reviewedAtText || '-')}
      </div>`;
    }
    /* 催促审核：申请人催过就给后台加一条醒目提示，方便优先处理 */
    if ((a.urgeCount || 0) > 0) {
      reviewHtml += `<div class="notice notice-err">
        <b>⚠️ 申请人已催促 ${a.urgeCount} 次</b><br>
        最近催促时间：${esc(a.lastUrgeAtText || '-')}
        ${(a.urgeLog || []).length ? `　共 ${a.urgeLog.length} 条催促日志` : ''}
      </div>`;
    }
    /* 复审历史 */
    if (a.resubmitUsed) {
      const rsN = a.resubmitCount || 1;
      const rsMax = a.resubmitMax || 2;
      const rsLeft = rsN >= rsMax
        ? '已用完复审机会，申请人无法再次提交'
        : (a.status === 'rejected' ? '复审被拒绝后不再提供机会' : '若本次退回，申请人还可再修改 1 次');
      reviewHtml += `<div class="notice notice-info">
        <b>复审申请表，请谨慎审核</b><br>
        该申请已提交 <b>${rsN} / ${rsMax}</b> 次复审　最近复审提交：${esc(a.resubmittedAtText || '-')}
        <br>${esc(rsLeft)}
        ${a.returnReason ? `<br>上次退回原因：<b>${esc(a.returnReason)}</b>` : ''}
        ${a.rejectReason && a.status !== 'rejected' ? `<br>上次拒绝理由：<b>${esc(a.rejectReason)}</b>` : ''}
      </div>`;
    }

    /* 作品图片 */
    const imgs = a.workImages || [];
    const galleryHtml = imgs.length ? `
      <div class="card">
        <h2 class="card-title">作品图片（${imgs.length} 张，点击可放大）</h2>
        <div class="gallery" id="detailGallery">
          ${imgs.map((u, i) => `<img src="${esc(u)}" data-i="${i}" alt="作品${i + 1}">`).join('')}
        </div>
      </div>` : '';

    /* 音频 */
    const audioHtml = a.workAudio ? `
      <div class="card">
        <h2 class="card-title">配音／录音文件（CV部）</h2>
        <audio controls preload="metadata" src="${esc(a.workAudio)}" style="width:100%"></audio>
        <div class="q-hint">文件：${esc(a.workAudio.split('/').pop())}</div>
      </div>` : '';

    /* 无需作品资料的部门（唱见部/舞见部/后勤部/妆娘部/宣传部…）：
       明确写出「本部门无需资料」，审核员不会以为漏看了附件、也不会去翻不存在的作品 */
    const noWorkHtml = !deptNeedsWork(a.department) ? `
      <div class="card no-work-card">
        <h2 class="card-title">作品资料</h2>
        <div class="notice notice-ok no-work-note">
          <b>本部门无需提交作品资料</b><br>
          申请人所选部门【${esc(a.department)}】在申请阶段不需要上传作品 / 录音，
          <b>没有附件属正常情况</b>，请直接根据以上填写内容审核。
        </div>
      </div>` : '';

    /* ---------- 底部操作栏 ----------
     * 权限与锁定规则（与后端 canReviewApp / canIntervene 保持一致）：
     *   · 已出结论（通过/不通过/退回）且未介入锁定
     *       - 有【介入权限】→ 仍渲染操作栏，审核按钮置灰、【审核介入】可点
     *         （需求：即使是审核通过/拒绝，最高管理员依然可以介入）
     *       - 无【介入权限】→ 只显示"结果不可修改"提示
     *   · 无【审核权限】且不能介入 → 只显示"仅可查看"提示
     *   · 处于「主审核官介入中」且无【介入权限】 → 按钮全部渲染但**置灰不可点**
     *   · 有【介入权限】 → 多一个【审核介入】按钮（介入中时置灰）
     */
    const perms = resp.perms || (ME && ME.perms) || {};
    const locked = resp.locked === true;            // 主审核官介入锁定中
    const canReview = resp.canReview === true;
    const canIntervene = resp.canIntervene === true;
    const hasReviewPerm = perms.review === true;
    const hasIvnPerm = perms.intervene === true;
    const isDecided = ['approved', 'rejected', 'returned'].includes(a.status);

    const rsCount = a.resubmitCount || 0;
    const rsMax = a.resubmitMax || 2;
    const rsNote = rsCount > 0 ? `　·　该申请已复审 ${rsCount}/${rsMax} 次` : '';

    let actionHtml;
    if (isDecided && !locked && !hasIvnPerm) {
      /* 已有结论、未被介入、且没有介入权限：不可二次修改（原行为） */
      actionHtml = `
      <div class="action-bar">
        <div class="action-bar-inner">
          <span class="muted small" style="margin-right:auto">该申请已于 ${esc(a.reviewedAtText || '')} 由 ${esc(a.reviewedBy || '')} 处理（${esc(STATUS_TEXT[a.status] || a.status)}），审核结果不可修改。</span>
        </div>
      </div>`;
    } else if (!hasReviewPerm && !hasIvnPerm && !(locked && canIntervene)) {
      /* 没有审核权限：只读 */
      actionHtml = `
      <div class="action-bar">
        <div class="action-bar-inner">
          <span class="muted small" style="margin-right:auto">当前账号没有【审核权限】，仅可查看申请表内容。</span>
        </div>
      </div>`;
    } else {
      const dis = (!canReview) ? ' disabled' : '';
      let lockTip;
      if (locked) {
        lockTip = canIntervene
          ? '该申请表已由主审核官介入，仅主审核官可操作（本账号可操作）'
          : '该申请表已由主审核官介入，仅主审核官可操作，本账号按钮已置灰';
      } else if (isDecided) {
        lockTip = `该申请已出结果（${STATUS_TEXT[a.status] || a.status}），审核按钮已置灰；如需改判请先点【审核介入】接管`;
      } else {
        lockTip = `审核操作不可逆，提交后不能二次修改${rsNote}`;
      }
      actionHtml = `
      <div class="action-bar${locked && !canIntervene ? ' action-bar-locked' : ''}">
        <div class="action-bar-inner">
          <span class="muted small" style="margin-right:auto">${esc(lockTip)}</span>
          <div class="ab-pair">
            <button class="btn btn-danger btn-lg" id="btnReject" type="button"${dis}>审核不通过</button>
            <button class="btn btn-ok btn-lg" id="btnApprove" type="button"${dis}>审核通过</button>
          </div>
          <button class="btn btn-warn btn-lg" id="btnReturn" type="button"${dis}>退回</button>
          <button class="btn btn-escalate btn-lg" id="btnEscalate" type="button"${dis}>无法决定 - 提交主审核官</button>
          ${perms.intervene ? `<button class="btn btn-intervene btn-lg" id="btnIntervene" type="button"${canIntervene ? '' : ' disabled'}>审核介入</button>` : ''}
        </div>
      </div>`;
    }

    $('#detailBody').innerHTML = `
      ${resp.autoViewed ? '<div class="notice notice-warn">系统已自动将该申请状态标记为「审核员查看中」。</div>' : ''}
      <div class="card">
        <div class="toolbar" style="margin-bottom:12px">
          <h2 class="card-title" style="margin:0">${esc(a.cn)} 的入社申请</h2>
          <span class="spacer"></span>
          <span class="${statusClass(a.status)}">${esc(STATUS_TEXT[a.status] || a.status)}</span>
        </div>
        ${reviewHtml}
        <div class="detail-grid">${gridHtml}</div>
      </div>
      ${galleryHtml}
      ${audioHtml}
      ${noWorkHtml}
      <div class="card" style="padding:0">
        ${actionHtml}
      </div>`;

    $$('#detailGallery img').forEach(img => {
      img.addEventListener('click', () => {
        lightbox(imgs.map((u, i) => ({ url: u, caption: `${a.cn} 的作品 ${i + 1}` })), Number(img.dataset.i));
      });
    });

    const ba = $('#btnApprove'), br = $('#btnReject');
    if (ba) ba.addEventListener('click', openApprove);
    if (br) br.addEventListener('click', openReject);
    const btRet = $('#btnReturn'), btEsc = $('#btnEscalate');
    if (btRet) btRet.addEventListener('click', openReturn);
    if (btEsc) btEsc.addEventListener('click', openEscalate);
    const btIvn = $('#btnIntervene');
    if (btIvn) btIvn.addEventListener('click', openIntervene);
  }

  /* ---------------------------------------------------------------------
   * 审核介入：清空已有审核状态 + 锁定为「主审核官介入中」
   * ------------------------------------------------------------------- */
  function openIntervene() {
    if (!CURRENT) return;
    $('#interveneErr').style.display = 'none';
    const from = STATUS_TEXT[CURRENT.status] || CURRENT.status;
    $('#interveneFrom').textContent = from;
    openModal('interveneModal');
  }

  $('#interveneConfirm').addEventListener('click', async () => {
    if (!CURRENT) return;
    const errBox = $('#interveneErr');
    const btn = $('#interveneConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', `/api/applications/${encodeURIComponent(CURRENT.id)}/intervene`, {});
    btn.disabled = false; btn.textContent = '确定介入';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('interveneModal');
      toast('已介入该申请表：原有审核状态已清空，此后仅主审核官可操作', 'ok');
      await openDetail(CURRENT.id);
      await loadList();
      return;
    }
    errBox.textContent = (res.data && res.data.error) || '介入失败，请稍后重试';
    errBox.style.display = '';
  });

  /* ---------------------------------------------------------------------
   * 退回：填写退回原因
   * ------------------------------------------------------------------- */
  function openReturn() {
    if (!CURRENT) return;
    $('#returnReason').value = '';
    $('#returnErr').style.display = 'none';
    /* 告诉审核员：这次退回之后申请人还能不能改（最多 2 次复审机会） */
    const n = CURRENT.resubmitCount || 0;
    const max = CURRENT.resubmitMax || 2;
    const box = $('#returnNotice');
    if (box) {
      if (n >= max) {
        box.innerHTML = `该申请已使用 <b>${n}/${max}</b> 次复审机会，`
          + '本次退回后申请人将<b>无法再次提交</b>（机会已用尽）。';
      } else {
        box.innerHTML = `该申请已使用 <b>${n}/${max}</b> 次复审机会；`
          + `本次退回后申请人将获得第 <b>${n + 1}</b> 次修改机会`
          + (n + 1 >= max ? '（<b>最后一次</b>）' : '，若复审再被退回还可修改 1 次') + '。';
      }
    }
    openModal('returnModal');
    setTimeout(() => $('#returnReason').focus(), 120);
  }

  $('#returnConfirm').addEventListener('click', async () => {
    if (!CURRENT) return;
    const reason = $('#returnReason').value.trim();
    const errBox = $('#returnErr');
    if (!reason) {
      errBox.textContent = '请填写退回原因';
      errBox.style.display = '';
      return;
    }
    const btn = $('#returnConfirm');
    const before = CURRENT.resubmitCount || 0;
    const max = CURRENT.resubmitMax || 2;
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', `/api/applications/${encodeURIComponent(CURRENT.id)}/review`,
      { action: 'return', reason });
    btn.disabled = false; btn.textContent = '确定退回';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('returnModal');
      toast(before < max
        ? `已退回，申请人可修改后提交第 ${before + 1}/${max} 次复审`
        : '已退回；该申请复审机会已用尽，申请人无法再次提交', 'ok');
      CURRENT = res.data.application;
      await openDetail(CURRENT.id);
      await loadList();
      return;
    }
    errBox.textContent = (res.data && res.data.error) || '操作失败';
    errBox.style.display = '';
  });

  /* ---------------------------------------------------------------------
   * 无法决定：移交主审核官
   * ------------------------------------------------------------------- */
  function openEscalate() {
    if (!CURRENT) return;
    $('#escalateErr').style.display = 'none';
    openModal('escalateModal');
  }

  $('#escalateConfirm').addEventListener('click', async () => {
    if (!CURRENT) return;
    const btn = $('#escalateConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', `/api/applications/${encodeURIComponent(CURRENT.id)}/review`,
      { action: 'escalate' });
    btn.disabled = false; btn.textContent = '确认提交';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('escalateModal');
      toast('已提交主审核官审核', 'ok');
      /* 移交后普通审核员不再可见，直接回列表 */
      location.hash = '#/list';
      await loadList();
      return;
    }
    const errBox = $('#escalateErr');
    errBox.textContent = (res.data && res.data.error) || '操作失败';
    errBox.style.display = '';
  });

  $('#btnBack').addEventListener('click', () => { location.hash = '#/list'; });

  /* =====================================================================
   * 审核操作
   * ===================================================================== */
  let approveDeptSel = null;
  function openApprove() {
    if (!CURRENT) return;
    const sel = $('#approveDept');
    sel.innerHTML = META.departments.map(d =>
      `<option value="${esc(d)}"${d === CURRENT.department ? ' selected' : ''}>${esc(d)}</option>`).join('');
    $('#approveErr').style.display = 'none';
    openModal('approveModal');
  }

  $('#approveConfirm').addEventListener('click', async () => {
    const dept = $('#approveDept').value;
    if (!dept) {
      $('#approveErr').textContent = '请选择推荐分配的部门';
      $('#approveErr').style.display = '';
      return;
    }
    const btn = $('#approveConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', `/api/applications/${encodeURIComponent(CURRENT.id)}/review`,
      { action: 'approve', department: dept });
    btn.disabled = false; btn.textContent = '确定';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('approveModal');
      toast(`审核通过，推荐部门：${dept}`, 'ok');
      CURRENT = res.data.application;
      await openDetail(CURRENT.id);
      await loadList();
      return;
    }
    $('#approveErr').textContent = (res.data && res.data.error) || '操作失败';
    $('#approveErr').style.display = '';
  });

  function openReject() {
    if (!CURRENT) return;
    const box = $('#rejectReasons');
    box.innerHTML = META.rejectReasons.map((r, i) =>
      `<label><input type="radio" name="rejectReason" value="${esc(r)}"${i === 0 ? '' : ''}>${esc(r)}</label>`).join('');
    $('#rejectOtherWrap').style.display = 'none';
    $('#rejectOtherText').value = '';
    $('#rejectErr').style.display = 'none';
    openModal('rejectModal');
  }

  document.addEventListener('change', e => {
    if (e.target && e.target.name === 'rejectReason') {
      $('#rejectOtherWrap').style.display = e.target.value === '其他' ? '' : 'none';
      if (e.target.value === '其他') $('#rejectOtherText').focus();
    }
  });

  $('#rejectConfirm').addEventListener('click', async () => {
    const r = $('input[name="rejectReason"]:checked');
    const errBox = $('#rejectErr');
    if (!r) {
      errBox.textContent = '请选择拒绝理由';
      errBox.style.display = '';
      return;
    }
    const custom = $('#rejectOtherText').value.trim();
    if (r.value === '其他' && !custom) {
      errBox.textContent = '选择「其他」时必须填写自定义拒绝原因';
      errBox.style.display = '';
      return;
    }
    const btn = $('#rejectConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', `/api/applications/${encodeURIComponent(CURRENT.id)}/review`,
      { action: 'reject', reason: r.value, reasonText: custom });
    btn.disabled = false; btn.textContent = '确定';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('rejectModal');
      toast('已驳回该申请', 'ok');
      CURRENT = res.data.application;
      await openDetail(CURRENT.id);
      await loadList();
      return;
    }
    errBox.textContent = (res.data && res.data.error) || '操作失败';
    errBox.style.display = '';
  });

  /* =====================================================================
   * 管理员账号管理（仅最高权限）
   * ===================================================================== */
  async function loadAdmins() {
    const res = await api('GET', '/api/admins');
    const body = $('#adminsBody');
    if (res.status === 403) {
      const msg = (res.data && res.data.error) || '当前账号无权查看管理员账号';
      body.innerHTML = `<tr><td colspan="7" class="empty">${esc(msg)}</td></tr>`;
      return;
    }
    if (res.status !== 200 || !res.data || !res.data.ok) {
      body.innerHTML = `<tr><td colspan="7" class="empty">${esc((res.data && res.data.error) || '加载失败')}</td></tr>`;
      return;
    }
    const canAssign = res.data.canAssignPerms === true;    // 只有超管能分配权限
    const canCreate = res.data.canCreate === true;
    $('#btnAddAdmin').style.display = canCreate ? '' : 'none';
    $('#addAdminHint').style.display = canCreate ? '' : 'none';

    const permTags = a => {
      const p = a.perms || {};
      const tags = [];
      if (p.review) tags.push('<span class="badge badge-perm">审核</span>');
      if (p.system) tags.push('<span class="badge badge-perm">系统设置</span>');
      if (p.ban) tags.push('<span class="badge badge-perm">封禁账号</span>');
      if (p.intervene) tags.push('<span class="badge badge-perm-intervene">主审核官介入</span>');
      /* .tag-stack：PC 内联不变，手机端自动换行、不超出卡片 */
      return tags.length
        ? `<span class="tag-stack">${tags.join('')}</span>`
        : '<span class="muted small">—</span>';
    };

    body.innerHTML = res.data.admins.map(a => `
      <tr>
        <td data-label="账号名称">
          <b>${esc(a.username)}</b>${a.id === (ME && ME.id) ? ' <span class="badge badge-referral">当前登录</span>' : ''}
          ${a.banned ? `<div class="ban-tag" title="封禁理由：${esc(a.banReason || '—')}">账号已被停用，停用至：${esc(a.banUntilText || '—')}</div>` : ''}
        </td>
        <td data-label="账号权限"><span class="badge ${a.role === 'super' ? 'badge-super' : 'badge-sub'}">${esc(a.roleLabel)}</span></td>
        <td data-label="功能权限">${a.role === 'super' ? '<span class="badge badge-super">全部权限</span>' : permTags(a)}</td>
        <td data-label="备注">${a.note ? `<span class="badge badge-note">${esc(a.note)}</span>` : '<span class="muted">—</span>'}</td>
        <td data-label="创建时间" class="muted small">${esc(a.createdAtText || '')}</td>
        <td data-label="最近登录" class="muted small">${esc(a.lastLoginAtText || '从未登录')}</td>
        <td data-label="操作"><div class="row-actions">${a.role === 'super'
        ? '<span class="muted small">超管账号不可删除</span>'
        : `${canAssign ? `<button class="btn btn-sm" data-note="${esc(a.id)}" data-name="${esc(a.username)}" data-current="${esc(a.note || '')}" type="button">设置备注</button>` : ''}
             <button class="btn btn-sm" data-settings="${esc(a.id)}" data-name="${esc(a.username)}" data-banned="${a.banned ? '1' : '0'}" data-until="${esc(a.banUntilYmd || '')}" data-reason="${esc(a.banReason || '')}" data-perms="${esc(JSON.stringify(a.perms || {}))}" type="button" title="分配功能权限 / 停用解封账号">设置权限</button>
             ${canAssign ? `<button class="btn btn-sm btn-danger" data-del="${esc(a.id)}" data-name="${esc(a.username)}" type="button">删除</button>` : ''}`}</div></td>
      </tr>`).join('');

    $$('#adminsBody [data-settings]').forEach(b => {
      b.addEventListener('click', () => openSettings(
        b.dataset.settings, b.dataset.name, b.dataset.banned === '1', b.dataset.until, b.dataset.reason,
        JSON.parse(b.dataset.perms || '{}'), canAssign
      ));
    });

    $$('#adminsBody [data-note]').forEach(b => {
      b.addEventListener('click', () => openNote(b.dataset.note, b.dataset.name, b.dataset.current));
    });

    $$('#adminsBody [data-del]').forEach(b => {
      b.addEventListener('click', () => {
        askConfirm('删除分管理员账号', `确定要删除分管理员「<b>${esc(b.dataset.name)}</b>」吗？删除后该账号将立即无法登录。`, async () => {
          const res2 = await api('DELETE', '/api/admins/' + encodeURIComponent(b.dataset.del));
          if (res2.status === 200 && res2.data && res2.data.ok) {
            toast(res2.data.message || '已删除', 'ok');
            await loadAdmins();
          } else {
            toast((res2.data && res2.data.error) || '删除失败', 'err');
          }
        });
      });
    });
  }

  /* 自动聚焦弹窗里的第一个输入框，但不抢用户（或测试脚本）已经点好的焦点。
     原来是无条件 setTimeout(120ms) 聚焦：只要用户在这 120ms 内先点了后面的输入框，
     后面敲进去的字符就会被塞到第一个输入框里（例如备注写成了账号名后缀）。 */
  function focusFirst(sel, modalId) {
    setTimeout(() => {
      const ae = document.activeElement;
      const modal = $('#' + modalId);
      const el = $(sel);
      if (!el) return;
      if (ae && modal && modal.contains(ae) && ae !== el) return;   // 用户已经自己选了别的字段
      el.focus();
    }, 120);
  }

  $('#btnAddAdmin').addEventListener('click', () => {
    $('#newUsername').value = '';
    $('#newPassword').value = '';
    $('#newNote').value = '';
    $('#addAdminErr').style.display = 'none';
    openModal('addAdminModal');
    focusFirst('#newUsername', 'addAdminModal');
  });

  $('#addAdminConfirm').addEventListener('click', async () => {
    const username = $('#newUsername').value.trim();
    const password = $('#newPassword').value;
    const note = $('#newNote').value.trim();
    const errBox = $('#addAdminErr');
    const showErr = m => { errBox.textContent = m; errBox.style.display = ''; };
    if (username.length < 2) return showErr('账号名称至少 2 位');
    if (password.length < 6) return showErr('密码至少 6 位');

    const btn = $('#addAdminConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', '/api/admins', { username, password, note });
    btn.disabled = false; btn.textContent = '确定新增';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('addAdminModal');
      toast(`已新增分管理员「${username}」`, 'ok');
      await loadAdmins();
      return;
    }
    showErr((res.data && res.data.error) || '新增失败');
  });

  /* =====================================================================
   * 停用账号 / 解除停用（超管独有）
   * ===================================================================== */
  let banTargetId = null;
  let banCanAssign = false;      // 当前登录账号是否有权分配权限（仅超管）

  /** 明天的 YYYY-MM-DD（东八区）—— 作为日期选择器可选的最早日期 */
  function tomorrowYmd() {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(Date.now() + 24 * 3600 * 1000))
      .reduce((o, x) => (o[x.type] = x.value, o), {});
    return `${p.year}-${p.month}-${p.day}`;
  }

  /** 根据所选日期自动计算封禁时长 */
  function banDurationText() {
    const v = $('#banUntil').value;
    if (!v) return '请选择解封日期';
    const until = Date.parse(v + 'T00:00:00+08:00');
    const days = Math.ceil((until - Date.now()) / 86400000);
    if (!Number.isFinite(days) || days < 1) return '解封日期必须晚于今天';
    const [y, m, d] = v.split('-');
    return `停用时长约 ${days} 天（停用至 ${y}年${m}月${d}日）`;
  }

  function syncBanFields() {
    const on = $('#banEnabled').checked;
    $('#banFields').style.display = on ? '' : 'none';
    $('#banSwitchHint').textContent = on
      ? '账号将被停用，未到解封日期前无法登录'
      : '开关关闭：不启用封禁；若该账号已被停用，将立即解除';
    if (on) $('#banDuration').textContent = banDurationText();
  }

  /**
   * 【设置权限】弹窗（原【关闭权限】）
   *   · 权限分配区：仅超管可见可改（canAssign）；只有封禁权限的账号看不到这一区
   *   · 停用 / 解封区：功能与原来完全一致
   */
  const PERM_KEYS = ['review', 'system', 'ban', 'intervene'];
  const PERM_INPUT = { review: '#permReview', system: '#permSystem', ban: '#permBan', intervene: '#permIntervene' };

  function openSettings(id, username, banned, untilYmd, reason, perms, canAssign) {
    banTargetId = id;
    banCanAssign = canAssign === true;
    $('#banWho').innerHTML = `目标子账号：<b>${esc(username)}</b>`;
    /* 权限回填 */
    const p = perms || {};
    for (const k of PERM_KEYS) {
      const el = $(PERM_INPUT[k]);
      if (!el) continue;
      el.checked = p[k] === true;
      el.disabled = !banCanAssign;
    }
    $('#permBox').style.display = banCanAssign ? '' : 'none';
    $('#permReadonlyHint').style.display = banCanAssign ? 'none' : '';

    const min = tomorrowYmd();
    const inp = $('#banUntil');
    inp.min = min;
    inp.value = (banned && untilYmd && untilYmd >= min) ? untilYmd : min;
    $('#banReason').value = banned ? (reason || '') : '';
    $('#banEnabled').checked = !!banned;
    $('#banErr').style.display = 'none';
    syncBanFields();
    openModal('banModal');
  }

  $('#banEnabled').addEventListener('change', syncBanFields);
  ['#banUntil'].forEach(sel => {
    $(sel).addEventListener('change', syncBanFields);
    $(sel).addEventListener('input', syncBanFields);
  });

  $('#banConfirm').addEventListener('click', async () => {
    if (!banTargetId) return;
    const errBox = $('#banErr');
    const fail = m => { errBox.textContent = m; errBox.style.display = ''; toast(m, 'err'); };

    const payload = {};
    if (banCanAssign) {
      payload.perms = {};
      for (const k of PERM_KEYS) {
        const el = $(PERM_INPUT[k]);
        payload.perms[k] = !!(el && el.checked);
      }
      if (payload.perms.review === false && banTargetId === (ME && ME.id)) {
        return fail('不能取消自己的审核权限');
      }
    }
    if ($('#banEnabled').checked) {
      const until = $('#banUntil').value;
      const reason = $('#banReason').value.trim();
      if (!until) return fail('请选择解封日期');
      if (until < tomorrowYmd()) return fail('解封日期必须是未来的日期（至少为明天）');
      if (!reason) return fail('请填写封禁理由');
      payload.enabled = true; payload.until = until; payload.reason = reason;
    } else {
      payload.enabled = false;
    }

    const btn = $('#banConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', `/api/admins/${encodeURIComponent(banTargetId)}/settings`, payload);
    btn.disabled = false; btn.textContent = '确定';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('banModal');
      toast(banCanAssign ? '权限与账号设置已保存' : (res.data.message || '已保存'), 'ok');
      await loadAdmins();
      /* 如果改的是自己，权限可能变化 → 刷新导航与当前登录信息 */
      if (banTargetId === (ME && ME.id)) {
        const me = await api('GET', '/api/admin/me', null, { silent401: true });
        if (me.status === 200 && me.data && me.data.ok) { ME = me.data.admin; showApp(); route(); }
      }
      return;
    }
    fail((res.data && res.data.error) || '操作失败');
  });

  /* =====================================================================
   * 设置子账号备注（超管独有）
   * ===================================================================== */
  let noteTargetId = null;

  function openNote(id, username, current) {
    noteTargetId = id;
    $('#noteInput').value = current || '';
    $('#noteWho').textContent = '目标子账号：' + username;
    $('#noteErr').style.display = 'none';
    openModal('noteModal');
    setTimeout(() => $('#noteInput').focus(), 120);
  }

  $('#noteConfirm').addEventListener('click', async () => {
    if (!noteTargetId) return;
    const note = $('#noteInput').value.trim();
    const errBox = $('#noteErr');
    if (note.length > 100) {
      errBox.textContent = '备注不能超过 100 个字符';
      errBox.style.display = '';
      return;
    }
    const btn = $('#noteConfirm');
    btn.disabled = true; btn.textContent = '保存中…';
    const res = await api('PUT', '/api/admins/' + encodeURIComponent(noteTargetId), { note });
    btn.disabled = false; btn.textContent = '保存备注';
    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('noteModal');
      toast(res.data.message || '备注已保存', 'ok');
      /* 若改的是自己，右上角立即同步 */
      if (ME && res.data.admin && res.data.admin.id === ME.id) {
        ME.note = res.data.admin.note;
        showApp();
      }
      await loadAdmins();
      return;
    }
    errBox.textContent = (res.data && res.data.error) || '保存失败';
    errBox.style.display = '';
  });

  /* =====================================================================
   * 修改密码（超管与普通审核账号均可使用，三项输入）
   * ===================================================================== */
  $('#navPwd').addEventListener('click', () => {
    $('#oldPassword').value = '';
    $('#newPassword2').value = '';
    $('#confirmPassword').value = '';
    $('#pwdErr').style.display = 'none';
    openModal('pwdModal');
    focusFirst('#oldPassword', 'pwdModal');
  });

  function pwdError(msg) {
    const errBox = $('#pwdErr');
    errBox.textContent = msg;
    errBox.style.display = '';
    toast(msg, 'err');
  }

  $('#pwdConfirm').addEventListener('click', async () => {
    const oldPassword = $('#oldPassword').value;
    const newPassword = $('#newPassword2').value;
    const confirmPassword = $('#confirmPassword').value;

    /* ① 三项都不能为空 */
    if (!oldPassword) return pwdError('请输入旧密码');
    if (!newPassword) return pwdError('请输入新密码');
    if (!confirmPassword) return pwdError('请再次输入新密码以确认');

    /* ② 新密码与确认新密码必须完全一致 */
    if (newPassword !== confirmPassword) return pwdError('两次输入的新密码不一致，请重新输入');

    /* ③ 新密码长度（与后端规则一致，避免提交后才报错） */
    if (newPassword.length < 6) return pwdError('新密码至少 6 位');
    if (newPassword === oldPassword) return pwdError('新密码不能与旧密码相同');

    $('#pwdErr').style.display = 'none';
    const btn = $('#pwdConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    /* 旧密码是否正确由服务端校验 */
    const res = await api('POST', '/api/admin/password', { oldPassword, newPassword });
    btn.disabled = false; btn.textContent = '确定修改';

    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('pwdModal');
      $('#oldPassword').value = '';
      $('#newPassword2').value = '';
      $('#confirmPassword').value = '';
      toast('密码修改成功，请牢记新密码', 'ok');
      return;
    }
    pwdError((res.data && res.data.error) || '密码修改失败，请稍后重试');
  });

  /* =====================================================================
   * 通用确认弹窗 / 关闭按钮
   * ===================================================================== */
  function askConfirm(title, html, fn) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').innerHTML = html;
    confirmAction = fn;
    openModal('confirmModal');
  }
  $('#confirmOk').addEventListener('click', async () => {
    closeModal('confirmModal');
    const fn = confirmAction;
    confirmAction = null;
    if (fn) await fn();
  });
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));

  /* =====================================================================
   * 系统设置（仅最高权限管理员）：服务器状态 / 重启服务器系统
   *   —— 只重启操作系统，不删除任何业务数据
   * ===================================================================== */
  let SYSINFO = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function fmtLeft(ms) {
    const s = Math.ceil(ms / 1000);
    return s < 60 ? s + ' 秒' : Math.ceil(s / 60) + ' 分钟';
  }

  async function loadSystemInfo(silent) {
    const res = await api('GET', '/api/system/info', null, { silent401: true });
    if (res.status !== 200 || !res.data || !res.data.ok) {
      if (!silent) toast((res.data && res.data.error) || '服务器状态读取失败', 'err');
      return null;
    }
    SYSINFO = res.data.system;
    renderSystemInfo(SYSINFO);
    return SYSINFO;
  }

  function renderSystemInfo(s) {
    const sch = s.schedule || {};
    const rows = [
      ['服务器主机名', s.hostname || '—'],
      ['服务器当前时间', (s.serverTimeText || '—') + '　' + (s.timezone || '')],
      ['已连续运行', s.uptimeText || '—'],
      ['本次开机时间', s.bootAtText || '—'],
      ['每日定时重启', sch.enabled
        ? `已启用 · ${sch.desc}（下次 ${sch.nextAtText}）`
        : `未启用 · 计划为 ${sch.desc}`],
      ['上次重启请求', s.lastRequest
        ? `${s.lastRequest.atText}（${s.lastRequest.mode === 'manual' ? '手动' : '定时'} · ${s.lastRequest.by}）`
        : '暂无记录'],
      ['上次实际重启', s.lastActualReboot
        ? `${s.lastActualReboot.rebootedAtText}（由 ${s.lastActualReboot.by} 触发）`
        : '暂无记录'],
      ['重启能力', s.dryRun ? '演练模式（不会真正重启）'
        : (s.canReboot ? '已就绪' : '不可用：' + (s.blockReason || ''))]
    ];
    $('#sysInfo').innerHTML = rows.map(([k, v]) =>
      `<div class="detail-item"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join('');

    $('#rebootDelayText').textContent = String(s.rebootDelaySeconds || 8);
    const btn = $('#btnReboot'), hint = $('#rebootHint');
    if (s.dryRun) {
      btn.disabled = false;
      hint.textContent = '（演练模式：只记录指令，不会真正重启服务器）';
    } else if (!s.canReboot) {
      btn.disabled = true;
      hint.textContent = s.blockReason || '当前环境不支持重启';
    } else if (s.cooldownRemainingMs > 0) {
      btn.disabled = true;
      hint.textContent = `刚刚已执行过重启，请等待 ${fmtLeft(s.cooldownRemainingMs)} 后再操作`;
    } else {
      btn.disabled = false;
      hint.textContent = `同一台服务器两次手动重启之间至少间隔 ${s.cooldownMinutes || 5} 分钟`;
    }

    const hist = s.history || [];
    const modeLabel = h => h.mode === 'manual' ? '手动'
      : h.mode === 'selftest' ? '自检（未重启）' : '定时自动';
    $('#rebootLogBody').innerHTML = hist.length
      ? hist.map(h => `<tr>
          <td data-label="时间">${esc(h.atText || '')}</td>
          <td data-label="方式">${modeLabel(h)}</td>
          <td data-label="操作人">${esc(h.by || '—')}</td>
          <td data-label="来源 IP">${esc(h.ip || '—')}</td>
          <td data-label="说明">${esc(h.reason || '')}${h.dryRun ? '（演练，未真正重启）' : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty">暂无重启记录</td></tr>';

    /* 服务器侧重启日志（定时任务的重启只在这里留痕） */
    const sl = s.systemLog || { lines: [] };
    if (sl.path) $('#sysLogPath').textContent = sl.path;
    $('#sysLogTail').textContent = (sl.lines && sl.lines.length)
      ? sl.lines.join('\n')
      : ('（暂时读不到重启日志：' + (sl.error || '尚无记录') + '）');
  }

  $('#btnRefreshSystem').addEventListener('click', async () => {
    await loadSystemInfo();
    toast('服务器状态已刷新', 'ok');
  });

  $('#btnReboot').addEventListener('click', async () => {
    $('#rebootErr').style.display = 'none';
    const s = await loadSystemInfo(true);
    if (s && s.canReboot === false && !s.dryRun) {
      toast(s.blockReason || '当前环境不支持重启', 'err');
      return;
    }
    openModal('rebootModal');
  });

  $('#rebootConfirm').addEventListener('click', async () => {
    const errBox = $('#rebootErr');
    errBox.style.display = 'none';
    const btn = $('#rebootConfirm');
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', '/api/system/reboot', {});
    btn.disabled = false; btn.textContent = '确定重启';

    if (res.status === 200 && res.data && res.data.ok) {
      closeModal('rebootModal');
      if (res.data.dryRun) {
        toast('（演练模式）重启指令已下发，服务器不会被真正重启', 'ok');
        await loadSystemInfo(true);
        return;
      }
      showRebootOverlay();
      waitServerBack();
      return;
    }
    errBox.textContent = (res.data && res.data.error) || '重启指令下发失败，请稍后重试';
    errBox.style.display = '';
    toast(errBox.textContent, 'err');
    await loadSystemInfo(true);
  });

  function showRebootOverlay() {
    $('#roTitle').textContent = '服务器正在重启…';
    $('#roText').textContent = '请勿关闭本页面，恢复访问后会自动刷新。';
    $('#roSub').textContent = '已等待 0 秒';
    $('#rebootOverlay').classList.add('show');
  }

  /** 服务器重启期间：轮询健康检查，恢复后自动刷新页面 */
  async function waitServerBack() {
    const started = Date.now();
    const ov = $('#rebootOverlay');
    const MIN_WAIT = 15000;          // 重启还没开始，别太早判定"已恢复"
    const MAX_WAIT = 5 * 60 * 1000;
    const tick = setInterval(() => {
      if (ov.classList.contains('show')) {
        $('#roSub').textContent = '已等待 ' + Math.round((Date.now() - started) / 1000) + ' 秒';
      }
    }, 1000);

    for (;;) {
      await sleep(3000);
      const elapsed = Date.now() - started;
      if (elapsed < MIN_WAIT) continue;
      let alive = false;
      try {
        const r = await fetch('/api/health?ts=' + Date.now(), { cache: 'no-store' });
        alive = r.ok;
      } catch (e) { alive = false; }
      if (alive) break;
      if (elapsed > MAX_WAIT) {
        clearInterval(tick);
        $('#roTitle').textContent = '等待恢复超时';
        $('#roText').innerHTML = '服务器重启时间比预期长。<br>请稍后手动刷新本页；若仍无法访问，请到腾讯云控制台查看实例状态。';
        return;
      }
    }

    clearInterval(tick);
    const box = ov.querySelector('.ro-box');
    const sp = box.querySelector('.spinner');
    if (sp) sp.style.display = 'none';
    if (!box.querySelector('.ro-ok')) {
      const d = document.createElement('div');
      d.className = 'ro-ok';
      d.textContent = '✅';
      box.insertBefore(d, box.firstChild);
    }
    $('#roTitle').textContent = '服务器已恢复访问';
    $('#roText').textContent = '页面即将自动刷新。重启未影响任何申请表、审核结果与账号数据。';
    $('#roSub').textContent = '用时 ' + Math.round((Date.now() - started) / 1000) + ' 秒';
    setTimeout(() => location.reload(), 2500);
  }

  /* =====================================================================
   * 审核设置（需【系统开启权限】）：启动 / 暂停 / 终止审核系统
   *   三个按钮互斥单选，点击即生效；每次操作都留痕（后端 review-state.json）
   * ===================================================================== */
  let RSTATE = null;

  const RSTATE_LABEL = {
    running: '审核系统运行中',
    paused: '审核系统已暂停',
    stopped: '审核系统已终止（停止新人入社申请）'
  };

  function rstateTone(st) {
    return st.status === 'paused' ? 'warn' : (st.status === 'stopped' ? 'err' : 'ok');
  }

  function renderRState(st) {
    RSTATE = st;
    const cur = $('#rstateCurrent');
    cur.dataset.state = st.status;
    $('#rstateLabel').textContent = st.statusLabel || RSTATE_LABEL[st.status] || st.status;

    /* 状态补充信息：暂停显示原因/预计恢复，终止显示通告，运行显示启动时间 */
    const bits = [];
    if (st.status === 'paused') {
      bits.push('暂停时间：' + (st.pausedAtText || '—'));
      bits.push('暂停原因：' + (st.reason || '—'));
      bits.push('预计恢复：' + (st.pauseUntilText || '—'));
    } else if (st.status === 'stopped') {
      bits.push('通告：' + (st.notice || '—'));
    } else if (st.runningSinceText) {
      bits.push('自 ' + st.runningSinceText + ' 起运行中');
    }
    if (st.updatedAtText) bits.push('最近操作：' + st.updatedAtText + (st.updatedByName ? '（' + st.updatedByName + '）' : ''));
    $('#rstateMeta').textContent = bits.join('　·　');

    /* 三个按钮互斥高亮 */
    $$('.rstate-btn').forEach(b => b.classList.toggle('active', b.dataset.state === st.status));
    $('#rstateHint').textContent = st.status === 'stopped'
      ? '当前已停止新人入社申请：前台填表页会弹出公告，提交按钮不可用。'
      : (st.status === 'paused'
        ? '当前审核已暂停：前台会弹窗提示，申请表仍可提交并排队等待。'
        : '三个状态互斥：点击后立即生效，前台申请人页面会同步更新。');
  }

  async function loadReviewState(silent) {
    const [stateRes, histRes] = await Promise.all([
      api('GET', '/api/review-state', null, { auth: false }),
      api('GET', '/api/review-state/history', null, { silent401: true })
    ]);
    if (stateRes.status === 200 && stateRes.data && stateRes.data.ok) renderRState(stateRes.data.review);
    else if (!silent) toast((stateRes.data && stateRes.data.error) || '读取系统状态失败', 'err');

    const body = $('#rstateHistoryBody');
    if (histRes.status === 200 && histRes.data && histRes.data.ok) {
      const hs = histRes.data.history || [];
      body.innerHTML = hs.length ? hs.map(h => `
        <tr>
          <td data-label="时间" class="muted small">${esc(h.atText || '')}</td>
          <td data-label="操作">${esc(h.action === 'start' ? '启动' : h.action === 'pause' ? '暂停' : '终止')}${h.changed ? '' : '（状态未变）'}</td>
          <td data-label="变更" class="small">${esc(h.fromLabel || '')} → <b>${esc(h.toLabel || '')}</b></td>
          <td data-label="原因 / 通告" class="small">${esc(h.reason || h.notice || '—')}</td>
          <td data-label="预计恢复" class="small">${esc(h.pauseUntilText || '—')}</td>
          <td data-label="操作人" class="small">${esc(h.byName || h.by || '—')}</td>
        </tr>`).join('')
        : '<tr><td colspan="6" class="empty">暂无操作记录</td></tr>';
    } else if (histRes.status === 403) {
      body.innerHTML = '<tr><td colspan="6" class="empty">当前账号没有【系统开启权限】，无法查看记录</td></tr>';
    }
  }

  /** 提交一次状态变更 */
  async function submitRState(payload, btn, errBoxId, modalId) {
    const errBox = errBoxId ? $('#' + errBoxId) : null;
    if (errBox) errBox.style.display = 'none';
    btn.disabled = true; btn.textContent = '提交中…';
    const res = await api('POST', '/api/review-state', payload);
    btn.disabled = false;
    btn.textContent = btn.id === 'pauseSysConfirm' ? '确定暂停' : (btn.id === 'stopSysConfirm' ? '确定终止' : '确定');
    if (res.status === 200 && res.data && res.data.ok) {
      if (modalId) closeModal(modalId);
      toast(res.data.message || '已保存', 'ok');
      await loadReviewState(true);
      return true;
    }
    const msg = (res.data && res.data.error) || '操作失败';
    if (errBox) { errBox.textContent = msg; errBox.style.display = ''; }
    toast(msg, 'err');
    return false;
  }

  $('#btnRefreshState').addEventListener('click', async () => {
    await loadReviewState();
    toast('系统状态已刷新', 'ok');
  });

  $('#btnStateStart').addEventListener('click', async () => {
    if (RSTATE && RSTATE.status === 'running') { toast('当前已经是「审核系统运行中」', 'ok'); return; }
    await submitRState({ action: 'start' }, $('#btnStateStart'));
  });

  $('#btnStatePause').addEventListener('click', () => {
    $('#pauseReason').value = (RSTATE && RSTATE.paused) ? (RSTATE.reason || '') : '';
    const inp = $('#pauseUntil');
    /* 默认给一个"明天此刻"的时间，减少手填成本 */
    if (RSTATE && RSTATE.paused && RSTATE.pauseUntilText) {
      inp.value = String(RSTATE.pauseUntilText).replace(' ', 'T').slice(0, 16);
    } else {
      const t = new Date(Date.now() + 24 * 3600 * 1000);
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      }).formatToParts(t).reduce((o, x) => (o[x.type] = x.value, o), {});
      inp.value = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    }
    $('#pauseSysErr').style.display = 'none';
    openModal('pauseSysModal');
    setTimeout(() => { try { $('#pauseReason').focus(); } catch (e) { } }, 150);
  });

  $('#pauseSysConfirm').addEventListener('click', async () => {
    const reason = $('#pauseReason').value.trim();
    const until = $('#pauseUntil').value;
    const errBox = $('#pauseSysErr');
    const fail = m => { errBox.textContent = m; errBox.style.display = ''; toast(m, 'err'); };
    if (!reason) return fail('请填写暂停原因');
    if (!until) return fail('请填写预计恢复时间');
    await submitRState({ action: 'pause', reason, pauseUntil: until }, $('#pauseSysConfirm'), 'pauseSysErr', 'pauseSysModal');
  });

  $('#btnStateStop').addEventListener('click', () => {
    $('#stopNotice').value = (RSTATE && RSTATE.stopped) ? (RSTATE.notice || '') : '';
    $('#stopSysErr').style.display = 'none';
    openModal('stopSysModal');
    setTimeout(() => { try { $('#stopNotice').focus(); } catch (e) { } }, 150);
  });

  $('#stopSysConfirm').addEventListener('click', async () => {
    const notice = $('#stopNotice').value.trim();
    const errBox = $('#stopSysErr');
    if (!notice) { errBox.textContent = '请填写通告文本'; errBox.style.display = ''; toast('请填写通告文本', 'err'); return; }
    await submitRState({ action: 'stop', notice }, $('#stopSysConfirm'), 'stopSysErr', 'stopSysModal');
  });

  /* =====================================================================
   * 路由
   * ===================================================================== */
  function route() {
    if (!ME) { showLogin(); return; }
    const h = location.hash || '#/list';
    let m = /^#\/detail\/(.+)$/.exec(h);
    if (m) { showApp(); openDetail(decodeURIComponent(m[1])); return; }
    if (h === '#/admins') {
      const p = ME.perms || {};
      if (ME.role !== 'super' && !p.ban) { location.hash = '#/list'; return; }
      showApp(); showSection('admins'); loadAdmins(); return;
    }
    if (h === '#/system') {
      const p = ME.perms || {};
      if (!p.system) { location.hash = '#/list'; return; }
      showApp(); showSection('system'); loadSystemInfo(); return;
    }
    if (h === '#/rstate') {
      const p = ME.perms || {};
      if (!p.openSystem) { location.hash = '#/list'; return; }
      showApp(); showSection('rstate'); loadReviewState(); return;
    }
    showApp(); showSection('list');
  }
  window.addEventListener('hashchange', route);

  /* =====================================================================
   * 启动
   * ===================================================================== */
  async function boot() {
    /* 恢复「显示QQ号」开关状态 */
    try { $('#showQq').checked = localStorage.getItem('club_show_qq') === '1'; } catch (e) { }

    const meta = await api('GET', '/api/meta', null, { auth: false });
    if (meta.status === 200 && meta.data && meta.data.ok) {
      META.departments = meta.data.departments || META.departments;
      META.workRules = meta.data.workRules || META.workRules || {};
      META.rejectReasons = meta.data.rejectReasons || META.rejectReasons;
    }
    $('#fDept').innerHTML = '<option value="">全部部门</option>' +
      META.departments.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');

    if (!getToken()) { showLogin(); $('#username').focus(); return; }

    const cached = getAdmin();
    const me = await api('GET', '/api/admin/me', null, { silent401: true });
    if (me.status === 200 && me.data && me.data.ok) {
      ME = me.data.admin;
      route();
      await loadList();
      return;
    }
    if (me.status === 0 && cached) {
      /* 服务暂时不可达：不清除会话，提示用户 */
      toast('无法连接服务器', 'err');
      showLogin();
      return;
    }
    clearSession();
    showLogin();
    $('#username').focus();
  }

  boot();
  $('#navList').addEventListener('click', () => { location.hash = '#/list'; });
  $('#navAdmins').addEventListener('click', () => { location.hash = '#/admins'; });
  $('#navSystem').addEventListener('click', () => { location.hash = '#/system'; });
  $('#navReviewState').addEventListener('click', () => { location.hash = '#/rstate'; });
})();
