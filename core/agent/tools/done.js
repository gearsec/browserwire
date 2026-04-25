/**
 * done.js — Signal agent completion.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * @param {{ _done: boolean, _result: any }} ctx
 */
export function doneTool(ctx) {
  return tool(
    async ({ result }) => {
      ctx._done = true;
      ctx._result = result ? JSON.parse(result) : undefined;
      return "Done.";
    },
    {
      name: "done",
      description: "Signal that the task is complete. Optionally pass a JSON result.",
      schema: z.object({
        result: z.string().optional().describe("Optional JSON string with the final result"),
      }),
    }
  );
}
