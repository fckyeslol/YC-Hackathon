import { describe, test, expect } from "vitest";
import { harvestReviews, parseJudgment, raterIdFor, type TeracHarvestPort } from "./harvest.js";
import type { Poll } from "../store/types.js";
import type { Submission, SubmissionAnswers } from "../clients/terac.js";

const POLL: Poll = {
  id: "poll-1",
  prompt: "¿Apruebas este consejo?",
  options: ["rechazar", "editar", "aprobar"],
  status: "open",
  createdAt: "2026-07-24T00:00:00.000Z",
  teracOpportunityId: "opp-1",
};

const AT = "2026-07-24T12:00:00.000Z";

/** Build a fake Terac port from a list of (submission, answers). */
function fakePort(rows: Array<{ sub: Submission; answers: SubmissionAnswers }>): TeracHarvestPort {
  return {
    listSubmissions: async () => ({ data: rows.map((r) => r.sub) }),
    getSubmissionAnswers: async (_opp, subId) => rows.find((r) => r.sub.id === subId)!.answers,
  };
}

function sub(id: string, participant: string, status: Submission["status"]): Submission {
  return { id, opportunity_id: "opp-1", status, participant_id: participant, created_at: AT, updated_at: AT };
}

function answers(id: string, participant: string, choice: string, advice?: string): SubmissionAnswers {
  return {
    submission_id: id,
    participant_id: participant,
    responses: [
      { prompt: "Tu veredicto", value: choice },
      ...(advice ? [{ prompt: "Consejo libre", value: advice }] : []),
    ],
  };
}

describe("parseJudgment (BR-T3, BR-T9 isolated)", () => {
  test("maps a chosen option to its label index + extracts advice", () => {
    const j = parseJudgment(POLL, answers("s1", "p1", "aprobar", "ojo con las suscripciones"));
    expect(j?.label).toBe(2);
    expect(j?.adviceText).toBe("ojo con las suscripciones");
  });

  test("returns null when no valid option was chosen (abstain, not guessed)", () => {
    const j = parseJudgment(POLL, answers("s1", "p1", "no sé"));
    expect(j).toBeNull();
  });
});

describe("harvestReviews (BR-T3/T4/T7/T8)", () => {
  test("BR-T3/T4 — completed submissions become terac votes and aggregate via Dawid–Skene", async () => {
    const port = fakePort([
      { sub: sub("s1", "p1", "awaiting_review"), answers: answers("s1", "p1", "aprobar") },
      { sub: sub("s2", "p2", "approved"), answers: answers("s2", "p2", "aprobar") },
      { sub: sub("s3", "p3", "awaiting_review"), answers: answers("s3", "p3", "editar") },
      { sub: sub("s4", "p4", "in_progress"), answers: answers("s4", "p4", "aprobar") }, // excluded
    ]);

    const { votes, consensus } = await harvestReviews(POLL, port, { at: AT });

    expect(votes).toHaveLength(3); // in_progress excluded
    expect(votes.every((v) => v.channel === "terac")).toBe(true);
    expect(consensus.dawidSkene).not.toBeNull();
    expect(consensus.dawidSkene?.labelText).toBe("aprobar"); // 2 aprobar vs 1 editar
  });

  test("BR-T7 — re-harvest does not duplicate votes (deterministic per participant)", async () => {
    const port = fakePort([{ sub: sub("s1", "p1", "approved"), answers: answers("s1", "p1", "aprobar") }]);
    const first = await harvestReviews(POLL, port, { at: AT });
    const second = await harvestReviews(POLL, port, { at: AT });
    expect(second.votes).toEqual(first.votes);
    expect(second.votes).toHaveLength(1);
  });

  test("BR-T8 — advice carrying PII is dropped (label still counts)", async () => {
    const port = fakePort([
      { sub: sub("s1", "p1", "approved"), answers: answers("s1", "p1", "aprobar", "llamá a Juan Pérez al 3001234567") },
    ]);
    const { votes, droppedAdvice } = await harvestReviews(POLL, port, { at: AT });
    expect(votes).toHaveLength(1); // the vote (label) survives
    expect(droppedAdvice).toBe(1); // the leaky advice was flagged for dropping
  });

  test("BR-T8 — rater id is opaque and poll-scoped (no cross-review linkage)", () => {
    const a = raterIdFor("poll-1", "p1");
    const b = raterIdFor("poll-2", "p1"); // same participant, different review
    expect(a).not.toBe(b);
    expect(a).not.toContain("p1");
  });
});
