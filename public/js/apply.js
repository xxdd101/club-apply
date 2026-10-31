/* =========================================================================
 * 用户填写端（入社申请表）逻辑
 *  - 26 题，条件题默认隐藏，按前置选择动态显示
 *  - 图片 / 音频在线校验并即时上传
 *  - 提交前全量校验，定位并提示缺失项
 *  - 本地草稿自动保存，刷新不丢失
 * ========================================================================= */
(function () {
  'use strict';
  const { $, $$, esc, toast, api, upload, openModal, closeModal, lightbox } = window.App;

  const DRAFT_KEY = 'club_apply_draft_v2';
  const EDIT_KEY = 'club_edit_session';
  /* 复审编辑模式：{ id, cn, qq }；非空表示当前是「修改后提交复审」 */
  let editMode = null;

  /* 服务端元数据（失败时用本地兜底，保证页面可用） */
  let META = {
    departments: ['COS部', '唱见部', '舞见部', 'CV部', '三坑部', '后勤部', '妆娘部', '绘画部', '后期部', '摄影部', '特摄部', 'FURRY（福瑞）部', 'Kigurumi(人偶扮演)部', '宣传部'],
    genders: ['男', '女', '两性人', '生理男认知女', '生理女认知男', '其他认知性别'],
    workRules: {
      'COS部': { q: 14, kind: 'image', max: 6 },
      '三坑部': { q: 15, kind: 'image', max: 6 },
      '摄影部': { q: 16, kind: 'image', max: 6 },
      '后期部': { q: 16, kind: 'image', max: 6 },
      '绘画部': { q: 17, kind: 'image', max: 6 },
      'CV部': { q: 18, kind: 'audio', max: 1, minDuration: 15 },
      '特摄部': { q: 19, kind: 'image', max: 6 },
      'FURRY（福瑞）部': { q: 20, kind: 'image', max: 6 },
      'Kigurumi(人偶扮演)部': { q: 21, kind: 'image', max: 6 }
    },
    maxImages: 6,
    minAudioSeconds: 15
  };
  const WORK_QIDS = ['q14', 'q15', 'q16', 'q17', 'q18', 'q19', 'q20', 'q21'];

  /* =====================================================================
   * 上传组件
   * ===================================================================== */
  function initUploader(box) {
    const kind = box.dataset.uploader;          // image | audio
    const max = Number(box.dataset.max || (kind === 'image' ? 6 : 1));
    box._files = [];                            // [{url,name,size,duration}]

    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.accept = kind === 'image' ? 'image/jpeg,image/png,.jpg,.jpeg,.png' : 'audio/mpeg,audio/wav,.mp3,.wav';
    if (kind === 'image' && max > 1) input.multiple = true;
    box.appendChild(input);

    const listEl = document.createElement('div');
    listEl.className = kind === 'image' ? 'thumbs' : 'audio-box';
    box.appendChild(listEl);

    const pickBtn = $('[data-pick]', box);
    if (pickBtn) pickBtn.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.value = '';
      for (const f of files) {
        if (box._files.length >= max) { toast(`最多上传 ${max} 个文件`, 'err'); break; }
        await handleFile(box, f, kind, max);
      }
      renderUploader(box);
      scheduleDraft();
    });

    /* 拖拽上传 */
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('dragover'); });
    box.addEventListener('dragleave', () => box.classList.remove('dragover'));
    box.addEventListener('drop', async e => {
      e.preventDefault(); box.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files || []);
      for (const f of files) {
        if (box._files.length >= max) { toast(`最多上传 ${max} 个文件`, 'err'); break; }
        await handleFile(box, f, kind, max);
      }
      renderUploader(box);
      scheduleDraft();
    });

    renderUploader(box);
  }

  function setUploaderError(box, msg) {
    const q = box.closest('.q');
    if (!q) return;
    q.classList.add('invalid');
    const e = $('.q-error', q);
    if (e) e.textContent = msg;
  }

  async function handleFile(box, file, kind, max) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (kind === 'image') {
      if (!['jpg', 'jpeg', 'png'].includes(ext)) return toast('图片仅支持 jpg / png 格式', 'err');
      if (file.size > 10 * 1024 * 1024) return toast('单张图片不能超过 10MB', 'err');
      if (box._files.length + 1 > max) return toast(`最多上传 ${max} 张图片`, 'err');
    } else {
      if (!['mp3', 'wav'].includes(ext)) return toast('录音仅支持 mp3 / wav 格式', 'err');
      if (file.size > 30 * 1024 * 1024) return toast('录音文件不能超过 30MB', 'err');
      /* 前端校验时长（服务端会再校验一次） */
      try {
        const sec = await audioDuration(file);
        if (sec && sec < META.minAudioSeconds) {
          setUploaderError(box, `录音时长约 ${sec.toFixed(1)} 秒，要求不少于 ${META.minAudioSeconds} 秒`);
          return toast(`录音时长不足 ${META.minAudioSeconds} 秒，请重新录制`, 'err');
        }
      } catch (e) { /* 无法读取时长时交由服务端判断 */ }
      box._files = [];   // 单文件，替换原有
    }

    /* 上传中的临时提示 */
    const ph = document.createElement('div');
    ph.className = 'file-name';
    ph.textContent = '上传中：' + file.name;
    const q0 = box.closest('.q');
    if (q0) q0.appendChild(ph);

    const res = await upload(file, kind);
    ph.remove();

    if (res.status !== 200 || !res.data || !res.data.ok) {
      const msg = (res.data && res.data.error) || '上传失败，请重试';
      setUploaderError(box, msg);
      toast(msg, 'err');
      return;
    }
    box._files.push({
      url: res.data.url, name: file.name, size: res.data.size,
      duration: res.data.duration || null
    });
    const qq = box.closest('.q');
    if (qq) { qq.classList.remove('invalid'); const e = $('.q-error', qq); if (e) e.textContent = ''; }
    toast('上传成功', 'ok');
  }

  function audioDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const a = new Audio();
      const done = fn => { URL.revokeObjectURL(url); fn(); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(() => resolve(isFinite(a.duration) ? a.duration : 0));
      a.onerror = () => done(() => reject(new Error('decode error')));
      a.src = url;
    });
  }

  function renderUploader(box) {
    const kind = box.dataset.uploader;
    const listEl = $('.thumbs, .audio-box', box);
    if (!listEl) return;
    listEl.innerHTML = '';

    if (kind === 'image') {
      box._files.forEach((f, i) => {
        const d = document.createElement('div');
        d.className = 'thumb';
        d.innerHTML = `<img src="${esc(f.url)}" alt="${esc(f.name)}">
          <button class="del" type="button" title="删除">✕</button>`;
        $('img', d).addEventListener('click', () => {
          lightbox(box._files.map(x => ({ url: x.url, caption: x.name })), i);
        });
        $('.del', d).addEventListener('click', () => {
          box._files.splice(i, 1);
          renderUploader(box);
          scheduleDraft();
          updateFillState();
        });
        listEl.appendChild(d);
      });
    } else {
      box._files.forEach(f => {
        const wrap = document.createElement('div');
        const dur = f.duration ? `（约 ${f.duration} 秒）` : '';
        wrap.innerHTML = `<div class="up-actions">
            <span class="file-name">🎧 ${esc(f.name)}${dur}</span>
            <button class="btn btn-sm btn-ghost" type="button" data-rm>删除</button>
          </div>
          <audio controls preload="none" src="${esc(f.url)}"></audio>`;
        $('[data-rm]', wrap).addEventListener('click', () => {
          box._files = [];
          renderUploader(box);
          scheduleDraft();
          updateFillState();
        });
        listEl.appendChild(wrap);
      });
    }
  }

  /* =====================================================================
   * 动态显示逻辑（默认全部隐藏条件题）
   * ===================================================================== */
  function show(qid, on) {
    const el = $('#' + qid);
    if (!el) return;
    const was = el.classList.contains('show');
    el.classList.toggle('show', !!on);
    if (!on && was) {
      /* 题目被隐藏：清空其上传内容，避免误提交其他部门的作品 */
      const box = $('.uploader', el);
      if (box && box._files && box._files.length) {
        box._files = [];
        renderUploader(box);
      }
      el.classList.remove('invalid');
      const e = $('.q-error', el);
      if (e) e.textContent = '';
    }
  }

  function currentDept() {
    const r = $('input[name="department"]:checked');
    return r ? r.value : '';
  }

  function refreshConditional() {
    const hasExp = ($('input[name="hasExperience"]:checked') || {}).value || '';
    const otherClub = ($('input[name="otherClub"]:checked') || {}).value || '';
    show('q09', hasExp === '有');
    show('q12', otherClub === '是');

    const dept = currentDept();
    const rule = META.workRules[dept];
    WORK_QIDS.forEach(qid => {
      const el = $('#' + qid);
      if (!el) return;
      const belongs = (el.dataset.dept || '').split(',').map(s => s.trim());
      show(qid, !!rule && belongs.includes(dept));
    });

    const hint = $('#deptHint');
    if (hint) {
      if (!dept) { hint.textContent = ''; hint.className = 'q-hint'; }
      else if (rule && rule.kind === 'image') {
        hint.className = 'q-hint dept-hint need';
        hint.textContent = `【${dept}】需要提交作品图片（最多 ${rule.max || 6} 张），已在下方向您展示第 ${rule.q} 题。`;
      } else if (rule && rule.kind === 'audio') {
        hint.className = 'q-hint dept-hint need';
        hint.textContent = `【${dept}】需要提交配音/录音文件（时长 ≥${rule.minDuration || 15} 秒），已在下方向您展示第 ${rule.q} 题。`;
      } else {
        hint.className = 'q-hint dept-hint free';
        hint.textContent = `【${dept}】无需提交作品资料，可直接继续填写其余题目。`;
      }
    }
    updateFillState();
  }

  /* =====================================================================
   * 取值
   * ===================================================================== */
  function visibleUploader(field) {
    return $$(`.uploader[data-field="${field}"]`).find(b => {
      const q = b.closest('.q');
      return q && (!q.classList.contains('cond') || q.classList.contains('show'));
    }) || null;
  }

  function collect() {
    const val = id => { const el = $('#' + id); return el ? el.value.trim() : ''; };
    const radio = name => { const r = $(`input[name="${name}"]:checked`); return r ? r.value : ''; };
    const imgBox = visibleUploader('workImages');
    const audBox = visibleUploader('workAudio');
    return {
      cn: val('cn'),
      qq: val('qq'),
      age: val('age'),
      joinYears: val('joinYears'),
      province: val('province'),
      city: val('city'),
      gender: radio('gender'),
      height: val('height'),
      hobbies: val('hobbies'),
      hasExperience: radio('hasExperience'),
      experienceDesc: val('experienceDesc'),
      favoriteWorks: val('favoriteWorks'),
      otherClub: radio('otherClub'),
      otherClubName: val('otherClubName'),
      department: radio('department'),
      workImages: imgBox ? imgBox._files.map(f => f.url) : [],
      workAudio: audBox && audBox._files[0] ? audBox._files[0].url : '',
      introduction: val('introduction'),
      viewOn2D: val('viewOn2D'),
      agreeRules: radio('agreeRules'),
      referralCode: val('referralCode'),
      inviterCn: val('inviterCn')
    };
  }

  function uploaderSnapshot() {
    const out = {};
    $$('.uploader[data-field]').forEach((b, i) => {
      const q = b.closest('.q');
      out[(q ? q.id : 'q') + '_' + b.dataset.field + '_' + i] = b._files || [];
    });
    return out;
  }

  function applyUploaderSnapshot(snap) {
    if (!snap) return;
    $$('.uploader[data-field]').forEach((b, i) => {
      const q = b.closest('.q');
      const key = (q ? q.id : 'q') + '_' + b.dataset.field + '_' + i;
      if (Array.isArray(snap[key])) { b._files = snap[key]; renderUploader(b); }
    });
  }

  /* =====================================================================
   * 校验
   * ===================================================================== */
  function markInvalid(qid, msg) {
    const el = $('#' + qid);
    if (!el) return;
    el.classList.add('invalid');
    const e = $('.q-error', el);
    if (e) e.textContent = msg;
  }
  /* QQ号与 CN 同在第01题卡片内，需要定位到它自己的错误提示行 */
  function markQqInvalid(msg) {
    const el = $('#q01');
    if (el) el.classList.add('invalid');
    const e = $('#qqError');
    if (e) e.textContent = msg;
  }
  function clearInvalid() {
    $$('.q.invalid').forEach(el => {
      el.classList.remove('invalid');
      $$('.q-error', el).forEach(e => { e.textContent = ''; });
    });
  }

  function validate() {
    clearInvalid();
    const d = collect();
    const errs = [];

    if (!d.cn) errs.push(['q01', '请填写您的 CN 或代称']);
    /* QQ号：必填 → 仅数字 → 5-11 位（与需求给定的三句提示文案完全一致） */
    if (!d.qq) errs.push(['q01', 'QQ号为必填项，请填写', 'qq']);
    else if (!/^\d+$/.test(d.qq)) errs.push(['q01', 'QQ号只能填写数字', 'qq']);
    else if (d.qq.length < 5 || d.qq.length > 11) errs.push(['q01', 'QQ号长度需要5-11位', 'qq']);
    if (!d.age) errs.push(['q02', '请填写真实年龄']);
    else if (!/^\d{1,3}$/.test(d.age) || +d.age < 1 || +d.age > 120) errs.push(['q02', '真实年龄应为 1-120 的整数']);
    if (!d.joinYears) errs.push(['q03', '请填写您的入圈年龄，例如：1年；1月']);
    if (!d.province) errs.push(['q04', '请选择所在省份']);
    else if (!d.city) errs.push(['q04', '请选择所在城市']);
    if (!d.gender) errs.push(['q05', '请选择性别']);
    if (!d.height) errs.push(['q06', '请填写身高']);
    else if (isNaN(+d.height) || +d.height < 50 || +d.height > 250) errs.push(['q06', '身高应为 50-250 之间的数字（厘米）']);
    if (!d.hobbies) errs.push(['q07', '请填写您的日常兴趣或特长']);
    if (!d.hasExperience) errs.push(['q08', '请选择是否有相关经验']);
    if (d.hasExperience === '有' && !d.experienceDesc) errs.push(['q09', '请简述您的相关经验']);
    if (!d.favoriteWorks) errs.push(['q10', '请填写喜欢或保有兴趣的二次元动漫/人物/游戏']);
    if (!d.otherClub) errs.push(['q11', '请选择是否参加其他社会性质动漫社团']);
    if (d.otherClub === '是' && !d.otherClubName) errs.push(['q12', '请填写其他社会性质动漫社团名称']);
    if (!d.department) errs.push(['q13', '请选择您想要加入的部门']);

    const rule = META.workRules[d.department];
    if (rule) {
      const qid = 'q' + rule.q;
      if (rule.kind === 'image' && d.workImages.length === 0) {
        errs.push([qid, `选择【${d.department}】需上传作品图片（最多 ${rule.max || 6} 张）`]);
      }
      if (rule.kind === 'audio' && !d.workAudio) {
        errs.push([qid, `选择【${d.department}】需上传配音/录音文件（时长 ≥${rule.minDuration || 15} 秒）`]);
      }
    }

    if (!d.introduction) errs.push(['q22', '请做个自我介绍吧']);
    if (!d.viewOn2D) errs.push(['q23', '请填写您对二次元的看法']);
    if (!d.agreeRules) errs.push(['q24', '请选择是否能遵守并理解管理规章制度']);

    errs.forEach(([qid, msg, target]) => (target === 'qq' ? markQqInvalid(msg) : markInvalid(qid, msg)));
    return { data: d, errors: errs };
  }

  function updateFillState() {
    const el = $('#fillState');
    if (!el) return;
    const d = collect();
    const rule = META.workRules[d.department];
    const req = [
      !!d.cn, !!d.qq, !!d.age, !!d.joinYears, !!d.province && !!d.city, !!d.gender, !!d.height,
      !!d.hobbies, !!d.hasExperience, d.hasExperience !== '有' || !!d.experienceDesc,
      !!d.favoriteWorks, !!d.otherClub, d.otherClub !== '是' || !!d.otherClubName,
      !!d.department,
      !rule || (rule.kind === 'image' ? d.workImages.length > 0 : !!d.workAudio),
      !!d.introduction, !!d.viewOn2D, !!d.agreeRules
    ];
    let done = 0;
    req.forEach(v => { if (v) done++; });
    el.textContent = `已填写 ${done} / ${req.length} 项必填`;
  }

  /* =====================================================================
   * 草稿（刷新不丢失）
   * ===================================================================== */
  let draftTimer = null;
  let submittedFlag = false;   // 提交成功后不再写草稿，避免残留草稿再次提示
  function scheduleDraft() {
    if (submittedFlag) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }
  function saveDraft() {
    if (submittedFlag) return;
    try {
      const d = collect();
      if (!d.cn && !d.hobbies && !d.introduction && !d.department) return;   // 基本为空不保存
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        at: Date.now(), data: d, uploaders: uploaderSnapshot()
      }));
    } catch (e) { /* 忽略容量/隐私模式错误 */ }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { } }

  function restoreDraft() {
    let draft;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { draft = null; }
    if (!draft || !draft.data) return false;
    const d = draft.data;

    ['cn', 'qq', 'age', 'joinYears', 'hobbies', 'experienceDesc', 'favoriteWorks', 'otherClubName',
      'height', 'introduction', 'viewOn2D', 'referralCode', 'inviterCn'].forEach(k => {
        const el = $('#' + k);
        if (el) el.value = d[k] || '';
      });

    const pv = $('#province');
    if (pv && d.province) {
      pv.value = d.province;
      pv.dispatchEvent(new Event('change'));
      const ct = $('#city');
      if (ct && d.city) ct.value = d.city;
    }

    const setRadio = (name, value) => {
      if (!value) return;
      const r = $$(`input[name="${name}"]`).find(x => x.value === value);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    setRadio('gender', d.gender);
    setRadio('hasExperience', d.hasExperience);
    setRadio('otherClub', d.otherClub);
    setRadio('department', d.department);
    setRadio('agreeRules', d.agreeRules);
    /* 同步高亮样式 */
    $$('input[type="radio"]:checked').forEach(r => {
      const lb = r.closest('label');
      if (lb) lb.classList.add('checked');
    });

    refreshConditional();
    applyUploaderSnapshot(draft.uploaders);
    updateFillState();
    return true;
  }

  /* =====================================================================
   * 复审编辑模式：把已提交的申请回填到表单，允许修改后重新提交
   * ===================================================================== */
  function setUploaderFiles(field, files) {
    const box = $$(`.uploader[data-field="${field}"]`).find(b => {
      const q = b.closest('.q');
      return q && (!q.classList.contains('cond') || q.classList.contains('show'));
    });
    if (!box) return;
    box._files = Array.isArray(files) ? files : [];
    renderUploader(box);
  }

  function fileNameOf(url) {
    try { return decodeURIComponent(String(url).split('?')[0].split('/').pop() || '已有附件'); }
    catch (e) { return '已有附件'; }
  }

  /** 用一条已有申请的数据回填整个表单 */
  function fillFromApplication(a) {
    ['cn', 'qq', 'age', 'joinYears', 'hobbies', 'experienceDesc', 'favoriteWorks', 'otherClubName',
      'height', 'introduction', 'viewOn2D', 'referralCode', 'inviterCn'].forEach(k => {
        const el = $('#' + k);
        if (el) el.value = (a[k] === undefined || a[k] === null) ? '' : String(a[k]);
      });

    const pv = $('#province');
    if (pv && a.province) {
      pv.value = a.province;
      pv.dispatchEvent(new Event('change'));
      const ct = $('#city');
      if (ct && a.city) ct.value = a.city;
    }

    const setRadio = (name, value) => {
      if (!value) return;
      const r = $$(`input[name="${name}"]`).find(x => x.value === value);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    setRadio('gender', a.gender);
    setRadio('hasExperience', a.hasExperience);
    setRadio('otherClub', a.otherClub);
    setRadio('agreeRules', a.agreeRules);
    setRadio('department', a.department);      // 必须先定部门，作品题才会显示
    refreshConditional();
    $$('input[type="radio"]:checked').forEach(r => {
      const lb = r.closest('label');
      if (lb) lb.classList.add('checked');
    });

    /* 回填原有附件（后端已签发可预览的临时链接） */
    if (Array.isArray(a.workImages) && a.workImages.length) {
      setUploaderFiles('workImages', a.workImages.map(u => ({ url: u, name: fileNameOf(u), size: 0 })));
    }
    if (a.workAudio) {
      setUploaderFiles('workAudio', [{ url: a.workAudio, name: fileNameOf(a.workAudio), size: 0, duration: null }]);
    }
    updateFillState();
  }

  /** 进入复审编辑模式（返回是否成功） */
  function enterEditMode(appId) {
    let sess = null;
    try { sess = JSON.parse(sessionStorage.getItem(EDIT_KEY) || 'null'); } catch (e) { sess = null; }
    if (!sess || sess.id !== appId || !sess.application) {
      $('#topNotice').className = 'notice notice-err';
      $('#topNotice').innerHTML = '复审会话已失效，请返回 <a href="/status">审核状态查询</a> 重新点击「前往修改 - 提交复审」。';
      return false;
    }
    editMode = { id: sess.id, cn: sess.cn, qq: sess.qq };
    fillFromApplication(sess.application);

    $('#editNotice').style.display = '';
    const btn = $('#submitBtn');
    btn.textContent = '提交复审';
    const rbtn = $('#resetBtn');
    if (rbtn) {
      rbtn.textContent = '放弃复审并返回查询页';
      rbtn.onclick = () => { sessionStorage.removeItem(EDIT_KEY); location.href = '/status'; };
    }
    document.title = '提交复审 · 示例动漫社入社申请表';
    return true;
  }

  /* =====================================================================
   * 初始化
   * ===================================================================== */
  function renderRadios() {
    const g = $('#genderGroup');
    if (g) {
      g.innerHTML = META.genders.map(x =>
        `<label><input type="radio" name="gender" value="${esc(x)}">${esc(x)}</label>`).join('');
    }
    const dp = $('#departmentGroup');
    if (dp) {
      dp.innerHTML = META.departments.map(x => {
        const rule = META.workRules[x];
        /* 需作品 / 需录音 / 无需资料 —— 一眼看出这个部门要不要准备东西 */
        const tag = !rule ? '无需资料'
          : rule.kind === 'audio' ? '需录音' : '需作品';
        const cls = !rule ? 'free' : 'need';
        return `<label class="dept-item" title="${esc(x)}：${tag}">` +
          `<input type="radio" name="department" value="${esc(x)}">` +
          `<span class="dept-name">${esc(x)}</span>` +
          `<span class="dept-tag ${cls}">${tag}</span></label>`;
      }).join('');
    }
  }

  function initRegions() {
    const pv = $('#province'), ct = $('#city');
    const regions = window.REGIONS || [];
    if (!pv || !ct) return;
    pv.innerHTML = '<option value="">请选择省份</option>' +
      regions.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
    pv.addEventListener('change', () => {
      const r = regions.find(x => x.name === pv.value);
      ct.innerHTML = '<option value="">请选择城市</option>' +
        (r ? r.cities.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') : '');
      updateFillState();
    });
    ct.addEventListener('change', updateFillState);
  }

  function bindRadioStyles() {
    document.addEventListener('change', e => {
      const t = e.target;
      if (t && t.type === 'radio') {
        $$(`input[name="${t.name}"]`).forEach(r => {
          const lb = r.closest('label');
          if (lb) lb.classList.toggle('checked', r.checked);
        });
      }
    });
  }

  /* =====================================================================
   * 审核系统状态（启动 / 暂停 / 终止）
   *   · 暂停：页面顶部警戒线提示 + 进入自动弹窗（暂停时间 / 原因 / 预计恢复时间）
   *   · 终止：红色警戒线 + 弹窗（标题 + 管理员通告），并**停止接收新人入社申请**
   * ===================================================================== */
  const SYS_SEEN_KEY = 'club_sys_state_seen';
  let sysState = null;

  function sysSeenKey(st) {
    return (st && st.status) + '@' + ((st && st.updatedAtText) || '');
  }

  function renderSysAlert(st) {
    const box = $('#sysAlert');
    if (!box) return;
    const on = st.status === 'paused' || st.status === 'stopped';
    box.style.display = on ? '' : 'none';
    box.dataset.status = st.status;
    document.body.classList.toggle('sys-paused', st.status === 'paused');
    document.body.classList.toggle('sys-stopped', st.status === 'stopped');
    if (!on) return;

    if (st.status === 'paused') {
      $('#sysAlertIcon').textContent = '⏸️';
      $('#sysAlertTitle').textContent = '审核系统已暂停';
      $('#sysAlertDesc').textContent = `暂停原因：${st.reason || '—'}　预计恢复：${st.pauseUntilText || '—'}`;
    } else {
      $('#sysAlertIcon').textContent = '⛔';
      $('#sysAlertTitle').textContent = st.noticeTitle || '示例动漫社团暂时停止新人入社申请';
      $('#sysAlertDesc').textContent = '当前停止接收新人入社申请';
    }
    $('#sysAlertMore').style.display = '';
  }

  function renderSysModal(st) {
    const isPause = st.status === 'paused';
    $('#sysStateHead').textContent = isPause ? '审核系统已暂停' : (st.noticeTitle || '社团暂时停止新人入社申请');
    $('#sysPauseBox').style.display = isPause ? '' : 'none';
    $('#sysStopBox').style.display = isPause ? 'none' : '';
    if (isPause) {
      $('#sysPausedAt').textContent = st.pausedAtText || st.updatedAtText || '—';
      $('#sysPauseReason').textContent = st.reason || '—';
      $('#sysPauseUntil').textContent = st.pauseUntilText || '—';
    } else {
      $('#sysStopTitle').textContent = st.noticeTitle || '示例动漫社团暂时停止新人入社申请';
      $('#sysStopNotice').textContent = st.notice || '—';
    }
    openModal('sysStateModal');
  }

  /** 终止状态：禁用提交，并给出说明 */
  function applySubmitBlock(st) {
    const blocked = !!(st && st.blockSubmit);
    const btn = $('#submitBtn');
    if (btn) {
      btn.disabled = blocked;
      btn.textContent = blocked ? '已停止招新，暂不可提交' : (editMode ? '提交复审' : '提交');
    }
    const n = $('#topNotice');
    if (n && blocked) {
      n.className = 'notice notice-err';
      n.innerHTML = `<b>${esc(st.noticeTitle || '社团暂时停止新人入社申请')}</b><br>${esc(st.notice || '')}`;
      n.style.display = '';
    }
  }

  async function loadSysState() {
    let st = null;
    try {
      const res = await api('GET', '/api/review-state', null, { auth: false });
      if (res.status === 200 && res.data && res.data.ok) st = res.data.review;
    } catch (e) { /* 读不到就按正常运行处理 */ }
    if (!st) { sysState = null; return; }
    sysState = st;
    renderSysAlert(st);
    applySubmitBlock(st);

    if (st.status === 'paused' || st.status === 'stopped') {
      /* 同一份状态在本次会话里只自动弹一次，避免每次刷新都打扰申请人 */
      let seen = '';
      try { seen = sessionStorage.getItem(SYS_SEEN_KEY) || ''; } catch (e) { }
      if (seen !== sysSeenKey(st)) {
        renderSysModal(st);
        try { sessionStorage.setItem(SYS_SEEN_KEY, sysSeenKey(st)); } catch (e) { }
      }
    }
  }

  async function init() {
    try {
      const res = await api('GET', '/api/meta', null, { auth: false });
      if (res.status === 200 && res.data && res.data.ok) META = Object.assign(META, res.data);
    } catch (e) { /* 使用兜底配置 */ }

    renderRadios();
    initRegions();
    bindRadioStyles();
    $$('.uploader').forEach(initUploader);

    $$('input[name="hasExperience"], input[name="otherClub"], input[name="department"]').forEach(r => {
      r.addEventListener('change', () => { refreshConditional(); scheduleDraft(); updateFillState(); });
    });

    $('#applyForm').addEventListener('input', e => {
      scheduleDraft();
      updateFillState();
      const q = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.q') : null;
      if (q) { q.classList.remove('invalid'); $$('.q-error', q).forEach(x => { x.textContent = ''; }); }
      /* QQ号即时反馈：输入非数字字符时立刻提示 */
      if (e.target && e.target.id === 'qq') {
        const v = e.target.value.trim();
        if (v && !/^\d+$/.test(v)) markQqInvalid('QQ号只能填写数字');
      }
    });
    $('#applyForm').addEventListener('change', () => { scheduleDraft(); updateFillState(); });

    refreshConditional();
    updateFillState();

    /* 复审编辑模式（?edit=<申请id>）：回填数据后不再提示草稿 */
    const editId = new URLSearchParams(location.search).get('edit');
    const inEdit = editId ? enterEditMode(editId) : false;

    let hasDraft = false;
    try { hasDraft = !!localStorage.getItem(DRAFT_KEY); } catch (e) { }
    if (hasDraft && !inEdit) {
      const n = $('#draftNotice');
      if (n) n.style.display = '';
    }

    $('#applyForm').addEventListener('submit', onSubmit);

    /* 审核系统状态：警戒线 + 自动弹窗 + 终止时禁用提交 */
    const sysOk = $('#sysStateOk');
    if (sysOk) sysOk.addEventListener('click', () => closeModal('sysStateModal'));
    const sysMore = $('#sysAlertMore');
    if (sysMore) sysMore.addEventListener('click', () => { if (sysState) renderSysModal(sysState); });
    await loadSysState();

    $('#resetBtn').addEventListener('click', () => {
      if (!confirm('确定要清空当前填写的全部内容吗？此操作不可恢复。')) return;
      clearDraft();
      location.reload();
    });

    $('#restoreDraft').addEventListener('click', () => {
      if (restoreDraft()) {
        toast('草稿已恢复', 'ok');
        $('#draftNotice').style.display = 'none';
      } else toast('草稿恢复失败', 'err');
    });
    $('#discardDraft').addEventListener('click', () => {
      clearDraft();
      $('#draftNotice').style.display = 'none';
      toast('已丢弃草稿');
    });

    $('#okClose').addEventListener('click', () => {
      closeModal('okModal');
      clearDraft();
      /* 复审提交完成后回查询页（此时复审机会已用掉，重置表单已无意义） */
      if (editMode) { location.href = '/status'; return; }
      location.reload();
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    const btn = $('#submitBtn');
    /* 终止（停止新人入社申请）时直接拦下，不发请求 */
    if (sysState && sysState.blockSubmit) {
      toast(sysState.notice || '社团暂时停止新人入社申请', 'err');
      renderSysModal(sysState);
      return;
    }
    const { data, errors } = validate();

    if (errors.length) {
      const [qid, msg] = errors[0];
      const el = $('#' + qid);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const input = el.querySelector('input, select, textarea');
        if (input && input.focus) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (x) { } }, 320);
      }
      $('#topNotice').className = 'notice notice-err';
      $('#topNotice').innerHTML = `还有 <b>${errors.length}</b> 项需要完善，已定位到第一项：<b>${esc(msg)}</b>`;
      toast(`第 ${qid.replace('q', '')} 题：${msg}`, 'err');
      return;
    }

    btn.disabled = true;
    btn.textContent = editMode ? '提交复审中…' : '提交中…';
    const url = editMode
      ? `/api/applications/${encodeURIComponent(editMode.id)}/resubmit`
      : '/api/applications';
    /* 复审时把会话里保存的 CN / QQ 一并带上（服务端据此校验身份） */
    const payload = editMode ? Object.assign({}, data, { cn: editMode.cn, qq: editMode.qq }) : data;
    const res = await api('POST', url, payload, { auth: false });
    btn.disabled = false;
    btn.textContent = editMode ? '提交复审' : '提交';

    if (res.status === 200 && res.data && res.data.ok) {
      submittedFlag = true;
      clearTimeout(draftTimer);
      clearDraft();
      if (editMode) {
        try { sessionStorage.removeItem(EDIT_KEY); } catch (x) { }
        $('#okHead').textContent = '复审提交成功';
        $('#okTitle').textContent = '复审申请已提交，请等待审核';
        $('#okMsg').textContent = '您修改后的申请表已重新进入审核队列。每份申请表仅有一次复审机会，本次已使用。';
        $('#okClose').textContent = '返回审核状态查询';
      }
      $('#okCn').textContent = data.cn;
      openModal('okModal');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const msg = (res.data && res.data.error) || '提交失败，请稍后重试';
    $('#topNotice').className = 'notice notice-err';
    $('#topNotice').innerHTML = '提交失败：' + esc(msg);
    toast(msg, 'err');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (res.data && Array.isArray(res.data.errors)) {
      res.data.errors.forEach(m => {
        const m2 = /^第(\d+)题/.exec(m);
        if (m2) {
          const el = $('#q' + m2[1]);
          if (el) { el.classList.add('invalid'); const er = $('.q-error', el); if (er) er.textContent = m; }
        }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
