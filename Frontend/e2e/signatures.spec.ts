import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const requestId = '00000000-0000-4000-8000-000000000001';
test.setTimeout(60000);

async function mockSignature(page: Page, photoSize = 1600) {
  // Fotografia sintética local: nenhum dado, autenticação ou storage real é acessado.
  await page.setContent('<html><body></body></html>');
  const photo = Buffer.from(await page.evaluate((size) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size * 1.5;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e9e0d1';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#416077';
    ctx.fillRect(size * .15, size * .55, size * .7, size);
    ctx.fillStyle = '#b58c6b';
    ctx.beginPath();
    ctx.arc(size / 2, size * .45, size * .2, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  }, photoSize), 'base64');
  const request = {
    id: requestId, source_ticket_id: null, source_sender_email: 'rh@example.com',
    employee_name: 'Charles da Silva Madeira', job_title: 'Supervisor Financeiro',
    phone: '21 98941-4762', corporate_email: 'charlesmadeira@centaurotelecom.com.br',
    status: 'Pendente', extraction_warnings: [], email_conflict: false,
    email_conflicts: { user_exists: false, requests: [] },
    archived_at: null, has_manual_photo: true, photo_attachment_id: null,
    images: [], history: [], created_at: '2026-11-05T12:00:00Z',
  };
  const generated: Buffer[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const headers = {
      'access-control-allow-origin': 'http://127.0.0.1:4207',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    };
    const json = (body: unknown) => route.fulfill({ json: body, headers });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/api/auth/me') return json({ success: true, user: {
      id: 'admin', nome: 'Administrador', email: 'admin@example.com', role: 'ADMIN', ativo: true,
    } });
    if (path === '/api/auth/activity') return json({ success: true });
    if (path.endsWith('/photo')) return route.fulfill({ body: photo, contentType: 'image/png', headers });
    if (path === '/api/signatures') return json({ data: [request], total: 1 });
    if (path.endsWith('/generate')) {
      const body = req.postDataBuffer()!;
      const start = body.indexOf(Buffer.from('89504e470d0a1a0a', 'hex'));
      const end = body.indexOf(Buffer.from('0000000049454e44ae426082', 'hex'), start) + 12;
      generated.push(body.subarray(start, end));
      return json({ data: { request: { ...request, status: 'Gerada' }, artifact_id: 'artifact', file_name: 'assinatura.png' } });
    }
    if (path === `/api/signatures/${requestId}`) return json({ data: request });
    return json({ data: [] });
  });
  await page.goto('/signatures');
  await expect(page.getByRole('heading', { name: 'Pré-visualização oficial' })).toBeVisible({ timeout: 30000 });
  return generated;
}

test('exporta vetores e foto em alta resolução na prévia e na geração oficial', async ({ page }, testInfo) => {
  const generated = await mockSignature(page);
  await expect(page.getByRole('button', { name: 'Baixar prévia de teste' })).toBeEnabled();
  await expect(page.getByText('Ampliar uma foto pequena', { exact: false })).toHaveCount(0);
  const previewDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar prévia de teste' }).click();
  const preview = await previewDownload;
  const exportPath = testInfo.outputPath('signature-export.png');
  await preview.saveAs(exportPath);
  const bytes = await readFile(exportPath);
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([2304, 600]);
  expect(generated).toHaveLength(0);
  const officialDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Gerar e baixar PNG' }).click();
  await officialDownload;
  expect(generated).toHaveLength(1);
  expect([generated[0].readUInt32BE(16), generated[0].readUInt32BE(20)]).toEqual([2304, 600]);
  expect(generated[0].equals(bytes)).toBe(true);
});

test('avisa sobre foto pequena e permite a exportação', async ({ page }) => {
  await mockSignature(page, 200);
  await expect(page.getByRole('alert')).toContainText('200 × 300 px');
  await expect(page.getByRole('alert')).toContainText('558 × 558 px');
  await expect(page.getByRole('button', { name: 'Baixar prévia de teste' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Gerar e baixar PNG' })).toBeEnabled();
});

test('falha no SVG impede exportação incompleta', async ({ page }) => {
  await page.route('**/assets/signatures/icones-centauro.svg', (route) => route.abort());
  await mockSignature(page);
  await expect(page.getByRole('status').filter({ hasText: 'Prévia de teste indisponível:' })).toContainText('fontes ou os ícones');
  await expect(page.getByRole('button', { name: 'Baixar prévia de teste' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Gerar e baixar PNG' })).toBeDisabled();
});
