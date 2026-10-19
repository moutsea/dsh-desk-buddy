# DeepSeek 娘 · 角色与美术资产

项目名称为 **DeepSeek Girl**，角色称为 **DeepSeek 娘**。本版替换早期绿色 SVG 小精灵，采用 DeepSeek 鲸鱼娘的蓝白二次元形象。角色用于桌面陪伴、任务反馈、聊天面板和应用图标。

## 视觉设定

蓝宝石色长发渐变至浅青发梢，鲸鳍耳、前弯呆毛、双叶鲸尾；蓝眼睛、柔和腮红；藏青与白色女仆装、白围裙和小鲸鱼徽记。采用精致 Q 版比例、细腻线稿和柔和赛璐璐上色，让脸部和鲸鱼特征在桌宠尺寸下依然清晰。

## 素材与状态

所有角色素材使用内置 **ImageGen** 生成，保留真实透明通道。静态立绘尺寸约为 **1145 × 1374**，动态动作使用同等比例的 2 × 2 帧图。最终素材已复制进项目，不依赖 Codex 缓存路径。

| 文件                                            | 用途                        |
| ----------------------------------------------- | --------------------------- |
| `public/characters/deepseek-girl/idle.png`      | 待机、聊天面板及应用头像    |
| `public/characters/deepseek-girl/blink.png`     | 待机眨眼、手动闭眼          |
| `public/characters/deepseek-girl/thinking.png`  | 任务思考                    |
| `public/characters/deepseek-girl/happy.png`     | 任务完成、空闲笑容          |
| `public/characters/deepseek-girl/shy.png`       | 害羞、悬停互动              |
| `public/characters/deepseek-girl/angry.png`     | 生气、连续点击              |
| `public/characters/deepseek-girl/sad.png`       | 委屈、任务出错              |
| `public/characters/deepseek-girl/surprised.png` | 震惊                        |
| `public/characters/deepseek-girl/confused.png`  | 疑问、等待用户回应          |
| `public/characters/deepseek-girl/love.png`      | 比心、点击互动              |
| `public/characters/deepseek-girl/cheer.png`     | 加油                        |
| `public/characters/deepseek-girl/proud.png`     | 得意                        |
| `public/characters/deepseek-girl/working.png`   | 敲电脑、工具执行            |
| `public/characters/deepseek-girl/rice.png`      | 吃白饭                      |
| `public/characters/deepseek-girl/sleepy.png`    | 困困、2 分钟未互动          |
| `public/characters/deepseek-girl/sleeping.png`  | 睡觉、未连接或 4 分钟未互动 |

另新增 `learning.png`（捧书学习）、`bored.png`（托脸无聊）、`celebrating.png`（举手庆祝）。现在共 19 张独立状态立绘，作为图标和动作加载失败时的静态后备；其中庆祝为 1144 × 1375，其余约 1145 × 1374。

0.5.0 又为全部 19 个表情绘制了四帧动作图，共 76 个动作帧，保存在 `public/characters/deepseek-girl/animations/{表情ID}.png`。桌宠、聊天头像和表情页实际播放这些连续帧，眼睛、嘴巴、手和道具随动作变化。动作就绪后停止整张图的旧呼吸/摆动，使用逐帧裁切与脚底对齐保持稳定；详细规则见 [动态动作](animation.md)。支持关闭动作、系统减少动态效果和隐藏窗口暂停。切换时先解码后替换，避免空白。

0.7.0 为 19 张静态图及 76 个动作帧统一主体可见身高和脚底位置：使用 alpha 最大连通主体估算身高、下部脚点，映射到同一 1000 × 1200 坐标系。裁切允许鲸尾略超出帧格边缘，避免尾巴被切平。源 PNG 不修改，静态后备也使用同一基准；更换表情不再随透明留白和动作图尺寸变化而缩放。

## 表情使用

“表情”页提供完整预览，也可右键点击桌宠，从日常心情、陪伴互动、工作与生活三个分类中选择。固定选择与空闲开关保存到本地设置，重启后恢复。固定只改变角色外观，悬停时的状态文字继续显示实际任务状态。

自动模式下，执行任务优先于日常互动与随机卖萌：思考→托腮、读取/搜索→捧书学习、其他工具执行→敲电脑、文本回复→开心、等待回应→疑问、错误→先震惊再恢复执行或委屈、成功→先庆祝再开心、未连接→睡觉。对话顶部小头像跟随当前会话；桌宠关注所有普通会话，隐藏面板仍会反应。完整事件映射、优先级与时长见 [任务与表情联动](task-behaviour.md)。空闲时点击→比心，1.8 秒内连续 5 次点击→生气，悬停 8 秒→害羞。

开启“空闲时也有小情绪”后，每隔 28–48 秒随机展示吃饭、得意、加油、开心或读书，持续 7 秒；无互动超过 1 分钟无聊、2 分钟困困、4 分钟睡觉。新任务或在对话面板操作会唤醒桌宠。关闭该选项后停止空闲随机、无聊与自动犯困，点击/悬停互动仍可用。空闲读书仅为陪伴动作，不调用模型。

`src/Mascot.tsx` 统一消费角色素材；`scripts/icon.mjs` 将同一立绘放入 `build/icon.svg` 的蓝色圆角构图中，生成 `build/icon.png`。生产构建复制 `public/` 素材进 `dist/`，桌面安装包内置这些图片。

## 参考来源与署名

本次立绘以用户指定的 DeepSeek 娘化角色为蓝本。直接视觉参考为 [dsh-whale-widget-plus](https://github.com/louke6572/dsh-whale-widget-plus) 的 `assets/v4/DSniang1.png`，角色特征亦对照 [DeepSeek Whale-chan 社区角色项目](https://github.com/Neko3000/deepseek-whalechan)。新 PNG 为 AI 重绘的角色变体，不是直接复制参考 PNG。

社区项目记载的已知形象创作者包括 [上善无形](https://space.bilibili.com/4456176) 和 [ZipZipPipe](https://space.bilibili.com/4168597)。角色设计及品牌归属保留给相关权利人，本项目不将其声明为独占原创，也不是 DeepSeek 官方应用。参考仓库的代码许可不等同于角色美术许可。

## 完整生成提示词

生成方式：内置 `image_gen.imagegen`，静态立绘 19 次、动态动作图 19 次，均开启 `transparent_background: true`。首张以鲸鱼娘原图作为角色参考，后续静态图以本项目 `idle.png` 为编辑目标，动作图分别以对应表情立绘为编辑目标；未使用 CLI、外部图像 API 或手工抠图。0.3 新增 12 张的提示词、中文名称与最终保存路径在 [expression-prompts.json](expression-prompts.json)，0.4 三张在 [task-expression-prompts.json](task-expression-prompts.json)，0.5 全部动作图的完整提示词、参考图及逐张路径在 [animation-prompts.json](animation-prompts.json)。下文保留首版四张提示词。

### 待机立绘

```text
Use case: stylized-concept. Asset type: production transparent desktop-pet character sprite for the application DeepSeek Girl. Input image 1 is a CHARACTER DESIGN REFERENCE, not an edit target: use the recognizable DeepSeek whale-girl motifs but redraw with much more polished original anime illustration craftsmanship. Create ONE beautiful full-body semi-chibi DeepSeek-chan, 2.8 heads tall, facing front in a relaxed slight three-quarter stance. Long flowing deep sapphire blue hair softly graduating to luminous cyan at the curled tips, elegant single forward-curving ahoge, a pair of low SIDE whale fins integrated at ear level (clearly whale fins, NOT cat ears), expressive large ocean-blue eyes with sophisticated iris highlights, delicate blush and a gentle friendly knowing smile. A clearly visible curved blue WHALE TAIL with two horizontal flukes behind her to the viewer's right. Wear an elegant fully covered navy-blue and crisp white maid dress, white ruffled headband, small cobalt bow and tiny pale-blue gem at collar, neat white apron with subtle small whale emblem, tailored dark blue skirt with refined white frills and only very restrained silver trim, opaque white stockings and navy Mary Jane shoes. One hand gently raised in a welcoming small wave near shoulder, the other rests naturally at her skirt. Premium Japanese anime game companion illustration: exquisite clean ink lines, beautiful hand-drawn face, soft cel shading with gentle gradients, convincing layered hair and fabric, crisp readable silhouette even at 220px tall. Attractive, charming, softly rounded, NOT a crude vector blob and NOT an oversized bobble head. Entire head, ahoge, both hands, shoes and entire whale tail must fit fully in frame with 8 percent transparent margins. Centered isolated character ONLY, real alpha transparency; no backdrop, no ground plane, no cast shadow, no frame, no text, no speech bubble, no logo text, no watermark, no extra characters or props. Do not copy the exact reference pose or linework. Her face and blue hair are the focal point.
```

### 三张表情的共同前缀

每张表情的实际提示词为以下共同前缀与对应状态指令直接拼接。

```text
Use case: identity-preserve. Asset: a transparent desktop pet mood sprite for DeepSeek Girl. Input image 1 is the EDIT TARGET and the locked character identity. Preserve the exact same recognizable whale-girl design, proportions, beautifully drawn face, deep sapphire to cyan long hair, whale-fin ears, single ahoge, entire blue whale tail with horizontal flukes, navy and white modest maid costume, opaque stockings, shoes, line quality and rich clean cel shading. Preserve image aspect ratio, scale, head position, feet baseline and overall silhouette. One entire full-body character centered on genuine transparent alpha, with all hair, ahoge, tail, hands and shoes fully inside the canvas, 8 percent clear margins. No text, no logos, no extra characters, no scene or cast shadow.
```

眨眼：

```text
Change ONLY her eyelids and tiny mouth to make a natural gentle blink: both eyes closed as elegant soft curved eyelashes, peaceful small smile. Absolutely preserve the original standing wave pose and all other geometry so this frame can alternate with the original for blinking without jumping. Keep the figure still.
```

思考：

```text
Change her expression and arms for a cute focused thinking state: very slightly knitted eyebrows, attentive ocean-blue eyes glancing a little upward, small thoughtful closed mouth, her originally raised waving hand now gently touching her chin with one finger. The other hand stays by the skirt. She looks clever and quietly engaged, not distressed. No new props or graphic symbols. Keep the same head and feet placement.
```

开心：

```text
Change her expression to a very happy task-complete smile, both eyes softly closed in cheerful crescents, subtle warm blush, small joyful open smile; her waving hand lifted just slightly more energetically but still next to her face. The other hand stays by her skirt. The face must still be delicate and attractive, not exaggerated meme art. No new props or drawn symbols. Keep the same head and feet placement.
```
