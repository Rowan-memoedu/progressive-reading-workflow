export const GUIDE_FIDELITY_VERSION='guide-fidelity/v1';
const CHUNK_GENERATION_SCOPE='guide_context 是完整原文语境，guide_points 是程序冻结的当前信息点。只为当前 blocks 的有效 key 生成洞察；不要把语境中的其他块误作当前处理对象。相关主张、条件、反驳和回应一起表达，不将过渡句独立成卡。';
const RULES=[
 '核心洞察的唯一内容来源是原文观点。任务是忠实表达这些观点，不是读完原文后发表自己的看法。可以摘取原句、合并重复、调整句式和组织层次，不要求逐字照抄，但不得改变观点内容。',
 '标题和 description 的每个实质命题都须有原文依据。保留量词、数字、因果方向、条件、否定、比较对象、推测程度和判断力度。原文说得强就保留其强度，原文存疑就保留其疑问；不为了客观、审慎、平衡或合理而加强、弱化、纠正或补全。',
 '原文没有提出的理由、结论、建议、边界、免责声明、反方意见、解释和注释不加入洞察，即使看似正确或有益。原文已有的限定、反驳、回应、解释性脚注和决定观点含义的例子细节须保留。',
 '结合完整原文区分作者立场、引述、被反驳的说法和假设。引语不能脱离语境成为作者结论。必要时自然交代反方身份，不另加整理说明；作者自己的观点直接陈述，不加“作者指出”等套话。',
 CHUNK_GENERATION_SCOPE,
 'judgments 仍按既有规则单独给出阅读判断，其评价不混入 insights。提交前静默核对原文依据、观点归属、范围、条件和判断力度，不输出核对过程。'
];
export const GUIDE_FIDELITY_POLICY=RULES.join('\n');
// Aggregated audits have no current generation chunk. Applying that instruction
// there can discard other chunks or miss coverage supplied by another card.
export const GUIDE_REVIEW_FIDELITY_POLICY=RULES.filter(rule=>rule!==CHUNK_GENERATION_SCOPE).join('\n');
