# dsh-desk-buddy

[![Desktop validation](https://github.com/moutsea/dsh-desk-buddy/actions/workflows/desktop.yml/badge.svg)](https://github.com/moutsea/dsh-desk-buddy/actions/workflows/desktop.yml)

一个独立的 Agent 桌宠产品：陪伴、余额、任务状态、对话和任务调用。目前接入 DSH，并提供完整的 DSH 插件安装入口。

Electron 提供单一透明置顶窗口，React 构建桌宠和身旁的内容气泡，所有任务通过本机 DSH 执行。桌宠退出不会取消 DSH 中已接受的任务。角色采用蓝白鲸鱼娘形象：蓝色渐变长发、鲸鳍耳、鲸尾与蓝白女仆装，内置 19 张透明表情与姿态，支持自动跟随任务、日常互动和手动固定。

## 通过 DSH 插件安装

在官方 DSH Desktop 左侧打开“插件”→“添加插件”，粘贴以下仓库地址：

```text
https://github.com/moutsea/dsh-desk-buddy
```

安装后点击“立即启用”，再重启 Desktop。首次启动会自动识别系统，从 GitHub Release 下载已验证的桌宠组件，校验 SHA-256、解压并连接当前 DSH。Mac 和 Windows 使用同一个地址，无需另装 App、Node.js、Electron 或手动构建，也无需另外启动 Web 服务。当前支持 macOS Apple Silicon 和 Windows x64。

首次下载约 200–230 MB，需要能够访问 GitHub Release；成功后缓存到当前用户目录，后续启动无需再次下载。可在右下角“dsh-desk-buddy”查看准备状态；下载失败时，检查网络后点击“启动桌宠”重试。管理入口支持拖动并记住位置，默认避开左下角 user-menu；聚焦后也可用方向键移动，Home 恢复默认位置。

桌宠“设置 → 插件更新”和 DSH 页面“dsh-desk-buddy → 插件更新”均提供“检查更新”和“下载并更新”。只在点击后访问 GitHub，自动选择当前系统的正式版完整包、显示下载进度并校验 SHA-256，再通过 DSH 安装。升级会短暂重启桌宠，请保持 DSH 打开；可在 DSH 管理页查看更新结果，完成后重启 DSH。桌宠设置、窗口位置、对话记录和 DSH 中已接受的任务均保留；安装失败会尝试恢复旧版。每次下载约 200–230 MB。

0.12.4–0.12.5 若更新时报“DSH 未能卸载旧插件；已恢复旧版”，是旧更新器误判了 DSH 的“操作成功、需要重启”状态。请先重启 DSH，再在 DSH 插件管理中卸载桌宠，使用同一个 GitHub 仓库地址安装最新版并重启；原有设置和对话保留。0.12.6 起修复此问题。0.12.3 及更早版本也需重新安装一次新版才能获得更新按钮。插件列表、管理入口和管理页统一显示鲸鱼娘 logo。未提供插件管理接口的旧版 DSH Web 仍需通过原安装方式升级。

也可以在 [GitHub Releases](https://github.com/moutsea/dsh-desk-buddy/releases) 选择对应的完整 `.tgz`，将附件链接或本地文件的绝对路径填入同一安装框。完整包已包含组件，启用时无需额外下载：

| 系统                | 插件包                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64         | [dsh-desk-buddy-0.12.8-win32-x64.tgz](https://github.com/moutsea/dsh-desk-buddy/releases/download/v0.12.8/dsh-desk-buddy-0.12.8-win32-x64.tgz)       |
| macOS Apple Silicon | [dsh-desk-buddy-0.12.8-darwin-arm64.tgz](https://github.com/moutsea/dsh-desk-buddy/releases/download/v0.12.8/dsh-desk-buddy-0.12.8-darwin-arm64.tgz) |

仓库根目录已声明 `dsh.bundle`，可直接安装。若仍提示“这个包没有声明组合包，不能作为插件管理”，删除失败的旧安装项后重新添加上面的仓库地址，确保获取最新提交。自 0.12.1 起，仓库安装和 Release 完整包统一使用 `dsh-desk-buddy` 包名。升级前卸载旧的 `deepseek-girl` 或 `dsh-girl` 插件，再添加同一个仓库地址；原有桌宠设置与位置继续保留。不要使用 GitHub 自动生成的 Source code 压缩包或源码子目录代替安装来源。

DSH Web 用户可通过命令安装，无需另装 App、Electron 或手填地址：

```sh
dsh plugin --profile web add https://github.com/moutsea/dsh-desk-buddy
```

重启 DSH Web，桌宠自动启动并连接当前 DSH。页面右下角的“dsh-desk-buddy”入口可拖动，提供启动、关闭、显示、隐藏、打开对话、运行状态和“随 DSH 启动”设置；也可访问当前服务的 `/dsh-girl/`。停用插件或退出所属 DSH 时，插件管理的桌宠会退出，已接受的 DSH 任务不受关闭桌宠影响。

完整插件包由 `npm run pack:plugin` 生成，文件名包含版本、系统和架构。仓库入口只携带管理插件和下载清单，原生组件使用已发布的完整包。内置余额桥接，无需再装 `dsh-girl-bridge`；已有旧余额插件时先停用，避免路由重复。详见 [插件说明](plugins/dsh-girl/README.md)。

接入协议依据官方 DSH Desktop `0.2.1-rc.2` 和 DSH Web `0.1.1-rc.2`。Desktop 使用宿主正式 Gateway/Peer 接口，管理入口随官方启动注入加载。Desktop 插件由应用管理，不能使用 `dsh plugin --profile desktop` 安装。支持 GitHub 仓库地址和 Release 完整包两种安装方式，尚未发布到 npm 或插件市场。各系统的验证范围见 [平台验证](docs/platforms.md)。

## 独立运行与开发

需要 Node.js 22.12+、npm 和可用的 DSH Web 服务。

```sh
npm ci
dsh web --host 127.0.0.1 --port 3080 --no-open
npm run dev
```

打开设置，填写本机 DSH 地址（默认 `http://127.0.0.1:3080`），点击连接。选择项目目录，新建对话，发送任务。执行中的输入进入 DSH 队列；停止按钮取消当前轮次，DSH 原有排队消息可能继续执行。

- 平时只显示桌宠；鼠标悬停在她身上时，浮现“对话、表情、设置”三个气泡及带有“DeepSeek 余额”说明的金额标签，旁边以暖色“峰时”和绿色“谷时”显示 DeepSeek 官方 API 当前计价时段，并逐秒显示距下次切换的倒计时（如“峰时 02:15:30”）。超过一天时显示天数，自动跨过周末和节假日。按北京时间自动切换，移开后一起隐去。
- 点击气泡，在桌宠身旁的同一个窗口展开对应内容；设置中的“对话框大小”提供小（默认 360 × 460）、中（480 × 620）、大（600 × 760）三档，选择后自动保存，重启继续使用。屏幕空间不足时自动缩小适配，不改变文字和桌宠大小。再次点击同一气泡、右上角关闭或按 Escape 可收起，草稿保留。可用空间决定在左侧还是右侧展开。
- 直接按住桌宠身体即可自由拖动，松开后记住位置；轻点仍是摸摸她。展开的内容会跟随角色，靠近边缘时自动换到有空间的一侧，收起后保持角色位置。
- `Command/Ctrl+Shift+Space` 展开/收起对话；系统托盘可显示、隐藏桌宠或退出。图标使用当前鲸鱼娘角色的剪影；Mac 提供普通与 Retina 分辨率，由系统自动适配深浅色菜单栏，Windows 使用蓝色剪影。
- 在对话标题旁切换已有会话，也可点击加号新建会话，历史支持向前加载。聊天、讨论与执行都使用同一个 DSH 会话。
- 聊天中的助手名称统一为“dsh-desk-buddy”。工具调用直接显示实际命令、文件路径或查询内容，点击可展开完整参数，不再只显示 `bash` 等工具名。
- 收起内容时，执行中的会话会在桌宠上方显示进度气泡，包括工具命令、实时回复或待回答事项；点击气泡直接打开对应对话。优先提示待回应事项，其次为当前运行会话，再展示后台进度。气泡默认开启，可在“设置 → 执行进度气泡”中关闭，重启后保留选择；不会自动展开窗口或抢占焦点。
- 遇到工具审批可允许一次或拒绝；遇到提问可直接作答。
- 设置中的“桌宠大小”可在 50%–150% 之间调节，每档 5%，松开滑块后应用，可一键恢复默认 100%；重启后保留。气泡、余额与对话文字保持原大小。
- 默认启用窗口置顶，可在设置中关闭。面板关闭后，桌宠继续显示整体状态。
- “表情”页预览全部 19 种表情；点击即可固定，选择“自动跟随会话”恢复自动。也可右键点击桌宠快速选择。
- 对话与后台任务联动：读资料→学习、执行工具→工作、回复→开心、报错→震惊、成功→庆祝后开心。对话顶部小头像跟随当前会话，桌宠也关注后台会话。详见 [任务与表情联动](docs/task-behaviour.md)。
- 任一普通会话成功完成后，桌宠无需悬停就会跳跃庆祝 6 秒，并短暂显示任务名称；多个完成会合并计数。即使固定了表情，完成提醒也会短暂出现，随后恢复原选择；下一轮立即开始也不会漏掉提醒。仅根据实时成功事件触发，失败、取消及历史加载不触发，重复事件不会重复提醒。动态效果开关与系统减少动态效果设置继续生效。
- 点击比心、连续点 5 下生气、悬停 8 秒害羞；空闲时偶尔吃饭、读书或得意，1 分钟未互动会无聊、2 分钟犯困、4 分钟睡觉。可关闭空闲随机表情。
- 19 种表情的静态图和全部 76 个动作帧统一可见身高与脚底位置，切换不会忽大忽小。表情均提供逐帧循环动作：挥手眨眼、敲键盘、翻书、夹饭、举手欢呼等。桌宠、对话头像和表情预览使用同一套播放规则；“让她动起来”开关可暂停，系统减少动态效果也会生效。

## 余额插件

完整桌宠插件已内置余额功能。若只使用独立应用，可单独安装轻量余额插件，让 DSH 使用其凭证服务查询余额；独立应用不读取 API Key：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-girl/plugins/dsh-girl-bridge
```

重启 DSH Web 后，在应用中刷新余额。插件读取 DSH 中的 `DEEPSEEK_API_KEY`，返回按币种区分的官方余额，不返回密钥。余额表示这个 Key 所属账号，与会话使用的第三方模型余额无关。没有插件、没有凭证、数据过期等情况均明确展示。不需要安装鲸鱼参考插件。

峰谷时段按 [DeepSeek 官方规则](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-10-18 核对）显示：北京时间周一至周五 09:00–12:00、14:00–18:00 为峰时，周末、中国节假日及其余时段为谷时。倒计时指向下一次实际峰谷切换，悬停金额可查看目标时段、具体切换时间与规则；时段提示不依赖余额连接，也不代表第三方供应商的实际计费。已内置 [2026 年节假日日历](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html)；新年份需更新日历，未收录年份在可能的峰时明确显示“峰时·估算”，涉及未知日历的倒计时加“约”，跨年时同样说明估算原因。

## 构建与检查

```sh
npm test                 # 协议、流式解析、状态投影、余额插件
npm run test:manager     # 手动更新界面、下载校验、失败重试与 logo
npm run test:settings-update # 桌宠设置内更新、独立管理地址、进度与重试
npm run test:expand      # 首次展开与收起连续帧、原生窗口位置稳定
npm run test:stream      # Desktop 无游标流式回复、最终替换和断线清理
npm run test:completion  # 独立完成提醒、后台会话、去重及动态效果
npm run test:desktop     # 官方 Desktop 隔离安装与连接检查（先构建插件包）
DSG_TEST_MANUAL_UPDATE=1 npm run test:desktop # Mac 官方 Desktop 完整升级与配置保留
npm run test:repository  # 隔离安装仓库入口、下载 Release、原生启动和缓存重启
npm run test:plugin      # 真实 DSH 完整插件包安装、原生组件和管理流程（先构建插件包）
npm run test:packaged    # 安装完整包、解压和启动组件，再验证打包后的桌面交互
npm run build            # 类型检查与前端构建
npm start                # 运行构建后的桌面应用
npm run check:dsh        # 只读探测本机 DSH，DSH_URL 可覆盖地址
npm run test:ui          # 构建后执行 Electron 端到端检查（本地模拟服务）
npm run test:motion      # 构建后检查 19 段动画的真实帧变化、透明度、暂停与恢复
npm run test:size        # 构建后检查大小调节、屏幕边界、收起和重启恢复
npm run test:drag        # 构建后检查直接拖动、点击区分、内容跟随及位置恢复
npm run pack             # 生成本机平台的应用目录，输出到 release/
npm run pack:plugin      # 生成包含原生组件的完整 DSH 插件目录与 .tgz
```

`npm run dev:web` 仅用于界面预览，不提供桌面连接能力。界面不会展示模拟余额或伪造任务。自动化测试使用明确隔离的测试服务，不消耗模型额度。

在 macOS 上生成 `release/mac-arm64/dsh-desk-buddy.app`（Intel 为 `release/mac/`）；在 Windows x64 上生成 `release/win-unpacked/dsh-desk-buddy.exe`，整个目录需保持完整。插件包会携带该目录及全部运行依赖。当前构建尚未签名，macOS 也未公证。直接独立启动时需连接 DSH Web；通过插件启动时自动使用所属宿主。

GitHub Actions 在 Windows x64 和 macOS ARM64 上执行构建、单元检查、仓库入口安装、Release 下载和启动、完整包安装及桌面交互验证。只有验证成功的任务上传插件成品；截图和结果报告作为独立 artifacts 保存。Windows 使用系统自带 Windows PowerShell 和 .NET 解压，无需用户安装 Node、Electron、7-Zip 或执行安装脚本。Intel Mac 和 Windows ARM64 暂无 CI 验证成品，Linux 尚不支持完整插件。

## 文档

- [产品与交互](docs/product.md)
- [架构、协议和兼容性](docs/architecture.md)
- [开发阶段与验收记录](docs/roadmap.md)
- [DeepSeek 娘角色设定、素材与生成提示词](docs/character.md)
- [任务、对话与表情联动](docs/task-behaviour.md)
- [动态动作与素材维护](docs/animation.md)

## 来源

功能研究参考 [dsh-whale-widget-plus](https://github.com/louke6572/dsh-whale-widget-plus)；本项目重新实现界面和连接层。角色通过内置 ImageGen 参考鲸鱼娘形象重新绘制，素材来源与提示词见角色文档。DSH 接口依据本机 Web `0.1.1-rc.2` 与官方 Desktop `0.2.1-rc.2` 安装包的实现核对。独立客户端与 DSH 协议尚无稳定版本协商，升级后需重新验证。
