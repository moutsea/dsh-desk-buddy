dsh-desk-buddy 0.12.4：新增插件手动更新和统一 logo。打开 DSH 左下角“dsh-desk-buddy → 插件更新”，点击“检查更新”，发现新版后点击“下载并更新”。自动选择当前系统的正式版完整包，显示下载进度并校验 SHA-256，再通过 DSH 的正式接口更新插件和桌宠应用。

升级会短暂重启桌宠，请保持 DSH 打开；完成后重启 DSH。桌宠设置、窗口位置、对话记录和 DSH 中的任务保留，安装失败会尝试恢复旧版。只在点击时检查和下载，不自动后台更新。插件列表、管理入口和管理页统一显示鲸鱼娘 logo。

0.12.3 及更早版本需先在 DSH 插件管理中卸载旧插件，再使用原 GitHub 仓库地址或本次完整包安装一次；之后即可使用更新按钮。缺少插件管理接口的旧版 DSH Web 继续使用原安装方式升级。

聊天中的助手名称统一为 dsh-desk-buddy。工具调用直接显示实际命令、文件路径或查询内容，点击展开完整参数，不再只显示 bash 等工具名。保留小、中、大三档对话框大小设置。支持 Windows x64 和 macOS Apple Silicon。

在 DSH Desktop 的「插件 → 添加插件」中，粘贴对应 `.tgz` 附件的下载链接，或先下载后填写绝对路径。点击「立即启用」并重启 DSH。无需额外安装 Electron、Node.js 或启动 DSH Web。

- `win32-x64`：Windows x64，内含 EXE、DLL 和全部资源；系统 PowerShell/.NET 解压，支持中文和空格路径。
- `darwin-arm64`：Apple Silicon Mac，保留 `.app` 权限和 framework 符号链接。
- `SHA256SUMS.txt`：完整插件包的 SHA-256 校验值。

两个系统的 GitHub Actions 验证包含更新界面、校验失败与重试、logo、单元检查、真实插件包安装、原生组件解压和启动、私有管道控制、退出/重启、打包应用对话、拖动、缩放、动画、完成提醒和执行进度气泡。Windows 额外使用系统鼠标键盘验证点击穿透、角色点击、原生拖动和全局快捷键。截图和报告见对应 Actions 运行的 `desktop-evidence-*` artifacts。

自动检查使用隔离协议服务，不调用模型。官方 DSH Desktop 0.2.1-rc.2 安装与宿主连接已在 macOS 验证；Windows 官方宿主的全流程验证仍需目标环境。Intel Mac、Windows ARM64 和 Linux 暂无验证成品。当前应用未签名，macOS 未公证。

也可在 DSH 安装框粘贴 `https://github.com/moutsea/dsh-desk-buddy`，首次启用会按系统下载已验证的 Release 组件。已有 `deepseek-girl` 或 `dsh-girl` 插件时，先卸载旧包再添加新版本，原有配置保留。不要使用 GitHub 自动生成的 Source code 包。完整安装与兼容性说明见仓库 README 和 docs/platforms.md。
