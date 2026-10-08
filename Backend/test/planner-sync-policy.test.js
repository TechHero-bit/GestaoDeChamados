import assert from "node:assert/strict";
import { test } from "node:test";
import { statusToPlannerProgress, plannerProgressToStatus, decidePlannerSync, plannerSyncIdempotencyKey } from "../src/services/planner-sync-policy.js";

test("mapeia os três status e aceita progresso intermediário como Em Andamento", () => {
  for (const [status, progress] of [["Aberto", 0], ["Em Andamento", 50], ["Resolvido", 100]]) {
    assert.equal(statusToPlannerProgress(status), progress);
    assert.equal(plannerProgressToStatus(progress), status);
  }
  assert.equal(plannerProgressToStatus(25), "Em Andamento");
  assert.equal(plannerProgressToStatus(99), "Em Andamento");
  for (const value of [-1, 101, 1.5, "50", null]) assert.throws(() => plannerProgressToStatus(value));
  assert.throws(() => statusToPlannerProgress("Fechado"));
});

test("compara com a última situação conciliada, detecta conflito e não ecoa a sincronização", () => {
  const decide = (lastSyncedStatus, portalStatus, plannerPercentComplete) =>
    decidePlannerSync({ lastSyncedStatus, portalStatus, plannerPercentComplete });
  assert.equal(decide(null, "Aberto", 0), "baseline_required");
  assert.equal(decide("Aberto", "Em Andamento", 0), "portal_to_planner");
  assert.equal(decide("Aberto", "Aberto", 100), "planner_to_portal");
  assert.equal(decide("Aberto", "Em Andamento", 100), "conflict");
  assert.equal(decide("Aberto", "Resolvido", 100), "noop");
  assert.equal(decide("Em Andamento", "Em Andamento", 75), "noop");
});

test("evento repetido tem a mesma chave; versão e origem diferentes geram outra chave", () => {
  const event = { ticketId: "ticket-1", origin: "portal", version: "2026-10-08T12:00:00.123456Z", status: "Aberto" };
  assert.equal(plannerSyncIdempotencyKey(event), plannerSyncIdempotencyKey({ ...event }));
  assert.notEqual(plannerSyncIdempotencyKey(event), plannerSyncIdempotencyKey({ ...event, version: "outra-versao" }));
  assert.notEqual(plannerSyncIdempotencyKey(event), plannerSyncIdempotencyKey({ ...event, origin: "planner" }));
  assert.throws(() => plannerSyncIdempotencyKey({ ...event, version: "" }));
});
