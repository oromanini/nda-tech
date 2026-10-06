const crypto = require('crypto');

// Autenticação das chamadas entre sistemas (contracts/README §4.1): Bearer + HMAC do corpo bruto + janela de 300 s.
// Mesmo desenho do Deal (backend/src/integracoes/assinatura.ts). Falha fecha: qualquer dúvida é 401.

const JANELA_SEGUNDOS = 300;

const sha = (v) => crypto.createHash('sha256').update(v).digest();
// Hash dos dois lados iguala o tamanho: timingSafeEqual não vaza o comprimento do segredo.
const iguais = (a, b) => crypto.timingSafeEqual(sha(String(a)), sha(String(b)));

function assinar(segredo, timestamp, corpo) {
  return 'sha256=' + crypto.createHmac('sha256', segredo).update(`${timestamp}.`).update(corpo).digest('hex');
}

const header = (headers, nome) => (typeof headers[nome] === 'string' ? headers[nome] : '');
const env = (nome) => (process.env[nome] || '').trim();

/** Credenciais de quem chama o nda-form (hoje só o Deal). Lidas a cada chamada: rotação e testes. */
function credencialDaOrigem(origem) {
  if (origem !== 'deal') return null;
  return { token: env('INTEGRATION_DEAL_TOKEN'), hmac: env('INTEGRATION_DEAL_HMAC'), hmacAnterior: env('INTEGRATION_DEAL_HMAC_PREVIOUS') };
}

function autenticarChamada(headers, corpoBruto, agoraSegundos = Math.floor(Date.now() / 1000)) {
  const origem = header(headers, 'x-alluz-origem');
  const cred = credencialDaOrigem(origem);
  if (!cred || !cred.token || !cred.hmac) return { ok: false, motivo: 'origem_desconhecida' };

  const auth = header(headers, 'authorization');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !iguais(token, cred.token)) return { ok: false, motivo: 'token_invalido' };

  const ts = header(headers, 'x-alluz-timestamp');
  if (!/^\d{1,12}$/.test(ts) || Math.abs(agoraSegundos - Number(ts)) > JANELA_SEGUNDOS) return { ok: false, motivo: 'timestamp_fora_da_janela' };

  const recebida = header(headers, 'x-alluz-assinatura');
  // Avalia todos os segredos (sem curto-circuito) para o tempo não variar conforme qual deles casou. Atual e anterior (rotação).
  const casou = [cred.hmac, cred.hmacAnterior].filter(Boolean).map((s) => iguais(recebida, assinar(s, ts, corpoBruto))).some(Boolean);
  if (!casou) return { ok: false, motivo: 'assinatura_invalida' };

  return { ok: true, origem };
}

/** Segredo simples em header (webhook do DocuSeal, que não assina com HMAC) e token de job: comparação em tempo constante. */
function segredoConfere(recebido, esperado) {
  if (!recebido || !esperado) return false;
  return iguais(recebido, esperado);
}

module.exports = { JANELA_SEGUNDOS, assinar, autenticarChamada, segredoConfere };
