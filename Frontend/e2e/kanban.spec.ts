import { test, expect, type Page } from '@playwright/test';

const admin = {
  id: '00000000-0000-4000-8000-000000000999',
  nome: 'Ana Ribeiro',
  email: 'ana@example.com',
  role: 'ADMIN',
  ativo: true,
};
const timestamp = '2026-10-08T12:00:00.123456+00:00';
const primaryId = '00000000-0000-4000-8000-000000000001';

async function mockPortal(page: Page) {
  const state = {
    tickets: Array.from({ length: 23 }, (_, i) => ({
      id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      assunto: i === 0 ? 'Configurar acesso' : 'Chamado de teste ' + (i + 1),
      remetente_nome: 'Solicitante ' + (i + 1),
      remetente_email: 'cliente' + i + '@example.com',
      corpo_mensagem: 'Conteúdo de teste local',
      status: i < 21 ? 'Aberto' : i === 21 ? 'Em Andamento' : 'Resolvido',
      prioridade: i % 2 === 0 ? 'Alta' : 'Normal',
      responsavel_id: i % 2 === 0 ? admin.id : null,
      responsavel: i % 2 === 0 ? admin : null,
      data_criacao: '2026-10-01T12:00:00Z',
      data_atualizacao:
        i === 0 ? timestamp : '2026-10-07T12:00:' + String(i).padStart(2, '0') + 'Z',
    })),
    writes: [] as Array<Record<string, string>>,
    failWrites: false,
    wait: undefined as Promise<void> | undefined,
  };
  // Todos os endpoints da API são simulados, inclusive autenticação. Nenhum acesso ao Supabase.
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
        headers: {
          'access-control-allow-origin': 'http://127.0.0.1:4207',
          'access-control-allow-credentials': 'true',
        },
      });
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': 'http://127.0.0.1:4207',
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    if (url.pathname === '/api/auth/me') return json({ success: true, user: admin });
    if (url.pathname === '/api/auth/activity') return json({ success: true });
    if (url.pathname === '/api/tickets/responsaveis') return json({ success: true, data: [admin] });
    if (url.pathname === '/api/tickets' && req.method() === 'GET') {
      const query = url.searchParams;
      const filtered = state.tickets
        .filter(
          (ticket) =>
            (!query.get('status') || query.get('status') === ticket.status) &&
            (!query.get('prioridade') || query.get('prioridade') === ticket.prioridade) &&
            (!query.get('responsavel_id') ||
              (query.get('responsavel_id') === 'none'
                ? !ticket.responsavel_id
                : ticket.responsavel_id === query.get('responsavel_id'))) &&
            (!query.get('search') ||
              ticket.assunto.toLowerCase().includes(query.get('search')!.toLowerCase())),
        )
        .sort(
          (a, b) =>
            b.data_atualizacao.localeCompare(a.data_atualizacao) || b.id.localeCompare(a.id),
        );
      const pageNumber = Number(query.get('page') || 1);
      const size = Number(query.get('pageSize') || 10);
      return json({
        success: true,
        data: filtered.slice((pageNumber - 1) * size, pageNumber * size),
        total: filtered.length,
        page: pageNumber,
        page_size: size,
      });
    }
    const id = url.pathname.split('/').pop();
    const ticket = state.tickets.find((row) => row.id === id);
    if (ticket && req.method() === 'PUT') {
      const body = req.postDataJSON();
      state.writes.push(body);
      if (state.wait) await state.wait;
      if (state.failWrites)
        return json({ success: false, message: 'Falha simulada ao salvar' }, 502);
      if (body.expected_data_atualizacao !== ticket.data_atualizacao) {
        return json({ success: false, message: 'O chamado foi alterado por outro atendente' }, 409);
      }
      ticket.status = body.status;
      ticket.data_atualizacao = '2026-10-08T14:00:00Z';
      return json({ success: true, data: ticket });
    }
    if (ticket && req.method() === 'GET')
      return json({ success: true, data: { ...ticket, messages: [] } });
    return json({ success: false, message: 'Endpoint não simulado' }, 404);
  });
  await page.goto('/dashboard');
  await expect(page.locator('[data-kanban-refresh]')).toBeEnabled();
  await expect(column(page, 'Em curso').getByRole('combobox')).toHaveValue('Em Andamento');
  await expect(column(page, 'Concluídos').getByRole('combobox')).toHaveValue('Resolvido');
  return state;
}

const column = (page: Page, status: string) =>
  page.locator('.kanban-column').filter({ has: page.locator('h3', { hasText: status }) });
const card = (page: Page, status: string) =>
  column(page, status).locator('.kanban-ticket').filter({ hasText: 'Configurar acesso' });

test('arrastar salva com versão, mantém paginação completa e reconsulta ao recarregar', async ({
  page,
}) => {
  const state = await mockPortal(page);
  await expect(column(page, 'A fazer').locator('.kanban-ticket')).toHaveCount(20);
  await column(page, 'A fazer').getByRole('button', { name: 'Carregar mais' }).click();
  await expect(column(page, 'A fazer').locator('.kanban-ticket')).toHaveCount(21);
  const handle = card(page, 'A fazer').locator('.kanban-handle');
  await handle.scrollIntoViewIfNeeded();
  const start = await handle.boundingBox();
  const end = await column(page, 'Em curso').locator('.kanban-drop-zone').boundingBox();
  if (!start || !end) throw new Error('Alça ou destino não encontrado');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 4 });
  await page.mouse.move(end.x + end.width / 2, end.y + 70, { steps: 20 });
  await expect(column(page, 'Em curso')).toHaveClass(/kanban-column-active/);
  await page.mouse.up();
  await expect(card(page, 'Em curso')).toBeVisible();
  await expect(page.locator('[data-kanban-refresh]')).toBeEnabled();
  expect(state.writes).toEqual([{ status: 'Em Andamento', expected_data_atualizacao: timestamp }]);
  await page.reload();
  await expect(card(page, 'Em curso')).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test('teclado move, bloqueia duplo envio e mantém foco depois da confirmação', async ({ page }) => {
  const state = await mockPortal(page);
  let release!: () => void;
  state.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const select = card(page, 'A fazer').getByRole('combobox');
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(card(page, 'Em curso')).toBeVisible();
  await expect(card(page, 'Em curso').getByRole('combobox')).toBeDisabled();
  await expect(page.locator('[data-kanban-refresh]')).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  release();
  await expect(page.locator('[data-kanban-refresh]')).toBeEnabled();
  await expect(card(page, 'Em curso').getByRole('combobox')).toBeFocused();
});

test('falha reverte cartão e contagens, anuncia erro e exige reconciliação', async ({ page }) => {
  const state = await mockPortal(page);
  state.failWrites = true;
  await card(page, 'A fazer').getByRole('combobox').selectOption('Resolvido');
  await expect(page.getByRole('alert')).toContainText('O cartão voltou à coluna anterior');
  await expect(card(page, 'A fazer')).toBeVisible();
  await expect(card(page, 'Concluídos')).toHaveCount(0);
  await expect(column(page, 'A fazer').locator('.kanban-count')).toHaveText('21');
  await expect(card(page, 'A fazer').getByRole('combobox')).toBeDisabled();
  await expect(page.locator('[data-kanban-refresh]')).toBeFocused();
  state.failWrites = false;
  await page.locator('[data-kanban-refresh]').click();
  await expect(card(page, 'A fazer').getByRole('combobox')).toBeEnabled();
});

test('conflito preserva a alteração do outro atendente e atualização concilia o quadro', async ({
  page,
}) => {
  const state = await mockPortal(page);
  const current = state.tickets.find((ticket) => ticket.id === primaryId)!;
  current.status = 'Resolvido';
  current.data_atualizacao = '2026-10-08T13:00:00Z';
  await card(page, 'A fazer').getByRole('combobox').selectOption('Em Andamento');
  await expect(page.getByRole('alert')).toContainText('outro atendente');
  expect(current.status).toBe('Resolvido');
  await page.locator('[data-kanban-refresh]').click();
  await expect(card(page, 'Concluídos')).toBeVisible();
});

test('filtros atingem toda a fila e preserva acesso à visão geral e detalhes', async ({ page }) => {
  await mockPortal(page);
  await page.getByRole('searchbox', { name: 'Buscar chamado' }).fill('Configurar acesso');
  await page.getByRole('button', { name: 'Filtrar', exact: true }).click();
  await expect(column(page, 'A fazer').locator('.kanban-ticket')).toHaveCount(1);
  await expect(column(page, 'Em curso').locator('.kanban-ticket')).toHaveCount(0);
  await page.getByRole('button', { name: 'Visão geral', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chamados recentes' })).toBeVisible();
  await page.getByRole('button', { name: 'Quadro', exact: true }).click();
  await card(page, 'A fazer').getByRole('link', { name: 'Configurar acesso' }).click();
  await expect(page).toHaveURL(new RegExp('/tickets/' + primaryId));
});

test('tela estreita mantém colunas acessíveis por rolagem e operação touch', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await mockPortal(page);
  await expect(card(page, 'A fazer')).toBeVisible();
  // Seletor nativo é alternativa touch, sem depender da precisão de um gesto de arraste.
  await card(page, 'A fazer').getByRole('combobox').selectOption('Resolvido');
  await expect(page.locator('[data-kanban-refresh]')).toBeEnabled();
  await expect(card(page, 'Concluídos')).toHaveCount(1);
  expect(
    await page
      .locator('.kanban-grid')
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await card(page, 'Concluídos').scrollIntoViewIfNeeded();
  await expect(card(page, 'Concluídos')).toBeVisible();
  await context.close();
});

test('arraste touch transfere entre colunas após pressionar a alça', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const state = await mockPortal(page);
  const handle = card(page, 'A fazer').locator('.kanban-handle');
  await handle.scrollIntoViewIfNeeded();
  const start = await handle.boundingBox();
  const end = await column(page, 'Em curso').locator('.kanban-drop-zone').boundingBox();
  if (!start || !end) throw new Error('Alça ou destino touch não encontrado');
  const session = await context.newCDPSession(page);
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }],
  });
  // Pressão pelo tempo configurado pelo CDK, antes de mover o dedo.
  await page.waitForTimeout(220);
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          id: 1,
          radiusX: 8,
          radiusY: 8,
          force: 1,
          x: x + ((end.x + end.width / 2 - x) * step) / 12,
          y: y + ((end.y + 70 - y) * step) / 12,
        },
      ],
    });
  }
  await expect(column(page, 'Em curso')).toHaveClass(/kanban-column-active/);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(card(page, 'Em curso')).toBeVisible();
  await expect(page.locator('[data-kanban-refresh]')).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  await context.close();
});

test('soltar na mesma coluna ou fora do quadro não grava status', async ({ page }) => {
  const state = await mockPortal(page);
  const handle = card(page, 'A fazer').locator('.kanban-handle');
  await handle.scrollIntoViewIfNeeded();
  const start = await handle.boundingBox();
  if (!start) throw new Error('Alça não encontrada');
  await page.mouse.move(start.x + 10, start.y + 10);
  await page.mouse.down();
  await page.mouse.move(start.x - 40, start.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect(card(page, 'A fazer')).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await handle.scrollIntoViewIfNeeded();
  await page.mouse.move(start.x + 10, start.y + 10);
  await page.mouse.down();
  await page.mouse.move(10, 10, { steps: 15 });
  await page.mouse.up();
  await expect(card(page, 'A fazer')).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test('prévia desktop e móvel para inspeção visual', async ({ page }, testInfo) => {
  await mockPortal(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: testInfo.outputPath('kanban-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('aside')).not.toBeInViewport();
  await page.getByRole('heading', { name: 'Quadro de chamados' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('kanban-mobile.png'), fullPage: false });
});
