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
  private readonly objectUrls = new Set<string>();
  private photoImage: HTMLImageElement | null = null;
  private imageLoadVersion = 0;

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
  readyToGenerate(): boolean {
    return !this.generationBlockedReason() && !this.saving() && !this.generating() && !this.previewDownloading();
  }

  readyToDownloadPreview(): boolean {
    return !this.previewBlockedReason() && !this.saving() && !this.generating() && !this.previewDownloading();
  }

  previewBlockedReason(): string {
    if (!this.selected()) return 'Selecione uma solicitação.';
    if (!this.form.employee_name.trim() || !this.form.job_title.trim() ||
        !this.form.phone.trim() || !this.form.corporate_email.trim()) {
      return 'Preencha os quatro campos para testar a imagem.';
    }
    if (this.photoLoading()) return 'Carregando a fotografia para a prévia de teste…';
    if (!this.photoReady()) return 'Selecione ou envie uma fotografia válida para testar a imagem.';
    if (!this.templateReady()) return 'Carregando o modelo visual da assinatura…';
    return '';
  }

  generationBlockedReason(): string {
    const request = this.selected();
    if (!request) return 'Selecione uma solicitação.';
    if (!this.form.employee_name.trim() || !this.form.job_title.trim() ||
        !this.form.phone.trim() || !this.form.corporate_email.trim()) {
      return 'Preencha nome, função, telefone e e-mail corporativo.';
    }
    if (!/^[a-z0-9][a-z0-9._-]*@centaurotelecom\.com\.br$/i.test(this.form.corporate_email.trim())) {
      return 'Informe um e-mail válido @centaurotelecom.com.br.';
    }
    if (request.email_conflict) return 'O e-mail está em uso. Corrija e salve os dados para verificar novamente.';
    if (!request.photo_attachment_id && !request.has_manual_photo) return 'Selecione ou envie uma fotografia.';
    if (this.photoLoading()) return 'Carregando a fotografia selecionada…';
    if (!this.photoReady()) return 'A fotografia não pôde ser carregada. Consulte o aviso acima ou envie outra foto.';
    if (!this.templateReady()) return 'Carregando o modelo visual da assinatura…';
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
    this.template.onload = () => {
      this.templateReady.set(this.template.naturalWidth === 800 && this.template.naturalHeight === 200);
      void this.drawPreview();
    };
    this.template.onerror = () => {
      this.templateReady.set(false);
      this.error.set('O modelo visual obrigatório não pôde ser carregado.');
    };
    this.template.src = '/assets/signatures/modelo-centauro-17.png';
  }

  loadList(preferredId?: string): void {
    this.loading.set(true);
    this.error.set('');
    this.service.list(this.statusFilter, this.search).subscribe({
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
            this.photoImage = loaded;
            this.photoReady.set(true);
            this.photoLoading.set(false);
            this.photoWarning.set(
              loaded.naturalWidth / loaded.naturalHeight > 1.7
                ? 'A imagem selecionada é muito larga para um retrato e pode ser uma assinatura de e-mail inteira. Confira a prévia ou envie uma foto de rosto.'
                : '',
            );
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

    context.clearRect(0, 0, 768, 200);
    context.save();
    context.scale(768 / 800, 1);
    context.drawImage(this.template, 0, 0, 800, 200);

    // O PNG original mantém grafismos, logotipo, ícones e dados fixos.
    // As regiões variáveis são apagadas antes de receber o conteúdo revisado.
    context.fillStyle = '#ffffff';
    context.fillRect(376, 24, 313, 43);
    context.fillRect(399, 89, 290, 40);

    context.save();
    context.beginPath();
    context.arc(232, 100, 93, 0, Math.PI * 2);
    context.clip();
    if (this.photoImage) {
      const image = this.photoImage;
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        139,
        7,
        186,
        186,
      );
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

    const name = this.form.employee_name.trim().toUpperCase() || 'NOME SOBRENOME';
    let nameSize = 16;
    do {
      context.font = '700 ' + nameSize + 'px Arial, sans-serif';
      if (context.measureText(name).width <= 300 || nameSize <= 11) break;
      nameSize -= 1;
    } while (nameSize > 11);
    context.textBaseline = 'alphabetic';
    const surnameStart = name.indexOf(' ');
    const firstName = surnameStart < 0 ? name : name.slice(0, surnameStart);
    const surname = surnameStart < 0 ? '' : name.slice(surnameStart);
    const nameWidth = context.measureText(name).width;
    context.save();
    context.translate(380, 0);
    context.scale(Math.min(1, 300 / nameWidth), 1);
    context.lineJoin = 'round';
    context.lineWidth = 1.3;
    context.fillStyle = '#7d383d';
    context.strokeStyle = '#7d383d';
    context.strokeText(firstName, 0, 44);
    context.fillText(firstName, 0, 44);
    context.fillStyle = '#484848';
    context.strokeStyle = '#484848';
    context.strokeText(surname, context.measureText(firstName).width, 44);
    context.fillText(surname, context.measureText(firstName).width, 44);
    context.restore();

    context.font = '10px Arial, sans-serif';
    context.fillStyle = '#595355';
    context.fillText((this.form.job_title.trim() || 'CARGO/FUNÇÃO').toUpperCase(), 380, 59, 300);

    context.font = '10px Arial, sans-serif';
    context.fillStyle = '#380b0b';
    context.fillText(this.form.phone.trim() || '(21) 98476-3729', 400, 103, 286);
    context.fillText(
      this.form.corporate_email.trim() || 'email@centaurotelecom.com.br',
      400,
      123,
      286,
    );
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
