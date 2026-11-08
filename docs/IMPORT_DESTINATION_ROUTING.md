# 导入入口与阅读区目录路由

所有入口共用标准 URL 导入与预处理流程；入口只负责提供目标目录语义。配置文件是 `config/import-destination-routes.json`。

## 当前映射

| 入口 | `entry_route` | 目录规则 |
| --- | --- | --- |
| 浏览器插件 | `browser_extension` | 固定写入 `阅读区/浏览器高亮` |
| Obsidian 链接导入 | `obsidian` | 按规范化域名写入，例如 `阅读区/zhihu.com` |
| AI 指令导入 | `ai` | AI 在请求中显式注入 `destination_folder` |

共享接口 `POST /api/browser-import/requests` 接受：

```json
{
  "urls": ["https://zhuanlan.zhihu.com/p/123"],
  "source": "archive-social-reading:zhihu-likes-since",
  "entry_route": "ai",
  "destination_folder": "知乎/知乎点赞"
}
```

`destination_folder` 必须是 `阅读区` 下的相对路径，禁止绝对路径和 `..`。AI 入口未提供该字段时请求失败，不再静默落入“浏览器高亮”。来源 URL 的全局去重规则不变，目录只决定唯一正文的物理位置。

2026-09-18 已确认的章节集合目标：Problem of Schooling 放入现有 `Supermemo guru/Problem of Schooling`，再追加来源章节层级。已有 `Supermemo guru` 文章参与全局来源去重，命中时保留原位置并由书内索引引用，不因目标子目录不同重复建档。范围、真实重复样本、保护规则及待实现边界统一见 [章节目录型网页导入](IMPORT_RULES.md#章节目录型网页导入已确认需求尚未接入集合规则)。

## 本次知乎归档

“导入 2026-07-01 之后的知乎点赞”固定注入：

```json
{
  "entry_route": "ai",
  "destination_folder": "知乎/知乎点赞"
}
```

已经误写入 `阅读区/浏览器高亮` 的本批产物按 `source_url` 精确迁移，并同步更新浏览器 IR sidecar；验收要求目标 URL 全部只存在于 `阅读区/知乎/知乎点赞`，源目录残留为零。
