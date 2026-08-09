/**
 * 효과음 모듈 — Web Audio API로 실시간 합성해 재생한다(외부 오디오 파일 없음).
 * 나중에 실제 사운드 파일(mp3/ogg)로 교체하고 싶으면 이 파일의 SOUND_PLAYERS 구현부만
 * `new Audio(url).play()` 방식으로 바꾸면 된다 — 호출부(playSound('cardDeal') 등)는
 * 그대로 유지할 수 있도록 이름 기반 API로 추상화해 두었다.
 */

export type SoundName =
  | 'cardDeal'
  | 'chipBet'
  | 'buttonClick'
  | 'win'
  | 'augmentSelect'
  | 'cardSwap'
  | 'myTurn'
  | 'showdownSting'
  | 'tick'
  | 'rouletteAlarm'
  | 'gunshot';

const STORAGE_KEY = 'augment-poker:soundEnabled';

let ctx: AudioContext | null = null;
let enabled = readInitialEnabled();

function readInitialEnabled(): boolean {
  try {
    // sessionStorage — 세션(탭) 안에서만 유지되고 브라우저를 닫으면 초기화된다(기본값 on)
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function persistEnabled(value: boolean) {
  try {
    sessionStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 접근 불가(프라이빗 모드 등)여도 재생 자체는 계속 동작해야 하므로 무시
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean) {
  enabled = value;
  persistEnabled(value);
}

export function toggleSoundEnabled(): boolean {
  setSoundEnabled(!enabled);
  return enabled;
}

/** 오디오 컨텍스트는 첫 사용자 상호작용 시점에 지연 생성 — 브라우저 자동재생 정책 대응 */
function audioCtx(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 순수 톤(오실레이터) 한 개 — 감쇠 곡선까지 포함해 짧게 울리고 자동으로 멈춘다 */
function tone(
  ac: AudioContext,
  freq: number,
  duration: number,
  type: OscillatorType = 'sine',
  volume = 0.06,
  delay = 0,
  freqTo?: number,
) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const t0 = ac.currentTime + delay;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + duration);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + Math.min(0.015, duration / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/** 화이트 노이즈 버스트를 대역통과 필터에 통과시켜 "촥/휙" 계열의 스침 소리를 만든다 */
function noiseSweep(
  ac: AudioContext,
  duration: number,
  freqFrom: number,
  freqTo: number,
  volume = 0.05,
  delay = 0,
) {
  const bufferSize = Math.max(1, Math.floor(ac.sampleRate * duration));
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = ac.createBufferSource();
  noise.buffer = buffer;

  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.1;
  const t0 = ac.currentTime + delay;
  filter.frequency.setValueAtTime(freqFrom, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + duration);

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + Math.min(0.02, duration / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  noise.connect(filter).connect(gain).connect(ac.destination);
  noise.start(t0);
  noise.stop(t0 + duration + 0.05);
}

/** 각 효과음의 실제 합성 레시피 — 이름별로 하나씩, 여러 tone()/noiseSweep() 조합 가능 */
const SOUND_PLAYERS: Record<SoundName, (ac: AudioContext) => void> = {
  // 카드 딜링 — 짧고 가벼운 "촥" (고음 쪽으로 빠르게 스치는 노이즈)
  cardDeal: (ac) => noiseSweep(ac, 0.09, 2600, 1200, 0.05),

  // 베팅/콜 — 칩이 부딪히는 두 번의 짧은 금속성 클릭
  chipBet: (ac) => {
    tone(ac, 1100, 0.045, 'square', 0.035);
    tone(ac, 1500, 0.05, 'square', 0.03, 0.04);
  },

  // 버튼 클릭 — 아주 짧은 틱
  buttonClick: (ac) => tone(ac, 720, 0.035, 'square', 0.03),

  // 라운드 승리 — 밝게 상승하는 4음 아르페지오
  win: (ac) => [523, 659, 784, 1047].forEach((f, i) => tone(ac, f, 0.2, 'triangle', 0.06, i * 0.09)),

  // 증강 선택 — 신비로운 두 톤(살짝 디튠된 화음)
  augmentSelect: (ac) => {
    tone(ac, 523, 0.18, 'triangle', 0.05);
    tone(ac, 659, 0.22, 'triangle', 0.045, 0.05);
    tone(ac, 784, 0.26, 'sine', 0.03, 0.1);
  },

  // 카드 교체/변경 증강 발동 — 휙 스치는 소리(카드딜보다 낮은 대역, 살짝 더 길게)
  cardSwap: (ac) => noiseSweep(ac, 0.14, 900, 2200, 0.05),

  // 내 차례 — 부드러운 2음 알림(차임벨 느낌)
  myTurn: (ac) => {
    tone(ac, 784, 0.16, 'sine', 0.045);
    tone(ac, 988, 0.22, 'sine', 0.04, 0.12);
  },

  // 쇼다운 임팩트 — "SHOW DOWN" 텍스트 등장 순간의 강한 타격음(저음 임팩트 + 짧은 금속성 스윕)
  showdownSting: (ac) => {
    tone(ac, 130, 0.3, 'sawtooth', 0.07);
    noiseSweep(ac, 0.2, 4000, 800, 0.05, 0.02);
  },

  // 러시안 룰렛 카운트다운 — "째깍" 시계 초침
  tick: (ac) => tone(ac, 1900, 0.045, 'square', 0.045),

  // 러시안 룰렛 발동 — 다급한 사이렌풍 두 음
  rouletteAlarm: (ac) => {
    tone(ac, 220, 0.35, 'sawtooth', 0.075);
    tone(ac, 175, 0.4, 'sawtooth', 0.065, 0.08);
  },

  // 총성 — 낮은 충격 임팩트 + 고음에서 저음으로 빠르게 스치는 노이즈
  gunshot: (ac) => {
    noiseSweep(ac, 0.18, 3200, 200, 0.09);
    tone(ac, 90, 0.28, 'sawtooth', 0.08, 0, 35);
  },
};

/**
 * 이름으로 효과음을 재생한다. 사운드가 꺼져있거나(setSoundEnabled(false)) 오디오
 * 컨텍스트를 생성할 수 없는 환경(예: 아직 사용자 상호작용이 없었던 iOS Safari)이면
 * 조용히 무시한다 — 호출부는 항상 안전하게 호출만 하면 된다.
 */
export function playSound(name: SoundName) {
  if (!enabled) return;
  const ac = audioCtx();
  if (!ac) return;
  try {
    SOUND_PLAYERS[name](ac);
  } catch (err) {
    console.error(`[sounds] '${name}' 재생 실패:`, err);
  }
}
