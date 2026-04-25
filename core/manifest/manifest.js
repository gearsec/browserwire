/**
 * manifest.js — StateMachineManifest: mutable builder for the state machine.
 *
 * Used by the session to incrementally build the manifest as snapshots
 * are processed serially. Each snapshot either adds a new state or
 * revisits an existing one, and optionally links the previous state's
 * action to the destination state via to_state.
 *
 * Views and actions carry executable Playwright code alongside
 * structured signatures (returns/inputs) that define their API.
 */

import { validateManifest } from "./validate.js";

export class StateMachineManifest {
  constructor() {
    this.domain = null;
    this.domainDescription = null;
    this.initial_state = null;
    /** @type {Map<string, object>} state id → state object */
    this._states = new Map();
    this._stateIdCounter = 0;
    /** @type {Array<object>} top-level workflow definitions */
    this._workflows = [];
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /**
   * Add a new state to the manifest.
   *
   * @param {{ name: string, description: string, url_pattern: string, signature: object, views: object[], actions: object[] }} params
   * @returns {string} The assigned state id
   */
  addState({ name, description, url_pattern, signature, views = [], actions = [] }) {
    const id = `s${this._stateIdCounter++}`;
    const state = {
      id,
      name,
      description,
      url_pattern,
      signature,
      views: [...views],
      actions: [...actions],
    };
    this._states.set(id, state);
    return id;
  }

  /**
   * Get a state by id.
   *
   * @param {string} stateId
   * @returns {object|null}
   */
  getState(stateId) {
    return this._states.get(stateId) || null;
  }

  /**
   * Get all states.
   *
   * @returns {object[]}
   */
  getStates() {
    return [...this._states.values()];
  }

  /**
   * Find a state by matching its signature against existing states.
   * Returns the state id if a match is found, null otherwise.
   *
   * Matching criteria: same page_purpose AND same sorted view names AND same sorted action names.
   *
   * @param {object} signature - { page_purpose, views: string[], actions: string[] }
   * @returns {string|null} Matching state id or null
   */
  findMatchingState(signature) {
    const normalize = (arr) => [...arr].sort().join("\0");
    const targetViews = normalize(signature.views);
    const targetActions = normalize(signature.actions);

    for (const state of this._states.values()) {
      if (
        state.signature.page_purpose === signature.page_purpose &&
        normalize(state.signature.views) === targetViews &&
        normalize(state.signature.actions) === targetActions
      ) {
        return state.id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // View / Action mutations on existing states
  // -------------------------------------------------------------------------

  /**
   * Merge views into an existing state (add any that don't already exist by name).
   *
   * @param {string} stateId
   * @param {object[]} views
   */
  mergeViews(stateId, views) {
    const state = this._states.get(stateId);
    if (!state) return;

    const existing = new Set(state.views.map((v) => v.name));
    for (const view of views) {
      if (!existing.has(view.name)) {
        state.views.push(view);
        existing.add(view.name);
      }
    }
  }

  /**
   * Merge actions into an existing state (add any that don't already exist by name).
   *
   * @param {string} stateId
   * @param {object[]} actions
   */
  mergeActions(stateId, actions) {
    const state = this._states.get(stateId);
    if (!state) return;

    const existing = new Set(state.actions.map((a) => a.name));
    for (const action of actions) {
      if (!existing.has(action.name)) {
        state.actions.push({ ...action });
        existing.add(action.name);
      }
    }
  }

  // -------------------------------------------------------------------------
  // View / Action updates on existing states
  // -------------------------------------------------------------------------

  /**
   * Update an existing view's fields (e.g. code, returns).
   *
   * @param {string} stateId
   * @param {string} viewName
   * @param {object} updates — fields to merge into the view
   * @returns {boolean} true if found and updated
   */
  updateView(stateId, viewName, updates) {
    const state = this._states.get(stateId);
    if (!state) return false;
    const view = state.views.find((v) => v.name === viewName);
    if (!view) return false;
    Object.assign(view, updates);
    return true;
  }

  /**
   * Update an existing action's fields (e.g. code, inputs).
   *
   * @param {string} stateId
   * @param {string} actionName
   * @param {object} updates — fields to merge into the action
   * @returns {boolean} true if found and updated
   */
  updateAction(stateId, actionName, updates) {
    const state = this._states.get(stateId);
    if (!state) return false;
    const action = state.actions.find((a) => a.name === actionName);
    if (!action) return false;
    Object.assign(action, updates);
    return true;
  }

  /**
   * Find a state whose url_pattern matches a given URL.
   *
   * @param {string} url
   * @returns {string|null} state ID or null
   */
  findStateByUrl(url) {
    for (const state of this._states.values()) {
      if (state.url_pattern && url.includes(state.url_pattern.replace(/\{[^}]+\}/g, ""))) {
        return state.id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Workflow management
  // -------------------------------------------------------------------------

  /**
   * Add a workflow to the manifest.
   *
   * @param {{ name: string, description?: string, steps: Array<{ state: string, action?: string, view?: string }> }} workflow
   */
  addWorkflow({ name, description, steps }) {
    this._workflows.push({ name, description, steps });
  }

  /**
   * Get a workflow by name.
   *
   * @param {string} name
   * @returns {object|null}
   */
  getWorkflow(name) {
    return this._workflows.find((w) => w.name === name) || null;
  }

  /**
   * Append a step to a workflow.
   *
   * @param {string} workflowName
   * @param {{ state: string, action?: string, view?: string }} step
   * @returns {number|false} new step index, or false if workflow not found
   */
  appendStep(workflowName, step) {
    const wf = this._workflows.find((w) => w.name === workflowName);
    if (!wf) return false;
    wf.steps.push(step);
    return wf.steps.length - 1;
  }

  /**
   * Update a step at a specific index.
   *
   * @param {string} workflowName
   * @param {number} index
   * @param {object} updates — fields to merge into the step
   * @returns {boolean}
   */
  updateStep(workflowName, index, updates) {
    const wf = this._workflows.find((w) => w.name === workflowName);
    if (!wf || index < 0 || index >= wf.steps.length) return false;
    Object.assign(wf.steps[index], updates);
    return true;
  }

  /**
   * Insert a step before a specific index.
   *
   * @param {string} workflowName
   * @param {number} index
   * @param {{ state: string, action?: string, view?: string }} step
   * @returns {boolean}
   */
  insertStep(workflowName, index, step) {
    const wf = this._workflows.find((w) => w.name === workflowName);
    if (!wf || index < 0 || index > wf.steps.length) return false;
    wf.steps.splice(index, 0, step);
    return true;
  }

  /**
   * Remove a step at a specific index.
   *
   * @param {string} workflowName
   * @param {number} index
   * @returns {boolean}
   */
  removeStep(workflowName, index) {
    const wf = this._workflows.find((w) => w.name === workflowName);
    if (!wf || index < 0 || index >= wf.steps.length) return false;
    wf.steps.splice(index, 1);
    return true;
  }

  /**
   * Get all workflows.
   *
   * @returns {object[]}
   */
  getWorkflows() {
    return [...this._workflows];
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /**
   * Serialize to a plain object matching stateMachineManifestSchema.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      domain: this.domain,
      domainDescription: this.domainDescription,
      initial_state: this.initial_state,
      states: this.getStates(),
      workflows: this.getWorkflows(),
    };
  }

  /**
   * Validate the current manifest state.
   *
   * @returns {{ valid: boolean, errors?: string[], manifest?: object }}
   */
  validate() {
    return validateManifest(this.toJSON());
  }

  // -------------------------------------------------------------------------
  // Summary (for LLM context)
  // -------------------------------------------------------------------------

  /**
   * Produce a compact summary for passing to the LLM as context.
   * Includes state names, signatures, and action to_state links.
   * Omits code and grounding details to keep context small.
   *
   * @returns {object}
   */
  toSummary() {
    return {
      domain: this.domain,
      initial_state: this.initial_state,
      states: this.getStates().map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        url_pattern: s.url_pattern,
        signature: s.signature,
        views: s.views.map((v) => ({
          name: v.name,
          isList: v.isList,
          returns: v.returns,
          ...(v.pagination ? { pagination: v.pagination } : {}),
        })),
        actions: s.actions.map((a) => ({
          name: a.name,
          kind: a.kind,
          inputs: a.inputs,
          to_state: a.to_state,
        })),
      })),
      workflows: this.getWorkflows().map((w) => ({
        name: w.name,
        description: w.description,
        steps: w.steps,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Factory: from plain object
  // -------------------------------------------------------------------------

  /**
   * Create a StateMachineManifest from a plain object (e.g., loaded from disk).
   *
   * @param {object} obj
   * @returns {StateMachineManifest}
   */
  static fromJSON(obj) {
    const m = new StateMachineManifest();
    m.domain = obj.domain || null;
    m.domainDescription = obj.domainDescription || null;
    m.initial_state = obj.initial_state || null;
    m._stateIdCounter = 0;

    for (const state of obj.states || []) {
      m._states.set(state.id, {
        id: state.id,
        name: state.name,
        description: state.description,
        url_pattern: state.url_pattern,
        signature: state.signature,
        views: state.views || [],
        actions: [...(state.actions || [])],
      });

      // Keep counter ahead of any existing numeric ids
      const num = parseInt(state.id.replace(/^s/, ""), 10);
      if (!isNaN(num) && num >= m._stateIdCounter) {
        m._stateIdCounter = num + 1;
      }
    }

    m._workflows = [...(obj.workflows || [])];

    return m;
  }
}
