const request = require('supertest');
const fs = require('fs');
const path = require('path');

jest.mock('../src/db/connection');
jest.mock('../src/services/pdfService');
jest.mock('../src/services/emailService');
jest.mock('../src/services/docusealService');

process.env.JWT_SECRET = 'test-secret';
process.env.INTEGRATION_DEAL_TOKEN = 'tok-deal-teste';
process.env.INTEGRATION_DEAL_HMAC = 'hmac-deal-atual';
process.env.INTEGRATION_DEAL_HMAC_PREVIOUS = 'hmac-deal-anterior';
process.env.NDA_PUBLIC_URL = 'https://nda.alluz.tech';

const pool = require('../src/db/connection');
const { gerarPDF } = require('../src/services/pdfService');
const { criarSubmission, arquivarSubmission } = require('../src/services/docusealService');
const { enviarLinkAssinatura } = require('../src/services/emailService');
const { assinar } = require('../src/lib/integracaoAuth');
const { hashToken } = require('../src/services/convitesService');
const { criarFakeDb } = require('./helpers/fakeDb');
const app = require('../src/app');

const comando = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/exemplos/comandos/nda.convite.criar.json'), 'utf8'));
const agora = () => Math.floor(Date.now() / 1000);
let db;

function enviar(corpo, o = {}) {
  const bruto = o.raw ?? JSON.stringify(corpo);
  const ts = String(o.ts ?? agora());
  const r = request(app).post('/api/integracoes/convites')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${o.token ?? process.env.INTEGRATION_DEAL_TOKEN}`)
    .set('X-Alluz-Origem', o.origem ?? 'deal')
    .set('X-Alluz-Timestamp', ts)
    .set('X-Alluz-Assinatura', o.assinatura ?? assinar(o.segredo ?? process.env.INTEGRATION_DEAL_HMAC, ts, bruto));
  if (o.chave) r.set('Idempotency-Key', o.chave);
  return r.send(bruto);
}

const tokenDoLink = (link) => link.split('/c/')[1];

beforeEach(() => {
  jest.clearAllMocks();
  db = criarFakeDb();
  pool.query.mockImplementation(db.query);
  process.env.LEGACY_NDA_FORM_ENABLED = 'true';
});

describe('autenticação do comando', () => {
  it('assinatura válida cria o convite (201 com convite_id e link)', async () => {
    const res = await enviar(comando);
    expect(res.status).toBe(201);
    expect(res.body.convite_id).toBeTruthy();
    expect(res.body.link).toMatch(/^https:\/\/nda\.alluz\.tech\/c\/[A-Za-z0-9_-]{43,}$/);
  });
  it('segredo anterior (rotação) também é aceito', async () => {
    expect((await enviar(comando, { segredo: 'hmac-deal-anterior' })).status).toBe(201);
  });
  it('assinatura inválida ⇒ 401 e nada gravado', async () => {
    const res = await enviar(comando, { segredo: 'outro' });
    expect(res.status).toBe(401);
    expect(db.st.convites).toHaveLength(0);
  });
  it('corpo alterado depois de assinar ⇒ 401', async () => {
    const bruto = JSON.stringify(comando);
    const res = await enviar(comando, { raw: bruto.replace('Maria', 'Mario'), assinatura: assinar(process.env.INTEGRATION_DEAL_HMAC, String(agora()), bruto) });
    expect(res.status).toBe(401);
  });
  it('timestamp fora da janela de 300 s (passado e futuro) ⇒ 401', async () => {
    expect((await enviar(comando, { ts: agora() - 301 })).status).toBe(401);
    expect((await enviar(comando, { ts: agora() + 301 })).status).toBe(401);
  });
  it('token errado, origem desconhecida ou sem credencial ⇒ 401', async () => {
    expect((await enviar(comando, { token: 'errado' })).status).toBe(401);
    expect((await enviar(comando, { origem: 'aurora' })).status).toBe(401);
    const antes = process.env.INTEGRATION_DEAL_HMAC;
    process.env.INTEGRATION_DEAL_HMAC = '';
    try { expect((await enviar(comando, { segredo: '' })).status).toBe(401); } finally { process.env.INTEGRATION_DEAL_HMAC = antes; }
  });
  it('segredo anterior vazio não aceita assinatura feita com segredo vazio', async () => {
    const antes = process.env.INTEGRATION_DEAL_HMAC_PREVIOUS;
    process.env.INTEGRATION_DEAL_HMAC_PREVIOUS = '';
    try { expect((await enviar(comando, { segredo: '' })).status).toBe(401); } finally { process.env.INTEGRATION_DEAL_HMAC_PREVIOUS = antes; }
  });
});

describe('validação do comando', () => {
  it('campo ausente, extra ou e-mail inválido ⇒ 422', async () => {
    const { empresa: _e, ...semEmpresa } = comando;
    expect((await enviar(semEmpresa)).status).toBe(422);
    expect((await enviar({ ...comando, extra: 1 })).status).toBe(422);
    expect((await enviar({ ...comando, email: 'x' })).status).toBe(422);
    expect((await enviar({ ...comando, projeto_uuid: 'nao-e-uuid' })).status).toBe(422);
    expect(db.st.convites).toHaveLength(0);
  });
  it('JSON malformado ⇒ 4xx sem criar convite', async () => {
    const res = await enviar(null, { raw: '{nao-json', assinatura: 'sha256=x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(db.st.convites).toHaveLength(0);
  });
});

describe('convite: token e idempotência', () => {
  it('guarda só o hash do token (nunca o token nem o link)', async () => {
    const res = await enviar(comando);
    const token = tokenDoLink(res.body.link);
    expect(db.st.convites[0].token_hash).toBe(hashToken(token));
    expect(JSON.stringify(db.st.convites)).not.toContain(token);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
  });
  it('mesma Idempotency-Key devolve a resposta original, sem criar outro convite', async () => {
    const chave = `${comando.projeto_uuid}:nda.convite.criar:1`;
    const a = await enviar(comando, { chave });
    const b = await enviar(comando, { chave });
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect(db.st.convites).toHaveLength(1);
  });
  it('duas chamadas simultâneas com a mesma chave: mesmo link, um só convite, e o link continua abrindo o formulário', async () => {
    // Criação lenta: a segunda chamada chega enquanto a primeira ainda está criando o convite (a corrida real).
    pool.query.mockImplementation(async (sql, p) => {
      if (/^\s*INSERT INTO convites/.test(sql)) await new Promise((r) => setTimeout(r, 80));
      return db.query(sql, p);
    });
    const chave = `${comando.projeto_uuid}:nda.convite.criar:1`;
    const [a, b] = await Promise.all([enviar(comando, { chave }), enviar(comando, { chave })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(db.st.convites).toHaveLength(1);
    expect(db.st.convites[0].status).toBe('pendente'); // o perdedor não cancelou o convite do vencedor
    const page = await request(app).get(`/c/${tokenDoLink(a.body.link)}`);
    expect(page.status).toBe(200);
    expect((await request(app).get(`/api/convites/${tokenDoLink(b.body.link)}`)).status).toBe(200);
  });

  it('se o vencedor falha, a chave é liberada e o retry da mesma chave funciona', async () => {
    const chave = 'k:falha';
    pool.query.mockImplementationOnce(async (sql, p) => db.query(sql, p)); // reserva
    pool.query.mockImplementationOnce(async () => { throw new Error('banco caiu'); }); // criarConvite (SELECT abertos)
    const ruim = await enviar(comando, { chave });
    expect(ruim.status).toBe(500);
    expect(db.st.idem[chave]).toBeUndefined();
    pool.query.mockImplementation(db.query);
    const ok = await enviar(comando, { chave });
    expect(ok.status).toBe(201);
  });

  describe('reserva da Idempotency-Key: 503 + Retry-After e reserva abandonada', () => {
    const opcoes = require('../src/routes/integracoes').opcoes;
    const original = { ...opcoes };
    afterEach(() => Object.assign(opcoes, original));

    it('(a) perdedor cujo vencedor falha e libera a chave recebe 503 com Retry-After (nunca 409), e o retry funciona', async () => {
      const chave = 'k:vencedor-falha';
      let primeira = true;
      pool.query.mockImplementation(async (sql, p) => {
        // criarConvite do vencedor: demora e falha, enquanto o perdedor já está esperando.
        if (primeira && /FROM convites c LEFT JOIN clientes cl/.test(sql)) {
          primeira = false;
          await new Promise((r) => setTimeout(r, 120));
          throw new Error('banco caiu');
        }
        return db.query(sql, p);
      });
      const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
      const [a, b] = await Promise.all([enviar(comando, { chave }), enviar(comando, { chave })]);
      erro.mockRestore();
      const [vencedor, perdedor] = a.status === 500 ? [a, b] : [b, a];
      expect(vencedor.status).toBe(500);
      expect(perdedor.status).toBe(503);
      expect(perdedor.headers['retry-after']).toBe('5');
      expect(db.st.convites).toHaveLength(0);

      pool.query.mockImplementation(db.query);
      expect((await enviar(comando, { chave })).status).toBe(201); // o Deal retenta com a mesma chave
    });

    it('(b) reserva com status 0 criada há 5 minutos é considerada abandonada: assumida, convite criado (201)', async () => {
      const chave = 'k:abandonada';
      db.st.idem[chave] = { status: 0, resposta: '{}', criado_em: new Date(Date.now() - 5 * 60000) };
      const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const r = await enviar(comando, { chave });
      aviso.mockRestore();
      expect(r.status).toBe(201);
      expect(db.st.convites).toHaveLength(1);
      expect(db.st.idem[chave].status).toBe(201);
      // e a repetição devolve a resposta gravada, sem criar outro convite
      expect((await enviar(comando, { chave })).body).toEqual(r.body);
      expect(db.st.convites).toHaveLength(1);
    });

    it('(b2) dois processos disputando a reserva abandonada: só um assume e cria o convite', async () => {
      const chave = 'k:abandonada-disputa';
      db.st.idem[chave] = { status: 0, resposta: '{}', criado_em: new Date(Date.now() - 5 * 60000) };
      opcoes.esperaMs = 300;
      const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});
      pool.query.mockImplementation(async (sql, p) => {
        if (/^\s*INSERT INTO convites/.test(sql)) await new Promise((r) => setTimeout(r, 60));
        return db.query(sql, p);
      });
      const [a, b] = await Promise.all([enviar(comando, { chave }), enviar(comando, { chave })]);
      aviso.mockRestore();
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.body).toEqual(a.body);
      expect(db.st.convites).toHaveLength(1);
    });

    it('(c) reserva recente (status 0) continua devolvendo 503 depois da espera, sem criar convite', async () => {
      const chave = 'k:em-andamento';
      db.st.idem[chave] = { status: 0, resposta: '{}', criado_em: new Date() };
      opcoes.esperaMs = 150;
      const r = await enviar(comando, { chave });
      expect(r.status).toBe(503);
      expect(r.headers['retry-after']).toBe('5');
      expect(db.st.convites).toHaveLength(0);
      expect(db.st.idem[chave].status).toBe(0); // reserva alheia intacta
    });
  });

  it('reenvio (chave nova) invalida o convite anterior', async () => {
    const a = await enviar(comando, { chave: 'k:1' });
    const b = await enviar(comando, { chave: 'k:2' });
    expect(b.body.link).not.toBe(a.body.link);
    expect(db.st.convites.map((c) => c.status)).toEqual(['cancelado', 'pendente']);
    expect((await request(app).get(`/api/convites/${tokenDoLink(a.body.link)}`)).status).toBe(404);
    expect((await request(app).get(`/api/convites/${tokenDoLink(b.body.link)}`)).status).toBe(200);
  });
  it('reenvio com assinatura em andamento arquiva a submissão antiga no DocuSeal', async () => {
    const a = await enviar(comando, { chave: 'k:1' });
    db.st.convites[0].status = 'em_assinatura';
    db.st.clientes.push({ id: 9, convite_id: db.st.convites[0].id, docuseal_submission_id: '555' });
    await enviar(comando, { chave: 'k:2' });
    expect(arquivarSubmission).toHaveBeenCalledWith('555');
    expect(a.status).toBe(201);
  });
});

describe('formulário por convite', () => {
  async function convite() { return tokenDoLink((await enviar(comando)).body.link); }

  it('GET /c/<token> abre o formulário e GET /api/convites/<token> devolve e-mail, empresa e responsável', async () => {
    const token = await convite();
    const page = await request(app).get(`/c/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const api = await request(app).get(`/api/convites/${token}`);
    expect(api.body).toEqual({ email: comando.email, empresa: comando.empresa, responsavel: comando.responsavel });
  });

  it('token inexistente, expirado, usado e cancelado dão a MESMA resposta neutra', async () => {
    const token = await convite();
    const inexistente = await request(app).get(`/c/${'x'.repeat(43)}`);

    db.st.convites[0].expira_em = new Date(Date.now() - 1000);
    const expirado = await request(app).get(`/c/${token}`);
    db.st.convites[0].expira_em = new Date(Date.now() + 1e6);

    db.st.convites[0].status = 'em_assinatura';
    const usado = await request(app).get(`/c/${token}`);
    db.st.convites[0].status = 'cancelado';
    const cancelado = await request(app).get(`/c/${token}`);

    for (const r of [expirado, usado, cancelado]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(inexistente.text);
    }
    const apis = await Promise.all([`x`.repeat(43), token].map((t) => request(app).get(`/api/convites/${t}`)));
    expect(apis[0].status).toBe(404);
    expect(apis[1].body).toEqual(apis[0].body);
  });

  describe('POST /api/gerar-nda com convite', () => {
    const dadosPJ = {
      tipo_pessoa: 'PJ', razao_social: 'BPO Exemplo LTDA', cnpj_cpf: '11.222.333/0001-81', endereco: 'Av. Brasil, 100', cep: '87000-000',
      representante: 'Maria Souza', cpf_representante: '529.982.247-25', cargo: 'Sócia',
      testemunha1_nome: 'João Lima', testemunha1_cpf: '111.444.777-35', testemunha1_email: 'joao@x.co',
      testemunha2_nome: 'Ana Reis', testemunha2_cpf: '390.533.447-05', testemunha2_email: 'ana@alluz.tech',
    };
    beforeEach(() => {
      process.env.DOCUSEAL_API_KEY = 'k';
      gerarPDF.mockResolvedValue(Buffer.from('pdf'));
      criarSubmission.mockResolvedValue({ submissionId: 777, signatarios: [{ nome: 'a', email: 'a@a.co', link: 'l1' }] });
      enviarLinkAssinatura.mockResolvedValue();
    });
    afterEach(() => { delete process.env.DOCUSEAL_API_KEY; });

    it('e-mail adulterado no POST é ignorado: vale o do convite', async () => {
      const token = await convite();
      const res = await request(app).post('/api/gerar-nda').send({ ...dadosPJ, email: 'invasor@evil.com', convite_token: token });
      expect(res.status).toBe(200);
      expect(gerarPDF.mock.calls[0][0].email).toBe(comando.email);
      expect(criarSubmission.mock.calls[0][0].email).toBe(comando.email);
      expect(db.st.clientes[0].email).toBe(comando.email);
      expect(db.st.clientes[0]).toMatchObject({ projeto_uuid: comando.projeto_uuid, cliente_uuid: comando.cliente_uuid, convite_id: db.st.convites[0].id });
      expect(db.st.convites[0].status).toBe('em_assinatura');
    });

    it('convite já usado não gera outro NDA (reuso ⇒ 404 neutro)', async () => {
      const token = await convite();
      expect((await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: token })).status).toBe(200);
      const outra = await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: token });
      expect(outra.status).toBe(404);
      expect(db.st.clientes).toHaveLength(1);
    });

    describe('falha no e-mail do link de assinatura', () => {
      const quatro = [
        { nome: 'Maria', email: 'maria@bpoexemplo.com.br', link: 'l1' }, { nome: 'Alluz', email: 'nda@alluz.tech', link: 'l2' },
        { nome: 'João', email: 'joao@x.co', link: 'l3' }, { nome: 'Ana', email: 'ana@alluz.tech', link: 'l4' },
      ];
      beforeEach(() => criarSubmission.mockResolvedValue({ submissionId: 777, signatarios: quatro }));

      it('falhou para o cliente: convites.falha_email = 1, log com convite_id e SEM e-mail; o NDA segue (200)', async () => {
        const token = await convite();
        const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        enviarLinkAssinatura.mockImplementation(async (_n, email) => { if (email === quatro[0].email) throw new Error('smtp 550'); });
        const res = await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: token });
        const saida = JSON.stringify([...erro.mock.calls, ...log.mock.calls]);
        erro.mockRestore(); log.mockRestore();
        expect(res.status).toBe(200);
        expect(db.st.convites[0].falha_email).toBe(1);
        expect(saida).toContain(db.st.convites[0].id);
        expect(saida).not.toContain('@'); // nenhum e-mail em log
      });

      it('falhou só para uma testemunha: não marca falha_email (o cliente recebeu o link)', async () => {
        const token = await convite();
        const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
        enviarLinkAssinatura.mockImplementation(async (_n, email) => { if (email === quatro[2].email) throw new Error('smtp'); });
        await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: token });
        erro.mockRestore();
        expect(db.st.convites[0].falha_email).toBeUndefined();
      });

      it('tudo certo: nada marcado', async () => {
        const token = await convite();
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        enviarLinkAssinatura.mockResolvedValue();
        await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: token });
        log.mockRestore();
        expect(db.st.convites[0].falha_email).toBeUndefined();
      });
    });

    it('token inválido ⇒ 404 neutro, sem consultar PDF/DocuSeal', async () => {
      const res = await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: 'z'.repeat(43), email: 'a@b.co' });
      expect(res.status).toBe(404);
      expect(gerarPDF).not.toHaveBeenCalled();
    });

    it('dados inválidos (CPF) ⇒ 400 e o convite continua utilizável', async () => {
      const token = await convite();
      const res = await request(app).post('/api/gerar-nda').send({ ...dadosPJ, cpf_representante: '111.111.111-11', convite_token: token });
      expect(res.status).toBe(400);
      expect(db.st.convites[0].status).toBe('pendente');
    });

    it('falha no DocuSeal devolve o convite a pendente e remove o registro órfão', async () => {
      const token = await convite();
      criarSubmission.mockRejectedValueOnce(new Error('docuseal fora'));
      const res = await request(app).post('/api/gerar-nda').send({ ...dadosPJ, convite_token: token });
      expect(res.status).toBe(500);
      expect(db.st.convites[0].status).toBe('pendente');
      expect(db.st.clientes).toHaveLength(0);
    });
  });
});

describe('formulário legado (LEGACY_NDA_FORM_ENABLED)', () => {
  const dadosPF = {
    tipo_pessoa: 'PF', razao_social: 'João da Silva', cnpj_cpf: '168.995.350-09', endereco: 'Rua A', cep: '01310-200', email: 'joao@x.co',
    testemunha1_nome: 'T1', testemunha1_cpf: '111.444.777-35', testemunha1_email: 't1@x.co',
    testemunha2_nome: 'T2', testemunha2_cpf: '390.533.447-05', testemunha2_email: 't2@x.co',
  };
  it('ligado (padrão): POST sem token continua funcionando', async () => {
    delete process.env.DOCUSEAL_API_KEY;
    gerarPDF.mockResolvedValue(Buffer.from('pdf'));
    expect((await request(app).post('/api/gerar-nda').send(dadosPF)).status).toBe(200);
  });
  it('desligado: POST sem token ⇒ 403 e a raiz mostra a página neutra', async () => {
    process.env.LEGACY_NDA_FORM_ENABLED = 'false';
    expect((await request(app).post('/api/gerar-nda').send(dadosPF)).status).toBe(403);
    expect((await request(app).get('/')).status).toBe(404);
    expect(db.st.clientes).toHaveLength(0);
  });
});
