// Local dev: mock management plane + portal, signed in as DEV_LOGIN_EMAIL without SSO.
import { startMockMgmtPlane } from './mock-mgmt-plane.js';
import { createApp } from '../server.js';

const mock = await startMockMgmtPlane({ port: 4010 });
const port = Number(process.env.PORT) || 3000;
createApp({
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(port),
  MGMT_PLANE_BASE_URL: mock.url,
  MGMT_ADMIN_KEY: 'mock-key',
  SESSION_SECRET: 'dev-only-secret-dev-only-secret-0000',
  DEV_LOGIN_EMAIL: process.env.DEV_LOGIN_EMAIL || 'sarah.chen@example.com',
  GATEWAY_URL: process.env.GATEWAY_URL || 'https://gateway.example.com/v1',
}).listen(port, () => console.log(`Portal: http://localhost:${port}  (mock management plane: ${mock.url})`));
