import { describe, test, expect, vi } from "vitest";
import { guardedSend } from "./guardedSend.js";
import type { SendGuardState } from "./sendGuard.js";
import { text } from "../clients/linq.js";

const healthy = (): SendGuardState => ({ suppressed: false, healthStatus: "HEALTHY" });
const suppressed = (): SendGuardState => ({ suppressed: true, healthStatus: "HEALTHY" });
const critical = (): SendGuardState => ({ suppressed: false, healthStatus: "CRITICAL" });

describe("guardedSend (B2 — canSend is inevitable)", () => {
  test("delivers when the guard allows", async () => {
    const deliver = vi.fn(async () => {});
    const r = await guardedSend("+1", [text("hola")], healthy, deliver);
    expect(r.sent).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test("a suppressed recipient never receives; deliver is not called", async () => {
    const deliver = vi.fn(async () => {});
    const r = await guardedSend("+1", [text("hola")], suppressed, deliver);
    expect(r.sent).toBe(false);
    expect(r.decision.reason).toBe("suppressed");
    expect(deliver).not.toHaveBeenCalled();
  });

  test("a CRITICAL line is paused; deliver is not called", async () => {
    const deliver = vi.fn(async () => {});
    const r = await guardedSend("+1", [text("hola")], critical, deliver);
    expect(r.sent).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
