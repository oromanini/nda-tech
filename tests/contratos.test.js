const fs = require('fs');
const path = require('path');
const { validarComandoConvite, validarRespostaConvite, validarEnvelope } = require('../src/lib/contratos');

const AQUI = path.join(__dirname, '..', 'contracts');
const ORIGINAL = path.join(__dirname, '..', '..', 'deal-alluztech', 'contracts');
const ler = (rel) => JSON.parse(fs.readFileSync(path.join(AQUI, rel), 'utf8'));

describe('exemplos do contrato (contracts/exemplos)', () => {
  it('comando nda.convite.criar valida', () => {
    expect(validarComandoConvite(ler('exemplos/comandos/nda.convite.criar.json'))).toEqual([]);
  });
  it.each(['nda.assinado.json', 'nda.assinatura.parcial.json'])('evento %s valida no envelope', (f) => {
    expect(validarEnvelope(ler(`exemplos/eventos/${f}`))).toEqual([]);
  });
  it('resposta do comando exige convite_id e link', () => {
    expect(validarRespostaConvite({ convite_id: 'c', link: 'https://nda.alluz.tech/c/x' })).toEqual([]);
    expect(validarRespostaConvite({ convite_id: 'c' })).not.toEqual([]);
  });
  it('envelope recusa origem errada, papel desconhecido e total diferente de 4', () => {
    const ev = ler('exemplos/eventos/nda.assinatura.parcial.json');
    expect(validarEnvelope({ ...ev, origem: 'aurora' })).not.toEqual([]);
    expect(validarEnvelope({ ...ev, dados: { ...ev.dados, papel: 'diretor' } })).not.toEqual([]);
    expect(validarEnvelope({ ...ev, dados: { ...ev.dados, assinaturas_total: 3 } })).not.toEqual([]);
    expect(validarEnvelope({ ...ev, dados: { ...ev.dados, assinaturas_concluidas: 5 } })).not.toEqual([]);
  });
  it('nda.assinado exige dados_juridicos com 2 testemunhas e representante na PJ', () => {
    const ev = ler('exemplos/eventos/nda.assinado.json');
    const dj = ev.dados.dados_juridicos;
    expect(validarEnvelope({ ...ev, dados: { ...ev.dados, dados_juridicos: { ...dj, testemunhas: [dj.testemunhas[0]] } } })).not.toEqual([]);
    const { representante: _r, ...semRep } = dj;
    expect(validarEnvelope({ ...ev, dados: { ...ev.dados, dados_juridicos: semRep } })).not.toEqual([]);
    expect(validarEnvelope({ ...ev, dados: { ...ev.dados, dados_juridicos: { ...semRep, tipo_pessoa: 'PF' } } })).toEqual([]);
  });
  it('mensagens de erro não ecoam valores (dados pessoais)', () => {
    const ev = ler('exemplos/eventos/nda.assinado.json');
    const erros = validarEnvelope({ ...ev, dados: { ...ev.dados, dados_juridicos: { ...ev.dados.dados_juridicos, cep: 'Maria Souza 111.222.333-44' } } });
    expect(JSON.stringify(erros)).not.toContain('Maria Souza');
  });
});

// A cópia local precisa ser idêntica ao deal-alluztech/contracts (fonte da verdade). Só roda quando o repo irmão existe.
const temOriginal = fs.existsSync(ORIGINAL);
(temOriginal ? describe : describe.skip)('cópia sincronizada com o deal-alluztech/contracts', () => {
  const arquivos = [];
  (function varrer(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) varrer(p); else arquivos.push(path.relative(AQUI, p));
    }
  })(AQUI);

  it.each(arquivos)('%s', (rel) => {
    expect(fs.readFileSync(path.join(AQUI, rel), 'utf8')).toBe(fs.readFileSync(path.join(ORIGINAL, rel), 'utf8'));
  });
});
