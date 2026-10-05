const express = require('express');
const pool = require('../db/connection');
const { autenticarChamada, segredoConfere } = require('../lib/integracaoAuth');
const { validarComandoConvite } = require('../lib/contratos');
const { criarConvite } = require('../services/convitesService');
const { arquivarSubmission } = require('../services/docusealService');
const { registrarAssinatura } = require('../services/assinaturasService');
const { processarOutbox, listarFalhas } = require('../services/outboxService');
const { enviarLembretes } = require('../services/lembretesService');

const router = express.Router();

const NAO_AUTORIZADO = { error: 'Não autorizado' };

// O HMAC cobre os bytes exatos enviados: app.js guarda o corpo bruto em req.rawBody (express.json verify).
function autenticar(req, res) {
  const corpo = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
  const auth = autenticarChamada(req.headers, corpo);
  if (!auth.ok) {
    console.warn(`integracoes: requisição recusada (${auth.motivo})`);
    res.status(401).json(NAO_AUTORIZADO);
    return null;
  }
  return corpo;
}

/**
 * POST /api/integracoes/convites — comando nda.convite.criar (Deal → nda-form).
 * Idempotency-Key repetida devolve a resposta original, sem criar outro convite.
 */
router.post('/integracoes/convites', async (req, res) => {
  const corpo = autenticar(req, res);
  if (!corpo) return;

  let comando;
  try { comando = JSON.parse(corpo.toString('utf8')); } catch { return res.status(422).json({ error: 'Corpo não é um JSON válido' }); }
  const erros = validarComandoConvite(comando);
  if (erros.length) return res.status(422).json({ error: 'Comando inválido', detalhes: erros });

  const chave = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 191) : '';
  let reservada = false;
  try {
    if (chave) {
      // A chave é reservada ANTES de criar o convite (status 0 = em processamento). Quem perde a corrida não cria nada
      // (criar cancelaria o convite do vencedor) e devolve a resposta que o vencedor gravar.
      const [res0] = await pool.query('INSERT IGNORE INTO idempotencia_comandos (chave, status, resposta) VALUES (?, 0, ?)', [chave, '{}']);
      if (res0.affectedRows === 0) {
        const original = await respostaGravada(chave);
        if (!original) return res.status(409).json({ error: 'Comando em processamento; tente novamente.' });
        return res.status(original.status).json(original.corpo);
      }
      reservada = true;
    }

    const { convite_id, link, submissoesParaArquivar } = await criarConvite(comando);
    const resposta = { convite_id, link };
    if (chave) await pool.query('UPDATE idempotencia_comandos SET status = 201, resposta = ? WHERE chave = ?', [JSON.stringify(resposta), chave]);

    // Reenvio com assinatura em andamento: a submissão antiga é arquivada no DocuSeal (melhor esforço).
    for (const sub of submissoesParaArquivar) {
      try { await arquivarSubmission(sub); } catch (err) { console.error('docuseal: falha ao arquivar submissão antiga:', err.message); }
    }
    res.status(201).json(resposta);
  } catch (err) {
    // Reserva sem resposta travaria os retries da mesma chave: libera para o Deal poder tentar de novo.
    if (reservada) { try { await pool.query('DELETE FROM idempotencia_comandos WHERE chave = ? AND status = 0', [chave]); } catch (e) { console.error('Erro ao liberar chave:', e.message); } }
    console.error('Erro ao criar convite:', err.message);
    res.status(500).json({ error: 'Erro ao criar convite' });
  }
});

const ESPERA_MS = 10000;
const INTERVALO_MS = 50;

/** Resposta gravada pelo vencedor da corrida; espera enquanto ele ainda processa (status 0). null = não saiu a tempo. */
async function respostaGravada(chave) {
  const limite = Date.now() + ESPERA_MS;
  for (;;) {
    const [rows] = await pool.query('SELECT status, resposta FROM idempotencia_comandos WHERE chave = ? LIMIT 1', [chave]);
    if (rows.length && rows[0].status !== 0) {
      const r = rows[0].resposta;
      return { status: rows[0].status, corpo: typeof r === 'string' ? JSON.parse(r) : r };
    }
    // Sem linha: o vencedor falhou e liberou a chave. Quem espera devolve 409 e o Deal retenta (a outbox já faz isso).
    if (!rows.length || Date.now() >= limite) return null;
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }
}

/** GET /api/integracoes/eventos/falhas — eventos que esgotaram as tentativas (o Deal lista). */
router.get('/integracoes/eventos/falhas', async (req, res) => {
  if (!autenticar(req, res)) return;
  res.json(await listarFalhas());
});

/**
 * POST /api/integracoes/docuseal/webhook — form.completed (um por signatário).
 * O DocuSeal não assina o corpo: o painel envia um header com segredo (DOCUSEAL_WEBHOOK_SECRET), comparado em tempo constante.
 */
router.post('/integracoes/docuseal/webhook', async (req, res) => {
  const segredo = (process.env.DOCUSEAL_WEBHOOK_SECRET || '').trim();
  if (!segredoConfere(req.headers['x-docuseal-secret'], segredo)) {
    console.warn('docuseal: webhook recusado (segredo inválido)');
    return res.status(401).json(NAO_AUTORIZADO);
  }

  const corpo = req.body || {};
  if (corpo.event_type !== 'form.completed') return res.json({ ok: true, efeito: 'ignorado' });
  const d = corpo.data || {};
  try {
    const r = await registrarAssinatura({
      submissionId: (d.submission && d.submission.id) || d.submission_id,
      role: d.role,
      nome: d.name,
      assinadoEm: d.completed_at || corpo.timestamp,
    });
    res.json({ ok: true, efeito: r.efeito });
  } catch (err) {
    // 500 faz o DocuSeal reentregar; a unicidade (nda, papel) mantém a reentrega inofensiva.
    console.error('docuseal: falha ao processar webhook:', err.message);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

/** Jobs do Cloud Scheduler (o serviço escala a zero: não há timer interno). Bearer JOBS_TOKEN. */
function jobAutorizado(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!segredoConfere(m && m[1], (process.env.JOBS_TOKEN || '').trim())) return res.status(401).json(NAO_AUTORIZADO);
  next();
}

router.post('/jobs/outbox', jobAutorizado, async (_req, res) => {
  res.json(await processarOutbox());
});

router.post('/jobs/lembretes', jobAutorizado, async (_req, res) => {
  res.json(await enviarLembretes());
});

module.exports = router;
