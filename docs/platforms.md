# 平台支持与验证

0.12.0 增加 Windows 完整插件的构建、解压和启动链路。正式分发目标为 Windows x64、macOS ARM64；Intel Mac 和 Windows ARM64 尚无验证成品，Linux 完整插件暂不支持。

## 自动检查

工作流：[Desktop validation](https://github.com/moutsea/dsh-desk-buddy/actions/workflows/desktop.yml)。以具体提交对应的绿色任务为通过依据。

每个平台执行 `npm ci`、`npm test`、`npm run test:manager`、`npm run test:repository`、`npm run pack:plugin` 和 `npm run test:packaged`。管理页检查使用模拟 Release 和宿主安装接口，覆盖最新版本、下载进度、校验失败、重试、刷新、重启提示和 logo 加载。单元检查另覆盖热加载卸载与安装、失败恢复旧版以及卸载期间更新继续完成。仓库入口检查使用含中文和空格的隔离目录，验证根包的插件导出与图标、真实 Release 下载、SHA-256 校验、原生启动、连接、显示/隐藏和缓存重启。完整包检查将实际 `.tgz` 安装到临时目录，校验组件、解压，然后直接运行该组件，而非开发环境 Electron：

- 私有管道启动、版本检查、双事件连接、显示/隐藏/对话、重复启动去重、正常退出、重启和父管道断开后退出。
- 完整对话、会话切换、审批提问、流式回复、连接恢复、完成提醒和动画。
- 执行进度气泡的后台工具与实时回复、点击直达对应会话、命令参数展开、开关保存和重启恢复，以及不抢焦点、不移动窗口和结束后清理。
- 拖动与点击区分、内容跟随与换边、指针取消、屏幕边界、位置保存和重启恢复。
- 50%–150% 缩放、滑块交互、脚底锚点，以及对话框小/中/大三档的选择、屏幕适配、草稿保留和重启恢复。
- 打包状态、原生透明窗口、置顶开关和全局快捷键注册。
- Windows 通过 User32 实际系统鼠标/键盘输入验证透明区域点击穿透、角色点击、拖动和 Ctrl+Shift+Space，并保存桌面截图。

Windows 安装器另测并发解压、SHA-256 校验、中文/空格/引号路径、缓存复用以及解压后的 EXE 可执行性。macOS 保留 framework 符号链接和可执行权限的检查。

工作流成功后上传完整插件成品；`desktop-evidence-*` 包含截图和 `packaged-result.json`。这些检查使用隔离的协议服务，不访问账号、不消耗模型额度。它们验证真实 Windows/macOS 进程和窗口，但不等同于在每个系统上安装官方 DSH Desktop 的全流程验证。

## 官方宿主验证

此前在 macOS ARM64 的官方 Desktop `0.2.1-rc.2` 和 Web `0.1.1-rc.2` 上验证过完整插件安装、启动和连接。Windows 官方 DSH Desktop 的安装器及宿主端到端验证仍需在安装该宿主的 Windows 环境运行：

```powershell
$env:DSG_DESKTOP_EXECUTABLE = 'C:\path\to\DeepSeek Harness.exe'
npm run test:desktop
```

`DSG_PLUGIN_PACKAGE` 可指定完整插件包路径。此检查使用独立 DSH_HOME，不覆盖日常使用的配置。macOS 默认使用 `/Applications/DeepSeek Harness.app`。

`DSG_TEST_MANUAL_UPDATE=1 npm run test:desktop` 在隔离环境中安装版本号为 `0.0.0` 的测试种子，然后点击更新按钮，下载真实 GitHub 最新正式版并交给官方宿主替换，验证重启后版本、自动启动选择与当前会话保留，以及官方插件列表 logo。测试种子不发布。Windows PowerShell 使用 `$env:DSG_TEST_MANUAL_UPDATE = '1'` 后运行同一检查；Windows CI 的模拟安装服务检查不等同于官方宿主完整升级验证。

再设置 `DSG_TEST_UPDATE_ROLLBACK=1` 可在测试种子中注入一次安装失败，验证官方宿主真正卸载旧插件后，能够从本地备份恢复并重新连接。产品代码不包含故障注入开关。

`DSG_PLUGIN_SPEC` 可直接指定安装框中的来源，包括 GitHub 仓库地址和 Release 下载链接；测试会在官方 Desktop 界面填写原始地址并验证安装、启用、重启及连接，避免仅测试下载后的本地文件。仓库和完整包默认名称均为 `dsh-desk-buddy`，`DSG_PLUGIN_NAME` 仅用于覆盖测试目标包名。例如 macOS：

```sh
DSG_PLUGIN_SPEC=https://github.com/moutsea/dsh-desk-buddy npm run test:desktop
```

## 构建与安装

在对应系统、架构的 Node.js 22.12+ 环境运行 `npm ci` 和 `npm run pack:plugin`，不要使用跨架构 Electron 输出冒充当前架构。Windows x64 组件目录为 `release/win-unpacked`，完整保留其中的 EXE、DLL、资源和 locales；macOS ARM64 为 `release/mac-arm64/dsh-desk-buddy.app`。

Windows 解压使用系统 Windows PowerShell 与 .NET，支持当前 Electron 支持的 Windows 10/11 环境。成品未签名；macOS 未公证。多显示器、不同 DPI、系统托盘菜单与不同 Windows 安全软件的兼容性仍需实际设备覆盖，CI 只提供单显示器自动验证。

推荐在 DSH 插件页填写 `https://github.com/moutsea/dsh-desk-buddy`；首次启用自动下载当前平台的已验证组件，随后缓存复用。也可填写 GitHub Release 的完整 `.tgz` 附件链接或本地文件绝对路径，以使用包内组件。仓库安装和完整包安装都支持 macOS ARM64、Windows x64。
