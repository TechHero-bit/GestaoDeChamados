import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  CorporateSignatureStatus,
  SignatureRequest,
  SignatureRequestUpdate,
} from '../../../../core/models/signature-request.model';
import { SignatureRequestService } from '../../../../core/services/signature-request.service';
import {
  canDownloadSignaturePreview,
  canGenerateOfficialSignature,
} from '../../../../core/utils/signature-readiness';
import { prepareSignaturePhoto, signaturePhotoWarning } from '../../../../core/utils/signature-photo';

interface SignatureForm {
  employee_name: string;
  job_title: string;
  phone: string;
  corporate_email: string;
}

@Component({
  selector: 'app-signatures-page',
  imports: [FormsModule],
  templateUrl: './signatures.page.html',
  styleUrl: './signatures.page.css',
})
export class SignaturesPage implements OnInit, AfterViewInit, OnDestroy {
  private readonly service = inject(SignatureRequestService);
  private readonly template = new Image();
  private vectorIcons = new Image();
  private readonly objectUrls = new Set<string>();
  private photoImage: HTMLCanvasElement | null = null;
  private imageLoadVersion = 0;
  private readonly templateLoadError = signal('');

  @ViewChild('signatureCanvas')
  private canvasRef?: ElementRef<HTMLCanvasElement>;

  readonly requests = signal<SignatureRequest[]>([]);
  readonly selected = signal<SignatureRequest | null>(null);
  readonly candidateUrls = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly loadingDetail = signal(false);
  readonly saving = signal(false);
  readonly generating = signal(false);
  readonly previewDownloading = signal(false);
  readonly photoReady = signal(false);
  readonly photoLoading = signal(false);
  readonly photoWarning = signal('');
  readonly templateReady = signal(false);
  readonly candidateErrors = signal<Record<string, string>>({});
  readonly error = signal('');
  readonly success = signal('');
  readonly total = signal(0);
  readonly archiving = signal(false);
  readyToGenerate(): boolean {
    const request = this.selected();
    return canGenerateOfficialSignature({
      selected: Boolean(request),
      archived: Boolean(request?.archived_at),
      fieldsValid: !this.hasInvalidFormFields(),
      hasUnsavedChanges: this.hasUnsavedChanges(),
      emailConflict: Boolean(request?.email_conflict),
      photoReady: this.photoReady(),
      photoLoading: this.photoLoading(),
      templateReady: this.templateReady(),
      busy: this.saving() || this.generating() || this.previewDownloading(),
    }) && !this.generationBlockedReason();
  }

  hasUnsavedChanges(): boolean {
    const request = this.selected();
    if (!request) return false;
    return this.form.employee_name.trim() !== (request.employee_name || '') ||
      this.form.job_title.trim() !== (request.job_title || '') ||
      this.form.phone.trim() !== (request.phone || '') ||
      this.form.corporate_email.trim().toLowerCase() !== (request.corporate_email || '').toLowerCase();
  }

  fieldError(field: keyof SignatureForm): string {
    const value = this.form[field].trim();
    if (field === 'employee_name' && value.length < 2) return 'Informe o nome completo do colaborador.';
    if (field === 'job_title' && value.length < 2) return 'Informe a função do colaborador.';
    if (field === 'phone' && (value.length < 8 || value.length > 40)) return 'Informe um telefone válido (8 a 40 caracteres).';
    if (field === 'corporate_email') {
      if (!/^[a-z0-9][a-z0-9._-]*@centaurotelecom\.com\.br$/i.test(value)) return 'Use um e-mail válido @centaurotelecom.com.br.';
      const request = this.selected();
      if (request && value.toLowerCase() === (request.corporate_email || '').toLowerCase()) {
        if (request.email_conflicts?.user_exists) return 'Este e-mail já pertence a um usuário cadastrado; onboarding não pode atualizar uma assinatura existente.';
        if (request.email_conflicts?.requests.length) return 'Este e-mail está em outra solicitação ativa. Arquive a duplicada ou use outro e-mail.';
      }
    }
    return '';
  }

  hasInvalidFormFields(): boolean {
    return this.form.employee_name.trim().length < 2 || this.form.job_title.trim().length < 2 ||
      this.form.phone.trim().length < 8 || this.form.phone.trim().length > 40 ||
      !/^[a-z0-9][a-z0-9._-]*@centaurotelecom\.com\.br$/i.test(this.form.corporate_email.trim());
  }

  completedSteps(): { label: string; done: boolean }[] {
    const request = this.selected();
    return [
      { label: 'Dados', done: Boolean(this.form.employee_name.trim() && this.form.job_title.trim() && this.form.phone.trim() && /^[a-z0-9][a-z0-9._-]*@centaurotelecom\.com\.br$/i.test(this.form.corporate_email.trim())) && !this.hasUnsavedChanges() },
      { label: 'E-mail livre', done: Boolean(request && !request.email_conflict && !this.hasUnsavedChanges()) },
      { label: 'Fotografia', done: this.photoReady() },
      { label: 'Modelo', done: this.templateReady() },
    ];
  }

  readyToDownloadPreview(): boolean {
    return canDownloadSignaturePreview({
      selected: Boolean(this.selected()),
      fieldsComplete: Boolean(this.form.employee_name.trim() && this.form.job_title.trim() && this.form.phone.trim() && this.form.corporate_email.trim()),
      photoReady: this.photoReady(),
      photoLoading: this.photoLoading(),
      templateReady: this.templateReady(),
      busy: this.saving() || this.generating() || this.previewDownloading(),
    }) && !this.previewBlockedReason();
  }

  previewBlockedReason(): string {
    if (!this.selected()) return 'Selecione uma solicitação.';
    if (!this.form.employee_name.trim() || !this.form.job_title.trim() ||
        !this.form.phone.trim() || !this.form.corporate_email.trim()) {
      return 'Preencha os quatro campos para testar a imagem.';
    }
    if (this.photoLoading()) return 'Carregando a fotografia para a prévia de teste…';
    if (!this.photoReady()) return 'Selecione ou envie uma fotografia válida para testar a imagem.';
    if (!this.templateReady()) return this.templateLoadError() || 'Carregando o modelo visual da assinatura…';
    return '';
  }

  generationBlockedReason(): string {
    const request = this.selected();
    if (!request) return 'Selecione uma solicitação.';
    if (request.archived_at) return 'Esta solicitação está arquivada. Consulte o histórico; não é possível gerar novas versões.';
    if (this.hasInvalidFormFields()) {
      return 'Corrija os campos indicados antes da geração oficial.';
    }
    if (this.hasUnsavedChanges()) return 'Há alterações pendentes. Salve os dados para revalidar o e-mail.';
    if (!this.form.employee_name.trim() || !this.form.job_title.trim() ||
        !this.form.phone.trim() || !this.form.corporate_email.trim()) {
      return 'Preencha nome, função, telefone e e-mail corporativo.';
    }
    if (!/^[a-z0-9][a-z0-9._-]*@centaurotelecom\.com\.br$/i.test(this.form.corporate_email.trim())) {
      return 'Informe um e-mail válido @centaurotelecom.com.br.';
    }
    if (request.email_conflicts?.user_exists) return 'O e-mail pertence a um usuário cadastrado. É necessário um fluxo separado de atualização de assinatura.';
    if (request.email_conflicts?.requests.length) return 'O e-mail aparece em outra solicitação ativa. Arquive a solicitação duplicada ou informe outro e-mail.';
    if (request.email_conflict) return 'O conflito do e-mail ainda não foi revalidado. Salve os dados.';
    if (!request.photo_attachment_id && !request.has_manual_photo) return 'Selecione ou envie uma fotografia.';
    if (this.photoLoading()) return 'Carregando a fotografia selecionada…';
    if (!this.photoReady()) return 'A fotografia não pôde ser carregada. Consulte o aviso acima ou envie outra foto.';
    if (!this.templateReady()) return this.templateLoadError() || 'Carregando o modelo visual da assinatura…';
    return '';
  }

  statusFilter: CorporateSignatureStatus | '' = '';
  search = '';
  form: SignatureForm = {
    employee_name: '',
    job_title: '',
    phone: '',
    corporate_email: '',
  };

  ngOnInit(): void {
    this.loadList();
  }

  ngAfterViewInit(): void {
    this.template.onload = async () => {
      try {
        const [spartan, poppins, icons] = await Promise.all([
          new FontFace('Signature League Spartan', 'url(/assets/signatures/fonts/LeagueSpartan.ttf)', { weight: '100 900' }).load(),
          new FontFace('Signature Poppins', 'url(/assets/signatures/fonts/Poppins-Regular.ttf)').load(),
          this.loadImage('/assets/signatures/icones-centauro.svg'),
        ]);
        document.fonts.add(spartan);
        document.fonts.add(poppins);
        this.vectorIcons = icons;
        this.templateReady.set(this.template.naturalWidth === 800 && this.template.naturalHeight === 200);
        await this.drawPreview();
      } catch {
        this.templateReady.set(false);
        this.templateLoadError.set('Não foi possível carregar as fontes ou os ícones da assinatura. Atualize a página para tentar novamente.');
        this.error.set(this.templateLoadError());
      }
    };
    this.template.onerror = () => {
      this.templateReady.set(false);
      this.templateLoadError.set('O modelo visual obrigatório não pôde ser carregado.');
      this.error.set(this.templateLoadError());
    };
    this.template.src = '/assets/signatures/modelo-centauro-hd.svg';
  }

  loadList(preferredId?: string): void {
    this.loading.set(true);
    this.error.set('');
    this.service.list(this.statusFilter, this.search, true).subscribe({
      next: (response) => {
        this.requests.set(response.data);
        this.total.set(response.total);
        this.loading.set(false);
        const target =
          response.data.find((item) => item.id === preferredId) ??
          response.data.find((item) => item.id === this.selected()?.id) ??
          response.data[0];
        if (target) this.selectRequest(target.id);
        else this.clearSelection();
      },
      error: (error: Error) => {
        this.loading.set(false);
        this.error.set(error.message);
      },
    });
  }

  selectRequest(id: string): void {
    if (this.loadingDetail()) return;
    this.loadingDetail.set(true);
    this.error.set('');
    this.success.set('');
    this.service.get(id).subscribe({
      next: (request) => {
        this.loadingDetail.set(false);
        this.applyRequest(request);
      },
      error: (error: Error) => {
        this.loadingDetail.set(false);
        this.error.set(error.message);
      },
    });
  }

  async save(): Promise<void> {
    const request = this.selected();
    if (!request || this.saving()) return;
    if (this.hasInvalidFormFields()) {
      this.error.set('Revise os campos indicados antes de salvar.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const updated = await firstValueFrom(
        this.service.update(request.id, this.formPayload()),
      );
      this.applyRequest(updated, false);
      this.success.set('Dados salvos e duplicidade de e-mail verificada.');
      this.refreshListRow(updated);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  async selectCandidate(attachmentId: string): Promise<void> {
    const request = this.selected();
    if (!request || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const updated = await firstValueFrom(
        this.service.update(request.id, { photo_attachment_id: attachmentId }),
      );
      this.applyRequest(updated, true, 'Fotografia selecionada. Revise a prévia antes de gerar.');
      this.refreshListRow(updated);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  async uploadPhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const request = this.selected();
    input.value = '';
    if (!file || !request || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      const updated = await firstValueFrom(
        this.service.uploadPhoto(request.id, file),
      );
      this.applyRequest(updated, true, 'Nova fotografia enviada e selecionada.');
      this.refreshListRow(updated);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.saving.set(false);
    }
  }

  async generateAndDownload(): Promise<void> {
    const current = this.selected();
    if (!current || !this.readyToGenerate()) return;
    this.generating.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const saved = await firstValueFrom(
        this.service.update(current.id, this.formPayload()),
      );
      this.applyRequest(saved, false);
      await this.drawPreview();
      const png = await this.exportPreviewPng();
      const result = await firstValueFrom(this.service.generate(saved.id, png));
      this.applyRequest(result.request, false);
      this.refreshListRow(result.request);
      this.downloadPng(png, result.file_name);
      this.success.set('Assinatura gerada, baixada e registrada no histórico.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.generating.set(false);
    }
  }

  async archiveSelected(): Promise<void> {
    const request = this.selected();
    if (!request || request.archived_at || this.archiving()) return;
    const reason = window.prompt('Informe o motivo do arquivamento (ex.: solicitação de teste duplicada):');
    if (!reason || reason.trim().length < 5) return;
    if (!window.confirm(`Arquivar a solicitação de ${request.employee_name || 'colaborador'}? Ela será preservada no histórico e não será excluída.`)) return;
    this.archiving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const archived = await firstValueFrom(this.service.archive(request.id, reason.trim()));
      this.success.set('Solicitação arquivada com rastreabilidade. Nenhum registro ou versão foi excluído.');
      this.refreshListRow(archived);
      this.loadList(archived.id);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.archiving.set(false);
    }
  }

  async downloadPreview(): Promise<void> {
    if (!this.readyToDownloadPreview()) return;
    this.previewDownloading.set(true);
    this.error.set('');
    this.success.set('');
    try {
      await this.drawPreview();
      const png = await this.exportPreviewPng();
      const name = this.form.employee_name.trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      this.downloadPng(png, `previa-assinatura-${name || 'teste'}.png`);
      this.success.set('Prévia de teste baixada. Nenhuma versão foi registrada no histórico.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.previewDownloading.set(false);
    }
  }

  schedulePreview(): void {
    void this.drawPreview();
  }

  artifactUrl(artifactId: string): string {
    const request = this.selected();
    return request ? this.service.artifactUrl(request.id, artifactId) : '#';
  }

  formatDate(value: string | null): string {
    if (!value) return '—';
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  statusTone(status: CorporateSignatureStatus): string {
    if (status === 'Gerada') return 'status-generated';
    if (status === 'Pendente') return 'status-pending';
    return 'status-review';
  }

  ngOnDestroy(): void {
    this.revokeObjectUrls();
  }

  private formPayload(): SignatureRequestUpdate {
    return {
      employee_name: this.form.employee_name.trim(),
      job_title: this.form.job_title.trim(),
      phone: this.form.phone.trim(),
      corporate_email: this.form.corporate_email.trim().toLowerCase(),
    };
  }

  private applyRequest(request: SignatureRequest, reloadImages = true, photoSuccessMessage = ''): void {
    this.selected.set(request);
    this.form = {
      employee_name: request.employee_name || '',
      job_title: request.job_title || '',
      phone: request.phone || '',
      corporate_email: request.corporate_email || '',
    };
    if (reloadImages) this.loadImages(request, photoSuccessMessage);
    else void this.drawPreview();
  }

  private refreshListRow(request: SignatureRequest): void {
    this.requests.update((items) =>
      items.map((item) => (item.id === request.id ? { ...item, ...request } : item)),
    );
  }

  private clearSelection(): void {
    this.imageLoadVersion += 1;
    this.selected.set(null);
    this.form = { employee_name: '', job_title: '', phone: '', corporate_email: '' };
    this.revokeObjectUrls();
    this.photoImage = null;
    this.photoReady.set(false);
    this.photoLoading.set(false);
    this.photoWarning.set('');
    this.candidateErrors.set({});
    this.drawBlankCanvas();
  }

  private loadImages(request: SignatureRequest, photoSuccessMessage = ''): void {
    const version = ++this.imageLoadVersion;
    this.revokeObjectUrls();
    this.candidateUrls.set({});
    this.candidateErrors.set({});
    this.photoImage = null;
    this.photoReady.set(false);
    this.photoWarning.set('');
    this.photoLoading.set(Boolean(request.photo_attachment_id || request.has_manual_photo));
    this.success.set('');

    for (const image of request.images) {
      if (image.processing_status !== 'Disponivel') continue;
      this.service.loadCandidate(request.id, image.attachment_id).subscribe({
        next: (blob) => {
          if (version !== this.imageLoadVersion) return;
          const url = URL.createObjectURL(blob);
          this.objectUrls.add(url);
          this.candidateUrls.update((values) => ({ ...values, [image.attachment_id]: url }));
        },
        error: (error: Error) => {
          if (version !== this.imageLoadVersion) return;
          this.candidateErrors.update((values) => ({
            ...values,
            [image.attachment_id]: error.message,
          }));
        },
      });
    }

    if (request.photo_attachment_id || request.has_manual_photo) {
      const selectedCandidate = request.images.find(
        (image) => image.attachment_id === request.photo_attachment_id,
      );
      if (selectedCandidate && selectedCandidate.processing_status !== 'Disponivel') {
        this.photoLoading.set(false);
        this.error.set(
          selectedCandidate.processing_status === 'Pendente'
            ? 'O anexo selecionado aguarda confirmação do Power Automate. Atualize a solicitação após concluir o fluxo.'
            : 'O upload do anexo selecionado falhou' +
              (selectedCandidate.processing_error ? ' (' + selectedCandidate.processing_error + ')' : '') +
              '. Envie outra foto.',
        );
        void this.drawPreview();
        return;
      }
      this.service.loadPhoto(request.id).subscribe({
        next: async (blob) => {
          if (version !== this.imageLoadVersion) return;
          const url = URL.createObjectURL(blob);
          this.objectUrls.add(url);
          try {
            const loaded = await this.loadImage(url);
            if (version !== this.imageLoadVersion) return;
            this.photoImage = prepareSignaturePhoto(loaded);
            this.photoReady.set(true);
            this.photoLoading.set(false);
            this.photoWarning.set(signaturePhotoWarning(loaded.naturalWidth, loaded.naturalHeight));
            this.error.set('');
            await this.drawPreview();
            if (photoSuccessMessage) this.success.set(photoSuccessMessage);
          } catch {
            if (version !== this.imageLoadVersion) return;
            this.photoLoading.set(false);
            this.error.set('A fotografia recebida não é uma imagem válida. Envie outra foto.');
            void this.drawPreview();
          }
        },
        error: (error: Error) => {
          if (version !== this.imageLoadVersion) return;
          this.photoLoading.set(false);
          this.error.set('Não foi possível carregar a fotografia: ' + error.message);
          void this.drawPreview();
        },
      });
    } else {
      void this.drawPreview();
    }
  }

  private async drawPreview(): Promise<void> {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || !this.templateReady()) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(canvas.width / 800, canvas.height / 200);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(this.template, 0, 0, 800, 200);
    context.drawImage(this.vectorIcons, 0, 0, 800, 200);

    // Modelo, logotipo e ícones vetoriais são desenhados na resolução de saída.
    // As regiões variáveis são apagadas antes de receber o conteúdo revisado.
    context.fillStyle = '#ffffff';
    context.fillRect(376, 24, 313, 43);
    context.fillRect(399, 89, 290, 80);

    context.save();
    context.beginPath();
    context.arc(232, 100, 93, 0, Math.PI * 2);
    context.clip();
    if (this.photoImage) {
      context.drawImage(this.photoImage, 139, 7, 186, 186);
    } else {
      context.fillStyle = '#f2f4f4';
      context.fillRect(139, 7, 186, 186);
    }
    context.restore();
    context.beginPath();
    context.arc(232, 100, 97, 0, Math.PI * 2);
    context.strokeStyle = '#ffffff';
    context.lineWidth = 8;
    context.stroke();

    context.save();
    context.letterSpacing = '-0.25px';
    const name = this.form.employee_name.trim().toUpperCase() || 'NOME SOBRENOME';
    // Mantém as coordenadas do modelo original de 800 × 200 exportado do Canva.
    let nameSize = 17.5;
    do {
      context.font = '800 ' + nameSize + 'px "Signature League Spartan"';
      if (context.measureText(name).width <= 300 || nameSize <= 11) break;
      nameSize -= 1;
    } while (nameSize > 11);
    context.textBaseline = 'alphabetic';
    const surnameStart = name.indexOf(' ');
    const firstName = surnameStart < 0 ? name : name.slice(0, surnameStart);
    const surname = surnameStart < 0 ? '' : name.slice(surnameStart);
    const nameWidth = context.measureText(name).width;
    context.translate(380, 0);
    context.scale(Math.min(1, 300 / nameWidth), 1);
    context.fillStyle = '#7d383d';
    context.fillText(firstName, 0, 44);
    context.fillStyle = '#484848';
    context.fillText(surname, context.measureText(firstName).width, 44);
    context.restore();

    context.font = (8.3 * 4 / 3) + 'px "Signature Poppins"';
    context.fillStyle = '#737373';
    context.fillText((this.form.job_title.trim() || 'CARGO/FUNÇÃO').toUpperCase(), 380, 59, 300);

    context.font = (7.4 * 4 / 3) + 'px "Signature Poppins"';
    context.fillStyle = '#380b0b';
    context.fillText(this.form.phone.trim() || '(21) 98476-3729', 400, 103, 286);
    context.fillText(
      this.form.corporate_email.trim() || 'email@centaurotelecom.com.br',
      400,
      123,
      286,
    );
    context.fillText('Rua Buenos Aires, Nº 15 - SL 801 - Centro', 400, 144, 286);
    context.fillText('www.centaurotelecom.com.br', 400, 165, 286);
    context.restore();
  }

  private drawBlankCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
  }

  private exportPreviewPng(): Promise<Blob> {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return Promise.reject(new Error('A prévia da assinatura não está disponível.'));
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Falha ao exportar o PNG.'))),
        'image/png',
      );
    });
  }

  private downloadPng(png: Blob, fileName: string): void {
    const url = URL.createObjectURL(png);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Imagem inválida.'));
      image.src = url;
    });
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }
}
