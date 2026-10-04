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
  try {
    if (chave) {
      const [ant] = await pool.query('SELECT status, resposta FROM idempotencia_comandos WHERE chave = ? LIMIT 1', [chave]);
      if (ant.length) return res.status(ant[0].status).json(typeof ant[0].resposta === 'string' ? JSON.parse(ant[0].resposta) : ant[0].resposta);
    }

    const { convite_id, link, submissoesParaArquivar } = await criarConvite(comando);
    const resposta = { convite_id, link };

    if (chave) {
      const [ins] = await pool.query('INSERT IGNORE INTO idempotencia_comandos (chave, status, resposta) VALUES (?, 201, ?)', [chave, JSON.stringify(resposta)]);
      if (ins.affectedRows === 0) {
        // Corrida: outra requisição com a mesma chave gravou primeiro. Cancela este convite e devolve a resposta dela.
        await pool.query(`UPDATE convites SET status = 'cancelado' WHERE id = ?`, [convite_id]);
        const [orig] = await pool.query('SELECT status, resposta FROM idempotencia_comandos WHERE chave = ? LIMIT 1', [chave]);
        return res.status(orig[0].status).json(typeof orig[0].resposta === 'string' ? JSON.parse(orig[0].resposta) : orig[0].resposta);
      }
    }

    // Reenvio com assinatura em andamento: a submissão antiga é arquivada no DocuSeal (melhor esforço).
    for (const sub of submissoesParaArquivar) {
      try { await arquivarSubmission(sub); } catch (err) { console.error('docuseal: falha ao arquivar submissão antiga:', err.message); }
    }
    res.status(201).json(resposta);
  } catch (err) {
    console.error('Erro ao criar convite:', err.message);
    res.status(500).json({ error: 'Erro ao criar convite' });
  }
});

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
