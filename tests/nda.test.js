const request = require('supertest');

jest.mock('../src/db/connection');
jest.mock('../src/services/pdfService');
jest.mock('../src/services/emailService');
jest.mock('../src/services/docusealService');

const pool = require('../src/db/connection');
const { gerarPDF } = require('../src/services/pdfService');
const { enviarNDA, notificarInterno, enviarLinkAssinatura } = require('../src/services/emailService');
const { criarSubmission } = require('../src/services/docusealService');

process.env.JWT_SECRET = 'test-secret';

const app = require('../src/app');

const dadosPJ = {
  tipo_pessoa: 'PJ',
  razao_social: 'Empresa Teste LTDA',
  cnpj_cpf: '11.222.333/0001-81',
  endereco: 'Rua Teste, 123',
  cep: '01310-100',
  representante: 'João Silva',
  cpf_representante: '529.982.247-25',
  cargo: 'Diretor',
  testemunha1_nome: 'Testemunha Um',
  testemunha1_cpf: '111.444.777-35',
  testemunha1_email: 'testemunha1@email.com',
  testemunha2_nome: 'Testemunha Dois',
  testemunha2_cpf: '390.533.447-05',
  testemunha2_email: 'testemunha2@email.com',
  email: 'empresa@email.com',
};

const dadosPF = {
  tipo_pessoa: 'PF',
  razao_social: 'João da Silva',
  cnpj_cpf: '168.995.350-09',
  endereco: 'Rua Teste, 456',
  cep: '01310-200',
  testemunha1_nome: 'Testemunha Um',
  testemunha1_cpf: '111.444.777-35',
  testemunha1_email: 'testemunha1@email.com',
  testemunha2_nome: 'Testemunha Dois',
  testemunha2_cpf: '390.533.447-05',
  testemunha2_email: 'testemunha2@email.com',
  email: 'joao@email.com',
};

describe('POST /api/gerar-nda — validação', () => {
  it('retorna 400 se campo obrigatório estiver ausente', async () => {
    const { email: _omit, ...semEmail } = dadosPJ;
    const res = await request(app).post('/api/gerar-nda').send(semEmail);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('retorna 400 se PJ sem representante', async () => {
    const { representante: _r, cpf_representante: _c, cargo: _ca, ...semRepresentante } = dadosPJ;
    const res = await request(app).post('/api/gerar-nda').send(semRepresentante);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/representante/i);
  });

  it('aceita PF sem representante', async () => {
    delete process.env.DOCUSEAL_API_KEY;
    pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
    gerarPDF.mockResolvedValueOnce(Buffer.from('pdf'));
    enviarNDA.mockResolvedValueOnce();

    const res = await request(app).post('/api/gerar-nda').send(dadosPF);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/gerar-nda — fluxo sem DocuSeal', () => {
  beforeEach(() => {
    delete process.env.DOCUSEAL_API_KEY;
  });

  it('salva no banco, gera PDF e envia email', async () => {
    pool.query.mockResolvedValueOnce([{ insertId: 42 }]);
    gerarPDF.mockResolvedValueOnce(Buffer.from('pdf-content'));
    enviarNDA.mockResolvedValueOnce();

    const res = await request(app).post('/api/gerar-nda').send(dadosPJ);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(gerarPDF).toHaveBeenCalledTimes(1);
    expect(enviarNDA).toHaveBeenCalledTimes(1);
  });

  it('aplica valores fixos (prazo_vigencia, valor_multa) sem aceitar do body', async () => {
    pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
    gerarPDF.mockResolvedValueOnce(Buffer.from('pdf'));
    enviarNDA.mockResolvedValueOnce();

    const dadosComValoresAlterados = { ...dadosPJ, prazo_vigencia: '10 anos', valor_multa: 999 };
    await request(app).post('/api/gerar-nda').send(dadosComValoresAlterados);

    const chamadaInsert = pool.query.mock.calls[0];
    const valores = chamadaInsert[1];
    // prazo_vigencia é o 9º parâmetro (índice 8), valor_multa é o 10º (índice 9)
    expect(valores[8]).toBe('1 (um) ano');
    expect(valores[9]).toBe(20000);
  });
});

describe('POST /api/gerar-nda — fluxo com DocuSeal', () => {
  beforeEach(() => {
    process.env.DOCUSEAL_API_KEY = 'fake-key';
  });

  afterEach(() => {
    delete process.env.DOCUSEAL_API_KEY;
  });

  it('cria submission e envia links por email', async () => {
    pool.query
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([{}]); // UPDATE docuseal_submission_id

    gerarPDF.mockResolvedValueOnce(Buffer.from('pdf'));
    criarSubmission.mockResolvedValueOnce({
      submissionId: 'sub-123',
      signatarios: [
        { nome: 'Empresa Teste', email: 'empresa@email.com', link: 'https://docuseal.com/s/abc' },
        { nome: 'Alluz Tech',    email: 'nda@alluz.tech',   link: 'https://docuseal.com/s/def' },
      ],
    });
    enviarLinkAssinatura.mockResolvedValue();

    const res = await request(app).post('/api/gerar-nda').send(dadosPJ);

    expect(res.status).toBe(200);
    expect(criarSubmission).toHaveBeenCalledTimes(1);
    expect(enviarLinkAssinatura).toHaveBeenCalledTimes(2);
    // submission_id salvo no banco
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE clientes SET docuseal_submission_id'),
      ['sub-123', 5]
    );
  });

  it('continua mesmo se envio de email para um signatário falhar', async () => {
    pool.query
      .mockResolvedValueOnce([{ insertId: 6 }])
      .mockResolvedValueOnce([{}]);

    gerarPDF.mockResolvedValueOnce(Buffer.from('pdf'));
    criarSubmission.mockResolvedValueOnce({
      submissionId: 'sub-456',
      signatarios: [
        { nome: 'Empresa', email: 'empresa@email.com', link: 'https://docuseal.com/s/abc' },
        { nome: 'Alluz',   email: 'nda@alluz.tech',   link: 'https://docuseal.com/s/def' },
      ],
    });
    enviarLinkAssinatura
      .mockRejectedValueOnce(new Error('SMTP error'))
      .mockResolvedValueOnce();

    const res = await request(app).post('/api/gerar-nda').send(dadosPJ);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
