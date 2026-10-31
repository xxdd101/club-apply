'use strict';

/* =========================================================================
 * 表单配置（config/form.json）读取与渲染
 *   · 题目字段全部由 JSON 描述，服务端据此生成填写页的 26 个 <section class="q">
 *   · 按文件 mtime 缓存：改了 form.json 不用重启，下一次请求自动重新读取
 *   · 同时给 /api/meta 提供精简字段表（publicFields）、给提交接口做补充校验
 *     （validateExtras）；原有 26 题的校验仍由 lib/validate.js 负责，文案不变
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { str } = require('./util');

const FORM_FILE = path.join(__dirname, '..', 'config', 'form.json');

/**
 * 原有 26 题的字段 id。
 * 这些字段继续走 lib/validate.js 的原有校验（错误文案被测试断言，不能变），
 * validateExtras 只校验配置里**新增**的字段，避免重复报错。
 */
const CORE_FIELD_IDS = [
  'cn', 'qq', 'age', 'joinYears', 'province', 'city', 'gender', 'height', 'hobbies',
  'hasExperience', 'experienceDesc', 'favoriteWorks', 'otherClub', 'otherClubName',
  'department', 'workImages', 'workAudio', 'introduction', 'viewOn2D', 'agreeRules',
  'referralCode', 'inviterCn'
];

let cached = null;   // { mtimeMs, config }

/* ---------------- 配置读取 ---------------- */
function load() {
  let st;
  try {
    st = fs.statSync(FORM_FILE);
  } catch (e) {
    throw new Error('找不到表单配置 config/form.json');
  }
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.config;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(FORM_FILE, 'utf8'));
  } catch (e) {
    throw new Error('表单配置 config/form.json 解析失败：' + e.message);
  }
  if (!config || !Array.isArray(config.fields)) {
    throw new Error('表单配置 config/form.json 缺少 fields 数组');
  }
  cached = { mtimeMs: st.mtimeMs, config };
  return config;
}

function allFields() {
  return load().fields;
}

/** 顶层题目（嵌套子字段除外）——页面上的「共 N 题」按这个算 */
function sectionFields() {
  return allFields().filter(f => !f.nestUnder);
}

/** 按 id 去重后的字段表（同一 id 可能对应多道条件上传题，如 workImages） */
function uniqueFields() {
  const seen = new Set();
  const out = [];
  for (const f of allFields()) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

function fieldCount() {
  return sectionFields().length;
}

/* ---------------- 渲染工具 ---------------- */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 必填星号 / 选填标签 */
function reqTag(f) {
  if (f.required) return '<span class="q-req">*</span>';
  const tag = f.optionalTag === undefined ? '选填' : f.optionalTag;
  return tag ? `<span class="q-opt">${esc(tag)}</span>` : '';
}

/** showIf → data-cond / data-dept（department 用 data-dept，其余用 data-cond） */
function showIfAttrs(si) {
  const vals = Array.isArray(si.in) ? si.in : [si.in];
  if (si.field === 'department') return ` data-dept="${esc(vals.join(','))}"`;
  return ` data-cond="${esc(si.field + '=' + vals.join(','))}"`;
}

function qid(f) {
  return 'q' + f.no;
}

/* ---------------- 各类型控件 ---------------- */
function textInput(f, indent) {
  const id = esc(f.id);
  let attrs = ` type="text" id="${id}" name="${id}"`;
  if (f.maxLength) attrs += ` maxlength="${Number(f.maxLength)}"`;
  if (f.inputmode) attrs += ` inputmode="${esc(f.inputmode)}"`;
  if (f.autocomplete) attrs += ` autocomplete="${esc(f.autocomplete)}"`;
  if (f.placeholder !== undefined) attrs += ` placeholder="${esc(f.placeholder)}"`;
  return `${indent}<input${attrs}>`;
}

function numberInput(f, indent) {
  const id = esc(f.id);
  let attrs = ` type="number" id="${id}" name="${id}"`;
  if (f.min !== undefined) attrs += ` min="${Number(f.min)}"`;
  if (f.max !== undefined) attrs += ` max="${Number(f.max)}"`;
  if (f.step !== undefined) attrs += ` step="${Number(f.step)}"`;
  if (f.placeholder !== undefined) attrs += ` placeholder="${esc(f.placeholder)}"`;
  const input = `<input${attrs}>`;
  if (f.unit) {
    return `${indent}<div class="unit">${input}<span class="unit-text">${esc(f.unit)}</span></div>`;
  }
  return `${indent}${input}`;
}

function textarea(f, indent) {
  const id = esc(f.id);
  let attrs = ` id="${id}" name="${id}"`;
  if (f.maxLength) attrs += ` maxlength="${Number(f.maxLength)}"`;
  attrs += ` rows="${Number(f.rows || 3)}"`;
  if (f.placeholder !== undefined) attrs += ` placeholder="${esc(f.placeholder)}"`;
  return `${indent}<textarea${attrs}></textarea>`;
}

function regionRow(f, indent) {
  const id = esc(f.id);
  return [
    `${indent}<div class="row">`,
    `${indent}  <div><select id="${id}" name="${id}"><option value="">请选择省份</option></select></div>`,
    `${indent}  <div><select id="city" name="city"><option value="">请选择城市</option></select></div>`,
    `${indent}</div>`
  ].join('\n');
}

function radioGroup(f, indent) {
  const id = esc(f.id);
  /* optionsFrom：选项由前端按 /api/meta 的内置列表渲染（性别 / 部门） */
  if (f.optionsFrom) {
    return `${indent}<div class="radios" id="${id}Group"></div>`;
  }
  const labels = (f.options || []).map(o =>
    `${indent}  <label><input type="radio" name="${id}" value="${esc(o)}">${esc(o)}</label>`).join('\n');
  return [`${indent}<div class="radios" id="${id}Group">`, labels, `${indent}</div>`].join('\n');
}

function choiceGrid(f, indent) {
  const id = esc(f.id);
  if (f.optionsFrom === 'departments') {
    /* 部门选项由前端渲染成带「需作品 / 需录音」标签的卡片，并带 #deptHint 提示行 */
    return [
      `${indent}<div class="radios depts" id="${id}Group"></div>`,
      `${indent}<div class="q-hint" id="deptHint"></div>`
    ].join('\n');
  }
  const items = (f.options || []).map(o =>
    `${indent}  <label class="dept-item"><input type="radio" name="${id}" value="${esc(o)}">` +
    `<span class="dept-name">${esc(o)}</span></label>`).join('\n');
  return [`${indent}<div class="radios depts" id="${id}Group">`, items, `${indent}</div>`].join('\n');
}

function uploader(f, indent) {
  const id = esc(f.id);
  const kind = f.uploader || (f.type === 'audio' ? 'audio' : 'image');
  const max = Number(f.max || (kind === 'audio' ? 1 : 6));
  const pick = f.pickLabel || (kind === 'audio' ? '＋ 选择录音文件' : '＋ 选择图片');
  const hint = f.hint || (kind === 'audio'
    ? '支持 mp3 / wav，时长 ≥15 秒，单个 ≤30MB'
    : `支持 jpg / png，最多 ${max} 张，单张 ≤10MB`);
  return [
    `${indent}<div class="uploader" data-uploader="${esc(kind)}" data-max="${max}" data-field="${id}">`,
    `${indent}  <div class="up-actions">`,
    `${indent}    <button class="btn btn-sm" type="button" data-pick>${esc(pick)}</button>`,
    `${indent}    <span class="up-hint">${esc(hint)}</span>`,
    `${indent}  </div>`,
    `${indent}</div>`
  ].join('\n');
}

/** 题目主体（按 type 分发） */
function bodyHtml(f) {
  const indent = '        ';
  switch (f.type) {
    case 'number': return numberInput(f, indent);
    case 'textarea': return textarea(f, indent);
    case 'region': return regionRow(f, indent);
    case 'radio': return radioGroup(f, indent);
    case 'choice-grid': return choiceGrid(f, indent);
    case 'images':
    case 'audio': return uploader(f, indent);
    case 'text':
    default: return textInput(f, indent);
  }
}

/** 嵌在父题内部的子字段（默认配置里的第 01 题 QQ 号） */
function subFieldHtml(f) {
  const id = esc(f.id);
  const head = `          <input type="text" id="${id}" name="${id}"`;
  let first = '';
  if (f.maxLength) first += ` maxlength="${Number(f.maxLength)}"`;
  if (f.inputmode) first += ` inputmode="${esc(f.inputmode)}"`;
  let second = '';
  if (f.autocomplete) second += ` autocomplete="${esc(f.autocomplete)}"`;
  if (f.placeholder !== undefined) second += ` placeholder="${esc(f.placeholder)}"`;
  const input = second
    ? `${head}${first}\n${' '.repeat(17)}${second.trim()}>`
    : `${head}${first}${second}>`;
  return [
    '        <div class="sub-field">',
    `          <label class="sub-label" for="${id}">${esc(f.label)}${reqTag(f)}</label>`,
    input,
    `          <div class="q-error" id="${id}Error"></div>`,
    '        </div>'
  ].join('\n');
}

/* ---------------- 生成整块题目 HTML ---------------- */
function sectionHtml(f) {
  const children = allFields().filter(x => x.nestUnder === f.id);
  const cls = f.showIf ? 'q cond' : 'q';
  const cond = f.showIf ? showIfAttrs(f.showIf) : '';
  const comment = f.comment || (String(f.no) + (f.showIf ? ' 条件题' : ''));

  const parts = [bodyHtml(f)];
  if (!f.noError) parts.push('        <div class="q-error"></div>');
  for (const child of children) {
    parts.push('');
    if (child.nestComment) parts.push(`        <!-- ${esc(child.nestComment)} -->`);
    parts.push(subFieldHtml(child));
  }

  return [
    `    <!-- ${esc(comment)} -->`,
    `    <section class="${cls}" id="${qid(f)}" data-q="${esc(f.no)}"${cond}>`,
    `      <div class="q-head"><span class="q-no">${esc(f.no)}</span>`,
    `        <h3 class="q-title">${esc(f.label)}${f.note ? `<em>${esc(f.note)}</em>` : ''}${reqTag(f)}</h3>`,
    '      </div>',
    '      <div class="q-body">',
    parts.join('\n'),
    '      </div>',
    '    </section>'
  ].join('\n');
}

/** 全部题目（顶层）拼成一段 HTML，替换 index.html 里的占位标记 */
function sectionsHtml() {
  return sectionFields().map(sectionHtml).join('\n\n');
}

/* ---------------- 给 /api/meta 的精简字段表 ---------------- */
function publicFields() {
  return uniqueFields().map(f => {
    const o = {
      id: f.id, no: f.no, type: f.type, label: f.label, required: !!f.required
    };
    if (f.note) o.note = f.note;
    if (f.adminLabel) o.adminLabel = f.adminLabel;
    if (f.unit) o.unit = f.unit;
    if (f.placeholder !== undefined) o.placeholder = f.placeholder;
    if (f.maxLength) o.maxLength = f.maxLength;
    if (f.min !== undefined) o.min = f.min;
    if (f.max !== undefined) o.max = f.max;
    if (f.rows) o.rows = f.rows;
    if (f.options) o.options = f.options;
    if (f.optionsFrom) o.optionsFrom = f.optionsFrom;
    if (f.showIf) o.showIf = f.showIf;
    if (f.pattern) o.pattern = f.pattern;
    if (f.patternError) o.patternError = f.patternError;
    if (f.nestUnder) o.nestUnder = f.nestUnder;
    return o;
  });
}

/* ---------------- 新字段的通用校验 / 入库 ---------------- */
function emptyValue(v) {
  if (Array.isArray(v)) return v.length === 0;
  return str(v) === '';
}

function validateOne(f, raw) {
  const tag = `第${f.no}题（${f.label}）`;
  const val = Array.isArray(raw) || typeof raw === 'number' ? raw : str(raw);
  if (emptyValue(val)) return f.required ? tag + '不能为空' : '';

  if (Array.isArray(val)) {
    const max = Number(f.max || 0);
    if (max && val.length > max) return `${tag}最多上传 ${max} 个文件`;
    return '';
  }

  const s = String(val);
  if (f.pattern) {
    let re = null;
    try { re = new RegExp(f.pattern); } catch (e) { re = null; }
    if (re && !re.test(s)) return f.patternError || (tag + '格式不正确');
  }
  if (f.type === 'number') {
    const n = +s;
    if (isNaN(n)) return tag + '请填写数字';
    if (f.min !== undefined && n < f.min) return `${tag}不能小于 ${f.min}`;
    if (f.max !== undefined && n > f.max) return `${tag}不能大于 ${f.max}`;
  }
  const maxLen = Number(f.maxLength || 0);
  if (maxLen && s.length > maxLen) return `${tag}不能超过 ${maxLen} 个字符`;
  if (Array.isArray(f.options) && !f.options.includes(s)) return tag + '请选择有效选项';
  return '';
}

/**
 * 对配置里**新增**的字段做通用校验。
 * @returns {Array<{field:string,message:string}>}
 */
function validateExtras(body) {
  const out = [];
  for (const f of uniqueFields()) {
    if (CORE_FIELD_IDS.includes(f.id)) continue;
    const err = validateOne(f, body ? body[f.id] : undefined);
    if (err) out.push({ field: f.id, message: err });
  }
  return out;
}

/** 新增字段的入库值（清洗、限长，避免把任意 JSON 原样存库） */
function extrasData(body) {
  const out = {};
  if (!body) return out;
  for (const f of uniqueFields()) {
    if (CORE_FIELD_IDS.includes(f.id)) continue;
    if (!(f.id in body)) continue;
    const v = body[f.id];
    if (Array.isArray(v)) {
      out[f.id] = v.map(x => str(x, 400)).filter(Boolean).slice(0, 50);
    } else if (typeof v === 'number' && isFinite(v)) {
      out[f.id] = v;
    } else {
      out[f.id] = str(v, Number(f.maxLength || 0) || 5000);
    }
  }
  return out;
}

module.exports = {
  FORM_FILE, CORE_FIELD_IDS,
  load, allFields, sectionFields, uniqueFields, fieldCount,
  sectionsHtml, publicFields, validateExtras, extrasData
};
