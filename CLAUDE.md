# CLAUDE.md — nda-form

## ⚠️ Fluxo DRI v2: contratos entre sistemas

A fonte da verdade do fluxo comercial (marcos, status, tracking, eventos, comandos e regras operacionais) é **`deal-alluztech/contracts/`**. Comece pelo `README.md` de lá. Toda integração com os outros sistemas (Aurora, Deal, NDA, Contractor, Board) deve seguir esses schemas e ter testes validando contra `contracts/exemplos/`. Descrições de fluxo neste arquivo anteriores ao DRI v2 estão desatualizadas até a revisão da Etapa 9.

**Papel deste sistema:** recebe o comando `nda.convite.criar` (e-mail travado no formulário) e emite `nda.assinatura.parcial` e `nda.assinado` (com os dados jurídicos). O NDA é **por cliente** e vale 1 ano.


## Regras obrigatórias de desenvolvimento

### Testes

**Toda nova funcionalidade ou alteração de comportamento deve ser acompanhada de testes.**

- Criar ou atualizar o arquivo de teste correspondente em `tests/` antes de abrir PR.
- Os testes devem passar (`npm test`) antes de qualquer merge. **Nunca subir PR com testes falhando.**
- Ao adicionar um novo serviço em `src/services/`, criar `tests/<nomeServico>.test.js`.
- Ao adicionar uma nova rota em `src/routes/`, criar ou expandir o arquivo de teste correspondente em `tests/`.
- Ao alterar middleware em `src/middlewares/`, atualizar `tests/middleware-auth.test.js` ou o arquivo equivalente.

### Padrões de mock nos testes

- Banco de dados: sempre usar `jest.mock('../src/db/connection')` (o mock automático fica em `src/db/__mocks__/connection.js`).
- Serviços externos (nodemailer, puppeteer, https): usar `jest.mock()` ou `jest.spyOn()`. Nunca chamar serviços reais nos testes.
- Nunca usar `jest.mock('fs')` — quebra o `cosmiconfig` do Puppeteer. Usar `jest.spyOn(fs, 'readFileSync')` com `.mockRestore()` no `afterEach`.

### Variáveis de ambiente nos testes

- Definir `process.env.JWT_SECRET` no topo do arquivo antes de importar o `app`.
- Remover `process.env.DOCUSEAL_API_KEY` no `beforeEach` quando testar o fluxo sem DocuSeal.

## Stack

- Runtime: Node.js ≥ 20
- Framework: Express 4
- Banco: MySQL 2 (pooled connection em `src/db/connection.js`)
- Auth: JWT (`jsonwebtoken`) + bcrypt
- PDF: Puppeteer (headless Chromium)
- Email: Nodemailer (SMTP Hostinger)
- Assinatura digital: DocuSeal (opcional, via `DOCUSEAL_API_KEY`)
- Testes: Jest + Supertest

## Estrutura do projeto

```
src/
  app.js              # Express app (sem listen); guarda req.rawBody para o HMAC das rotas de integração
  routes/             # nda.js, auth.js, clientes.js, convites.js (/c/:token), integracoes.js (comando, webhook DocuSeal, jobs)
  middlewares/        # auth.js — verifica JWT
  services/           # pdf, email, docuseal, convites, assinaturas (webhook → eventos), outbox, lembretes
  lib/                # validadores (CPF/CNPJ/CEP), integracaoAuth (Bearer + HMAC), contratos (ajv)
  db/
    connection.js     # Pool MySQL
    __mocks__/        # Mock automático do pool para testes
contracts/            # Cópia dos schemas/exemplos do deal-alluztech/contracts (scripts/sync-contracts.sh)
tests/                # Um arquivo por módulo testado; helpers/fakeDb.js = banco falso em memória
```

## Integração com o Deal (DRI v2)

- **Comando** `POST /api/integracoes/convites` (`nda.convite.criar`): Bearer `INTEGRATION_DEAL_TOKEN` + HMAC `INTEGRATION_DEAL_HMAC`
  (e `_PREVIOUS` na rotação), janela de 300 s, `Idempotency-Key`. O token do convite só existe na resposta e no e-mail; no banco, só o hash.
- **Formulário** `GET /c/:token`: e-mail travado (servidor sobrescreve o do POST). Sem token só com `LEGACY_NDA_FORM_ENABLED=true`.
- **Webhook DocuSeal** `POST /api/integracoes/docuseal/webhook`: header `X-Docuseal-Secret` = `DOCUSEAL_WEBHOOK_SECRET`.
  Uma assinatura (`form.completed`) → `nda.assinatura.parcial`; 4/4 → um único `nda.assinado`.
- **Outbox** `outbox_eventos`: grava antes de enviar ao Deal (`DEAL_URL`, `INTEGRATION_NDA_FORM_TOKEN/HMAC`); backoff 1 min → 12 h, até 24 h.
  Retentativa e lembretes por Cloud Scheduler (`POST /api/jobs/outbox`, `/api/jobs/lembretes`, Bearer `JOBS_TOKEN`).
- **Assinaturas no DocuSeal**: `SIGNATURE_FIELDS` em `docusealService.js` (coordenadas da página de assinaturas, última do PDF).
  Mudou `templates/nda.html`? Gere o PDF, confira a última página e recalibre.
- Nunca logar token/link do convite, segredos, assinatura ou CPF/CNPJ completos (`mascararDocumento`).

## Valores fixos do NDA (não vêm do formulário)

| Campo               | Valor            |
|---------------------|------------------|
| `prazo_vigencia`    | 1 (um) ano       |
| `valor_multa`       | R$ 20.000,00     |
| `prazo_nao_solicitacao` | 1 (um) ano   |
