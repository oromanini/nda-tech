const express = require('express');
const pool = require('../db/connection');
const authMiddleware = require('../middlewares/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  const busca = req.query.busca || '';
  const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
  const porPagina = Math.min(100, parseInt(req.query.por_pagina) || 20);
  const offset = (pagina - 1) * porPagina;

  try {
    const buscaParam = `%${busca}%`;
    const where = busca
      ? 'WHERE razao_social LIKE ? OR clientes.email LIKE ? OR cnpj_cpf LIKE ?'
      : '';
    const params = busca ? [buscaParam, buscaParam, buscaParam] : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM clientes ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT clientes.id, tipo_pessoa, razao_social, cnpj_cpf, clientes.email, clientes.created_at,
              COALESCE(convites.falha_email, 0) AS falha_email
       FROM clientes LEFT JOIN convites ON convites.id = clientes.convite_id ${where}
       ORDER BY clientes.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, porPagina, offset]
    );

    res.json({
      data: rows,
      total,
      pagina,
      por_pagina: porPagina,
      total_paginas: Math.ceil(total / porPagina),
    });
  } catch (err) {
    console.error('Erro ao listar clientes:', err);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao buscar cliente:', err);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

module.exports = router;
