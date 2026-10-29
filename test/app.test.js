import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, validateGeneration, describeStatus } from '../src/app.js';
import { createHiggsfield, DEFAULT_MODEL } from '../src/higgsfield.js';

const calls = [];
const fakeHf = {
  async upload(data, contentType) {
    calls.push({ fn: 'upload', size: data.length, contentType });
    return `https://cdn.example.com/${calls.length}`;
  },
  async submit(model, input) {
    calls.push({ fn: 'submit', model, input });
    return 'req-123';
  },
  async status(id) {
    calls.push({ fn: 'status', id });
    return { status: 'completed', request_id: id, video: { url: 'https://cdn.example.com/out.mp4' } };
  },
};

let server;
let base;
before(async () => {
  server = createApp({ hf: fakeHf, password: 'segredo-123' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const auth = { Authorization: `Basic ${Buffer.from('x:segredo-123').toString('base64')}` };

test('exige a senha do app', async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 401);
  const wrong = await fetch(`${base}/api/config`, {
    headers: { Authorization: `Basic ${Buffer.from('x:errada').toString('base64')}` },
  });
  assert.equal(wrong.status, 401);
});

test('config lista o modelo mais barato como padrão', async () => {
  const res = await fetch(`${base}/api/config`, { headers: auth });
  const body = await res.json();
  assert.equal(body.defaultModel, 'higgsfield/genjutsu-light/motion-transfer/v1.0');
  assert.equal(body.models[0].id, body.defaultModel);
});

test('serve a página inicial', async () => {
  const res = await fetch(`${base}/`, { headers: auth });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Motion Control/);
  const escape = await fetch(`${base}/..%2Fpackage.json`, { headers: auth });
  assert.equal(escape.status, 404);
});

test('envio de arquivo valida o formato e devolve a URL', async () => {
  const bad = await fetch(`${base}/api/upload?kind=image`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'image/gif' }, body: 'x',
  });
  assert.equal(bad.status, 415);

  const ok = await fetch(`${base}/api/upload?kind=video`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'video/mp4' }, body: Buffer.alloc(10),
  });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).url, /^https:\/\/cdn\.example\.com\//);
  assert.deepEqual(calls.at(-1), { fn: 'upload', size: 10, contentType: 'video/mp4' });
});

test('cria a geração e consulta o andamento', async () => {
  const res = await fetch(`${base}/api/generations`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl: 'https://cdn.example.com/v.mp4',
      imageUrls: ['https://cdn.example.com/a.jpg'],
      prompt: '  ',
    }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { requestId: 'req-123' });
  assert.deepEqual(calls.at(-1), {
    fn: 'submit',
    model: DEFAULT_MODEL,
    input: { video_url: 'https://cdn.example.com/v.mp4', image_urls: ['https://cdn.example.com/a.jpg'], resolution: '720p' },
  });

  const status = await fetch(`${base}/api/generations/req-123`, { headers: auth });
  assert.deepEqual(await status.json(), {
    status: 'completed', done: true, videoUrl: 'https://cdn.example.com/out.mp4', message: 'Vídeo pronto!',
  });
});

test('validateGeneration recusa entradas inválidas', () => {
  const ok = { videoUrl: 'https://x.com/v.mp4', imageUrls: ['https://x.com/a.jpg'] };
  assert.throws(() => validateGeneration({ ...ok, model: 'outro' }), /Modelo inválido/);
  assert.throws(() => validateGeneration({ ...ok, videoUrl: 'http://x.com/v.mp4' }), /vídeo/);
  assert.throws(() => validateGeneration({ ...ok, imageUrls: [] }), /ao menos uma imagem/);
  assert.throws(() => validateGeneration({ ...ok, imageUrls: Array(9).fill('https://x.com/a.jpg') }), /no máximo 8/);
  assert.throws(() => validateGeneration({ ...ok, resolution: '480p' }), /Resolução inválida/);
  const { input } = validateGeneration({ ...ok, prompt: ' dançando ' });
  assert.equal(input.prompt, 'dançando');
});

test('describeStatus nunca indica sucesso sem vídeo', () => {
  assert.equal(describeStatus({ status: 'in_progress' }).done, false);
  for (const status of ['failed', 'nsfw', 'canceled', 'cancelled', 'algo-novo']) {
    const r = describeStatus({ status });
    assert.equal(r.done, true);
    assert.equal(r.videoUrl, undefined);
  }
  assert.equal(describeStatus({ status: 'completed' }).status, 'failed');
});

test('createHiggsfield envia arquivo e consulta status com a credencial só no cabeçalho', async () => {
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/files/generate-upload-url')) {
      return Response.json({ upload_url: 'https://storage.example.com/put', public_url: 'https://cdn.example.com/f.jpg' });
    }
    if (url === 'https://storage.example.com/put') return new Response(null, { status: 200 });
    if (url.includes('/requests/')) return Response.json({ status: 'queued', request_id: 'abc' });
    return new Response('{}', { status: 404 });
  };
  const hf = createHiggsfield('id:secret', { fetch: fakeFetch });

  assert.equal(await hf.upload(Buffer.from('img'), 'image/jpeg'), 'https://cdn.example.com/f.jpg');
  assert.equal(requests[0].url, 'https://api.higgsfield.ai/files/generate-upload-url');
  assert.equal(requests[0].options.headers.Authorization, 'Key id:secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), { content_type: 'image/jpeg' });
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].options.headers.Authorization, undefined);

  assert.equal((await hf.status('abc')).status, 'queued');
  assert.equal(requests[2].url, 'https://api.higgsfield.ai/requests/abc/status');

  assert.throws(() => createHiggsfield(''), /HF_CREDENTIALS/);
});
