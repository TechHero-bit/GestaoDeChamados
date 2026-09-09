export type AttachmentUploadState = 'pending' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface ReplyAttachmentProgress {
  file: File;
  uploaded: number;
  progress: number;
  state: AttachmentUploadState;
}

export function updateAttachmentProgress(
  items: ReplyAttachmentProgress[],
  index: number,
  uploaded: number,
  state: AttachmentUploadState,
): ReplyAttachmentProgress[] {
  return items.map((item, currentIndex) => {
    if (currentIndex !== index) return item;
    const safeUploaded = Math.max(0, Math.min(item.file.size, uploaded));
    const progress =
      item.file.size > 0 ? Math.min(100, Math.round((safeUploaded / item.file.size) * 100)) : 0;
    return { ...item, uploaded: safeUploaded, progress, state };
  });
}

export function markUnfinishedAttachments(
  items: ReplyAttachmentProgress[],
  cancelled: boolean,
): ReplyAttachmentProgress[] {
  const state = cancelled ? 'cancelled' : 'error';
  return items.map((item) => (item.state === 'done' ? item : { ...item, state }));
}
