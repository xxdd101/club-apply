'use strict';

/* =========================================================================
 * 申请表单校验（服务端二次校验，防止绕过前端）
 * ========================================================================= */
const {
  DEPARTMENTS, WORK_RULES, GENDERS, MAX_IMAGES_PER_QUESTION, MIN_AUDIO_SECONDS,
  REJECT_REASONS, REJECT_REASON_OTHER
} = require('./config');
const { str } = require('./util');

function validateApplication(body) {
  const errors = [];
  const need = (v, label) => {
    const s = str(v);
    if (!s) errors.push(label + '不能为空');
    return s;
  };

  /* 01 必填 */
  const cn = need(body.cn, '第01题（CN或代称）');

  /* 01-附：QQ号（必填 / 仅数字 / 5-11 位） */
  const qq = str(body.qq, 20);
  if (!qq) errors.push('QQ号为必填项，请填写');
  else if (!/^\d+$/.test(qq)) errors.push('QQ号只能填写数字');
  else if (qq.length < 5 || qq.length > 11) errors.push('QQ号长度需要5-11位');

  /* 02 必填 数字 */
  const ageRaw = str(body.age, 10);
  let age = 0;
  if (!ageRaw) errors.push('第02题（真实年龄）不能为空');
  else if (!/^\d{1,3}$/.test(ageRaw) || +ageRaw < 1 || +ageRaw > 120) errors.push('第02题（真实年龄）应为 1-120 的整数');
  else age = +ageRaw;

  /* 03 必填 */
  const joinYears = need(body.joinYears, '第03题（入圈年龄）');

  /* 04 必填 省/市 */
  const province = need(body.province, '第04题（所在省份）');
  const city = need(body.city, '第04题（所在城市）');

  /* 05 必填 单选 */
  const gender = str(body.gender, 30);
  if (!GENDERS.includes(gender)) errors.push('第05题（性别）请选择有效选项');

  /* 06 必填 数字 */
  const heightRaw = str(body.height, 10);
  let height = 0;
  if (!heightRaw) errors.push('第06题（身高）不能为空');
  else if (isNaN(+heightRaw) || +heightRaw < 50 || +heightRaw > 250) errors.push('第06题（身高）应为 50-250 之间的数字（厘米）');
  else height = Math.round(+heightRaw);

  /* 07 必填 */
  const hobbies = need(body.hobbies, '第07题（日常兴趣或特长）');

  /* 08 必填 单选 → 09 条件 */
  const hasExperience = str(body.hasExperience, 10);
  if (!['有', '无'].includes(hasExperience)) errors.push('第08题（是否有相关经验）请选择 有/无');
  let experienceDesc = '';
  if (hasExperience === '有') experienceDesc = need(body.experienceDesc, '第09题（相关经验简述）');

  /* 10 必填 */
  const favoriteWorks = need(body.favoriteWorks, '第10题（喜欢/保有兴趣的二次元动漫·人物·游戏）');

  /* 11 必填 单选 → 12 条件 */
  const otherClub = str(body.otherClub, 10);
  if (!['是', '否'].includes(otherClub)) errors.push('第11题（是否参加其他社会性质动漫社团）请选择 是/否');
  let otherClubName = '';
  if (otherClub === '是') otherClubName = need(body.otherClubName, '第12题（其他社会性质动漫社团名称）');

  /* 13 必填 单选 */
  const department = str(body.department, 50);
  if (!DEPARTMENTS.includes(department)) errors.push('第13题（申请部门）请选择有效部门');

  /* 14~21 部门作品联动 */
  let workImages = [];
  let workAudio = '';
  const rule = WORK_RULES[department];
  if (rule && rule.kind === 'image') {
    const raw = Array.isArray(body.workImages) ? body.workImages : [];
    if (raw.length === 0) {
      errors.push(`第${rule.q}题：所选部门【${department}】需上传作品图片`);
    } else if (raw.length > (rule.max || MAX_IMAGES_PER_QUESTION)) {
      errors.push(`第${rule.q}题：作品图片最多上传 ${rule.max || MAX_IMAGES_PER_QUESTION} 张`);
    } else {
      /* 去掉签名查询串后再入库：库里存规范路径，展示时重新签发临时链接 */
      workImages = raw.map(u => str(u, 300).split('?')[0]).filter(u => u.startsWith('/uploads/'));
      if (workImages.length !== raw.length) errors.push(`第${rule.q}题：存在无效的图片地址，请重新上传`);
      if (workImages.length > 6) workImages = workImages.slice(0, 6);
    }
  }
  if (rule && rule.kind === 'audio') {
    workAudio = str(body.workAudio, 300).split('?')[0];
    if (!workAudio.startsWith('/uploads/')) {
      errors.push(`第${rule.q}题：CV部需上传配音/录音文件（时长不少于 ${MIN_AUDIO_SECONDS} 秒）`);
    }
  }

  /* 22 必填 */
  const introduction = need(body.introduction, '第22题（自我介绍）');

  /* 23 必填 */
  const viewOn2D = need(body.viewOn2D, '第23题（对二次元的看法）');

  /* 24 必填 单选 */
  const agreeRules = str(body.agreeRules, 10);
  if (!['是', '否'].includes(agreeRules)) errors.push('第24题（能否遵守并理解管理规章制度）请选择 是/否');

  /* 25 / 26 选填 */
  const referralCode = str(body.referralCode, 100);
  const inviterCn = str(body.inviterCn, 100);

  return {
    errors,
    data: {
      cn, qq, age, joinYears, province, city, gender, height, hobbies,
      hasExperience, experienceDesc, favoriteWorks, otherClub, otherClubName,
      department, workImages, workAudio,
      introduction, viewOn2D, agreeRules, referralCode, inviterCn
    }
  };
}

/* =========================================================================
 * 审核动作校验
 * ========================================================================= */
function validateReview(body) {
  const action = str(body.action, 20);
  if (action === 'approve') {
    const dept = str(body.department, 50);
    if (!DEPARTMENTS.includes(dept)) return { error: '请选择推荐分配的部门' };
    return { value: { action, recommendedDepartment: dept } };
  }
  if (action === 'reject') {
    const code = str(body.reason, 50);
    if (!REJECT_REASONS.includes(code)) return { error: '请选择拒绝理由' };
    let text = code;
    if (code === REJECT_REASON_OTHER) {
      const custom = str(body.reasonText, 500);
      if (!custom) return { error: '选择「其他」时必须填写自定义拒绝原因' };
      text = custom;
    }
    return { value: { action, rejectReasonCode: code, rejectReason: text } };
  }
  /* 退回：由审核员填写退回原因，申请人可修改后提交复审（最多 2 次，见 store.resubmitState） */
  if (action === 'return') {
    const reason = str(body.reason, 500);
    if (!reason) return { error: '请填写退回原因' };
    return { value: { action, returnReason: reason } };
  }
  /* 无法决定：移交最高管理员审核 */
  if (action === 'escalate') {
    return { value: { action } };
  }
  return { error: '无效的审核动作' };
}

module.exports = { validateApplication, validateReview };
