jest.mock('../src/db/connection');
jest.mock('../src/services/emailService');

const pool = require('../src/db/connection');
const { enviarLembreteConvite } = require('../src/services/emailService');
const { enviarLembretes, MAXIMO, INTERVALO_DIAS } = require('../src/services/lembretesService');

beforeEach(() => jest.clearAllMocks());

describe('lembretes de convite pendente', () => {
  it('seleciona só pendentes, não expirados, com menos de 3 lembretes e 3 dias desde o último', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await enviarLembretes();
    const [sql, params] = pool.query.mock.calls[0];
    const s = sql.replace(/\s+/g, ' ');
    expect(s).toMatch(/status = 'pendente'/);
    expect(s).toMatch(/expira_em > NOW\(\)/);
    expect(s).toMatch(/lembretes_enviados < \?/);
    expect(s).toMatch(/COALESCE\(ultimo_lembrete_em, criado_em\) <= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)/);
    expect(params).toEqual([MAXIMO, INTERVALO_DIAS]);
    expect([MAXIMO, INTERVALO_DIAS]).toEqual([3, 3]);
  });

  it('envia um lembrete por convite e conta (sem link: o token não é guardado)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 'a', email: 'a@x.co', empresa: 'E', responsavel: 'R', lembretes_enviados: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const r = await enviarLembretes();
    expect(r).toEqual({ analisados: 1, enviados: 1 });
    expect(enviarLembreteConvite).toHaveBeenCalledWith('R', 'a@x.co', 'E');
    expect(enviarLembreteConvite.mock.calls[0]).toHaveLength(3);
  });

  it('dois disparos do job: quem perdeu a reivindicação não reenvia', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 'a', email: 'a@x.co', empresa: 'E', responsavel: 'R', lembretes_enviados: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);
    expect((await enviarLembretes()).enviados).toBe(0);
    expect(enviarLembreteConvite).not.toHaveBeenCalled();
  });

  it('falha de e-mail não derruba o job', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 'a', email: 'a@x.co', empresa: 'E', responsavel: 'R', lembretes_enviados: 0 }, { id: 'b', email: 'b@x.co', empresa: 'F', responsavel: 'S', lembretes_enviados: 0 }]])
      .mockResolvedValue([{ affectedRows: 1 }]);
    enviarLembreteConvite.mockRejectedValueOnce(new Error('smtp'));
    const espiao = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await enviarLembretes()).enviados).toBe(1);
    espiao.mockRestore();
  });
});
