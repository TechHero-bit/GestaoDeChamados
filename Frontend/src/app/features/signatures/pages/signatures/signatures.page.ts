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

  @ViewChild('signatureCanvas')
  private canvasRef?: ElementRef<HTMLCanvasElement>;

  readonly requests = signal<SignatureRequest[]>([]);
  readonly selected = signal<SignatureRequest | null>(null);
  readonly candidateUrls = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly loadingDetail = signal(false);
  readonly saving = signal(false);
  readonly generating = signal(false);
  readonly photoReady = signal(false);
  readonly error = signal('');
  readonly success = signal('');
  readonly total = signal(0);
  readyToGenerate(): boolean {
    const request = this.selected();
    return Boolean(
      request &&
        this.form.employee_name.trim() &&
        this.form.job_title.trim() &&
        this.form.phone.trim() &&
        this.form.corporate_email.trim() &&
        (request.photo_attachment_id || request.has_manual_photo) &&
        this.photoReady() &&
        !request.email_conflict &&
        !this.saving() &&
        !this.generating(),
    );
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
    this.template.onload = () => this.drawPreview();
    this.template.onerror = () => {
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
    try {
      const updated = await firstValueFrom(
        this.service.update(request.id, { photo_attachment_id: attachmentId }),
      );
      this.applyRequest(updated);
      this.refreshListRow(updated);
      this.success.set('Fotografia selecionada. Revise a prévia antes de gerar.');
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
      this.applyRequest(updated);
      this.refreshListRow(updated);
      this.success.set('Nova fotografia enviada e selecionada.');
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
      const canvas = this.canvasRef?.nativeElement;
      if (!canvas) throw new Error('A prévia da assinatura não está disponível.');
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Falha ao exportar o PNG.'))),
          'image/png',
        );
      });
      const result = await firstValueFrom(this.service.generate(saved.id, png));
      this.applyRequest(result.request, false);
      this.refreshListRow(result.request);
      const url = URL.createObjectURL(png);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.file_name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.success.set('Assinatura gerada, baixada e registrada no histórico.');
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.generating.set(false);
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

  private applyRequest(request: SignatureRequest, reloadImages = true): void {
    this.selected.set(request);
    this.form = {
      employee_name: request.employee_name || '',
      job_title: request.job_title || '',
      phone: request.phone || '',
      corporate_email: request.corporate_email || '',
    };
    if (reloadImages) this.loadImages(request);
    else void this.drawPreview();
  }

  private refreshListRow(request: SignatureRequest): void {
    this.requests.update((items) =>
      items.map((item) => (item.id === request.id ? { ...item, ...request } : item)),
    );
  }

  private clearSelection(): void {
    this.selected.set(null);
    this.form = { employee_name: '', job_title: '', phone: '', corporate_email: '' };
    this.revokeObjectUrls();
    this.drawBlankCanvas();
  }

  private loadImages(request: SignatureRequest): void {
    this.revokeObjectUrls();
    this.candidateUrls.set({});
    this.photoImage = null;
    this.photoReady.set(false);
    for (const image of request.images) {
      if (image.processing_status !== 'Disponivel') continue;
      this.service.loadCandidate(request.id, image.attachment_id).subscribe({
        next: (blob) => {
          if (this.selected()?.id !== request.id) return;
          const url = URL.createObjectURL(blob);
          this.objectUrls.add(url);
          this.candidateUrls.update((values) => ({
            ...values,
            [image.attachment_id]: url,
          }));
        },
      });
    }
    if (request.photo_attachment_id || request.has_manual_photo) {
      this.service.loadPhoto(request.id).subscribe({
        next: async (blob) => {
          if (this.selected()?.id !== request.id) return;
          const url = URL.createObjectURL(blob);
          this.objectUrls.add(url);
          try {
            this.photoImage = await this.loadImage(url);
            this.photoReady.set(true);
            await this.drawPreview();
          } catch {
            this.error.set('A fotografia selecionada não pôde ser exibida.');
          }
        },
        error: () => {
          this.error.set('A fotografia ainda não está disponível no armazenamento.');
          void this.drawPreview();
        },
      });
    } else {
      void this.drawPreview();
    }
  }

  private async drawPreview(): Promise<void> {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || !this.template.complete || this.template.naturalWidth === 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, 768, 200);
    context.drawImage(this.template, 0, 0, 768, 200);

    if (this.photoImage) {
      context.save();
      context.beginPath();
      context.arc(236, 93, 93, 0, Math.PI * 2);
      context.clip();
      const imageRatio = this.photoImage.naturalWidth / this.photoImage.naturalHeight;
      const frameRatio = 1;
      let sourceWidth = this.photoImage.naturalWidth;
      let sourceHeight = this.photoImage.naturalHeight;
      let sourceX = 0;
      let sourceY = 0;
      if (imageRatio > frameRatio) {
        sourceWidth = sourceHeight * frameRatio;
        sourceX = (this.photoImage.naturalWidth - sourceWidth) / 2;
      } else {
        sourceHeight = sourceWidth / frameRatio;
        sourceY = (this.photoImage.naturalHeight - sourceHeight) / 2;
      }
      context.drawImage(
        this.photoImage,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        143,
        0,
        186,
        186,
      );
      context.restore();
      context.beginPath();
      context.arc(236, 93, 97, 0, Math.PI * 2);
      context.strokeStyle = '#ffffff';
      context.lineWidth = 8;
      context.stroke();
    }

    context.fillStyle = '#ffffff';
    context.fillRect(376, 24, 285, 43);
    context.fillRect(399, 87, 270, 38);

    const name = this.form.employee_name.trim().toUpperCase() || 'NOME SOBRENOME';
    const [firstName, ...surnameParts] = name.split(/\s+/);
    let fontSize = 16;
    do {
      context.font = `700 ${fontSize}px Arial, sans-serif`;
      const total = context.measureText(name).width;
      if (total <= 275 || fontSize <= 11) break;
      fontSize -= 1;
    } while (fontSize > 10);
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#7b2e36';
    context.fillText(firstName, 380, 44);
    const firstWidth = context.measureText(firstName).width;
    context.fillStyle = '#2f2b2c';
    if (surnameParts.length) {
      context.fillText(` ${surnameParts.join(' ')}`, 380 + firstWidth, 44);
    }

    context.font = '10px Arial, sans-serif';
    context.fillStyle = '#595355';
    context.fillText((this.form.job_title || 'CARGO/FUNÇÃO').toUpperCase(), 380, 60);

    context.font = '10px Arial, sans-serif';
    context.fillStyle = '#3f393b';
    context.fillText(this.form.phone || '(21) 98476-3729', 400, 103);
    context.fillText(
      this.form.corporate_email || 'email@centaurotelecom.com.br',
      400,
      123,
    );
  }

  private drawBlankCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
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
