import type { BrowserWireManifest } from "../../src/contract-dsl";

const BASE_MANIFEST: BrowserWireManifest = {
  contractVersion: "1.0.0",
  manifestVersion: "1.0.0",
  metadata: {
    id: "support-center-manifest",
    site: "support.example.com",
    createdAt: "2026-02-25T00:00:00.000Z"
  },
  entities: [
    {
      id: "ticket",
      name: "Support Ticket",
      description: "A support issue row displayed in ticket lists.",
      signals: [
        {
          kind: "role",
          value: "row",
          weight: 0.9
        },
        {
          kind: "text",
          value: "Ticket #",
          weight: 0.8
        }
      ],
      confidence: {
        score: 0.9,
        level: "high"
      },
      provenance: {
        source: "human",
        sessionId: "session-1",
        traceIds: ["trace-1"],
        annotationIds: ["annotation-1"],
        capturedAt: "2026-02-25T00:01:00.000Z"
      }
    }
  ],
  actions: [
    {
      id: "open_ticket",
      entityId: "ticket",
      name: "Open Ticket",
      description: "Open a ticket by ticket id.",
      inputs: [
        {
          name: "ticketId",
          type: "string",
          required: true,
          description: "The ticket identifier from the list."
        },
        {
          name: "preferNewest",
          type: "boolean",
          required: false,
          description: "If true, choose the newest matching ticket."
        }
      ],
      requiredInputRefs: ["ticketId"],
      preconditions: [
        {
          id: "ticket_list_visible",
          description: "Ticket list is visible in viewport."
        }
      ],
      postconditions: [
        {
          id: "ticket_detail_open",
          description: "Opened ticket id equals input ticketId.",
          inputRefs: ["ticketId"]
        }
      ],
      recipeRef: "recipe://ticket/open_ticket/v1",
      locatorSet: {
        id: "ticket_row_locator",
        strategies: [
          {
            kind: "data_testid",
            value: "ticket-row",
            confidence: 0.9
          },
          {
            kind: "text",
            value: "Ticket #",
            confidence: 0.6
          }
        ]
      },
      errors: ["ERR_TARGET_NOT_FOUND", "ERR_POSTCONDITION_FAILED"],
      confidence: {
        score: 0.8,
        level: "high"
      },
      provenance: {
        source: "hybrid",
        sessionId: "session-2",
        traceIds: ["trace-2", "trace-3"],
        annotationIds: ["annotation-2"],
        capturedAt: "2026-02-25T00:02:00.000Z"
      }
    }
  ],
  errors: [
    {
      code: "ERR_TARGET_NOT_FOUND",
      messageTemplate: "Could not find target element for action {{actionId}}.",
      classification: "recoverable"
    },
    {
      code: "ERR_POSTCONDITION_FAILED",
      messageTemplate: "Postcondition failed for action {{actionId}}.",
      classification: "fatal"
    }
  ]
};

export function createValidManifest(): BrowserWireManifest {
  return JSON.parse(JSON.stringify(BASE_MANIFEST)) as BrowserWireManifest;
}
