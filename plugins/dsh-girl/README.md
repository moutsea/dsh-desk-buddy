# DeepSeek Girl · DSH 插件入口

完整 DSG 桌宠的 DSH 安装和管理入口。插件包内含对应平台的桌宠组件，首次启用时校验、解压到当前用户目录并启动；无需另外下载 App、安装 Electron 或填写 DSH 地址。保留独立桌宠产品，插件只是一个接入渠道。

提供 macOS ARM64 和 Windows x64 构建，接入协议依据官方 DSH Desktop `0.2.1-rc.2` 和 DSH Web `0.1.1-rc.2`。插件自动识别宿主版本，余额查询通过 DSH 凭证服务完成。无需同时安装 `dsh-girl-bridge`；已有独立余额插件时，先停用旧插件，避免余额路由重复。平台验证范围见仓库 `docs/platforms.md`。

## 官方 DSH Desktop 安装

从 [GitHub Releases](https://github.com/moutsea/dsh-desk-buddy/releases) 选择系统对应的完整插件包。在 Desktop 左侧打开“插件”，选择添加插件，将 Release 附件的下载链接或下载后文件的绝对路径作为安装来源。例如 macOS ARM64：

```text
/absolute/path/to/dsh-girl-0.12.0-darwin-arm64.tgz
```

Windows x64 选择 `dsh-girl-0.12.0-win32-x64.tgz`，本地路径可以是 `C:\Users\YourName\Downloads\dsh-girl-0.12.0-win32-x64.tgz`。安装后点击“立即启用”，再重启 Desktop。左下角“DSG 桌宠”提供启动、关闭、显示、隐藏、对话和自动启动设置。无需另开 DSH Web 服务，也无需手填地址。Desktop 的插件由应用管理，不能使用 `dsh plugin --profile desktop` 修改。

## DSH Web 安装

下载适合当前系统和架构的完整插件包，然后通过 DSH 插件安装：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-girl-0.12.0-darwin-arm64.tgz
```

重启 DSH Web，插件会自动唤醒 DSG。DSH 页面左下角增加“DSG 桌宠”按钮，可查看状态、启动、关闭、显示、隐藏、打开对话，以及设置是否随 DSH 启动。也可在当前 DSH 地址后加 `/dsh-girl/` 打开管理页。关闭桌宠不会取消 DSH 任务；停用/卸载插件或退出所属 DSH 后，该插件管理的桌宠会退出。

DSG 自身的表情、角色大小、拖动、对话和完成提醒全部保留。插件模式下服务地址由所属 DSH 自动配置；独立启动方式仍可手动选择连接地址。插件数据与独立应用的数据隔离，避免相互改写连接和会话。

## 从项目构建

在目标系统的项目根目录执行 `npm ci` 和 `npm run pack:plugin`，输出 `release/dsh-girl-0.12.0-<platform>-<arch>.tgz` 和带版本、平台、架构名的插件目录。完整包包含桌面组件，源码子目录和 GitHub Source code 压缩包都不能代替构建产物。Windows 使用原生 `.exe` 及其完整依赖目录，macOS 使用 `.app`。

组件随插件包一起下载，没有额外运行时下载、安装脚本或后台更新器；升级时安装新版插件包，首次启动使用新版本组件。插件卸载后保留用户设置和已解压组件缓存，方便重新安装。未发布到 npm 或插件市场。

## Desktop 接入方式

使用官方结构化 `webserver/index-inject` 启动注入，兼容 `dsh-app://app` 页面及其同源转发。插件启动时等待宿主完成随机端口绑定，避免阻塞启动。

Desktop 0.2 使用 Typert Gateway 与 Connection Peer：插件创建自己拥有的本机 owner Peer，将会话列表、创建、发送、取消、历史和实时事件交给桌宠。审批、提问通过宿主 `$events` 转发和关联结果通道完成，可与主界面同步处理。关闭桌宠不取消已接受的任务。

桌宠连接只监听 `127.0.0.1` 随机端口，每次插件启用生成专用连接凭证，通过子进程私有启动环境传递；管理页不返回此凭证。不会转交 DSH 登录 Cookie、API Key，或依赖固定端口。卸载、停用或退出宿主时释放 Peer、事件订阅、端口和插件所属桌宠。

Standalone 模式仍使用手工配置的旧版 DSH Web 接口；官方 Desktop 的自动连接由本插件提供。
