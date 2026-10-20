# 使用与开发指南

安装和升级见 [插件说明](../plugins/dsh-girl/README.md)，平台限制见 [平台支持与验证](platforms.md)。

## 日常使用

平时只显示桌宠，悬停后出现「对话、表情、设置」入口及余额。点击入口，在角色身旁展开面板；再次点击、右上角关闭或按 `Esc` 收起，草稿保留。`Command/Ctrl + Shift + Space` 可直接切换对话面板。

按住角色拖动，位置会自动保存。设置可调整桌宠大小（50%–150%）、窗口置顶、动画、闲置表情和对话框大小。小、中、大对话框分别以 360 × 460、480 × 620、600 × 760 为目标，空间不足时适配屏幕。

对话标题旁切换会话，加号新建会话，历史可向前加载。执行期间发送的消息进入 DSH 队列；停止按钮取消当前轮次，原有排队消息可能继续执行。审批和提问可以直接在对话框处理。

收起面板后，执行进度气泡显示工具命令、实时回复或待回应事项，点击直达对应会话。成功完成时，桌宠庆祝并短暂显示任务名；失败、取消和历史加载不触发完成提醒。关闭桌宠不会取消 DSH 中已接受的任务。

## 用量与提示音

对话框显示当前会话累计 Token、输入缓存命中率和上下文占用，点击展开明细。输入包含未缓存输入、缓存读取和缓存写入；命中率为缓存读取 ÷ 全部输入。上下文属于单次请求占用，估算值带「≈」。未上报或无可计算样本时显示「—」，不据此推算费用。累计数据来自宿主，历史分页不会重复累加。

「设置 → 声音陪伴」可选择 8 种声线、试听、调节音量，分别开关摸摸、完成和闲置招呼。默认音量 35%，设置在重启后保留。语音离线播放，切换声线、静音或关闭对应场景会停止相关声音。

轻点角色回应，拖动不响；任务成功完成时说「做好啦」。闲置约 75–105 秒后偶尔招呼，之后至少间隔 2 分钟；工作、待回应、展开面板、隐藏和睡着时保持安静。音频资源、来源与重新生成方式见 [语音包说明](voices.md)。

## 余额

完整桌宠插件已内置余额桥接，通过 DSH 凭证服务查询 DeepSeek 官方余额，不向桌宠传递 API Key。余额属于该 Key 对应的账号，与第三方模型供应商的余额无关。

独立运行时，可单独安装轻量余额插件并重启 DSH Web：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-girl/plugins/dsh-girl-bridge
```

已使用完整插件时无需再装余额插件。峰谷倒计时按北京时间显示 DeepSeek 官方 API 计价时段，跨周末和已收录节假日计算；未知年份会标明估算，不代表第三方供应商的实际计费。

## 独立运行

需要 Node.js 22.12+、npm 和 DSH Web：

```sh
npm ci
dsh web --host 127.0.0.1 --port 3080 --no-open
npm run dev
```

打开设置连接 `http://127.0.0.1:3080`，选择项目目录后新建对话。官方 DSH Desktop 通过插件自动接入，无需另外启动 Web 服务。`npm run dev:web` 仅预览界面，不提供桌面连接能力。

## 检查与构建

| 命令 | 检查内容 |
| --- | --- |
| `npm test` | 协议、状态、统计合并、音频竞态和资源完整性 |
| `npm run build` | 类型检查与前端构建 |
| `npm run test:ui` | 对话、审批和提问流程 |
| `npm run test:usage` | 用量、分页、乱序快照、Desktop 统计流及持续输出 |
| `npm run test:sound` | 声线、解码、音量、静音、优先级、重试和闲置 |
| `npm run test:stream` | Desktop 流式回复与断线清理 |
| `npm run test:completion` | 完成提醒与后台会话 |
| `npm run test:expand` | 首次展开和收起、窗口锚点与闪烁 |
| `npm run test:motion` | 动画帧、透明度、暂停与恢复 |
| `npm run test:size` / `npm run test:drag` | 缩放、拖动、边界及位置恢复 |
| `npm run test:manager` / `npm run test:settings-update` | 插件管理、下载校验、进度与失败重试 |
| `npm run test:repository` | 仓库入口安装、Release 下载、启动和缓存 |
| `npm run test:packaged` | 完整插件包安装和打包后的交互 |
| `npm run test:desktop` / `npm run test:plugin` | 官方 Desktop / Web 隔离安装（需先打包） |

桌面检查先执行 `npm run build`。自动检查使用隔离服务，不消耗模型额度；官方宿主验证方法及平台差异见 [平台文档](platforms.md)。

```sh
npm run pack:plugin  # 在目标系统生成含原生组件的完整 .tgz
npm run check:dsh    # 只读探测本机 DSH；DSH_URL 可覆盖地址
```

生成的插件包位于 `release/`，文件名包含版本、系统和架构。GitHub Actions 在 Windows x64 和 macOS ARM64 上验证后发布；仓库下载清单在 Release 可用后更新。

## 更新 README 截图

```sh
npm run build
npm run screenshots:readme
```

脚本启动隔离的真实 Electron 窗口，使用固定演示会话和用量，更新 `docs/images/` 中的对话、统计和声音设置截图。不会读取日常会话或调用模型。README 必须保留演示数据说明。
