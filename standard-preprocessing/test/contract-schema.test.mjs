import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { processMaterial } from "../lib/core.mjs";
import { SyntheticProducer } from "../test-support/synthetic-producer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtures = path.join(root, "fixtures");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function contractValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const requestSchema = await readJson(path.join(root, "contracts", "request.schema.json"));
  const resultSchema = await readJson(path.join(root, "contracts", "result.schema.json"));
  return {
    requestSchema,
    validateRequest: ajv.compile(requestSchema),
    validateResult: ajv.compile(resultSchema)
  };
}

function explain(validate) {
  return JSON.stringify(validate.errors || [], null, 2);
}

class ContractCompliantSyntheticProducer extends SyntheticProducer {
  async generate(payload) {
    const generated = await super.generate(payload);
    for (const insight of generated.output.insights || []) {
      while (String(insight.description || "").replace(/\s+/gu, "").length < 60) {
        insight.description += "该结论同时保留对应正文中的条件、依据、适用边界和实际处理结果，不以跳转代替内容本身。";
      }
    }
    return generated;
  }
}

function producerWithDescription(description) {
  return {
    calls: 0,
    async generate(payload) {
      this.calls += 1;
      return {
        provider: "synthetic",
        model: "contract-boundary-producer-v1",
        usage: null,
        output: {
          judgments: {
            value: { level: "medium", reason: "用于验证合同边界。" },
            density: { level: "medium", reason: "用于验证合同边界。" },
            continue_reading: { level: 2, reason: "用于验证合同边界。" }
          },
          insights: [{
            title: "洞察长度边界",
            description,
            target_block_key: payload.blocks[0].source_block_key
          }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }
  };
}

test("request fixtures and their deterministic results satisfy the published JSON Schemas", async () => {
  const { validateRequest, validateResult } = await contractValidators();
  const fixtureNames = [
    "monolingual.request.json",
    "bilingual.request.json",
    "translation-missing-original.request.json",
    "translation-restored.request.json"
  ];

  for (const fixtureName of fixtureNames) {
    const request = await readJson(path.join(fixtures, fixtureName));
    assert.equal(validateRequest(request), true, `${fixtureName} request: ${explain(validateRequest)}`);

    const result = await processMaterial(request, {
      producer: new ContractCompliantSyntheticProducer(),
      now: "2026-08-15T00:00:00.000Z"
    });
    assert.equal(validateResult(result), true, `${fixtureName} result: ${explain(validateResult)}`);
  }
});

test("request schema publishes the cross-field insight budget as a mandatory runtime invariant", async () => {
  const { requestSchema } = await contractValidators();
  assert.match(
    requestSchema.properties.processing_options.$comment,
    /insight_soft_min <= insight_soft_max <= insight_safety_cap/u
  );
});

test("result schema requires structural fields and permits short nonempty insights", async () => {
  const { validateResult } = await contractValidators();
  const request = await readJson(path.join(fixtures, "monolingual.request.json"));
  const result = await processMaterial(request, {
    producer: new ContractCompliantSyntheticProducer(),
    now: "2026-08-15T00:00:00.000Z"
  });

  const missingModel = structuredClone(result);
  delete missingModel.receipt.model;
  assert.equal(validateResult(missingModel), false);

  const malformedBlockId = structuredClone(result);
  malformedBlockId.artifacts.body_blocks[0].block_id = "model-guessed-anchor";
  assert.equal(validateResult(malformedBlockId), false);

  const obsoleteReadingLevel = structuredClone(result);
  obsoleteReadingLevel.artifacts.semantic.judgments.continue_reading.level = 5;
  assert.equal(validateResult(obsoleteReadingLevel), false);

  const shortInsight = structuredClone(result);
  shortInsight.artifacts.semantic.insights[0].description = "一句过短的洞察";
  assert.equal(validateResult(shortInsight), true);
  shortInsight.artifacts.semantic.insights[0].description = "";
  assert.equal(validateResult(shortInsight), false);
});

test("failed request results remain valid contract results without pretending to have artifacts", async () => {
  const { validateResult } = await contractValidators();
  const invalidRequest = await readJson(path.join(fixtures, "monolingual.request.json"));
  invalidRequest.contract_version = "unsupported";
  const result = await processMaterial(invalidRequest, { now: "2026-08-15T00:00:00.000Z" });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.artifacts, {});
  assert.equal(validateResult(result), true, explain(validateResult));
});

test("core accepts generated insights on both sides of the retired 60-character threshold", async () => {
  const base = await readJson(path.join(fixtures, "monolingual.request.json"));
  base.processing_options = { cleaning_mode: "semantic_only" };
  const exactFiftyNine = "洞".repeat(59);
  const exactSixty = "洞".repeat(60);
  assert.equal(exactFiftyNine.replace(/\s+/gu, "").length, 59);
  assert.equal(exactSixty.replace(/\s+/gu, "").length, 60);

  const rejectedProducer = producerWithDescription(exactFiftyNine);
  const rejected = await processMaterial(structuredClone(base), { producer: rejectedProducer });
  assert.equal(rejected.status, "completed");
  assert.equal(rejected.processing_state, "rendered");
  assert.equal(rejectedProducer.calls, 1);
  assert.deepEqual(rejected.errors, []);

  const acceptedProducer = producerWithDescription(exactSixty);
  const accepted = await processMaterial(structuredClone(base), { producer: acceptedProducer });
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.processing_state, "rendered");
  assert.equal(acceptedProducer.calls, 1);
  assert.equal(accepted.artifacts.semantic.insights[0].description, exactSixty);
});

test("runtime rejects insight budgets that violate min <= max <= cap after defaults", async () => {
  const base = await readJson(path.join(fixtures, "monolingual.request.json"));
  const invalidBudgets = [
    { insight_soft_min: 5, insight_soft_max: 4, insight_safety_cap: 24 },
    { insight_soft_min: 3, insight_soft_max: 13, insight_safety_cap: 12 },
    { insight_soft_min: 13 },
    { insight_safety_cap: 2 }
  ];

  for (const budget of invalidBudgets) {
    const request = structuredClone(base);
    request.processing_options = { cleaning_mode: "semantic_only", ...budget };
    const producer = producerWithDescription("洞".repeat(60));
    const result = await processMaterial(request, { producer });
    assert.equal(result.status, "failed", JSON.stringify(budget));
    assert.equal(producer.calls, 0, JSON.stringify(budget));
    assert.ok(result.errors.some((item) => item.code === "invalid_insight_budget_order"), JSON.stringify(budget));
  }

  const validRequest = structuredClone(base);
  validRequest.processing_options = {
    cleaning_mode: "semantic_only",
    insight_soft_min: 0,
    insight_soft_max: 1,
    insight_safety_cap: 1
  };
  const accepted = await processMaterial(validRequest, { producer: producerWithDescription("洞".repeat(60)) });
  assert.equal(accepted.status, "completed");
});
