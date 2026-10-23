# dsh-desk-buddy 0.17.0

桌宠现在可以同时陪伴 DSH 和 Codex 会话，完成的任务也会留在桌边，方便回头查看。

## 新功能

- **Codex 实验接入**：同时连接 DSH 与本机 Codex 共享 App Server，新建对话选择平台，Codex 使用深色对话框与气泡。共享服务中的会话支持跟随、发送、补充消息、取消、审批和问答；外部桌面端或 CLI 历史支持只读查看。具体边界见 [接入说明](https://github.com/moutsea/dsh-desk-buddy/blob/main/docs/codex.md)。
- **完成气泡保留**：任务结束后气泡继续显示，刚完成的会话排到最前；右上角 × 只关闭显示，新任务开始后重新出现。多会话仍可沿右上方斜向翻看，同时最多显示 5 张卡片。
- **会话独立状态**：两平台的草稿、Token 用量、缓存命中率、审批与操作各自隔离，断开一个平台不影响另一个。

## 修复与可靠性

- 修复重连、重复通知、后台任务和延迟历史响应导致气泡误弹出、丢失或完成顺序改变的问题。
- 修复历史撤回、跨页补读及两者并发时的旧内容回流；撤回旧轮次保留气泡关闭状态，真正的新任务仍会重新显示。
- 切换服务失败时保留原连接与设置；Codex 断线采用有上限的退避重连，历史补读限制并发，失败读取可重试。
- 两平台打包检查覆盖 Codex 和双平台操作；发布复用验证过的安装包，组件清单与版本不匹配时明确提示，避免静默安装错误版本。

## 安装与升级

在 DSH Desktop「插件 → 添加插件」填写 `https://github.com/moutsea/dsh-desk-buddy`，启用后重启 DSH。已有用户可在「设置 → 插件更新」检查并更新，升级后重启 DSH。

也可使用本页完整 `.tgz` 附件链接或本地绝对路径，无需另装 Node.js、Electron 或启动 DSH Web：

- `darwin-arm64`：macOS Apple Silicon。
- `win32-x64`：Windows x64。
- `SHA256SUMS.txt`：两个完整插件包的校验值。

Codex 接入需要自行启动并连接共享 App Server，不会接管已有独立窗口的任务。成品未签名，macOS 未公证；平台验证范围见 [平台说明](https://github.com/moutsea/dsh-desk-buddy/blob/main/docs/platforms.md)。
