/**
 * schema.js — Zod schemas for the state machine manifest.
 *
 * The manifest represents a site as a state machine:
 *   - States are nodes (what you see + what you can do)
 *   - Actions on a state are edges (leads_to → destination state)
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

export const viewSchema = z.object({
  name: z.string(),
  description: z.string(),
  isList: z.boolean(),
  returns: z.array(viewReturnFieldSchema).describe("Fields returned by this view"),
  code: z.string().describe("Playwright async function body: (page) => { ... }"),
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
  leads_to: z.string().optional(),
  form_group: z.string().optional().describe("Groups actions belonging to the same form (e.g. 'registration_form'). Actions sharing a form_group are replayed in sequence_order by a single workflow endpoint."),
  sequence_order: z.number().optional().describe("Execution order within the form_group (0, 1, 2, ...). The submit action gets the highest sequence_order."),
  code: z.string().describe("Playwright async function body: (page, inputs) => { ... }"),
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
});
