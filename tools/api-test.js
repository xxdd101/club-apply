'use strict';

/* =========================================================================
 * 端到端接口测试
 *   用法：先启动服务（建议用独立数据目录），再执行
 *     $env:DATA_DIR='./data-test'; $env:PORT='3100'; node server.js
 *     node tools/api-test.js
 *   环境变量 BASE 可指定地址，默认 http://127.0.0.1:3100
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const OUT_DIR = path.join(__dirname, '_probe');
fs.mkdirSync(OUT_DIR, { recursive: true });

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
    console.log('  ❌ ' + name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}

async function rawApi(method, p, { token, json, raw, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (token) h['Authorization'] = 'Bearer ' + token;
  let body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (raw) body = raw;
  const res = await fetch(BASE + p, { method, headers: h, body });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  else data = Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

/* 用例很多时会撞上服务端的限流（提交 20/分、查询 20/分、上传 30/分…）。
   这里对 429 做「等窗口滚动后重试」，让测试不因限流而假失败；
   需要**故意**验证限流的用例请直接用 rawApi（见 [11] 上传滥用防护）。 */
let rateWaits = 0;
async function api(method, p, opts = {}) {
  for (let i = 0; i < 30; i++) {
    const res = await rawApi(method, p, opts);
    if (res.status !== 429) return res;
    rateWaits++;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('接口持续返回 429（限流未恢复）：' + method + ' ' + p);
}

/* ---------------- 测试素材生成 ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
/** 生成纯色 PNG（真实可解码图片，用于上传与缩略图测试） */
function makePng(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
/** 构造一个「IHDR 声明超大尺寸」的 PNG，用于测试解压炸弹防护 */
function makeBombPng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
/** 生成 8kHz 单声道 16bit PCM WAV（正弦波，时长可控） */
function makeWav(seconds, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i * 2 * Math.PI * 440 / rate)), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

async function uploadImage(rgb) {
  return api('POST', '/api/upload?kind=image&ext=png', { raw: makePng(320, 240, rgb), headers: { 'Content-Type': 'application/octet-stream' } });
}
async function uploadAudio(seconds) {
  return api('POST', '/api/upload?kind=audio&ext=wav', { raw: makeWav(seconds), headers: { 'Content-Type': 'application/octet-stream' } });
}

function basePayload(over) {
  return Object.assign({
    cn: '测试CN', qq: '123456789', age: 20, joinYears: '3年', province: '广东省', city: '广州市',
    gender: '女', height: 165, hobbies: '绘画、唱歌', hasExperience: '有', experienceDesc: '参加过校漫展',
    favoriteWorks: '《原神》《明日方舟》', otherClub: '否', department: '唱见部',
    introduction: '大家好', viewOn2D: '二次元是我的精神家园', agreeRules: '是',
    referralCode: '', inviterCn: ''
  }, over || {});
}

(async () => {
  console.log('==================================================');
  console.log(' 端到端接口测试   目标：' + BASE);
  console.log('==================================================');

  /* ---------- 1. 基础 ---------- */
  console.log('\n[1] 基础接口');
  const health = await api('GET', '/api/health');
  ok('健康检查返回 ok', health.status === 200 && health.data.ok === true, health.data);
  const meta = await api('GET', '/api/meta');
  ok('元数据返回 14 个部门', meta.status === 200 && meta.data.departments.length === 14, meta.data && meta.data.departments);
  ok('部门列表包含新增的【宣传部】', (meta.data.departments || []).includes('宣传部'), meta.data.departments);
  ok('【宣传部】没有任何作品/录音要求（不在 workRules 里）',
    !!meta.data.workRules && !meta.data.workRules['宣传部'], Object.keys(meta.data.workRules || {}));
  ok('原有 9 个需作品部门的规则保持不变',
    Object.keys(meta.data.workRules || {}).length === 9, Object.keys(meta.data.workRules || {}));

  /* ---------- 2. 登录 ---------- */
  console.log('\n[2] 管理员登录');
  const bad = await api('POST', '/api/admin/login', { json: { username: 'admin', password: 'wrong-pass' } });
  ok('错误密码 → 401 且提示“账号或密码错误”', bad.status === 401 && bad.data.error === '账号或密码错误', bad.data);
  const badUser = await api('POST', '/api/admin/login', { json: { username: 'nobody', password: 'x' } });
  ok('不存在账号 → 401 同样提示', badUser.status === 401 && badUser.data.error === '账号或密码错误', badUser.data);

  const login = await api('POST', '/api/admin/login', { json: { username: 'admin', password: 'change-this-password' } });
  ok('最高管理员登录成功并返回令牌', login.status === 200 && !!login.data.token && login.data.admin.role === 'super', login.data);
  const token = login.data.token;

  const noAuth = await api('GET', '/api/applications');
  ok('未登录访问列表 → 401', noAuth.status === 401, noAuth.data);

  /* ---------- 3. 上传 ---------- */
  console.log('\n[3] 文件上传');
  const up1 = await uploadImage([200, 60, 60]);
  ok('上传 PNG 图片成功', up1.status === 200 && up1.data.url.startsWith('/uploads/'), up1.data);
  const up2 = await uploadImage([60, 120, 200]);
  ok('上传第二张 PNG 图片成功', up2.status === 200 && !!up2.data.url, up2.data);

  const fakeImg = await api('POST', '/api/upload?kind=image&ext=png', { raw: Buffer.from('<html>not an image</html>'), headers: { 'Content-Type': 'application/octet-stream' } });
  ok('伪装成 png 的文本被魔数校验拒绝', fakeImg.status === 400, fakeImg.data);

  const shortAudio = await uploadAudio(5);
  ok('5 秒音频被拒绝（要求≥15秒）', shortAudio.status === 400 && /时长不足/.test(shortAudio.data.error), shortAudio.data);
  const goodAudio = await uploadAudio(18);
  ok('18 秒 WAV 上传成功并解析出时长', goodAudio.status === 200 && goodAudio.data.duration >= 17 && goodAudio.data.duration <= 19, goodAudio.data);

  /* ---------- 4. 提交申请与校验 ---------- */
  console.log('\n[4] 提交申请（含联动校验）');
  const missing = await api('POST', '/api/applications', { json: { cn: '缺项测试' } });
  ok('缺项提交 → 400 且返回错误列表', missing.status === 400 && Array.isArray(missing.data.errors) && missing.data.errors.length > 0, missing.data);

  const condErr = await api('POST', '/api/applications', { json: basePayload({ hasExperience: '有', experienceDesc: '' }) });
  ok('第08题选“有”但第09题空白 → 报错', condErr.status === 400 && /第09题/.test(condErr.data.error), condErr.data);

  /* ---------- 4b. QQ号校验（必填 / 仅数字 / 5-11 位） ---------- */
  console.log('\n[4b] QQ号校验');
  const qqEmpty = await api('POST', '/api/applications', { json: basePayload({ qq: '' }) });
  ok('QQ号为空 → 「QQ号为必填项，请填写」',
    qqEmpty.status === 400 && qqEmpty.data.error === 'QQ号为必填项，请填写', qqEmpty.data);
  const qqNaN = await api('POST', '/api/applications', { json: basePayload({ qq: '12a45' }) });
  ok('QQ号含非数字 → 「QQ号只能填写数字」',
    qqNaN.status === 400 && qqNaN.data.error === 'QQ号只能填写数字', qqNaN.data);
  const qqSpace = await api('POST', '/api/applications', { json: basePayload({ qq: '123 456' }) });
  ok('QQ号含空格 → 「QQ号只能填写数字」',
    qqSpace.status === 400 && qqSpace.data.error === 'QQ号只能填写数字', qqSpace.data);
  const qqShort = await api('POST', '/api/applications', { json: basePayload({ qq: '1234' }) });
  ok('QQ号 4 位 → 「QQ号长度需要5-11位」',
    qqShort.status === 400 && qqShort.data.error === 'QQ号长度需要5-11位', qqShort.data);
  const qqLong = await api('POST', '/api/applications', { json: basePayload({ qq: '123456789012' }) });
  ok('QQ号 12 位 → 「QQ号长度需要5-11位」',
    qqLong.status === 400 && qqLong.data.error === 'QQ号长度需要5-11位', qqLong.data);
  const qq5 = await api('POST', '/api/applications', { json: basePayload({ cn: 'QQ边界5', qq: '12345' }) });
  ok('QQ号 5 位边界 → 允许提交', qq5.status === 200, qq5.data);
  const qq11 = await api('POST', '/api/applications', { json: basePayload({ cn: 'QQ边界11', qq: '12345678901' }) });
  ok('QQ号 11 位边界 → 允许提交', qq11.status === 200, qq11.data);

  const deptErr = await api('POST', '/api/applications', { json: basePayload({ department: 'COS部', workImages: [] }) });
  ok('选 COS 部未传作品图 → 报错', deptErr.status === 400 && /需上传作品图片/.test(deptErr.data.error), deptErr.data);

  const cvErr = await api('POST', '/api/applications', { json: basePayload({ department: 'CV部', workAudio: '' }) });
  ok('选 CV 部未传录音 → 报错', cvErr.status === 400 && /录音/.test(cvErr.data.error), cvErr.data);

  const sub1 = await api('POST', '/api/applications', {
    json: basePayload({ cn: '星野澪', department: 'COS部', workImages: [up1.data.url, up2.data.url], referralCode: 'JZ2026' })
  });
  ok('COS 部申请提交成功', sub1.status === 200 && sub1.data.ok === true, sub1.data);
  const app1Id = sub1.data.id;

  const sub2 = await api('POST', '/api/applications', {
    json: basePayload({ cn: '白河千夏', department: 'CV部', workAudio: goodAudio.data.url, hasExperience: '无', experienceDesc: '' })
  });
  ok('CV 部申请提交成功（无经验时第09题免填）', sub2.status === 200 && sub2.data.ok === true, sub2.data);
  const app2Id = sub2.data.id;

  const sub3 = await api('POST', '/api/applications', { json: basePayload({ cn: '黑猫', department: '后勤部' }) });
  ok('后勤部申请提交成功（无需作品）', sub3.status === 200, sub3.data);

  /* 新增部门【宣传部】：不提交任何作品资料也能通过校验 */
  const pubSub = await api('POST', '/api/applications', {
    json: basePayload({ cn: '宣传部测试员', qq: '112233445', department: '宣传部' })
  });
  ok('【宣传部】不提交任何作品资料即可提交成功', pubSub.status === 200 && pubSub.data.ok === true, pubSub.data);
  const pubId = pubSub.data.id;
  const pubDetail = await api('GET', `/api/applications/${pubId}`, { token });
  ok('【宣传部】申请的附件数量为 0',
    (!pubDetail.data.application.workImages || pubDetail.data.application.workImages.length === 0) &&
    !pubDetail.data.application.workAudio, {
    workImages: pubDetail.data.application.workImages, workAudio: pubDetail.data.application.workAudio
  });
  const pubList = await api('GET', '/api/applications?department=' + encodeURIComponent('宣传部'), { token });
  ok('列表可按【宣传部】筛选', pubList.status === 200 &&
    pubList.data.applications.length > 0 &&
    pubList.data.applications.every(a => a.department === '宣传部'), pubList.data.applications.map(a => a.department));
  const pubApprove = await api('POST', `/api/applications/${pubId}/review`, {
    token, json: { action: 'approve', department: '宣传部' }
  });
  ok('【宣传部】可直接审核通过（推荐部门选宣传部）',
    pubApprove.status === 200 && pubApprove.data.application.status === 'approved', pubApprove.data);
  ok('审核通过无需任何附件前置条件', pubApprove.data.application.recommendedDepartment === '宣传部');

  /* ---------- 5. 状态查询（公开） ---------- */
  console.log('\n[5] 审核状态查询页接口');
  const noCn = await api('POST', '/api/status-query', { json: {} });
  ok('空 CN → 400', noCn.status === 400, noCn.data);
  const notFound = await api('POST', '/api/status-query', { json: { cn: '不存在的CNxyz' } });
  ok('查不到 → 404 且提示', notFound.status === 404 && /未查询到/.test(notFound.data.error), notFound.data);

  const q1 = await api('POST', '/api/status-query', { json: { cn: '星野澪' } });
  ok('刚提交 → 状态「已提交申请」', q1.status === 200 && q1.data.results[0].statusLabel === '已提交申请', q1.data);
  ok('查询结果不含敏感字段（审核人/哈希）', !JSON.stringify(q1.data).includes('reviewedBy') && !JSON.stringify(q1.data).includes('hash'), q1.data);

  const fuzzy = await api('POST', '/api/status-query', { json: { cn: '星野' } });
  ok('部分 CN（模糊）已不再返回结果 → 404（防批量枚举）', fuzzy.status === 404, { status: fuzzy.status, data: fuzzy.data });
  const exact = await api('POST', '/api/status-query', { json: { cn: '星野澪' } });
  ok('完整 CN 精确匹配 → 200', exact.status === 200 && exact.data.results.length >= 1, exact.status);
  const oneChar = await api('POST', '/api/status-query', { json: { cn: '星' } });
  ok('单字符查询被拒绝 → 400', oneChar.status === 400, oneChar.data);

  /* ---------- 6. 详情页自动置为「审核员查看中」 ---------- */
  console.log('\n[6] 打开详情 → 审核员查看中');
  const detail = await api('GET', '/api/applications/' + app1Id, { token });
  ok('详情返回完整字段', detail.status === 200 && detail.data.application.cn === '星野澪' && detail.data.application.workImages.length === 2, detail.data && detail.data.application && detail.data.application.cn);
  ok('详情返回 QQ号', detail.data.application.qq === '123456789', detail.data.application.qq);
  ok('首次打开自动置为「审核员查看中」', detail.data.autoViewed === true && detail.data.application.status === 'viewing', detail.data);
  const detail2 = await api('GET', '/api/applications/' + app1Id, { token });
  ok('再次打开不再重复变更', detail2.data.autoViewed === false, detail2.data);

  /* ---------- 6b. 附件访问签名（不再公开可读） ---------- */
  console.log('\n[6b] 附件访问签名');
  const signedImg = detail.data.application.workImages[0];
  ok('详情接口返回的附件链接带签名', /\?e=\d+&s=[0-9a-f]{32}$/.test(signedImg), signedImg);
  const unsignedUrl = signedImg.split('?')[0];
  const rUnsigned = await api('GET', unsignedUrl);
  ok('未签名的附件链接 → 403（不再公开可读）', rUnsigned.status === 403, rUnsigned.status);
  const rSigned = await api('GET', signedImg);
  ok('带正确签名的附件链接 → 200', rSigned.status === 200 && Buffer.isBuffer(rSigned.data) && rSigned.data.length > 0, rSigned.status);
  const tampered = unsignedUrl + '?e=' + (Date.now() + 3600000) + '&s=' + '0'.repeat(32);
  const rTampered = await api('GET', tampered);
  ok('签名被伪造 → 403', rTampered.status === 403, rTampered.status);
  const expired = unsignedUrl + '?e=' + (Date.now() - 1000) + '&s=' + (signedImg.match(/s=([0-9a-f]+)/) || [])[1];
  const rExpired = await api('GET', expired);
  ok('签名已过期 → 403', rExpired.status === 403, rExpired.status);

  const q2 = await api('POST', '/api/status-query', { json: { cn: '星野澪' } });
  ok('查询页显示「审核员查看中」', q2.data.results[0].statusLabel === '审核员查看中', q2.data);

  /* ---------- 7. 审核通过 ---------- */
  console.log('\n[7] 审核操作');
  const badApprove = await api('POST', `/api/applications/${app1Id}/review`, { token, json: { action: 'approve', department: '不存在的部门' } });
  ok('审核通过未选部门 → 400', badApprove.status === 400, badApprove.data);

  const approve = await api('POST', `/api/applications/${app1Id}/review`, { token, json: { action: 'approve', department: 'COS部' } });
  ok('审核通过成功并记录推荐部门', approve.status === 200 && approve.data.application.status === 'approved' && approve.data.application.recommendedDepartment === 'COS部', approve.data);
  ok('记录审核人与审核时间', approve.data.application.reviewedBy === 'admin' && !!approve.data.application.reviewedAtText, approve.data.application.reviewedBy);

  const again = await api('POST', `/api/applications/${app1Id}/review`, { token, json: { action: 'reject', reason: '其他', reasonText: '再试一次' } });
  ok('已审核记录不可二次修改 → 409', again.status === 409 && /不可逆/.test(again.data.error), again.data);

  const q3 = await api('POST', '/api/status-query', { json: { cn: '星野澪' } });
  ok('查询页显示「审核通过」+ 推荐部门', q3.data.results[0].statusLabel === '审核通过' && q3.data.results[0].recommendedDepartment === 'COS部', q3.data);

  /* ---------- 8. 审核拒绝 ---------- */
  const badReject = await api('POST', `/api/applications/${app2Id}/review`, { token, json: { action: 'reject', reason: '其他', reasonText: '' } });
  ok('选“其他”但未填自定义原因 → 400', badReject.status === 400 && /自定义拒绝原因/.test(badReject.data.error), badReject.data);

  const badReason = await api('POST', `/api/applications/${app2Id}/review`, { token, json: { action: 'reject', reason: '随便编的理由' } });
  ok('非法拒绝理由 → 400', badReason.status === 400, badReason.data);

  const reject = await api('POST', `/api/applications/${app2Id}/review`, { token, json: { action: 'reject', reason: '不符合入社部门要求' } });
  ok('审核拒绝成功并保存理由', reject.status === 200 && reject.data.application.status === 'rejected' && reject.data.application.rejectReason === '不符合入社部门要求', reject.data);

  const q4 = await api('POST', '/api/status-query', { json: { cn: '白河千夏' } });
  ok('查询页显示「审核拒绝」+ 理由', q4.data.results[0].statusLabel === '审核拒绝' && /不符合入社部门要求/.test(q4.data.results[0].rejectReason), q4.data);

  /* ---------- 9. 筛选 / 搜索 ---------- */
  console.log('\n[8] 列表筛选与搜索');
  const listAll = await api('GET', '/api/applications', { token });
  ok('列表返回统计信息', listAll.status === 200 && typeof listAll.data.stats.total === 'number', listAll.data && listAll.data.stats);
  const fDept = await api('GET', '/api/applications?department=' + encodeURIComponent('COS部'), { token });
  ok('按部门筛选', fDept.data.applications.every(a => a.department === 'COS部') && fDept.data.applications.length >= 1, fDept.data.filtered);
  const fStatus = await api('GET', '/api/applications?status=rejected', { token });
  ok('按状态筛选', fStatus.data.applications.every(a => a.status === 'rejected'), fStatus.data.filtered);
  const fQ = await api('GET', '/api/applications?q=' + encodeURIComponent('星野'), { token });
  ok('按 CN 模糊搜索', fQ.data.applications.length >= 1 && fQ.data.applications.every(a => a.cn.includes('星野')), fQ.data.filtered);
  ok('列表摘要按状态给出中文文案', listAll.data.applications.every(a => !!a.statusLabel), listAll.data.applications[0]);
  ok('列表摘要包含 QQ号（供列表开关展示）',
    listAll.data.applications.every(a => typeof a.qq === 'string'), listAll.data.applications[0]);
  const qqRec = listAll.data.applications.find(a => a.cn === '星野澪');
  ok('QQ号取值正确', qqRec && qqRec.qq === '123456789', qqRec && qqRec.qq);

  /* ---------- 10. 管理员账号与权限 ---------- */
  console.log('\n[9] 管理员账号与权限');
  const adminList = await api('GET', '/api/admins', { token });
  ok('最高权限可查看账号列表', adminList.status === 200 && adminList.data.admins.length >= 1, adminList.data);
  ok('最高管理员标记为不可删除', adminList.data.admins.find(a => a.role === 'super').deletable === false, adminList.data.admins);

  const dup = await api('POST', '/api/admins', { token, json: { username: 'admin', password: 'abc123456' } });
  ok('重复账号名 → 409', dup.status === 409, dup.data);
  const weak = await api('POST', '/api/admins', { token, json: { username: 'reviewer1', password: '123' } });
  ok('弱密码 → 400', weak.status === 400, weak.data);

  const newAdm = await api('POST', '/api/admins', { token, json: { username: 'reviewer1', password: 'review123', note: '审核员一号' } });
  ok('新增分管理员成功', newAdm.status === 200 && newAdm.data.admin.role === 'sub', newAdm.data);
  const subId = newAdm.data.admin.id;

  const subLogin = await api('POST', '/api/admin/login', { json: { username: 'reviewer1', password: 'review123' } });
  ok('分管理员可登录', subLogin.status === 200 && subLogin.data.admin.role === 'sub', subLogin.data);
  const subToken = subLogin.data.token;

  /* 超管设置子账号备注 */
  const noteFail = await api('PUT', '/api/admins/' + subId, { token: subToken, json: { note: '越权备注' } });
  ok('分管理员设置备注 → 403', noteFail.status === 403, noteFail.data);
  const noteSet = await api('PUT', '/api/admins/' + subId, { token, json: { note: 'COS部长' } });
  ok('超管可设置子账号备注', noteSet.status === 200 && noteSet.data.admin.note === 'COS部长', noteSet.data);
  const subLogin2 = await api('POST', '/api/admin/login', { json: { username: 'reviewer1', password: 'review123' } });
  ok('子账号登录响应带备注（供右上角展示）', subLogin2.status === 200 && subLogin2.data.admin.note === 'COS部长', subLogin2.data && subLogin2.data.admin);
  const noteClear = await api('PUT', '/api/admins/' + subId, { token, json: { note: '' } });
  ok('备注可清空', noteClear.status === 200 && noteClear.data.admin.note === '', noteClear.data);
  const noteMiss = await api('PUT', '/api/admins/NOT-EXIST', { token, json: { note: 'x' } });
  ok('对不存在的账号设置备注 → 404', noteMiss.status === 404, noteMiss.data);
  const noteNoAuth = await api('PUT', '/api/admins/' + subId, { json: { note: 'x' } });
  ok('未登录设置备注 → 401', noteNoAuth.status === 401, noteNoAuth.data);

  const subList = await api('GET', '/api/applications', { token: subToken });
  ok('分管理员可查看申请列表', subList.status === 200, subList.status);
  const subDetail = await api('GET', '/api/applications/' + app2Id, { token: subToken });
  ok('分管理员可查看申请详情', subDetail.status === 200, subDetail.status);
  const subAdmins = await api('GET', '/api/admins', { token: subToken });
  ok('分管理员查看账号管理 → 403', subAdmins.status === 403, subAdmins.data);
  const subCreate = await api('POST', '/api/admins', { token: subToken, json: { username: 'hacker', password: 'hack123456' } });
  ok('分管理员新增账号 → 403', subCreate.status === 403, subCreate.data);
  const subDel = await api('DELETE', '/api/admins/' + subId, { token: subToken });
  ok('分管理员删除账号 → 403', subDel.status === 403, subDel.data);

  const listAfterCreate = await api('GET', '/api/applications', { token });
  const pendingRec = listAfterCreate.data.applications.find(a => a.status === 'submitted');
  if (pendingRec) {
    const subReview = await api('POST', `/api/applications/${pendingRec.id}/review`, { token: subToken, json: { action: 'approve', department: '后勤部' } });
    ok('分管理员可执行审核操作', subReview.status === 200, subReview.data);
  } else {
    ok('分管理员可执行审核操作（跳过：无待审核记录）', true);
  }

  /* ---------- 9b. 账号停用 / 解封（超管独有） ---------- */
  console.log('\n[9b] 账号停用 / 解封');
  const ymd = ts => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(ts).reduce((o, x) => (o[x.type] = x.value, o), {});
  const t1 = ymd(Date.now() + 24 * 3600 * 1000);
  const tomorrowYmd = `${t1.year}-${t1.month}-${t1.day}`;
  const superId = adminList.data.admins.find(a => a.role === 'super').id;

  const banBySub = await api('POST', `/api/admins/${subId}/ban`, { token: subToken, json: { enabled: true, until: tomorrowYmd, reason: '越权测试' } });
  ok('分管理员停用账号 → 403（权限隔离）', banBySub.status === 403, banBySub.data);
  const banSuper = await api('POST', `/api/admins/${superId}/ban`, { token, json: { enabled: true, until: tomorrowYmd, reason: 'x' } });
  ok('停用最高管理员 → 403 拒绝', banSuper.status === 403, banSuper.data);
  const banNoAuth = await api('POST', `/api/admins/${subId}/ban`, { json: { enabled: true, until: tomorrowYmd, reason: 'x' } });
  ok('未登录停用 → 401', banNoAuth.status === 401, banNoAuth.data);

  const noDate = await api('POST', `/api/admins/${subId}/ban`, { token, json: { enabled: true, reason: 'x' } });
  ok('未选解封日期 → 400', noDate.status === 400, noDate.data);
  const pastDate = await api('POST', `/api/admins/${subId}/ban`, { token, json: { enabled: true, until: '2020-01-01', reason: 'x' } });
  ok('解封日期为过去 → 400', pastDate.status === 400, pastDate.data);
  const noReason = await api('POST', `/api/admins/${subId}/ban`, { token, json: { enabled: true, until: tomorrowYmd, reason: '' } });
  ok('未填封禁理由 → 400', noReason.status === 400, noReason.data);

  const banOk = await api('POST', `/api/admins/${subId}/ban`, { token, json: { enabled: true, until: tomorrowYmd, reason: '多次缺席社团活动' } });
  ok('超管停用子账号成功', banOk.status === 200 && banOk.data.admin.banned === true, banOk.data);
  ok('保存了停用开始时间 / 解封日期 / 封禁理由',
    !!banOk.data.admin.bannedAtText && banOk.data.admin.banUntilText === `${t1.year}年${t1.month}月${t1.day}日` &&
    banOk.data.admin.banReason === '多次缺席社团活动', banOk.data.admin);

  const bannedLogin = await api('POST', '/api/admin/login', { json: { username: 'reviewer1', password: 'review123' } });
  ok('被停用账号登录 → 403 且标记 banned', bannedLogin.status === 403 && bannedLogin.data.banned === true, bannedLogin.data);
  ok('提示文案为「您的账户已被示例动漫社停用」',
    bannedLogin.data.error === '您的账户已被示例动漫社停用', bannedLogin.data.error);
  ok('返回停用开始时间 / 解封时间 / 封禁原因 三项',
    !!bannedLogin.data.ban.bannedAtText && !!bannedLogin.data.ban.banUntilText &&
    bannedLogin.data.ban.banReason === '多次缺席社团活动', bannedLogin.data.ban);

  const wrongPass = await api('POST', '/api/admin/login', { json: { username: 'reviewer1', password: 'wrong-pass' } });
  ok('停用账号+错误密码 → 仍返回 401（不泄露账号是否被封）',
    wrongPass.status === 401 && !wrongPass.data.banned, wrongPass.data);

  const bannedToken = await api('GET', '/api/applications', { token: subToken });
  ok('已停用账号的旧令牌立即失效 → 401', bannedToken.status === 401, bannedToken.status);
  const bannedReview = await api('POST', `/api/applications/${app2Id}/review`, { token: subToken, json: { action: 'approve', department: '后勤部' } });
  ok('已停用账号不能执行审核 → 401', bannedReview.status === 401, bannedReview.status);

  const unban = await api('POST', `/api/admins/${subId}/ban`, { token, json: { enabled: false } });
  ok('开关关闭 = 解除停用', unban.status === 200 && unban.data.admin.banned === false, unban.data);
  const afterUnban = await api('POST', '/api/admin/login', { json: { username: 'reviewer1', password: 'review123' } });
  ok('解除后恢复登录权限', afterUnban.status === 200 && afterUnban.data.ok === true, afterUnban.status);

  const superDel = await api('DELETE', '/api/admins/' + adminList.data.admins.find(a => a.role === 'super').id, { token });
  ok('删除最高管理员 → 403 拒绝', superDel.status === 403 && /不可删除/.test(superDel.data.error), superDel.data);

  const delSub = await api('DELETE', '/api/admins/' + subId, { token });
  ok('删除分管理员成功', delSub.status === 200, delSub.data);

  const subTokenAfterDelete = await api('GET', '/api/admin/me', { token: subToken });
  ok('被删除账号的令牌立即失效 → 401', subTokenAfterDelete.status === 401, subTokenAfterDelete.data);

  /* ---------- 11. Excel 导出 ---------- */
  console.log('\n[10] Excel 导出（图片内嵌）');
  const exp = await api('GET', '/api/export', { token });
  ok('导出返回 xlsx 二进制', exp.status === 200 && Buffer.isBuffer(exp.data) && exp.data.length > 3000, exp.status);
  ok('响应头为 xlsx 类型', (exp.headers.get('content-type') || '').includes('spreadsheetml'), exp.headers.get('content-type'));
  const expFile = path.join(OUT_DIR, 'api-test-export.xlsx');
  fs.writeFileSync(expFile, exp.data);
  console.log('     已写出：' + expFile + '（' + exp.data.length + ' 字节）');

  const expNoAuth = await api('GET', '/api/export');
  ok('未登录导出 → 401', expNoAuth.status === 401, expNoAuth.status);

  /* ---------- 11. 上传滥用防护（放最后，避免耗尽限流影响前面用例） ---------- */
  console.log('\n[11] 上传滥用防护');

  /* 解压炸弹：IHDR 声明 20000×20000，实际数据极小 —— 必须在生成缩略图前就被拒绝 */
  const bomb = await api('POST', '/api/upload?kind=image&ext=png', {
    raw: makeBombPng(20000, 20000), headers: { 'Content-Type': 'application/octet-stream' }
  });
  ok('声明 20000×20000 的「解压炸弹」图片被拒绝 → 400', bomb.status === 400, bomb.data);

  const normalDim = await api('POST', '/api/upload?kind=image&ext=png', {
    raw: makePng(600, 480, [1, 2, 3]), headers: { 'Content-Type': 'application/octet-stream' }
  });
  ok('尺寸正常的图片仍可上传', normalDim.status === 200, normalDim.status);

  let upOk = 0, up429 = 0;
  const tiny = makePng(8, 8, [10, 20, 30]);
  for (let i = 0; i < 40; i++) {
    /* 这里故意用 rawApi：要的就是看到 429（api() 会自动重试，看不到限流） */
    const r = await rawApi('POST', '/api/upload?kind=image&ext=png', {
      raw: tiny, headers: { 'Content-Type': 'application/octet-stream' }
    });
    if (r.status === 200) upOk++;
    else if (r.status === 429) up429++;
  }
  ok('上传超过 30 次/分钟后被限流', up429 > 0, { upOk, up429 });

  /* ---------- 12. 退回 → 复审 → 重新审核 ---------- */
  console.log('\n[12] 退回 / 复审流程');
  const revName = 'reviewer_rs_' + Date.now().toString().slice(-5);
  await api('POST', '/api/admins', { token, json: { username: revName, password: 'review123' } });
  const revLogin = await api('POST', '/api/admin/login', { json: { username: revName, password: 'review123' } });
  ok('建立复审流程测试用审核员账号', revLogin.status === 200, revLogin.status);
  const revToken = revLogin.data.token;

  const RS_CN = '复审测试员';
  const RS_QQ = '246813579';
  const rsSub = await api('POST', '/api/applications', { json: basePayload({ cn: RS_CN, qq: RS_QQ, department: '后勤部' }) });
  ok('提交用于复审测试的申请', rsSub.status === 200, rsSub.data);
  const rsId = rsSub.data.id;

  const noRetReason = await api('POST', `/api/applications/${rsId}/review`, { token: revToken, json: { action: 'return' } });
  ok('退回未填原因 → 400', noRetReason.status === 400 && /退回原因/.test(noRetReason.data.error), noRetReason.data);

  const ret = await api('POST', `/api/applications/${rsId}/review`, { token: revToken, json: { action: 'return', reason: '作品图片不足，请补充' } });
  ok('审核员退回成功 → 状态 returned', ret.status === 200 && ret.data.application.status === 'returned', ret.data && ret.data.application && ret.data.application.status);
  ok('退回原因已保存', ret.data.application.returnReason === '作品图片不足，请补充', ret.data.application.returnReason);

  const qr = await api('POST', '/api/status-query', { json: { cn: RS_CN } });
  const rr = qr.data.results[0];
  ok('查询页状态显示「该申请表被退回」', rr.statusLabel === '该申请表被退回', rr.statusLabel);
  ok('查询页显示退回原因', rr.returnReason === '作品图片不足，请补充', rr.returnReason);
  ok('查询页标记可复审（canResubmit = true）', rr.canResubmit === true, rr.canResubmit);

  const wrongQq = await api('GET', `/api/applications/${rsId}/edit-data?cn=${encodeURIComponent(RS_CN)}&qq=000000000`);
  ok('QQ号不匹配 → 404（读不到待编辑数据）', wrongQq.status === 404, wrongQq.status);
  const wrongCn = await api('GET', `/api/applications/${rsId}/edit-data?cn=${encodeURIComponent('别人')}&qq=${RS_QQ}`);
  ok('CN 不匹配 → 404', wrongCn.status === 404, wrongCn.status);
  const editOk = await api('GET', `/api/applications/${rsId}/edit-data?cn=${encodeURIComponent(RS_CN)}&qq=${RS_QQ}`);
  ok('CN + QQ 双重校验通过 → 可读取待编辑数据', editOk.status === 200 && editOk.data.application.cn === RS_CN, editOk.status);

  /* 复审提交同样要过完整表单校验（此时机会还没用掉，能测出 400） */
  const badResubmit = await api('POST', `/api/applications/${rsId}/resubmit`, {
    json: basePayload({ cn: RS_CN, qq: RS_QQ, department: '后勤部', age: '999' })
  });
  ok('复审表单仍受完整校验（年龄非法 → 400）', badResubmit.status === 400 && /年龄/.test(badResubmit.data.error), badResubmit.data);

  const rs = await api('POST', `/api/applications/${rsId}/resubmit`, {
    json: basePayload({ cn: RS_CN, qq: RS_QQ, department: '后勤部', hobbies: '修改后的兴趣' })
  });
  ok('提交复审成功', rs.status === 200 && rs.data.ok === true, rs.data);

  const qr2 = await api('POST', '/api/status-query', { json: { cn: RS_CN } });
  const rr2 = qr2.data.results[0];
  ok('查询页状态变为「已提交复审申请」', rr2.statusLabel === '已提交复审申请', rr2.statusLabel);
  ok('查询页标记 isResubmit = true（时间线首节点文案随之变化）', rr2.isResubmit === true, rr2.isResubmit);
  ok('已使用 1/2 次机会', rr2.resubmitCount === 1 && rr2.resubmitMax === 2, rr2.resubmitCount);
  ok('复审等待审核中 → 不显示按钮（canResubmit = false）', rr2.canResubmit === false, rr2.canResubmit);

  const rs2 = await api('POST', `/api/applications/${rsId}/resubmit`, {
    json: basePayload({ cn: RS_CN, qq: RS_QQ, department: '后勤部' })
  });
  ok('复审审核中再次提交 → 409（状态不支持）', rs2.status === 409 && /不支持/.test(rs2.data.error), rs2.data);

  const editAfter = await api('GET', `/api/applications/${rsId}/edit-data?cn=${encodeURIComponent(RS_CN)}&qq=${RS_QQ}`);
  ok('复审待审核期间不可再进入编辑 → 403', editAfter.status === 403, editAfter.status);

  const listRs = await api('GET', '/api/applications?q=' + encodeURIComponent(RS_CN), { token });
  const rsRow = listRs.data.applications[0];
  ok('列表标记为「复审申请表」（resubmitUsed）', rsRow.resubmitUsed === true, rsRow);
  ok('列表状态为「复审待审核」', rsRow.statusLabel === '复审待审核', rsRow.statusLabel);

  /* ---------- 12b. 复审被【退回】→ 额外获得第 2 次机会（新规则） ---------- */
  console.log('\n[12b] 复审被退回 → 第 2 次机会');
  await api('GET', `/api/applications/${rsId}`, { token: revToken });
  const ret2 = await api('POST', `/api/applications/${rsId}/review`, { token: revToken, json: { action: 'return', reason: '复审后仍缺材料，请再补充' } });
  ok('复审申请被审核员退回', ret2.status === 200 && ret2.data.application.status === 'returned', ret2.data && ret2.data.application && ret2.data.application.status);

  const qr3 = await api('POST', '/api/status-query', { json: { cn: RS_CN } });
  const rr3 = qr3.data.results[0];
  ok('复审被退回后状态文案为「复审申请被退回」', rr3.statusLabel === '复审申请被退回', rr3.statusLabel);
  ok('复审被退回后【再次】出现复审机会（canResubmit = true）', rr3.canResubmit === true, rr3.canResubmit);
  ok('已使用 1/2 次，下一次是第 2 次', rr3.resubmitCount === 1 && rr3.resubmitNextNo === 2, rr3.resubmitCount);
  ok('标记为最后一次机会（resubmitIsLast = true）', rr3.resubmitIsLast === true, rr3.resubmitIsLast);
  ok('已退回 2 次但未用尽 → resubmitEnded = false', rr3.resubmitEnded === false, rr3.resubmitEnded);

  const edit2 = await api('GET', `/api/applications/${rsId}/edit-data?cn=${encodeURIComponent(RS_CN)}&qq=${RS_QQ}`);
  ok('第 2 次机会可以重新读取待编辑数据', edit2.status === 200, edit2.status);
  const rs3 = await api('POST', `/api/applications/${rsId}/resubmit`, {
    json: basePayload({ cn: RS_CN, qq: RS_QQ, department: '后勤部', hobbies: '第二次复审修改' })
  });
  ok('第 2 次提交复审成功', rs3.status === 200 && rs3.data.resubmitCount === 2, rs3.data);

  const qr4 = await api('POST', '/api/status-query', { json: { cn: RS_CN } });
  const rr4 = qr4.data.results[0];
  ok('已使用 2/2 次机会', rr4.resubmitCount === 2, rr4.resubmitCount);
  ok('复审2 再次被退回 → 不再给机会（本次为退回）',
    (await api('POST', `/api/applications/${rsId}/review`, { token: revToken, json: { action: 'return', reason: '第三次退回' } })).data.application.status === 'returned');
  const qr5 = await api('POST', '/api/status-query', { json: { cn: RS_CN } });
  const rr5 = qr5.data.results[0];
  ok('用完 2 次后【不再显示】复审按钮（canResubmit = false）', rr5.canResubmit === false, rr5.canResubmit);
  ok('明确标记机会已用尽（resubmitEnded = true）', rr5.resubmitEnded === true, rr5.resubmitEnded);
  ok('用尽原因说明「已用完 2 次」', /已用完 2 次/.test(rr5.resubmitReason || ''), rr5.resubmitReason);
  const rs4 = await api('POST', `/api/applications/${rsId}/resubmit`, {
    json: basePayload({ cn: RS_CN, qq: RS_QQ, department: '后勤部' })
  });
  ok('第 3 次提交复审 → 409（超出上限）', rs4.status === 409 && /已用完 2 次/.test(rs4.data.error), rs4.data);

  /* ---------- 12c. 复审后被【拒绝】→ 直接结束，不再给机会 ---------- */
  console.log('\n[12c] 复审被拒绝 → 永久结束');
  const RJ_CN = '复审被拒测试员';
  const rjSub = await api('POST', '/api/applications', { json: basePayload({ cn: RJ_CN, qq: '975312468', department: '后勤部' }) });
  const rjId = rjSub.data.id;
  ok('（准备）提交初审被拒绝的申请',
    (await api('POST', `/api/applications/${rjId}/review`, { token: revToken, json: { action: 'reject', reason: '不符合入社部门要求' } })).data.application.status === 'rejected');
  const rjQ1 = await api('POST', '/api/status-query', { json: { cn: RJ_CN } });
  ok('初审拒绝 → 显示复审按钮', rjQ1.data.results[0].canResubmit === true, rjQ1.data.results[0].canResubmit);
  const rjRs = await api('POST', `/api/applications/${rjId}/resubmit`, {
    json: basePayload({ cn: RJ_CN, qq: '975312468', department: '后勤部' })
  });
  ok('提交第 1 次复审', rjRs.status === 200 && rjRs.data.resubmitCount === 1, rjRs.data);
  const rjRej = await api('POST', `/api/applications/${rjId}/review`, { token: revToken, json: { action: 'reject', reason: '不符合入社部门要求' } });
  ok('复审申请被审核拒绝', rjRej.status === 200 && rjRej.data.application.status === 'rejected', rjRej.data);
  const rjQ2 = await api('POST', '/api/status-query', { json: { cn: RJ_CN } });
  const rjR2 = rjQ2.data.results[0];
  ok('复审被拒绝后【永久不再显示】复审按钮', rjR2.canResubmit === false, rjR2.canResubmit);
  ok('虽只用 1 次但已结束（resubmitEnded = true）', rjR2.resubmitEnded === true, rjR2.resubmitEnded);
  ok('原因说明「复审申请已被审核拒绝」', /已被审核拒绝/.test(rjR2.resubmitReason || ''), rjR2.resubmitReason);
  const rjEdit = await api('GET', `/api/applications/${rjId}/edit-data?cn=${encodeURIComponent(RJ_CN)}&qq=975312468`);
  ok('复审被拒后不可再进入编辑 → 403', rjEdit.status === 403, rjEdit.status);
  const rjRs2 = await api('POST', `/api/applications/${rjId}/resubmit`, {
    json: basePayload({ cn: RJ_CN, qq: '975312468', department: '后勤部' })
  });
  ok('复审被拒后再次提交 → 409', rjRs2.status === 409, rjRs2.data);

  /* ---------- 12d. 初次【退回】（未用过机会）也给 1 次（本需求确认的规则） ---------- */
  console.log('\n[12d] 初审被退回 → 1 次机会');
  const RT_CN = '初次退回测试员';
  const rtSub = await api('POST', '/api/applications', { json: basePayload({ cn: RT_CN, qq: '864209753', department: '后勤部' }) });
  const rtId = rtSub.data.id;
  await api('POST', `/api/applications/${rtId}/review`, { token: revToken, json: { action: 'return', reason: '资料不全' } });
  const rtQ = await api('POST', '/api/status-query', { json: { cn: RT_CN } });
  const rtR = rtQ.data.results[0];
  ok('初审被退回 → 显示复审按钮', rtR.canResubmit === true, rtR.canResubmit);
  ok('初审被退回的状态文案仍是「该申请表被退回」', rtR.statusLabel === '该申请表被退回', rtR.statusLabel);
  ok('初审退回时已使用次数为 0', rtR.resubmitCount === 0, rtR.resubmitCount);
  ok('初审退回后可进入编辑', (await api('GET', `/api/applications/${rtId}/edit-data?cn=${encodeURIComponent(RT_CN)}&qq=864209753`)).status === 200);
  ok('初审退回后提交第 1 次复审成功',
    (await api('POST', `/api/applications/${rtId}/resubmit`, {
      json: basePayload({ cn: RT_CN, qq: '864209753', department: '后勤部' })
    })).data.resubmitCount === 1);

  /* ---------- 12e. 复审2 之后再退回：终态说明 + 复审中仍可正常审核 ---------- */
  console.log('\n[12e] 终态与回归');
  const rsFinal = await api('POST', `/api/applications/${rsId}/review`, { token: revToken, json: { action: 'approve', department: '后勤部' } });
  ok('机会用尽的【退回】状态属于终态：不能再直接审核（409）',
    rsFinal.status === 409 || rsFinal.status === 400, { code: rsFinal.status, data: rsFinal.data });

  const rtApprove = await api('POST', `/api/applications/${rtId}/review`, { token: revToken, json: { action: 'approve', department: '后勤部' } });
  ok('复审待审核的申请仍可正常审核通过',
    rtApprove.status === 200 && rtApprove.data.application.status === 'approved', rtApprove.data);
  const rtQ2 = await api('POST', '/api/status-query', { json: { cn: RT_CN } });
  ok('审核通过后不再显示复审按钮', rtQ2.data.results[0].canResubmit === false, rtQ2.data.results[0].canResubmit);


  /* ---------- 13. 无法决定 → 移交主审核官 ---------- */
  console.log('\n[13] 移交主审核官');
  const ES_CN = '移交测试员';
  const esSub = await api('POST', '/api/applications', { json: basePayload({ cn: ES_CN, qq: '135791357', department: '后勤部' }) });
  ok('提交用于移交测试的申请', esSub.status === 200, esSub.data);
  const esId = esSub.data.id;

  const esc = await api('POST', `/api/applications/${esId}/review`, { token: revToken, json: { action: 'escalate' } });
  ok('审核员「无法决定」→ 移交成功，状态 escalated',
    esc.status === 200 && esc.data.application.status === 'escalated', esc.data && esc.data.application && esc.data.application.status);
  ok('记录了移交人与时间', !!esc.data.application.escalatedBy && !!esc.data.application.escalatedAtText, esc.data.application.escalatedBy);

  const esQ = await api('POST', '/api/status-query', { json: { cn: ES_CN } });
  ok('查询页移交中显示「等待审核结果」', esQ.data.results[0].statusLabel === '等待审核结果', esQ.data.results[0].statusLabel);
  ok('移交中不可复审', esQ.data.results[0].canResubmit === false, esQ.data.results[0].canResubmit);

  const subListEsc = await api('GET', '/api/applications?q=' + encodeURIComponent(ES_CN), { token: revToken });
  ok('普通审核员列表中【不可见】已移交的申请', subListEsc.data.applications.length === 0, subListEsc.data.filtered);
  ok('列表返回被隐藏的数量（供前端提示）', (subListEsc.data.hiddenEscalated || 0) >= 1, subListEsc.data.hiddenEscalated);
  const subDetailEsc = await api('GET', `/api/applications/${esId}`, { token: revToken });
  ok('普通审核员查看已移交详情 → 403', subDetailEsc.status === 403, subDetailEsc.data);
  const subReviewEsc = await api('POST', `/api/applications/${esId}/review`, { token: revToken, json: { action: 'approve', department: '后勤部' } });
  ok('普通审核员审核已移交申请 → 403', subReviewEsc.status === 403, subReviewEsc.data);

  const supListEsc = await api('GET', '/api/applications?q=' + encodeURIComponent(ES_CN), { token });
  ok('超管列表中【可见】该申请', supListEsc.data.applications.length === 1, supListEsc.data.filtered);
  const supDetailEsc = await api('GET', `/api/applications/${esId}`, { token });
  ok('超管可查看已移交详情', supDetailEsc.status === 200, supDetailEsc.status);
  const supReviewEsc = await api('POST', `/api/applications/${esId}/review`, { token, json: { action: 'approve', department: '后勤部' } });
  ok('超管可审核已移交申请', supReviewEsc.status === 200 && supReviewEsc.data.application.status === 'approved', supReviewEsc.data);

  /* 清理测试子账号 */
  const adminsNow = await api('GET', '/api/admins', { token });
  const revRec = (adminsNow.data.admins || []).find(a => a.username === revName);
  if (revRec) await api('DELETE', '/api/admins/' + revRec.id, { token });
  ok('清理复审测试用子账号', true);

  /* ---------- 14. 系统设置 / 重启服务器（仅超管） ---------- */
  console.log('\n[14] 系统设置（仅超管可访问）');
  const sysNoAuth = await api('GET', '/api/system/info');
  ok('未登录查看服务器信息 → 401', sysNoAuth.status === 401, sysNoAuth.data);
  const sysRebootNoAuth = await api('POST', '/api/system/reboot', { json: {} });
  ok('未登录请求重启 → 401', sysRebootNoAuth.status === 401, sysRebootNoAuth.data);

  /* 专为本节建一个子账号，避免依赖前面用例残留的账号 */
  const sysSubName = 'sysrev_' + Date.now().toString().slice(-6);
  const sysSubAdd = await api('POST', '/api/admins', { token, json: { username: sysSubName, password: 'review123' } });
  const sysSubLogin = await api('POST', '/api/admin/login', { json: { username: sysSubName, password: 'review123' } });
  const sysSubToken = sysSubLogin.status === 200 ? sysSubLogin.data.token : '';
  ok('（准备）创建分管理员用于权限隔离验证', sysSubAdd.status === 200 && !!sysSubToken, sysSubLogin.data);

  const subInfo = await api('GET', '/api/system/info', { token: sysSubToken });
  ok('分管理员查看服务器信息 → 403', subInfo.status === 403, subInfo.data);
  const subReboot = await api('POST', '/api/system/reboot', { token: sysSubToken, json: {} });
  ok('分管理员请求重启 → 403（且不会真的重启）', subReboot.status === 403, subReboot.data);
  ok('拒绝文案说明缺少【系统设置权限】',
    /系统设置权限/.test((subReboot.data || {}).error || ''), subReboot.data);

  const sysInfo = await api('GET', '/api/system/info', { token });
  ok('超管可查看服务器信息', sysInfo.status === 200 && sysInfo.data.ok === true, sysInfo.status);
  const si = sysInfo.data.system || {};
  ok('返回服务器时间（东八区）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(si.serverTimeText || ''), si.serverTimeText);
  ok('返回系统运行时长', typeof si.uptimeText === 'string' && si.uptimeText.length > 0, si.uptimeText);
  ok('返回每日定时重启规则（0 0 * * *）', si.schedule && si.schedule.cron === '0 0 * * *', si.schedule);
  ok('下次定时重启时间为当日/次日 00:00:00',
    /00:00:00$/.test((si.schedule || {}).nextAtText || ''), (si.schedule || {}).nextAtText);
  ok('明确标注重启不删除业务数据',
    Array.isArray(si.dataSafety) && si.dataSafety.some(x => x.includes('applications.json')), si.dataSafety);
  ok('返回"是否具备重启能力"字段', typeof si.canReboot === 'boolean', si.canReboot);
  ok('返回当前重启模式（默认 manual）', si.rebootMode === 'manual', si.rebootMode);
  ok('返回服务器侧重启日志（含日志路径）',
    !!si.systemLog && typeof si.systemLog.path === 'string' && Array.isArray(si.systemLog.lines),
    si.systemLog && si.systemLog.path);
  ok('重启日志路径指向 /var/log/club-reboot.log',
    (si.systemLog || {}).path === '/var/log/club-reboot.log', (si.systemLog || {}).path);

  /* ⚠️ 安全阀：只有在服务器开启演练模式（REBOOT_DRY_RUN=1）时才真的下发重启请求，
     否则跑这个脚本会把正在运行的机器重启掉。 */
  if (si.dryRun === true) {
    const rb = await api('POST', '/api/system/reboot', { token, json: {} });
    ok('超管请求重启 → 200 且为演练模式', rb.status === 200 && rb.data.ok === true && rb.data.dryRun === true, rb.data);
    ok('响应里带「不会删除任何申请数据」的说明',
      String(rb.data.tip || '').includes('不会删除任何申请数据'), rb.data.tip);

    const sysInfo2 = await api('GET', '/api/system/info', { token });
    const lr = (sysInfo2.data.system || {}).lastRequest;
    ok('重启请求已写入审计（操作人 = 超管账号）', !!lr && lr.by === 'admin' && lr.mode === 'manual', lr);
    ok('审计记录里有时间与来源 IP', !!lr && !!lr.atText && !!lr.ip, lr);
    ok('审计历史可查询', ((sysInfo2.data.system || {}).history || []).length >= 1, (sysInfo2.data.system || {}).history);
    ok('演练模式不占用冷却时间（可连续演练）', (sysInfo2.data.system || {}).cooldownRemainingMs === 0,
      (sysInfo2.data.system || {}).cooldownRemainingMs);
  } else {
    console.log('  ⚠️ 服务器未开启演练模式（REBOOT_DRY_RUN=1），已跳过「真正下发重启」的用例，避免把机器重启掉');
    ok('未开启演练模式时不下发重启请求（安全阀生效）', true);
  }
  ok('测试环境必须是演练模式（避免误重启测试机）', si.dryRun === true, { dryRun: si.dryRun, canReboot: si.canReboot });

  /* 清理本节专用子账号 */
  const sysAdminsNow = await api('GET', '/api/admins', { token });
  const sysSubRec = (sysAdminsNow.data.admins || []).find(a => a.username === sysSubName);
  if (sysSubRec) await api('DELETE', '/api/admins/' + sysSubRec.id, { token });
  ok('清理系统设置测试用子账号', true);

  /* ---------- 15. 权限体系 + 审核介入（仅主审核官权限可用） ---------- */
  console.log('\n[15] 子账号权限与审核介入');
  const P_CN = '介入测试员';
  const P_QQ = '112233445';
  const pSub = await api('POST', '/api/applications', { json: basePayload({ cn: P_CN, qq: P_QQ, department: '后勤部' }) });
  const pId = pSub.data.id;
  ok('（准备）提交一条用于介入测试的申请', pSub.status === 200, pSub.data);

  const permName = 'perm_' + Date.now().toString().slice(-6);
  const addPerm = await api('POST', '/api/admins', { token, json: { username: permName, password: 'review123', note: '权限测试' } });
  ok('（准备）新建分管理员', addPerm.status === 200, addPerm.data);
  const permId = addPerm.data.admin.id;
  ok('新建子账号默认开启【审核权限】', addPerm.data.admin.perms.review === true, addPerm.data.admin.perms);
  ok('新建子账号默认不开启 系统设置/封禁/介入 权限',
    addPerm.data.admin.perms.system === false && addPerm.data.admin.perms.ban === false
    && addPerm.data.admin.perms.intervene === false, addPerm.data.admin.perms);

  const pLogin = await api('POST', '/api/admin/login', { json: { username: permName, password: 'review123' } });
  const pToken = pLogin.data.token;
  ok('登录响应里带权限对象（前端据此显隐）', !!pLogin.data.admin.perms, pLogin.data.admin.perms);
  ok('默认账号有审核权限', pLogin.data.admin.perms.review === true);
  ok('默认账号没有系统设置/封禁/介入权限',
    pLogin.data.admin.perms.system === false && pLogin.data.admin.perms.ban === false
    && pLogin.data.admin.perms.intervene === false, pLogin.data.admin.perms);

  /* --- 权限隔离：系统设置 / 账号管理 --- */
  ok('无系统设置权限 → /api/system/info 403', (await api('GET', '/api/system/info', { token: pToken })).status === 403);
  ok('无封禁权限 → 账号列表 403', (await api('GET', '/api/admins', { token: pToken })).status === 403);
  ok('无封禁权限 → 停用接口 403',
    (await api('POST', '/api/admins/' + permId + '/ban', { token: pToken, json: { enabled: false } })).status === 403);
  ok('无封禁权限 → 设置接口 403',
    (await api('POST', '/api/admins/' + permId + '/settings', { token: pToken, json: { enabled: false } })).status === 403);
  ok('无介入权限 → 介入接口 403',
    (await api('POST', `/api/applications/${pId}/intervene`, { token: pToken, json: {} })).status === 403);

  /* --- 介入前先让这条申请带上"已有审核结论"，用于验证"介入会清空结论" --- */
  await api('GET', `/api/applications/${pId}`, { token });
  const preApprove = await api('POST', `/api/applications/${pId}/review`, { token, json: { action: 'approve', department: '唱见部' } });
  ok('（准备）先审核通过，制造已有结论',
    preApprove.status === 200 && preApprove.data.application.recommendedDepartment === '唱见部', preApprove.data);

  /* --- 超管（有介入权限）执行介入 --- */
  const ivn = await api('POST', `/api/applications/${pId}/intervene`, { token, json: {} });
  ok('超管执行【审核介入】成功', ivn.status === 200 && ivn.data.application.status === 'intervened', ivn.data);
  const ivnApp = ivn.data.application;
  ok('状态标签为「主审核官介入中」', ivn.data.statusLabel === '主审核官介入中', ivn.data.statusLabel);
  ok('介入清空了推荐部门（原「唱见部」）', ivnApp.recommendedDepartment === '', ivnApp.recommendedDepartment);
  ok('介入清空了审核人/审核时间', ivnApp.reviewedBy === '' && ivnApp.reviewedAtText === '', { by: ivnApp.reviewedBy, at: ivnApp.reviewedAtText });
  ok('记录了介入人', ivnApp.intervenedBy === 'admin', ivnApp.intervenedBy);
  ok('记录了介入时间', !!ivnApp.intervenedAtText, ivnApp.intervenedAtText);
  ok('记录了介入前的状态（供后台追溯）', ivnApp.intervenedFromStatus === 'approved', ivnApp.intervenedFromStatus);
  ok('重复介入 → 409', (await api('POST', `/api/applications/${pId}/intervene`, { token, json: {} })).status === 409);

  /* --- 查询页表现 --- */
  const pq = await api('POST', '/api/status-query', { json: { cn: P_CN } });
  const pr = pq.data.results[0];
  ok('查询页状态为「该申请表已由主审核官介入」', pr.statusLabel === '该申请表已由主审核官介入', pr.statusLabel);
  ok('查询页不再显示原审核结论（推荐部门）', pr.recommendedDepartment === undefined, pr.recommendedDepartment);
  ok('查询页带介入时间', !!pr.intervenedAt, pr.intervenedAt);
  ok('介入中不再提供复审按钮', pr.canResubmit === false, pr.canResubmit);

  /* --- 无介入权限的分管理员：能看，不能动 --- */
  const pDetail = await api('GET', `/api/applications/${pId}`, { token: pToken });
  ok('介入中的申请，分管理员仍可打开查看（200）', pDetail.status === 200, pDetail.status);
  ok('分管理员看到的 canReview = false（前端据此置灰）', pDetail.data.canReview === false, pDetail.data.canReview);
  ok('分管理员看到的 canIntervene = false', pDetail.data.canIntervene === false, pDetail.data.canIntervene);
  ok('分管理员看到 locked = true', pDetail.data.locked === true, pDetail.data.locked);
  const pReviewLocked = await api('POST', `/api/applications/${pId}/review`, { token: pToken, json: { action: 'approve', department: '后勤部' } });
  ok('分管理员审核被锁定的申请 → 403', pReviewLocked.status === 403, pReviewLocked.data);
  ok('403 文案说明已由主审核官介入', /主审核官介入/.test(pReviewLocked.data.error || ''), pReviewLocked.data);

  /* --- 超管（介入权限）可以正常审核 → 自动解除锁定 --- */
  const supDetail = await api('GET', `/api/applications/${pId}`, { token });
  ok('超管看到 canReview = true', supDetail.data.canReview === true, supDetail.data.canReview);
  ok('超管看到 canIntervene = false（已在介入中）', supDetail.data.canIntervene === false, supDetail.data.canIntervene);
  const supReview = await api('POST', `/api/applications/${pId}/review`, { token, json: { action: 'approve', department: '后勤部' } });
  ok('主审核官审核通过成功', supReview.status === 200 && supReview.data.application.status === 'approved', supReview.data);
  ok('响应标记已解除锁定（unlocked）', supReview.data.unlocked === true, supReview.data.unlocked);
  ok('介入标记已清除', supReview.data.application.intervened === false, supReview.data.application.intervened);
  ok('记录了锁定解除时间', !!supReview.data.application.intervenedResolvedAtText, supReview.data.application.intervenedResolvedAtText);
  const pq2 = await api('POST', '/api/status-query', { json: { cn: P_CN } });
  ok('查询页恢复为「审核通过」', pq2.data.results[0].statusLabel === '审核通过', pq2.data.results[0].statusLabel);

  /* ---------- 需求：审核已通过 / 已拒绝的申请，仍然可以再次介入 ---------- */
  console.log('  --- 已出结果的申请仍可介入 ---');
  const detailDecided = await api('GET', `/api/applications/${pId}`, { token });
  ok('已通过的申请：canIntervene 仍为 true（可再次介入）', detailDecided.data.canIntervene === true, detailDecided.data.canIntervene);
  ok('已通过的申请：canReview 为 false（需先介入才能改判）', detailDecided.data.canReview === false, detailDecided.data.canReview);
  const ivnAgain = await api('POST', `/api/applications/${pId}/intervene`, { token, json: {} });
  ok('对「审核通过」的申请执行介入成功', ivnAgain.status === 200 && ivnAgain.data.application.status === 'intervened', ivnAgain.data);
  ok('再次介入清空了通过结论（推荐部门为空）', ivnAgain.data.application.recommendedDepartment === '', ivnAgain.data.application.recommendedDepartment);

  /* 这次让主审核官给「退回」→ 前端第④节点应显示「主审核官退回你的申请」 */
  const supReturn = await api('POST', `/api/applications/${pId}/review`, { token, json: { action: 'return', reason: '主审核官复核后请补充材料' } });
  ok('主审核官（介入后）退回成功', supReturn.status === 200 && supReturn.data.application.status === 'returned', supReturn.data);
  ok('标记这份结论由主审核官介入后给出（reviewedViaIntervene）',
    supReturn.data.application.reviewedViaIntervene === true, supReturn.data.application.reviewedViaIntervene);
  ok('记录了主审核官与复核时间',
    !!supReturn.data.application.reviewedViaInterveneBy && !!supReturn.data.application.reviewedViaInterveneAtText,
    { by: supReturn.data.application.reviewedViaInterveneBy, at: supReturn.data.application.reviewedViaInterveneAtText });
  const pq3 = await api('POST', '/api/status-query', { json: { cn: P_CN } });
  ok('查询页接口暴露 finalByIntervene（前端据此改写第④节点）',
    pq3.data.results[0].finalByIntervene === true, pq3.data.results[0].finalByIntervene);
  ok('查询页状态为「该申请表被退回」（主审核官退回）',
    pq3.data.results[0].statusLabel === '该申请表被退回', pq3.data.results[0].statusLabel);
  ok('主审核官退回后申请人仍可复审', pq3.data.results[0].canResubmit === true, pq3.data.results[0].canResubmit);

  /* 后台列表摘要里要能显示「主审核官最终审核」 */
  const listFinal = await api('GET', '/api/applications?q=' + encodeURIComponent(P_CN), { token });
  const rowFinal = listFinal.data.applications[0];
  ok('后台列表摘要带 reviewedViaIntervene', rowFinal.reviewedViaIntervene === true, rowFinal.reviewedViaIntervene);
  ok('后台列表摘要带「主审核官最终审核」所需的状态文案（审核员退回）',
    rowFinal.statusLabel === '审核员退回', rowFinal.statusLabel);
  ok('后台列表摘要带复核人与时间',
    !!rowFinal.reviewedViaInterveneBy && !!rowFinal.reviewedViaInterveneAtText,
    { by: rowFinal.reviewedViaInterveneBy, at: rowFinal.reviewedViaInterveneAtText });
  const rowIvn = listFinal.data.applications.find(a => a.id === pId);
  ok('介入中/已接管的申请在列表里能被识别', rowIvn.intervened === false && rowIvn.reviewedViaIntervene === true);

  /* 申请人提交复审后，介入标记应复位（新一轮尚未出结论） */
  const reAfterIvn = await api('POST', `/api/applications/${pId}/resubmit`, {
    json: basePayload({ cn: P_CN, qq: P_QQ, department: '后勤部', hobbies: '介入后再复审' })
  });
  ok('主审核官退回后可以提交复审', reAfterIvn.status === 200 && reAfterIvn.data.resubmitCount === 1, reAfterIvn.data);
  const pq4 = await api('POST', '/api/status-query', { json: { cn: P_CN } });
  ok('新一轮（复审）还没有结论 → finalByIntervene 复位为 false',
    pq4.data.results[0].finalByIntervene === false, pq4.data.results[0].finalByIntervene);

  /* 主审核官对「审核不通过」的申请也能介入 */
  const rejApp = await api('POST', '/api/applications', { json: basePayload({ cn: '介入拒绝测试员', qq: '445566778', department: '后勤部' }) });
  const rejId = rejApp.data.id;
  await api('POST', `/api/applications/${rejId}/review`, { token, json: { action: 'reject', reason: '不符合入社部门要求' } });
  const rejDetail = await api('GET', `/api/applications/${rejId}`, { token });
  ok('已拒绝的申请：canIntervene 仍为 true', rejDetail.data.canIntervene === true, rejDetail.data.canIntervene);
  const ivnRej = await api('POST', `/api/applications/${rejId}/intervene`, { token, json: {} });
  ok('对「审核不通过」的申请执行介入成功', ivnRej.status === 200 && ivnRej.data.application.status === 'intervened', ivnRej.data);
  const supApprove2 = await api('POST', `/api/applications/${rejId}/review`, { token, json: { action: 'approve', department: '后勤部' } });
  ok('主审核官介入后可以把「拒绝」改判为「通过」',
    supApprove2.status === 200 && supApprove2.data.application.status === 'approved', supApprove2.data);
  const pq5 = await api('POST', '/api/status-query', { json: { cn: '介入拒绝测试员' } });
  ok('改判后查询页 finalByIntervene = true（第④节点显示主审核官同意你的申请）',
    pq5.data.results[0].finalByIntervene === true && pq5.data.results[0].statusLabel === '审核通过',
    { f: pq5.data.results[0].finalByIntervene, l: pq5.data.results[0].statusLabel });

  /* --- 授予权限：介入 + 系统设置 + 封禁 --- */
  const setPerms = await api('POST', `/api/admins/${permId}/settings`, {
    token, json: { perms: { review: true, system: true, ban: true, intervene: true }, enabled: false }
  });
  ok('超管可分配权限', setPerms.status === 200 && setPerms.data.admin.perms.intervene === true,
    setPerms.data && setPerms.data.admin && setPerms.data.admin.perms);
  const pMe = await api('GET', '/api/admin/me', { token: pToken });
  ok('被授权账号的 me 里立刻生效（介入/系统设置/封禁）',
    pMe.data.admin.perms.intervene === true && pMe.data.admin.perms.system === true && pMe.data.admin.perms.ban === true,
    pMe.data.admin.perms);
  ok('被授权后可以访问系统设置', (await api('GET', '/api/system/info', { token: pToken })).status === 200);
  ok('被授权后可以查看账号列表', (await api('GET', '/api/admins', { token: pToken })).status === 200);

  /* --- 非超管（即使有封禁权限）不能分配权限 --- */
  const pAssign = await api('POST', `/api/admins/${permId}/settings`, { token: pToken, json: { perms: { system: false } } });
  ok('非超管分配权限 → 403', pAssign.status === 403, pAssign.data);
  ok('403 文案说明仅最高权限管理员可分配', /仅最高权限管理员/.test(pAssign.data.error || ''), pAssign.data);
  const pList = await api('GET', '/api/admins', { token: pToken });
  ok('非超管看到的账号列表标记 canAssignPerms = false', pList.data.canAssignPerms === false, pList.data.canAssignPerms);
  ok('非超管不能新增账号', (await api('POST', '/api/admins', { token: pToken, json: { username: 'x1', password: 'abc123456' } })).status === 403);

  /* --- 被授予介入权限的分管理员可以介入并审核 --- */
  const P2_CN = '介入测试员二';
  const p2Sub = await api('POST', '/api/applications', { json: basePayload({ cn: P2_CN, qq: '998877665', department: '后勤部' }) });
  const p2Id = p2Sub.data.id;
  const ivnBySub = await api('POST', `/api/applications/${p2Id}/intervene`, { token: pToken, json: {} });
  ok('被授权的分管理员可以执行介入', ivnBySub.status === 200 && ivnBySub.data.application.status === 'intervened', ivnBySub.data);
  ok('介入人记录为该分管理员', ivnBySub.data.application.intervenedBy === permName, ivnBySub.data.application.intervenedBy);
  const subReviewIvn = await api('POST', `/api/applications/${p2Id}/review`, { token: pToken, json: { action: 'reject', reason: '拥有其他社会性质社团' } });
  ok('主审核官（分管理员身份）可审核介入中的申请',
    subReviewIvn.status === 200 && subReviewIvn.data.application.status === 'rejected', subReviewIvn.data);
  ok('审核后锁定解除', subReviewIvn.data.application.intervened === false);

  /* --- 取消审核权限：只能查看，不能审核 --- */
  const P3_CN = '无审核权限测试员';
  const p3Sub = await api('POST', '/api/applications', { json: basePayload({ cn: P3_CN, qq: '556677889', department: '后勤部' }) });
  const p3Id = p3Sub.data.id;
  await api('POST', `/api/admins/${permId}/settings`, {
    token, json: { perms: { review: false, system: true, ban: true, intervene: true }, enabled: false }
  });
  const p3Detail = await api('GET', `/api/applications/${p3Id}`, { token: pToken });
  ok('取消审核权限后 canReview = false', p3Detail.data.canReview === false, p3Detail.data.canReview);
  const p3Review = await api('POST', `/api/applications/${p3Id}/review`, { token: pToken, json: { action: 'approve', department: '后勤部' } });
  ok('无审核权限的账号审核 → 403', p3Review.status === 403, p3Review.data);
  ok('403 文案说明没有审核权限', /没有审核权限/.test(p3Review.data.error || ''), p3Review.data);
  ok('但介入权限仍在（可介入）',
    (await api('POST', `/api/applications/${p3Id}/intervene`, { token: pToken, json: {} })).status === 200);

  /* --- 超管账号权限不可分配 / 不可停用 --- */
  const superRec = (await api('GET', '/api/admins', { token })).data.admins.find(a => a.role === 'super');
  ok('超管账号恒定显示全部权限',
    superRec.perms.review && superRec.perms.system && superRec.perms.ban && superRec.perms.intervene, superRec.perms);
  ok('对超管账号分配权限 → 403',
    (await api('POST', `/api/admins/${superRec.id}/settings`, { token, json: { perms: { review: false } } })).status === 403);
  ok('停用超管账号 → 403',
    (await api('POST', `/api/admins/${superRec.id}/settings`, { token, json: { enabled: true, until: '2027-01-01', reason: 'x' } })).status === 403);

  /* --- 有封禁权限的分管理员可以停用 / 解封他人 --- */
  const victimName = 'victim_' + permName;
  const victimAdd = await api('POST', '/api/admins', { token, json: { username: victimName, password: 'review123' } });
  const victimId = victimAdd.data.admin.id;
  const v5 = ymd(Date.now() + 5 * 86400000);
  const banSub = await api('POST', `/api/admins/${victimId}/settings`, {
    token: pToken, json: { enabled: true, until: `${v5.year}-${v5.month}-${v5.day}`, reason: '测试封禁' }
  });
  ok('有封禁权限的分管理员可以停用账号', banSub.status === 200 && banSub.data.admin.banned === true, banSub.data);
  const unbanSub = await api('POST', `/api/admins/${victimId}/settings`, { token: pToken, json: { enabled: false } });
  ok('有封禁权限的分管理员可以解封账号', unbanSub.status === 200 && unbanSub.data.admin.banned === false, unbanSub.data);

  /* --- 清理 --- */
  const victimRec = (await api('GET', '/api/admins', { token })).data.admins.find(a => a.username === victimName);
  if (victimRec) await api('DELETE', '/api/admins/' + victimRec.id, { token });
  await api('DELETE', '/api/admins/' + permId, { token });
  ok('清理权限测试用子账号', true);

  /* ---------- 16. 催促审核 ---------- */
  console.log('\n[16] 催促审核');
  const U_CN = '催促测试员';
  const U_QQ = '667788990';
  const uSub = await api('POST', '/api/applications', { json: basePayload({ cn: U_CN, qq: U_QQ, department: '后勤部' }) });
  const uId = uSub.data.id;
  ok('（准备）提交一条等待审核的申请', uSub.status === 200, uSub.data);

  const uQ1 = await api('POST', '/api/status-query', { json: { cn: U_CN } });
  const ur1 = uQ1.data.results[0];
  ok('查询页返回 urgeCount = 0', ur1.urgeCount === 0, ur1.urgeCount);
  ok('等待审核时允许催促（urgeAllowed = true）', ur1.urgeAllowed === true, ur1.urgeAllowed);
  ok('未催促过时不带终审标记', ur1.urgeEnded === undefined, ur1.urgeEnded);

  const u1 = await api('POST', `/api/applications/${uId}/urge`, { json: { cn: U_CN } });
  ok('催促成功 → 200', u1.status === 200 && u1.data.ok === true, u1.data);
  ok('提示文案为需求指定文本',
    u1.data.message === '已提交催促提醒，审核人员将尽快查看，请耐心等待。', u1.data.message);
  ok('urgeCount 变为 1', u1.data.urgeCount === 1, u1.data.urgeCount);
  ok('返回冷却时长 60 分钟', u1.data.cooldownMinutes === 60, u1.data.cooldownMinutes);
  ok('返回最近催促时间（东八区）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(u1.data.lastUrgeAt || ''), u1.data.lastUrgeAt);

  const uQ2 = await api('POST', '/api/status-query', { json: { cn: U_CN } });
  const ur2 = uQ2.data.results[0];
  ok('查询页 urgeCount = 1', ur2.urgeCount === 1, ur2.urgeCount);
  ok('查询页带 lastUrgeAt', !!ur2.lastUrgeAt, ur2.lastUrgeAt);
  ok('1 小时冷却中 → urgeAllowed = false', ur2.urgeAllowed === false, ur2.urgeAllowed);
  ok('冷却剩余时间约 60 分钟', ur2.urgeCooldownLeftMs > 55 * 60 * 1000, ur2.urgeCooldownLeftMs);
  ok('冷却剩余时间文案可用', /\d+ 分钟/.test(ur2.urgeCooldownLeftText || ''), ur2.urgeCooldownLeftText);

  /* 这里故意用 rawApi：要的就是看到 429（api() 会自动重试，看不到限流/冷却） */
  const u2 = await rawApi('POST', `/api/applications/${uId}/urge`, { json: { cn: U_CN } });
  ok('1 小时内重复催促 → 429', u2.status === 429, u2.data);
  ok('429 文案说明「1 小时内只能催促 1 次」', /1 小时内只能催促 1 次/.test(u2.data.error || ''), u2.data);
  ok('429 返回剩余冷却毫秒', u2.data.cooldownLeftMs > 0, u2.data.cooldownLeftMs);

  const uWrongCn = await api('POST', `/api/applications/${uId}/urge`, { json: { cn: '别人' } });
  ok('CN 不匹配 → 404', uWrongCn.status === 404, uWrongCn.data);
  const uNoId = await api('POST', '/api/applications/no-such-id/urge', { json: { cn: U_CN } });
  ok('不存在的申请 → 404', uNoId.status === 404, uNoId.data);

  /* 后台列表：标签数据 + 筛选 + 日志 */
  const uList = await api('GET', '/api/applications?q=' + encodeURIComponent(U_CN), { token });
  const uRow = uList.data.applications[0];
  ok('列表摘要带 urgeCount（红色标签用）', uRow.urgeCount === 1, uRow.urgeCount);
  ok('列表摘要带 urged 布尔（筛选用）', uRow.urged === true, uRow.urged);
  ok('列表摘要带最近催促时间', !!uRow.lastUrgeAtText, uRow.lastUrgeAtText);
  ok('后端留存了催促操作日志', uRow.urgeLogCount >= 1, uRow.urgeLogCount);

  const uFilter = await api('GET', '/api/applications?urged=1', { token });
  ok('urged=1 只返回被催促过的申请',
    uFilter.data.applications.length >= 1 && uFilter.data.applications.every(a => (a.urgeCount || 0) > 0),
    uFilter.data.applications.map(a => a.urgeCount));
  ok('本次催促的申请出现在筛选结果里', uFilter.data.applications.some(a => a.id === uId));
  const uFilterNone = await api('GET', '/api/applications?q=' + encodeURIComponent('介入测试员') + '&urged=1', { token });
  ok('未被催促的申请不会出现在 urged=1 结果里', uFilterNone.data.applications.length === 0, uFilterNone.data.applications.length);

  /* 状态限制：查看中 / 终审后不再接收 */
  await api('GET', `/api/applications/${uId}`, { token });     // 打开详情 → 审核员查看中
  const uViewing = await api('POST', `/api/applications/${uId}/urge`, { json: { cn: U_CN } });
  ok('状态变为「审核员查看中」后不再接收催促 → 409', uViewing.status === 409, uViewing.data);
  ok('409 文案说明当前状态无需催促', /无需催促/.test(uViewing.data.error || ''), uViewing.data);

  await api('POST', `/api/applications/${uId}/review`, { token, json: { action: 'approve', department: '后勤部' } });
  const uApproved = await api('POST', `/api/applications/${uId}/urge`, { json: { cn: U_CN } });
  ok('审核通过（终审）后不再接收催促 → 409', uApproved.status === 409, uApproved.data);
  ok('409 文案说明已审核完成', /已审核完成/.test(uApproved.data.error || ''), uApproved.data);
  ok('409 带 urgeEnded = true 标记', uApproved.data.urgeEnded === true, uApproved.data);
  const uQ3 = await api('POST', '/api/status-query', { json: { cn: U_CN } });
  ok('终审后查询页 urgeAllowed = false', uQ3.data.results[0].urgeAllowed === false, uQ3.data.results[0].urgeAllowed);
  ok('终审后查询页带 urgeEnded 标记', uQ3.data.results[0].urgeEnded === true, uQ3.data.results[0].urgeEnded);

  /* 复审中的申请同样可以催促（1 小时冷却按申请计，不受另一条影响） */
  const U2_CN = '催促复审测试员';
  const u2Sub = await api('POST', '/api/applications', { json: basePayload({ cn: U2_CN, qq: '223344556', department: '后勤部' }) });
  const u2Id = u2Sub.data.id;
  await api('POST', `/api/applications/${u2Id}/review`, { token, json: { action: 'reject', reason: '不符合入社部门要求' } });
  const u2Re = await api('POST', `/api/applications/${u2Id}/resubmit`, {
    json: basePayload({ cn: U2_CN, qq: '223344556', department: '后勤部' })
  });
  ok('（准备）提交复审，状态变为复审待审核', u2Re.status === 200, u2Re.data);
  const u2Q = await api('POST', '/api/status-query', { json: { cn: U2_CN } });
  ok('复审中允许催促', u2Q.data.results[0].urgeAllowed === true, u2Q.data.results[0].urgeAllowed);
  const u2Urge = await api('POST', `/api/applications/${u2Id}/urge`, { json: { cn: U2_CN } });
  ok('复审中的申请可以成功催促', u2Urge.status === 200 && u2Urge.data.urgeCount === 1, u2Urge.data);
  ok('催促次数按申请单独计数（互不影响）', u2Urge.data.urgeCount === 1);

  /* ---------- 17. 审核设置：启动 / 暂停 / 终止 ---------- */
  console.log('\n[17] 审核设置（启动 / 暂停 / 终止）');
  const rsPub = await api('GET', '/api/review-state');
  ok('公开接口可读系统状态', rsPub.status === 200 && rsPub.data.ok === true, rsPub.status);
  ok('默认状态为 running（审核系统运行中）',
    rsPub.data.review.status === 'running' && rsPub.data.review.statusLabel === '审核系统运行中', rsPub.data.review);
  ok('默认不拦截提交', rsPub.data.review.blockSubmit === false);
  ok('终止公告标题为需求指定文案',
    rsPub.data.review.noticeTitle === '示例动漫社团暂时停止新人入社申请', rsPub.data.review.noticeTitle);

  /* 权限：需【系统开启权限】 */
  const rsNoAuth = await api('POST', '/api/review-state', { json: { action: 'stop', notice: 'x' } });
  ok('未登录操作开关 → 401', rsNoAuth.status === 401, rsNoAuth.data);

  const rsName = 'rs_' + Date.now().toString().slice(-6);
  const rsAdd = await api('POST', '/api/admins', { token, json: { username: rsName, password: 'review123' } });
  ok('新建子账号默认没有【系统开启权限】', rsAdd.data.admin.perms.openSystem === false, rsAdd.data.admin.perms);
  const rsLogin = await api('POST', '/api/admin/login', { json: { username: rsName, password: 'review123' } });
  const rsToken = rsLogin.data.token;
  const rsForbidden = await api('POST', '/api/review-state', { token: rsToken, json: { action: 'stop', notice: '越权' } });
  ok('无【系统开启权限】的账号操作开关 → 403', rsForbidden.status === 403, rsForbidden.data);
  ok('403 文案说明缺少系统开启权限', /系统开启权限/.test(rsForbidden.data.error || ''), rsForbidden.data);
  ok('无权限账号读取变更记录 → 403',
    (await api('GET', '/api/review-state/history', { token: rsToken })).status === 403);

  /* 校验 */
  const badAction = await api('POST', '/api/review-state', { token, json: { action: 'nope' } });
  ok('非法 action → 400', badAction.status === 400, badAction.data);
  const rsNoReason = await api('POST', '/api/review-state', { token, json: { action: 'pause' } });
  ok('暂停缺原因 → 400「请填写暂停原因」', rsNoReason.status === 400 && /暂停原因/.test(rsNoReason.data.error), rsNoReason.data);
  const noUntil = await api('POST', '/api/review-state', { token, json: { action: 'pause', reason: 'x' } });
  ok('暂停缺预计恢复时间 → 400', noUntil.status === 400 && /预计恢复时间/.test(noUntil.data.error), noUntil.data);
  const pastUntil = await api('POST', '/api/review-state', {
    token, json: { action: 'pause', reason: 'x', pauseUntil: '2020-01-01T10:00' }
  });
  ok('预计恢复时间早于当前 → 400', pastUntil.status === 400 && /晚于当前时间/.test(pastUntil.data.error), pastUntil.data);
  const noNotice = await api('POST', '/api/review-state', { token, json: { action: 'stop' } });
  ok('终止缺通告 → 400「请填写通告文本」', noNotice.status === 400 && /通告文本/.test(noNotice.data.error), noNotice.data);
  ok('校验失败不会改动状态',
    (await api('GET', '/api/review-state')).data.review.status === 'running');

  /* 暂停 */
  const untilYmdObj = ymd(Date.now() + 3 * 86400000);
  const untilStr = `${untilYmdObj.year}-${untilYmdObj.month}-${untilYmdObj.day}T09:30`;
  const doPause = await api('POST', '/api/review-state', {
    token, json: { action: 'pause', reason: '期末周暂停审核', pauseUntil: untilStr }
  });
  ok('暂停成功 → 200', doPause.status === 200 && doPause.data.ok === true, doPause.data);
  ok('状态变为 paused', doPause.data.review.status === 'paused' && doPause.data.review.paused === true, doPause.data.review);
  ok('返回暂停原因', doPause.data.review.reason === '期末周暂停审核', doPause.data.review.reason);
  ok('返回暂停时间与预计恢复时间',
    /^\d{4}-\d{2}-\d{2} /.test(doPause.data.review.pausedAtText || '') &&
    /^\d{4}-\d{2}-\d{2} /.test(doPause.data.review.pauseUntilText || ''), doPause.data.review);
  ok('暂停时仍可提交申请（blockSubmit = false）', doPause.data.review.blockSubmit === false);
  const pauseSub = await api('POST', '/api/applications', {
    json: basePayload({ cn: '暂停期提交测试', qq: '334455667', department: '后勤部' })
  });
  ok('暂停期间申请人仍可提交申请表', pauseSub.status === 200, pauseSub.data);

  /* 终止 */
  const doStop = await api('POST', '/api/review-state', {
    token, json: { action: 'stop', notice: '本轮招新已结束，请留意下次公告' }
  });
  ok('终止成功 → 200', doStop.status === 200 && doStop.data.review.status === 'stopped', doStop.data);
  ok('终止后清空暂停信息',
    doStop.data.review.reason === '' && doStop.data.review.pauseUntilText === '', doStop.data.review);
  ok('终止通告被保存', doStop.data.review.notice === '本轮招新已结束，请留意下次公告', doStop.data.review.notice);
  ok('终止时 blockSubmit = true', doStop.data.review.blockSubmit === true);
  const stopSub = await api('POST', '/api/applications', {
    json: basePayload({ cn: '终止期提交测试', qq: '445566778', department: '后勤部' })
  });
  ok('终止后后端拒绝提交申请 → 403', stopSub.status === 403, stopSub.data);
  ok('403 带 reviewStopped 标记与通告文案',
    stopSub.data.reviewStopped === true && /招新已结束/.test(stopSub.data.error || ''), stopSub.data);
  ok('终止不影响查询页（已提交的申请仍可查询）',
    (await api('POST', '/api/status-query', { json: { cn: '暂停期提交测试' } })).status === 200);

  /* 恢复运行 */
  const doStart = await api('POST', '/api/review-state', { token, json: { action: 'start' } });
  ok('启动成功 → 状态回到 running', doStart.status === 200 && doStart.data.review.status === 'running', doStart.data);
  ok('恢复运行记录了启动时间', !!doStart.data.review.runningSinceText, doStart.data.review.runningSinceText);
  ok('恢复运行后可以正常提交申请',
    (await api('POST', '/api/applications', {
      json: basePayload({ cn: '恢复后提交测试', qq: '556677889', department: '后勤部' })
    })).status === 200);

  /* 重复设置同一状态：仍记录操作 */
  const againStart = await api('POST', '/api/review-state', { token, json: { action: 'start' } });
  ok('重复设置为同一状态 → 200 且 changed = false',
    againStart.status === 200 && againStart.data.changed === false, againStart.data);

  /* 变更记录 */
  const hist = await api('GET', '/api/review-state/history', { token });
  ok('可读取状态变更记录', hist.status === 200 && Array.isArray(hist.data.history), hist.status);
  const hs = hist.data.history || [];
  ok('记录了 启动/暂停/终止 三个方向的变更',
    hs.some(h => h.to === 'paused') && hs.some(h => h.to === 'stopped') && hs.some(h => h.to === 'running'),
    hs.map(h => h.to));
  ok('记录里带 操作人 / 时间 / 原因或通告',
    hs.every(h => h.by && h.atText) && hs.some(h => h.reason) && hs.some(h => h.notice), hs.slice(0, 2));
  ok('重复设置同一状态也被记录（changed = false）',
    hs.some(h => h.changed === false), hs.filter(h => !h.changed).length);

  /* 授予权限后可操作 */
  const rsRec = (await api('GET', '/api/admins', { token })).data.admins.find(a => a.username === rsName);
  await api('POST', `/api/admins/${rsRec.id}/settings`, {
    token, json: { perms: Object.assign({}, rsRec.perms, { openSystem: true }), enabled: false }
  });
  const rsMe = await api('GET', '/api/admin/me', { token: rsToken });
  ok('被授予【系统开启权限】后 me 里立刻生效', rsMe.data.admin.perms.openSystem === true, rsMe.data.admin.perms);
  const rsPause = await api('POST', '/api/review-state', {
    token: rsToken, json: { action: 'pause', reason: '授权账号测试暂停', pauseUntil: untilStr }
  });
  ok('被授权的分管理员可以操作审核系统开关', rsPause.status === 200 && rsPause.data.review.status === 'paused', rsPause.data);
  ok('记录里写明操作人是该分管理员', rsPause.data.review.updatedBy === rsName, rsPause.data.review.updatedBy);
  /* 复位并清理 */
  await api('POST', '/api/review-state', { token, json: { action: 'start' } });
  ok('测试结束已恢复 running（不影响后续用例）',
    (await api('GET', '/api/review-state')).data.review.status === 'running');
  await api('DELETE', '/api/admins/' + rsRec.id, { token });
  ok('清理审核设置测试用子账号', true);

  /* ---------- 汇总 ---------- */
  console.log('\n==================================================');  console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log(' 失败明细：');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(2); });
