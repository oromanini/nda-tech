const request = require('supertest');

jest.mock('../src/db/connection');
jest.mock('../src/services/emailService');
jest.mock('../src/services/pdfService');
jest.mock('../src/services/docusealService');

process.env.JWT_SECRET = 'test-secret';
process.env.DOCUSEAL_WEBHOOK_SECRET = 'segredo-webhook';
process.env.DEAL_URL = 'https://deal.test/';
process.env.INTEGRACAO_NDA_FORM_TOKEN = 'tok-nda-form';
process.env.INTEGRACAO_NDA_FORM_HMAC = 'hmac-nda-form';

const pool = require('../src/db/connection');
const { criarFakeDb } = require('./helpers/fakeDb');
const { validarEnvelope } = require('../src/lib/contratos');
const { assinar } = require('../src/lib/integracaoAuth');
const app = require('../src/app');

const PROJETO = '550e8400-e29b-41d4-a716-446655440000';
const CLIENTE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const fetchMock = jest.fn();
global.fetch = fetchMock;
let db;

function ndaPJ(extra = {}) {
  return {
    id: 5, tipo_pessoa: 'PJ', razao_social: 'BPO Exemplo LTDA', cnpj_cpf: '11.222.333/0001-81', endereco: 'Av. Brasil, 100', cep: '87000-000',
    representante: 'Maria Souza', cpf_representante: '529.982.247-25', cargo: 'Sócia', email: 'maria@bpo.co',
    testemunha1_nome: 'João Lima', testemunha1_cpf: '111.444.777-35', testemunha1_email: 'joao@x.co',
    testemunha2_nome: 'Ana Reis', testemunha2_cpf: '390.533.447-05', testemunha2_email: 'ana@alluz.tech',
    convite_id: 'cv-1', projeto_uuid: PROJETO, cliente_uuid: CLIENTE, docuseal_submission_id: '987', assinaturas_concluidas: 0, ...extra,
  };
}

const ROLES = [['DIVULGANTE', 'Maria Souza', 'cliente'], ['RECEPTORA', 'Alluz Tech', 'alluz'], ['TESTEMUNHA 1', 'João Lima', 'testemunha1'], ['TESTEMUNHA 2', 'Ana Reis', 'testemunha2']];

function webhook(i, o = {}) {
  const [role, name] = ROLES[i];
  const corpo = o.corpo ?? { event_type: 'form.completed', timestamp: '2026-10-04T18:00:00Z', data: { role, name, completed_at: `2026-10-04T18:0${i}:00Z`, submission: { id: 987 } } };
  const r = request(app).post('/api/integracoes/docuseal/webhook');
  if (o.segredo !== null) r.set('X-Docuseal-Secret', o.segredo ?? 'segredo-webhook');
  return r.send(corpo);
}

const eventos = (tipo) => db.st.outbox.filter((o) => JSON.parse(o.payload).tipo === tipo).map((o) => JSON.parse(o.payload));

beforeEach(() => {
  jest.clearAllMocks();
  db = criarFakeDb();
  db.st.convites.push({ id: 'cv-1', status: 'em_assinatura', projeto_uuid: PROJETO });
  db.st.clientes.push(ndaPJ());
  pool.query.mockImplementation(db.query);
  fetchMock.mockResolvedValue({ status: 200 });
});

describe('validação do webhook', () => {
  it('sem segredo, segredo errado ou segredo não configurado ⇒ 401 e nenhum evento', async () => {
    expect((await webhook(0, { segredo: null })).status).toBe(401);
    expect((await webhook(0, { segredo: 'errado' })).status).toBe(401);
    const antes = process.env.DOCUSEAL_WEBHOOK_SECRET;
    process.env.DOCUSEAL_WEBHOOK_SECRET = '';
    try { expect((await webhook(0, { segredo: '' })).status).toBe(401); } finally { process.env.DOCUSEAL_WEBHOOK_SECRET = antes; }
    expect(db.st.outbox).toHaveLength(0);
    expect(db.st.assinaturas).toHaveLength(0);
  });
  it('outros tipos de evento são ignorados com 200', async () => {
    const r = await webhook(0, { corpo: { event_type: 'form.viewed', data: {} } });
    expect(r.status).toBe(200);
    expect(db.st.outbox).toHaveLength(0);
  });
  it('NDA desconhecido, sem convite (legado) ou de convite cancelado não gera evento', async () => {
    expect((await webhook(0, { corpo: { event_type: 'form.completed', data: { role: 'DIVULGANTE', name: 'x', submission: { id: 1 } } } })).body.efeito).toBe('ignorado');
    db.st.clientes[0].convite_id = null;
    expect((await webhook(0)).body.efeito).toBe('ignorado');
    db.st.clientes[0].convite_id = 'cv-1';
    db.st.convites[0].status = 'cancelado';
    expect((await webhook(0)).body.efeito).toBe('ignorado');
    expect(db.st.outbox).toHaveLength(0);
  });
});

describe('assinaturas parciais', () => {
  it('1/4: emite nda.assinatura.parcial com papel, nome e contagem, e nada de nda.assinado', async () => {
    const r = await webhook(0);
    expect(r.body.efeito).toBe('parcial');
    const [ev] = eventos('nda.assinatura.parcial');
    expect(ev).toMatchObject({ versao: 1, origem: 'nda-form', projeto_uuid: PROJETO, cliente_uuid: CLIENTE });
    expect(ev.dados).toMatchObject({ nda_id: '5', papel: 'cliente', nome: 'Maria Souza', assinaturas_concluidas: 1, assinaturas_total: 4 });
    expect(ev.evento_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(eventos('nda.assinado')).toHaveLength(0);
  });

  it('todo evento emitido valida contra o envelope do contrato', async () => {
    for (let i = 0; i < 4; i++) await webhook(i);
    for (const o of db.st.outbox) expect(validarEnvelope(JSON.parse(o.payload))).toEqual([]);
  });

  it('reentrega da mesma assinatura não gera outro evento', async () => {
    await webhook(0);
    const r = await webhook(0);
    expect(r.status).toBe(200);
    expect(r.body.efeito).toBe('duplicado');
    expect(eventos('nda.assinatura.parcial')).toHaveLength(1);
    expect(db.st.assinaturas).toHaveLength(1);
  });
});

describe('4/4: nda.assinado', () => {
  it('1/4 → 4/4 gera exatamente um nda.assinado, mesmo com reentregas', async () => {
    for (let i = 0; i < 4; i++) await webhook(i);
    await webhook(3);
    await webhook(0);
    expect(eventos('nda.assinatura.parcial').map((e) => e.dados.assinaturas_concluidas)).toEqual([1, 2, 3, 4]);
    expect(eventos('nda.assinado')).toHaveLength(1);
  });

  it('assinaturas em ordem qualquer chegam a 4 do mesmo jeito', async () => {
    for (const i of [3, 1, 0, 2]) await webhook(i);
    expect(eventos('nda.assinado')).toHaveLength(1);
    expect(eventos('nda.assinatura.parcial').map((e) => e.dados.papel).sort()).toEqual(['alluz', 'cliente', 'testemunha1', 'testemunha2']);
  });

  it('vigente_ate = assinado_em + 1 ano; documento_id e dados_juridicos (cópia exata PJ)', async () => {
    for (let i = 0; i < 4; i++) await webhook(i);
    const [ev] = eventos('nda.assinado');
    expect(ev.dados.assinado_em).toBe('2026-10-04T18:03:00.000Z');
    expect(ev.dados.vigente_ate).toBe('2027-10-04');
    expect(ev.dados.documento_id).toBe('docuseal_987');
    expect(ev.dados.nda_id).toBe('5');
    expect(ev.dados.dados_juridicos).toEqual({
      tipo_pessoa: 'PJ', razao_social: 'BPO Exemplo LTDA', documento: '11.222.333/0001-81', endereco: 'Av. Brasil, 100', cep: '87000-000', email: 'maria@bpo.co',
      representante: { nome: 'Maria Souza', cpf: '529.982.247-25', cargo: 'Sócia' },
      testemunhas: [{ nome: 'João Lima', cpf: '111.444.777-35', email: 'joao@x.co' }, { nome: 'Ana Reis', cpf: '390.533.447-05', email: 'ana@alluz.tech' }],
    });
    expect(db.st.convites[0]).toMatchObject({ status: 'assinado', nda_id: '5' });
  });

  it('assinado_em é o da última assinatura mesmo com webhooks fora de ordem', async () => {
    for (const i of [3, 0, 1, 2]) await webhook(i); // a mais recente (i=3, 18:03) chegou primeiro
    expect(eventos('nda.assinado')[0].dados.assinado_em).toBe('2026-10-04T18:03:00.000Z');
  });

  it('PF: dados_juridicos sem representante, e o evento valida no schema', async () => {
    db.st.clientes[0] = ndaPJ({ tipo_pessoa: 'PF', razao_social: 'João da Silva', cnpj_cpf: '168.995.350-09', representante: null, cpf_representante: null, cargo: null });
    for (let i = 0; i < 4; i++) await webhook(i);
    const [ev] = eventos('nda.assinado');
    expect(ev.dados.dados_juridicos.tipo_pessoa).toBe('PF');
    expect(ev.dados.dados_juridicos).not.toHaveProperty('representante');
    expect(validarEnvelope(ev)).toEqual([]);
  });

  it('vigência cruza o ano bissexto sem estourar a data', () => {
    const { vigenteAte } = require('../src/services/assinaturasService');
    expect(vigenteAte('2027-01-10T12:00:00Z')).toBe('2028-01-10');
    expect(vigenteAte('2028-02-29T12:00:00Z')).toBe('2029-03-01');
  });
});

describe('entrega ao Deal', () => {
  it('envia assinado com Bearer, origem nda-form e HMAC do corpo bruto', async () => {
    await webhook(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://deal.test/api/integracoes/eventos');
    const ts = init.headers['X-Alluz-Timestamp'];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-nda-form', 'X-Alluz-Origem': 'nda-form', 'X-Alluz-Assinatura': assinar('hmac-nda-form', ts, init.body) });
    expect(db.st.outbox[0].status).toBe('enviado');
  });

  it('Deal fora do ar: o webhook responde 200 e o evento fica pendente na outbox', async () => {
    fetchMock.mockResolvedValue({ status: 503 });
    const r = await webhook(0);
    expect(r.status).toBe(200);
    expect(db.st.outbox[0].status).toBe('pendente');
  });

  it('a outbox grava antes de enviar (evento existe mesmo se o envio lançar)', async () => {
    fetchMock.mockRejectedValue(new Error('rede'));
    expect((await webhook(0)).status).toBe(200);
    expect(db.st.outbox).toHaveLength(1);
  });
});
