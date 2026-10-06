jest.mock('../src/db/connection');

process.env.DEAL_URL = 'https://deal.test';
process.env.INTEGRATION_NDA_FORM_TOKEN = 'tok';
process.env.INTEGRATION_NDA_FORM_HMAC = 'hmac';

const pool = require('../src/db/connection');
const { criarFakeDb } = require('./helpers/fakeDb');
const { montarEnvelope, enfileirar, tentarEnvio, processarOutbox, listarFalhas, proximaTentativa, BACKOFF_MINUTOS } = require('../src/services/outboxService');

const fetchMock = jest.fn();
global.fetch = fetchMock;
let db;

const env = () => montarEnvelope({
  tipo: 'nda.assinatura.parcial', projeto_uuid: '550e8400-e29b-41d4-a716-446655440000', cliente_uuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  dados: { nda_id: '1', papel: 'cliente', nome: 'M', assinado_em: new Date().toISOString(), assinaturas_concluidas: 1, assinaturas_total: 4 },
});

async function novo(criadoEm) {
  const id = await enfileirar(env(), `k:${Math.random()}`);
  if (criadoEm) db.st.outbox.find((o) => o.id === id).criado_em = criadoEm;
  return id;
}
const linha = (id) => db.st.outbox.find((o) => o.id === id);

beforeEach(() => { jest.clearAllMocks(); db = criarFakeDb(); pool.query.mockImplementation(db.query); });

describe('outbox de eventos', () => {
  it('2xx marca enviado', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const id = await novo();
    expect((await tentarEnvio(id)).status).toBe('enviado');
    expect(linha(id).status).toBe('enviado');
  });

  it('5xx retenta: continua pendente e agenda +1 min', async () => {
    fetchMock.mockResolvedValue({ status: 503 });
    const id = await novo();
    const agora = new Date();
    linha(id).criado_em = agora;
    const r = await tentarEnvio(id, agora);
    expect(r.status).toBe('pendente');
    expect(linha(id)).toMatchObject({ status: 'pendente', tentativas: 1 });
    expect(+linha(id).proxima - +agora).toBe(60000);
  });

  it('timeout e erro de rede retentam', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }));
    const id = await novo();
    expect((await tentarEnvio(id)).motivo).toBe('timeout');
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const id2 = await novo();
    expect((await tentarEnvio(id2)).motivo).toBe('erro de rede');
    expect(linha(id).status).toBe('pendente');
  });

  it('4xx não retenta: falhou na primeira', async () => {
    fetchMock.mockResolvedValue({ status: 422 });
    const id = await novo();
    expect((await tentarEnvio(id)).status).toBe('falhou');
    expect(linha(id)).toMatchObject({ status: 'falhou', tentativas: 1, ultimo_erro: 'HTTP 422' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('esgotado (oitava falha) marca falhou e fica visível na listagem', async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    const id = await novo();
    linha(id).tentativas = BACKOFF_MINUTOS.length;
    expect((await tentarEnvio(id)).status).toBe('falhou');
    expect(linha(id).ultimo_erro).toMatch(/^esgotado/);
  });

  it('passou de 24 h desde a criação ⇒ falhou', async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    const id = await novo(new Date(Date.now() - 25 * 3600 * 1000));
    linha(id).tentativas = 2;
    expect((await tentarEnvio(id)).status).toBe('falhou');
  });

  it('backoff: 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h e depois esgota', () => {
    const t0 = new Date('2026-10-04T00:00:00Z');
    expect([1, 2, 3, 4, 5, 6, 7].map((k) => (proximaTentativa(k, t0, t0) - t0) / 60000)).toEqual([1, 5, 15, 60, 180, 360, 720]);
    expect(proximaTentativa(8, t0, t0)).toBeNull();
  });

  it('dedupe_key repetida não cria outro evento', async () => {
    const a = await enfileirar(env(), 'assinado:1');
    const b = await enfileirar(env(), 'assinado:1');
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect(db.st.outbox).toHaveLength(1);
  });

  it('destino sem configuração não envia (reagenda)', async () => {
    const url = process.env.DEAL_URL;
    process.env.DEAL_URL = '';
    try {
      const id = await novo();
      expect((await tentarEnvio(id)).status).toBe('pendente');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { process.env.DEAL_URL = url; }
  });

  it('dois processos não enviam o mesmo evento (reivindicação)', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const id = await novo();
    linha(id).emAndamento = true;
    expect((await tentarEnvio(id)).motivo).toBe('em_andamento');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('o job reprocessa o que está vencido e conta enviados e falhos', async () => {
    const a = await novo();
    const b = await novo();
    pool.query.mockImplementation(async (sql, p) => (/^SELECT id FROM outbox_eventos WHERE status = 'pendente'/.test(sql.replace(/\s+/g, ' ').trim()) ? [[{ id: a }, { id: b }]] : db.query(sql, p)));
    fetchMock.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 400 });
    expect(await processarOutbox()).toEqual({ analisados: 2, enviados: 1, falhos: 1 });
  });

  it('listarFalhas não expõe o payload (dados pessoais)', async () => {
    pool.query.mockResolvedValueOnce([[{ evento_id: 'e', tipo: 't', projeto_uuid: 'p', tentativas: 8, ultimo_erro: 'x', criado_em: new Date() }]]);
    const f = await listarFalhas();
    expect(pool.query.mock.calls[0][0]).not.toMatch(/payload/);
    expect(f).toHaveLength(1);
  });

  it('nunca loga corpo, token ou assinatura', async () => {
    const espiao = jest.spyOn(console, 'error').mockImplementation(() => {});
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ status: 422 });
    await tentarEnvio(await novo());
    const log = JSON.stringify([...espiao.mock.calls, ...aviso.mock.calls]);
    expect(log).not.toMatch(/tok|hmac|sha256=|assinaturas_concluidas/);
    espiao.mockRestore(); aviso.mockRestore();
  });
});
