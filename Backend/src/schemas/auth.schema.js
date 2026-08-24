import { z } from "zod";

export const loginSchema = z.object({
  email: z
    .string({ required_error: "E-mail é obrigatório." })
    .trim()
    .email("Formato de e-mail inválido.")
    .toLowerCase(),
  password: z
    .string({ required_error: "Senha é obrigatória." })
    .min(1, "Senha é obrigatória."),
});
