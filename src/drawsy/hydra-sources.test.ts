import assert from "node:assert/strict";
import test from "node:test";

import { hydraContextSources } from "./hydra-sources.js";

test("maps official snake_case source metadata to a connector source", () => {
  assert.deepEqual(
    hydraContextSources(
      [
        {
          source: "connector",
          sourceInfo: {
            source_id: "gmail-source",
            source_title: "Gmail",
            additional_metadata: { app_provider: "gmail" }
          }
        }
      ],
      []
    ),
    [
      {
        id: "gmail-source",
        label: "Gmail",
        kind: "connector",
        capability: "mail"
      }
    ]
  );
});

test("falls back to chunks when the sources array has no parseable entries", () => {
  assert.deepEqual(
    hydraContextSources(
      [{ unexpected: true }],
      [
        {
          chunk_uuid: "gmail-chunk",
          source_id: "gmail-source",
          source_title: "Gmail inbox",
          additional_metadata: { provider: "gmail" },
          chunk_content: "A pending message"
        }
      ]
    ),
    [
      {
        id: "gmail-source",
        label: "Gmail Inbox",
        kind: "connector",
        capability: "mail"
      }
    ]
  );
});

test("preserves personal memory provenance", () => {
  assert.deepEqual(
    hydraContextSources(
      [
        {
          source: "memory",
          sourceInfo: {
            id: "memory-1",
            source_title: "Personal memory"
          }
        }
      ],
      []
    ),
    [
      {
        id: "memory-1",
        label: "Personal Memory",
        kind: "memory",
        capability: null
      }
    ]
  );
});
