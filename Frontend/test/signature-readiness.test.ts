import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canDownloadSignaturePreview,
  canGenerateOfficialSignature,
  type OfficialSignatureRequirements,
  type PreviewRequirements,
} from '../src/app/core/utils/signature-readiness.ts';

const ready: OfficialSignatureRequirements = {
  selected: true,
  archived: false,
  fieldsValid: true,
  hasUnsavedChanges: false,
  emailConflict: false,
  photoReady: true,
  photoLoading: false,
  templateReady: true,
  busy: false,
};

const preview: PreviewRequirements = {
  selected: true,
  fieldsComplete: true,
  photoReady: true,
  photoLoading: false,
  templateReady: true,
  busy: false,
};

test('geração oficial habilita automaticamente quando todos os requisitos estão satisfeitos', () => {
  assert.equal(canGenerateOfficialSignature(ready), true);
});

test('geração oficial permanece bloqueada por duplicidade, conta, alterações, foto ou arquivamento', () => {
  for (const change of [
    { emailConflict: true },
    { hasUnsavedChanges: true },
    { photoReady: false },
    { archived: true },
    { busy: true },
  ]) {
    assert.equal(canGenerateOfficialSignature({ ...ready, ...change }), false);
  }
});

test('prévia de teste não depende da unicidade do e-mail, mas exige imagem e modelo prontos', () => {
  assert.equal(canDownloadSignaturePreview(preview), true);
  assert.equal(canDownloadSignaturePreview({ ...preview, photoReady: false }), false);
  assert.equal(canDownloadSignaturePreview({ ...preview, templateReady: false }), false);
  assert.equal(canDownloadSignaturePreview({ ...preview, busy: true }), false);
});
