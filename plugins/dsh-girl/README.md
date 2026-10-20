# dsh-desk-buddy · DSH 插件入口

完整 dsh-desk-buddy的 DSH 安装和管理入口。仓库安装会在首次启用时自动下载对应平台的 Release 组件，校验、解压到当前用户目录并启动；完整插件包则直接使用内含组件。无需另外下载 App、安装 Electron 或填写 DSH 地址。保留独立桌宠产品，插件只是一个接入渠道。

提供 macOS ARM64 和 Windows x64 构建，接入协议依据官方 DSH Desktop `0.2.1-rc.2` 和 DSH Web `0.1.1-rc.2`。插件自动识别宿主版本，余额查询通过 DSH 凭证服务完成。无需同时安装 `dsh-girl-bridge`；已有独立余额插件时，先停用旧插件，避免余额路由重复。平台验证范围见仓库 `docs/platforms.md`。

## 官方 DSH Desktop 安装

在 Desktop 左侧打开“插件”→“添加插件”，粘贴仓库地址：

```text
https://github.com/moutsea/dsh-desk-buddy
```

安装后点击“立即启用”，再重启 Desktop。Mac 和 Windows 使用同一个地址，插件自动选择组件。首次下载约 200–230 MB，需要能够访问 GitHub Release；之后使用本地缓存。右下角“dsh-desk-buddy”提供准备状态、启动、关闭、显示、隐藏、对话和自动启动设置；支持拖动并保存位置，避开左下角 user-menu。聚焦后方向键移动，Home 恢复默认位置。下载失败可检查网络后重试。无需另开 DSH Web 服务，也无需手填地址。Desktop 的插件由应用管理，不能使用 `dsh plugin --profile desktop` 修改。

也可从 [GitHub Releases](https://github.com/moutsea/dsh-desk-buddy/releases) 选择完整 `.tgz`，将附件链接或下载后文件的绝对路径作为安装来源。macOS ARM64 使用 `dsh-desk-buddy-0.12.5-darwin-arm64.tgz`，Windows x64 使用 `dsh-desk-buddy-0.12.5-win32-x64.tgz`。完整包无需额外下载组件。两种方式的包名均为 `dsh-desk-buddy`；升级前卸载旧的 `deepseek-girl` 或 `dsh-girl` 插件，再安装新版。用户设置和窗口位置保留。

## 手动更新与图标

在桌宠“设置 → 插件更新”，或 DSH 页面“dsh-desk-buddy → 插件更新”点击“检查更新”，发现正式版后点击“下载并更新”。按当前系统下载完整插件包并校验 SHA-256，不会自动下载或后台升级。更新包含插件管理代码和桌宠应用，下载约 200–230 MB。升级期间桌宠可能关闭，可继续在 DSH 管理页查看结果。

升级时请保持 DSH 打开。支持热加载的宿主使用正式卸载、安装接口替换插件，桌宠会短暂退出再启动；不支持热加载的宿主在安装后等待重启。安装失败时尝试恢复更新前备份，失败信息提供重新安装指引。完成后重启 DSH，桌宠设置、窗口位置、会话与 DSH 任务保留。更新包和旧版备份保留在用户数据目录，DSH 的依赖记录仍会引用这些文件，请勿手动删除。

0.12.3 及更早版本需先通过 DSH 插件管理重新安装一次新版，才能获得更新按钮。缺少插件管理接口的旧版 DSH Web 显示原因，继续使用原安装方式升级。

仓库入口和完整包均通过 `package.json` 的 `icon` 字段及导出提供 128 × 128 PNG 图标；插件列表、可拖动入口和管理页使用相同的鲸鱼娘 logo。

## DSH Web 安装

通过同一仓库地址安装，也可将地址换成当前系统的完整 `.tgz` 路径：

```sh
dsh plugin --profile web add https://github.com/moutsea/dsh-desk-buddy
```

重启 DSH Web，插件会自动唤醒桌宠。DSH 页面右下角增加可拖动的“dsh-desk-buddy”按钮，可查看状态、启动、关闭、显示、隐藏、打开对话，以及设置是否随 DSH 启动。也可在当前 DSH 地址后加 `/dsh-girl/` 打开管理页。关闭桌宠不会取消 DSH 任务；停用/卸载插件或退出所属 DSH 后，该插件管理的桌宠会退出。

桌宠自身的表情、角色大小、拖动、对话和完成提醒全部保留。收起窗口时可通过执行进度气泡查看工具命令和实时回复，点击打开对应会话；在桌宠“设置 → 执行进度气泡”中开关，选择会保存。插件模式下服务地址由所属 DSH 自动配置；独立启动方式仍可手动选择连接地址。插件数据与独立应用的数据隔离，避免相互改写连接和会话。

## 从项目构建

在目标系统的项目根目录执行 `npm ci` 和 `npm run pack:plugin`，输出 `release/dsh-desk-buddy-0.12.5-<platform>-<arch>.tgz` 和带版本、平台、架构名的插件目录。完整包包含桌面组件，源码子目录和 GitHub Source code 压缩包都不能代替构建产物。Windows 使用原生 `.exe` 及其完整依赖目录，macOS 使用 `.app`。

仓库根目录声明 `dsh.bundle` 并导出插件，首次启动读取 `release-runtime.json`，下载固定版本的官方 Release 附件并校验 SHA-256。完整包则不触发运行时下载。两种方式都不执行 npm 安装脚本、不要求本机编译，也没有后台更新器。发布新版本时，应在 Release 验证完成后同步清单中的版本、平台 URL 和 SHA-256。插件卸载后保留用户设置和组件缓存，方便重新安装。未发布到 npm 或插件市场。

## Desktop 接入方式

使用官方结构化 `webserver/index-inject` 启动注入，兼容 `dsh-app://app` 页面及其同源转发。插件启动时等待宿主完成随机端口绑定，避免阻塞启动。

Desktop 0.2 使用 Typert Gateway 与 Connection Peer：插件创建自己拥有的本机 owner Peer，将会话列表、创建、发送、取消、历史和实时事件交给桌宠。审批、提问通过宿主 `$events` 转发和关联结果通道完成，可与主界面同步处理。关闭桌宠不取消已接受的任务。

桌宠连接只监听 `127.0.0.1` 随机端口，每次插件启用生成专用连接凭证，通过子进程私有启动环境传递；管理页不返回此凭证。不会转交 DSH 登录 Cookie、API Key，或依赖固定端口。卸载、停用或退出宿主时释放 Peer、事件订阅、端口和插件所属桌宠。

Standalone 模式仍使用手工配置的旧版 DSH Web 接口；官方 Desktop 的自动连接由本插件提供。
