// Preparação offline: este módulo não é importado pelo app e não chama serviços externos.
import { createHash } from "node:crypto";

const progressByStatus = { Aberto: 0, "Em Andamento": 50, Resolvido: 100 };

export function statusToPlannerProgress(status) {
  if (!Object.hasOwn(progressByStatus, status)) throw new Error("Status inválido para sincronização.");
  return progressByStatus[status];
}

export function plannerProgressToStatus(progress) {
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new Error("Progresso do Planner deve ser inteiro entre 0 e 100.");
  }
  return progress === 0 ? "Aberto" : progress === 100 ? "Resolvido" : "Em Andamento";
}

/** Compara valores de negócio, evitando eco provocado apenas por timestamps/ETags. */
export function decidePlannerSync({ lastSyncedStatus, portalStatus, plannerPercentComplete }) {
  statusToPlannerProgress(portalStatus);
  const plannerStatus = plannerProgressToStatus(plannerPercentComplete);
  if (!lastSyncedStatus) return "baseline_required";
  statusToPlannerProgress(lastSyncedStatus);
  if (portalStatus === plannerStatus) return "noop";
  const portalChanged = portalStatus !== lastSyncedStatus;
  const plannerChanged = plannerStatus !== lastSyncedStatus;
  if (portalChanged && plannerChanged) return "conflict";
  return portalChanged ? "portal_to_planner" : "planner_to_portal";
}

export function plannerSyncIdempotencyKey({ ticketId, origin, version, status }) {
  statusToPlannerProgress(status);
  if (!["portal", "planner"].includes(origin) || typeof ticketId !== "string" || !ticketId
      || typeof version !== "string" || !version || version.length > 1024) {
    throw new Error("Identidade do evento de sincronização inválida.");
  }
  return createHash("sha256").update(JSON.stringify([ticketId, origin, version, status])).digest("hex");
}
