import { z } from "zod";

export const signatureRequestIdSchema = z.string().uuid();

export const listSignatureRequestsSchema = z.object({
  status: z.enum(["Pendente", "Revisão necessária", "Gerada"]).optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});

export const updateSignatureRequestSchema = z
  .object({
    employee_name: z.string().trim().min(2).max(160).optional(),
    job_title: z.string().trim().min(2).max(160).optional(),
    phone: z.string().trim().min(8).max(40).optional(),
    corporate_email: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .max(255)
      .refine((value) => value.endsWith("@centaurotelecom.com.br"), {
        message: "Use o domínio @centaurotelecom.com.br.",
      })
      .optional(),
    photo_attachment_id: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Informe ao menos um campo para atualizar.",
  });
