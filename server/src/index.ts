/** 증강 포커 서버 부트스트랩 — Express(HTTP) + Colyseus(WebSocket) 동일 포트 */

import http from 'http';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PokerRoom } from './rooms/PokerRoom';

const DEFAULT_PORT = Number(process.env.PORT) || 2567;

export async function bootstrap(port = DEFAULT_PORT) {
  const app = express();
  app.use(express.json());

  // REST 엔드포인트 (추후 전적/로비 API 확장 지점)
  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  const httpServer = http.createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define('poker', PokerRoom);

  await gameServer.listen(port);
  return { gameServer, port };
}

if (require.main === module) {
  bootstrap()
    .then(({ port }) => console.log(`🃏 증강 포커 서버 실행 중 — ws://localhost:${port} (HTTP /health 포함)`))
    .catch((err) => {
      console.error('서버 시작 실패:', err);
      process.exit(1);
    });
}
