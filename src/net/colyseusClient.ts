/** 서버 연결 — Colyseus 클라이언트 싱글톤 + 룸 공유 링크 유틸 */

import { Client } from 'colyseus.js';

export const ROOM_NAME = 'poker_room';

/**
 * VITE_SERVER_URL이 없을 때의 기본값 — 'ws://localhost:2567'로 고정하면 LAN의 다른 기기에서
 * 접속했을 때 그 기기 자신의 localhost를 가리키게 되어 서버에 연결할 수 없다. 대신 지금 페이지를
 * 연 호스트명(window.location.hostname)을 그대로 재사용해 같은 서버로 자동 연결되게 한다 —
 * localhost로 열면 localhost:2567, LAN IP(예: 192.168.x.x:5173)로 열면 같은 IP의 2567로 연결된다.
 */
function defaultServerUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.hostname}:2567`;
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL || defaultServerUrl();

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
