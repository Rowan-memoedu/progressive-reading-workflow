# PiKaChu345 数学笔记库更新

活动目录固定为：

`阅读区/PiKaChu345 数学笔记库`

当前版本及逐文件 SHA-256 清单位于：

`config/pikachu345-library.current.json`

## 版本规则

使用来源日期版本 `YYYY.MM.DD-rN`。同一天重新发布时递增修订号，例如 `2026.08.11-r2`。

## 更新流程

先把新分享解压到独立目录。默认命令只预览，不修改现有笔记库：

```powershell
pwsh -File ".\scripts\Update-PiKaChu345Library.ps1" `
  -Source "D:\待更新\笔记共享vault" `
  -Version "2026.09.01-r1"
```

确认预览中的来源、文件数、字节数、目标和插件差异后，在同一命令末尾添加 `-Apply` 才执行替换。

执行时会先复制并校验新版本，再替换稳定目录；上一版本保存在：

`.local-ir/library-rollback/PiKaChu345-<上一版本>`（可通过 `-RollbackRoot` 指向既有回滚目录）

新版本和新回滚均校验成功后，脚本才清理更早的受管回滚。源库中的 `.obsidian` 不会迁入活动目录；插件差异只报告，不会自动修改主库插件。

## 测试

```powershell
pwsh -File ".\scripts\Test-PiKaChu345LibraryUpdater.ps1"
```

