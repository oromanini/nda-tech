const express = require('express');
const path = require('path');
const { buscarConviteAberto } = require('../services/convitesService');

const router = express.Router();
const publico = path.join(__dirname, '..', '..', 'public');

// Convite inválido, expirado, já usado ou cancelado: a MESMA resposta para todos (não revela se o convite existiu).
const NEUTRO = { error: 'Convite inválido ou expirado' };

function semCache(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer'); // o token está na URL
}

/** GET /c/:token — abre o formulário do convite. */
router.get('/c/:token', async (req, res) => {
  semCache(res);
  try {
    const convite = await buscarConviteAberto(req.params.token);
    if (!convite) return res.status(404).sendFile(path.join(publico, 'convite-invalido.html'));
    res.sendFile(path.join(publico, 'index.html'));
  } catch (err) {
    console.error('Erro ao abrir convite:', err.message);
    res.status(404).sendFile(path.join(publico, 'convite-invalido.html'));
  }
});

/** GET /api/convites/:token — dados para pré-preencher o formulário (e-mail travado). */
router.get('/api/convites/:token', async (req, res) => {
  semCache(res);
  try {
    const c = await buscarConviteAberto(req.params.token);
    if (!c) return res.status(404).json(NEUTRO);
    res.json({ email: c.email, empresa: c.empresa, responsavel: c.responsavel });
  } catch (err) {
    console.error('Erro ao consultar convite:', err.message);
    res.status(404).json(NEUTRO);
  }
});

module.exports = router;
