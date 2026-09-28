/**
 * dsh-agent-room / F4 — 唤醒预览的**截断自述**回归测试（2026-09-20）
 *
 * 缺陷（2026-09-17 实测）：唤醒预览把正文截到 500 字、上下文每行截到 120 字，
 * 但**没有任何标记** ⇒ 收到"看起来完整"的半句话 ⇒ 按半句作答 ⇒ 一整轮返工。
 * 小黄一条 665 字的结论被切在她看不见的尾部，同型 4 次。
 *
 * 本文件证明（直接调用导出的 buildListenPrompt，不需要起服务、不碰端口）：
 *   1. 长消息：截断处自述【全文 N 字】+【seq】+【取全文的一行命令】，且确实只放了前 500 字；
 *   2. 短消息：**不得**出现任何截断标记（反例；防"到处都标截断"的误报）；
 *   3. 上下文：长行被标记（含全文长度与 seq），短行不被标记；
 *   4. 分母自述：上下文标题给出"共 N 条，此处显示最后 M 条"，不再是硬编码的"（3 条）"。
 *
 * 跑法：node test/wake-truncation-selfreport.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildListenPrompt } from '../lib/host/service.js';

const ROOM = '01a0ad92-0000-7000-8000-000000000000';
const identity = { agentId: 'a'.repeat(32), nickname: '测试机', capabilities: [] };
const msg = (seq, text, nick = '甲', human = false) => ({
  seq, roomId: ROOM, fromAgentId: 'b'.repeat(32), fromNickname: nick,
  text, human, mentions: [], at: '2026-09-20T00:00:00.000Z',
});
const build = (message, recent) => buildListenPrompt({ roomId: ROOM, title: '测试房', identity, message, recent });

test('1) 长消息：自述全文长度 + seq + 取全文命令，且确实只放前 500 字', () => {
  const long = 'X'.repeat(812);
  const out = build(msg(77, long), []);
  assert.match(out, /全文 812 字/, '应自述全文长度');
  assert.match(out, /此处截断到 500/);
  assert.match(out, /seq=77/, '应带 seq，便于精确取回');
  assert.match(out, /取全文：GET http/, '应给出一行取全文命令');
  assert.ok(out.includes(long.slice(0, 500)), '前 500 字应在');
  assert.ok(!out.includes(long.slice(0, 501)), '第 501 字起不应在（证明真的截了）');
});

test('2) 短消息：不得出现任何截断标记（反例 / 防误报）', () => {
  const out = build(msg(5, '只有一句话'), []);
  assert.ok(!out.includes('截断'), '短消息不该被标成截断');
  assert.ok(!out.includes('全文'), '短消息不该出现"全文"字样');
  assert.ok(out.includes('只有一句话'));
});

test('3) 上下文：长行被标记（含长度与 seq），短行不被标记，分母自述', () => {
  const rec = [msg(1, 'Y'.repeat(300), '长发言者'), msg(2, '短', '短发言者')];
  const out = build(msg(3, '正文'), rec);
  assert.match(out, /最近对话（上下文，共 2 条，此处显示最后 2 条）/, '分母必须自述，不能硬编码 3 条');
  assert.match(out, /全文 300 字，seq=1/, '长上下文行应被标记');
  const shortLine = out.split('\n').find((l) => l.includes('短发言者'));
  assert.ok(shortLine, '短上下文行应存在');
  assert.ok(!shortLine.includes('截断'), '短上下文行不应被标记');
});

test('4) 超过 6 条的上下文：标题自述真实总数与显示条数', () => {
  const rec = Array.from({ length: 9 }, (_, i) => msg(i + 1, '短消息' + i, 'R' + i));
  const out = build(msg(10, '正文'), rec);
  assert.match(out, /共 9 条，此处显示最后 6 条/);
});
