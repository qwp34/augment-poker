/**
 * 게임 상태 관리 (Zustand).
 * 게임 루프: 증강 선택 → 핸드 진행(베팅→쇼다운) → 결과 → 다음 라운드 (기획서 3장)
 */

import { create } from 'zustand';
import type { Card, GamePhase, Street } from '../engine/types';
import { createDeck, shuffle, applyRoyalBias } from '../engine/deck';
import { evaluateBest, compareHands, CATEGORY_NAMES_KO, type HandResult } from '../engine/handEvaluator';
import {
  type Augment,
  applyPayoutAugments,
  findByEffect,
  needsTargetSelection,
  rollAugmentChoices,
} from '../engine/augmentEngine';
import { decideBotAction, type BotPersona } from '../engine/botAI';
// 증강 정의는 서버(server/src/data/augments.json)를 단일 소스로 참조한다 —
// 여기 따로 사본을 두지 않는다. 텍스트/효과를 고치려면 그 파일 하나만 수정하면 된다.
import augmentsData from '../../server/src/data/augments.json';

// 대상 지정이 필요한 증강(음침한 눈/카멜레온/당근이세요?)은 대상 지정이 필요한 멀티플레이 전용
// 흐름으로만 구현돼 있다 — 로컬 싱글플레이는 아직 그 효과를 실행할 수 없으므로
// 애초에 제시하지 않는다(고르고도 아무 일도 안 일어나는 "먹통 픽"을 막기 위함).
const AUGMENT_POOL = (augmentsData as Augment[]).filter((a) => !needsTargetSelection(a));

// 멀티플레이 바이인(server/src/rooms/PokerRoom.ts의 INITIAL_CHIPS)과 맞춘다 —
// 싱글플레이는 Supabase와 연동되지 않는 순수 로컬 상태라 여기 숫자를 맞추는 것
// 외에 서버 측 반영은 없다(곧 삭제될 모드).
const INITIAL_CHIPS = 5000;
const ANTE = 100;
const MAX_ROUNDS = 5;
const MAX_RAISES_PER_STREET = 4;

export interface HandOutcome {
  winner: 'player' | 'bot' | 'tie';
  byFold: boolean;
  playerHand?: HandResult;
  botHand?: HandResult;
  basePot: number;
  payout: number;
  multiplier: number;
  appliedAugments: Augment[];
}

interface GameState {
  phase: GamePhase;
  round: number;
  maxRounds: number;
  street: Street;

  deck: Card[];
  playerHole: Card[];
  botHole: Card[];
  community: Card[];

  playerStack: number;
  botStack: number;
  pot: number;
  /** 이번 스트리트에서 각자 낸 칩 */
  streetBets: { player: number; bot: number };
  raisesThisStreet: number;
  /** 누군가 올인해서 남은 베팅 없이 쇼다운으로 직행하는 상태 */
  allInLocked: boolean;
  playerWasAllIn: boolean;

  ownedAugments: Augment[];
  augmentChoices: Augment[];
  swapUsedThisHand: boolean;

  botPersona: BotPersona;
  /** 봇이 고민 중 (연출용 딜레이) — true인 동안 플레이어 입력 잠금 */
  botThinking: boolean;
  /** 봇 말풍선 대사 */
  botSpeech: string | null;
  log: string[];
  outcome: HandOutcome | null;

  // actions
  startGame: () => void;
  chooseAugment: (id: string) => void;
  playerAct: (action: 'fold' | 'checkcall' | 'raise' | 'allin', raiseAmount?: number) => void;
  swapHoleCard: (index: number) => void;
  nextRound: () => void;
}

function pushLog(log: string[], message: string): string[] {
  return [...log.slice(-49), message];
}

export const useGameStore = create<GameState>((set, get) => {
  /** 라운드 시작: 증강 선택지 제시 (남은 증강이 없으면 바로 핸드 시작) */
  function beginRound() {
    const { ownedAugments, round } = get();
    const choices = rollAugmentChoices(AUGMENT_POOL, ownedAugments, round, 3);
    if (choices.length === 0) {
      startHand();
      return;
    }
    set((s) => ({
      phase: 'augment',
      augmentChoices: choices,
      log: pushLog(s.log, `— ${s.round}라운드: 증강을 선택하세요 —`),
    }));
  }

  /** 핸드 시작: 앤티 → 셔플(증강 훅) → 딜링(증강 훅) */
  function startHand() {
    const s = get();
    const anteP = Math.min(ANTE, s.playerStack);
    const anteB = Math.min(ANTE, s.botStack);

    let deck = shuffle(createDeck());
    // [증강 훅: on_shuffle] 로열의 예언 — 연출용 셔플 편향
    const bias = findByEffect(s.ownedAugments, 'shuffle_bias');
    if (bias) deck = applyRoyalBias(deck, bias.effect.value);

    const playerHole = deck.slice(0, 2).map((c) => ({ ...c }));
    const botHole = deck.slice(2, 4).map((c) => ({ ...c }));
    deck = deck.slice(4);

    // [증강 훅: on_round_start] 황금 뒤집개 — 내 홀카드 1장 조커화
    let jokerLog: string | null = null;
    if (findByEffect(s.ownedAugments, 'jokerize_random')) {
      const idx = Math.floor(Math.random() * playerHole.length);
      playerHole[idx] = { ...playerHole[idx], isJoker: true };
      jokerLog = '✨ 황금 뒤집개 발동! 홀카드 1장이 조커가 되었다.';
    }

    set((prev) => {
      let log = pushLog(prev.log, `${prev.round}라운드 핸드 시작 (앤티 ${ANTE})`);
      if (jokerLog) log = pushLog(log, jokerLog);
      return {
        phase: 'betting',
        street: 'preflop',
        deck,
        playerHole,
        botHole,
        community: [],
        playerStack: prev.playerStack - anteP,
        botStack: prev.botStack - anteB,
        pot: anteP + anteB,
        streetBets: { player: 0, bot: 0 },
        raisesThisStreet: 0,
        allInLocked: false,
        playerWasAllIn: false,
        swapUsedThisHand: false,
        outcome: null,
        botSpeech: null,
        log,
      };
    });
  }

  /** 스트리트 종료: 베팅을 팟에 합치고 다음 스트리트 or 쇼다운 */
  function advanceStreet() {
    const s = get();
    const pot = s.pot + s.streetBets.player + s.streetBets.bot;
    const someoneAllIn = s.playerStack === 0 || s.botStack === 0;

    set({ pot, streetBets: { player: 0, bot: 0 }, raisesThisStreet: 0 });

    // 올인 상태면 남은 커뮤니티 카드를 모두 깔고 쇼다운
    if (someoneAllIn) {
      set({ allInLocked: true, playerWasAllIn: get().playerStack === 0 || get().playerWasAllIn });
      let { deck, community } = get();
      while (community.length < 5) {
        community = [...community, deck[0]];
        deck = deck.slice(1);
      }
      set({ deck, community });
      showdown();
      return;
    }

    if (s.street === 'river') {
      showdown();
      return;
    }

    const dealCount = s.street === 'preflop' ? 3 : 1;
    const nextStreet: Street = s.street === 'preflop' ? 'flop' : s.street === 'flop' ? 'turn' : 'river';
    const { deck, community } = get();
    set((prev) => ({
      street: nextStreet,
      community: [...community, ...deck.slice(0, dealCount)],
      deck: deck.slice(dealCount),
      log: pushLog(
        prev.log,
        nextStreet === 'flop' ? '플랍 공개' : nextStreet === 'turn' ? '턴 공개' : '리버 공개',
      ),
    }));
  }

  /** 쇼다운: 핸드 평가 → 승자 결정 → 증강 배당 적용 (기획서 4.1 on_showdown) */
  function showdown() {
    const s = get();
    const playerHand = evaluateBest([...s.playerHole, ...s.community]);
    const botHand = evaluateBest([...s.botHole, ...s.community]);
    const cmp = compareHands(playerHand, botHand);
    const basePot = s.pot;

    let winner: HandOutcome['winner'];
    let payout = basePot;
    let multiplier = 1;
    let appliedAugments: Augment[] = [];
    let playerStack = s.playerStack;
    let botStack = s.botStack;
    let logMsg: string;

    if (cmp > 0) {
      winner = 'player';
      const result = applyPayoutAugments(
        s.ownedAugments,
        { handCategory: playerHand.category, isAllIn: s.playerWasAllIn },
        basePot,
      );
      payout = result.payout;
      multiplier = result.multiplier;
      appliedAugments = result.applied;
      playerStack += payout;
      logMsg =
        `🏆 승리! ${CATEGORY_NAMES_KO[playerHand.category]} — ${payout} 획득` +
        (multiplier > 1 ? ` (증강 배당 ×${multiplier})` : '');
    } else if (cmp < 0) {
      winner = 'bot';
      botStack += basePot;
      logMsg = `패배... 봇의 ${CATEGORY_NAMES_KO[botHand.category]}에 밀렸다.`;
    } else {
      winner = 'tie';
      const half = Math.floor(basePot / 2);
      playerStack += half;
      botStack += basePot - half;
      logMsg = '무승부 — 팟을 나눠 가진다.';
    }

    set((prev) => ({
      phase: 'roundResult',
      pot: 0,
      playerStack,
      botStack,
      outcome: { winner, byFold: false, playerHand, botHand, basePot, payout, multiplier, appliedAugments },
      log: pushLog(prev.log, logMsg),
    }));
  }

  /** 폴드로 핸드 종료 */
  function endByFold(winner: 'player' | 'bot') {
    const s = get();
    const basePot = s.pot + s.streetBets.player + s.streetBets.bot;
    set((prev) => ({
      phase: 'roundResult',
      pot: 0,
      streetBets: { player: 0, bot: 0 },
      playerStack: winner === 'player' ? prev.playerStack + basePot : prev.playerStack,
      botStack: winner === 'bot' ? prev.botStack + basePot : prev.botStack,
      outcome: {
        winner,
        byFold: true,
        basePot,
        payout: basePot,
        multiplier: 1,
        appliedAugments: [],
      },
      log: pushLog(prev.log, winner === 'player' ? '봇이 폴드! 팟을 가져온다.' : '폴드 — 팟을 내준다.'),
    }));
  }

  /** 봇 차례를 딜레이 후 실행 (고민하는 연출) */
  function scheduleBotTurn() {
    set({ botThinking: true });
    const delay = 650 + Math.random() * 750;
    setTimeout(() => {
      set({ botThinking: false });
      if (get().phase !== 'betting') return;
      botTurn();
    }, delay);
  }

  /** 봇 차례 처리. 반환값: 스트리트가 계속되는지(플레이어 재행동 필요) */
  function botTurn() {
    const s = get();
    const toCall = s.streetBets.player - s.streetBets.bot;

    const decision = decideBotAction({
      holeCards: s.botHole,
      community: s.community,
      street: s.street,
      toCall,
      potSize: s.pot + s.streetBets.player + s.streetBets.bot,
      botStack: s.botStack,
      raisesThisStreet: s.raisesThisStreet,
      persona: s.botPersona,
      opponents: 1, // 싱글플레이는 항상 봇 vs 플레이어 헤즈업
    });

    const logBot = (msg: string) =>
      set((prev) => ({
        log: pushLog(prev.log, `🤖 봇: ${msg} — "${decision.reason}"`),
        botSpeech: decision.reason,
      }));

    switch (decision.action) {
      case 'fold':
        logBot('폴드');
        endByFold('player');
        return;

      case 'check':
        logBot('체크');
        advanceStreet();
        return;

      case 'call': {
        const pay = Math.min(toCall, s.botStack);
        set((prev) => ({
          botStack: prev.botStack - pay,
          streetBets: { ...prev.streetBets, bot: prev.streetBets.bot + pay },
        }));
        logBot(`콜 (${pay})`);
        advanceStreet();
        return;
      }

      case 'raise':
      case 'allin': {
        // 레이즈 한도 초과 또는 플레이어가 이미 올인이면 콜로 강등
        const playerAllIn = s.playerStack === 0;
        const raiseAmount =
          decision.action === 'allin' ? s.botStack - toCall : (decision.amount ?? 0);
        if (playerAllIn || s.raisesThisStreet >= MAX_RAISES_PER_STREET || raiseAmount <= 0) {
          const pay = Math.min(toCall, s.botStack);
          set((prev) => ({
            botStack: prev.botStack - pay,
            streetBets: { ...prev.streetBets, bot: prev.streetBets.bot + pay },
          }));
          logBot(`콜 (${pay})`);
          advanceStreet();
          return;
        }
        const pay = Math.min(toCall + raiseAmount, s.botStack);
        set((prev) => ({
          botStack: prev.botStack - pay,
          streetBets: { ...prev.streetBets, bot: prev.streetBets.bot + pay },
          raisesThisStreet: prev.raisesThisStreet + 1,
        }));
        logBot(decision.action === 'allin' ? '올인!' : `레이즈 (+${raiseAmount})`);
        // 플레이어가 다시 응수해야 함 — phase 유지, UI가 콜/폴드 제시
        return;
      }
    }
  }

  return {
    phase: 'augment',
    round: 1,
    maxRounds: MAX_ROUNDS,
    street: 'preflop',
    deck: [],
    playerHole: [],
    botHole: [],
    community: [],
    playerStack: INITIAL_CHIPS,
    botStack: INITIAL_CHIPS,
    pot: 0,
    streetBets: { player: 0, bot: 0 },
    raisesThisStreet: 0,
    allInLocked: false,
    playerWasAllIn: false,
    ownedAugments: [],
    augmentChoices: [],
    swapUsedThisHand: false,
    botPersona: Math.random() < 0.5 ? 'aggressive' : 'cautious',
    botThinking: false,
    botSpeech: null,
    log: [],
    outcome: null,

    startGame: () => {
      set({
        round: 1,
        playerStack: INITIAL_CHIPS,
        botStack: INITIAL_CHIPS,
        pot: 0,
        ownedAugments: [],
        outcome: null,
        botThinking: false,
        botSpeech: null,
        log: ['게임 시작! 5라운드 동안 봇을 이겨보자.'],
        botPersona: Math.random() < 0.5 ? 'aggressive' : 'cautious',
      });
      beginRound();
    },

    chooseAugment: (id) => {
      const choice = get().augmentChoices.find((a) => a.id === id);
      if (!choice) return;
      set((prev) => ({
        ownedAugments: [...prev.ownedAugments, choice],
        augmentChoices: [],
        log: pushLog(prev.log, `증강 획득: [${choice.name}] ${choice.description}`),
      }));
      startHand();
    },

    playerAct: (action, raiseAmount = 0) => {
      const s = get();
      if (s.phase !== 'betting' || s.botThinking) return;
      const toCall = Math.max(0, s.streetBets.bot - s.streetBets.player);

      switch (action) {
        case 'fold':
          endByFold('bot');
          return;

        case 'checkcall': {
          const pay = Math.min(toCall, s.playerStack);
          set((prev) => ({
            playerStack: prev.playerStack - pay,
            playerWasAllIn: prev.playerWasAllIn || prev.playerStack - pay === 0,
            streetBets: { ...prev.streetBets, player: prev.streetBets.player + pay },
            log: pushLog(prev.log, pay > 0 ? `콜 (${pay})` : '체크'),
          }));
          if (toCall > 0) {
            // 봇의 베팅을 받아친 것 → 스트리트 종료
            advanceStreet();
          } else {
            scheduleBotTurn();
          }
          return;
        }

        case 'raise':
        case 'allin': {
          const amount = action === 'allin' ? s.playerStack - toCall : raiseAmount;
          if (amount <= 0 && action === 'raise') return;
          const pay = Math.min(toCall + Math.max(0, amount), s.playerStack);
          set((prev) => ({
            playerStack: prev.playerStack - pay,
            playerWasAllIn: prev.playerWasAllIn || prev.playerStack - pay === 0,
            streetBets: { ...prev.streetBets, player: prev.streetBets.player + pay },
            raisesThisStreet: prev.raisesThisStreet + 1,
            log: pushLog(prev.log, action === 'allin' ? '올인!' : `레이즈 (+${amount})`),
          }));
          scheduleBotTurn();
          return;
        }
      }
    },

    swapHoleCard: (index) => {
      const s = get();
      // [증강 훅: on_hand_start] 카드 재구성 — 핸드당 1회 홀카드 교체
      if (s.phase !== 'betting' || s.swapUsedThisHand) return;
      if (!findByEffect(s.ownedAugments, 'card_swap')) return;
      if (index < 0 || index >= s.playerHole.length) return;

      const [newCard, ...rest] = s.deck;
      const playerHole = [...s.playerHole];
      const old = playerHole[index];
      playerHole[index] = newCard;
      set((prev) => ({
        playerHole,
        deck: rest,
        swapUsedThisHand: true,
        log: pushLog(prev.log, `🔄 카드 재구성: 홀카드 교체 (${old.isJoker ? '조커' : '카드'} → 새 카드)`),
      }));
    },

    nextRound: () => {
      const s = get();
      if (s.playerStack <= 0 || s.botStack <= 0 || s.round >= s.maxRounds) {
        set((prev) => ({
          phase: 'gameOver',
          log: pushLog(prev.log, '— 게임 종료 —'),
        }));
        return;
      }
      set({ round: s.round + 1 });
      beginRound();
    },
  };
});

// 개발 모드: 콘솔에서 연출 테스트용 스토어 접근
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__gameStore = useGameStore;
}
