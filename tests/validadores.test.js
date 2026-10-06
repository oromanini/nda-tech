const { validarCPF, validarCNPJ, validarCEP, mascararDocumento, validarDadosNda } = require('../src/lib/validadores');

const base = {
  endereco: 'Rua A, 1', cep: '87013-050', email: 'a@b.co',
  testemunha1_nome: 'T1', testemunha1_cpf: '111.444.777-35', testemunha1_email: 't1@b.co',
  testemunha2_nome: 'T2', testemunha2_cpf: '390.533.447-05', testemunha2_email: 't2@b.co',
};
const pj = { ...base, tipo_pessoa: 'PJ', razao_social: 'Empresa LTDA', cnpj_cpf: '11.222.333/0001-81', representante: 'Maria', cpf_representante: '529.982.247-25', cargo: 'Sócia' };
const pf = { ...base, tipo_pessoa: 'PF', razao_social: 'João da Silva', cnpj_cpf: '168.995.350-09' };

describe('documentos', () => {
  it('CPF: dígito verificador, repetidos e tamanho', () => {
    expect(validarCPF('111.444.777-35')).toBe(true);
    expect(validarCPF('11144477735')).toBe(true);
    expect(validarCPF('111.444.777-36')).toBe(false);
    expect(validarCPF('111.111.111-11')).toBe(false);
    expect(validarCPF('123')).toBe(false);
    expect(validarCPF('')).toBe(false);
  });
  it('CNPJ: dígito verificador, repetidos e tamanho', () => {
    expect(validarCNPJ('11.222.333/0001-81')).toBe(true);
    expect(validarCNPJ('11.222.333/0001-82')).toBe(false);
    expect(validarCNPJ('00.000.000/0000-00')).toBe(false);
    expect(validarCNPJ('1122233300018')).toBe(false);
  });
  it('CEP segue o padrão do schema', () => {
    expect(validarCEP('87013-050')).toBe(true);
    expect(validarCEP('87013050')).toBe(true);
    expect(validarCEP('8701-3050')).toBe(false);
    expect(validarCEP('abc')).toBe(false);
  });
  it('máscara nunca devolve o documento completo', () => {
    expect(mascararDocumento('11.222.333/0001-81')).toBe('************81');
    expect(mascararDocumento('111.444.777-35')).toBe('*********35');
    expect(mascararDocumento(null)).toBe('');
  });
});

describe('PF e PJ', () => {
  it('PJ completa e PF sem representante são aceitas', () => {
    expect(validarDadosNda(pj)).toBeNull();
    expect(validarDadosNda(pf)).toBeNull();
  });
  it('PJ exige CNPJ válido, representante (nome, CPF válido e cargo)', () => {
    expect(validarDadosNda({ ...pj, cnpj_cpf: '11.222.333/0001-80' })).toMatch(/CNPJ/);
    expect(validarDadosNda({ ...pj, representante: '' })).toMatch(/Representante/);
    expect(validarDadosNda({ ...pj, cargo: '' })).toMatch(/Representante/);
    expect(validarDadosNda({ ...pj, cpf_representante: '111.111.111-11' })).toMatch(/CPF do representante/);
  });
  it('PF exige CPF válido (CNPJ não vale) e não pede representante', () => {
    expect(validarDadosNda({ ...pf, cnpj_cpf: '11.222.333/0001-81' })).toMatch(/CPF/);
    expect(validarDadosNda({ ...pf, cnpj_cpf: '168.995.350-10' })).toMatch(/CPF/);
  });
  it('duas testemunhas obrigatórias (nome, CPF, e-mail) nos dois casos', () => {
    for (const d of [pj, pf]) {
      expect(validarDadosNda({ ...d, testemunha2_nome: '' })).toMatch(/testemunha 2/);
      expect(validarDadosNda({ ...d, testemunha1_cpf: '123.456.789-00' })).toMatch(/testemunha 1/);
      expect(validarDadosNda({ ...d, testemunha1_email: 'invalido' })).toMatch(/testemunha 1/);
      expect(validarDadosNda({ ...d, testemunha2_cpf: d.testemunha1_cpf })).toMatch(/diferentes/);
      expect(validarDadosNda({ ...d, testemunha2_email: d.testemunha1_email.toUpperCase() })).toMatch(/diferentes/);
    }
  });
  it('CEP e e-mail inválidos são recusados', () => {
    expect(validarDadosNda({ ...pj, cep: '123' })).toMatch(/CEP/);
    expect(validarDadosNda({ ...pj, email: 'x' })).toMatch(/E-mail/);
  });
  it('tipo_pessoa desconhecido é recusado', () => {
    expect(validarDadosNda({ ...pj, tipo_pessoa: 'MEI' })).toMatch(/tipo_pessoa/);
  });
});
