/** 간단한 WebAudio 신디사이저 효과음 — 외부 에셋 없이 동작 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(
  freq: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 0.06,
  delay = 0,
) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const t0 = ac.currentTime + delay;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export const sfx = {
  // 카지노 칩 두 개가 짧게 부딪히는 느낌 — 높은 톤 두 개를 살짝 겹쳐 "짤각"처럼 들리게 한다.
  // 전체 길이 ~0.11초로 짧게 잡아 연타(로그인/메뉴 버튼 등)해도 거슬리지 않는다.
  click: () => {
    tone(1500, 0.05, 'square', 0.035);
    tone(2000, 0.05, 'square', 0.028, 0.035);
  },
  deal: () => tone(320, 0.05, 'triangle', 0.04),
  chip: () => {
    tone(880, 0.07, 'sine', 0.05);
    tone(1250, 0.06, 'sine', 0.04, 0.05);
  },
  augment: () => {
    tone(523, 0.12, 'triangle', 0.06);
    tone(784, 0.16, 'triangle', 0.06, 0.09);
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.06, i * 0.09)),
  jackpot: () =>
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.26, 'triangle', 0.07, i * 0.085)),
  lose: () => [420, 320, 220].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.03, i * 0.13)),
};
