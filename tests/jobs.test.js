const request = require('supertest');

jest.mock('../src/db/connection');
jest.mock('../src/services/outboxService', () => ({
  ...jest.requireActual('../src/services/outboxService'),
  processarOutbox: jest.fn(async () => ({ analisados: 0, enviados: 0, falhos: 0 })),
  listarFalhas: jest.fn(async () => [{ evento_id: 'e', tipo: 'nda.assinado' }]),
}));
jest.mock('../src/services/lembretesService', () => ({ enviarLembretes: jest.fn(async () => ({ analisados: 0, enviados: 0 })) }));

process.env.JWT_SECRET = 'test-secret';
process.env.JOBS_TOKEN = 'token-do-scheduler';
process.env.INTEGRACAO_DEAL_TOKEN = 'tok-deal';
process.env.INTEGRACAO_DEAL_HMAC = 'hmac-deal';

const { processarOutbox } = require('../src/services/outboxService');
const { enviarLembretes } = require('../src/services/lembretesService');
const { assinar } = require('../src/lib/integracaoAuth');
const app = require('../src/app');

beforeEach(() => jest.clearAllMocks());

describe.each(['/api/jobs/outbox', '/api/jobs/lembretes'])('%s', (rota) => {
  it('sem token, token errado ou JOBS_TOKEN vazio ⇒ 401', async () => {
    expect((await request(app).post(rota)).status).toBe(401);
    expect((await request(app).post(rota).set('Authorization', 'Bearer errado')).status).toBe(401);
    const antes = process.env.JOBS_TOKEN;
    process.env.JOBS_TOKEN = '';
    try { expect((await request(app).post(rota).set('Authorization', 'Bearer ')).status).toBe(401); } finally { process.env.JOBS_TOKEN = antes; }
    expect(processarOutbox).not.toHaveBeenCalled();
    expect(enviarLembretes).not.toHaveBeenCalled();
  });
  it('token certo executa o job', async () => {
    const r = await request(app).post(rota).set('Authorization', 'Bearer token-do-scheduler');
    expect(r.status).toBe(200);
  });
});

describe('GET /api/integracoes/eventos/falhas (o Deal lista)', () => {
  const get = (o = {}) => {
    const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    return request(app).get('/api/integracoes/eventos/falhas')
      .set('Authorization', 'Bearer tok-deal').set('X-Alluz-Origem', 'deal')
      .set('X-Alluz-Timestamp', ts).set('X-Alluz-Assinatura', o.assinatura ?? assinar('hmac-deal', ts, ''));
  };
  it('assinatura do Deal válida (corpo vazio) lista as falhas', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });
  it('assinatura inválida ou timestamp velho ⇒ 401', async () => {
    expect((await get({ assinatura: 'sha256=00' })).status).toBe(401);
    expect((await get({ ts: Math.floor(Date.now() / 1000) - 400 })).status).toBe(401);
  });
});
