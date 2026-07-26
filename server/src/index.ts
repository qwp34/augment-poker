/** 증강 포커 서버 부트스트랩 — Express(HTTP) + Colyseus(WebSocket) 동일 포트 */

import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { monitor } from '@colyseus/monitor';
import { PokerRoom } from './rooms/PokerRoom';

const DEFAULT_PORT = Number(process.env.PORT) || 2567;
// '0.0.0.0'을 명시해 모든 네트워크 인터페이스에서 리스닝한다 — 호스트명을 생략해도
// Node가 기본으로 이렇게 동작하지만(암묵적 동작이라 코드만 봐서는 드러나지 않음),
// 같은 LAN의 다른 기기(휴대폰 등)에서도 접속 가능함을 명시적으로 보이기 위해 직접 지정한다.
// 방화벽 등으로 인바운드를 특정 인터페이스로 제한하고 싶으면 HOST 환경변수로 덮어쓸 수 있다.
const DEFAULT_HOST = process.env.HOST || '0.0.0.0';

export async function bootstrap(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // REST 엔드포인트 (추후 전적/로비 API 확장 지점)
  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  const httpServer = http.createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define('poker_room', PokerRoom);

  // 디버깅용 Colyseus Monitor 패널
  app.use('/colyseus', monitor());

  await gameServer.listen(port, host);
  return { gameServer, port, host };
}

if (require.main === module) {
  bootstrap()
    .then(({ port, host }) =>
      console.log(
        `🃏 증강 포커 서버 실행 중 — ws://${host}:${port} (모든 인터페이스에서 접속 가능 · HTTP /health, /colyseus 모니터 포함)`,
      ),
    )
    .catch((err) => {
      console.error('서버 시작 실패:', err);
      process.exit(1);
    });
}
