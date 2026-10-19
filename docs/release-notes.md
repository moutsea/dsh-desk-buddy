Windows x64 和 macOS Apple Silicon 的完整 DSH 桌宠插件。

在 DSH Desktop 的「插件 → 添加插件」中，粘贴对应 `.tgz` 附件的下载链接，或先下载后填写绝对路径。点击「立即启用」并重启 DSH。无需额外安装 Electron、Node.js 或启动 DSH Web。

- `win32-x64`：Windows x64，内含 EXE、DLL 和全部资源；系统 PowerShell/.NET 解压，支持中文和空格路径。
- `darwin-arm64`：Apple Silicon Mac，保留 `.app` 权限和 framework 符号链接。
- `SHA256SUMS.txt`：完整插件包的 SHA-256 校验值。

两个系统均通过 GitHub Actions 的单元检查、真实插件包安装、原生组件解压和启动、私有管道控制、退出/重启、打包应用对话、拖动、缩放、动画和完成提醒测试。Windows 额外使用系统鼠标键盘验证点击穿透、角色点击、原生拖动和全局快捷键。截图和报告见对应 Actions 运行的 `desktop-evidence-*` artifacts。

自动检查使用隔离协议服务，不调用模型。官方 DSH Desktop 0.2.1-rc.2 安装与宿主连接已在 macOS 验证；Windows 官方宿主的全流程验证仍需目标环境。Intel Mac、Windows ARM64 和 Linux 暂无验证成品。当前应用未签名，macOS 未公证。

不要安装 GitHub 自动生成的 Source code 包或仓库首页地址，它们不包含桌宠运行组件。完整安装与兼容性说明见仓库 README 和 docs/platforms.md。
