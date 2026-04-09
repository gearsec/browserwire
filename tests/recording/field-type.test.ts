import { describe, it, expect } from "vitest";
import { inferFieldType } from "../../core/discovery/tools-v2/field-type.js";

// ---------------------------------------------------------------------------
// Minimal SnapshotIndex stub — only implements getNode, getChildren, getDirectText
// ---------------------------------------------------------------------------

class FakeIndex {
  private nodes: Map<string, any>;

  constructor(nodes: Record<string, any>) {
    this.nodes = new Map(Object.entries(nodes));
  }

  getNode(ref: string) {
    return this.nodes.get(ref) || undefined;
  }

  getChildren(ref: string) {
    const node = this.nodes.get(ref);
    if (!node || !node.childRefs) return [];
    return node.childRefs
      .map((r: string) => this.nodes.get(r))
      .filter(Boolean);
  }

  getDirectText(ref: string) {
    const node = this.nodes.get(ref);
    return node ? (node.textParts || []).join(" ").trim() : "";
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inferFieldType", () => {
  it("returns null for unknown ref", () => {
    const index = new FakeIndex({});
    expect(inferFieldType(index as any, "e999")).toBeNull();
  });

  it("input type=text → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "text" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type=email → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "email" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type=password → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "password" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type=tel → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "tel" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type=url → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "url" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type=date → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "date" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type=number → number", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "number" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "number" });
  });

  it("input type=range → number", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "range" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "number" });
  });

  it("input type=checkbox → boolean", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "checkbox" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "boolean" });
  });

  it("input type=radio → boolean", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "radio" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "boolean" });
  });

  it("input with no type attribute → string (defaults to text)", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: {}, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("textarea → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "textarea", attributes: {}, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("select with option children → string with options", () => {
    const index = new FakeIndex({
      e1: {
        ref: "e1", tag: "select", attributes: {}, childRefs: ["e2", "e3", "e4"],
      },
      e2: { ref: "e2", tag: "option", attributes: { value: "us" }, childRefs: [], textParts: ["United States"] },
      e3: { ref: "e3", tag: "option", attributes: { value: "ca" }, childRefs: [], textParts: ["Canada"] },
      e4: { ref: "e4", tag: "option", attributes: { value: "uk" }, childRefs: [], textParts: ["United Kingdom"] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({
      type: "string",
      options: ["us", "ca", "uk"],
    });
  });

  it("select with options that have no value attr → uses text content", () => {
    const index = new FakeIndex({
      e1: {
        ref: "e1", tag: "select", attributes: {}, childRefs: ["e2", "e3"],
      },
      e2: { ref: "e2", tag: "option", attributes: {}, childRefs: [], textParts: ["Red"] },
      e3: { ref: "e3", tag: "option", attributes: {}, childRefs: [], textParts: ["Blue"] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({
      type: "string",
      options: ["Red", "Blue"],
    });
  });

  it("select with no options → string without options key", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "select", attributes: {}, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("select with optgroup → extracts options from nested groups", () => {
    const index = new FakeIndex({
      e1: {
        ref: "e1", tag: "select", attributes: {}, childRefs: ["g1", "g2"],
      },
      g1: {
        ref: "g1", tag: "optgroup", attributes: { label: "North America" },
        childRefs: ["o1", "o2"],
      },
      o1: { ref: "o1", tag: "option", attributes: { value: "us" }, childRefs: [], textParts: ["US"] },
      o2: { ref: "o2", tag: "option", attributes: { value: "ca" }, childRefs: [], textParts: ["CA"] },
      g2: {
        ref: "g2", tag: "optgroup", attributes: { label: "Europe" },
        childRefs: ["o3"],
      },
      o3: { ref: "o3", tag: "option", attributes: { value: "uk" }, childRefs: [], textParts: ["UK"] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({
      type: "string",
      options: ["us", "ca", "uk"],
    });
  });

  it("unknown element (div) → string", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "div", attributes: { role: "textbox" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "string" });
  });

  it("input type is case-insensitive", () => {
    const index = new FakeIndex({
      e1: { ref: "e1", tag: "input", attributes: { type: "NUMBER" }, childRefs: [] },
    });
    expect(inferFieldType(index as any, "e1")).toEqual({ type: "number" });
  });
});
