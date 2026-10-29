import { createApp } from './src/app.js';
import { createHiggsfield } from './src/higgsfield.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

let hf;
try {
  hf = createHiggsfield(process.env.HF_CREDENTIALS);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const password = process.env.APP_PASSWORD || '';
const port = Number(process.env.PORT) || 3000;
// Sem senha, o app só aceita conexões deste computador: cada geração gasta créditos.
const host = process.env.HOST || (password ? '0.0.0.0' : '127.0.0.1');

const server = createApp({ hf, password });
server.listen(port, host, () => {
  console.log(`appvideo rodando em http://localhost:${port}`);
  if (!password) console.log('Sem APP_PASSWORD: acessível só por este computador.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
