jest.mock('puppeteer');

const puppeteer = require('puppeteer');
const { gerarPDF } = require('../src/services/pdfService');

// Usa o templates/nda.html de verdade (sem mock de fs) e captura o HTML entregue ao Chromium.
async function htmlGerado(dados) {
  let html = '';
  puppeteer.launch.mockResolvedValue({
    newPage: async () => ({ setContent: async (h) => { html = h; }, pdf: async () => Buffer.from('pdf') }),
    close: async () => {},
  });
  await gerarPDF({ prazo_vigencia: '1 (um) ano', valor_multa: 20000, prazo_nao_solicitacao: '1 (um) ano', data_dia: '4', data_mes: '10', data_ano: '2026', ...dados });
  return html;
}

const comuns = {
  endereco: 'Av. Brasil, 100', cep: '87000-000',
  testemunha1_nome: 'João Lima', testemunha1_cpf: '111.444.777-35', testemunha2_nome: 'Ana Reis', testemunha2_cpf: '390.533.447-05',
};
const pj = { ...comuns, tipo_pessoa: 'PJ', razao_social: 'BPO Exemplo LTDA', cnpj_cpf: '11.222.333/0001-81', representante: 'Maria Souza', cpf_representante: '529.982.247-25', cargo: 'Sócia' };
const pf = { ...comuns, tipo_pessoa: 'PF', razao_social: 'João da Silva', cnpj_cpf: '168.995.350-09' };

describe('templates/nda.html', () => {
  it('PJ: traz o bloco do representante legal', async () => {
    const html = await htmlGerado(pj);
    expect(html).toContain('neste ato representada por Maria Souza, Sócia');
    expect(html).toContain('529.982.247-25');
    expect(html).toContain('pessoa jurídica de direito privado');
  });

  it('PF: variante sem representante (nem nome, nem CPF, nem "neste ato representada")', async () => {
    const html = await htmlGerado(pf);
    expect(html).not.toContain('neste ato representada por');
    expect(html).not.toMatch(/representante\s+legal\s*:/i);
    expect(html).toContain('pessoa física');
    expect(html).toContain('CPF sob o nº 168.995.350-09');
  });

  it.each([['PJ', pj], ['PF', pf]])('%s: nenhum placeholder sem preencher', async (_t, dados) => {
    expect(await htmlGerado(dados)).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it('as quatro assinaturas (cliente, Alluz, 2 testemunhas) ficam em página própria', async () => {
    const html = await htmlGerado(pj);
    expect(html).toMatch(/\.assinaturas\s*\{[^}]*page-break-before:\s*always/);
    expect((html.match(/Assinatura: _+/g) || []).length).toBe(4);
    // Linha de assinatura ancorada no rodapé de blocos de altura fixa: as coordenadas do DocuSeal não variam com nomes longos.
    expect(html).toMatch(/\.assinatura-bloco\s*\{[^}]*position:\s*relative;[^}]*height:\s*4cm/);
    expect(html).toMatch(/\.linha-assinatura\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*0/);
    expect((html.match(/class="label linha-assinatura"/g) || []).length).toBe(4);
  });
});
