'use strict';

/* =========================================================================
 * 生成演示数据（可选，用于预览审核后台与 Excel 导出效果）
 *
 *   用法（建议先停止服务）：node tools/seed-demo.js
 *   说明：追加写入，不会清空已有数据；同时生成演示图片与音频到 data/uploads/
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('../lib/config');
const store = require('../lib/store');
const { cnTime } = require('../lib/util');
const { makePng, makeWav } = require('./make-image');

const PALETTE = [
  [[236, 110, 150], [130, 90, 220]],
  [[96, 170, 235], [70, 110, 200]],
  [[120, 210, 160], [50, 150, 130]],
  [[245, 190, 100], [230, 120, 90]],
  [[180, 140, 240], [110, 80, 200]],
  [[240, 150, 190], [200, 90, 160]]
];

let counter = 0;
function saveUpload(buf, ext) {
  const name = 'demo-' + Date.now().toString(36) + '-' + (counter++).toString(36) + '-' +
    crypto.randomBytes(3).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(cfg.UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}

function images(n, seed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = PALETTE[(seed + i) % PALETTE.length];
    out.push(saveUpload(makePng(900, 700, p[0], p[1]), 'png'));
  }
  return out;
}

const DEMO = [
  {
    cn: '星野澪', age: 21, joinYears: '6年', province: '广东省', city: '广州市', gender: '女', height: 165,
    hobbies: 'COS、舞台剧、手作道具', hasExperience: '有', experienceDesc: '参加过 4 届本地漫展，担任过两次舞台剧主役。',
    favoriteWorks: '《原神》《明日方舟》《Fate》系列', otherClub: '否', department: 'COS部',
    introduction: '大家好我是澪，主攻舞台剧方向，希望和大家一起做更好的作品！',
    viewOn2D: '二次元是我表达自我的方式，也是认识朋友的地方。',
    agreeRules: '是', referralCode: 'JZ2026', inviterCn: '白夜',
    status: cfg.STATUS.APPROVED, recommendedDepartment: 'COS部', imgs: 4
  },
  {
    cn: '白夜', age: 24, joinYears: '8年', province: '广东省', city: '咸阳市', gender: '男', height: 178,
    hobbies: '摄影、修图、机甲模型', hasExperience: '有', experienceDesc: '商业摄影助理两年，擅长棚拍布光。',
    favoriteWorks: '《EVA》《攻壳机动队》', otherClub: '否', department: '摄影部',
    introduction: '想做社团的专属摄影，帮大家出好片子。',
    viewOn2D: '一种审美与情感的共同体。',
    agreeRules: '是', referralCode: '', inviterCn: '星野澪',
    status: cfg.STATUS.APPROVED, recommendedDepartment: '摄影部', imgs: 3
  },
  {
    cn: '千夏', age: 19, joinYears: '3年', province: '广东省', city: '广州市', gender: '女', height: 160,
    hobbies: '配音、广播剧、日语', hasExperience: '无', experienceDesc: '',
    favoriteWorks: '《咒术回战》《间谍过家家》', otherClub: '否', department: 'CV部',
    introduction: '希望能在 CV 部学习更多配音技巧。',
    viewOn2D: '让我找到很多同好的地方。',
    agreeRules: '是', referralCode: '', inviterCn: '',
    status: cfg.STATUS.VIEWING, audio: 22
  },
  {
    cn: '黑猫', age: 22, joinYears: '5年', province: '广东省', city: '宝鸡市', gender: '其他认知性别', height: 170,
    hobbies: '板绘、设计、写文', hasExperience: '有', experienceDesc: '接过一些同人插画委托。',
    favoriteWorks: '《明日方舟》《崩坏：星穹铁道》', otherClub: '是', otherClubName: '某高校动漫社（校外联合社）',
    department: '绘画部',
    introduction: '想参与社团的视觉设计工作。',
    viewOn2D: '一种长期陪伴我的爱好。',
    agreeRules: '是', referralCode: '', inviterCn: '千夏',
    status: cfg.STATUS.REJECTED, rejectReasonCode: '拥有其他社会性质社团', rejectReason: '拥有其他社会性质社团', imgs: 3
  },
  {
    cn: '雪见', age: 20, joinYears: '2年', province: '广东省', city: '广州市', gender: '女', height: 158,
    hobbies: 'Lolita、JK、手作', hasExperience: '有', experienceDesc: '三坑收藏三年，常参与线下茶会。',
    favoriteWorks: '《魔法少女小圆》', otherClub: '否', department: '三坑部',
    introduction: '希望认识更多三坑姐妹～',
    viewOn2D: '是让我感到被理解的世界。',
    agreeRules: '是', referralCode: '', inviterCn: '',
    status: cfg.STATUS.SUBMITTED, imgs: 2
  },
  {
    cn: '青空', age: 23, joinYears: '4年', province: '广东省', city: '广州市', gender: '男', height: 175,
    hobbies: '唱歌、编曲、混音', hasExperience: '无', experienceDesc: '',
    favoriteWorks: '《孤独摇滚》《BanG Dream!》', otherClub: '否', department: '唱见部',
    introduction: '希望能在社团里一起做翻唱企划。',
    viewOn2D: '音乐与二次元结合的最好载体。',
    agreeRules: '是', referralCode: 'JZ2026', inviterCn: '白夜',
    status: cfg.STATUS.SUBMITTED
  }
];

function main() {
  store.ensureSeedAdmin();
  console.log('正在生成演示数据…\n');

  const now = Date.now();
  DEMO.forEach((d, i) => {
    const rec = {
      id: 'APP-demo-' + crypto.randomBytes(4).toString('hex'),
      seq: ++store.appDb.seq,
      cn: d.cn, qq: d.qq || String(100000000 + (i + 1) * 11111111),
      age: d.age, joinYears: d.joinYears, province: d.province, city: d.city,
      gender: d.gender, height: d.height, hobbies: d.hobbies,
      hasExperience: d.hasExperience, experienceDesc: d.experienceDesc || '',
      favoriteWorks: d.favoriteWorks, otherClub: d.otherClub, otherClubName: d.otherClubName || '',
      department: d.department,
      workImages: d.imgs ? images(d.imgs, i) : [],
      workAudio: d.audio ? saveUpload(makeWav(d.audio), 'wav') : '',
      introduction: d.introduction, viewOn2D: d.viewOn2D, agreeRules: d.agreeRules,
      referralCode: d.referralCode || '', inviterCn: d.inviterCn || '',
      createdAt: new Date(now - (DEMO.length - i) * 3600 * 1000).toISOString(),
      createdAtText: cnTime(new Date(now - (DEMO.length - i) * 3600 * 1000)),
      status: d.status,
      viewedAt: d.status === cfg.STATUS.SUBMITTED ? null : new Date(now - 1800 * 1000).toISOString(),
      viewedAtText: d.status === cfg.STATUS.SUBMITTED ? '' : cnTime(new Date(now - 1800 * 1000)),
      viewedBy: d.status === cfg.STATUS.SUBMITTED ? '' : 'admin',
      reviewedAt: null, reviewedAtText: '', reviewedBy: '',
      recommendedDepartment: d.recommendedDepartment || '',
      rejectReason: d.rejectReason || '', rejectReasonCode: d.rejectReasonCode || ''
    };
    if (d.status === cfg.STATUS.APPROVED || d.status === cfg.STATUS.REJECTED) {
      rec.reviewedAt = new Date(now - 900 * 1000).toISOString();
      rec.reviewedAtText = cnTime(new Date(now - 900 * 1000));
      rec.reviewedBy = 'admin';
    }
    store.appDb.applications.push(rec);
    console.log(`  #${rec.seq}  ${rec.cn.padEnd(6)}  ${rec.department.padEnd(18)}  ${rec.status}`);
  });

  store.saveApps();
  console.log(`\n完成：共写入 ${DEMO.length} 条演示申请，当前总计 ${store.appDb.applications.length} 条。`);
  console.log('启动服务后打开 http://localhost:' + cfg.PORT + '/admin 即可查看（账号见 README）。');
}

main();
