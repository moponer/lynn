// 2026-11-15 实机：新建群后右栏仍挂着别群的「等你拍板」（问题/契约/审批）。
// 根因：decisions 是内核的全局数组，快照原样吐给渲染层，没有群归属。
// 这里锁死四件事：打标 → 只出本群 → 切回还在 → 跨重启不串群。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Kernel } from '../dist/main/kernel.js';
import { TeamStore } from '../dist/main/team-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-decision-scope-'));

function seedModel(root) {
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({
      model: {
        provider: 'test',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'test-model',
        apiKey: { encrypted: false, data: 'test-key' },
        updatedAt: new Date().toISOString(),
      },
    }),
    'utf-8',
  );
}

function seedTeam(root) {
  const teams = new TeamStore(root);
  teams.createTeam('t1', '月报突击队');
  teams.writeMember('t1', {
    name: '林工',
    role: '数据整理员',
    goal: '把源数据整理成可核对的月报',
    boundaries: ['只动工作区'],
    tools: ['read_file', 'write_file'],
    model: 'test-model',
    limits: { maxTurns: 6, budgetTokens: 100000, wallClockMin: 10 },
    outputContract: { deliverable: 'report.md', evidence: ['报告文件'], acceptance: ['数字可对账'] },
    escalateWhen: '卡住',
    body: '',
  });
}

function setup() {
  const root = tmp();
  seedModel(root);
  seedTeam(root);
  const kernel = new Kernel(root);
  kernel.handle('config.prefs', { autoStart: false });
  return { root, kernel };
}

const BRIEF =
  '【目标】把 9 月材料整理成月报\n【完成标准】产出月报文件，数字与源材料核对一致\n【材料与位置】材料文件在工作区\n【限制】只做 9 月，不要改源材料';

const assign = (kernel, taskId) =>
  kernel.runTool('assign_task', {
    teamId: 't1',
    taskId,
    member: '林工',
    brief: BRIEF,
    deadline: '30 分钟',
  });

const decisions = (kernel) => kernel.handle('session.snapshot').board.decisions;

test('新建群不显示别群的「等你拍板」，切回原群两张卡都还在', () => {
  const { kernel } = setup();
  const aId = kernel.currentThreadId;
  assert.ok(aId, '默认群存在');

  const asked = kernel.runTool('ask_user', { question: '要梳理的「项目」指哪个仓库？', checks: [] });
  assert.match(asked, /等待回答/);
  const assigned = assign(kernel, 'WO-SCOPE-1');
  assert.match(assigned, /任务契约已呈给用户/, assigned);

  const before = decisions(kernel);
  assert.equal(before.length, 2, '一张问询 + 一张契约');
  assert.ok(before.every((d) => d.threadId === aId), '每张卡都带群标记');

  const created = kernel.handle('session.new', {});
  assert.equal(created.ok, true);
  assert.notEqual(kernel.currentThreadId, aId);
  assert.equal(decisions(kernel).length, 0, '新群不该冒出别群的问题/契约');

  kernel.handle('thread.switch', { id: aId });
  const back = decisions(kernel);
  assert.equal(back.length, 2, '切回原群，两张卡都还在');
  assert.ok(back.every((d) => d.threadId === aId));
});

test('在新群说话只撤本群问询；别群等契约也不堵本群提问', () => {
  const { kernel } = setup();
  const aId = kernel.currentThreadId;
  kernel.runTool('ask_user', { question: '要梳理的「项目」指哪个仓库？', checks: [] });
  assign(kernel, 'WO-SCOPE-2');
  kernel.handle('session.new', {});

  // 别群有刚呈上的契约（lastPlanAt 在 2 分钟内），本群问别的问题不该被当成「重复确认」
  const asked = kernel.runTool('ask_user', { question: '报告用 Markdown 还是 docx？', checks: [] });
  assert.match(asked, /等待回答/, asked);
  assert.equal(decisions(kernel).filter((d) => d.kind === 'question').length, 1);

  kernel.handle('feed.send', { text: '就用 Markdown' });
  assert.equal(decisions(kernel).some((d) => d.kind === 'question'), false, '本群问询由发言撤掉');

  kernel.handle('thread.switch', { id: aId });
  const back = decisions(kernel);
  assert.equal(back.filter((d) => d.kind === 'question').length, 1, '别群问询没被新群那句话抹掉');
  assert.equal(back.filter((d) => d.kind === 'plan').length, 1, '别群契约没被动过');
});

test('待拍板卡的群归属跨重启保留：原群看得见、别群看不见', async () => {
  const { root, kernel } = setup();
  const aId = kernel.currentThreadId;
  kernel.runTool('ask_user', { question: '周报口径按自然周还是交付周？', checks: [] });
  kernel.handle('session.new', {});
  const bId = kernel.currentThreadId;

  const file = path.join(root, 'pending.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(saved.decisions.length, 1);
  assert.equal(saved.decisions[0].threadId, aId, '落盘就带群标记');

  const k2 = new Kernel(root);
  await k2.init();
  k2.handle('thread.switch', { id: aId });
  assert.equal(decisions(k2).length, 1, '重启后原群还认得这张卡');
  k2.handle('thread.switch', { id: bId });
  assert.equal(decisions(k2).length, 0, '重启后别群依旧看不到');
});

test('旧版 pending.json 没有群标记：重启回填归属，且只在一个群出现', async () => {
  const { root, kernel } = setup();
  const aId = kernel.currentThreadId;
  kernel.runTool('ask_user', { question: '周报口径按自然周还是交付周？', checks: [] });
  kernel.handle('session.new', {});
  const bId = kernel.currentThreadId;

  const file = path.join(root, 'pending.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf-8'));
  delete legacy.decisions[0].threadId;
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf-8');

  const k2 = new Kernel(root);
  await k2.init();
  const stamped = JSON.parse(fs.readFileSync(file, 'utf-8')).decisions[0].threadId;
  assert.ok(stamped, '旧文件会被补上群标记');
  const counts = [aId, bId].map((id) => {
    k2.handle('thread.switch', { id });
    return decisions(k2).length;
  });
  assert.deepEqual(counts.slice().sort(), [0, 1], '不会变成每个群都弹的卡');
});
