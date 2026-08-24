import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getSupabase } from "../src/config/supabase.js";

const adminSchema = z.object({
  nome: z.string().trim().min(2, "Nome deve ter no mínimo 2 caracteres"),
  email: z.string().trim().email("Formato de e-mail inválido").toLowerCase(),
  password: z
    .string()
    .min(8, "A senha deve conter no mínimo 8 caracteres"),
});

async function main() {
  console.log("==========================================");
  console.log("  Help Desk — Criação do Administrador   ");
  console.log("==========================================\n");

  const rl = readline.createInterface({ input, output });

  try {
    let nome = process.env.ADMIN_NAME || "";
    let email = process.env.ADMIN_EMAIL || "";
    let password = process.env.ADMIN_PASSWORD || "";

    if (!nome) {
      nome = (await rl.question("Nome do administrador: ")).trim();
    }
    if (!email) {
      email = (await rl.question("E-mail do administrador: ")).trim();
    }
    if (!password) {
      password = (await rl.question("Senha do administrador (mínimo 8 caracteres): ")).trim();
    }

    const validation = adminSchema.safeParse({ nome, email, password });
    if (!validation.success) {
      console.error("\n❌ Dados inválidos:");
      for (const err of validation.error.errors) {
        console.error(`   - ${err.message}`);
      }
      process.exit(1);
    }

    const validData = validation.data;
    const supabase = getSupabase();

    // Verificar se e-mail já existe
    const { data: existingUser, error: checkError } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", validData.email)
      .maybeSingle();

    if (checkError) {
      console.error("\n❌ Erro ao consultar o banco de dados:", checkError.message);
      process.exit(1);
    }

    if (existingUser) {
      console.error(`\n❌ Já existe um usuário cadastrado com o e-mail: ${validData.email}`);
      process.exit(1);
    }

    // Gerar hash seguro da senha com bcrypt
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(validData.password, saltRounds);

    // Inserir usuário administrador
    const { data: newUser, error: insertError } = await supabase
      .from("users")
      .insert({
        nome: validData.nome,
        email: validData.email,
        password_hash: passwordHash,
        role: "ADMIN",
        ativo: true,
      })
      .select("id, nome, email, role, ativo, data_criacao")
      .single();

    if (insertError) {
      console.error("\n❌ Erro ao cadastrar o administrador:", insertError.message);
      process.exit(1);
    }

    console.log("\n✅ Administrador criado com sucesso!");
    console.log(`   ID:    ${newUser.id}`);
    console.log(`   Nome:  ${newUser.nome}`);
    console.log(`   Email: ${newUser.email}`);
    console.log(`   Role:  ${newUser.role}`);
    console.log(`   Ativo: ${newUser.ativo}`);
  } catch (error) {
    console.error("\n❌ Erro inesperado:", error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
