#!/usr/bin/env node
/**
 * 织锦排程台 · 回归检查
 * 运行：node test.js   （或 npm test）
 *
 * 从 index.html 提取数据层逻辑，在 localStorage 桩上驱动真实状态机。
 * 每个分组独立清空存储，互不污染；断言失败会标注所属流程分组。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('未能在 index.html 中找到 <script> 数据层'); process.exit(1); }
const js = m[1];

/* localStorage 桩：store 对象即“浏览器存储”，可整体清空（全新状态）或重读（模拟刷新） */
let store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

const API_EXPR = `({
  addPlan, deletePlan, genProcesses,
  addYarn, restockYarn, adjustYarn, deleteYarn,
  checkSchedule, scheduleProcess, cancelSchedule, completeSchedule,
  resetAll, persist, loadState,
  yarnById, procById, planById, available, __getState
})`;
function boot() { return eval(js + '\n' + API_EXPR); }  // 读当前 store，等价于打开/刷新页面
function freshBoot() { store = {}; return boot(); }       // 清空存储后的全新工作台

/* 断言框架 */
let total = 0, failures = 0, groupName = '';
function group(name, fn) { groupName = name; console.log('\n■ ' + name); fn(); }
function ok(name, cond, extra) {
  total++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ [' + groupName + '] ' + name + (extra ? '\n      实际: ' + extra : '')); }
}
const lastSch = (app, procId) => app.__getState().schedules.filter(s => s.processId === procId).pop();
const procOf = (app, planId, name) => app.__getState().processes.find(p => p.planId === planId && p.name === name);
const mkPlan = (app, name, warpUse, weftUse, qty) => {
  const r = app.addPlan({ name, warpEnds: 960, weftDensity: 28, widthCm: 68, lengthM: 2.4, qty: qty || 1, warpUse, weftUse });
  if (!r.ok) throw new Error('建方案失败: ' + r.msg);
  app.genProcesses(r.plan.id);
  return r.plan;
};

/* ================= 1. 方案建立与工序拆分 ================= */
group('方案建立与工序拆分', () => {
  const app = freshBoot();
  app.addYarn({ name: '红', color: '#a00', material: '丝', stock: 500 });
  app.addYarn({ name: '蓝', color: '#00a', material: '丝', stock: 200 });
  const [yr, yb] = app.__getState().yarns;

  ok('缺名称的方案被拒绝', !app.addPlan({ name: '', warpUse: [{ yarnId: yr.id, grams: 100 }], weftUse: [] }).ok);
  ok('无任何色线用量的方案被拒绝', !app.addPlan({ name: '空', warpUse: [], weftUse: [] }).ok);
  ok('克数为 0 的用色行被忽略后视为无用量', !app.addPlan({ name: '零', warpUse: [{ yarnId: yr.id, grams: 0 }], weftUse: [] }).ok);

  const plan = mkPlan(app, '缠枝莲纹', [{ yarnId: yr.id, grams: 300 }], [{ yarnId: yb.id, grams: 150 }], 3);
  const procs = app.__getState().processes;
  ok('拆出 4 道工序且顺序为 整经→穿综→织造→后整理',
    procs.map(p => p.name).join(',') === '整经,穿综,织造,后整理' && procs.every((p, i) => p.seq === i + 1));
  ok('整经携带经线用量、织造携带纬线用量',
    procs[0].yarnUse[0].grams === 300 && procs[2].yarnUse[0].grams === 150);
  ok('穿综/后整理不耗线', procs[1].yarnUse.length === 0 && procs[3].yarnUse.length === 0);
  ok('织造工期按批量估算（3件×2.4m→4天）', procs[2].days === 4);
  ok('重复拆分工序被拦截', !app.genProcesses(plan.id).ok);
});

/* ================= 2. 库存不足与排程占用 ================= */
group('库存不足与排程占用', () => {
  const app = freshBoot();
  app.addYarn({ name: '红', color: '#a00', material: '丝', stock: 300 });
  const y = app.__getState().yarns[0];
  const plan = mkPlan(app, 'P', [{ yarnId: y.id, grams: 200 }], [{ yarnId: y.id, grams: 150 }]);
  const jz = procOf(app, plan.id, '整经');   // 需 200
  const zz = procOf(app, plan.id, '织造');   // 需 150

  ok('整经排程成功', app.scheduleProcess(jz.id, 'loom1', '2026-09-20').ok);
  ok('占用 200、可用降至 100', app.yarnById(y.id).reserved === 200 && app.available(app.yarnById(y.id)) === 100);

  const before = app.__getState().schedules.length;
  const r1 = app.scheduleProcess(zz.id, 'loom2', '2026-09-20');
  ok('可用不足时排程被拒绝', !r1.ok && r1.msg.includes('库存不足'), r1.msg);
  ok('失败排程不产生排程记录', app.__getState().schedules.length === before);
  ok('失败排程不产生占用', app.yarnById(y.id).reserved === 200);
  ok('工序保持待排程状态', app.procById(zz.id).status === 'pending');

  app.restockYarn(y.id, 50);   // 可用 100+50=150，恰好等于需求
  ok('可用量恰好等于需求时可排程（边界）', app.scheduleProcess(zz.id, 'loom2', '2026-09-20').ok);
  ok('排程后可用量归零', app.available(app.yarnById(y.id)) === 0);
  ok('占用流水已记录', app.__getState().txs.some(t => t.type === '排程占用' && t.resDelta === 150));
});

/* ================= 3. 机台日期冲突（三态） ================= */
group('机台日期冲突（进行中 / 已取消 / 已完工）', () => {
  const app = freshBoot();
  app.addYarn({ name: '红', color: '#a00', material: '丝', stock: 1000 });
  const y = app.__getState().yarns[0];
  const plan = mkPlan(app, 'P', [{ yarnId: y.id, grams: 10 }], [{ yarnId: y.id, grams: 10 }]);
  const jz = procOf(app, plan.id, '整经'), cz = procOf(app, plan.id, '穿综');
  const zz = procOf(app, plan.id, '织造'), hz = procOf(app, plan.id, '后整理');
  const D = '2026-09-21', D2 = '2026-09-22';

  ok('整经排到 loom1 ' + D, app.scheduleProcess(jz.id, 'loom1', D).ok);
  const rActive = app.scheduleProcess(cz.id, 'loom1', D);
  ok('进行中：同机台同日被拦截', !rActive.ok && rActive.msg.includes('进行中的排程'), rActive.msg);
  ok('进行中：换机台可排', app.scheduleProcess(cz.id, 'loom2', D).ok);
  ok('进行中：换日期可排', app.scheduleProcess(zz.id, 'loom1', D2).ok);

  ok('取消整经排程', app.cancelSchedule(lastSch(app, jz.id).id).ok);
  ok('已取消：同时段立即可再排（后整理上位）', app.scheduleProcess(hz.id, 'loom1', D).ok);

  ok('后整理完工', app.completeSchedule(lastSch(app, hz.id).id, []).ok);
  const rDone = app.scheduleProcess(jz.id, 'loom1', D);
  ok('已完工：同机台同日被拦截', !rDone.ok, '未被拦截');
  ok('已完工：拦截提示明确指向完工记录', !rDone.ok && rDone.msg.includes('完工记录'), rDone.msg);
  ok('已完工：换机台可排（完工只锁原机台原日期）', app.scheduleProcess(jz.id, 'loom3', D).ok);
});

/* ================= 4. 取消排程退回库存 ================= */
group('取消排程退回库存', () => {
  const app = freshBoot();
  app.addYarn({ name: '蓝', color: '#00a', material: '丝', stock: 400 });
  const y = app.__getState().yarns[0];
  const plan = mkPlan(app, 'P', [], [{ yarnId: y.id, grams: 120 }]);
  const zz = procOf(app, plan.id, '织造');

  ok('排程成功', app.scheduleProcess(zz.id, 'loom1', '2026-09-22').ok);
  ok('占用 120', app.yarnById(y.id).reserved === 120);
  ok('取消成功', app.cancelSchedule(lastSch(app, zz.id).id).ok);
  ok('占用全额退回、可用恢复 400',
    app.yarnById(y.id).reserved === 0 && app.available(app.yarnById(y.id)) === 400);
  ok('工序回到待排程', app.procById(zz.id).status === 'pending');
  ok('退回流水已记录', app.__getState().txs.some(t => t.type === '取消退回' && t.resDelta === -120));
  const cancelled = lastSch(app, zz.id);
  ok('已取消不能再次取消', !app.cancelSchedule(cancelled.id).ok);

  ok('取消后重新排程', app.scheduleProcess(zz.id, 'loom1', '2026-09-22').ok);
  ok('重新排程后完工', app.completeSchedule(lastSch(app, zz.id).id, [{ yarnId: y.id, grams: 100 }]).ok);
  ok('已完工排程不能取消', !app.cancelSchedule(lastSch(app, zz.id).id).ok);
});

/* ================= 5. 完工结算（实耗扣减） ================= */
group('完工结算（实耗扣减）', () => {
  const app = freshBoot();
  app.addYarn({ name: '红', color: '#a00', material: '丝', stock: 500 });
  app.addYarn({ name: '金', color: '#da4', material: '丝', stock: 100 });
  app.addYarn({ name: '白', color: '#eee', material: '棉', stock: 90 });
  app.addYarn({ name: '紫', color: '#a5a', material: '丝', stock: 90 });
  const [yr, yj, yb, yz] = app.__getState().yarns;

  const p1 = mkPlan(app, 'P1', [{ yarnId: yr.id, grams: 200 }], [{ yarnId: yj.id, grams: 50 }]);
  const jz = procOf(app, p1.id, '整经'), cz = procOf(app, p1.id, '穿综'), zz = procOf(app, p1.id, '织造');
  app.scheduleProcess(jz.id, 'loom1', '2026-09-23');
  app.scheduleProcess(zz.id, 'loom2', '2026-09-23');
  app.scheduleProcess(cz.id, 'loom3', '2026-09-23');

  ok('实耗小于计划：完工成功', app.completeSchedule(lastSch(app, jz.id).id, [{ yarnId: yr.id, grams: 180 }]).ok);
  ok('库存按实耗扣减（500-180=320）', app.yarnById(yr.id).stock === 320);
  ok('计划占用同步释放', app.yarnById(yr.id).reserved === 0);
  ok('完工流水记录计划与实耗', app.__getState().txs.some(t => t.type === '完工扣减' && t.stockDelta === -180 && t.resDelta === -200));
  ok('实耗登记在排程上', lastSch(app, jz.id).actualUse[0].grams === 180);

  ok('实耗等于计划：完工成功', app.completeSchedule(lastSch(app, zz.id).id, [{ yarnId: yj.id, grams: 50 }]).ok);
  ok('库存 100-50=50', app.yarnById(yj.id).stock === 50);

  ok('无耗线工序（穿综）可直接完工', app.completeSchedule(lastSch(app, cz.id).id, []).ok);

  // 边界：实耗 > 计划，但不超过“释放本单占用后的可扣减库存”（90-60+60=90）
  const p2 = mkPlan(app, 'P2', [], [{ yarnId: yb.id, grams: 60 }]);
  const zz2 = procOf(app, p2.id, '织造');
  app.scheduleProcess(zz2.id, 'loom1', '2026-09-24');
  ok('实耗超出计划但在可扣减范围内（边界90=90）', app.completeSchedule(lastSch(app, zz2.id).id, [{ yarnId: yb.id, grams: 90 }]).ok);
  ok('库存扣至 0', app.yarnById(yb.id).stock === 0);

  // 失败：实耗超出可扣减库存
  const p3 = mkPlan(app, 'P3', [], [{ yarnId: yz.id, grams: 60 }]);
  const zz3 = procOf(app, p3.id, '织造');
  app.scheduleProcess(zz3.id, 'loom2', '2026-09-24');
  const rOver = app.completeSchedule(lastSch(app, zz3.id).id, [{ yarnId: yz.id, grams: 91 }]);
  ok('实耗超出可扣减库存被拦截', !rOver.ok && rOver.msg.includes('超出可扣减库存'), rOver.msg);
  ok('拦截后库存与占用未动', app.yarnById(yz.id).stock === 90 && app.yarnById(yz.id).reserved === 60);
  ok('拦截后排程仍在进行中', lastSch(app, zz3.id).status === 'active');
});

/* ================= 6. 重复完工拦截 ================= */
group('重复完工拦截', () => {
  const app = freshBoot();
  app.addYarn({ name: '红', color: '#a00', material: '丝', stock: 500 });
  const y = app.__getState().yarns[0];
  const plan = mkPlan(app, 'P', [{ yarnId: y.id, grams: 100 }], [{ yarnId: y.id, grams: 50 }]);
  const jz = procOf(app, plan.id, '整经'), zz = procOf(app, plan.id, '织造');

  app.scheduleProcess(jz.id, 'loom1', '2026-09-24');
  ok('首次完工成功', app.completeSchedule(lastSch(app, jz.id).id, [{ yarnId: y.id, grams: 100 }]).ok);
  const r1 = app.completeSchedule(lastSch(app, jz.id).id, [{ yarnId: y.id, grams: 100 }]);
  ok('已完工再次完工被拦截', !r1.ok && r1.msg.includes('重复完工'), r1.msg);
  ok('库存未被二次扣减（仍为 400）', app.yarnById(y.id).stock === 400);

  app.scheduleProcess(zz.id, 'loom1', '2026-09-25');
  app.cancelSchedule(lastSch(app, zz.id).id);
  const r2 = app.completeSchedule(lastSch(app, zz.id).id, [{ yarnId: y.id, grams: 50 }]);
  ok('已取消排程完工同样被拦截', !r2.ok && r2.msg.includes('重复完工'), r2.msg);
  ok('库存仍未被扣减（仍为 400）', app.yarnById(y.id).stock === 400);
});

/* ================= 7. 刷新恢复（持久化） ================= */
group('刷新恢复（localStorage 持久化）', () => {
  const app = freshBoot();
  app.addYarn({ name: '红', color: '#a00', material: '丝', stock: 500 });
  app.addYarn({ name: '蓝', color: '#00a', material: '丝', stock: 200 });
  const [yr, yb] = app.__getState().yarns;
  const plan = mkPlan(app, 'P', [{ yarnId: yr.id, grams: 100 }], [{ yarnId: yb.id, grams: 80 }]);
  const jz = procOf(app, plan.id, '整经'), cz = procOf(app, plan.id, '穿综');
  const zz = procOf(app, plan.id, '织造'), hz = procOf(app, plan.id, '后整理');

  app.scheduleProcess(jz.id, 'loom1', '2026-09-25');
  app.completeSchedule(lastSch(app, jz.id).id, [{ yarnId: yr.id, grams: 90 }]);  // 已完工
  app.scheduleProcess(cz.id, 'loom1', '2026-09-26');
  app.cancelSchedule(lastSch(app, cz.id).id);                                    // 已取消
  app.scheduleProcess(zz.id, 'loom2', '2026-09-25');                             // 进行中（蓝占用80）
  // hz 保持待排程
  app.persist();

  const before = JSON.stringify(app.__getState());
  const app2 = boot();   // 同一存储重新载入 = 刷新页面
  ok('刷新后方案/工序/排程/库存/流水完全一致', JSON.stringify(app2.__getState()) === before);
  ok('刷新后占用量保留（蓝 reserved=80）', app2.__getState().yarns.find(v => v.id === yb.id).reserved === 80);
  ok('刷新后三种状态记录都在',
    app2.__getState().schedules.some(s => s.status === 'done') &&
    app2.__getState().schedules.some(s => s.status === 'cancelled') &&
    app2.__getState().schedules.some(s => s.status === 'active'));

  const errs = app2.checkSchedule(hz.id, 'loom1', '2026-09-25');
  ok('刷新后已完工日期仍占用机台', errs.some(e => e.includes('完工记录')), errs.join('；'));

  // 刷新后库存不足仍拦截：蓝线可用 = 200 - 80(织造占用) = 120g，新方案织造需 150g
  const plan2 = mkPlan(app2, 'P2', [], [{ yarnId: yb.id, grams: 150 }]);
  const zz2 = procOf(app2, plan2.id, '织造');
  const rLow = app2.scheduleProcess(zz2.id, 'loom3', '2026-09-27');
  ok('刷新后库存不足仍拦截', !rLow.ok && rLow.msg.includes('库存不足'), rLow.msg);
  ok('拦截不产生新占用（蓝线 reserved 仍为 80）',
    app2.__getState().yarns.find(v => v.id === yb.id).reserved === 80);

  store['brocadeStudio.v1'] = '{broken json';
  const app3 = boot();
  ok('存储损坏时回退到初始状态', app3.__getState().plans.length === 0 && app3.__getState().looms.length === 3);
});

/* ================= 汇总 ================= */
console.log('\n' + (failures ? '✗' : '✓') + ' 共 ' + total + ' 项断言：' + (total - failures) + ' 通过，' + failures + ' 失败');
process.exit(failures ? 1 : 0);
