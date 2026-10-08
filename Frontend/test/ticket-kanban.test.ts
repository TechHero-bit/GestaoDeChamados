import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TicketKanbanState } from '../src/app/core/utils/ticket-kanban.ts';
import type { Ticket, TicketUpdatePayload } from '../src/app/core/models/ticket.model.ts';

const ticket: Ticket = {
  id: '00000000-0000-4000-8000-000000000001',
  assunto: 'Falha de acesso',
  remetente_email: 'solicitante@example.com',
  corpo_mensagem: 'Mensagem preservada',
  status: 'Aberto',
  prioridade: 'Alta',
  responsavel_id: '00000000-0000-4000-8000-000000000002',
  data_criacao: '2026-10-01T12:00:00Z',
  data_atualizacao: '2026-10-08T12:00:00.123456+00:00',
};

function board() {
  const state = new TicketKanbanState();
  state.replaceColumns(
    state.columns.map((column) => ({
      ...column,
      tickets: column.status === 'Aberto' ? [ticket] : [],
      total: column.status === 'Aberto' ? 21 : 0,
    })),
  );
  return state;
}

test('movimento é imediato, salva status real com versão exata e usa o retorno do servidor', async () => {
  const state = board();
  let complete!: (value: Ticket) => void;
  let sent: TicketUpdatePayload | undefined;
  const pending = state.move(ticket.id, 'Em Andamento', async (id, payload) => {
    assert.equal(id, ticket.id);
    sent = payload;
    return new Promise<Ticket>((resolve) => {
      complete = resolve;
    });
  });
  assert.equal(state.pendingId, ticket.id);
  assert.equal(state.columns[0].total, 20);
  assert.equal(state.columns[1].total, 1);
  assert.equal(state.columns[1].tickets[0].status, 'Em Andamento');
  assert.deepEqual(sent, {
    status: 'Em Andamento',
    expected_data_atualizacao: ticket.data_atualizacao,
  });
  const saved = {
    ...ticket,
    status: 'Em Andamento' as const,
    data_atualizacao: '2026-10-08T13:00:00Z',
  };
  complete(saved);
  assert.equal(await pending, true);
  assert.deepEqual(state.columns[1].tickets, [saved]);
  assert.equal(state.columns[1].tickets[0].responsavel_id, ticket.responsavel_id);
  assert.equal(state.pendingId, null);
});

test('falha restaura cartão e contagens e impede escrita até reconciliar o servidor', async () => {
  const state = board();
  const previous = structuredClone(state.columns);
  assert.equal(
    await state.move(ticket.id, 'Resolvido', async () => {
      throw new Error('Conflito 409');
    }),
    false,
  );
  assert.deepEqual(state.columns, previous);
  assert.equal(state.stale, true);
  assert.match(state.error, /Conflito 409/);
  assert.match(state.announcement, /voltou/);
  let calls = 0;
  await state.move(ticket.id, 'Resolvido', async () => {
    calls++;
    return ticket;
  });
  assert.equal(calls, 0);
  state.replaceColumns(previous);
  assert.equal(state.stale, false);
});

test('duplo movimento e atualização durante gravação não sobrescrevem o estado otimista', async () => {
  const state = board();
  let complete!: (value: Ticket) => void;
  const pending = state.move(
    ticket.id,
    'Resolvido',
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  let calls = 0;
  assert.equal(
    await state.move(ticket.id, 'Em Andamento', async () => {
      calls++;
      return ticket;
    }),
    false,
  );
  state.replaceColumns([]);
  assert.equal(state.columns.length, 3);
  assert.equal(state.columns[2].tickets.length, 1);
  assert.equal(calls, 0);
  complete({ ...ticket, status: 'Resolvido' });
  await pending;
});

test('mesma coluna, destino inválido e ticket inexistente não geram API', async () => {
  const state = board();
  let calls = 0;
  const persist = async () => {
    calls++;
    return ticket;
  };
  assert.equal(await state.move(ticket.id, 'Aberto', persist), false);
  assert.equal(await state.move(ticket.id, 'Inválido' as never, persist), false);
  assert.equal(await state.move('inexistente', 'Resolvido', persist), false);
  assert.equal(calls, 0);
});

test('resposta inconsistente ou versão ausente bloqueia novos movimentos', async () => {
  const state = board();
  assert.equal(await state.move(ticket.id, 'Resolvido', async () => ticket), false);
  assert.equal(state.stale, true);
  state.replaceColumns(
    state.columns.map((column) => ({
      ...column,
      tickets: column.tickets.map((row) => ({ ...row, data_atualizacao: '' })),
    })),
  );
  let calls = 0;
  assert.equal(
    await state.move(ticket.id, 'Resolvido', async () => {
      calls++;
      return ticket;
    }),
    false,
  );
  assert.equal(calls, 0);
  assert.equal(state.stale, true);
});
