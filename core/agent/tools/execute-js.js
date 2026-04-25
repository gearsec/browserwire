/**
 * execute-js.js — Run Playwright code against the live page.
 *
 * Single interaction primitive. The agent writes all navigation, clicking,
 * typing, DOM queries, and data extraction as Playwright code.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeCode } from "../../browser/code-runner.js";

/**
 * @param {{ page: import('patchright').Page }} ctx
 */
export function executeJsTool(ctx) {
  return tool(
    async ({ code, inputs }) => {
      const parsedInputs = inputs ? JSON.parse(inputs) : undefined;
      const { success, result, error } = await executeCode(ctx.page, code, parsedInputs);
      if (!success) return `Error: ${error}`;
      return typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "undefined";
    },
    {
      name: "execute_js",
      description:
        "Execute Playwright code against the live page. The code is an async function receiving (page, inputs). " +
        "Use this for ALL interactions: navigation (page.goto), clicking (page.locator().click()), " +
        "typing (page.locator().fill()), DOM inspection (page.locator().innerHTML()), " +
        "data extraction (page.locator().allTextContents()), and any other Playwright API. " +
        "Returns the result or error message.",
      schema: z.object({
        code: z.string().describe('Playwright async function, e.g. "async (page, inputs) => { await page.goto(inputs.url); return await page.title(); }"'),
        inputs: z.string().optional().describe("JSON string of input values passed to the function, e.g. '{\"url\": \"https://example.com\"}'"),
      }),
    }
  );
}
