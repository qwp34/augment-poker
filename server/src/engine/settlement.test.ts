import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SettlementTracker } from './settlement';

describe('SettlementTracker — 세션당 정확히 한 번만 정산', () => {
  it('track 후 consume하면 userId를 반환한다', () => {
    const t = new SettlementTracker();
    t.track('sess-1', 'user-a');
    assert.equal(t.consume('sess-1'), 'user-a');
  });

  it('같은 세션을 두 번 consume하면 두 번째는 null (이중 정산 방지)', () => {
    const t = new SettlementTracker();
    t.track('sess-1', 'user-a');
    assert.equal(t.consume('sess-1'), 'user-a');
    assert.equal(t.consume('sess-1'), null);
  });

  it('추적된 적 없는 세션은 null (게스트 등 미인증 플레이어)', () => {
    const t = new SettlementTracker();
    assert.equal(t.consume('unknown-session'), null);
  });

  it('서로 다른 세션은 독립적으로 정산된다', () => {
    const t = new SettlementTracker();
    t.track('sess-1', 'user-a');
    t.track('sess-2', 'user-b');
    assert.equal(t.consume('sess-1'), 'user-a');
    assert.equal(t.consume('sess-2'), 'user-b');
    assert.equal(t.consume('sess-1'), null);
    assert.equal(t.consume('sess-2'), null);
  });
});
