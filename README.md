# appvideo

App para gerar vídeos com a API da [Higgsfield](https://cloud.higgsfield.ai). Por enquanto faz **motion control**: você envia um vídeo com o movimento e fotos da sua modelo, e a Higgsfield gera o mesmo vídeo com a sua modelo.

## Modelos

| Modelo | Endpoint | Observação |
| --- | --- | --- |
| Genjutsu Lite (padrão) | `higgsfield/genjutsu-light/motion-transfer/v1.0` | O mais barato (cerca de 1/3 do Genjutsu) |
| Genjutsu | `higgsfield/genjutsu/motion-transfer/v1.0` | Qualidade maior |

Ambos recebem `video_url` (vídeo de 4 a 30 s; acima disso é cortado), `image_urls` (fotos da modelo), `resolution` e `prompt` (opcional). A duração do resultado segue a do vídeo de referência, e o custo também.

## Como rodar

Requer Node.js 22 ou mais novo.

```bash
npm install
cp .env.example .env.local
```

Abra `.env.local` no editor e preencha:

- `HF_CREDENTIALS`: sua chave da Higgsfield no formato `key-id:key-secret`.
- `APP_PASSWORD`: senha para abrir o app. Sem ela, o app só aceita acesso do próprio computador.

```bash
npm start
```

Abra http://localhost:3000.

**Cada geração é cobrada pela Higgsfield.** Se colocar o app na internet, defina `APP_PASSWORD`.

## Como funciona

1. O navegador envia o vídeo e as fotos para o servidor (`POST /api/upload`), que os repassa ao armazenamento da Higgsfield (`/files/generate-upload-url`) e devolve a URL pública.
2. O servidor cria o pedido com o `subscribe` do SDK oficial `@higgsfield/client` (`POST /api/generations`), sem esperar terminar.
3. A página consulta o andamento a cada 5 segundos (`GET /api/generations/:id` → `/requests/{id}/status`). Só mostra o vídeo quando o status é `completed` e há URL; falha, moderação (`nsfw`) e cancelamento aparecem como erro.

A credencial fica só no servidor: nunca vai para o navegador nem para o log. O histórico de vídeos fica salvo no navegador.

## Testes

```bash
npm test
```

Os testes simulam a API da Higgsfield e não gastam créditos.
