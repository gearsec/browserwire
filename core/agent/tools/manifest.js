/**
 * manifest.js — Tools for reading and writing the manifest.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * @param {{ manifest: import('../../manifest/manifest.js').StateMachineManifest }} ctx
 */
export function manifestTools(ctx) {
  const read_manifest = tool(
    async () => JSON.stringify(ctx.manifest.toSummary(), null, 2),
    {
      name: "read_manifest",
      description: "Get the current manifest summary — states, views, actions, workflows. Code is omitted to keep context small. Use this to check what has been discovered so far.",
      schema: z.object({}),
    }
  );

  const add_state = tool(
    async ({ name, description, url_pattern, page_purpose }) => {
      const id = ctx.manifest.addState({
        name,
        description,
        url_pattern,
        signature: { page_purpose, views: [], actions: [] },
      });
      if (!ctx.manifest.initial_state) ctx.manifest.initial_state = id;
      return `State added: ${id}`;
    },
    {
      name: "add_state",
      description: "Add a new state (page) to the manifest. Returns the assigned state ID (e.g. 's0').",
      schema: z.object({
        name: z.string().describe("Snake_case state name, e.g. 'product_listing'"),
        description: z.string().describe("What this page/state represents"),
        url_pattern: z.string().describe("URL pattern (RFC 6570 template), e.g. 'https://example.com/products/{id}'"),
        page_purpose: z.string().describe("One-line purpose of the page, e.g. 'Browse and filter products'"),
      }),
    }
  );

  const add_view = tool(
    async ({ stateId, name, description, isList, returns, code, pagination }) => {
      const state = ctx.manifest.getState(stateId);
      if (!state) return `Error: state ${stateId} not found`;
      const view = { name, description, isList, returns: JSON.parse(returns), code };
      if (pagination) view.pagination = JSON.parse(pagination);
      ctx.manifest.mergeViews(stateId, [view]);
      state.signature.views = state.views.map((v) => v.name);
      return `View '${name}' added to ${stateId}`;
    },
    {
      name: "add_view",
      description:
        "Add a data extraction view to a state. The code must be a Playwright async function: async (page) => { ... } that returns the extracted data.",
      schema: z.object({
        stateId: z.string().describe("Target state ID, e.g. 's0'"),
        name: z.string().describe("Snake_case view name, e.g. 'product_list'"),
        description: z.string().describe("What data this view extracts"),
        isList: z.boolean().describe("True if the view returns an array of items"),
        returns: z.string().describe('JSON array of return field descriptors, e.g. \'[{"name":"title","type":"string","description":"Product title"}]\''),
        code: z.string().describe("Playwright async function: async (page) => { ... }"),
        pagination: z.string().optional().describe('Optional JSON pagination config, e.g. \'{"type":"infinite_scroll","scroll_target":".list"}\''),
      }),
    }
  );

  const add_action = tool(
    async ({ stateId, name, kind, description, inputs, to_state, code }) => {
      const state = ctx.manifest.getState(stateId);
      if (!state) return `Error: state ${stateId} not found`;
      const action = {
        name,
        kind,
        description,
        inputs: JSON.parse(inputs),
        code,
      };
      if (to_state) action.to_state = to_state;
      ctx.manifest.mergeActions(stateId, [action]);
      state.signature.actions = state.actions.map((a) => a.name);
      return `Action '${name}' added to ${stateId}`;
    },
    {
      name: "add_action",
      description:
        "Add an interaction action to a state. The code must be a Playwright async function: async (page, inputs) => { ... } that performs the action.",
      schema: z.object({
        stateId: z.string().describe("Target state ID, e.g. 's0'"),
        name: z.string().describe("Snake_case action name, e.g. 'search_products'"),
        kind: z.enum(["form_submit", "click", "input", "toggle", "select", "navigation"]).describe("Action kind"),
        description: z.string().describe("What this action does"),
        inputs: z.string().describe('JSON array of input descriptors, e.g. \'[{"name":"query","type":"string","required":true,"description":"Search query"}]\''),
        to_state: z.string().optional().describe("Destination state ID after this action, e.g. 's1'"),
        code: z.string().describe("Playwright async function: async (page, inputs) => { ... }"),
      }),
    }
  );

  const update_view = tool(
    async ({ stateId, viewName, code }) => {
      const ok = ctx.manifest.updateView(stateId, viewName, { code });
      return ok ? `View '${viewName}' updated in ${stateId}` : `Error: view '${viewName}' not found in ${stateId}`;
    },
    {
      name: "update_view",
      description: "Update the code of an existing view. Use this to fix broken extraction code.",
      schema: z.object({
        stateId: z.string().describe("State ID containing the view"),
        viewName: z.string().describe("Name of the view to update"),
        code: z.string().describe("New Playwright async function: async (page) => { ... }"),
      }),
    }
  );

  const update_action = tool(
    async ({ stateId, actionName, code }) => {
      const ok = ctx.manifest.updateAction(stateId, actionName, { code });
      return ok ? `Action '${actionName}' updated in ${stateId}` : `Error: action '${actionName}' not found in ${stateId}`;
    },
    {
      name: "update_action",
      description: "Update the code of an existing action. Use this to fix broken interaction code.",
      schema: z.object({
        stateId: z.string().describe("State ID containing the action"),
        actionName: z.string().describe("Name of the action to update"),
        code: z.string().describe("New Playwright async function: async (page, inputs) => { ... }"),
      }),
    }
  );

  return [read_manifest, add_state, add_view, add_action, update_view, update_action];
}
