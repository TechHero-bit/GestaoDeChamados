import express from "express";
import cors from "cors";
import helmet from "helmet";
import ticketRoutes from "./routes/ticket.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import { errorMiddleware } from "./middlewares/error.middleware.js";

const app = express();

// Segurança
app.use(helmet());

// CORS — restrito ao frontend
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:4200",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "x-webhook-secret"],
  }),
);

// Body parser com limite de tamanho
app.use(express.json({ limit: "100kb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Rotas
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
