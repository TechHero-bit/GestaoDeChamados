import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorMiddleware } from "./middlewares/error.middleware.js";
import authRoutes from "./routes/auth.routes.js";
import microsoftIntegrationRoutes from "./routes/microsoft-integration.routes.js";
import ticketRoutes from "./routes/ticket.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

// Trust proxy para interpretação correta do IP real atrás da Vercel
app.set("trust proxy", 1);

// Segurança com Helmet
app.use(
  helmet({
    contentSecurityPolicy: false, // Desabilitado na API REST para evitar conflito com Angular SPA
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// CORS — Origens permitidas com suporte a credentials (cookies HttpOnly)
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:4200")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Permite chamadas sem header origin (como testes locais, webhooks do Power Automate, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Permite previews da Vercel se configurado
      if (
        process.env.ALLOW_VERCEL_PREVIEWS === "true" &&
        /^https:\/\/[a-zA-Z0-9_-]+\.vercel\.app$/.test(origin)
      ) {
        return callback(null, true);
      }

      return callback(new Error("Origem não permitida pela política CORS."));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-webhook-secret",
      "x-requested-with",
    ],
  }),
);

// Cookie Parser
app.use(cookieParser());

// Body parser com limite seguro de tamanho
app.use(express.json({ limit: "100kb" }));

// Prevenção de cache em endpoints de dados sensíveis e privados
app.use((req, res, next) => {
  if (
    req.path.startsWith("/api/tickets") ||
    req.path.startsWith("/api/auth") ||
    req.path.startsWith("/api/integrations/microsoft")
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

// Health check público
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Rotas da API
app.use("/api/auth", authRoutes);
app.use("/api/integrations/microsoft", microsoftIntegrationRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/webhooks", webhookRoutes);

// 404 para rotas não encontradas
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "Rota não encontrada.",
  });
});

// Middleware de erro centralizado
app.use(errorMiddleware);

export default app;
