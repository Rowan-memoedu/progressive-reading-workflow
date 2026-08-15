export class SyntheticProducer {
  constructor({ invalid = false } = {}) {
    this.invalid = invalid;
    this.calls = 0;
    this.lastPayload = null;
  }

  async generate(payload) {
    this.calls += 1;
    this.lastPayload = structuredClone(payload);
    if (this.invalid) {
      return {
        provider: "synthetic",
        model: "invalid-synthetic-v1",
        usage: null,
        output: {
          cleaned_blocks: [],
          judgments: {},
          insights: [{ title: "无效", description: "无效目标", target_block_key: "missing" }],
          translation: { is_bilingual: false, alignments: [] }
        }
      };
    }

    const translationBlocks = payload.blocks.filter((block) => block.role === "translation" && block.type !== "heading");
    const originalBlocks = payload.blocks.filter((block) => block.role === "original" && block.type !== "heading");
    const alignments = [];
    for (let index = 0; index < Math.min(translationBlocks.length, originalBlocks.length); index += 1) {
      alignments.push({
        original_block_key: originalBlocks[index].source_block_key,
        translation_block_key: translationBlocks[index].source_block_key,
        confidence: 0.98,
        status: "aligned"
      });
    }
    const targetBlocks = payload.blocks.filter((block) => block.type !== "heading");
    const insights = targetBlocks.slice(0, Math.min(3, targetBlocks.length)).map((block, index) => ({
      title: ["语义与渲染分离", "幂等身份稳定", "失败必须显式"][index] || `真实洞察 ${index + 1}`,
      description: [
        "模型负责可校验的语义结果，本地代码负责稳定锚点与链接。",
        "材料身份和请求幂等键承担不同职责，恢复原文不应改变材料身份。",
        "降级结果应保留正文并暴露错误，而不是伪装完整成功。"
      ][index] || "该条洞察直接来自对应正文块。",
      target_block_key: block.source_block_key
    }));
    return {
      provider: "synthetic",
      model: "synthetic-producer-v1",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      output: {
        cleaned_blocks: payload.blocks.map((block) => ({
          source_block_key: block.source_block_key,
          markdown: block.markdown
        })),
        judgments: {
          value: { level: "high", reason: "合同与失败边界清楚，可直接复用。" },
          density: { level: "high", reason: "包含接口、幂等和降级三个独立信息点。" },
          continue_reading: { level: 6, reason: "值得精细阅读以核验合同细节。" }
        },
        insights,
        translation: {
          is_bilingual: translationBlocks.length > 0 && originalBlocks.length > 0,
          alignments
        }
      }
    };
  }
}
