# RemNote 人类内容与本地审计边界 v1

## RemNote 只保存人类可读内容

正式导入后的 RemNote 节点只允许出现问题、答案、摘录、评论、改写、例子、观点和随想正文。以下字段只存在本地 package、state 和 receipt，禁止写成 RemNote 标题或子节点：

- `itemKey`、`payloadHash`、`packageId`；
- `sourceMaterialType`、`sourceFormat`、`sourceOrigin`；
- Obsidian 本地路径；
- `aiStatus`、重试状态、错误日志和归档状态。

## 问答卡创建合同

问答卡必须把完整 RemNote 原生多行卡 Markdown 作为 `remnote_create_note.content` 一次提交，不把 `>>>` 伪装在普通 note title 参数中：

```markdown
- 问题 >>>
    - 第一行答案
    - 第二行答案
```

验收必须同时满足：

1. 创建请求使用 content-only markdown tree；
2. 回读标题等于去掉 `>>>` 后的问题；
3. `cardDirection=forward`；
4. 回读答案行与 package 中答案语义一致；
5. 标题和正文不含上述技术元数据。

## 无远端技术标记的幂等恢复

本地 state 保存 `itemKey -> Rem ID` 映射。若进程在远端创建后、本地映射落盘前中断，重试按以下条件对账：

```text
精确目标父文档
  + RemNote 规范化后的人类标题
  + 人类可见正文语义
  + 卡片方向（适用时）
```

只有唯一完全匹配节点可被认领；零匹配才创建，多个完全匹配则 fail closed。这样不需要在知识正文中嵌入机器标记。
