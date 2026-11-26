import test from 'node:test';
import assert from 'node:assert/strict';
import { localProjectVisible, localRunVisible, ownerFields } from '../lib/core/owner.js';

const sub = {
  userId: '1',
  ownerKey: 'sub:7',
  isSubaccount: true,
  operatorType: 'subaccount',
  operatorSubaccountId: 7,
  operatorLabel: 'tester',
};

test('子账号的 run 只对同一个 operatorKey 可见', () => {
  assert.equal(localRunVisible({ ownerKey: 'sub:7', ownerUserId: '1' }, sub), true);
  assert.equal(localRunVisible({ ownerKey: 'sub:8', ownerUserId: '1' }, sub), false);
  assert.equal(localRunVisible({ ownerUserId: '1' }, sub), false);
});

test('普通用户仍可看到没有 operatorKey 的旧 run', () => {
  const user = { userId: '1', ownerKey: 'user:1', isSubaccount: false };
  assert.equal(localRunVisible({ ownerUserId: '1' }, user), true);
  assert.equal(localRunVisible({ ownerUserId: '2' }, user), false);
});

test('项目 metadata 的 ownerKey 限制子账号访问', () => {
  assert.equal(localProjectVisible('p1', { harnessOwnerKey: 'sub:7' }, sub), true);
  assert.equal(localProjectVisible('p1', { harnessOwnerKey: 'sub:8' }, sub), false);
  assert.equal(localProjectVisible('p1', {}, { userId: '1', ownerKey: 'user:1', isSubaccount: false }), true);
});

test('子账号 token 已由后端按 operator 过滤时直接信任项目列表', () => {
  const scoped = { ...sub, tokenProvider: 'subaccount' };
  assert.equal(localProjectVisible('p1', {}, scoped), true);
  assert.equal(localProjectVisible('p1', { harnessOwnerKey: 'sub:8' }, scoped), false);
});

test('ownerFields 写入稳定的操作者身份', () => {
  assert.deepEqual(ownerFields(sub), {
    ownerUserId: '1',
    ownerUsername: 'tester',
    ownerKey: 'sub:7',
    ownerType: 'subaccount',
    ownerSubaccountId: 7,
    ownerLabel: 'tester',
  });
});
