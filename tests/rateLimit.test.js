const request = require('supertest');

jest.mock('../src/db/connection');
process.env.JWT_SECRET = 'test-secret';
const app = require('../src/app');

describe('rate limit de /api/gerar-nda (10 por hora por IP)', () => {
  it('fora do ambiente de teste, a 11ª tentativa recebe 429', async () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let ultimo;
      for (let i = 0; i < 11; i++) ultimo = await request(app).post('/api/gerar-nda').send({});
      expect(ultimo.status).toBe(429);
    } finally { process.env.NODE_ENV = antes; }
  });
});
