const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/connection');
const pool = require('../src/db/connection');

process.env.JWT_SECRET = 'test-secret';

const app = require('../src/app');

function authHeader() {
  const token = jwt.sign({ id: 1, username: 'admin' }, 'test-secret', { expiresIn: '1h' });
  return `Bearer ${token}`;
}

describe('GET /api/admin/clientes', () => {
  it('retorna 401 sem token', async () => {
    const res = await request(app).get('/api/admin/clientes');
    expect(res.status).toBe(401);
  });

  it('retorna lista paginada de clientes', async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 2 }]])
      .mockResolvedValueOnce([[
        { id: 1, razao_social: 'Empresa A', email: 'a@a.com', cnpj_cpf: '00.000.000/0001-00', tipo_pessoa: 'PJ', created_at: new Date() },
        { id: 2, razao_social: 'Empresa B', email: 'b@b.com', cnpj_cpf: '00.000.000/0001-01', tipo_pessoa: 'PJ', created_at: new Date() },
      ]]);

    const res = await request(app)
      .get('/api/admin/clientes')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.total_paginas).toBe(1);
  });

  it('aceita parâmetros de paginação', async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 50 }]])
      .mockResolvedValueOnce([[]]); // página 3, sem resultados

    const res = await request(app)
      .get('/api/admin/clientes?pagina=3&por_pagina=10')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.pagina).toBe(3);
    expect(res.body.por_pagina).toBe(10);
    expect(res.body.total_paginas).toBe(5);
  });
});

describe('GET /api/admin/clientes/:id', () => {
  it('retorna 404 se cliente não existe', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const res = await request(app)
      .get('/api/admin/clientes/999')
      .set('Authorization', authHeader());
    expect(res.status).toBe(404);
  });

  it('retorna o cliente pelo id', async () => {
    const cliente = { id: 1, razao_social: 'Empresa A', email: 'a@a.com' };
    pool.query.mockResolvedValueOnce([[cliente]]);
    const res = await request(app)
      .get('/api/admin/clientes/1')
      .set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.razao_social).toBe('Empresa A');
  });
});

describe('GET /api/admin/clientes — falha de e-mail do convite visível ao admin', () => {
  it('junta convites e devolve falha_email', async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 1 }]])
      .mockResolvedValueOnce([[{ id: 3, razao_social: 'BPO', falha_email: 1 }]]);
    const res = await request(app).get('/api/admin/clientes').set('Authorization', authHeader());
    expect(res.status).toBe(200);
    expect(res.body.data[0].falha_email).toBe(1);
    const sql = pool.query.mock.calls[1][0];
    expect(sql).toMatch(/LEFT JOIN convites ON convites\.id = clientes\.convite_id/);
    expect(sql).toMatch(/COALESCE\(convites\.falha_email, 0\) AS falha_email/);
  });
});
