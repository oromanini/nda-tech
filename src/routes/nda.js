const express = require('express');
const pool = require('../db/connection');
const { gerarPDF } = require('../services/pdfService');
const { enviarNDA, notificarInterno, enviarLinkAssinatura } = require('../services/emailService');
const { criarSubmission } = require('../services/docusealService');
const { validarDadosNda } = require('../lib/validadores');
const { buscarConviteAberto, reivindicar, liberar } = require('../services/convitesService');

const router = express.Router();

const PRAZO_VIGENCIA = '1 (um) ano';
const VALOR_MULTA = 20000;
const PRAZO_NAO_SOLICITACAO = '1 (um) ano';

const CAMPOS_OBRIGATORIOS = [
  'tipo_pessoa', 'razao_social', 'cnpj_cpf', 'endereco', 'cep',
  'testemunha1_nome', 'testemunha1_cpf', 'testemunha1_email',
  'testemunha2_nome', 'testemunha2_cpf', 'testemunha2_email',
  'email',
];

// Convite inválido, expirado, usado ou cancelado: resposta única, sem revelar se o convite existiu.
const CONVITE_NEUTRO = { error: 'Convite inválido ou expirado' };
const legadoLigado = () => (process.env.LEGACY_NDA_FORM_ENABLED ?? 'true') === 'true';

router.post('/gerar-nda', async (req, res) => {
  const dados = req.body || {};

  // Com convite: o e-mail é o do convite, sempre. Qualquer valor enviado no POST é ignorado (e-mail travado).
  let convite = null;
  if (dados.convite_token !== undefined) {
    try { convite = await buscarConviteAberto(dados.convite_token); } catch (err) { console.error('Erro ao consultar convite:', err.message); }
    if (!convite) return res.status(404).json(CONVITE_NEUTRO);
    dados.email = convite.email;
  } else if (!legadoLigado()) {
    return res.status(403).json({ error: 'O NDA agora é preenchido a partir do convite enviado por e-mail.' });
  }

  for (const campo of CAMPOS_OBRIGATORIOS) {
    if (!dados[campo] && dados[campo] !== 0) {
      return res.status(400).json({ error: `Campo obrigatório ausente: ${campo}` });
    }
  }

  if (dados.tipo_pessoa === 'PJ') {
    if (!dados.representante || !dados.cpf_representante || !dados.cargo) {
      return res.status(400).json({ error: 'Representante legal obrigatório para Pessoa Jurídica.' });
    }
  }

  const erroDados = validarDadosNda(dados);
  if (erroDados) return res.status(400).json({ error: erroDados });

  // O convite é reivindicado de forma atômica: dois envios simultâneos não geram dois NDAs.
  if (convite && !(await reivindicar(convite.id))) return res.status(404).json(CONVITE_NEUTRO);

  // Valores fixos — não vêm do formulário
  dados.prazo_vigencia = PRAZO_VIGENCIA;
  dados.prazo_nao_solicitacao = PRAZO_NAO_SOLICITACAO;

  // Data atual automática
  const hoje = new Date();
  const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  dados.data_dia = String(hoje.getDate());
  dados.data_mes = String(hoje.getMonth() + 1);
  dados.data_ano = String(hoje.getFullYear());
  const dataAssinatura = hoje.toISOString().slice(0, 10);

  let ndaId = null;
  try {
    const [result] = await pool.query(
      `INSERT INTO clientes
        (tipo_pessoa, razao_social, cnpj_cpf, endereco, cep, representante, cpf_representante, cargo,
         prazo_vigencia, valor_multa, prazo_nao_solicitacao, plataforma_assinatura,
         testemunha1_nome, testemunha1_cpf, testemunha1_email,
         testemunha2_nome, testemunha2_cpf, testemunha2_email,
         data_assinatura, email, convite_id, projeto_uuid, cliente_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dados.tipo_pessoa, dados.razao_social, dados.cnpj_cpf, dados.endereco, dados.cep,
        dados.representante || null, dados.cpf_representante || null, dados.cargo || null,
        PRAZO_VIGENCIA, VALOR_MULTA, PRAZO_NAO_SOLICITACAO,
        dados.plataforma_assinatura || null,
        dados.testemunha1_nome, dados.testemunha1_cpf, dados.testemunha1_email,
        dados.testemunha2_nome, dados.testemunha2_cpf, dados.testemunha2_email,
        dataAssinatura, dados.email,
        convite ? convite.id : null, convite ? convite.projeto_uuid : null, convite ? convite.cliente_uuid : null,
      ]
    );
    ndaId = result.insertId;

    const dadosCompletos = { ...dados, valor_multa: VALOR_MULTA };
    const pdfBuffer = await gerarPDF(dadosCompletos);

    if (process.env.DOCUSEAL_API_KEY) {
      const { submissionId, signatarios } = await criarSubmission(dadosCompletos, pdfBuffer);
      if (submissionId) {
        await pool.query('UPDATE clientes SET docuseal_submission_id = ? WHERE id = ?', [submissionId, result.insertId]);
      }

      const nomeCliente = dadosCompletos.razao_social || dadosCompletos.representante;
      const papeis = ['cliente', 'alluz', 'testemunha', 'testemunha'];
      for (let i = 0; i < signatarios.length; i++) {
        const s = signatarios[i];
        try {
          await enviarLinkAssinatura(s.nome, s.email, s.link, nomeCliente, papeis[i]);
          console.log(`Link de assinatura enviado (${papeis[i]}, NDA ${result.insertId})`);
        } catch (emailErr) {
          // Sem e-mail no log (dado pessoal). Falha no link do cliente: o convite fica marcado para o admin enxergar.
          console.error(`Falha ao enviar link de assinatura (${papeis[i]}${convite ? `, convite ${convite.id}` : `, NDA ${result.insertId}`}):`, emailErr.message);
          if (convite && papeis[i] === 'cliente') {
            try { await pool.query('UPDATE convites SET falha_email = 1 WHERE id = ?', [convite.id]); }
            catch (e) { console.error(`Falha ao marcar falha_email (convite ${convite.id}):`, e.message); }
          }
        }
      }

      res.json({ success: true, message: 'NDA enviado! Você receberá um e-mail com o link para assinatura digital.' });
    } else {
      await enviarNDA(dadosCompletos, pdfBuffer);
      res.json({ success: true, message: 'NDA enviado com sucesso.' });
    }
  } catch (err) {
    console.error('Erro ao gerar NDA:', err && err.message);
    // Falhou antes de o cliente receber qualquer link: devolve o convite para ele tentar de novo e some com o registro órfão.
    if (convite) {
      try {
        if (ndaId) await pool.query('DELETE FROM clientes WHERE id = ?', [ndaId]);
        await liberar(convite.id);
      } catch (e) { console.error('Erro ao liberar convite:', e.message); }
    }
    res.status(500).json({ error: 'Erro ao processar o NDA. Tente novamente.' });
  }
});

module.exports = router;
