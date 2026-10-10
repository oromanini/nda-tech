# NDA (nda-form) — Alluz Tech

Serviço Express que coleta os dados jurídicos do cliente por convite e gera o Acordo de Não Divulgação (NDA), que é assinado no DocuSeal. Um NDA por cliente. Deploy no Cloud Run (`.github/workflows/deploy.yml`).

## Fluxo DRI v2: contratos entre sistemas

Fonte da verdade: `../deal-alluztech/contracts/README.md` (e `marcos.json`, `regras-operacionais.md`). Mudança de contrato começa lá, com PR.

Cópia local em `contracts/`, sincronizada por `scripts/sync-contracts.sh` (confirmado: os arquivos copiados são idênticos à origem). Os testes validam contra `contracts/exemplos/` (`tests/contratos.test.js`).

**Papel:** recebe o comando `nda.convite.criar` do Deal e é dono dos dados jurídicos (CNPJ/CPF, endereço, representante, testemunhas). Coleta 4 assinaturas no DocuSeal (cliente, Alluz, 2 testemunhas), para PF e PJ. Emite para `POST {DEAL_URL}/api/integracoes/eventos`:
- `nda.assinatura.parcial`, a cada assinatura;
- `nda.assinado`, uma vez, com 4/4 assinaturas.

**Onde está:**
- Comando: `POST /api/integracoes/convites` (`src/routes/integracoes.js`), auth em `src/lib/integracaoAuth.js`, convite e hash do token em `src/services/convitesService.js`.
- Link do cliente: `GET /c/:token` (`src/routes/convites.js`). O token é opaco; o e-mail vem travado do convite.
- DocuSeal: `src/services/docusealService.js` (campos `SIGNATURE_FIELDS`), webhook `POST /api/integracoes/docuseal/webhook` (header `X-Docuseal-Secret`) e `src/services/assinaturasService.js`.
- Eventos: outbox `outbox_eventos` em `src/services/outboxService.js`. Reenvio por `POST /api/jobs/outbox` (Cloud Scheduler, Bearer `JOBS_TOKEN`). Falhas: `GET /api/integracoes/eventos/falhas`.

`nda.assinado` leva `documento_id` (referência ao documento no DocuSeal), não o PDF.

**Legado:** `LEGACY_NDA_FORM_ENABLED` (padrão `true`) mantém o formulário sem convite em `/` e `POST /api/gerar-nda`. É o caminho legado a ser desligado quando o Deal emitir todos os convites.

## Stack e comandos de dev

- Node.js >= 20, Express 4, MySQL (`mysql2`, pool em `src/db/connection.js`), JWT + bcrypt, Puppeteer (PDF), Nodemailer, Jest + Supertest.
- `npm start` (produção), `npm run dev` (nodemon), `npm test` (Jest), `npm run test:watch`.
- Imagem: `Dockerfile` (node:20-slim com Chromium). Modelo de variáveis: `.env.example`.

**Testes:**
- Toda funcionalidade ou mudança de comportamento leva teste em `tests/`. Nunca subir PR com `npm test` falhando.
- Banco: `jest.mock('../src/db/connection')` (mock em `src/db/__mocks__/connection.js`) ou o banco falso `tests/helpers/fakeDb.js`.
- Serviços externos (nodemailer, puppeteer, https): `jest.mock()` ou `jest.spyOn()`. Nunca chamar serviço real.
- Nunca `jest.mock('fs')`, pois quebra o cosmiconfig do Puppeteer. Use `jest.spyOn(fs, 'readFileSync')` com `.mockRestore()` no `afterEach`.

## Padrões obrigatórios

- **Tipografia:** Plus Jakarta Sans (texto) e JetBrains Mono (código e números). Nunca serifa. Hoje o front usa Inter (`public/style.css`, `admin/*.html`) (a implementar na Etapa 9C).
- **Ícones:** Tabler Icons outline (a implementar na Etapa 9C).
- **Sem emoji** em código, UI, e-mail ou mensagens. CI: `npm run check:emoji` (a implementar na Etapa 9C; o script e o passo de CI ainda não existem).
- **Design flat:** sem gradiente nem sombra. Cores por CSS variables em `:root`. Hoje `public/style.css` ainda tem gradientes e `box-shadow` (a implementar na Etapa 9C).
- **Botões que escrevem** (gerar, enviar, assinar): `useAction` + `Button loading` (a implementar na Etapa 9C; o front é HTML/JS puro, sem componentes).
- **Dinheiro:** cálculo em centavos inteiros. Nas mensagens entre sistemas, decimal em reais (`7200.00`, nunca string), conforme `contracts/README.md` §4.3. Hoje o banco guarda `DECIMAL(15,2)`.
- **Datas:** ISO 8601 com fuso; datas puras `YYYY-MM-DD` (contrato §4.3).
- **Identificadores novos em inglês.** Os existentes em português ficam como estão.
- **Logs:** nunca logar token ou link do convite, segredos, assinatura ou CPF/CNPJ completo. Use `mascararDocumento` (`src/lib/validadores.js`).

## Segredos e ambiente

Só nomes aqui. Valores ficam no GCP Secret Manager (produção) e no `.env` local (ignorado pelo git).

- **Entrada (Deal → nda-form):** `INTEGRATION_DEAL_TOKEN`, `INTEGRATION_DEAL_HMAC`, `INTEGRATION_DEAL_HMAC_PREVIOUS` (rotação; janela de 300 s).
- **Saída (nda-form → Deal):** `INTEGRATION_NDA_FORM_TOKEN`, `INTEGRATION_NDA_FORM_HMAC`. Não há `_PREVIOUS` no código de saída.
- **URLs:** `DEAL_URL` (destino dos eventos), `NDA_PUBLIC_URL` (base dos links do convite), `CONTRACTS_DIR` (opcional).
- **Jobs:** `JOBS_TOKEN` (Bearer do Cloud Scheduler).
- **DocuSeal:** `DOCUSEAL_API_KEY`, `DOCUSEAL_WEBHOOK_SECRET`.
- **Banco:** `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- **SMTP:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_CC`.
- **Admin:** `JWT_SECRET`, `JWT_EXPIRES_IN`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`.
- **Outros:** `PORT`, `NODE_ENV`, `PUPPETEER_EXECUTABLE_PATH`, `LEGACY_NDA_FORM_ENABLED`.
