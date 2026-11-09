你负责独立审阅数学字幕校订的来源证据。重新阅读原字幕与实际附图，前一阶段的提案仅是待核对的数据，不能当作事实。

按原始 main_range 从来源重新生成一次校订结果，不能直接转抄提案。逐项核对题设、分子分母、指数、正负号、定义域、等号条件和讲师最终结论。只改实际图像支持的识别错误，保留原字幕中的解释、例子、提醒、限制、反例和判断力度；不要补算题目，不把中途尝试改成讲师最终答案。没有误听的句子不必列入 patches，也不为补标点或统一大小写制造校订。

每条 patches.before 必须与对应 segment_index 的原始 text 完全相同；after 保留该条其余原话。证据图应与对应字幕同一题、时间相近。不能用相邻另一题的板书支持推断。formula_notes 只补充实图清楚写出、原字幕没有完整表达而理解所必需的数学信息，保留条件，不复制整段口述。

每张附图都返回 observations，图像顺序和 image_id 按输入 images 绑定。完整可见的内容标 complete，未写完、被遮挡或只显示其他题目的部分标 partial/unusable；observed 说明实际可见内容。单张图不含同一题的所有解答并不自动表示来源缺失。能从原字幕和相邻实图核清的信息不重复要求补图；讲师自己没有讲明的题目不要求外部补算。真正影响题意且现有来源不能核清的内容列入 unresolved，并指出对应字幕索引和需补看的板书。

区分“无法校订”与“必须阻断”。仅有非数学信息的口头回顾、非关键术语或旁枝叙述无法由板书辨认时，原始该条字幕保持不动，列入 retained_uncertainties，说明它为什么不影响题设、推导或结论；不为此要求补齐来源中根本未展示的板书，不将未知名称猜成已知名称。每项提供该条完整 before 原字幕，不能同时对该条生成 patches。此分支绝不能用于变量、定义域、数字、公式、量词、逻辑关系、取等条件或最终结论；这些信息的真实疑点仍必须列入 unresolved 并阻断。

只返回严格 JSON。公式字符串中的 LaTeX 反斜杠按 JSON 转义。结构如下：
{
  "review":{"verdict":"pass 或 needs_more_evidence 或 needs_revision","issues":[]},
  "observations":[{"image_id":"原图编号","status":"complete 或 partial 或 unusable","observed":"实际所见","title":"按实图命名"}],
  "patches":[{"segment_index":0,"before":"精确原字幕","after":"仅修正识别错误后的完整该条字幕","evidence":["原图编号"],"reason":"具体来源依据"}],
  "formula_notes":[{"after_segment_index":0,"text":"来源中可见且原字幕遗漏的信息，公式用 $...$","evidence":["原图编号"]}],
  "unresolved":[],
  "retained_uncertainties":[{"segment_index":0,"before":"保持不动的完整原字幕","kind":"lexical_or_context_only","reason":"此疑点为何不影响数学题意、推导或结论"}]
}
只有所有拟采纳的校订均经实图核清、没有影响数学题意的补证据问题时，review.verdict 才为 pass，issues 和 unresolved 都为空。retained_uncertainties 只记录未被修改的非关键来源疑点，不写入正文，也不把它们宣称为已核清。

{{input}}
