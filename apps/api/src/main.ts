import 'reflect-metadata';
import { createApp } from './bootstrap';
import { loadEnv } from './config/env';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.PORT);
  console.log(`API da OTILC em http://localhost:${env.PORT}/api`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
