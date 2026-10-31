'use strict';

/* =========================================================================
 * Excel 导出（ExcelJS）
 *  - 全部表单字段 + 审核状态/审核时间/审核人/推荐部门/拒绝理由
 *  - 作品图片按「作品图片1~6」独立单元格内嵌（OOXML 绘图对象），
 *    打开 Excel 即可直接预览，无需另附图片压缩包
 *  - 导出前自动压缩为缩略图并缓存，避免工作簿体积失控
 * ========================================================================= */
const path = require('path');
const ExcelJS = require('exceljs');
const { getThumbsMany } = require('./thumbs');
const { STATUS, STATUS_LABEL_ADMIN, WORK_RULES } = require('./config');

const IMAGE_SLOTS = 6;
const IMG_PX = 104;              // 单元格内图片显示尺寸
const ROW_HEIGHT_PT = 84;        // 行高（磅），约 112px，容纳图片

const HEAD_FILL = 'FF6C5CE7';
const STATUS_FILL = {
  [STATUS.SUBMITTED]: 'FFEDEDED',   // 灰
  [STATUS.VIEWING]: 'FFFFF3C4',     // 黄
  [STATUS.APPROVED]: 'FFD6F5DD',    // 绿
  [STATUS.REJECTED]: 'FFFBD9D9',    // 红
  [STATUS.RETURNED]: 'FFFFE6C7',    // 橙（审核员退回）
  [STATUS.RESUBMITTED]: 'FFDCE7FF', // 蓝（已提交复审申请）
  [STATUS.ESCALATED]: 'FFE9DDFF'    // 紫（已移交主审核官）
};

function buildColumns() {
  const cols = [
    { h: '序号', w: 6 },
    { h: 'CN代称', w: 16 },
    { h: 'QQ号', w: 14 },
    { h: '真实年龄(岁)', w: 11 },
    { h: '入圈年龄', w: 12 },
    { h: '所在地', w: 16 },
    { h: '性别', w: 15 },
    { h: '身高(厘米)', w: 10 },
    { h: '日常兴趣或特长', w: 28 },
    { h: '是否有相关经验', w: 12 },
    { h: '相关经验简述', w: 30 },
    { h: '喜欢/保有兴趣的二次元动漫·人物·游戏', w: 32 },
    { h: '是否参加其他社会性质动漫社团', w: 15 },
    { h: '其他社团名称', w: 18 },
    { h: '申请部门', w: 20 }
  ];
  for (let i = 1; i <= IMAGE_SLOTS; i++) cols.push({ h: `作品图片${i}`, w: 16, image: true });
  cols.push(
    { h: '配音/录音文件', w: 22 },
    { h: '自我介绍', w: 34 },
    { h: '对二次元的看法', w: 34 },
    { h: '能否遵守并理解管理规章制度', w: 15 },
    { h: '内推码', w: 12 },
    { h: '邀请人CN', w: 14 },
    { h: '提交时间', w: 20 },
    { h: '审核状态', w: 13 },
    { h: '审核时间', w: 20 },
    { h: '审核人', w: 14 },
    { h: '推荐部门', w: 20 },
    { h: '拒绝理由', w: 26 },
    { h: '复审标记', w: 11 },
    { h: '退回原因', w: 26 },
    { h: '催促次数', w: 11, urge: true }
  );
  return cols;
}

const COLUMNS = buildColumns();
const STATUS_COL = COLUMNS.findIndex(c => c.h === '审核状态');
/* 图片起始列改为按列定义自动推导，避免以后增删列时锚点错位 */
const IMAGE_COL_START = COLUMNS.findIndex(c => c.image);

function locality(a) {
  if (a.province === a.city) return a.province || a.city || '';
  return [a.province, a.city].filter(Boolean).join(' / ');
}

function fileBase(url) {
  return url ? path.basename(String(url)) : '';
}

/** 组装某一行的纯文本单元格值（图片列留空，稍后内嵌） */
function rowValues(a) {
  const dept = a.department || '';
  const rule = WORK_RULES[dept];
  const vals = [
    a.seq, a.cn, a.qq || '', a.age, a.joinYears, locality(a), a.gender, a.height,
    a.hobbies,
    a.hasExperience, a.experienceDesc || '',
    a.favoriteWorks,
    a.otherClub, a.otherClubName || '',
    dept
  ];
  for (let i = 0; i < IMAGE_SLOTS; i++) vals.push('');
  vals.push(
    (rule && rule.kind === 'audio' && a.workAudio) ? fileBase(a.workAudio) : '',
    a.introduction, a.viewOn2D, a.agreeRules,
    a.referralCode || '', a.inviterCn || '',
    a.createdAtText || '',
    STATUS_LABEL_ADMIN[a.status] || a.status || '',
    a.reviewedAtText || '',
    a.reviewedBy || '',
    a.recommendedDepartment || '',
    a.rejectReason || '',
    a.resubmitUsed ? '复审申请表' : '',
    a.returnReason || '',
    (a.urgeCount || 0) > 0 ? `${a.urgeCount} 次${a.lastUrgeAtText ? '（' + a.lastUrgeAtText + '）' : ''}` : ''
  );
  return vals;
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.height = 26;
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: '微软雅黑' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
    };
  });
}

function styleBody(ws, row, isImageRow) {
  row.height = isImageRow ? ROW_HEIGHT_PT : 20;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cell.font = { size: 10, name: '微软雅黑' };
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = {
      top: { style: 'hair', color: { argb: 'FFDDDDDD' } },
      left: { style: 'hair', color: { argb: 'FFDDDDDD' } },
      bottom: { style: 'hair', color: { argb: 'FFDDDDDD' } },
      right: { style: 'hair', color: { argb: 'FFDDDDDD' } }
    };
    if (colNumber === STATUS_COL + 1) {
      const app = ws.__apps[row.number - 2];
      const fill = app ? STATUS_FILL[app.status] : null;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.font = { size: 10, bold: true, name: '微软雅黑' };
    }
    if (colNumber === 1 || colNumber === 3 || colNumber === 7) {
      cell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
    }
  });
}

/**
 * 生成工作簿
 * @param {Array} apps 申请记录
 * @returns {Promise<Buffer>}
 */
async function buildExportBuffer(apps) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '示例动漫社 · 入社申请审核系统';
  wb.created = new Date();

  const ws = wb.addWorksheet('入社申请汇总', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });
  ws.__apps = apps;

  ws.columns = COLUMNS.map(c => ({ width: c.w }));
  ws.addRow(COLUMNS.map(c => c.h));
  styleHeader(ws);

  apps.forEach(a => {
    const row = ws.addRow(rowValues(a));
    styleBody(ws, row, true);
  });

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMNS.length }
  };

  /* ---------- 内嵌作品图片 ---------- */
  const wanted = [];
  apps.forEach(a => (a.workImages || []).forEach(u => wanted.push(fileBase(u))));
  const thumbs = await getThumbsMany(wanted, 4);

  let embedded = 0, skipped = 0;
  apps.forEach((a, rowIdx) => {
    (a.workImages || []).slice(0, IMAGE_SLOTS).forEach((url, i) => {
      const name = fileBase(url);
      const buf = thumbs.get(name);
      if (!buf) { skipped++; return; }
      const imageId = wb.addImage({ buffer: buf, extension: 'jpeg' });
      const col = IMAGE_COL_START + i;          // 0 基
      const row = rowIdx + 1;                   // 0 基（第 1 行为表头）
      ws.addImage(imageId, {
        tl: { col: col + 0.06, row: row + 0.06 },
        ext: { width: IMG_PX, height: IMG_PX },
        editAs: 'oneCell'
      });
      embedded++;
    });
  });

  /* ---------- 无图/缺失说明 ---------- */
  const note = wb.addWorksheet('导出说明');
  note.columns = [{ width: 100 }];
  note.addRow(['示例动漫社 · 入社申请导出说明']).font = { bold: true, size: 14 };
  note.addRow(['']);
  note.addRow([`导出时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`]);
  note.addRow([`申请记录：${apps.length} 条`]);
  note.addRow([`已内嵌作品图片：${embedded} 张${skipped ? `（${skipped} 张原图缺失，未能内嵌）` : ''}`]);
  note.addRow(['']);
  note.addRow(['· 作品图片已直接嵌入「入社申请汇总」工作表对应的“作品图片1~6”单元格，点击即可放大查看，无需另外下载图片压缩包。']);
  note.addRow(['· 图片已按比例压缩以保证文件体积，原始高清图仍保存在服务器 data/uploads 目录。']);
  note.addRow(['· 配音/录音文件（CV部）为音频，Excel 无法内嵌，已在“配音/录音文件”列标注文件名，原件保存在服务器 data/uploads 目录。']);
  note.addRow(['· 审核状态说明：待审核（灰）= 已提交待查看；审核员查看中（黄）；审核通过（绿）；审核不通过（红）。']);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildExportBuffer, COLUMNS };
