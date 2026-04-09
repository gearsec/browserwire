import { describe, it, expect } from "vitest";
import { detectTransitions } from "../../core/discovery/session-processor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  index: number,
  opts: { trigger?: { kind: string }; hasTree?: boolean } = {}
) {
  return {
    eventIndex: index * 100,
    url: `http://example.com/page${index}`,
    title: `Page ${index}`,
    rrwebTree: opts.hasTree === false ? null : { node: { type: 0 } },
    screenshot: null,
    trigger: opts.trigger || null,
  };
}

function makeGroups(
  ...labels: Array<{ label: string; name: string }>
) {
  return labels.map(({ label, name }) => ({
    stateLabel: label,
    stateIdentity: { name },
    isFirstOccurrence: true,
    representative: {},
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectTransitions", () => {
  it("empty snapshots → empty specs", () => {
    expect(detectTransitions([], [], null)).toEqual([]);
  });

  it("single snapshot → no transitions", () => {
    const snapshots = [makeSnapshot(0)];
    expect(detectTransitions(snapshots, [], null)).toEqual([]);
  });

  it("two snapshots with click trigger → one spec with eventRange", () => {
    const snapshots = [
      makeSnapshot(0),
      makeSnapshot(1, { trigger: { kind: "click" } }),
    ];
    const groups = makeGroups({ label: "s0", name: "Home" });
    const specs: any[] = detectTransitions(snapshots, groups, null);

    expect(specs).toHaveLength(1);
    expect(specs[0].index).toBe(0);
    expect(specs[0].triggerKind).toBe("click");
    expect(specs[0].stateInfo).toEqual({ name: "Home" });
    expect(specs[0].eventRange).toEqual({ start: 1, end: 100 });
  });

  it("skips non-actionable triggers (scroll, resize, focus)", () => {
    const snapshots = [
      makeSnapshot(0),
      makeSnapshot(1, { trigger: { kind: "scroll" } }),
      makeSnapshot(2, { trigger: { kind: "resize" } }),
      makeSnapshot(3, { trigger: { kind: "focus" } }),
    ];
    const groups = makeGroups(
      { label: "s0", name: "Home" },
      { label: "s0", name: "Home" },
      { label: "s0", name: "Home" },
    );
    expect(detectTransitions(snapshots, groups, null)).toEqual([]);
  });

  it("detects all ACTION_TRIGGERS kinds (click, dblclick, touch, navigation)", () => {
    const kinds = ["click", "dblclick", "touch", "navigation"];
    const snapshots = [makeSnapshot(0)];
    for (let i = 0; i < kinds.length; i++) {
      snapshots.push(makeSnapshot(i + 1, { trigger: { kind: kinds[i] } }));
    }

    const specs = detectTransitions(snapshots, makeGroups(
      ...Array(snapshots.length).fill({ label: "s0", name: "Page" })
    ), null);

    expect(specs).toHaveLength(kinds.length);
    for (let i = 0; i < kinds.length; i++) {
      expect(specs[i].triggerKind).toBe(kinds[i]);
    }
  });

  it("skips snapshots without rrwebTree", () => {
    const snapshots = [
      makeSnapshot(0, { hasTree: false }),
      makeSnapshot(1, { trigger: { kind: "click" } }),
    ];
    const groups = makeGroups({ label: "s0", name: "Home" });

    expect(detectTransitions(snapshots, groups, null)).toEqual([]);
  });

  it("skips snapshots with no trigger", () => {
    const snapshots = [
      makeSnapshot(0),
      makeSnapshot(1), // no trigger
    ];
    expect(detectTransitions(snapshots, [], null)).toEqual([]);
  });

  it("multiple transitions — click detected, scroll and type skipped", () => {
    const snapshots = [
      makeSnapshot(0),
      makeSnapshot(1, { trigger: { kind: "click" } }),
      makeSnapshot(2, { trigger: { kind: "scroll" } }), // skipped
      makeSnapshot(3, { trigger: { kind: "click" } }),   // detected
    ];
    const groups = makeGroups(
      { label: "s0", name: "Home" },
      { label: "s1", name: "Form" },
      { label: "s1", name: "Form" },
      { label: "s1", name: "Form" },
    );
    const specs = detectTransitions(snapshots, groups, null);

    expect(specs).toHaveLength(2);
    expect(specs[0].index).toBe(0);
    expect(specs[0].triggerKind).toBe("click");
    expect(specs[1].index).toBe(2);
    expect(specs[1].triggerKind).toBe("click");
  });

  it("handles groups shorter than snapshots", () => {
    const snapshots = [
      makeSnapshot(0),
      makeSnapshot(1, { trigger: { kind: "click" } }),
      makeSnapshot(2, { trigger: { kind: "click" } }),
    ];
    const groups = makeGroups({ label: "s0", name: "Home" });
    const specs = detectTransitions(snapshots, groups, null);

    expect(specs).toHaveLength(2);
    expect(specs[0].stateInfo).toEqual({ name: "Home" });
    expect(specs[1].stateInfo).toBeNull();
  });

  it("eventRange spans from source eventIndex+1 to destination eventIndex", () => {
    const snapshots = [
      makeSnapshot(0),                                     // eventIndex: 0
      makeSnapshot(1, { trigger: { kind: "click" } }),     // eventIndex: 100
      makeSnapshot(2, { trigger: { kind: "click" } }),     // eventIndex: 200
    ];
    const groups = makeGroups(
      { label: "s0", name: "Home" },
      { label: "s1", name: "Form" },
    );
    const specs: any[] = detectTransitions(snapshots, groups, null);

    expect(specs[0].eventRange).toEqual({ start: 1, end: 100 });
    expect(specs[1].eventRange).toEqual({ start: 101, end: 200 });
  });
});
