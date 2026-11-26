import test from 'node:test';
import assert from 'node:assert/strict';
import { auditShotContract } from '../lib/story/contract.js';

test('auditShotContract: 高密度/多参考/缺字幕约束', () => {
  const shot = {
    shotNo: 1,
    durationSeconds: 30,
    prompt: '分镜1\n0—3秒：甲拿手机。3—6秒：乙说“你好”。6—9秒：丙。9—12秒：丁。12—15秒：戊。15—18秒：己。18—21秒：庚。21—24秒：辛。24—27秒：壬。27—30秒：癸。',
  };
  const audit = auditShotContract(shot, { maxRefs: 4, maxBeatsPer15s: 4 });
  assert.equal(audit.shotNo, 1);
  assert.ok(audit.issues.some((i) => i.code === 'subtitle-unlocked'));
  assert.ok(audit.issues.some((i) => i.code === 'no-continuity-lock'));
  assert.ok(audit.issues.some((i) => i.code === 'beats-dense'));
});

test('auditShotContract: 合格合同', () => {
  const shot = {
    shotNo: 2,
    durationSeconds: 15,
    prompt: '0—5秒：白灵右手举手机至胸前，屏幕朝镜头，手机全程在她手中。5—10秒：甲接过剧本。10—15秒：两人对视。画面无任何文字、无字幕、无水印。同一张脸，同一件外套，无眼镜。不要畸形手，不要穿模。',
  };
  const audit = auditShotContract(shot);
  assert.equal(audit.issues.some((i) => i.code === 'subtitle-unlocked'), false);
  assert.equal(audit.issues.some((i) => i.code === 'no-continuity-lock'), false);
});
