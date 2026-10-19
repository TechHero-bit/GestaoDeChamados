export interface OfficialSignatureRequirements {
  selected: boolean;
  archived: boolean;
  fieldsValid: boolean;
  hasUnsavedChanges: boolean;
  emailConflict: boolean;
  photoReady: boolean;
  photoLoading: boolean;
  templateReady: boolean;
  busy: boolean;
}

export function canGenerateOfficialSignature(state: OfficialSignatureRequirements): boolean {
  return state.selected && !state.archived && state.fieldsValid && !state.hasUnsavedChanges &&
    !state.emailConflict && state.photoReady && !state.photoLoading && state.templateReady && !state.busy;
}

export interface PreviewRequirements {
  selected: boolean;
  fieldsComplete: boolean;
  photoReady: boolean;
  photoLoading: boolean;
  templateReady: boolean;
  busy: boolean;
}

export function canDownloadSignaturePreview(state: PreviewRequirements): boolean {
  return state.selected && state.fieldsComplete && state.photoReady && !state.photoLoading &&
    state.templateReady && !state.busy;
}
