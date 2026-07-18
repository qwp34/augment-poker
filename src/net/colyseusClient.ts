/** 서버 연결 — Colyseus 클라이언트 싱글톤 + 룸 공유 링크 유틸 */

import { Client } from 'colyseus.js';

export const ROOM_NAME = 'poker_room';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'ws://localhost:2567';

export const client = new Client(SERVER_URL);

/** 현재 경로가 /room/:roomId면 roomId를, 아니면 null을 반환 */
export function getRoomIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/room\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** 주소창을 갱신하지 않고 room.id 기준 공유 가능한 URL 생성 */
export function buildRoomShareUrl(roomId: string): string {
  return `${window.location.origin}/room/${encodeURIComponent(roomId)}`;
}

/** 주소창을 /room/:roomId로 갱신 (페이지 새로고침 없이) */
export function pushRoomPath(roomId: string) {
  window.history.pushState(null, '', `/room/${encodeURIComponent(roomId)}`);
}
