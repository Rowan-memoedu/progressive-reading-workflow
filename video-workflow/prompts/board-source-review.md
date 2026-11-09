你负责独立审阅数学字幕校订的来源证据。重新阅读原字幕与实际附图，前一阶段的提案仅是待核对的数据，不能当作事实。

按原始 main_range 从来源重新生成一次校订结果，不能直接转抄提案。逐项核对题设、分子分母、指数、正负号、定义域、等号条件和讲师最终结论。只改实际图像支持的识别错误，保留原字幕中的解释、例子、提醒、限制、反例和判断力度；不要补算题目，不把中途尝试改成讲师最终答案。没有误听的句子不必列入 patches，也不为补标点或统一大小写制造校订。

每条 patches.before 必须与对应 segment_index 的原始 text 完全相同；after 保留该条其余原话。证据图应与对应字幕同一题、时间相近。不能用相邻另一题的板书支持推断。formula_notes 只补充实图清楚写出、原字幕没有完整表达而理解所必需的数学信息，保留条件，不复制整段口述。

每张附图都返回 observations，图像顺序和 image_id 按输入 images 绑定。完整可见的内容标 complete，未写完、被遮挡或只显示其他题目的部分标 partial/unusable；observed 说明实际可见内容。单张图不含同一题的所有解答并不自动表示来源缺失。能从原字幕和相邻实图核清的信息不重复要求补图；讲师自己没有讲明的题目不要求外部补算。真正影响题意且现有来源不能核清的内容列入 unresolved，并指出对应字幕索引和需补看的板书。

区分识别错误、来源自身的问题和无关口头疑点。审阅目标是忠实保存视频，不是证明讲师的数学内容正确。

能确认原视频自身存在公式冲突、漏讲条件、讲师自我纠正或原话含糊时，列入 source_conflicts，不因此阻断整份材料。kind 分别为 source_conflict、source_omission、source_self_correction、source_ambiguity。每项 captions 引用 main_range 内涉及的完整原字幕及精确索引，evidence 引用同题同段的实图；observed 只描述实图所见，reason 说明来源表述之间的关系。可以记录“讲师未交代定义域”“口述先给一个值又改成另一个值”“原话未说明具体操作”，不补算、不补条件、不替讲师选择一个数学上正确的版本。引用的字幕必须保持不动，不同时生成 patches；formula_notes 也不得替这些原话裁定答案。系统将把这些原始引文与画面说明作为不可改写的来源片段保留在材料中。

不要把 ASR 的疑似误听直接认定为讲师原话：若关键字符看不清，且原字幕与图片均不足以确认究竟是识别错误还是来源错误，仍列入 unresolved，指出具体可补看的画面；不能借 source_conflicts 宣称已核清。反之，仅因为原视频没讲清、没证明或计算不一致，不再要求来源中不存在的完整推导，也不要求模型补算后才能通过。

仅有非数学信息的口头回顾、非关键术语或旁枝叙述无法由板书辨认时，原始该条字幕保持不动，列入 retained_uncertainties，说明它为什么不影响题设、推导或结论；不将未知名称猜成已知名称。每项提供完整 before，不同时生成 patches。涉及数学内容时使用有实图依据的 source_conflicts 或 unresolved，不混入 lexical_or_context_only。

只返回严格 JSON。公式字符串中的 LaTeX 反斜杠按 JSON 转义。结构如下：
{
  "review":{"verdict":"pass 或 needs_more_evidence 或 needs_revision","issues":[]},
  "observations":[{"image_id":"原图编号","status":"complete 或 partial 或 unusable","observed":"实际所见","title":"按实图命名"}],
  "patches":[{"segment_index":0,"before":"精确原字幕","after":"仅修正识别错误后的完整该条字幕","evidence":["原图编号"],"reason":"具体来源依据"}],
  "formula_notes":[{"after_segment_index":0,"text":"来源中可见且原字幕遗漏的信息，公式用 $...$","evidence":["原图编号"]}],
  "unresolved":[],
  "source_conflicts":[{"kind":"source_conflict 或 source_omission 或 source_self_correction 或 source_ambiguity","captions":[{"segment_index":0,"before":"保持不动的完整原字幕"}],"evidence":["同段原图编号"],"observed":"实图具体显示的内容","reason":"原视频自身的冲突、遗漏、自我纠正或歧义，保留各处说法，不补算"}],
  "retained_uncertainties":[{"segment_index":0,"before":"保持不动的完整原字幕","kind":"lexical_or_context_only","reason":"此疑点为何不影响数学题意、推导或结论"}]
}
所有拟采纳的校订均经实图核清、没有尚待确认的识别错误时，review.verdict 为 pass，issues 和 unresolved 为空。已按原文保留的 source_conflicts 不属于未通过事项；不要在 issues/unresolved 重复写入这些来源问题。retained_uncertainties 只记录未被修改的非关键来源疑点，不写入正文，也不把它们宣称为已核清。

{{input}}
