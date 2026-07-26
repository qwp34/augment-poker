import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // host: true로 0.0.0.0에 바인딩해 같은 LAN의 다른 기기(휴대폰 등)에서도
  // 터미널에 찍히는 "Network" URL로 접속할 수 있게 한다.
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
})
