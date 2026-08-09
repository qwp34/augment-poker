/** 서버 연결 — Colyseus 클라이언트 싱글톤 + 룸 공유 링크 유틸 */

import { Client } from 'colyseus.js';

export const ROOM_NAME = 'poker_room';

/**
 * Colyseus 서버 엔드포인트 — VITE_SERVER_URL을 'ws://localhost:2567'로 고정하면 LAN의
 * 다른 기기(예: 휴대폰이 http://192.168.x.x:5173으로 접속)에서는 그 기기 자신의
 * localhost를 가리키게 되어 ERR_CONNECTION_REFUSED가 난다. VITE_SERVER_URL이 비어 있으면
 * (.env에서 주석 처리된 경우 포함) 대신 지금 페이지를 연 호스트명(location.hostname)을
 * 그대로 재사용해 같은 서버로 자동 연결되게 한다 — localhost로 열면 localhost:2567,
 * LAN IP로 열면 같은 IP의 2567로 연결된다. 배포된 서버 등 정말 고정 주소가 필요할 때만
 * .env의 VITE_SERVER_URL 값이 우선 적용된다.
 */
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:2567`;

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
