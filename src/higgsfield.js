// Acesso à API da Higgsfield. A credencial (HF_CREDENTIALS, key-id:key-secret)
// fica só no servidor e nunca é enviada ao navegador nem escrita no log.
import { createHiggsfieldClient, APIError, HiggsfieldError } from '@higgsfield/client/v2';

export const API_URL = 'https://api.higgsfield.ai';

// Modelos de motion control: o movimento do vídeo de referência é aplicado
// à pessoa das imagens. O primeiro é o padrão (o mais barato).
// tipo define os campos enviados à API (ver validateGeneration em src/app.js).
export const MODELS = {
  'kling-video/motion-control/std': {
    nome: 'Kling 2.6 Standard (mais barato)',
    tipo: 'kling',
    maxImagens: 1,
    resolucoes: [],
    minSegundos: 3,
  },
  'higgsfield/genjutsu-light/motion-transfer/v1.0': {
    nome: 'Genjutsu Lite',
    tipo: 'genjutsu',
    maxImagens: 8,
    resolucoes: ['720p', '1080p'],
    minSegundos: 4,
  },
  'higgsfield/genjutsu/motion-transfer/v1.0': {
    nome: 'Genjutsu',
    tipo: 'genjutsu',
    maxImagens: 8,
    resolucoes: ['480p', '720p', '1080p'],
    minSegundos: 4,
  },
};
export const DEFAULT_MODEL = Object.keys(MODELS)[0];

// Erro com mensagem que pode ser mostrada ao usuário.
export class HiggsfieldFailure extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function createHiggsfield(credentials, { fetch = globalThis.fetch } = {}) {
  if (!credentials || credentials.split(':').length !== 2) {
    throw new Error('Defina HF_CREDENTIALS no formato key-id:key-secret.');
  }
  // Sem novas tentativas automáticas: o envio do pedido é cobrado, e repetir
  // após um tempo esgotado poderia gerar (e cobrar) o mesmo vídeo duas vezes.
  const sdk = createHiggsfieldClient({ credentials, maxRetries: 0 });
  const auth = { Authorization: `Key ${credentials}` };

  async function api(path, options = {}) {
    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: { ...auth, ...options.headers },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new HiggsfieldFailure(describeHttpError(res.status, body));
    return body;
  }

  // Pede um endereço temporário para enviar um arquivo ao armazenamento da
  // Higgsfield. O envio em si (PUT) não leva a credencial.
  async function createUpload(contentType) {
    const slot = await api('/files/generate-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: contentType }),
    });
    if (!slot.upload_url || !slot.public_url) {
      throw new HiggsfieldFailure('A Higgsfield não devolveu o endereço de envio do arquivo.');
    }
    return {
      uploadUrl: slot.upload_url,
      publicUrl: slot.public_url,
      headers: slot.upload_headers ?? { 'Content-Type': contentType },
    };
  }

  return {
    createUpload,

    // Envia o arquivo pelo servidor e devolve a URL pública.
    async upload(data, contentType) {
      const slot = await createUpload(contentType);
      const put = await fetch(slot.uploadUrl, { method: 'PUT', headers: slot.headers, body: data });
      if (!put.ok) throw new HiggsfieldFailure(`Falha ao enviar o arquivo (HTTP ${put.status}).`);
      return slot.publicUrl;
    },

    // Cria o pedido de geração sem esperar terminar; o andamento vem de status().
    async submit(model, input) {
      try {
        const res = await sdk.subscribe(model, { input, withPolling: false });
        if (!res?.request_id) throw new HiggsfieldFailure('A Higgsfield não devolveu o número do pedido.');
        return res.request_id;
      } catch (err) {
        throw toFailure(err);
      }
    },

    async status(requestId) {
      return api(`/requests/${encodeURIComponent(requestId)}/status`);
    },
  };
}

function describeHttpError(status, body) {
  if (status === 401) return 'Credencial da Higgsfield inválida (HF_CREDENTIALS).';
  if (status === 402 || status === 403) return 'Sem créditos suficientes na Higgsfield.';
  const detail = typeof body?.detail === 'string' ? `: ${body.detail}` : '';
  return `A Higgsfield recusou o pedido (HTTP ${status})${detail}`;
}

// Converte erros do SDK sem repassar o objeto original, que pode conter
// os cabeçalhos da requisição (com a credencial).
function toFailure(err) {
  if (err instanceof HiggsfieldFailure) return err;
  if (err instanceof APIError) {
    const detail = typeof err.responseData?.detail === 'string' ? err.responseData.detail : err.message;
    return new HiggsfieldFailure(describeHttpError(err.statusCode ?? 502, { detail }));
  }
  if (err instanceof HiggsfieldError) return new HiggsfieldFailure(`${err.name}: ${err.message}`);
  return new HiggsfieldFailure(`Falha ao falar com a Higgsfield: ${err.message}`);
}
