import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { MODELS, DEFAULT_MODEL, HiggsfieldFailure } from './higgsfield.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;

export const UPLOAD_TYPES = {
  video: { types: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 100 * 1024 * 1024 },
  image: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 15 * 1024 * 1024 },
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// hf: objeto com createUpload(), upload(), submit() e status() (src/higgsfield.js).
// password: se definida, todo o app exige login (usuário qualquer + essa senha).
// setupError: configuração faltando; a página abre e mostra o aviso, mas a API
// não gera nada até ser corrigida.
export function createApp({ hf, password, setupError = '' }) {
  return http.createServer(async (req, res) => {
    try {
      if (password && !authorized(req, password)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="appvideo", charset="UTF-8"' });
        return res.end('Login necessário.');
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, hf, setupError);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500 && !(err instanceof HiggsfieldFailure)) console.error(err.message);
      sendJson(res, status, { error: status === 500 ? 'Erro interno.' : err.message });
    }
  });
}

async function handleApi(req, res, url, hf, setupError) {
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const models = Object.entries(MODELS).map(([id, m]) => ({ id, ...m }));
    return sendJson(res, 200, { models, defaultModel: DEFAULT_MODEL, uploads: UPLOAD_TYPES, setupError });
  }
  if (setupError) throw new HttpError(503, setupError);

  // Endereço para o navegador enviar o arquivo direto à Higgsfield, sem passar
  // pelo servidor (na Vercel, o servidor só recebe até 4,5 MB por requisição).
  if (url.pathname === '/api/upload-url' && req.method === 'POST') {
    const body = parseJson(await readBody(req, 4 * 1024));
    const { contentType } = checkUpload(body?.kind, body?.contentType);
    if (!Number.isInteger(body?.size) || body.size <= 0) throw new HttpError(400, 'Arquivo vazio.');
    if (body.size > UPLOAD_TYPES[body.kind].maxBytes) throw new HttpError(413, tooBig(UPLOAD_TYPES[body.kind].maxBytes));
    const slot = await hf.createUpload(contentType);
    return sendJson(res, 200, { ...slot, headers: browserHeaders(slot.headers) });
  }

  // Alternativa: o arquivo passa pelo servidor (usada se o navegador não
  // conseguir enviar direto).
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const { rule, contentType } = checkUpload(url.searchParams.get('kind'), req.headers['content-type']);
    const data = await readBody(req, rule.maxBytes);
    if (data.length === 0) throw new HttpError(400, 'Arquivo vazio.');
    const publicUrl = await hf.upload(data, contentType);
    return sendJson(res, 200, { url: publicUrl });
  }

  if (url.pathname === '/api/generations' && req.method === 'POST') {
    const body = parseJson(await readBody(req, 64 * 1024));
    const { model, input } = validateGeneration(body);
    const requestId = await hf.submit(model, input);
    return sendJson(res, 202, { requestId });
  }

  const match = url.pathname.match(/^\/api\/generations\/([A-Za-z0-9-]{1,100})$/);
  if (match && req.method === 'GET') {
    const result = await hf.status(match[1]);
    return sendJson(res, 200, describeStatus(result));
  }

  throw new HttpError(404, 'Rota não encontrada.');
}

export function validateGeneration(body) {
  const model = body?.model ?? DEFAULT_MODEL;
  const info = MODELS[model];
  if (!info) throw new HttpError(400, 'Modelo inválido.');

  const videoUrl = body?.videoUrl;
  if (!isHttpsUrl(videoUrl)) throw new HttpError(400, 'Envie o vídeo de referência.');

  const imageUrls = body?.imageUrls;
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw new HttpError(400, 'Envie ao menos uma imagem da modelo.');
  }
  if (imageUrls.length > info.maxImagens) {
    throw new HttpError(400, `Use no máximo ${info.maxImagens} imagens.`);
  }
  if (!imageUrls.every(isHttpsUrl)) throw new HttpError(400, 'Imagem inválida.');

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > 10000) throw new HttpError(400, 'Descrição longa demais.');

  if (info.tipo === 'kling') {
    const orientation = body?.characterOrientation ?? 'video';
    if (!['video', 'image'].includes(orientation)) throw new HttpError(400, 'Orientação inválida.');
    const input = {
      image_url: imageUrls[0],
      video_url: videoUrl,
      keep_original_sound: body?.keepOriginalSound === false ? 'no' : 'yes',
      character_orientation: orientation,
    };
    if (prompt) input.prompt = prompt;
    return { model, input };
  }

  const resolution = body?.resolution ?? info.resolucoes[0];
  if (!info.resolucoes.includes(resolution)) {
    throw new HttpError(400, `Resolução inválida para ${info.nome}.`);
  }
  const input = { video_url: videoUrl, image_urls: imageUrls, resolution };
  if (prompt) input.prompt = prompt;
  return { model, input };
}

// Traduz a resposta de /requests/{id}/status. Só há vídeo com status "completed".
export function describeStatus(result) {
  const status = result?.status;
  switch (status) {
    case 'queued':
      return { status, done: false, message: 'Na fila…' };
    case 'in_progress':
      return { status, done: false, message: 'Gerando o vídeo…' };
    case 'completed':
      if (result.video?.url) return { status, done: true, videoUrl: result.video.url, message: 'Vídeo pronto!' };
      return { status: 'failed', done: true, message: 'A geração terminou, mas sem vídeo na resposta.' };
    case 'failed': {
      const reason = typeof result.error === 'string' && result.error ? `: ${result.error.slice(0, 300)}` : '';
      return { status, done: true, message: `A geração falhou${reason}.` };
    }
    case 'nsfw':
      return { status, done: true, message: 'Conteúdo barrado pela moderação (créditos devolvidos).' };
    case 'canceled':
    case 'cancelled':
      return { status: 'canceled', done: true, message: 'O pedido foi cancelado.' };
    default:
      return { status: 'unknown', done: true, message: `Status inesperado da Higgsfield: ${String(status)}.` };
  }
}

function checkUpload(kind, rawType) {
  const rule = UPLOAD_TYPES[kind];
  if (!rule) throw new HttpError(400, 'Tipo de envio inválido.');
  const contentType = String(rawType ?? '').split(';')[0].trim().toLowerCase();
  if (!rule.types.includes(contentType)) {
    throw new HttpError(415, `Formato não aceito. Use: ${rule.types.join(', ')}.`);
  }
  return { rule, contentType };
}

// O navegador não deixa definir alguns cabeçalhos (ele mesmo os calcula).
const FORBIDDEN_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);
function browserHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())));
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function authorized(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new HttpError(413, tooBig(maxBytes));
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, tooBig(maxBytes));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tooBig(maxBytes) {
  return `Arquivo grande demais (máximo ${Math.round(maxBytes / 1024 / 1024)} MB).`;
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  const type = STATIC_TYPES[extname(file)];
  if (!file.startsWith(PUBLIC_DIR) || !type) throw new HttpError(404, 'Não encontrado.');
  let content;
  try {
    content = await readFile(file);
  } catch {
    throw new HttpError(404, 'Não encontrado.');
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(content);
}

function sendJson(res, status, data) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
