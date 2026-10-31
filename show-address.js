'use strict';

/* 显示本系统所有可访问地址（本机 / 局域网） */

const os = require('os');
const PORT = Number(process.env.PORT || 3000);
const line = '='.repeat(66);

const lan = [];
const nets = os.networkInterfaces();
for (const name of Object.keys(nets)) {
  for (const info of nets[name] || []) {
    if (info.family === 'IPv4' && !info.internal) lan.push({ name, address: info.address });
  }
}

console.log(line);
console.log('  本机（自己）访问：');
console.log('    用户填写端   : http://localhost:' + PORT + '/');
console.log('    审核状态查询 : http://localhost:' + PORT + '/status');
console.log('    审核管理后台 : http://localhost:' + PORT + '/admin');
if (lan.length) {
  console.log('');
  console.log('  同一 WiFi / 局域网的同学访问（把链接复制发群里即可）：');
  for (const i of lan) {
    console.log('    [' + i.name + ']  http://' + i.address + ':' + PORT + '/');
  }
  console.log('');
  console.log('    审核状态查询 : http://' + lan[0].address + ':' + PORT + '/status');
  console.log('    审核管理后台 : http://' + lan[0].address + ':' + PORT + '/admin');
} else {
  console.log('');
  console.log('  未检测到局域网地址：请确认电脑已连接 WiFi 或网线');
}
console.log('');
console.log('  提示：同学打不开时，右键“开放局域网访问.bat” → 以管理员身份运行');
console.log(line);
