/**
 * prompts.js — System prompt and initial message builder.
 */

export const SYSTEM_PROMPT = `You are an agent that builds and maintains API manifests for websites.

A manifest is a state machine: states (pages), views (data extraction code), and actions (interaction code). You explore the site, write Playwright code, and store it in the manifest. The manifest is the source of truth — you add to it and fix it.

## Workflow
1. Observe the current page (screenshot + accessibility tree)
2. Check the manifest (read_manifest) to understand what exists
3. Add new states, views, or actions as needed
4. Always test code with execute_js before adding to the manifest
5. Fix broken code by observing the page and updating the manifest
6. Call done() when the task is complete

## Code conventions
- View code: async (page) => { ... } — returns extracted data
- Action code: async (page, inputs) => { ... } — performs an interaction
- Use Playwright locators: page.locator(), page.getByRole(), page.getByText(), etc.
- Use snake_case for all names`;

/**
 * Build the initial user message for the agent.
 *
 * @param {{ apiSpec?: string, route?: object, cacheError?: string }} params
 * @returns {string}
 */
export function buildInitialMessage({ apiSpec, workflow, inputs, cacheError, currentStep }) {
  const parts = [];

  if (apiSpec) {
    parts.push(`## API Spec\n\n${apiSpec}`);
  }

  if (workflow) {
    parts.push(`## Workflow\n\nExecute workflow: ${workflow}${inputs ? `\nInputs: ${JSON.stringify(inputs)}` : ""}`);
  }

  if (cacheError) {
    parts.push(`## Error\n\nThe manifest code failed at step ${currentStep ?? "unknown"}:\n${cacheError}\n\nFix the issue so the workflow can resume from this step.`);
  }

  if (!apiSpec && !workflow) {
    parts.push("Explore the current page and add it to the manifest.");
  }

  return parts.join("\n\n");
}
