const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const MAX_POLL_ERRORS = 5;
const HISTORY_KEY = 'appvideo:historico';

let config;
// Usado quando o navegador não deixa salvar o histórico (aba anônima, por exemplo).
let memoryHistory = null;
let videoDuration = null;
const polling = new Set();

init();

async function init() {
  try {
    config = await api('/api/config');
  } catch (err) {
    return setStatus(err.message, 'error');
  }
  for (const m of config.models) $('model').append(new Option(m.nome, m.id));
  $('model').value = config.defaultModel;
  updateModelOptions();

  $('model').addEventListener('change', updateModelOptions);
  $('video').addEventListener('change', previewVideo);
  $('images').addEventListener('change', previewImages);
  $('form').addEventListener('submit', generate);

  renderHistory();
  if (config.setupError) {
    $('submit').disabled = true;
    return setStatus(config.setupError, 'error');
  }
  for (const item of loadHistory()) if (!item.done) poll(item.id);
}

function currentModel() {
  return config.models.find((m) => m.id === $('model').value);
}

function updateModelOptions() {
  const model = currentModel();
  const select = $('resolution');
  const previous = select.value;
  select.replaceChildren(...model.resolucoes.map((r) => new Option(r, r)));
  if (model.resolucoes.includes(previous)) select.value = previous;
  $('max-images').textContent = model.maxImagens;
}

function previewVideo() {
  const file = $('video').files[0];
  const preview = $('video-preview');
  videoDuration = null;
  $('video-info').textContent = '';
  if (!file) return (preview.hidden = true);
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  preview.onloadedmetadata = () => {
    videoDuration = preview.duration;
    let info = `Duração: ${videoDuration.toFixed(1)} s`;
    if (videoDuration < 4) info += ' — curto demais, o mínimo é 4 segundos.';
    else if (videoDuration > 30) info += ' — só os primeiros 30 segundos serão usados.';
    $('video-info').textContent = info;
  };
}

function previewImages() {
  const box = $('image-preview');
  for (const img of box.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  box.replaceChildren(
    ...[...$('images').files].map((file) => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      return img;
    }),
  );
}

async function generate(event) {
  event.preventDefault();
  const model = currentModel();
  const video = $('video').files[0];
  const images = [...$('images').files];

  const problem = !video
    ? 'Escolha o vídeo de referência.'
    : videoDuration !== null && videoDuration < 4
      ? 'O vídeo precisa ter pelo menos 4 segundos.'
      : images.length === 0
        ? 'Escolha ao menos uma foto da modelo.'
        : images.length > model.maxImagens
          ? `Use no máximo ${model.maxImagens} fotos.`
          : tooLarge([video], 'video') || tooLarge(images, 'image');
  if (problem) return setStatus(problem, 'error');

  $('submit').disabled = true;
  try {
    setStatus('Enviando o vídeo…');
    const videoUrl = await upload(video, 'video');
    const imageUrls = [];
    for (const [i, image] of images.entries()) {
      setStatus(`Enviando foto ${i + 1} de ${images.length}…`);
      imageUrls.push(await upload(image, 'image'));
    }

    setStatus('Criando o pedido na Higgsfield…');
    const { requestId } = await api('/api/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        videoUrl,
        imageUrls,
        resolution: $('resolution').value,
        prompt: $('prompt').value,
      }),
    });

    saveItem({ id: requestId, model: model.nome, createdAt: Date.now(), done: false, message: 'Na fila…' });
    setStatus('Pedido criado. O vídeo aparece em "Seus vídeos" quando ficar pronto.', 'ok');
    poll(requestId);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('submit').disabled = false;
  }
}

function tooLarge(files, kind) {
  const max = config.uploads[kind].maxBytes;
  const big = files.find((f) => f.size > max);
  return big ? `"${big.name}" passa de ${Math.round(max / 1024 / 1024)} MB.` : '';
}

// Envia direto ao armazenamento da Higgsfield. Se o navegador bloquear o envio
// direto, tenta pelo servidor (que na Vercel só aceita arquivos até 4,5 MB).
async function upload(file, kind) {
  const slot = await api('/api/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, contentType: file.type, size: file.size }),
  });
  let put;
  try {
    put = await fetch(slot.uploadUrl, { method: 'PUT', headers: slot.headers, body: file });
  } catch {
    const { url } = await api(`/api/upload?kind=${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    return url;
  }
  if (!put.ok) throw new Error(`Falha ao enviar "${file.name}" (HTTP ${put.status}).`);
  return slot.publicUrl;
}

async function poll(id) {
  if (polling.has(id)) return;
  polling.add(id);
  let errors = 0;
  while (true) {
    try {
      const result = await api(`/api/generations/${encodeURIComponent(id)}`);
      errors = 0;
      saveItem({ id, done: result.done, status: result.status, message: result.message, videoUrl: result.videoUrl });
      if (result.done) break;
    } catch (err) {
      if (++errors >= MAX_POLL_ERRORS) {
        saveItem({ id, message: `Não foi possível consultar o andamento: ${err.message} Recarregue a página para tentar de novo.` });
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  polling.delete(id);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 413 && !data.error) throw new Error('Arquivo grande demais para enviar pelo servidor.');
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}.`);
  return data;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function loadHistory() {
  if (memoryHistory) return memoryHistory;
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveItem(update) {
  const history = loadHistory();
  const index = history.findIndex((item) => item.id === update.id);
  if (index === -1) history.unshift(update);
  else history[index] = { ...history[index], ...update };
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30)));
  } catch {
    // Sem armazenamento local: o histórico só vale até recarregar a página.
    memoryHistory = history;
  }
  renderHistory(history);
}

function renderHistory(history = loadHistory()) {
  $('history-card').hidden = history.length === 0;
  $('history').replaceChildren(
    ...history.map((item) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const when = item.createdAt ? new Date(item.createdAt).toLocaleString('pt-BR') : '';
      meta.textContent = [item.model, when].filter(Boolean).join(' · ');
      const message = document.createElement('div');
      message.textContent = item.message || '';
      li.append(meta, message);

      if (item.videoUrl && item.videoUrl.startsWith('https://')) {
        const video = document.createElement('video');
        video.src = item.videoUrl;
        video.controls = true;
        video.playsInline = true;
        const link = document.createElement('a');
        link.href = item.videoUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Abrir / baixar o vídeo';
        li.append(video, link);
      }
      return li;
    }),
  );
}
