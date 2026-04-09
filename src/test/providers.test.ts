import assert from "node:assert/strict";
import test from "node:test";

import { extractOpenAIResponsesText } from "../demo/providers.js";

test("extractOpenAIResponsesText recovers partial text from incomplete responses", () => {
  const text = extractOpenAIResponsesText({
    output_text: null,
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      { type: "reasoning", content: [] },
      {
        type: "message",
        status: "incomplete",
        content: [
          {
            type: "output_text",
            text: "Claro. Aqui va un cuento largo...",
          },
        ],
      },
    ],
  });

  assert.equal(text, "Claro. Aqui va un cuento largo...");
});
