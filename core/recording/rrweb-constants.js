/**
 * rrweb-constants.js — Named constants for rrweb event types and sources.
 *
 * These mirror the rrweb EventType and IncrementalSource enums.
 * Using named constants instead of magic numbers throughout the codebase.
 *
 * Reference: https://github.com/rrweb-io/rrweb/blob/master/packages/types/src/index.ts
 */

// ---------------------------------------------------------------------------
// EventType — top-level event classification
// ---------------------------------------------------------------------------

export const EventType = {
  DomContentLoaded: 0,
  Load: 1,
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
  Plugin: 6,
};

// ---------------------------------------------------------------------------
// IncrementalSource — sub-type for IncrementalSnapshot events
// ---------------------------------------------------------------------------

export const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
  TouchMove: 6,
  MediaInteraction: 7,
  StyleSheetRule: 8,
  CanvasMutation: 9,
  Font: 10,
  Log: 11,
  Drag: 12,
  StyleDeclaration: 13,
  Selection: 14,
  AdoptedStyleSheet: 15,
  CustomElement: 16,
};

// ---------------------------------------------------------------------------
// MouseInteraction — sub-type for MouseInteraction events
// ---------------------------------------------------------------------------

export const MouseInteraction = {
  MouseUp: 0,
  MouseDown: 1,
  Click: 2,
  ContextMenu: 3,
  DblClick: 4,
  Focus: 5,
  Blur: 6,
  TouchStart: 7,
  TouchMove_Departed: 8,
  TouchEnd: 9,
  TouchCancel: 10,
};
