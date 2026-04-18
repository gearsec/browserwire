/**
 * schema.js — Zod schemas for the state machine manifest.
 *
 * The manifest represents a site as a state machine:
 *   - States are nodes (what you see + what you can do)
 *   - Actions on a state are edges (to_state → destination state)
 *
 * Views and actions carry executable Playwright code alongside
 * structured signatures (inputs/returns) that define their API.
 * The code is the implementation; the signature is the contract.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// View schema (what you can SEE at a state)
// ---------------------------------------------------------------------------

export const viewReturnFieldSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "date", "array", "object"]),
  description: z.string().optional(),
});

export const paginationSchema = z.object({
  type: z.enum(["infinite_scroll"]),
  scroll_target: z.string().optional().describe("CSS selector for the scrollable container. Omit for window scroll."),
});

export const viewSchema = z.object({
  name: z.string(),
  description: z.string(),
  isList: z.boolean(),
  returns: z.array(viewReturnFieldSchema).describe("Fields returned by this view"),
  code: z.string().describe("Playwright async function body: (page) => { ... }"),
  pagination: paginationSchema.optional().describe("Set when the view targets an infinite-scroll list"),
});

// ---------------------------------------------------------------------------
// Action schema (what you can DO at a state)
// ---------------------------------------------------------------------------

export const actionInputSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string().optional(),
  widget: z.enum([
    "text", "email", "password", "tel", "url", "number",
    "date", "time", "select", "multiselect",
    "checkbox", "radio", "file", "combobox", "textarea",
  ]).optional(),
  options: z.array(z.string()).optional(),
  format: z.string().optional(),
  default_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  selector: z.string().optional(),
});

export const actionSchema = z.object({
  name: z.string(),
  kind: z.enum(["click", "form_submit", "navigation", "input", "toggle", "select"]),
  description: z.string(),
  inputs: z.array(actionInputSchema).optional(),
  to_state: z.string().describe("Destination state after executing this action"),
  code: z.string().describe("Playwright async function body: (page, inputs) => { ... }"),
});

// ---------------------------------------------------------------------------
// Workflow schema (compositions of actions and views across states)
// ---------------------------------------------------------------------------

export const workflowStepSchema = z.object({
  state: z.string().describe("State name where this step executes"),
  action: z.string().optional().describe("Action name to execute (mutation step)"),
  view: z.string().optional().describe("View name to execute (data-gathering step)"),
});

export const workflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepSchema).min(1),
});

// ---------------------------------------------------------------------------
// State signature (for deduplication)
// ---------------------------------------------------------------------------

export const stateSignatureSchema = z.object({
  page_purpose: z.string(),
  views: z.array(z.string()),
  actions: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// State schema (a node in the state machine)
// ---------------------------------------------------------------------------

export const stateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  url_pattern: z.string(),
  signature: stateSignatureSchema,
  views: z.array(viewSchema),
  actions: z.array(actionSchema),
});

// ---------------------------------------------------------------------------
// Top-level state machine manifest
// ---------------------------------------------------------------------------

export const stateMachineManifestSchema = z.object({
  domain: z.string(),
  domainDescription: z.string().optional(),
  initial_state: z.string(),
  states: z.array(stateSchema).min(1),
  workflows: z.array(workflowSchema).default([]),
});
