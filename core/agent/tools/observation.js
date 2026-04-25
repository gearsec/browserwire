/**
 * observation.js — Page observation tools: screenshot + accessibility tree.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getAccessibilityTree } from "../../browser/ax-tree.js";

/**
 * @param {{ page: import('patchright').Page }} ctx
 */
export function observationTools(ctx) {
  const screenshot = tool(
    async () => {
      const buffer = await ctx.page.screenshot({ type: "jpeg", quality: 80 });
      const base64 = buffer.toString("base64");
      return [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
      ];
    },
    {
      name: "screenshot",
      description: "Capture a screenshot of the current page. Use this to visually understand the page layout and find elements.",
      schema: z.object({}),
      responseFormat: "content",
    }
  );

  const ax_tree = tool(
    async () => {
      const { url, title, tree } = await getAccessibilityTree(ctx.page);
      return `URL: ${url}\nTitle: ${title}\n\n${tree}`;
    },
    {
      name: "ax_tree",
      description: "Get the accessibility tree of the current page as YAML. Shows element roles, names, states (checked, expanded, disabled, etc.), and hierarchy. Use this to understand page structure and decide on Playwright locators.",
      schema: z.object({}),
    }
  );

  return [screenshot, ax_tree];
}
