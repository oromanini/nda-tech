const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

// Valida mensagens contra contracts/ (JSON Schema 2020-12). A pasta é uma cópia dos schemas do
// deal-alluztech/contracts (scripts/sync-contracts.sh); o teste de sincronia compara com o original quando ele existe.

const BASE = 'https://contracts.alluz.tech/v1';

function diretorio() {
  const candidatos = [process.env.CONTRACTS_DIR, path.resolve(__dirname, '../../contracts'), '/app/contracts'];
  for (const c of candidatos) if (c && fs.existsSync(path.join(c, 'comum.schema.json'))) return c;
  throw new Error('Diretório contracts/ não encontrado (defina CONTRACTS_DIR)');
}

let ajv;
function instancia() {
  if (ajv) return ajv;
  const dir = diretorio();
  const a = new Ajv2020({ allErrors: true, strict: false });
  addFormats(a);
  const ler = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  a.addSchema(ler(path.join(dir, 'comum.schema.json')));
  for (const sub of ['eventos', 'comandos']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.schema.json')) a.addSchema(ler(path.join(d, f)));
  }
  ajv = a;
  return a;
}

// Erros sem ecoar valores (podem ser dados pessoais): só caminho e regra violada.
function erros(validar) {
  return (validar.errors || []).map((e) => ({ caminho: e.instancePath || '/', mensagem: e.message || 'inválido' }));
}

function validar(id, corpo) {
  const v = instancia().getSchema(id);
  if (!v) throw new Error(`Schema não carregado: ${id}`);
  return v(corpo) ? [] : erros(v);
}

const validarComandoConvite = (corpo) => validar(`${BASE}/comandos/nda.convite.criar.schema.json#/$defs/requisicao`, corpo);
const validarRespostaConvite = (corpo) => validar(`${BASE}/comandos/nda.convite.criar.schema.json#/$defs/resposta`, corpo);
const validarEnvelope = (corpo) => validar(`${BASE}/eventos/envelope.schema.json`, corpo);

module.exports = { validarComandoConvite, validarRespostaConvite, validarEnvelope };
