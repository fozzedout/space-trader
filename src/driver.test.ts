import { describe, expect, it } from "vitest";
import { extractThinkingAndJson } from "./llm-driver.js";

/**
 * Local models through LM Studio produce messy output: <think> preambles
 * (captured for the journal — they ARE the story), markdown fences,
 * prose around the JSON. The extractor must dig the action out of all of
 * it, and fail soft (empty object -> wait) rather than crash a runs-for-
 * weeks voyage.
 */
describe("LM Studio output extraction", () => {
  it("captures <think> reasoning and parses the JSON after it", () => {
    const { thinking, jsonText } = extractThinkingAndJson(
      `<think>Food is cheap here and Vega-1 is starving. I should load up.</think>\n{"log":"Loading food for Vega-1.","action":"buy","good":"food","qty":40}`,
    );
    expect(thinking).toContain("Vega-1 is starving");
    expect(JSON.parse(jsonText)).toMatchObject({ action: "buy", good: "food", qty: 40 });
  });

  it("handles markdown fences and surrounding prose", () => {
    const { jsonText } = extractThinkingAndJson(
      'Here is my decision:\n```json\n{"log":"Onward.","action":"travel","destId":3}\n```\nGood luck!',
    );
    expect(JSON.parse(jsonText)).toMatchObject({ action: "travel", destId: 3 });
  });

  it("merges separate reasoning_content (o1-style local models)", () => {
    const { thinking, jsonText } = extractThinkingAndJson(
      '{"log":"Skimming.","action":"harvest"}',
      "Fuel price is decent and I have nothing better to do.",
    );
    expect(thinking).toContain("nothing better to do");
    expect(JSON.parse(jsonText)).toMatchObject({ action: "harvest" });
  });

  it("fails soft on garbage (empty object, which becomes a wait)", () => {
    const { jsonText } = extractThinkingAndJson("I refuse to answer in JSON today.");
    expect(JSON.parse(jsonText)).toEqual({});
  });
});
