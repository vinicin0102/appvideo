import { createApp } from './src/app.js';
import { createHiggsfield } from './src/higgsfield.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

const onVercel = Boolean(process.env.VERCEL);
const where = onVercel
  ? 'nas variáveis de ambiente da Vercel (Settings → Environment Variables) e faça um novo deploy'
  : 'no arquivo .env.local e reinicie o app';
const password = process.env.APP_PASSWORD || '';

// Configuração faltando não derruba o app: a página abre e mostra o que falta.
let hf = null;
let setupError = '';
try {
  hf = createHiggsfield(process.env.HF_CREDENTIALS);
} catch {
  setupError = `Defina HF_CREDENTIALS (key-id:key-secret) ${where}.`;
}
if (!setupError && onVercel && !password) {
  setupError = `Defina APP_PASSWORD ${where}: sem senha, qualquer pessoa com o link gastaria seus créditos.`;
}
if (setupError) console.error(setupError);

const port = Number(process.env.PORT) || 3000;
const server = createApp({ hf, password, setupError });

if (onVercel) {
  server.listen(port);
} else {
  // Sem senha, o app só aceita conexões deste computador: cada geração gasta créditos.
  const host = process.env.HOST || (password ? '0.0.0.0' : '127.0.0.1');
  server.listen(port, host, () => {
    console.log(`appvideo rodando em http://localhost:${port}`);
    if (!password) console.log('Sem APP_PASSWORD: acessível só por este computador.');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
