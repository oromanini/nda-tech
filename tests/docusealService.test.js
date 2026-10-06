jest.mock('https');

const https = require('https');
const { EventEmitter } = require('events');

const { criarSubmission, arquivarSubmission, SIGNATURE_FIELDS } = require('../src/services/docusealService');

function mockHttpsRequest(statusCode, responseBody) {
  const resEmitter = new EventEmitter();
  resEmitter.statusCode = statusCode;

  const reqEmitter = new EventEmitter();
  reqEmitter.write = jest.fn();
  reqEmitter.end = jest.fn().mockImplementation(() => {
    resEmitter.emit('data', JSON.stringify(responseBody));
    resEmitter.emit('end');
  });

  https.request.mockImplementation((opts, cb) => {
    cb(resEmitter);
    return reqEmitter;
  });
}

function mockHttpsSequence(responses) {
  let index = 0;
  https.request.mockImplementation((opts, cb) => {
    const { statusCode, body } = responses[index] || responses[responses.length - 1];
    index++;

    const resEmitter = new EventEmitter();
    resEmitter.statusCode = statusCode;

    const reqEmitter = new EventEmitter();
    reqEmitter.write = jest.fn();
    reqEmitter.end = jest.fn().mockImplementation(() => {
      resEmitter.emit('data', JSON.stringify(body));
      resEmitter.emit('end');
    });

    cb(resEmitter);
    return reqEmitter;
  });
}

const dadosBase = {
  razao_social: 'Empresa Teste',
  email: 'empresa@teste.com',
  testemunha1_nome: 'Testemunha 1',
  testemunha1_email: 'test1@email.com',
  testemunha2_nome: 'Testemunha 2',
  testemunha2_email: 'test2@email.com',
};

// Resposta do POST /submissions/pdf conforme documentação oficial:
// objeto único com id e submitters (sem name, com embed_src)
const respostaSubmissionPdf = {
  id: 'sub-1',
  status: 'pending',
  submitters: [
    { email: 'empresa@teste.com', slug: 'abc', embed_src: 'https://docuseal.com/s/abc' },
    { email: 'nda@alluz.tech',    slug: 'def', embed_src: 'https://docuseal.com/s/def' },
    { email: 'test1@email.com',   slug: 'ghi', embed_src: 'https://docuseal.com/s/ghi' },
    { email: 'test2@email.com',   slug: 'jkl', embed_src: 'https://docuseal.com/s/jkl' },
  ],
};

// Resposta do POST /submissions (fallback): array com submission_id, name, email, slug
const respostaSubmissionTemplate = [
  { submission_id: 'sub-1', name: 'Empresa Teste', email: 'empresa@teste.com', slug: 'abc' },
  { submission_id: 'sub-1', name: 'Alluz Tech',    email: 'nda@alluz.tech',   slug: 'def' },
  { submission_id: 'sub-1', name: 'Testemunha 1',  email: 'test1@email.com',  slug: 'ghi' },
  { submission_id: 'sub-1', name: 'Testemunha 2',  email: 'test2@email.com',  slug: 'jkl' },
];

beforeEach(() => {
  process.env.DOCUSEAL_API_KEY = 'fake-key';
});

describe('criarSubmission — sem pdfBuffer (fallback template estático)', () => {
  it('usa POST /submissions com template_id fixo', async () => {
    mockHttpsRequest(200, respostaSubmissionTemplate);

    const result = await criarSubmission(dadosBase);

    const bodyStr = https.request.mock.results[0].value.write.mock.calls[0][0];
    const body = JSON.parse(bodyStr);
    expect(https.request.mock.calls[0][0].path).toBe('/submissions');
    expect(body.template_id).toBe(4380107);
    expect(result.submissionId).toBe('sub-1');
    expect(result.signatarios).toHaveLength(4);
  });

  it('envia 4 submitters com os roles corretos', async () => {
    mockHttpsRequest(200, respostaSubmissionTemplate);

    await criarSubmission(dadosBase);

    const bodyStr = https.request.mock.results[0].value.write.mock.calls[0][0];
    const body = JSON.parse(bodyStr);
    expect(body.submitters).toHaveLength(4);
    expect(body.submitters[0].role).toBe('DIVULGANTE');
    expect(body.submitters[1].role).toBe('RECEPTORA');
    expect(body.submitters[2].role).toBe('TESTEMUNHA 1');
    expect(body.submitters[3].role).toBe('TESTEMUNHA 2');
    expect(body.send_email).toBe(false);
  });

  it('PJ assina pelo representante legal', async () => {
    mockHttpsRequest(200, respostaSubmissionTemplate);

    await criarSubmission({ ...dadosBase, tipo_pessoa: 'PJ', razao_social: 'Empresa LTDA', representante: 'Rep Legal' });

    const bodyStr = https.request.mock.results[0].value.write.mock.calls[0][0];
    const body = JSON.parse(bodyStr);
    expect(body.submitters[0].name).toBe('Rep Legal');
  });

  it('lança erro se a API retornar status 4xx', async () => {
    mockHttpsRequest(401, { error: 'unauthorized' });
    await expect(criarSubmission(dadosBase)).rejects.toThrow('DocuSeal 401');
  });

  it('lança erro se a resposta não for JSON válido', async () => {
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = jest.fn();
    reqEmitter.end = jest.fn().mockImplementation(() => {
      resEmitter.emit('data', 'resposta-invalida-nao-json');
      resEmitter.emit('end');
    });
    https.request.mockImplementation((opts, cb) => { cb(resEmitter); return reqEmitter; });

    await expect(criarSubmission(dadosBase)).rejects.toThrow('DocuSeal parse error');
  });

  it('retorna submissionId null se lista estiver vazia', async () => {
    mockHttpsRequest(200, []);
    const result = await criarSubmission(dadosBase);
    expect(result.submissionId).toBeNull();
  });
});

describe('criarSubmission — com pdfBuffer (POST /submissions/pdf)', () => {
  const fakePdf = Buffer.from('%PDF-1.4\n/Type /Page\n%%EOF');

  it('usa POST /submissions/pdf e retorna submissionId e signatarios', async () => {
    mockHttpsSequence([
      { statusCode: 200, body: { fields: [] } },       // GET /templates/:id
      { statusCode: 200, body: respostaSubmissionPdf }, // POST /submissions/pdf
    ]);

    const result = await criarSubmission(dadosBase, fakePdf);

    const calls = https.request.mock.calls;
    expect(calls.find(([o]) => o.path === '/submissions/pdf')).toBeDefined();
    expect(result.submissionId).toBe('sub-1');
    expect(result.signatarios).toHaveLength(4);
  });

  it('inclui o PDF em base64 e send_email: false no payload', async () => {
    mockHttpsSequence([
      { statusCode: 200, body: { fields: [] } },
      { statusCode: 200, body: respostaSubmissionPdf },
    ]);

    await criarSubmission(dadosBase, fakePdf);

    const calls = https.request.mock.calls;
    const idx = calls.findIndex(([o]) => o.path === '/submissions/pdf');
    const body = JSON.parse(https.request.mock.results[idx].value.write.mock.calls[0][0]);
    expect(body.documents[0].file).toBe(fakePdf.toString('base64'));
    expect(body.send_email).toBe(false);
  });

  it('envia 4 submitters com os roles corretos', async () => {
    mockHttpsSequence([
      { statusCode: 200, body: { fields: [] } },
      { statusCode: 200, body: respostaSubmissionPdf },
    ]);

    await criarSubmission(dadosBase, fakePdf);

    const calls = https.request.mock.calls;
    const idx = calls.findIndex(([o]) => o.path === '/submissions/pdf');
    const { submitters } = JSON.parse(https.request.mock.results[idx].value.write.mock.calls[0][0]);
    expect(submitters[0].role).toBe('DIVULGANTE');
    expect(submitters[1].role).toBe('RECEPTORA');
    expect(submitters[2].role).toBe('TESTEMUNHA 1');
    expect(submitters[3].role).toBe('TESTEMUNHA 2');
  });

  it('resolve links pelo embed_src da resposta, cruzando por email', async () => {
    mockHttpsSequence([
      { statusCode: 200, body: { fields: [] } },
      { statusCode: 200, body: respostaSubmissionPdf },
    ]);

    const result = await criarSubmission(dadosBase, fakePdf);

    expect(result.signatarios[0].link).toBe('https://docuseal.com/s/abc');
    expect(result.signatarios[0].nome).toBe('Empresa Teste');
    expect(result.signatarios[1].link).toBe('https://docuseal.com/s/def');
    expect(result.signatarios[2].link).toBe('https://docuseal.com/s/ghi');
    expect(result.signatarios[3].link).toBe('https://docuseal.com/s/jkl');
  });

  async function camposEnviados(camposTemplate, pdf = fakePdf) {
    mockHttpsSequence([
      { statusCode: 200, body: { fields: camposTemplate } },
      { statusCode: 200, body: respostaSubmissionPdf },
    ]);
    await criarSubmission(dadosBase, pdf);
    const idx = https.request.mock.calls.findIndex(([o]) => o.path === '/submissions/pdf');
    return JSON.parse(https.request.mock.results[idx].value.write.mock.calls[0][0]).documents[0].fields;
  }

  it('assinaturas: 4 campos signature (um por signatário) na última página do PDF, 1-indexed', async () => {
    const pdf6 = Buffer.from('%PDF-1.4\n' + '/Type /Page\n'.repeat(6) + '/Type /Pages\n%%EOF'); // 6 páginas
    const fields = (await camposEnviados([], pdf6)).filter((f) => f.type === 'signature');
    expect(fields.map((f) => f.role)).toEqual(['DIVULGANTE', 'RECEPTORA', 'TESTEMUNHA 1', 'TESTEMUNHA 2']);
    for (const f of fields) {
      expect(f.required).toBe(true);
      expect(f.areas).toHaveLength(1);
      expect(f.areas[0].page).toBe(6);
      for (const k of ['x', 'y', 'w', 'h']) expect(f.areas[0][k]).toBeGreaterThan(0);
      expect(f.areas[0].x + f.areas[0].w).toBeLessThanOrEqual(1);
      expect(f.areas[0].y + f.areas[0].h).toBeLessThanOrEqual(1);
    }
  });

  it('assinaturas não se sobrepõem e seguem o layout (cliente/Alluz na linha 1, testemunhas na linha 2)', () => {
    const [cli, alz, t1, t2] = SIGNATURE_FIELDS;
    expect(cli.y).toBe(alz.y);
    expect(t1.y).toBe(t2.y);
    expect(t1.y).toBeGreaterThan(cli.y + cli.h);
    expect(cli.x + cli.w).toBeLessThan(alz.x);
    expect(t1.x + t1.w).toBeLessThan(t2.x);
  });

  it('ignora as assinaturas do template base (coordenadas antigas) e usa as calibradas', async () => {
    const antigas = [
      { name: 'ASSINATURA DIVULGANTE', type: 'signature', areas: [{ x: 0.01, y: 0.99, w: 0.01, h: 0.01, page: 2, attachment_uuid: 'u' }] },
      { name: 'ASSINATURA T2',         type: 'signature', areas: [{ x: 0.01, y: 0.99, w: 0.01, h: 0.01, page: 2, attachment_uuid: 'u' }] },
    ];
    const fields = await camposEnviados(antigas);
    const sig = fields.filter((f) => f.type === 'signature');
    expect(sig).toHaveLength(4); // nenhuma duplicada
    expect(sig.find((f) => f.role === 'DIVULGANTE').areas[0].y).toBe(SIGNATURE_FIELDS[0].y);
    expect(JSON.stringify(fields)).not.toContain('0.99');
  });

  it('mantém campos que não são assinatura (ex.: rubrica), sem attachment_uuid e com page 1-indexed', async () => {
    const camposTemplate = [
      { name: 'RUBRICA DIVULGANTE', type: 'initials', areas: [{ x: 0.1, y: 0.9, w: 0.1, h: 0.03, page: 0, attachment_uuid: 'u' }] },
      { name: 'ASSINATURA DIVULGANTE', type: 'signature', areas: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05, page: 2, attachment_uuid: 'u' }] },
    ];
    const rubrica = (await camposEnviados(camposTemplate)).find((f) => f.name === 'RUBRICA DIVULGANTE');
    expect(rubrica.role).toBe('DIVULGANTE');
    expect(rubrica.areas[0].attachment_uuid).toBeUndefined();
    expect(rubrica.areas[0].page).toBe(1); // 0-indexed → 1-indexed
  });

  it('template base indisponível: segue só com as assinaturas', async () => {
    const espiao = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockHttpsSequence([
      { statusCode: 500, body: { error: 'x' } },
      { statusCode: 200, body: respostaSubmissionPdf },
    ]);
    const r = await criarSubmission(dadosBase, fakePdf);
    expect(r.submissionId).toBe('sub-1');
    espiao.mockRestore();
  });

  it('lança erro se o DocuSeal retornar 4xx', async () => {
    mockHttpsSequence([
      { statusCode: 200, body: { fields: [] } },
      { statusCode: 422, body: { error: 'invalid document' } },
    ]);

    await expect(criarSubmission(dadosBase, fakePdf)).rejects.toThrow('DocuSeal 422');
  });
});

describe('arquivarSubmission', () => {
  it('chama DELETE /submissions/:id (reenvio de convite com assinatura em andamento)', async () => {
    mockHttpsRequest(200, { id: 9, archived_at: 'x' });
    await arquivarSubmission('9');
    const [opts] = https.request.mock.calls[0];
    expect(opts.method).toBe('DELETE');
    expect(opts.path).toBe('/submissions/9');
  });
  it('sem chave de API ou sem id não faz chamada', async () => {
    delete process.env.DOCUSEAL_API_KEY;
    await arquivarSubmission('9');
    process.env.DOCUSEAL_API_KEY = 'fake-key';
    await arquivarSubmission(null);
    expect(https.request).not.toHaveBeenCalled();
  });
});
