/* =========================================================================
 * 审核状态查询页逻辑
 *  - 只读查询：POST /api/status-query { cn }
 *  - 结果以「纵向时间线」展示，节点随状态变化：
 *      ①已提交申请（复审后变为「已提交复审申请」）
 *      → ②审核员查看中 → ③等待审核结果
 *      → ④审核通过 / 审核拒绝 / 该申请表已被审核员退回 / 复审申请被管理员退回
 *  - 复审机会规则（2026-10-01 修改版，由服务端 canResubmit 决定）：
 *      · 初审【审核拒绝】 → 第 1 次机会
 *      · 初审【退回】     → 第 1 次机会
 *      · 复审后【被退回】 → 第 2 次机会（最后一次）
 *      · 复审后【被拒绝】 → 直接结束，不再提供机会
 *      · 上限 2 次，用尽后按钮永久隐藏
 * ========================================================================= */
(function () {
  'use strict';
  const { $, $$, esc, toast, api, openModal, closeModal } = window.App;

  /* 让 loading 动画至少可见一小段时间，避免一闪而过 */
  const MIN_LOADING_MS = 320;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const EDIT_KEY = 'club_edit_session';
  let pendingRecord = null;      // 待复审的申请

  /* ---------------------------------------------------------------------
   * 时间线节点
   * ------------------------------------------------------------------- */
  function nodesOf(r) {
    const terminal = ['approved', 'rejected', 'returned'].includes(r.status);
    const escalated = r.status === 'escalated';
    const intervened = r.status === 'intervened';
    let current;
    if (terminal) current = 3;
    else if (escalated || intervened) current = 2;
    else if (r.status === 'viewing') current = 1;
    else current = 0;
    const state = i => (i < current ? 'done' : (i === current ? 'current' : 'todo'));

    const n1 = {
      state: state(0),
      icon: '1',
      title: r.isResubmit ? '已提交复审申请' : '已提交申请',
      desc: r.isResubmit
        ? '您修改后的申请表已重新提交，进入复审队列'
        : '您的入社申请表已成功提交，进入审核队列',
      time: (r.isResubmit ? (r.resubmittedAt || '') : (r.submittedAt || ''))
    };

    const n2 = {
      state: state(1),
      icon: '2',
      title: '审核员查看中',
      desc: (r.status === 'submitted' || r.status === 'resubmitted')
        ? '审核员还未查看您的申请表，请耐心等待'
        : (r.status === 'viewing' ? '审核员正在查看您的申请表' : '审核员已查看过您的申请表'),
      time: r.viewedAt || ''
    };

    const n3 = {
      state: state(2),
      icon: '3',
      title: '等待审核结果',
      desc: terminal ? '审核结果已产生'
        : (escalated
          ? '审核员已将该申请表转交主审核官复核，请耐心等待'
          : intervened
            ? '主审核官已介入，正在复核您的申请表'
            : '等待审核员给出审核结果'),
      time: escalated ? (r.escalatedAt || '') : (intervened ? (r.intervenedAt || '') : '')
    };

    let n4;
    /* 结论是「主审核官介入后」给出的 → 第 ④ 节点按主审核官口径显示 */
    const byIvn = r.finalByIntervene === true;
    if (r.status === 'approved') {
      n4 = {
        state: state(3) + ' ok',
        icon: '✓',
        title: byIvn ? '主审核官同意你的申请' : '审核通过',
        desc: (byIvn ? '主审核官已接管并复核通过' : '恭喜！您的入社申请已通过审核')
          + (r.recommendedDepartment ? `，推荐进入「${r.recommendedDepartment}」` : ''),
        time: r.reviewedAt || ''
      };
    } else if (r.status === 'rejected') {
      n4 = {
        state: state(3) + ' err',
        icon: '✕',
        title: byIvn ? '主审核官拒绝你的申请' : '审核拒绝',
        desc: byIvn ? '主审核官已接管并复核，很抱歉未通过审核' : '很抱歉，您的入社申请未通过审核',
        time: r.reviewedAt || ''
      };
    } else if (r.status === 'returned') {
      const isResub = (r.resubmitCount || 0) > 0;
      n4 = {
        state: state(3) + ' warn',
        icon: '↩',
        title: byIvn ? '主审核官退回你的申请'
          : (isResub ? '复审申请被管理员退回' : '该申请表已被审核员退回'),
        desc: r.canResubmit
          ? '请按退回原因修改后，点击下方按钮提交复审'
          : (r.resubmitEnded ? '复审机会已用完，无法再次提交复审' : '请按退回原因修改申请表内容'),
        time: r.reviewedAt || ''
      };
    } else if (r.status === 'intervened') {
      /* 主审核官介入中：非终态，第 ④ 节点以流程色高亮显示 */
      n4 = {
        state: state(3),
        icon: '★',
        title: '主审核官介入中',
        desc: '该申请表已由主审核官介入复核，原有审核状态已清空，请耐心等待结果',
        time: r.intervenedAt || ''
      };
    } else {
      n4 = {
        state: state(3),
        icon: '4',
        title: '审核通过 / 审核拒绝',
        desc: '审核结果尚未产生（两者只会出现其中一个）',
        time: ''
      };
    }
    return [n1, n2, n3, n4];
  }

  function timelineHTML(r) {
    const items = nodesOf(r).map(n => `
      <li class="tl-node ${n.state}">
        <span class="tl-dot" aria-hidden="true">${esc(n.icon)}</span>
        <div class="tl-body">
          <div class="tl-title">${esc(n.title)}</div>
          ${n.desc ? `<div class="tl-desc">${esc(n.desc)}</div>` : ''}
          ${n.time ? `<div class="tl-time">${esc(n.time)}</div>` : ''}
        </div>
      </li>`).join('');

    return `<div class="timeline-card">
      <div class="tl-head">
        <span class="cn">${esc(r.cn)}</span>
        <span class="${window.App.statusClass(r.status)}">${esc(r.statusLabel)}</span>
        ${r.resubmitUsed ? '<span class="badge badge-resubmit">复审申请表</span>' : ''}
        <span class="tl-head-dept">申请部门：${esc(r.department || '—')}</span>
      </div>
      <ol class="timeline">${items}</ol>
      ${detailHTML(r)}
      ${resubmitHTML(r)}
    </div>`;
  }

  /* 申请详情信息（放在时间线下方） */
  function detailHTML(r) {
    const rows = [
      ['申请人 CN', r.cn],
      ['申请部门', r.department || '—'],
      ['提交时间', r.submittedAt || '—']
    ];
    if (r.resubmitUsed && r.resubmittedAt) rows.push(['最近复审提交', r.resubmittedAt]);
    if (r.finalByIntervene && r.finalAt) rows.push(['主审核官复核时间', r.finalAt]);
    if (r.status === 'approved') {
      rows.push(['推荐进入部门', r.recommendedDepartment || r.department || '—']);
      rows.push(['审核时间', r.reviewedAt || '—']);
    } else if (r.status === 'rejected') {
      rows.push(['拒绝理由', r.rejectReason || '未填写']);
      rows.push(['审核时间', r.reviewedAt || '—']);
    } else if (r.status === 'returned') {
      rows.push(['退回原因', r.returnReason || '未填写']);
      rows.push(['退回时间', r.reviewedAt || '—']);
    } else if (r.status === 'escalated') {
      rows.push(['转交主审核官时间', r.escalatedAt || '—']);
    } else if (r.status === 'intervened') {
      rows.push(['主审核官介入时间', r.intervenedAt || '—']);
    } else if (r.viewedAt) {
      rows.push(['审核员查看时间', r.viewedAt]);
    }
    if (r.resubmitUsed) rows.push(['复审机会', `已使用 ${r.resubmitCount || 1} / ${r.resubmitMax || 2} 次`]);

    const html = rows
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => {
        let cls = 'v';
        if (k === '推荐进入部门') cls += ' sr-dept';
        if (k === '拒绝理由' || k === '退回原因') cls += ' sr-reason';
        return `<div class="detail-item"><span class="k">${esc(k)}</span><span class="${cls}">${esc(v)}</span></div>`;
      }).join('');

    return `<div class="tl-detail">
      <div class="tl-detail-title">申请详情信息</div>
      ${html}
      ${urgeHTML(r)}
    </div>`;
  }

  /* ---------------------------------------------------------------------
   * 催促审核（申请详细信息板块最下方）
   *   · 仅「已提交申请 / 已提交复审申请」显示；终审（通过/不通过）等状态不显示
   *   · 本次页面会话内点过一次后按钮置灰（sessionStorage 记住）
   *   · 服务端还有 1 小时冷却，冷却中显示剩余时间并置灰
   * ------------------------------------------------------------------- */
  const URGED_KEY = 'club_urged_ids';
  function urgedIds() {
    try { return new Set(JSON.parse(sessionStorage.getItem(URGED_KEY) || '[]').map(String)); }
    catch (e) { return new Set(); }
  }
  function markUrged(id) {
    try {
      const s = urgedIds(); s.add(String(id));
      sessionStorage.setItem(URGED_KEY, JSON.stringify(Array.from(s)));
    } catch (e) { /* 无痕模式下忽略 */ }
  }

  function urgeHTML(r) {
    /* 只有等待审核的两个状态才给入口 */
    if (!(r.status === 'submitted' || r.status === 'resubmitted')) return '';
    const done = urgedIds().has(String(r.id));
    const cooling = (r.urgeCooldownLeftMs || 0) > 0;
    const times = r.urgeCount || 0;
    const countText = times > 0 ? `（已催促 ${times} 次）` : '';
    if (done || cooling) {
      const why = done
        ? '本次已提交催促提醒，请耐心等待审核人员处理'
        : `1 小时内只能催促 1 次，请在 ${esc(r.urgeCooldownLeftText || '稍后')}后再试`;
      return `<div class="urge-bar">
        <button class="btn" type="button" disabled>催促审核</button>
        <span class="small muted">${why}${countText}</span>
      </div>`;
    }
    return `<div class="urge-bar">
      <button class="btn btn-urge" type="button" data-urge="${esc(r.id)}">催促审核</button>
      <span class="small muted">等得久了可以催一下；同一份申请表 1 小时内最多催促 1 次${countText}</span>
    </div>`;
  }

  async function urge(rec) {
    if (!rec) return;
    const res = await api('POST', `/api/applications/${encodeURIComponent(rec.id)}/urge`,
      { cn: rec.cn }, { auth: false });
    if (res.status === 200 && res.data && res.data.ok) {
      markUrged(rec.id);
      const box = $('#urgeOkMsg');
      if (box) box.textContent = res.data.message || '已提交催促提醒，审核人员将尽快查看，请耐心等待。';
      openModal('urgeOkModal');
      return;
    }
    toast((res.data && res.data.error) || '催促失败，请稍后重试', 'err');
    /* 冷却/终审等情况：刷新一次查询，让按钮状态与服务端一致 */
    if (res.status === 429 || res.status === 409) query();
  }

  /* 修改并重新复审入口 —— 仅服务端判定 canResubmit 时显示（拒绝/退回 + 还有次数） */
  function resubmitHTML(r) {
    if (r.canResubmit) {
      const used = r.resubmitCount || 0;
      const max = r.resubmitMax || 2;
      const hint = used === 0
        ? `初审被拒绝／退回后有 <b>${max} 次</b>复审机会，本次提交将使用第 <b>1</b> 次`
        : `这是<b>最后一次</b>复审机会（第 <b>${used + 1}/${max}</b> 次），提交后若再被退回或被拒绝将不再有机会`;
      return `<div class="resubmit-bar">
        <button class="btn btn-primary" type="button" data-resubmit="${esc(r.id)}">前往修改 - 提交复审</button>
        <span class="small muted">${hint}</span>
      </div>`;
    }
    if (r.resubmitEnded) {
      return `<div class="resubmit-bar"><span class="small muted">${esc(r.resubmitReason || '该申请已使用过复审机会')}，无法再次提交复审。</span></div>`;
    }
    return '';
  }

  function render(results) {
    $('#resultArea').innerHTML = results.map(timelineHTML).join('');
    $$('#resultArea [data-resubmit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = results.find(x => String(x.id) === btn.dataset.resubmit);
        openResubmitModal(rec);
      });
    });
    $$('#resultArea [data-urge]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rec = results.find(x => String(x.id) === btn.dataset.urge);
        if (!rec) return;
        btn.disabled = true;
        btn.textContent = '提交中…';
        await urge(rec);
        btn.textContent = '催促审核';
        btn.disabled = true;            // 本次会话内不再允许点击
      });
    });
  }

  /* 催促成功提示弹窗的关闭按钮 */
  const urgeOkBtn = $('#urgeOkClose');
  if (urgeOkBtn) {
    urgeOkBtn.addEventListener('click', () => {
      closeModal('urgeOkModal');
      query();                        // 关闭后刷新一次，按钮变为「已催促」置灰态
    });
  }

  /* ---------------------------------------------------------------------
   * 复审确认弹窗
   * ------------------------------------------------------------------- */
  function openResubmitModal(rec) {
    if (!rec) return;
    pendingRecord = rec;
    $('#rsQq').value = '';
    $('#rsErr').style.display = 'none';
    /* 把「这次是第几次 / 还有没有下一次」讲清楚 */
    const used = rec.resubmitCount || 0;
    const max = rec.resubmitMax || 2;
    const box = $('#rsNotice');
    if (box) {
      box.innerHTML = used === 0
        ? `⚠️ 每份申请表最多可提交 <b>${max} 次</b>复审。本次为第 <b>1</b> 次；`
          + '若复审被<b>退回</b>，还可再修改 1 次；若复审被<b>拒绝</b>，则不再提供机会。'
        : `⚠️ 这是<b>最后一次</b>复审机会（第 <b>${used + 1}/${max}</b> 次）。`
          + '提交后若再被退回或被拒绝，该按钮将<b>永久消失</b>，无法再次提交。';
    }
    openModal('resubmitModal');
    setTimeout(() => $('#rsQq').focus(), 120);
  }

  function rsError(msg) {
    const e = $('#rsErr');
    e.textContent = msg;
    e.style.display = '';
    toast(msg, 'err');
  }

  async function confirmResubmit() {
    if (!pendingRecord) return;
    const rec = pendingRecord;
    const qq = $('#rsQq').value.trim();
    if (!qq) return rsError('请填写申请时使用的 QQ号');
    if (!/^\d+$/.test(qq)) return rsError('QQ号只能填写数字');
    if (qq.length < 5 || qq.length > 11) return rsError('QQ号长度需要5-11位');

    const btn = $('#rsOk');
    btn.disabled = true; btn.textContent = '验证中…';
    const res = await api('GET', `/api/applications/${encodeURIComponent(rec.id)}/edit-data`
      + `?cn=${encodeURIComponent(rec.cn)}&qq=${encodeURIComponent(qq)}`, null, { auth: false });
    btn.disabled = false; btn.textContent = '确定';

    if (res.status !== 200 || !res.data || !res.data.ok) {
      return rsError((res.data && res.data.error) || '验证失败，请稍后重试');
    }
    /* 校验通过：把可编辑数据与会话凭据暂存到 sessionStorage（不把 QQ 放进 URL） */
    try {
      sessionStorage.setItem(EDIT_KEY, JSON.stringify({
        at: Date.now(), id: rec.id, cn: rec.cn, qq,
        application: res.data.application
      }));
    } catch (e) {
      return rsError('浏览器存储不可用，请关闭无痕模式后重试');
    }
    closeModal('resubmitModal');
    location.href = '/?edit=' + encodeURIComponent(rec.id);
  }

  function setLoading(on) {
    const box = $('#queryLoading');
    if (box) box.style.display = on ? '' : 'none';
  }

  async function query() {
    const cn = $('#cnInput').value.trim();
    const area = $('#resultArea');
    if (!cn) { toast('请输入您的 CN 或代称', 'err'); $('#cnInput').focus(); return; }

    const btn = $('#queryBtn');
    btn.disabled = true;
    btn.textContent = '查询中…';
    area.innerHTML = '';
    setLoading(true);

    const started = Date.now();
    const res = await api('POST', '/api/status-query', { cn }, { auth: false });

    const rest = MIN_LOADING_MS - (Date.now() - started);
    if (rest > 0) await sleep(rest);

    setLoading(false);
    btn.disabled = false;
    btn.textContent = '查询';

    if (res.status === 200 && res.data && res.data.ok) {
      render(res.data.results);
      toast(`查询到 ${res.data.count} 条申请记录`, 'ok');
      return;
    }
    area.innerHTML = `<div class="notice notice-err">${esc((res.data && res.data.error) || '查询失败，请稍后重试')}</div>`;
    toast((res.data && res.data.error) || '查询失败', 'err');
  }

  $('#queryBtn').addEventListener('click', query);
  $('#cnInput').addEventListener('keydown', e => { if (e.key === 'Enter') query(); });
  $('#rsCancel').addEventListener('click', () => closeModal('resubmitModal'));
  $('#rsOk').addEventListener('click', confirmResubmit);
  $('#rsQq').addEventListener('keydown', e => { if (e.key === 'Enter') confirmResubmit(); });
  $('#cnInput').focus();
})();
