import { describe, it, expect } from "vitest";
import { assignFormGroups } from "../../core/discovery/session-processor.js";

// ---------------------------------------------------------------------------
// Helper to build minimal groups (only stateLabel + stateIdentity needed)
// ---------------------------------------------------------------------------

function makeGroups(...labels: Array<{ label: string; name: string }>) {
  return labels.map(({ label, name }) => ({
    stateLabel: label,
    stateIdentity: { name },
    isFirstOccurrence: true,
    representative: {},
  }));
}

function makeAction(snapshotIndex: number, kind: "input" | "click", name?: string) {
  return {
    name: name || `action_${snapshotIndex + 1}_${kind}`,
    kind,
    description: `Transition`,
    inputs: [],
    code: "async (page) => {}",
    _snapshotIndex: snapshotIndex,
    _triggerKind: kind === "input" ? "type" : "click",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assignFormGroups", () => {
  it("no actions → no-op", () => {
    const actions: any[] = [];
    assignFormGroups(actions, []);
    expect(actions).toEqual([]);
  });

  it("single click action → no form_group", () => {
    const groups = makeGroups({ label: "s0", name: "Home" });
    const actions = [makeAction(0, "click")];
    assignFormGroups(actions, groups);

    expect(actions[0].form_group).toBeUndefined();
    expect(actions[0].sequence_order).toBeUndefined();
  });

  it("input + input + click on same state → form_group with sequence_order", () => {
    const groups = makeGroups(
      { label: "s0", name: "Registration" },
      { label: "s0", name: "Registration" },
      { label: "s0", name: "Registration" },
    );
    const actions = [
      makeAction(0, "input", "fill_name"),
      makeAction(1, "input", "fill_email"),
      makeAction(2, "click", "submit"),
    ];
    assignFormGroups(actions, groups);

    expect(actions[0].form_group).toBe("registration_form");
    expect(actions[0].sequence_order).toBe(0);
    expect(actions[0].kind).toBe("input");

    expect(actions[1].form_group).toBe("registration_form");
    expect(actions[1].sequence_order).toBe(1);
    expect(actions[1].kind).toBe("input");

    expect(actions[2].form_group).toBe("registration_form");
    expect(actions[2].sequence_order).toBe(2);
    expect(actions[2].kind).toBe("form_submit"); // converted from click
  });

  it("actions on different states → separate groups", () => {
    const groups = makeGroups(
      { label: "s0", name: "Home" },
      { label: "s1", name: "Login" },
      { label: "s1", name: "Login" },
    );
    const actions = [
      makeAction(0, "click", "nav_to_login"),
      makeAction(1, "input", "fill_username"),
      makeAction(2, "click", "login_submit"),
    ];
    assignFormGroups(actions, groups);

    // First action is a standalone click on s0 — no form_group
    expect(actions[0].form_group).toBeUndefined();

    // Second and third are input + click on s1 → form_group
    expect(actions[1].form_group).toBe("login_form");
    expect(actions[1].sequence_order).toBe(0);

    expect(actions[2].form_group).toBe("login_form");
    expect(actions[2].sequence_order).toBe(1);
    expect(actions[2].kind).toBe("form_submit");
  });

  it("only inputs on same state (no final click) → no form_group", () => {
    const groups = makeGroups(
      { label: "s0", name: "Search" },
      { label: "s0", name: "Search" },
    );
    const actions = [
      makeAction(0, "input", "fill_query"),
      makeAction(1, "input", "fill_filter"),
    ];
    assignFormGroups(actions, groups);

    // No click at end → not a form pattern
    expect(actions[0].form_group).toBeUndefined();
    expect(actions[1].form_group).toBeUndefined();
  });

  it("only click on same state → no form_group", () => {
    const groups = makeGroups({ label: "s0", name: "Home" });
    const actions = [makeAction(0, "click", "click_button")];
    assignFormGroups(actions, groups);

    expect(actions[0].form_group).toBeUndefined();
    expect(actions[0].kind).toBe("click"); // not converted to form_submit
  });

  it("state name with spaces → underscore in form_group", () => {
    const groups = makeGroups(
      { label: "s0", name: "Create Calendar" },
      { label: "s0", name: "Create Calendar" },
    );
    const actions = [
      makeAction(0, "input", "fill_name"),
      makeAction(1, "click", "submit"),
    ];
    assignFormGroups(actions, groups);

    expect(actions[0].form_group).toBe("create_calendar_form");
  });
});
