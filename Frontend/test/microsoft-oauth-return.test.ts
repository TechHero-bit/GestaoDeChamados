import assert from 'node:assert/strict';
import { test } from 'node:test';
import { microsoftOAuthLandingPath } from '../src/app/core/utils/microsoft-oauth-return.ts';

test('retorno Microsoft pela raiz abre Integrações com o resultado preservado', () => {
  assert.equal(
    microsoftOAuthLandingPath('connected'),
    '/settings/integrations?microsoft=connected',
  );
  assert.equal(microsoftOAuthLandingPath('error'), '/settings/integrations?microsoft=error');
});

test('entrada normal mantém Dashboard e resultados desconhecidos não alteram o destino', () => {
  for (const value of [
    undefined,
    null,
    '',
    'https://example.com',
    '//example.com',
    'connected&code=private',
  ]) {
    assert.equal(microsoftOAuthLandingPath(value), '/dashboard');
  }
});
