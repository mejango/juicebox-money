import { describe, expect, it } from "vitest";
import { APPROVAL_STATUS, planRulesetQueue } from "@/lib/ruleset-queue";

const current = { id: 10n, cycleNumber: 7n, start: 100, duration: 30 };
const queued = { id: 11n, cycleNumber: 8n, start: 130, duration: 30 };
const tail = { id: 12n, cycleNumber: 9n, start: 160, duration: 30 };

describe("planRulesetQueue", () => {
  it("bases a new queue on the current ruleset when nothing distinct is queued", () => {
    const plan = planRulesetQueue({
      current,
      upcoming: { ...current },
      latest: { ...current },
      latestApprovalStatus: APPROVAL_STATUS.Active,
    });
    expect(plan.defaultAction).toBe("current");
    expect(plan.options).toEqual([
      expect.objectContaining({ action: "current", source: current, mustStartAtOrAfter: 0 }),
    ]);
  });

  it("offers replace and append while approval is expected", () => {
    const plan = planRulesetQueue({
      current,
      upcoming: queued,
      latest: queued,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.options.map((option) => option.action)).toEqual(["replace", "after"]);
    expect(plan.defaultAction).toBe("after");
    expect(plan.options[0].mustStartAtOrAfter).toBe(queued.start);
    expect(plan.options[1].mustStartAtOrAfter).toBe(queued.start + queued.duration);
  });

  it("only appends after an approved queued cycle", () => {
    const plan = planRulesetQueue({
      current,
      upcoming: queued,
      latest: queued,
      latestApprovalStatus: APPROVAL_STATUS.Approved,
    });
    expect(plan.options.map((option) => option.action)).toEqual(["after"]);
  });

  it("only replaces a failed queued ruleset", () => {
    const plan = planRulesetQueue({
      current,
      upcoming: queued,
      latest: queued,
      latestApprovalStatus: APPROVAL_STATUS.Failed,
    });
    expect(plan.options.map((option) => option.action)).toEqual(["replace"]);
  });

  it("uses the queue tail for both replacement and append", () => {
    const plan = planRulesetQueue({
      current,
      upcoming: queued,
      latest: tail,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.hasMultipleQueuedRulesets).toBe(true);
    expect(plan.options[0]).toEqual(expect.objectContaining({ action: "replace", source: tail }));
    expect(plan.options[1]).toEqual(expect.objectContaining({ action: "after", source: tail }));
  });

  it("preserves earlier queued rules and replaces a non-final tail", () => {
    const plan = planRulesetQueue({
      current,
      upcoming: queued,
      latest: tail,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.options[0]).toEqual(
      expect.objectContaining({ action: "replace", source: tail }),
    );
  });

  it("requires a date to append after a flexible queued ruleset", () => {
    const flexible = { ...queued, duration: 0 };
    const plan = planRulesetQueue({
      current,
      upcoming: flexible,
      latest: flexible,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.options.find((option) => option.action === "after")).toEqual(
      expect.objectContaining({ requiresStartDate: true, mustStartAtOrAfter: null }),
    );
  });
});
