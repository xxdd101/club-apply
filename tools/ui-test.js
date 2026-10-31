'use strict';

/* =========================================================================
 * 真实浏览器 UI 端到端测试（Edge / Chrome + puppeteer-core）
 *   前置：启动服务（建议独立数据目录 + 端口 3120）
 *   运行：node tools/ui-test.js
 *   产物：tools/_shots/*.png 截图
 *
 *   覆盖：
 *     ① 用户填写端 26 题与条件联动、必填定位、上传、提交
 *     ② 审核状态查询页：纵向时间线（4 节点）、loading 动画、详情置于时间线下方
 *     ③ 审核管理后台：登录、列表筛选搜索、详情自动置为「审核员查看中」、审核通过
 *     ④ 管理员账号管理：超管设置子账号备注、备注在右上角展示、分管理员权限隔离
 *     ⑤ 修改密码：旧密码 / 新密码 / 确认新密码 三项校验
 *     ⑥ Excel 导出（图片内嵌由 verify_xlsx.py 校验）
 *     ⑦ 手机端响应式：无横向溢出、表格卡片化、按钮可点
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:3120';
const EDGE = process.env.BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOT_DIR = path.join(__dirname, '_shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''));
    console.log('  ❌ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 测试素材：真实可解码的 PNG ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
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
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const FIX = path.join(__dirname, '_fixtures');
function makeFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const files = [];
  const colors = [[220, 90, 120], [90, 160, 220], [120, 200, 140]];
  colors.forEach((c, i) => {
    const p = path.join(FIX, `work${i + 1}.png`);
    fs.writeFileSync(p, makePng(600, 480, c));
    files.push(p);
  });
  return files;
}

/* ========================================================================= */
(async () => {
  console.log('==================================================');
  console.log(' 浏览器 UI 端到端测试   目标：' + BASE);
  console.log('==================================================');

  const fixtures = makeFixtures();
  const CN = 'UI测试酱' + Date.now().toString().slice(-4);
  const QQ = '123456789';
  /* 每轮唯一，避免上一轮残留的账号/密码干扰测试 */
  const SUBUSER = 'ui_rev_' + Date.now().toString().slice(-6);
  const SUBPASS = 'review123';
  const SUBPASS2 = 'newpass456';
  const NOTE = 'COS部长';

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    /* 本测试会开多个页面轮流操作：后台页闲置久了再点/打字（走输入管线）会偶发协议超时，
       所以关掉后台节流，并把协议超时调短，出问题能快速定位到具体步骤 */
    protocolTimeout: 60000,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });

  const errors = [];
  const ignoredResource = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    /* 故意用错误密码登录会产生 401，浏览器记为资源加载错误，属于预期行为 */
    if (/Failed to load resource/i.test(t)) { ignoredResource.push(t); return; }
    errors.push('console: ' + t);
  });

  try {
    /* ================= 1. 用户填写端 ================= */
    console.log('\n[1] 用户填写端');
    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
    ok('主标题正确', (await page.$eval('.banner h1', el => el.textContent.trim())) === '示例动漫社-入社申请表');
    ok('审核时间标注存在', (await page.$eval('.banner .tag', el => el.textContent.trim())).includes('9:00-23:59'));
    ok('共 26 道题', (await page.$$eval('section.q', els => els.length)) === 26);
    ok('部门选项 14 个（含新增【宣传部】）', (await page.$$eval('#departmentGroup input', els => els.length)) === 14);
    ok('性别选项 6 个', (await page.$$eval('#genderGroup input', els => els.length)) === 6);
    ok('省份下拉已填充（≥34）', (await page.$$eval('#province option', els => els.length)) >= 34);

    /* 首页大卡片入口 + 页脚 */
    const cards = await page.$$eval('.entry-card', els => els.map(e => ({
      href: e.getAttribute('href'),
      title: (e.querySelector('.entry-title') || {}).textContent
    })));
    ok('顶部为两个大卡片入口（不再是文字链接）', cards.length === 2, cards);
    ok('旧文字链接已移除', (await page.$$('.banner .nav-links')).length === 0);
    ok('卡片分别指向 /status 与 /admin',
      cards[0] && cards[0].href === '/status' && cards[1] && cards[1].href === '/admin', cards);
    const cardBox = await page.$eval('.entry-card', el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, shadow: s.boxShadow };
    });
    ok('卡片足够大、有圆角与阴影',
      cardBox.w > 300 && cardBox.h >= 90 && parseFloat(cardBox.radius) >= 12 && cardBox.shadow !== 'none', cardBox);
    ok('页面最底部有页脚文字',
      (await page.$eval('.site-footer', el => el.textContent.trim())) === '本页面属于示例动漫社管理。');
    await page.screenshot({ path: path.join(SHOT_DIR, '0-home-cards.png') });

    /* 条件题默认隐藏（q09、q12 + 8 道作品题 = 10 道） */
    ok('10 道条件题默认全部隐藏',
      (await page.$$eval('section.q.cond', els => els.filter(e => !e.classList.contains('show')).length)) === 10);

    /* 08 → 09 */
    await page.click('input[name="hasExperience"][value="有"]');
    await sleep(150);
    ok('选“有”后显示第09题', await page.$eval('#q09', el => el.classList.contains('show')));
    await page.click('input[name="hasExperience"][value="无"]');
    await sleep(150);
    ok('改选“无”后隐藏第09题', !(await page.$eval('#q09', el => el.classList.contains('show'))));

    /* 11 → 12 */
    await page.click('input[name="otherClub"][value="是"]');
    await sleep(150);
    ok('选“是”后显示第12题', await page.$eval('#q12', el => el.classList.contains('show')));
    await page.click('input[name="otherClub"][value="否"]');
    await sleep(150);
    ok('改选“否”后隐藏第12题', !(await page.$eval('#q12', el => el.classList.contains('show'))));

    /* 部门 → 作品题联动 */
    const deptCases = [
      ['COS部', 'q14'], ['三坑部', 'q15'], ['摄影部', 'q16'], ['后期部', 'q16'],
      ['绘画部', 'q17'], ['CV部', 'q18'], ['特摄部', 'q19'],
      ['FURRY（福瑞）部', 'q20'], ['Kigurumi(人偶扮演)部', 'q21']
    ];
    for (const [dept, qid] of deptCases) {
      await page.evaluate(d => {
        const r = Array.from(document.querySelectorAll('input[name="department"]')).find(x => x.value === d);
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }, dept);
      await sleep(90);
      const shown = await page.$$eval('section.q.cond.show', els => els.map(e => e.id));
      ok(`选「${dept}」只显示第${qid.slice(1)}题`, shown.length === 1 && shown[0] === qid, shown);
    }
    for (const dept of ['唱见部', '舞见部', '后勤部', '妆娘部', '宣传部']) {
      await page.evaluate(d => {
        const r = Array.from(document.querySelectorAll('input[name="department"]')).find(x => x.value === d);
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }, dept);
      await sleep(90);
      const shown = await page.$$eval('section.q.cond.show', els => els.map(e => e.id));
      ok(`选「${dept}」不显示任何作品题`, shown.length === 0, shown);
    }

    /* 部门选项的「需作品 / 需录音 / 无需资料」标记 + 选中后的说明 */
    const deptTags = await page.$$eval('#departmentGroup label', els => els.map(e => ({
      name: (e.querySelector('.dept-name') || {}).textContent || '',
      tag: (e.querySelector('.dept-tag') || {}).textContent || '',
      cls: (e.querySelector('.dept-tag') || {}).className || ''
    })));
    ok('每个部门选项都带「需作品/需录音/无需资料」标记',
      deptTags.length === 14 && deptTags.every(d => /需作品|需录音|无需资料/.test(d.tag)), deptTags.map(d => d.name + ':' + d.tag));
    const tagOf = n => (deptTags.find(d => d.name === n) || {}).tag;
    ok('【宣传部】标记为「无需资料」', tagOf('宣传部') === '无需资料', tagOf('宣传部'));
    ok('【后勤部】标记为「无需资料」', tagOf('后勤部') === '无需资料', tagOf('后勤部'));
    ok('【COS部】标记为「需作品」', tagOf('COS部') === '需作品', tagOf('COS部'));
    ok('【CV部】标记为「需录音」', tagOf('CV部') === '需录音', tagOf('CV部'));
    ok('「无需资料」与「需作品」用不同颜色区分',
      (deptTags.find(d => d.name === '宣传部') || {}).cls.includes('free') &&
      (deptTags.find(d => d.name === 'COS部') || {}).cls.includes('need'), deptTags.map(d => d.cls));
    /* 14 个选项等宽网格（同一行的选项宽度一致，且不超出容器） */
    const grid = await page.$eval('#departmentGroup', el => {
      const s = getComputedStyle(el);
      const items = Array.from(el.querySelectorAll('label'));
      const first = items[0].getBoundingClientRect();
      const sameRow = items.filter(i => Math.abs(i.getBoundingClientRect().top - first.top) < 2);
      const widths = sameRow.map(i => Math.round(i.getBoundingClientRect().width));
      const box = el.getBoundingClientRect();
      const over = items.filter(i => i.getBoundingClientRect().right > box.right + 1).length;
      return {
        display: s.display, cols: widths.length,
        even: widths.every(w => Math.abs(w - widths[0]) <= 1), over,
        minW: Math.min.apply(null, widths), maxRight: Math.max.apply(null, items.map(i => i.getBoundingClientRect().right))
      };
    });
    ok('部门选择区为网格布局', grid.display === 'grid', grid.display);
    ok('同一行的部门选项等宽', grid.even && grid.minW >= 150, grid);
    ok('没有任何部门选项超出容器', grid.over === 0, grid);

    /* 选中宣传部 → 提示「无需提交作品资料」，且是绿色 */
    await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('input[name="department"]')).find(x => x.value === '宣传部');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(120);
    const pubHint = await page.$eval('#deptHint', el => ({
      text: el.textContent.trim(), cls: el.className,
      color: getComputedStyle(el).color
    }));
    ok('选宣传部后提示「无需提交作品资料」',
      /无需提交作品资料/.test(pubHint.text) && pubHint.text.includes('宣传部'), pubHint.text);
    ok('该提示为绿色（与需作品的琥珀色区分）',
      pubHint.cls.includes('free') && /rgb\(21, 115, 71\)/.test(pubHint.color), pubHint);
    /* 选中 COS部 → 琥珀色「需要提交作品图片」 */
    await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('input[name="department"]')).find(x => x.value === 'COS部');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(120);
    const cosHint = await page.$eval('#deptHint', el => ({
      text: el.textContent.trim(), cls: el.className, color: getComputedStyle(el).color
    }));
    ok('选 COS部后提示「需要提交作品图片」且为琥珀色',
      /需要提交作品图片/.test(cosHint.text) && cosHint.cls.includes('need') &&
      /rgb\(168, 118, 15\)/.test(cosHint.color), cosHint);

    /* 空表单提交 → 定位缺失项 */
    await page.click('#submitBtn');
    await sleep(300);
    ok('空表单提交被拦截并定位到第01题', await page.$eval('#q01', el => el.classList.contains('invalid')));
    ok('顶部提示缺失项数量', /还有\s*\d+\s*项需要完善/.test(await page.$eval('#topNotice', el => el.textContent)));

    /* 完整填写 */
    await page.type('#cn', CN);
    await page.type('#qq', QQ);
    await page.type('#age', '22');
    await page.type('#joinYears', '5年');
    await page.select('#province', '广东省');
    await sleep(120);
    await page.select('#city', '广州市');
    await page.click('input[name="gender"][value="女"]');
    await page.type('#height', '168');
    await page.type('#hobbies', '绘画、唱歌、舞台剧');
    await page.click('input[name="hasExperience"][value="有"]');
    await sleep(120);
    await page.type('#experienceDesc', '参加过三届校园漫展舞台剧');
    await page.type('#favoriteWorks', '《原神》《明日方舟》');
    await page.click('input[name="otherClub"][value="否"]');
    await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('input[name="department"]')).find(x => x.value === 'COS部');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(150);
    await page.type('#introduction', '大家好，我是UI测试酱，喜欢舞台与绘画。');
    await page.type('#viewOn2D', '二次元是我放松与表达自我的方式。');
    await page.click('input[name="agreeRules"][value="是"]');
    await page.type('#referralCode', 'UITEST01');
    await page.type('#inviterCn', '社长大人');
    await sleep(200);

    /* 作品题未上传时提交应被拦截 */
    await page.click('#submitBtn');
    await sleep(350);
    ok('未上传作品图片时提交被拦截并标记第14题', await page.$eval('#q14', el => el.classList.contains('invalid')));

    /* ---------- QQ号前端校验（需求给定的三条提示文案） ---------- */
    console.log('  --- QQ号校验 ---');
    await page.evaluate(() => { document.querySelector('#qq').value = ''; });
    await page.click('#submitBtn');
    await sleep(350);
    let qqMsg = await page.$eval('#qqError', el => el.textContent.trim());
    ok('QQ号为空提交 → 「QQ号为必填项，请填写」', qqMsg === 'QQ号为必填项，请填写', qqMsg);

    await page.type('#qq', '12a45');
    await sleep(200);
    qqMsg = await page.$eval('#qqError', el => el.textContent.trim());
    ok('QQ号输入非数字 → 「QQ号只能填写数字」', qqMsg === 'QQ号只能填写数字', qqMsg);

    await page.evaluate(() => { document.querySelector('#qq').value = ''; });
    await page.type('#qq', '1234');
    await page.click('#submitBtn');
    await sleep(350);
    qqMsg = await page.$eval('#qqError', el => el.textContent.trim());
    ok('QQ号 4 位 → 「QQ号长度需要5-11位」', qqMsg === 'QQ号长度需要5-11位', qqMsg);

    await page.evaluate(() => { document.querySelector('#qq').value = ''; });
    await page.type('#qq', '123456789012');
    await page.click('#submitBtn');
    await sleep(350);
    qqMsg = await page.$eval('#qqError', el => el.textContent.trim());
    ok('QQ号 12 位 → 「QQ号长度需要5-11位」', qqMsg === 'QQ号长度需要5-11位', qqMsg);

    /* 恢复为合法 QQ号 */
    await page.evaluate(() => { document.querySelector('#qq').value = ''; });
    await page.type('#qq', QQ);
    await sleep(200);
    qqMsg = await page.$eval('#qqError', el => el.textContent.trim());
    ok('填入合法 QQ号后不再报错', qqMsg === '', qqMsg);

    /* 上传 3 张图片 */
    const fileInput = await page.$('#q14 .uploader input[type="file"]');
    await fileInput.uploadFile(...fixtures);
    await page.waitForFunction(() => document.querySelectorAll('#q14 .thumb img').length === 3, { timeout: 20000 });
    ok('COS部作品图片上传 3 张并显示缩略图', true);
    await page.screenshot({ path: path.join(SHOT_DIR, '1-apply-form.png') });

    /* 提交 */
    await page.click('#submitBtn');
    await page.waitForFunction(() => document.querySelector('#okModal').classList.contains('show'), { timeout: 20000 });
    ok('完整填写后提交成功并弹出“申请已提交，请等待审核”',
      (await page.$eval('#okModal .modal-body', el => el.textContent)).includes('申请已提交，请等待审核'));
    await page.screenshot({ path: path.join(SHOT_DIR, '2-submit-success.png') });
    await page.click('#okClose');
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { });

    /* ================= 2. 状态查询页（时间线） ================= */
    console.log('\n[2] 审核状态查询页（时间线）');
    await page.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    ok('查询页存在唯一输入框', (await page.$$('main input[type="text"]')).length === 1);
    ok('旧的「状态说明」卡片已移除', !(await page.evaluate(() => document.body.textContent.includes('状态说明'))));
    ok('loading 转圈动画样式存在',
      (await page.evaluate(() => getComputedStyle(document.querySelector('.spinner')).animationName)) === 'spin');

    /* 点击查询的同时观察 loading 是否真的显示 */
    await page.type('#cnInput', CN);
    const sawLoading = await page.evaluate(async () => {
      const box = document.querySelector('#queryLoading');
      let seen = box && box.style.display !== 'none';
      const ob = new MutationObserver(() => { if (box.style.display !== 'none') seen = true; });
      ob.observe(box, { attributes: true, attributeFilter: ['style'] });
      document.querySelector('#queryBtn').click();
      await new Promise(r => setTimeout(r, 900));
      ob.disconnect();
      return seen;
    });
    ok('查询过程中出现 loading 动画', sawLoading === true);

    await page.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    const tl = await page.$$eval('#resultArea .tl-node', els => els.map(e => ({
      cls: e.className, title: e.querySelector('.tl-title').textContent.trim()
    })));
    ok('结果是纵向时间线的 4 个节点', tl.length === 4, tl.map(x => x.title));
    ok('节点顺序：已提交申请→审核员查看中→等待审核结果→审核通过/审核拒绝',
      tl[0].title === '已提交申请' && tl[1].title === '审核员查看中' &&
      tl[2].title === '等待审核结果' && /审核通过\s*\/\s*审核拒绝/.test(tl[3].title), tl.map(x => x.title));
    ok('刚提交：第①步当前高亮，其余置灰',
      /\bcurrent\b/.test(tl[0].cls) && /\btodo\b/.test(tl[1].cls) &&
      /\btodo\b/.test(tl[2].cls) && /\btodo\b/.test(tl[3].cls), tl.map(x => x.cls));
    ok('时间线有一条竖线串联节点（宽 2px）',
      (await page.evaluate(() => getComputedStyle(document.querySelector('#resultArea .tl-node'), '::after').width)) === '2px');
    ok('查询结果包含申请人 CN', (await page.$eval('.timeline-card .cn', el => el.textContent.trim())) === CN);
    ok('申请详情信息在时间线下方展示',
      await page.$eval('.timeline-card', el => !!el.querySelector('.tl-detail') && el.textContent.includes('申请详情信息')));
    ok('「已提交申请」状态下不显示【前往修改-提交复审】按钮',
      (await page.$$('#resultArea [data-resubmit]')).length === 0);

    /* ---------- 催促审核（申请人端） ---------- */
    console.log('  --- 催促审核 ---');
    ok('等待审核时显示【催促审核】按钮', (await page.$$('#resultArea [data-urge]')).length === 1);
    const urgePos = await page.evaluate(() => {
      const detail = document.querySelector('.timeline-card .tl-detail');
      const btn = document.querySelector('#resultArea [data-urge]');
      const rows = Array.from(detail.querySelectorAll('.detail-item')).map(x => x.getBoundingClientRect().bottom);
      return {
        inDetail: detail.contains(btn),
        belowLastRow: btn.getBoundingClientRect().top >= Math.max.apply(null, rows) - 1,
        text: btn.textContent.trim()
      };
    });
    ok('按钮位于「申请详情信息」板块最下方',
      urgePos.inDetail === true && urgePos.belowLastRow === true, urgePos);
    ok('按钮文案为「催促审核」', urgePos.text === '催促审核', urgePos.text);
    await page.screenshot({ path: path.join(SHOT_DIR, '3b-urge-button.png'), fullPage: true });

    await page.click('#resultArea [data-urge]');
    await page.waitForFunction(() => document.querySelector('#urgeOkModal').classList.contains('show'), { timeout: 10000 });
    ok('催促成功弹出提示弹窗',
      (await page.$eval('#urgeOkMsg', el => el.textContent.trim())) === '已提交催促提醒，审核人员将尽快查看，请耐心等待。',
      await page.$eval('#urgeOkMsg', el => el.textContent.trim()));
    await page.screenshot({ path: path.join(SHOT_DIR, '3c-urge-success.png') });
    await page.click('#urgeOkClose');
    await page.waitForFunction(() => !document.querySelector('#urgeOkModal').classList.contains('show'), { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    const urgeAfter = await page.evaluate(() => {
      const btn = document.querySelector('#resultArea [data-urge]');
      const all = Array.from(document.querySelectorAll('#resultArea .urge-bar button'));
      return {
        plainCount: all.filter(b => b.textContent.trim() === '催促审核').length,
        disabled: all.length ? all[0].disabled : null,
        hint: (document.querySelector('#resultArea .urge-bar .small') || {}).textContent || ''
      };
    });
    ok('催促后按钮置灰不可再点（本次会话内）',
      urgeAfter.disabled === true, urgeAfter);
    ok('置灰后仍显示「催促审核」按钮', urgeAfter.plainCount === 1, urgeAfter);
    ok('提示「本次已提交催促提醒」', urgeAfter.hint.includes('本次已提交催促提醒'), urgeAfter.hint);

    /* 同一会话内重新查询，按钮仍应保持置灰 */
    await page.click('#queryBtn');
    await page.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    ok('重新查询后仍保持置灰（本次页面会话内不可重复点击）',
      (await page.$eval('#resultArea .urge-bar button', el => el.disabled)) === true);
    await page.screenshot({ path: path.join(SHOT_DIR, '3d-urge-disabled.png'), fullPage: true });
    await page.screenshot({ path: path.join(SHOT_DIR, '3-status-submitted.png'), fullPage: true });

    /* ================= 3. 管理后台 ================= */
    console.log('\n[3] 审核管理后台');
    await page.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#viewLogin', { visible: true });
    await page.type('#username', 'admin');
    await page.type('#password', 'wrong-password');
    await page.click('#loginBtn');
    await page.waitForFunction(() => document.querySelector('#loginError').style.display !== 'none', { timeout: 8000 });
    ok('密码错误提示“账号或密码错误”',
      (await page.$eval('#loginError', el => el.textContent.trim())) === '账号或密码错误');
    await page.screenshot({ path: path.join(SHOT_DIR, '4-login-error.png') });

    await page.evaluate(() => { document.querySelector('#password').value = ''; });
    await page.type('#password', 'change-this-password');
    await page.click('#loginBtn');
    await page.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#listBody tr[data-id]').length > 0, { timeout: 10000 });
    ok('登录成功进入审核列表页', true);
    const headers = await page.$$eval('#listTable thead th', els => els.map(e => e.textContent.trim()));
    ok('列表表头为 序号/CN代称/QQ号/申请部门/提交时间/审核状态/附件',
      headers.join(',') === '序号,CN代称,QQ号,申请部门,提交时间,审核状态,附件', headers);
    ok('状态列有颜色标识 class', (await page.$eval('#listBody .badge', el => el.className)).includes('badge-'));
    await page.screenshot({ path: path.join(SHOT_DIR, '5-admin-list.png') });

    /* 搜索与筛选 */
    await page.type('#fQ', CN);
    await sleep(300);
    ok('按 CN 模糊搜索得到 1 条', (await page.$$eval('#listBody tr[data-id]', els => els.length)) === 1);
    ok('搜索结果 CN 正确',
      (await page.$eval('#listBody tr[data-id] td:nth-child(2)', el => el.textContent.trim())).includes(CN));

    /* ---------- 审核列表：QQ号列的显示开关 ---------- */
    const visHeads = () => page.$$eval('#listTable thead th',
      els => els.filter(e => e.offsetParent !== null).map(e => e.textContent.trim()));
    ok('默认不显示 QQ号列', !(await visHeads()).includes('QQ号'), await visHeads());
    await page.click('#showQq');
    await sleep(300);
    ok('勾选「显示QQ号」后出现 QQ号列', (await visHeads()).includes('QQ号'), await visHeads());
    ok('QQ号列内容正确',
      (await page.$eval('#listBody tr[data-id]', el => el.textContent)).includes(QQ));
    await page.click('#showQq');
    await sleep(300);
    ok('取消勾选后 QQ号列消失', !(await visHeads()).includes('QQ号'), await visHeads());

    /* ---------- 催促审核：红色标签 + 筛选框 ---------- */
    const urgeTagInfo = await page.evaluate(() => {
      const tr = document.querySelector('#listBody tr[data-id]');
      const tag = tr.querySelector('.badge-urge');
      if (!tag) return { found: false };
      const cs = getComputedStyle(tag);
      const firstCell = tr.querySelector('td:nth-child(2)');
      const nameEl = firstCell.querySelector('b');
      return {
        found: true,
        text: tag.textContent.trim(),
        bg: cs.backgroundColor,
        color: cs.color,
        weight: cs.fontWeight,
        /* 标签在 CN 名称上方 → 手机端卡片里就是"卡片顶部" */
        isTopOfCard: firstCell.contains(tag) &&
          tag.getBoundingClientRect().top <= nameEl.getBoundingClientRect().top + 1
      };
    });
    ok('被催促过的申请显示红色标签「⚠️ 申请人已催促1次」',
      urgeTagInfo.found === true && urgeTagInfo.text === '⚠️ 申请人已催促1次', urgeTagInfo);
    ok('标签为红底白字（与「审核不通过」红色风格一致）',
      urgeTagInfo.bg === 'rgb(224, 72, 77)' && urgeTagInfo.color === 'rgb(255, 255, 255)', urgeTagInfo);
    ok('标签位于卡片/Cn 单元格顶部', urgeTagInfo.isTopOfCard === true, urgeTagInfo);
    await page.screenshot({ path: path.join(SHOT_DIR, '5b-admin-urge-tag.png') });

    ok('工具栏有【仅显示被催促过的申请】筛选框', (await page.$$('#onlyUrged')).length === 1);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await page.click('#onlyUrged');
    await sleep(400);
    const urgedRows = await page.$$eval('#listBody tr[data-id]', els => els.map(e => e.textContent));
    ok('勾选后只显示被催促过的申请（至少 1 条且都带标签）',
      urgedRows.length >= 1 && urgedRows.every(t => t.includes('申请人已催促')), urgedRows.length);
    await page.screenshot({ path: path.join(SHOT_DIR, '5c-admin-urge-filter.png') });
    await page.click('#onlyUrged');
    await sleep(300);
    const allRows = await page.$$eval('#listBody tr[data-id]', els => els.map(e => e.textContent));
    ok('取消勾选后恢复显示全部申请', allRows.length >= urgedRows.length, { all: allRows.length, urged: urgedRows.length });
    await page.type('#fQ', CN);
    await sleep(300);

    await page.evaluate(() => {
      const q = document.querySelector('#fQ');
      q.value = '';
      q.dispatchEvent(new Event('input'));
    });
    await page.select('#fStatus', 'approved');
    await sleep(200);
    ok('按状态筛选（审核通过）',
      await page.$$eval('#listBody tr[data-id]', els => els.every(e => e.textContent.includes('审核通过'))));
    await page.select('#fStatus', '');
    await page.select('#fDept', 'COS部');
    await sleep(200);
    ok('按部门筛选（COS部）',
      await page.$$eval('#listBody tr[data-id]', els => els.every(e => e.textContent.includes('COS部'))));
    await page.select('#fDept', '');
    await sleep(200);

    /* 详情 → 自动置为「审核员查看中」 */
    await page.type('#fQ', CN);
    await sleep(300);
    await page.click('#listBody tr[data-id]');
    await page.waitForFunction(() => document.querySelector('#viewDetail').style.display !== 'none' &&
      !document.querySelector('#detailBody').textContent.includes('加载中'), { timeout: 10000 });
    ok('详情页展示完整填写内容',
      (await page.$eval('#detailBody', el => el.textContent)).includes('绘画、唱歌、舞台剧'));
    ok('详情页展示作品图片', (await page.$$eval('#detailGallery img', els => els.length)) === 3);

    /* 详情页 QQ号：应紧跟在「CN 代称」下方 */
    const qqShown = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#detailBody .detail-item'));
      const i = items.findIndex(x => {
        const k = x.querySelector('.k');
        return k && k.textContent.includes('QQ');
      });
      if (i < 0) return { found: false };
      const prev = items[i - 1];
      return {
        found: true,
        value: items[i].querySelector('.v').textContent.trim(),
        prevLabel: prev && prev.querySelector('.k') ? prev.querySelector('.k').textContent.trim() : ''
      };
    });
    ok('审核详情页展示 QQ号', qqShown.found && qqShown.value === QQ, qqShown);
    ok('QQ号紧跟在「CN 代称」下方', qqShown.prevLabel === 'CN 代称', qqShown);
    ok('详情页提示已自动标记「审核员查看中」',
      (await page.$eval('#detailBody', el => el.textContent)).includes('审核员查看中'));
    await page.screenshot({ path: path.join(SHOT_DIR, '6-admin-detail.png'), fullPage: true });

    await page.click('#btnBack');
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    await sleep(400);
    ok('列表状态变为「审核员查看中」',
      (await page.$eval('#listBody tr[data-id] td:nth-child(5) .badge', el => el.textContent.trim())) === '审核员查看中');

    /* 用户查询页同步 */
    const p2 = await browser.newPage();
    await p2.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    await p2.type('#cnInput', CN);
    await p2.click('#queryBtn');
    await p2.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    const tl2 = await p2.$$eval('#resultArea .tl-node', els => els.map(e => e.className));
    ok('用户查询页显示「审核员查看中」',
      (await p2.$eval('.timeline-card .badge', el => el.textContent.trim())) === '审核员查看中');
    ok('查看中：①已点亮、②当前高亮、③④置灰',
      /\bdone\b/.test(tl2[0]) && /\bcurrent\b/.test(tl2[1]) &&
      /\btodo\b/.test(tl2[2]) && /\btodo\b/.test(tl2[3]), tl2);
    await p2.close();

    /* 底部固定操作栏：先自己做命中测试确认真的可点，再触发点击
       （puppeteer 的几何预检查对 position:fixed 元素会误判为不可点） */
    const clickBar = async (sel) => {
      const info = await page.evaluate(s => {
        const b = document.querySelector(s);
        if (!b) return { ok: false, why: '元素不存在' };
        const r = b.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const el = document.elementFromPoint(cx, cy);
        return {
          ok: r.top >= 0 && r.bottom <= window.innerHeight && !!el && (el === b || b.contains(el)),
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
          viewportH: window.innerHeight,
          topEl: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null
        };
      }, sel);
      if (!info.ok) throw new Error(`操作栏按钮 ${sel} 当前不可点击：` + JSON.stringify(info));
      await page.evaluate(s => document.querySelector(s).click(), sel);
    };

    /* ---------- 审核详情页：新增的【退回】【无法决定-提交主审核官】 ---------- */
    /* 注意：上一步点过 #btnBack 回到了列表，#detailBody 里残留的是隐藏状态的旧详情，
       必须重新打开详情页，否则按钮 rect 全为 0、根本点不到 */
    await page.click('#listBody tr[data-id]');
    await page.waitForFunction(() => document.querySelector('#viewDetail').style.display !== 'none' &&
      !!document.querySelector('#btnReturn'), { timeout: 10000 });
    await sleep(300);
    const actionBtns = await page.$$eval('#detailBody .action-bar button', els => els.map(e => e.textContent.trim()));
    ok('详情页按钮为 审核不通过 / 审核通过 / 退回 / 无法决定-提交主审核官 / 审核介入',
      actionBtns.join(',') === '审核不通过,审核通过,退回,无法决定 - 提交主审核官,审核介入', actionBtns);
    /* 「审核通过 / 审核不通过」被包在 .ab-pair 里：PC 端 display:contents 保持原布局 */
    ok('审核通过 / 审核不通过 同属 .ab-pair（手机端才并排）',
      (await page.$$eval('#detailBody .ab-pair button', els => els.map(e => e.id))).join(',') === 'btnReject,btnApprove');
    ok('PC 端 .ab-pair 用 display:contents（布局与改造前一致）',
      (await page.$eval('#detailBody .ab-pair', el => getComputedStyle(el).display)) === 'contents');
    ok('超管（有介入权限）能看到【审核介入】按钮',
      (await page.$$('#detailBody #btnIntervene')).length === 1);
    ok('超管介入按钮在 PC 端可点击',
      (await page.$eval('#btnIntervene', el => el.disabled)) === false);
    await clickBar('#btnReturn');
    await page.waitForFunction(() => document.querySelector('#returnModal').classList.contains('show'), { timeout: 5000 });
    ok('【退回】按钮打开退回弹窗（要求填写退回原因）',
      (await page.$eval('#returnModal .modal-head', el => el.textContent)).includes('退回'));
    await page.click('#returnConfirm');
    await sleep(400);
    ok('退回原因为空 → 提示「请填写退回原因」',
      (await page.$eval('#returnErr', el => el.textContent.trim())) === '请填写退回原因');
    await page.click('[data-close="returnModal"]');
    await sleep(300);
    await clickBar('#btnEscalate');
    await page.waitForFunction(() => document.querySelector('#escalateModal').classList.contains('show'), { timeout: 5000 });
    ok('【无法决定-提交主审核官】弹窗文案符合需求',
      (await page.$eval('#escalateModal .modal-body', el => el.textContent))
        .includes('此将视为您无法决定该申请是否通过，审核表将提交至最高管理员审核'));
    await page.click('[data-close="escalateModal"]');
    await sleep(300);
    await page.screenshot({ path: path.join(SHOT_DIR, '7b-action-bar.png') });

    /* 审核通过（详情页已打开） */
    await page.waitForFunction(() => document.querySelector('#btnApprove'), { timeout: 10000 });
    await clickBar('#btnApprove');
    await page.waitForFunction(() => document.querySelector('#approveModal').classList.contains('show'), { timeout: 8000 });
    await page.select('#approveDept', 'COS部');
    await page.screenshot({ path: path.join(SHOT_DIR, '7-approve-modal.png') });
    await page.click('#approveConfirm');
    await page.waitForFunction(() => document.querySelector('#detailBody').textContent.includes('推荐进入部门'), { timeout: 10000 });
    ok('审核通过后显示推荐部门与审核信息',
      (await page.$eval('#detailBody', el => el.textContent)).includes('COS部'));
    /* 超管有介入权限：审核按钮置灰而不是消失，可用【审核介入】改判（需求） */
    const decidedBar = await page.evaluate(() => {
      const bar = document.querySelector('#detailBody .action-bar');
      const app = bar.querySelector('#btnApprove');
      const ivn = bar.querySelector('#btnIntervene');
      return {
        text: bar.textContent.replace(/\s+/g, ' '),
        hasApprove: !!app, approveDisabled: app ? app.disabled : null,
        hasIvn: !!ivn, ivnDisabled: ivn ? ivn.disabled : null
      };
    });
    ok('审核后审核按钮置灰不可点', decidedBar.hasApprove === true && decidedBar.approveDisabled === true, decidedBar);
    ok('审核结果不可直接二次修改（提示"如需改判请先点【审核介入】接管"）',
      decidedBar.text.includes('如需改判'), decidedBar.text.slice(0, 160));
    ok('有介入权限的账号此时仍可点【审核介入】', decidedBar.hasIvn === true && decidedBar.ivnDisabled === false, decidedBar);
    await page.screenshot({ path: path.join(SHOT_DIR, '8-approved.png'), fullPage: true });

    /* 查询页：审核通过 */
    const p3 = await browser.newPage();
    await p3.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    await p3.type('#cnInput', CN);
    await p3.click('#queryBtn');
    await p3.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    const tl3 = await p3.$$eval('#resultArea .tl-node', els => els.map(e => e.className));
    ok('用户查询页显示「审核通过」',
      (await p3.$eval('.timeline-card .badge', el => el.textContent.trim())) === '审核通过');
    ok('通过：①②③均点亮，④为绿色终点',
      /\bdone\b/.test(tl3[0]) && /\bdone\b/.test(tl3[1]) && /\bdone\b/.test(tl3[2]) &&
      /\bcurrent\b/.test(tl3[3]) && /\bok\b/.test(tl3[3]), tl3);
    ok('通过终点节点为绿色',
      (await p3.evaluate(() => getComputedStyle(
        document.querySelectorAll('#resultArea .tl-node')[3].querySelector('.tl-dot')).backgroundColor)) === 'rgb(35, 160, 107)');
    ok('用户查询页显示推荐进入部门',
      (await p3.$eval('.timeline-card', el => el.textContent)).includes('COS部'));
    ok('审核通过（终审）后不显示【催促审核】按钮',
      (await p3.$$('#resultArea [data-urge]')).length === 0 && (await p3.$$('.urge-bar')).length === 0);
    await p3.screenshot({ path: path.join(SHOT_DIR, '9-status-approved.png'), fullPage: true });

    /* 审核拒绝：终点应为红色，并显示拒绝理由 */
    const rejCn = 'R' + Date.now().toString().slice(-6);
    await page.evaluate(async (cn) => {
      const token = localStorage.getItem('club_admin_token');
      const payload = {
        cn, qq: '987654321', age: 21, joinYears: '3年', province: '广东省', city: '广州市',
        gender: '男', height: 175, hobbies: '舞台剧', hasExperience: '无', experienceDesc: '',
        favoriteWorks: '《咒术回战》', otherClub: '是', otherClubName: '某校外社团',
        department: '后勤部', introduction: '拒绝分支测试', viewOn2D: '喜欢二次元',
        agreeRules: '是', referralCode: '', inviterCn: ''
      };
      const r = await fetch('/api/applications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const j = await r.json();
      await fetch('/api/applications/' + j.id + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'reject', reason: '不符合入社部门要求' })
      });
    }, rejCn);

    await p3.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    await p3.type('#cnInput', rejCn);
    await p3.click('#queryBtn');
    await p3.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    const tl4 = await p3.$$eval('#resultArea .tl-node', els => els.map(e => e.className));
    ok('拒绝：①②③均点亮，④为红色终点',
      /\bdone\b/.test(tl4[0]) && /\bdone\b/.test(tl4[1]) && /\bdone\b/.test(tl4[2]) &&
      /\bcurrent\b/.test(tl4[3]) && /\berr\b/.test(tl4[3]), tl4);
    ok('拒绝终点节点为红色',
      (await p3.evaluate(() => getComputedStyle(
        document.querySelectorAll('#resultArea .tl-node')[3].querySelector('.tl-dot')).backgroundColor)) === 'rgb(224, 72, 77)');
    ok('拒绝终点标题为「审核拒绝」',
      (await p3.$eval('#resultArea .tl-node:last-child .tl-title', el => el.textContent.trim())) === '审核拒绝');
    ok('时间线下方显示拒绝理由',
      (await p3.$eval('.tl-detail', el => el.textContent)).includes('不符合入社部门要求'));
    await p3.screenshot({ path: path.join(SHOT_DIR, '9b-status-rejected.png'), fullPage: true });

    /* ---------- 复审规则：初审拒绝 → 复审1；复审1被退回 → 复审2；之后永久结束 ---------- */
    ok('审核拒绝时显示【前往修改 - 提交复审】按钮',
      (await p3.$$('#resultArea [data-resubmit]')).length === 1);
    const hint1 = await p3.$eval('.resubmit-bar .small', el => el.textContent.replace(/\s+/g, ' '));
    ok('按钮旁提示「最多 2 次机会、本次为第 1 次」',
      hint1.includes('2 次') && hint1.includes('第 1 次'), hint1);
    await p3.click('#resultArea [data-resubmit]');
    await p3.waitForFunction(() => document.querySelector('#resubmitModal').classList.contains('show'), { timeout: 8000 });
    const rsBody = await p3.$eval('#resubmitModal .modal-body', el => el.textContent.replace(/\s+/g, ' '));
    ok('确认弹窗文案为「您确认修改并重新复审吗？」', rsBody.includes('您确认修改并重新复审吗？'));
    ok('确认弹窗说明最多 2 次复审机会', rsBody.includes('最多可提交 2 次'), rsBody);
    ok('确认弹窗说明本次是第 1 次', rsBody.includes('本次为第 1 次'), rsBody);
    ok('确认弹窗说明复审被退回还能再改 1 次', rsBody.includes('被退回') && rsBody.includes('还可再修改 1 次'), rsBody);
    ok('确认弹窗说明复审被拒绝后不再提供机会', rsBody.includes('拒绝') && rsBody.includes('不再提供机会'), rsBody);
    await p3.screenshot({ path: path.join(SHOT_DIR, '9b2-resubmit-modal-1.png') });

    await p3.type('#rsQq', '000000000');
    await p3.click('#rsOk');
    await p3.waitForFunction(() => document.querySelector('#rsErr').style.display !== 'none', { timeout: 10000 });
    ok('QQ号不匹配 → 拒绝进入编辑（仍停留在查询页）',
      (await p3.$eval('#rsErr', el => el.textContent.trim())).length > 0 && p3.url().includes('/status'),
      await p3.$eval('#rsErr', el => el.textContent.trim()));

    await p3.evaluate(() => { document.querySelector('#rsQq').value = ''; });
    await p3.type('#rsQq', '987654321');
    await p3.click('#rsOk');
    await p3.waitForFunction(() => location.pathname === '/' && location.search.includes('edit='), { timeout: 20000 });
    await p3.waitForFunction(() => document.querySelector('#editNotice').style.display !== 'none', { timeout: 10000 });
    ok('校验通过 → 跳转填写页并进入复审模式',
      (await p3.$eval('#editNotice', el => el.textContent)).includes('您正在提交复审'));
    const pre = await p3.evaluate(() => ({
      cn: document.querySelector('#cn').value,
      qq: document.querySelector('#qq').value,
      age: document.querySelector('#age').value,
      dept: (document.querySelector('input[name="department"]:checked') || {}).value || '',
      btn: document.querySelector('#submitBtn').textContent.trim()
    }));
    ok('表单回填原申请数据（CN / QQ号 / 年龄 / 部门）',
      pre.cn === rejCn && pre.qq === '987654321' && pre.age === '21' && pre.dept === '后勤部', pre);
    ok('提交按钮变为「提交复审」', pre.btn === '提交复审', pre.btn);
    await p3.screenshot({ path: path.join(SHOT_DIR, '9c-resubmit-edit.png') });

    /* 改一处内容后提交第 1 次复审 */
    await p3.evaluate(() => {
      const h = document.querySelector('#hobbies');
      h.value = '第一次复审修改';
      h.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p3.click('#submitBtn');
    await p3.waitForFunction(() => document.querySelector('#okModal').classList.contains('show'), { timeout: 25000 });
    ok('第 1 次复审提交成功并弹出提示',
      (await p3.$eval('#okTitle', el => el.textContent)).includes('复审申请已提交'));
    await p3.click('#okClose');
    await p3.waitForFunction(() => location.pathname === '/status', { timeout: 15000 });

    /* 复审1 提交后的查询页 */
    await p3.type('#cnInput', rejCn);
    await p3.click('#queryBtn');
    await p3.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    ok('复审后时间线首节点变为「已提交复审申请」',
      (await p3.$eval('#resultArea .tl-node .tl-title', el => el.textContent.trim())) === '已提交复审申请');
    ok('复审后状态徽章为「已提交复审申请」',
      (await p3.$eval('.timeline-card .badge', el => el.textContent.trim())) === '已提交复审申请');
    ok('复审审核中不显示【前往修改-提交复审】按钮',
      (await p3.$$('#resultArea [data-resubmit]')).length === 0);
    ok('查询页显示「已使用 1 / 2 次」复审机会',
      (await p3.$eval('.tl-detail', el => el.textContent)).includes('已使用 1 / 2 次'));
    await p3.screenshot({ path: path.join(SHOT_DIR, '9d-status-resubmitted.png'), fullPage: true });

    /* ---------- 审核员把「复审1」退回 → 申请人获得第 2 次机会 ---------- */
    /* 后台页闲置了一阵（p3 那边在提交复审），每次交互前先切到前台并留一点时间，
       否则 page.click / page.type / 截图（走输入与合成管线）会偶发协议超时 */
    const front = async () => { try { await page.bringToFront(); } catch (e) { } await sleep(200); };
    /* 同一个浏览器里多个页面轮流操作时，闲置过的那个页面必须先切到前台，
       否则 click / type / 截图（走输入与合成管线）会偶发协议超时 */
    const frontOf = async pg => { try { await pg.bringToFront(); } catch (e) { } await sleep(200); };
    const shot = async (name, full) => {
      /* 截图只是取证，失败不应让整轮测试挂掉 */
      try { await front(); await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: !!full }); }
      catch (e) { console.log('    （截图 ' + name + ' 失败：' + e.message + '）'); }
    };
    await front();
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1200);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await page.type('#fQ', rejCn);
    await sleep(400);
    ok('后台列表显示标签「复审申请表，请谨慎审核」',
      (await page.$eval('#listBody tr[data-id]', el => el.textContent)).includes('复审申请表，请谨慎审核'));
    /* 长时间没操作后台页时，puppeteer 的 page.click 偶发协议超时 → 统一用 evaluate 触发 */
    const openRow = async () => {
      await page.evaluate(() => { const tr = document.querySelector('#listBody tr[data-id]'); if (tr) tr.click(); });
      await page.waitForFunction(() => !!document.querySelector('#btnReturn'), { timeout: 15000 });
      await sleep(300);
    };
    await openRow();
    ok('详情页操作栏提示该申请已复审 1/2 次',
      (await page.$eval('#detailBody .action-bar .muted', el => el.textContent)).includes('已复审 1/2 次'));

    await clickBar('#btnReturn');
    await page.waitForFunction(() => document.querySelector('#returnModal').classList.contains('show'), { timeout: 5000 });
    const retNotice = await page.$eval('#returnNotice', el => el.textContent.replace(/\s+/g, ' '));
    ok('退回弹窗提示「本次退回后申请人将获得第 2 次修改机会」',
      retNotice.includes('第 2') && retNotice.includes('修改机会'), retNotice);
    ok('退回弹窗说明这是最后一次', retNotice.includes('最后一次'), retNotice);
    await front();
    await page.type('#returnReason', '复审后仍缺材料，请再补充');
    await front();
    await page.click('#returnConfirm');
    await page.waitForFunction(() => !document.querySelector('#returnModal').classList.contains('show'), { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#detailBody').textContent.includes('审核员退回'), { timeout: 10000 });
    ok('复审1 被成功退回', true);
    await shot('9d2-admin-return-resubmit.png', true);

    /* 申请人再看：复审被退回 → 额外 1 次机会 */
    await frontOf(p3);
    await p3.click('#queryBtn');
    await p3.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    ok('复审被退回后状态徽章为「复审申请被退回」',
      (await p3.$eval('.timeline-card .badge', el => el.textContent.trim())) === '复审申请被退回');
    ok('复审被退回后时间线节点标题为「复审申请被管理员退回」',
      (await p3.$eval('#resultArea .tl-node:last-child .tl-title', el => el.textContent.trim())) === '复审申请被管理员退回');
    ok('复审被退回后【再次】出现【前往修改 - 提交复审】按钮',
      (await p3.$$('#resultArea [data-resubmit]')).length === 1);
    const hint2 = await p3.$eval('.resubmit-bar .small', el => el.textContent.replace(/\s+/g, ' '));
    ok('按钮旁提示「最后一次复审机会（第 2/2 次）」',
      hint2.includes('最后一次') && hint2.includes('2/2'), hint2);
    await p3.screenshot({ path: path.join(SHOT_DIR, '9d3-status-returned-resubmit.png'), fullPage: true });

    /* 提交第 2 次复审 */
    await frontOf(p3);
    await p3.click('#resultArea [data-resubmit]');
    await p3.waitForFunction(() => document.querySelector('#resubmitModal').classList.contains('show'), { timeout: 8000 });
    const rsBody2 = await p3.$eval('#resubmitModal .modal-body', el => el.textContent.replace(/\s+/g, ' '));
    ok('第 2 次确认弹窗提示这是「最后一次」机会',
      rsBody2.includes('最后一次') && rsBody2.includes('2/2'), rsBody2);
    await p3.type('#rsQq', '987654321');
    await p3.click('#rsOk');
    await p3.waitForFunction(() => location.pathname === '/' && location.search.includes('edit='), { timeout: 20000 });
    const pre2 = await p3.evaluate(() => ({
      hobbies: document.querySelector('#hobbies').value,
      btn: document.querySelector('#submitBtn').textContent.trim()
    }));
    ok('回填的是第 1 次复审修改后的内容', pre2.hobbies === '第一次复审修改', pre2);
    await p3.click('#submitBtn');
    await p3.waitForFunction(() => document.querySelector('#okModal').classList.contains('show'), { timeout: 25000 });
    await p3.click('#okClose');
    await p3.waitForFunction(() => location.pathname === '/status', { timeout: 15000 });
    await frontOf(p3);
    await p3.type('#cnInput', rejCn);       // 提交复审后跳回查询页，输入框是空的，需要重新填
    await p3.click('#queryBtn');
    await p3.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    ok('第 2 次复审提交后状态为「已提交复审申请」',
      (await p3.$eval('.timeline-card .badge', el => el.textContent.trim())) === '已提交复审申请');
    ok('查询页显示「已使用 2 / 2 次」复审机会',
      (await p3.$eval('.tl-detail', el => el.textContent)).includes('已使用 2 / 2 次'));
    ok('次数用尽后按钮消失',
      (await p3.$$('#resultArea [data-resubmit]')).length === 0);

    /* 审核员把「复审2」再退回 → 申请人不再有任何机会 */
    await front();
    /* 上一轮操作后停在详情页，必须先切回列表页，否则 #fQ 是隐藏的、搜索不会生效 */
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1200);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await front();
    await page.type('#fQ', rejCn);
    await sleep(400);
    await openRow();
    await clickBar('#btnReturn');
    await page.waitForFunction(() => document.querySelector('#returnModal').classList.contains('show'), { timeout: 5000 });
    const retNotice2 = await page.$eval('#returnNotice', el => el.textContent.replace(/\s+/g, ' '));
    ok('复审2 退回时弹窗提示「机会已用尽，申请人无法再次提交」',
      retNotice2.includes('无法再次提交'), retNotice2);
    await front();
    await page.type('#returnReason', '仍然不合格');
    await front();
    await page.click('#returnConfirm');
    await page.waitForFunction(() => !document.querySelector('#returnModal').classList.contains('show'), { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#detailBody').textContent.includes('审核员退回'), { timeout: 10000 });
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });

    await frontOf(p3);
    await p3.click('#queryBtn');
    await p3.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    ok('用完 2 次后再退回，按钮【永久消失】',
      (await p3.$$('#resultArea [data-resubmit]')).length === 0);
    ok('页面明确提示「已用完 2 次复审机会」',
      (await p3.$eval('.resubmit-bar', el => el.textContent)).includes('已用完 2 次复审机会'),
      await p3.$eval('.resubmit-bar', el => el.textContent));
    ok('节点标题仍为「复审申请被管理员退回」',
      (await p3.$eval('#resultArea .tl-node:last-child .tl-title', el => el.textContent.trim())) === '复审申请被管理员退回');
    await p3.screenshot({ path: path.join(SHOT_DIR, '9e-status-no-more-chance.png'), fullPage: true });

    /* 后台列表：复审标签 */
    await front();
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    /* 复审后的这条申请是在后台登录之后新建的，列表必须重新拉取一次才会出现。
       用 evaluate 触发点击：puppeteer 的 page.click 对工具栏按钮偶发协议超时 */
    await page.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1500);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await sleep(300);
    await front();
    await page.type('#fQ', rejCn);
    await sleep(400);
    ok('后台列表显示标签「复审申请表，请谨慎审核」',
      (await page.$eval('#listBody tr[data-id]', el => el.textContent)).includes('复审申请表，请谨慎审核'));
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await sleep(300);

    await p3.close();

    /* ================= 4. 管理员账号管理 ================= */
    console.log('\n[4] 管理员账号管理页');
    await page.evaluate(() => { location.hash = '#/admins'; });
    await page.waitForFunction(() => document.querySelector('#viewAdmins').style.display !== 'none', { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll('#adminsBody tr').length > 0, { timeout: 8000 });
    ok('账号列表显示最高管理员',
      (await page.$eval('#adminsBody', el => el.textContent)).includes('最高权限管理员'));
    ok('最高管理员显示“不可删除”',
      (await page.$eval('#adminsBody', el => el.textContent)).includes('超管账号不可删除'));

    await page.click('#btnAddAdmin');
    await page.waitForFunction(() => document.querySelector('#addAdminModal').classList.contains('show'), { timeout: 5000 });
    await sleep(250);   // 等弹窗自动聚焦的定时器跑完，避免输入被打到别的字段
    await page.type('#newUsername', SUBUSER);
    await page.type('#newPassword', SUBPASS);
    await page.type('#newNote', 'UI 测试审核员');
    await page.click('#addAdminConfirm');
    await page.waitForFunction(() => !document.querySelector('#addAdminModal').classList.contains('show'), { timeout: 10000 });
    await page.waitForFunction(n => document.querySelector('#adminsBody').textContent.includes(n), { timeout: 10000 }, SUBUSER);
    ok('新增分管理员成功', true);

    /* 超管设置子账号备注 */
    await page.evaluate(n => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(n));
      tr.querySelector('[data-note]').click();
    }, SUBUSER);
    await page.waitForFunction(() => document.querySelector('#noteModal').classList.contains('show'), { timeout: 5000 });
    await sleep(250);   // 同上：等自动聚焦定时器跑完
    ok('超管可打开「设置子账号备注」弹窗', true);
    await page.evaluate(() => { document.querySelector('#noteInput').value = ''; });
    await page.type('#noteInput', NOTE);
    await page.click('#noteConfirm');
    await page.waitForFunction(() => !document.querySelector('#noteModal').classList.contains('show'), { timeout: 10000 });
    await page.waitForFunction(n => document.querySelector('#adminsBody').textContent.includes(n), { timeout: 10000 }, NOTE);
    ok('备注保存后在账号列表显示', true);
    await page.screenshot({ path: path.join(SHOT_DIR, '10-admins.png') });

    /* ================= 4b. 停用账号 / 解除停用（超管独有） ================= */
    console.log('  --- 账号停用 ---');
    const rowBtns = n => page.evaluate(name => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(name));
      return tr ? Array.from(tr.querySelectorAll('button')).map(b => b.textContent.trim()) : null;
    }, n);

    const subBtns = await rowBtns(SUBUSER);
    ok('子账号行出现【设置权限】按钮（原【关闭权限】已改名）', !!subBtns && subBtns.includes('设置权限'), subBtns);
    ok('不再出现旧的【关闭权限】文案', !!subBtns && !subBtns.includes('关闭权限'), subBtns);
    ok('【设置权限】紧邻在【删除】左边',
      !!subBtns && subBtns.indexOf('设置权限') === subBtns.indexOf('删除') - 1, subBtns);
    const superBtns = await page.evaluate(() => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes('最高权限管理员'));
      return tr ? Array.from(tr.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
    });
    ok('超管行没有【设置权限】按钮（不可停用/改超管权限）', !superBtns.includes('设置权限'), superBtns);

    const clickBan = async (name) => {
      await page.evaluate(n => {
        const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(n));
        tr.querySelector('[data-settings]').click();
      }, name);
      await page.waitForFunction(() => document.querySelector('#banModal').classList.contains('show'), { timeout: 5000 });
    };

    await clickBan(SUBUSER);
    ok('弹窗标题为「设置权限」',
      (await page.$eval('#banModal .modal-head', el => el.textContent.trim())) === '设置权限');
    /* 权限分配区四要素 */
    const permIds = ['#permReview', '#permSystem', '#permBan', '#permIntervene'];
    const permLabels = await page.$$eval('#permBox .perm-item b', els => els.map(e => e.textContent.trim()));
    ok('弹窗内有 4 项权限可分配（审核/系统设置/封禁账号/主审核官介入）',
      permLabels.join(',') === '审核权限,系统设置权限,封禁账号权限,主审核官介入权限', permLabels);
    ok('4 个权限勾选框都在', (await page.$$(permIds.join(','))).length === 4);
    ok('新建子账号默认已勾选【审核权限】', (await page.$eval('#permReview', el => el.checked)) === true);
    ok('默认未勾选【系统设置权限】', (await page.$eval('#permSystem', el => el.checked)) === false);
    ok('默认未勾选【封禁账号权限】', (await page.$eval('#permBan', el => el.checked)) === false);
    ok('默认未勾选【主审核官介入权限】', (await page.$eval('#permIntervene', el => el.checked)) === false);
    ok('权限区说明「各权限相互独立」',
      (await page.$eval('#permBox', el => el.textContent)).includes('各权限相互独立'));
    await page.screenshot({ path: path.join(SHOT_DIR, '10b-perm-modal.png') });
    ok('① 有「启用停用」开关',
      (await page.$eval('#banEnabled', el => el.type)) === 'checkbox');
    ok('② 有日期选择器（日历组件）',
      (await page.$eval('#banUntil', el => el.type)) === 'date');
    /* 日期下限必须是未来（动态设置的"明天"） */
    const minAttr = await page.$eval('#banUntil', el => el.min);
    const tomorrow = await page.evaluate(() => {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(Date.now() + 86400000)).reduce((o, x) => (o[x.type] = x.value, o), {});
      return `${p.year}-${p.month}-${p.day}`;
    });
    ok('日期选择器只允许选未来日期（min = 明天）', minAttr === tomorrow, { minAttr, tomorrow });
    ok('默认回填的解封日期即最早可选日期', (await page.$eval('#banUntil', el => el.value)) === tomorrow);
    ok('③ 有封禁理由输入框',
      (await page.$eval('#banReason', el => el.tagName + ':' + el.type)) === 'INPUT:text');
    ok('弹窗底部为【取消】【确定】',
      (await page.$$eval('#banModal .modal-foot button', els => els.map(e => e.textContent.trim()))).join(',') === '取消,确定');
    ok('开关默认关闭时隐藏日期与理由',
      (await page.$eval('#banFields', el => el.style.display)) === 'none');

    await page.click('#banEnabled');
    await sleep(250);
    ok('打开开关后显示日期与理由',
      (await page.$eval('#banFields', el => el.style.display)) !== 'none');
    const dur0 = await page.$eval('#banDuration', el => el.textContent.trim());
    ok('自动计算封禁时长', /停用时长约\s*\d+\s*天/.test(dur0), dur0);

    /* 选择一个未来日期（按东八区计算，与服务端一致） */
    const untilYmd = await page.evaluate(() => {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(Date.now() + 5 * 86400000)).reduce((o, x) => (o[x.type] = x.value, o), {});
      return `${p.year}-${p.month}-${p.day}`;
    });
    await page.evaluate(v => {
      const i = document.querySelector('#banUntil');
      i.value = v;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, untilYmd);
    await sleep(250);
    const dur1 = await page.$eval('#banDuration', el => el.textContent.trim());
    ok('选择日期后时长自动更新', /停用时长约\s*[456]\s*天/.test(dur1), dur1);
    await page.type('#banReason', '多次缺席社团活动');
    await page.screenshot({ path: path.join(SHOT_DIR, '10b-ban-modal.png') });
    await page.click('#banConfirm');
    await page.waitForFunction(() => !document.querySelector('#banModal').classList.contains('show'), { timeout: 10000 });
    await page.waitForFunction(n => document.querySelector('#adminsBody').textContent.includes('账号已被停用'), { timeout: 10000 }, SUBUSER);

    const tagText = await page.evaluate(n => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(n));
      const t = tr && tr.querySelector('.ban-tag');
      return t ? t.textContent.trim() : '';
    }, SUBUSER);
    ok('账号卡片上显示「账号已被停用，停用至：XXXX年XX月XX日」',
      /^账号已被停用，停用至：\d{4}年\d{2}月\d{2}日$/.test(tagText), tagText);
    await page.screenshot({ path: path.join(SHOT_DIR, '10c-banned-list.png') });

    /* 被停用账号尝试登录 → 弹出停用提示 */
    const banCtx = await browser.createBrowserContext();
    const pb = await banCtx.newPage();
    await pb.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await pb.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await pb.type('#username', SUBUSER);
    await pb.type('#password', SUBPASS);
    await pb.click('#loginBtn');
    await pb.waitForFunction(() => document.querySelector('#banNoticeModal').classList.contains('show'), { timeout: 15000 });
    const notice = await pb.evaluate(() => ({
      msg: document.querySelector('#banNoticeModal .notice').textContent.trim(),
      start: document.querySelector('#bnStart').textContent.trim(),
      until: document.querySelector('#bnUntil').textContent.trim(),
      reason: document.querySelector('#bnReason').textContent.trim()
    }));
    ok('停用账号登录被拒并弹出提示弹窗', true);
    ok('提示内容为「您的账户已被示例动漫社停用」',
      notice.msg === '您的账户已被示例动漫社停用', notice.msg);
    ok('提示含停用开始时间（xxxx年xx月xx日）', /^\d{4}年\d{2}月\d{2}日$/.test(notice.start), notice.start);
    ok('提示含解封时间（xxxx年xx月xx日）', /^\d{4}年\d{2}月\d{2}日$/.test(notice.until), notice.until);
    ok('提示含封禁原因', notice.reason === '多次缺席社团活动', notice.reason);
    await sleep(400);   // 等入场动画结束再截图
    await pb.screenshot({ path: path.join(SHOT_DIR, '10d-ban-notice.png') });
    await banCtx.close();

    /* 解除停用 */
    await clickBan(SUBUSER);
    ok('再次打开时开关回填为已开启', await page.$eval('#banEnabled', el => el.checked));
    ok('日期回填为当前解封日期', (await page.$eval('#banUntil', el => el.value)) === untilYmd);
    ok('理由回填', (await page.$eval('#banReason', el => el.value)) === '多次缺席社团活动');
    await page.click('#banEnabled');           // 关闭开关 = 解除停用
    await sleep(250);
    await page.click('#banConfirm');
    await page.waitForFunction(n => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(n));
      return tr && !tr.querySelector('.ban-tag');
    }, { timeout: 10000 }, SUBUSER);
    ok('解除停用后状态标签消失', true);

    /* ================= 4c. 审核介入（仅主审核官权限） ================= */
    console.log('  --- 审核介入 ---');
    /* 造一条待审核申请（用后台登录态直接调接口），随后在详情页执行介入 */
    const ivnCn = 'IV' + Date.now().toString().slice(-6);
    const ivnId = await page.evaluate(async (cn) => {
      const payload = {
        cn, qq: '321654987', age: 22, joinYears: '2年', province: '广东省', city: '广州市',
        gender: '男', height: 178, hobbies: '介入测试', hasExperience: '无', experienceDesc: '',
        favoriteWorks: '《介入》', otherClub: '否', otherClubName: '',
        department: '后勤部', introduction: '介入测试', viewOn2D: '喜欢', agreeRules: '是',
        referralCode: '', inviterCn: ''
      };
      const r = await fetch('/api/applications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      return (await r.json()).id;
    }, ivnCn);
    await front();
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1200);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await front();
    await page.type('#fQ', ivnCn);
    await sleep(400);
    await page.evaluate(() => { const tr = document.querySelector('#listBody tr[data-id]'); if (tr) tr.click(); });
    await page.waitForFunction(() => !!document.querySelector('#btnIntervene'), { timeout: 12000 });
    await sleep(300);
    ok('超管详情页出现【审核介入】按钮', true);
    await clickBar('#btnIntervene');
    await page.waitForFunction(() => document.querySelector('#interveneModal').classList.contains('show'), { timeout: 5000 });
    const ivnBody = await page.$eval('#interveneModal .modal-body', el => el.textContent.replace(/\s+/g, ' '));
    ok('介入弹窗说明会清空已有审核状态',
      ivnBody.includes('清空该申请表已有的审核状态'), ivnBody.slice(0, 120));
    ok('介入弹窗说明状态固定为「主审核官介入中」', ivnBody.includes('主审核官介入中'), ivnBody);
    ok('介入弹窗说明其他审核员按钮会置灰', ivnBody.includes('置灰'), ivnBody);
    ok('介入弹窗说明审核后锁定自动解除', ivnBody.includes('锁定自动解除'), ivnBody);
    await page.screenshot({ path: path.join(SHOT_DIR, '10e-intervene-modal.png') });
    await page.evaluate(() => document.querySelector('#interveneConfirm').click());
    await page.waitForFunction(() => document.querySelector('#detailBody').textContent.includes('主审核官介入中'), { timeout: 12000 });
    ok('介入后详情页显示「主审核官介入中」', true);
    const ivnDetail = await page.$eval('#detailBody', el => el.textContent.replace(/\s+/g, ' '));
    ok('详情页显示介入人与介入时间', ivnDetail.includes('介入人') && ivnDetail.includes('介入时间'), ivnDetail.slice(0, 200));
    ok('介入后【审核介入】按钮变为置灰不可点（不能重复介入）',
      (await page.$eval('#detailBody #btnIntervene', el => el.disabled)) === true,
      (await page.$$('#detailBody #btnIntervene')).length);
    await page.screenshot({ path: path.join(SHOT_DIR, '10f-intervened.png'), fullPage: true });

    /* 列表里能看到「主审核官介入中」状态 */
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1200);
    const ivnRow = await page.$eval('#listBody tr[data-id]', el => el.textContent);
    ok('列表状态显示「主审核官介入中」', ivnRow.includes('主审核官介入中'), ivnRow.slice(0, 80));

    /* 查询页时间线：新增「主审核官介入中」节点 */
    const pIv = await browser.newPage();
    await pIv.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    await pIv.type('#cnInput', ivnCn);
    await pIv.click('#queryBtn');
    await pIv.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 15000 });
    ok('查询页状态徽章为「该申请表已由主审核官介入」',
      (await pIv.$eval('.timeline-card .badge', el => el.textContent.trim())) === '该申请表已由主审核官介入');
    ok('时间线第④节点为「主审核官介入中」',
      (await pIv.$eval('#resultArea .tl-node:last-child .tl-title', el => el.textContent.trim())) === '主审核官介入中');
    ok('时间线有 4 个节点（介入状态不新增节点数）',
      (await pIv.$$eval('#resultArea .tl-node', els => els.length)) === 4);
    ok('查询页不再显示原审核结论（无推荐部门行）',
      !(await pIv.$eval('.tl-detail', el => el.textContent)).includes('推荐进入部门'));
    await pIv.screenshot({ path: path.join(SHOT_DIR, '10g-status-intervened.png'), fullPage: true });
    await pIv.close();

    /* 分管理员（无介入权限）打开被介入的申请：按钮全部置灰 */
    const lockCtx = await browser.createBrowserContext();     // 独立上下文，避免复用超管登录态
    const pAdmSub = await lockCtx.newPage();
    await pAdmSub.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await pAdmSub.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await pAdmSub.type('#username', SUBUSER);
    await pAdmSub.type('#password', SUBPASS);
    await pAdmSub.click('#loginBtn');
    await pAdmSub.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    await pAdmSub.evaluate((id) => { location.hash = '#/detail/' + id; }, ivnId);
    await pAdmSub.waitForFunction(() => !document.querySelector('#detailBody').textContent.includes('加载中'), { timeout: 12000 });
    await sleep(400);
    const subBtnsState = await pAdmSub.evaluate(() => {
      const bar = document.querySelector('#detailBody .action-bar');
      return {
        text: bar.textContent.replace(/\s+/g, ' '),
        btns: Array.from(bar.querySelectorAll('button')).map(b => ({ id: b.id, dis: b.disabled })),
        hasIntervene: !!bar.querySelector('#btnIntervene')
      };
    });
    ok('分管理员仍可打开被介入的申请（能看内容）',
      (await pAdmSub.$eval('#detailBody', el => el.textContent)).includes('介入测试'));
    ok('分管理员看到的按钮全部置灰',
      subBtnsState.btns.length >= 4 && subBtnsState.btns.every(b => b.dis === true), subBtnsState.btns);
    ok('分管理员看不到【审核介入】按钮', subBtnsState.hasIntervene === false);
    ok('分管理员看到「已由主审核官介入…按钮已置灰」提示',
      subBtnsState.text.includes('主审核官介入') && subBtnsState.text.includes('置灰'), subBtnsState.text.slice(0, 140));
    await pAdmSub.screenshot({ path: path.join(SHOT_DIR, '10h-subadmin-locked.png'), fullPage: true });
    await pAdmSub.close();
    await lockCtx.close();

    /* 主审核官审核后锁定解除 */
    await front();
    await page.evaluate((id) => { location.hash = '#/detail/' + id; }, ivnId);
    await page.waitForFunction(() => !!document.querySelector('#btnApprove'), { timeout: 12000 });
    await sleep(400);
    ok('介入锁定时主审核官仍可操作（按钮未置灰）',
      (await page.$eval('#btnApprove', el => el.disabled)) === false);
    await page.evaluate(() => document.querySelector('#btnApprove').click());
    await page.waitForFunction(() => document.querySelector('#approveModal').classList.contains('show'), { timeout: 8000 });
    await page.select('#approveDept', '后勤部');
    await page.evaluate(() => document.querySelector('#approveConfirm').click());
    await page.waitForFunction(() => document.querySelector('#detailBody').textContent.includes('审核结果'), { timeout: 12000 });
    const afterIvn = await page.$eval('#detailBody', el => el.textContent);
    ok('主审核官审核后状态变为「审核通过」', afterIvn.includes('审核通过'), afterIvn.slice(0, 120));
    ok('审核后锁定自动解除（不再显示介入中）', !afterIvn.includes('主审核官介入中'), afterIvn.slice(0, 200));
    ok('详情页显示「该审核表已由主审核官接管」+ 最终审核结果',
      afterIvn.includes('该审核表已由主审核官接管') && afterIvn.includes('主审核官最终审核：审核通过'),
      afterIvn.slice(0, 240));

    /* ---------- 需求：已审核通过 / 已拒绝的申请，主审核官依然可以再次介入 ---------- */
    console.log('  --- 已通过的申请再介入 ---');
    await sleep(300);
    const barDecided = await page.evaluate(() => {
      const bar = document.querySelector('#detailBody .action-bar');
      const ivn = bar.querySelector('#btnIntervene');
      const app = bar.querySelector('#btnApprove');
      return {
        text: bar.textContent.replace(/\s+/g, ' '),
        hasIvn: !!ivn, ivnDisabled: ivn ? ivn.disabled : null,
        hasApprove: !!app, approveDisabled: app ? app.disabled : null
      };
    });
    ok('已通过的申请，操作栏仍保留【审核介入】按钮', barDecided.hasIvn === true, barDecided);
    ok('已通过的申请，【审核介入】依然可以点击（核心需求）', barDecided.ivnDisabled === false, barDecided);
    ok('已通过的申请，审核按钮置灰不可点（需先介入）', barDecided.approveDisabled === true, barDecided);
    ok('操作栏提示"如需改判请先点【审核介入】接管"', barDecided.text.includes('如需改判'), barDecided.text.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT_DIR, '10j-approved-can-intervene.png'), fullPage: true });

    await clickBar('#btnIntervene');
    await page.waitForFunction(() => document.querySelector('#interveneModal').classList.contains('show'), { timeout: 5000 });
    ok('弹窗显示介入前状态为「审核通过」',
      (await page.$eval('#interveneFrom', el => el.textContent.trim())) === '审核通过');
    await page.evaluate(() => document.querySelector('#interveneConfirm').click());
    /* 注意：不能等"该审核表已由主审核官接管"——上一轮介入的提示里也有这句，
       必须等状态本身变成「主审核官介入中」且不是加载中 */
    await page.waitForFunction(() => {
      const t = document.querySelector('#detailBody').textContent;
      return t.includes('主审核官介入中') && !t.includes('加载中');
    }, { timeout: 15000 });
    const afterSecondIvn = await page.$eval('#detailBody', el => el.textContent.replace(/\s+/g, ' '));
    ok('已通过的申请可以再次被介入（状态回到「主审核官介入中」）',
      afterSecondIvn.includes('主审核官介入中'), afterSecondIvn.slice(0, 160));
    ok('再次介入后原通过结论被清空（不再显示推荐进入部门）',
      !afterSecondIvn.includes('推荐进入部门'), afterSecondIvn.slice(0, 240));
    ok('再次介入后可点【审核通过/不通过/退回】',
      (await page.$eval('#btnReturn', el => el.disabled)) === false);

    /* 主审核官这次给【退回】→ 查询页第④节点显示「主审核官退回你的申请」 */
    await clickBar('#btnReturn');
    await page.waitForFunction(() => document.querySelector('#returnModal').classList.contains('show'), { timeout: 5000 });
    await front();
    await page.type('#returnReason', '主审核官复核后请补充材料');
    await page.evaluate(() => document.querySelector('#returnConfirm').click());
    await page.waitForFunction(() => document.querySelector('#detailBody').textContent.includes('主审核官最终审核：审核员退回'), { timeout: 12000 });
    const afterIvnReturn = await page.$eval('#detailBody', el => el.textContent.replace(/\s+/g, ' '));
    ok('主审核官退回后详情页显示「主审核官最终审核：审核员退回」',
      afterIvnReturn.includes('主审核官最终审核：审核员退回'), afterIvnReturn.slice(0, 240));
    await page.screenshot({ path: path.join(SHOT_DIR, '10k-final-by-intervene.png'), fullPage: true });

    /* 审核列表里要写「主审核官最终审核是什么」 */
    await front();
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1200);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await front();
    await page.type('#fQ', ivnCn);
    await sleep(400);
    const listRowText = await page.$eval('#listBody tr[data-id]', el => el.textContent.replace(/\s+/g, ' '));
    ok('审核列表显示「主审核官最终审核：审核员退回」',
      listRowText.includes('主审核官最终审核：审核员退回'), listRowText.slice(0, 200));
    await page.screenshot({ path: path.join(SHOT_DIR, '10l-list-final-by-intervene.png') });
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });

    /* 申请人查询页：第④节点按主审核官口径显示 */
    const pIvn2 = await browser.newPage();
    await pIvn2.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    await pIvn2.type('#cnInput', ivnCn);
    await pIvn2.click('#queryBtn');
    await pIvn2.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 15000 });
    ok('查询页第④节点显示「主审核官退回你的申请」',
      (await pIvn2.$eval('#resultArea .tl-node:last-child .tl-title', el => el.textContent.trim())) === '主审核官退回你的申请',
      await pIvn2.$eval('#resultArea .tl-node:last-child .tl-title', el => el.textContent.trim()));
    ok('查询页显示主审核官复核时间',
      (await pIvn2.$eval('.tl-detail', el => el.textContent)).includes('主审核官复核时间'));
    ok('主审核官退回后仍可提交复审（第④节点为橙色警示样式）',
      (await pIvn2.$$('#resultArea [data-resubmit]')).length === 1);
    await pIvn2.screenshot({ path: path.join(SHOT_DIR, '10m-status-final-by-intervene.png'), fullPage: true });
    await pIvn2.close();

    /* 权限分配：给分管理员开【系统设置权限】，菜单立即出现 */
    console.log('  --- 权限分配 ---');
    await page.evaluate(() => { location.hash = '#/admins'; });
    await page.waitForFunction(() => document.querySelector('#viewAdmins').style.display !== 'none', { timeout: 8000 });
    await clickBan(SUBUSER);
    await page.click('#permSystem');            // 勾选系统设置权限
    await page.click('#permIntervene');         // 勾选介入权限
    await sleep(200);
    await page.screenshot({ path: path.join(SHOT_DIR, '10i-perm-assign.png') });
    await page.click('#banConfirm');
    await page.waitForFunction(() => !document.querySelector('#banModal').classList.contains('show'), { timeout: 10000 });
    await sleep(500);
    const permCell = await page.evaluate(n => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(n));
      return tr ? tr.textContent.replace(/\s+/g, ' ') : '';
    }, SUBUSER);
    ok('账号列表显示已分配的权限标签',
      permCell.includes('系统设置') && permCell.includes('主审核官介入'), permCell.slice(0, 160));

    /* 分管理员重新登录后可见新菜单与介入按钮 */
    const permCtx = await browser.createBrowserContext();     // 独立上下文
    const pAdm2 = await permCtx.newPage();
    await pAdm2.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await pAdm2.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await pAdm2.type('#username', SUBUSER);
    await pAdm2.type('#password', SUBPASS);
    await pAdm2.click('#loginBtn');
    await pAdm2.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    ok('被授予系统设置权限后，分管理员能看到【系统设置】菜单',
      (await pAdm2.$eval('#navSystem', el => el.style.display !== 'none')) === true);
    await pAdm2.evaluate(() => { location.hash = '#/system'; });
    await pAdm2.waitForFunction(() => document.querySelector('#viewSystem').style.display !== 'none', { timeout: 8000 });
    ok('被授权的分管理员可以进入系统设置页', true);
    ok('未授予封禁权限 → 分管理员仍看不到账号管理菜单',
      (await pAdm2.$eval('#navAdmins', el => el.style.display !== 'none')) === false);
    /* 撤销权限 */
    await front();
    await clickBan(SUBUSER);
    await page.click('#permSystem');
    await page.click('#permIntervene');
    await page.click('#banConfirm');
    await page.waitForFunction(() => !document.querySelector('#banModal').classList.contains('show'), { timeout: 10000 });
    await sleep(400);
    await pAdm2.close();
    await permCtx.close();
    ok('权限可撤销（撤销后子账号需重新登录才生效）', true);


    /* ---------- 系统设置（仅超管可见）：菜单 / 页面 / 重启确认弹窗 ---------- */
    console.log('  --- 系统设置 ---');
    const navBtns = await page.$$eval('.admin-nav button', els => els.map(e => e.textContent.trim()));
    ok('超管导航栏出现【系统设置】菜单', navBtns.includes('系统设置'), navBtns);
    ok('【系统设置】排在「管理员账号管理」之后',
      navBtns.indexOf('系统设置') === navBtns.indexOf('管理员账号管理') + 1, navBtns);
    ok('【系统设置】排在「修改密码」之前',
      navBtns.indexOf('系统设置') < navBtns.indexOf('修改密码'), navBtns);
    await page.click('#navSystem');
    await page.waitForFunction(() => document.querySelector('#viewSystem').style.display !== 'none', { timeout: 8000 });
    ok('点击菜单可进入系统设置页', true);
    await page.waitForFunction(() => (document.querySelector('#sysInfo').textContent || '').includes('服务器主机名'),
      { timeout: 10000 });
    const sysText = await page.$eval('#sysInfo', el => el.textContent);
    ok('展示服务器信息（主机名/时间/运行时长/开机时间）',
      sysText.includes('服务器主机名') && sysText.includes('服务器当前时间') &&
      sysText.includes('已连续运行') && sysText.includes('本次开机时间'), sysText.slice(0, 120));
    ok('展示每日定时重启计划（00:00 东八区）',
      sysText.includes('每日定时重启') && sysText.includes('00:00'), sysText.slice(0, 200));
    ok('展示重启记录表（含表头）',
      (await page.$eval('#viewSystem', el => el.textContent)).includes('最近的重启记录'));
    ok('展示服务器侧重启日志区（定时任务留痕）',
      (await page.$eval('#viewSystem', el => el.textContent)).includes('服务器重启日志') &&
      (await page.$eval('#sysLogPath', el => el.textContent)).includes('club-reboot.log'));
    ok('重启日志区有内容或明确的空状态说明',
      ((await page.$eval('#sysLogTail', el => el.textContent.trim())) || '').length > 0);
    const sysPageText = await page.$eval('#viewSystem', el => el.textContent);
    ok('页面明确说明不会删除业务数据',
      sysPageText.includes('不会删除或修改任何业务数据') && sysPageText.includes('不会') && sysPageText.includes('申请表'));
    ok('存在【重启系统】按钮', (await page.$eval('#btnReboot', el => el.textContent.trim())) === '重启系统');
    await page.screenshot({ path: path.join(SHOT_DIR, '12-system-settings.png'), fullPage: true });

    /* 确认弹窗：先点取消，必须什么都不发生 */
    const logBefore = await page.$eval('#rebootLogBody', el => el.textContent.trim());
    await page.click('#btnReboot');
    await page.waitForFunction(() => document.querySelector('#rebootModal').classList.contains('show'), { timeout: 5000 });
    const rebootBody = await page.$eval('#rebootModal .modal-body', el => el.textContent.replace(/\s+/g, ' '));
    ok('弹窗文案为「确认要重启服务器系统吗？」', rebootBody.includes('确认要重启服务器系统吗？'), rebootBody);
    ok('弹窗说明不会删除数据库/申请表/账号', rebootBody.includes('不会删除'), rebootBody);
    await page.screenshot({ path: path.join(SHOT_DIR, '12b-reboot-modal.png') });
    await page.click('[data-close="rebootModal"]');
    await sleep(400);
    ok('点【取消】不会新增任何重启记录',
      (await page.$eval('#rebootLogBody', el => el.textContent.trim())) === logBefore,
      { before: logBefore.slice(0, 60), after: (await page.$eval('#rebootLogBody', el => el.textContent.trim())).slice(0, 60) });

    /* 点确定：走完整链路（测试服务器为演练模式，不会真的重启本机） */
    await page.click('#btnReboot');
    await page.waitForFunction(() => document.querySelector('#rebootModal').classList.contains('show'), { timeout: 5000 });
    await page.click('#rebootConfirm');
    await page.waitForFunction(() => (document.querySelector('#rebootLogBody').textContent || '').includes('手动'),
      { timeout: 15000 });
    const logText = await page.$eval('#rebootLogBody', el => el.textContent);
    ok('确认重启后写入审计记录（方式=手动）', logText.includes('手动'), logText.slice(0, 120));
    ok('审计记录里是当前超管账号', logText.includes('admin'), logText.slice(0, 120));
    ok('演练模式不会弹出"服务器正在重启"遮罩（本机不会被真重启）',
      (await page.$eval('#rebootOverlay', el => el.classList.contains('show'))) === false);
    await page.screenshot({ path: path.join(SHOT_DIR, '12c-reboot-record.png'), fullPage: true });

    /* 分管理员权限隔离（独立上下文，避免共享登录态） */
    const subCtx = await browser.createBrowserContext();
    const p4 = await subCtx.newPage();
    await p4.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await p4.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await p4.type('#username', SUBUSER);
    await p4.type('#password', SUBPASS);
    await p4.click('#loginBtn');
    await p4.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    ok('分管理员登录成功', true);
    const whoText = await p4.$eval('#whoAmI', el => el.textContent.trim());
    ok('右上角显示备注名称而非原始账号名', whoText === NOTE, whoText);
    ok('原始账号名不再直接显示在右上角', whoText !== SUBUSER, whoText);
    ok('分管理员看不到「管理员账号管理」入口',
      (await p4.$eval('#navAdmins', el => el.style.display !== 'none')) === false);
    ok('分管理员可以查看申请列表',
      await p4.$$eval('#listBody tr[data-id]', els => els.length > 0));
    await p4.evaluate(() => { location.hash = '#/admins'; });
    await sleep(400);
    ok('分管理员无法进入账号管理页（自动退回列表）',
      (await p4.$eval('#viewAdmins', el => el.style.display)) === 'none');
    ok('分管理员看不到「系统设置」入口',
      (await p4.$eval('#navSystem', el => el.style.display !== 'none')) === false);
    await p4.evaluate(() => { location.hash = '#/system'; });
    await sleep(400);
    ok('分管理员无法进入系统设置页（自动退回列表）',
      (await p4.$eval('#viewSystem', el => el.style.display)) === 'none');
    ok('分管理员被退回后仍在审核列表页',
      (await p4.$eval('#viewList', el => el.style.display)) !== 'none');
    await p4.evaluate(() => { location.hash = '#/list'; });
    await sleep(300);
    await p4.screenshot({ path: path.join(SHOT_DIR, '11-subadmin-list.png') });

    /* ================= 5. 修改密码（三项校验） ================= */
    console.log('\n[5] 修改密码');
    await p4.click('#navPwd');
    await p4.waitForFunction(() => document.querySelector('#pwdModal').classList.contains('show'), { timeout: 5000 });
    ok('修改密码表单包含旧密码/新密码/确认新密码三项',
      (await p4.$$('#pwdModal input[type="password"]')).length === 3);
    ok('三项输入框 id 正确',
      await p4.evaluate(() => !!(document.querySelector('#oldPassword') &&
        document.querySelector('#newPassword2') && document.querySelector('#confirmPassword'))));

    /* ① 两次新密码不一致 */
    await p4.type('#oldPassword', SUBPASS);
    await p4.type('#newPassword2', SUBPASS2);
    await p4.type('#confirmPassword', 'newpass999');
    await p4.click('#pwdConfirm');
    await p4.waitForFunction(() => document.querySelector('#pwdErr').style.display !== 'none', { timeout: 5000 });
    ok('两次新密码不一致 → 提示错误',
      /不一致/.test(await p4.$eval('#pwdErr', el => el.textContent.trim())));

    /* ② 旧密码错误 */
    await p4.evaluate(() => { document.querySelector('#confirmPassword').value = ''; });
    await p4.type('#confirmPassword', SUBPASS2);
    await p4.evaluate(() => { document.querySelector('#oldPassword').value = ''; });
    await p4.type('#oldPassword', 'wrong-old-pass');
    await p4.click('#pwdConfirm');
    await p4.waitForFunction(() => {
      const e = document.querySelector('#pwdErr');
      return e.style.display !== 'none' && e.textContent.includes('原密码');
    }, { timeout: 10000 });
    ok('旧密码错误 → 提示「原密码错误」',
      /原密码错误/.test(await p4.$eval('#pwdErr', el => el.textContent.trim())));

    /* ③ 全部正确 → 成功提示 */
    await p4.evaluate(() => { document.querySelector('#oldPassword').value = ''; });
    await p4.type('#oldPassword', SUBPASS);
    await p4.click('#pwdConfirm');
    await p4.waitForFunction(() => !document.querySelector('#pwdModal').classList.contains('show'), { timeout: 10000 });
    await p4.waitForFunction(() => {
      const t = document.querySelector('#toast');
      return t && t.classList.contains('show') && t.textContent.includes('成功');
    }, { timeout: 5000 });
    ok('校验通过 → 弹出修改成功提示',
      /成功/.test(await p4.$eval('#toast', el => el.textContent.trim())));

    /* 新密码确实生效 */
    await p4.evaluate(() => localStorage.clear());
    await p4.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await p4.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await p4.type('#username', SUBUSER);
    await p4.type('#password', SUBPASS2);
    await p4.click('#loginBtn');
    await p4.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    ok('新密码可以正常登录', true);
    await subCtx.close();

    /* 删除分管理员 */
    await page.evaluate(n => {
      const tr = Array.from(document.querySelectorAll('#adminsBody tr')).find(r => r.textContent.includes(n));
      tr.querySelector('[data-del]').click();
    }, SUBUSER);
    await page.waitForFunction(() => document.querySelector('#confirmModal').classList.contains('show'), { timeout: 5000 });
    await page.click('#confirmOk');
    await page.waitForFunction(n => !document.querySelector('#adminsBody').textContent.includes(n), { timeout: 10000 }, SUBUSER);
    ok('删除分管理员成功', true);

    /* ================= 6. 导出 Excel ================= */
    console.log('\n[6] 导出 Excel');
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 8000 });
    const client = await page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: path.join(SHOT_DIR, 'downloads'), eventsEnabled: true
    });
    await page.click('#btnExport');
    const dlDir = path.join(SHOT_DIR, 'downloads');
    let xlsx = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (fs.existsSync(dlDir)) {
        const f = fs.readdirSync(dlDir).filter(n => n.endsWith('.xlsx'));
        if (f.length) { xlsx = path.join(dlDir, f[0]); break; }
      }
    }
    if (!xlsx) {
      /* 兜底：通过页面上下文取回二进制 */
      const b64 = await page.evaluate(async () => {
        const res = await fetch('/api/export', { headers: { Authorization: 'Bearer ' + localStorage.getItem('club_admin_token') } });
        const buf = new Uint8Array(await res.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return btoa(s);
      });
      xlsx = path.join(SHOT_DIR, 'ui-export.xlsx');
      fs.writeFileSync(xlsx, Buffer.from(b64, 'base64'));
    }
    ok('浏览器成功下载 Excel 文件',
      !!xlsx && fs.existsSync(xlsx) && fs.statSync(xlsx).size > 3000,
      xlsx && fs.statSync(xlsx).size);
    if (xlsx) fs.copyFileSync(xlsx, path.join(__dirname, '_probe', 'ui-export.xlsx'));

    /* ================= 6b. 新增部门【宣传部】（无需作品资料） ================= */
    console.log('\n[6b] 新增部门【宣传部】—— 无需提交作品资料');
    const pubCn = 'P' + Date.now().toString().slice(-6);
    const pubSeed = await fetch(BASE + '/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cn: pubCn, qq: '246813579', age: 21, joinYears: '3年', province: '广东省', city: '广州市',
        gender: '女', height: 165, hobbies: '文案、剪辑、公众号排版', hasExperience: '无', experienceDesc: '',
        favoriteWorks: '《原神》', otherClub: '否', department: '宣传部',
        introduction: '想进宣传部做图文和视频', viewOn2D: '喜欢二次元文化', agreeRules: '是',
        referralCode: '', inviterCn: ''
      })
    });
    ok('【宣传部】申请已在无任何附件的情况下创建成功', pubSeed.status === 200, pubSeed.status);

    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 10000 });
    /* 刚用接口造的数据不在内存 LIST 里，必须点【刷新】重新拉取 */
    await page.click('#btnRefresh');
    await sleep(600);
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await page.type('#fQ', pubCn);
    await sleep(400);
    const pubRow = await page.evaluate(cn => {
      const tr = Array.from(document.querySelectorAll('#listBody tr[data-id]'))
        .find(t => t.querySelector('.cn-name') && t.querySelector('.cn-name').textContent.trim() === cn);
      if (!tr) return null;
      const cells = Array.from(tr.querySelectorAll('td'));
      const attach = cells.find(td => td.dataset.label === '附件');
      const dept = cells.find(td => td.dataset.label === '申请部门');
      return {
        dept: dept ? dept.textContent.trim() : '',
        attachText: attach ? attach.textContent.trim() : '',
        hasBadge: !!(attach && attach.querySelector('.badge-nowork'))
      };
    }, pubCn);
    ok('列表里能找到【宣传部】的申请', !!pubRow && pubRow.dept === '宣传部', pubRow);
    ok('列表「附件」列显示「无需资料」标记（不用去翻附件）',
      !!pubRow && pubRow.hasBadge && pubRow.attachText === '无需资料', pubRow);
    const badgeStyle = await page.evaluate(() => {
      const b = document.querySelector('#listBody .badge-nowork');
      if (!b) return null;
      const s = getComputedStyle(b);
      return { bg: s.backgroundColor, color: s.color };
    });
    ok('该标记为绿色轻量徽章（与红色催促、金色内推区分）',
      !!badgeStyle && /rgb\(233, 248, 239\)/.test(badgeStyle.bg) && /rgb\(21, 115, 71\)/.test(badgeStyle.color), badgeStyle);

    /* 打开详情：明确写出「本部门无需提交作品资料」 */
    await page.evaluate(cn => {
      const tr = Array.from(document.querySelectorAll('#listBody tr[data-id]'))
        .find(t => t.querySelector('.cn-name') && t.querySelector('.cn-name').textContent.trim() === cn);
      tr.click();
    }, pubCn);
    await page.waitForFunction(() => document.querySelectorAll('#detailBody .no-work-note').length === 1, { timeout: 20000 });
    const noWork = await page.$eval('#detailBody .no-work-note', el => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      isOk: el.classList.contains('notice-ok'),
      cardTitle: (el.closest('.card').querySelector('.card-title') || {}).textContent || ''
    }));
    ok('详情页显示「本部门无需提交作品资料」说明', /本部门无需提交作品资料/.test(noWork.text), noWork.text);
    ok('说明里点名申请人所选部门【宣传部】', noWork.text.includes('宣传部'), noWork.text);
    ok('说明明确「没有附件属正常情况」', /没有附件属正常情况/.test(noWork.text), noWork.text);
    ok('该说明为绿色 notice（不是警告红）', noWork.isOk === true, noWork.isOk);
    ok('详情页没有空的「作品图片」卡片', (await page.$$('#detailBody #detailGallery')).length === 0);
    await page.screenshot({ path: path.join(SHOT_DIR, '6b-detail-no-work.png') });

    /* 对照：COS部（需作品）不应出现该说明 */
    await page.evaluate(() => { location.hash = '#/list'; });
    await page.waitForFunction(() => document.querySelector('#viewList').style.display !== 'none', { timeout: 10000 });
    await page.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await page.type('#fQ', CN);
    await sleep(400);
    await page.evaluate(() => {
      const tr = Array.from(document.querySelectorAll('#listBody tr[data-id]'))[0];
      tr.click();
    });
    await page.waitForSelector('#detailBody .detail-grid', { timeout: 20000 });
    ok('需作品的部门（COS部）详情页没有「无需资料」说明',
      (await page.$$('#detailBody .no-work-note')).length === 0);
    ok('需作品的部门（COS部）详情页正常显示作品图片',
      (await page.$$('#detailBody #detailGallery img')).length === 3);

    /* ================= 7. 手机端响应式 ================= */
    console.log('\n[7] 手机端响应式适配（390x844）');

    /* 造一条「待审核」申请：已审核记录没有审核按钮，需要一条待审核的来校验按钮可点 */
    const mobileCn = 'M' + Date.now().toString().slice(-6);
    const seedRes = await fetch(BASE + '/api/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cn: mobileCn, qq: '135792468', age: 20, joinYears: '2年', province: '广东省', city: '广州市',
        gender: '女', height: 162, hobbies: '后勤、道具维护', hasExperience: '无', experienceDesc: '',
        favoriteWorks: '《原神》', otherClub: '否', department: '后勤部',
        introduction: '手机端测试用申请', viewOn2D: '喜欢二次元', agreeRules: '是',
        referralCode: '', inviterCn: ''
      })
    });
    ok('手机端校验用的待审核申请已创建', seedRes.status === 200, seedRes.status);
    const mobileCtx = await browser.createBrowserContext();
    const m = await mobileCtx.newPage();
    await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    const overflow = async (label) => {
      const r = await m.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        win: document.documentElement.clientWidth
      }));
      ok(`${label}：无横向溢出/滚动条`, r.doc <= r.win + 1 && r.body <= r.win + 1, r);
    };

    await m.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await overflow('填写端首页');
    /* 部门选择（14 个）：手机端两列、标签仍可见、不撑出屏幕 */
    const mDept = await m.evaluate(() => {
      const g = document.querySelector('#departmentGroup');
      const items = Array.from(g.querySelectorAll('label'));
      const first = items[0].getBoundingClientRect();
      const row = items.filter(i => Math.abs(i.getBoundingClientRect().top - first.top) < 2);
      const box = g.getBoundingClientRect();
      return {
        display: getComputedStyle(g).display,
        cols: row.length,
        over: items.filter(i => i.getBoundingClientRect().right > box.right + 1).length,
        tagVisible: items.every(i => {
          const t = i.querySelector('.dept-tag');
          return t && t.getBoundingClientRect().width > 0 && t.textContent.trim().length > 0;
        }),
        w: Math.round(first.width)
      };
    });
    ok('手机端部门选择为两列网格', mDept.display === 'grid' && mDept.cols === 2, mDept);
    ok('手机端 14 个部门选项都不超出卡片', mDept.over === 0, mDept);
    ok('手机端每个部门仍能看到「需作品/无需资料」标记', mDept.tagVisible === true, mDept);
    const mCards = await m.$$eval('.entry-card', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
    ok('填写端：卡片在手机上是单列（接近整屏宽）',
      mCards.length === 2 && mCards.every(w => w > 300), mCards);
    ok('填写端：输入框自适应宽度',
      (await m.$eval('#cn', el => Math.round(el.getBoundingClientRect().width))) > 280);
    ok('填写端：页脚存在',
      (await m.$eval('.site-footer', el => el.textContent.trim())).includes('示例动漫社管理'));
    await m.screenshot({ path: path.join(SHOT_DIR, '12-mobile-apply.png') });

    await m.goto(BASE + '/status', { waitUntil: 'networkidle2' });
    await overflow('查询页');
    await m.type('#cnInput', CN);
    await m.click('#queryBtn');
    await m.waitForFunction(() => document.querySelectorAll('.timeline-card').length > 0, { timeout: 10000 });
    await overflow('查询页（含时间线结果）');
    ok('查询页：时间线卡片未超出屏幕',
      await m.evaluate(() => document.querySelector('.timeline-card').getBoundingClientRect().right <= window.innerWidth + 1));
    await m.screenshot({ path: path.join(SHOT_DIR, '13-mobile-timeline.png'), fullPage: true });

    await m.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await m.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await overflow('后台登录页');
    await m.type('#username', 'admin');
    await m.type('#password', 'change-this-password');
    await m.click('#loginBtn');
    await m.waitForFunction(() => document.querySelectorAll('#listBody tr[data-id]').length > 0, { timeout: 10000 });
    await overflow('后台审核列表页');
    const stacked = await m.evaluate(() => {
      const td = document.querySelector('#listBody td');
      return { display: getComputedStyle(td).display, label: getComputedStyle(td, '::before').content };
    });
    ok('后台列表：手机上表格转为卡片式（含字段名）',
      stacked.display === 'flex' && /序号/.test(stacked.label), stacked);
    await m.screenshot({ path: path.join(SHOT_DIR, '14-mobile-admin-list.png') });

    /* ---------- 手机端：标签最多的那条也不能撑破卡片 ----------
       （需求：审核列表在手机上很多标识会超出 UI；最坏情况 = 内推 + 复审 + 催促 + 主审核官最终审核） */
    const mobTagsCn = 'MT' + Date.now().toString().slice(-6);
    await m.evaluate(async (cn) => {
      const token = localStorage.getItem('club_admin_token');
      const base = {
        cn, qq: '135724689', age: 21, joinYears: '3年', province: '广东省', city: '广州市',
        gender: '男', height: 175, hobbies: '手机端标签', hasExperience: '无', experienceDesc: '',
        favoriteWorks: '《测试》', otherClub: '否', otherClubName: '',
        department: '后勤部', introduction: '手机端标签', viewOn2D: '喜欢', agreeRules: '是',
        referralCode: 'MT8888', inviterCn: ''
      };
      const post = (p, body, tk) => fetch(p, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, tk ? { Authorization: 'Bearer ' + tk } : {}),
        body: JSON.stringify(body)
      }).then(r => r.json());
      const sub = await post('/api/applications', base);
      await post('/api/applications/' + sub.id + '/review', { action: 'reject', reason: '不符合入社部门要求' }, token);
      await post('/api/applications/' + sub.id + '/resubmit', base);
      await post('/api/applications/' + sub.id + '/urge', { cn });
      await post('/api/applications/' + sub.id + '/intervene', {}, token);
      await post('/api/applications/' + sub.id + '/review', { action: 'reject', reason: '拥有其他社会性质社团' }, token);
    }, mobTagsCn);
    await m.evaluate(() => { const b = document.querySelector('#btnRefresh'); if (b) b.click(); });
    await sleep(1200);
    await m.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await m.type('#fQ', mobTagsCn);
    await sleep(400);
    const tagCard = await m.evaluate(() => {
      const tr = document.querySelector('#listBody tr[data-id]');
      if (!tr) return { found: false };
      const cell = tr.querySelector('td[data-label="CN代称"]');
      const name = cell.querySelector('.cn-name');
      const card = tr.getBoundingClientRect();
      const badges = Array.from(cell.querySelectorAll('.badge')).map(b => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent.trim(), over: Math.round(r.right - card.right), width: Math.round(r.width) };
      });
      return {
        found: true,
        cellOverflow: cell.scrollWidth - cell.clientWidth,
        nameHeight: Math.round(name.getBoundingClientRect().height),
        nameLines: new Set(Array.from(name.getClientRects()).map(r => Math.round(r.top))).size,
        tagLineCount: new Set(Array.from(cell.querySelectorAll('.badge')).map(b => Math.round(b.getBoundingClientRect().top))).size,
        badges,
        maxBadgeOver: badges.length ? Math.max.apply(null, badges.map(b => b.over)) : 0,
        cardWidth: Math.round(card.width)
      };
    });
    ok('手机端：4 个标签的申请卡片能正常渲染', tagCard.found === true, tagCard);
    ok('手机端：CN 单元格内容不溢出（scrollWidth ≤ clientWidth）', tagCard.cellOverflow <= 1, tagCard);
    ok('手机端：没有任何标签超出卡片右边界', tagCard.maxBadgeOver <= 1, tagCard.badges);
    ok('手机端：CN 名字不被压成竖排（单行）', tagCard.nameLines === 1 && tagCard.nameHeight <= 30, tagCard);
    ok('手机端：标签自动换行显示（每个标签宽度都不超过卡片）',
      tagCard.tagLineCount >= 1 && tagCard.badges.every(b => b.width <= tagCard.cardWidth), tagCard);
    await overflow('后台列表（标签最多的卡片）');
    await m.screenshot({ path: path.join(SHOT_DIR, '14b-mobile-list-tags.png'), fullPage: true });
    await m.evaluate(() => { const q = document.querySelector('#fQ'); q.value = ''; q.dispatchEvent(new Event('input')); });
    await sleep(300);

    /* 定位到刚造的待审核申请，确保详情页有审核按钮 */
    await m.type('#fQ', mobileCn);
    await sleep(400);
    await m.click('#listBody tr[data-id]');
    await m.waitForFunction(() => document.querySelector('#viewDetail').style.display !== 'none' &&
      !document.querySelector('#detailBody').textContent.includes('加载中'), { timeout: 10000 });
    await overflow('后台申请详情页');
    ok('后台详情：操作按钮在手机上够大（可点）',
      (await m.evaluate(() => Math.round(document.querySelector('#detailBody .action-bar .btn').getBoundingClientRect().height))) >= 40);

    /* ---------- 手机端：审核通过 / 审核不通过 并排一行 ---------- */
    const mobBar = await m.evaluate(() => {
      const q = s => document.querySelector(s);
      const r = el => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
      const pair = q('#detailBody .ab-pair');
      const pairStyle = pair ? getComputedStyle(pair) : null;
      const bar = q('#detailBody .action-bar-inner');
      return {
        pairDisplay: pairStyle ? pairStyle.display : '',
        pairDir: pairStyle ? pairStyle.flexDirection : '',
        approve: r(q('#btnApprove')),
        reject: r(q('#btnReject')),
        ret: r(q('#btnReturn')),
        esc: r(q('#btnEscalate')),
        ivn: r(q('#btnIntervene')),
        barWidth: Math.round(bar.getBoundingClientRect().width),
        viewport: window.innerWidth
      };
    });
    ok('手机端 .ab-pair 变成 flex 行（PC 端是 contents）', mobBar.pairDisplay === 'flex', mobBar.pairDisplay);
    ok('手机端【审核通过】在左、【审核不通过】在右',
      mobBar.approve.l < mobBar.reject.l, { approve: mobBar.approve.l, reject: mobBar.reject.l });
    ok('手机端两个按钮在同一行（top 相同、高度一致）',
      Math.abs(mobBar.approve.t - mobBar.reject.t) <= 2 && Math.abs(mobBar.approve.h - mobBar.reject.h) <= 2,
      { a: mobBar.approve, r: mobBar.reject });
    ok('手机端两个按钮各占约一半宽度（没有各占一整行）',
      mobBar.approve.w < mobBar.barWidth * 0.62 && mobBar.reject.w < mobBar.barWidth * 0.62 &&
      Math.abs(mobBar.approve.w - mobBar.reject.w) <= 4,
      { approveW: mobBar.approve.w, rejectW: mobBar.reject.w, barW: mobBar.barWidth });
    ok('手机端【退回】仍单独占一行（宽度铺满）', mobBar.ret.w > mobBar.barWidth * 0.9 || mobBar.ret.w >= mobBar.approve.w * 1.8,
      { ret: mobBar.ret.w, approve: mobBar.approve.w, bar: mobBar.barWidth });
    ok('手机端按钮没有超出屏幕（无横向溢出）',
      mobBar.approve.l + mobBar.approve.w <= mobBar.viewport + 1 && mobBar.reject.l + mobBar.reject.w <= mobBar.viewport + 1,
      { viewport: mobBar.viewport, approveRight: mobBar.approve.l + mobBar.approve.w, rejectRight: mobBar.reject.l + mobBar.reject.w });
    ok('手机端按钮没有挤压变形（高度仍 ≥40）',
      mobBar.approve.h >= 40 && mobBar.reject.h >= 40, { a: mobBar.approve.h, r: mobBar.reject.h });
    await m.screenshot({ path: path.join(SHOT_DIR, '15b-mobile-action-buttons.png') });
    await m.screenshot({ path: path.join(SHOT_DIR, '15-mobile-admin-detail.png'), fullPage: true });

    await m.evaluate(() => { location.hash = '#/admins'; });
    await m.waitForFunction(() => document.querySelector('#viewAdmins').style.display !== 'none', { timeout: 8000 });
    await sleep(500);
    await overflow('后台账号管理页');
    await m.screenshot({ path: path.join(SHOT_DIR, '16-mobile-admin-admins.png') });

    /* 系统设置页也要适配手机（超管可见） */
    await m.evaluate(() => { location.hash = '#/system'; });
    await m.waitForFunction(() => document.querySelector('#viewSystem').style.display !== 'none', { timeout: 8000 });
    await m.waitForFunction(() => (document.querySelector('#sysInfo').textContent || '').includes('服务器主机名'),
      { timeout: 10000 });
    await overflow('后台系统设置页');
    ok('后台系统设置页：手机上重启按钮够大（可点）',
      (await m.evaluate(() => Math.round(document.querySelector('#btnReboot').getBoundingClientRect().height))) >= 40);
    await m.screenshot({ path: path.join(SHOT_DIR, '17-mobile-admin-system.png'), fullPage: true });
    await m.close();
    await mobileCtx.close();

    /* ================= 8. 审核设置（启动 / 暂停 / 终止） ================= */
    console.log('\n[8] 审核设置（启动 / 暂停 / 终止）');
    const cnDateTime = async (pg, addDays) => pg.evaluate(d => {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      }).formatToParts(new Date(Date.now() + d * 86400000)).reduce((o, x) => (o[x.type] = x.value, o), {});
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    }, addDays);

    await front();
    await page.evaluate(() => { location.hash = '#/rstate'; });
    await page.waitForFunction(() => document.querySelector('#viewReviewState').style.display !== 'none', { timeout: 8000 });
    await page.waitForFunction(() => (document.querySelector('#rstateLabel').textContent || '').trim().length > 0, { timeout: 8000 });
    const navR = await page.$$eval('.admin-nav button', els => els.map(e => e.textContent.trim()));
    ok('后台导航出现【审核设置】菜单', navR.includes('审核设置'), navR);
    ok('【审核设置】紧跟在【系统设置】之后',
      navR.indexOf('审核设置') === navR.indexOf('系统设置') + 1, navR);
    const st0 = await page.evaluate(() => ({
      label: document.querySelector('#rstateLabel').textContent.trim(),
      buttons: Array.from(document.querySelectorAll('.rstate-btn')).map(b => b.textContent.trim()),
      active: Array.from(document.querySelectorAll('.rstate-btn')).filter(b => b.classList.contains('active')).map(b => b.dataset.state)
    }));
    ok('三个按钮为 启动审核系统 / 暂停审核系统 / 终止审核系统',
      st0.buttons.join(',') === '▶ 启动审核系统,⏸ 暂停审核系统,⛔ 终止审核系统', st0.buttons);
    ok('系统默认状态为「审核系统运行中」', st0.label === '审核系统运行中', st0.label);
    ok('默认高亮【启动审核系统】（三按钮互斥单选）', st0.active.join(',') === 'running', st0.active);
    await page.screenshot({ path: path.join(SHOT_DIR, '18-rstate-running.png'), fullPage: true });

    /* ---------- ② 暂停：必填 暂停原因 + 预计恢复时间 ---------- */
    await page.evaluate(() => document.querySelector('#btnStatePause').click());
    await page.waitForFunction(() => document.querySelector('#pauseSysModal').classList.contains('show'), { timeout: 5000 });
    ok('点【暂停审核系统】弹出输入框弹窗', true);
    await page.evaluate(() => document.querySelector('#pauseSysConfirm').click());
    await sleep(300);
    ok('暂停原因为空 → 提示「请填写暂停原因」',
      (await page.$eval('#pauseSysErr', el => el.textContent.trim())) === '请填写暂停原因');
    await page.type('#pauseReason', '期末周暂停审核，考试结束后恢复');
    await page.evaluate(() => { document.querySelector('#pauseUntil').value = ''; });
    await page.evaluate(() => document.querySelector('#pauseSysConfirm').click());
    await sleep(300);
    ok('预计恢复时间为空 → 提示「请填写预计恢复时间」',
      (await page.$eval('#pauseSysErr', el => el.textContent.trim())) === '请填写预计恢复时间');

    const pauseAt = await cnDateTime(page, 3);
    await page.evaluate(v => {
      const i = document.querySelector('#pauseUntil');
      i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
    }, pauseAt);
    await page.screenshot({ path: path.join(SHOT_DIR, '18b-pause-modal.png') });
    await page.evaluate(() => document.querySelector('#pauseSysConfirm').click());
    await page.waitForFunction(() => document.querySelector('#rstateLabel').textContent.includes('已暂停'), { timeout: 12000 });
    ok('保存后【当前系统状态】变为「审核系统已暂停」', true);
    const stP = await page.evaluate(() => ({
      active: Array.from(document.querySelectorAll('.rstate-btn')).filter(b => b.classList.contains('active')).map(b => b.dataset.state),
      meta: document.querySelector('#rstateMeta').textContent,
      hist: document.querySelector('#rstateHistoryBody').textContent
    }));
    ok('暂停按钮高亮、启动按钮取消高亮（互斥）', stP.active.join(',') === 'paused', stP.active);
    ok('页面展示暂停原因 / 预计恢复时间',
      stP.meta.includes('期末周暂停审核') && stP.meta.includes('预计恢复'), stP.meta);
    ok('状态变更记录里有「运行中 → 已暂停」',
      stP.hist.includes('审核系统运行中') && stP.hist.includes('审核系统已暂停'), stP.hist.slice(0, 160));
    await page.screenshot({ path: path.join(SHOT_DIR, '18c-rstate-paused.png'), fullPage: true });

    /* ---------- 申请人页面：暂停时的警戒线 + 自动弹窗 ---------- */
    const applyCtx = await browser.createBrowserContext();
    const pA = await applyCtx.newPage();
    await pA.setViewport({ width: 1280, height: 900 });
    await pA.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await pA.waitForFunction(() => document.querySelector('#sysAlert').style.display !== 'none', { timeout: 12000 });
    ok('填表页顶部出现警戒线横幅', true);
    const alertP = await pA.evaluate(() => ({
      status: document.querySelector('#sysAlert').dataset.status,
      title: document.querySelector('#sysAlertTitle').textContent.trim(),
      bodyClass: document.body.className,
      bg: getComputedStyle(document.querySelector('#sysAlert')).backgroundColor
    }));
    ok('横幅为「审核系统已暂停」的琥珀色警戒样式',
      alertP.status === 'paused' && alertP.title === '审核系统已暂停', alertP);
    ok('整页带警戒线风格（body.sys-paused）', alertP.bodyClass.includes('sys-paused'), alertP.bodyClass);
    await pA.waitForFunction(() => document.querySelector('#sysStateModal').classList.contains('show'), { timeout: 10000 });
    const pauseModal = await pA.evaluate(() => ({
      shown: document.querySelector('#sysStateModal').classList.contains('show'),
      pausedAt: document.querySelector('#sysPausedAt').textContent.trim(),
      reason: document.querySelector('#sysPauseReason').textContent.trim(),
      until: document.querySelector('#sysPauseUntil').textContent.trim(),
      hasStopBox: document.querySelector('#sysStopBox').style.display !== 'none',
      okBtn: document.querySelector('#sysStateOk').textContent.trim()
    }));
    ok('进入填表页自动弹出暂停提示弹窗', pauseModal.shown === true);
    ok('弹窗依次展示 暂停时间 / 暂停原因 / 预计恢复时间',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(pauseModal.pausedAt) &&
      pauseModal.reason === '期末周暂停审核，考试结束后恢复' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(pauseModal.until), pauseModal);
    ok('弹窗底部为【我知道了】', pauseModal.okBtn === '我知道了', pauseModal.okBtn);
    ok('暂停时不再展示终止公告块', pauseModal.hasStopBox === false);
    await pA.screenshot({ path: path.join(SHOT_DIR, '18d-apply-paused.png'), fullPage: true });
    await pA.evaluate(() => document.querySelector('#sysStateOk').click());
    await sleep(300);
    ok('关闭弹窗后横幅仍在（状态持续可见）',
      (await pA.$eval('#sysAlert', el => el.style.display)) !== 'none');
    ok('暂停状态下申请表仍可提交（提交按钮可用）',
      (await pA.$eval('#submitBtn', el => el.disabled)) === false);

    /* ---------- ③ 终止：必填通告文本（无预计恢复时间输入框） ---------- */
    await front();
    await page.evaluate(() => document.querySelector('#btnStateStop').click());
    await page.waitForFunction(() => document.querySelector('#stopSysModal').classList.contains('show'), { timeout: 5000 });
    const stopModalFields = await page.evaluate(() => ({
      hasNotice: !!document.querySelector('#stopNotice'),
      hasUntil: !!document.querySelector('#stopUntil'),
      hasPauseUntil: !!document.querySelector('#pauseUntil')
    }));
    ok('终止弹窗只有通告输入框、没有预计恢复时间输入项',
      stopModalFields.hasNotice === true && stopModalFields.hasUntil === false, stopModalFields);
    await page.evaluate(() => document.querySelector('#stopSysConfirm').click());
    await sleep(300);
    ok('通告为空 → 提示「请填写通告文本」',
      (await page.$eval('#stopSysErr', el => el.textContent.trim())) === '请填写通告文本');
    await page.type('#stopNotice', '本轮招新已结束，下一次招新请留意群公告。');
    await page.screenshot({ path: path.join(SHOT_DIR, '18e-stop-modal.png') });
    await page.evaluate(() => document.querySelector('#stopSysConfirm').click());
    await page.waitForFunction(() => document.querySelector('#rstateLabel').textContent.includes('已终止'), { timeout: 12000 });
    ok('保存后状态变为「审核系统已终止（停止新人入社申请）」', true);
    ok('终止按钮高亮（互斥）',
      (await page.$$eval('.rstate-btn', els => els.filter(e => e.classList.contains('active')).map(e => e.dataset.state))).join(',') === 'stopped');
    await page.screenshot({ path: path.join(SHOT_DIR, '18f-rstate-stopped.png'), fullPage: true });

    /* 申请人页面：终止后的公告弹窗 + 停止提交 */
    await pA.reload({ waitUntil: 'networkidle2' });
    await pA.waitForFunction(() => document.querySelector('#sysAlert').style.display !== 'none', { timeout: 12000 });
    const alertS = await pA.evaluate(() => ({
      status: document.querySelector('#sysAlert').dataset.status,
      title: document.querySelector('#sysAlertTitle').textContent.trim(),
      bodyClass: document.body.className
    }));
    ok('横幅切换为红色警戒（终止）',
      alertS.status === 'stopped' && alertS.title.includes('暂时停止新人入社申请'), alertS);
    ok('整页带警戒线风格（body.sys-stopped）', alertS.bodyClass.includes('sys-stopped'), alertS.bodyClass);
    await pA.waitForFunction(() => document.querySelector('#sysStateModal').classList.contains('show'), { timeout: 10000 });
    const stopModal = await pA.evaluate(() => ({
      title: document.querySelector('#sysStopTitle').textContent.trim(),
      notice: document.querySelector('#sysStopNotice').textContent.trim(),
      head: document.querySelector('#sysStateHead').textContent.trim(),
      hasPauseBox: document.querySelector('#sysPauseBox').style.display !== 'none'
    }));
    ok('弹窗标题为「示例动漫社团暂时停止新人入社申请」',
      stopModal.title === '示例动漫社团暂时停止新人入社申请' && stopModal.head === '示例动漫社团暂时停止新人入社申请',
      stopModal);
    ok('弹窗内容为管理员填写的通告',
      stopModal.notice === '本轮招新已结束，下一次招新请留意群公告。', stopModal.notice);
    ok('终止弹窗不再展示暂停信息块', stopModal.hasPauseBox === false);
    await pA.screenshot({ path: path.join(SHOT_DIR, '18g-apply-stopped.png'), fullPage: true });
    await pA.evaluate(() => document.querySelector('#sysStateOk').click());
    await sleep(300);
    ok('终止时提交按钮不可用（停止新人入社申请）',
      (await pA.$eval('#submitBtn', el => el.disabled)) === true);
    ok('提交按钮文案说明已停止招新',
      (await pA.$eval('#submitBtn', el => el.textContent.trim())) === '已停止招新，暂不可提交',
      await pA.$eval('#submitBtn', el => el.textContent.trim()));
    ok('页面提示社团暂时停止新人入社申请',
      (await pA.$eval('#topNotice', el => el.textContent)).includes('停止新人入社申请'));

    /* 后端同样拦截提交（即使有人绕过前端直接调接口） */
    const blockedSub = await page.evaluate(async () => {
      const r = await fetch('/api/applications', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cn: '终止期测试', qq: '135790246', age: 20, joinYears: '1年', province: '广东省', city: '广州市',
          gender: '男', height: 170, hobbies: 'x', hasExperience: '无', experienceDesc: '',
          favoriteWorks: 'x', otherClub: '否', otherClubName: '', department: '后勤部',
          introduction: 'x', viewOn2D: 'x', agreeRules: '是', referralCode: '', inviterCn: ''
        })
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    });
    ok('终止状态下后端拒绝提交申请 → 403', blockedSub.status === 403, blockedSub);
    ok('403 返回停止招新的通告文案',
      String(blockedSub.data.error || '').includes('招新已结束'), blockedSub.data);

    /* ---------- ① 启动：恢复运行 ---------- */
    await front();
    await page.evaluate(() => document.querySelector('#btnStateStart').click());
    await page.waitForFunction(() => document.querySelector('#rstateLabel').textContent.includes('运行中'), { timeout: 12000 });
    ok('点【启动审核系统】立即恢复为运行中', true);
    ok('启动按钮重新高亮（互斥）',
      (await page.$$eval('.rstate-btn', els => els.filter(e => e.classList.contains('active')).map(e => e.dataset.state))).join(',') === 'running');
    const histAll = await page.$eval('#rstateHistoryBody', el => el.textContent);
    ok('三条操作记录都在（启动 / 暂停 / 终止）',
      histAll.includes('审核系统已暂停') && histAll.includes('审核系统已终止') && histAll.includes('审核系统运行中'));

    await pA.reload({ waitUntil: 'networkidle2' });
    await sleep(600);
    const alertOff = await pA.evaluate(() => ({
      display: document.querySelector('#sysAlert').style.display,
      bodyClass: document.body.className,
      modalShown: document.querySelector('#sysStateModal').classList.contains('show'),
      submitDisabled: document.querySelector('#submitBtn').disabled
    }));
    ok('恢复运行后填表页不再显示警戒线', alertOff.display === 'none', alertOff);
    ok('恢复运行后 body 上的警戒样式移除',
      !alertOff.bodyClass.includes('sys-paused') && !alertOff.bodyClass.includes('sys-stopped'), alertOff.bodyClass);
    ok('恢复运行后不再弹出状态弹窗、提交按钮恢复可用',
      alertOff.modalShown === false && alertOff.submitDisabled === false, alertOff);
    await applyCtx.close();

    /* ---------- 权限隔离：没有【系统开启权限】的账号 ---------- */
    const rsName = 'rs_' + Date.now().toString().slice(-5);
    await page.evaluate(async (name) => {
      const token = localStorage.getItem('club_admin_token');
      await fetch('/api/admins', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ username: name, password: 'review123' })
      });
    }, rsName);
    const rsCtx = await browser.createBrowserContext();
    const pRs = await rsCtx.newPage();
    await pRs.goto(BASE + '/admin', { waitUntil: 'networkidle2' });
    await pRs.waitForSelector('#viewLogin', { visible: true, timeout: 10000 });
    await pRs.type('#username', rsName);
    await pRs.type('#password', 'review123');
    await pRs.click('#loginBtn');
    await pRs.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    ok('新建子账号默认没有【系统开启权限】',
      (await pRs.evaluate(() => (JSON.parse(localStorage.getItem('club_admin_info') || '{}').perms || {}).openSystem)) !== true);
    ok('无权限的账号看不到【审核设置】菜单',
      (await pRs.$eval('#navReviewState', el => el.style.display !== 'none')) === false);
    await pRs.evaluate(() => { location.hash = '#/rstate'; });
    await sleep(400);
    ok('直接改地址也无法进入审核设置页（自动退回列表）',
      (await pRs.$eval('#viewReviewState', el => el.style.display)) === 'none');
    const rsForbidden = await pRs.evaluate(async () => {
      const r = await fetch('/api/review-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('club_admin_token') },
        body: JSON.stringify({ action: 'stop', notice: '越权测试' })
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    });
    ok('无权限账号调用开关接口 → 403', rsForbidden.status === 403, rsForbidden);
    ok('403 文案说明缺少【系统开启权限】',
      /系统开启权限/.test(String(rsForbidden.data.error || '')), rsForbidden.data);
    /* 授予权限后可见 */
    await front();
    await page.evaluate(() => { location.hash = '#/admins'; });
    await page.waitForFunction(() => document.querySelector('#viewAdmins').style.display !== 'none', { timeout: 8000 });
    await page.evaluate(async (name) => {
      const token = localStorage.getItem('club_admin_token');
      const list = await (await fetch('/api/admins', { headers: { Authorization: 'Bearer ' + token } })).json();
      const rec = (list.admins || []).find(a => a.username === name);
      if (!rec) return;
      await fetch('/api/admins/' + rec.id + '/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ perms: Object.assign({}, rec.perms, { openSystem: true }), enabled: false })
      });
    }, rsName);
    await pRs.reload({ waitUntil: 'networkidle2' });
    await pRs.waitForFunction(() => document.querySelector('#viewApp').style.display !== 'none', { timeout: 10000 });
    ok('被授予【系统开启权限】后能看到【审核设置】菜单',
      (await pRs.$eval('#navReviewState', el => el.style.display !== 'none')) === true);
    /* 清理 */
    await pRs.close();
    await rsCtx.close();
    await page.evaluate(async (name) => {
      const token = localStorage.getItem('club_admin_token');
      const list = await (await fetch('/api/admins', { headers: { Authorization: 'Bearer ' + token } })).json();
      const rec = (list.admins || []).find(a => a.username === name);
      if (rec) await fetch('/api/admins/' + rec.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    }, rsName);
    ok('（清理）删除权限测试子账号并确认系统已恢复运行', true);
    const finalState = await page.evaluate(async () => (await (await fetch('/api/review-state')).json()).review.status);
    ok('测试结束时系统状态已恢复为 running（不影响其它用例）', finalState === 'running', finalState);

    /* ================= 9. 控制台错误 ================= */
    console.log('\n[9] 控制台错误检查');
    ok('页面无 JS 运行错误（异常/未捕获错误）', errors.length === 0, errors.slice(0, 5));
    console.log(`     （已忽略 ${ignoredResource.length} 条预期内的 HTTP 401 资源提示：错误密码登录测试）`);
  } catch (e) {
    fail++;
    failures.push('测试异常: ' + e.message);
    console.log('  ❌ 测试异常：' + e.message);
    try { await page.screenshot({ path: path.join(SHOT_DIR, 'error.png') }); } catch (x) { }
  } finally {
    await browser.close();
  }

  console.log('\n==================================================');
  console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log(' 失败明细：');
    failures.forEach(f => console.log('   - ' + f));
  }
  console.log(' 截图目录：' + SHOT_DIR);
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})();
