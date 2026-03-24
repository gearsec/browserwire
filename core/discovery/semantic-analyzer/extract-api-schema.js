/**
 * extract-api-schema.js — Stage 1: API Schema Extraction
 *
 * Takes a screenshot + URL/title and produces a semantic API schema
 * describing what the page does — views (read), endpoints (write),
 * and workflows (multi-step). No DOM scanIds, no CSS selectors, no
 * locators. Purely semantic. Element grounding is Stage 2's job.
 *
 * Uses the Vercel AI SDK for structured output with Zod validation.
 */

import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "../ai-provider.js";

// ---------------------------------------------------------------------------
// Zod schema — defines the structured output shape
// ---------------------------------------------------------------------------

export const apiSchemaZod = z.object({
  domain: z.string().describe("e.g. event_management, messaging, email_client"),
  domainDescription: z.string().describe("1-2 sentences describing what this page/site does"),

  page: z.object({
    name: z.string().describe("e.g. Event List, User Profile"),
    routePattern: z.string().describe("e.g. /events/:id — generalize IDs"),
    description: z.string(),
  }),

  views: z.array(z.object({
    name: z.string().describe("snake_case: event_list, user_profile"),
    description: z.string(),
    isList: z.boolean(),
    isDynamic: z.boolean(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.enum(["string", "number", "boolean", "date"]),
    })),
  })).describe("READ operations — structured data visible on the page"),

  endpoints: z.array(z.object({
    name: z.string().describe("snake_case verb_noun: create_event, submit_login"),
    kind: z.enum(["click", "form_submit", "navigation", "input", "toggle", "select"]),
    description: z.string(),
    visualContext: z.string().describe("Where on the page: top nav bar, sidebar, main content, modal, etc."),
    inputs: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
    })).optional(),
  })).describe("WRITE/interaction operations"),

  workflows: z.array(z.object({
    name: z.string(),
    description: z.string(),
    stepEndpoints: z.array(z.string()).describe("References to endpoint names, in order"),
    inputs: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
    })).optional(),
  })).describe("Multi-step operations composed of multiple endpoints"),
});

// ---------------------------------------------------------------------------
// System prompt — focused on semantic understanding only
// ---------------------------------------------------------------------------

const STAGE1_SYSTEM_PROMPT = `You are a web application analyst. You are given a screenshot of a web page along with its URL and title.

Your task: describe this page as if it were an API. What data does it expose (views)? What actions can a user perform (endpoints)? What multi-step workflows exist?

## Views (READ operations)

Identify all structured data visible on the page:
- Lists (event list, message inbox, search results, product catalog)
- Detail views (event details, user profile, order summary)
- Status displays (notification count, account balance, dashboard metrics)

For each view:
- Give it a descriptive snake_case name
- List the data fields visible (name + type)
- Mark isList=true for repeating items, false for single records
- Mark isDynamic=true when content is server-driven and changes over time

## Endpoints (WRITE/interaction operations)

Identify all interactive elements that perform an action:
- Buttons (create, delete, submit, save, cancel)
- Form submissions (login, registration, search)
- Navigation links (go to page, open modal)
- Inputs (search box, filter dropdown, text field)
- Toggles (checkboxes, switches, radio buttons)

For each endpoint:
- Give it a verb_noun snake_case name (create_event, submit_login, toggle_dark_mode)
- Describe what it does
- Specify the kind of interaction
- Describe where it appears visually (top nav, sidebar, main content area, modal footer, etc.)
- List any inputs it accepts (form fields, text inputs)

## Workflows (multi-step operations)

Identify sequences of endpoints that form a complete task:
- Login flow: fill username → fill password → click submit
- Search flow: type query → click search → select result
- Form submission: fill fields → validate → submit

Reference endpoint names in stepEndpoints (must match names from endpoints array).

## Page context

Identify:
- The domain this application belongs to (e.g. event_management, social_media, email_client)
- The page name and route pattern (generalize IDs: /events/:id not /events/123)

## Rules
- Use snake_case for all names
- Be specific and developer-friendly with names — no "generic", "unknown", or "button_1"
- Focus on the 15-30 most meaningful interactive elements
- Skip purely decorative elements (icons, dividers, background images)
- For views, only include fields that contain actual data (not labels or headers)
- Generalize route patterns: use :id for numeric/UUID segments`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract an API schema from a page screenshot.
 *
 * @param {{ screenshot: string|null, url: string, title: string }} input
 * @returns {Promise<import("zod").infer<typeof apiSchemaZod>|null>}
 */
export const extractApiSchema = async ({ screenshot, url, title }) => {
  const model = getModel();
  if (!model) {
    throw new Error("[browserwire-cli] LLM not configured, skipping Stage 1 is not allowed");
  }

  if (!screenshot) {
    throw new Error("[browserwire-cli] no screenshot provided, skipping Stage 1 is not allowed");
  }

  console.log(
    `[browserwire-cli] Stage 1: extracting API schema from screenshot ` +
    `(${Math.round(screenshot.length * 0.75 / 1024)}KB) url=${url}`
  );

  const { output } = await generateText({
    model,
    output: Output.object({ schema: apiSchemaZod }),
    messages: [
      { role: "system", content: STAGE1_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image", image: Buffer.from(screenshot, "base64") },
          { type: "text", text: `URL: ${url}\nTitle: ${title}` }
        ]
      }
    ],
    temperature: 0.2,
  });

  if (!output) {
    console.warn("[browserwire-cli] Stage 1: LLM returned no structured output");
    return null;
  }

  return output;
};
