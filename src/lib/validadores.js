// Validação de documentos e dados do NDA no servidor (o formulário valida no navegador, mas o servidor é quem manda).

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function validarCPF(valor) {
  const c = soDigitos(valor);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[t])) return false;
  }
  return true;
}

function validarCNPJ(valor) {
  const c = soDigitos(valor);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = [...base].reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12));
  const d2 = calc(c.slice(0, 12) + d1);
  return d1 === Number(c[12]) && d2 === Number(c[13]);
}

// Mesmo padrão de contracts/comum.schema.json (dados_juridicos.cep).
const validarCEP = (v) => /^\d{5}-?\d{3}$/.test(String(v ?? ''));
const validarEmail = (v) => typeof v === 'string' && v.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** CPF/CNPJ sem dados completos em log: ***.***.*89-** → só os 2 últimos dígitos. */
function mascararDocumento(v) {
  const d = soDigitos(v);
  if (!d) return '';
  return d.length <= 2 ? '*'.repeat(d.length) : '*'.repeat(d.length - 2) + d.slice(-2);
}

const texto = (v, max = 255) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Regras do NDA (A3). Devolve a mensagem do primeiro problema ou null.
 *  - PJ: CNPJ, razão social e representante (nome, CPF, cargo). PF: CPF e nome, sem representante.
 *  - Duas testemunhas (nome, CPF, e-mail) nos dois casos.
 */
function validarDadosNda(d) {
  if (!['PJ', 'PF'].includes(d.tipo_pessoa)) return 'tipo_pessoa deve ser PJ ou PF';
  if (!texto(d.razao_social)) return d.tipo_pessoa === 'PJ' ? 'Razão social obrigatória' : 'Nome obrigatório';
  if (d.tipo_pessoa === 'PJ') {
    if (!validarCNPJ(d.cnpj_cpf)) return 'CNPJ inválido';
    if (!texto(d.representante) || !texto(d.cargo, 100)) return 'Representante legal obrigatório para Pessoa Jurídica.';
    if (!validarCPF(d.cpf_representante)) return 'CPF do representante inválido';
  } else if (!validarCPF(d.cnpj_cpf)) {
    return 'CPF inválido';
  }
  if (!texto(d.endereco, 500)) return 'Endereço obrigatório';
  if (!validarCEP(d.cep)) return 'CEP inválido';
  if (!validarEmail(d.email)) return 'E-mail inválido';
  for (const n of [1, 2]) {
    if (!texto(d[`testemunha${n}_nome`])) return `Nome da testemunha ${n} obrigatório`;
    if (!validarCPF(d[`testemunha${n}_cpf`])) return `CPF da testemunha ${n} inválido`;
    if (!validarEmail(d[`testemunha${n}_email`])) return `E-mail da testemunha ${n} inválido`;
  }
  if (soDigitos(d.testemunha1_cpf) === soDigitos(d.testemunha2_cpf)) return 'As testemunhas devem ser pessoas diferentes';
  if (String(d.testemunha1_email).toLowerCase() === String(d.testemunha2_email).toLowerCase()) return 'As testemunhas devem ter e-mails diferentes';
  return null;
}

module.exports = { soDigitos, validarCPF, validarCNPJ, validarCEP, validarEmail, mascararDocumento, validarDadosNda };
