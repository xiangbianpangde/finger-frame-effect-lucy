# 手指取景框 · 实时 AI 🎬⚡

> **本仓库是 [sophiamyang/finger-frame-effect-lucy](https://github.com/sophiamyang/finger-frame-effect-lucy) 的 Fork。**
> 原作者：[@sophiamyang](https://github.com/sophiamyang) ｜ 上游仓库：[github.com/sophiamyang/finger-frame-effect-lucy](https://github.com/sophiamyang/finger-frame-effect-lucy)
> 本 Fork 在上游代码基础上新增**简体中文界面与文档本地化**（`index.html` / `main.js` / `README.md`）。
> 上游仓库未附带 LICENSE 文件，版权与使用条款归属原作者；本 Fork 不额外主张任何权利。

**在线体验（原作者部署）：https://sophiamyang.github.io/finger-frame-effect-lucy/**

双手比出取景框，框内会出现 **实时 AI 世界**——由
[Decart Lucy 2.5](https://docs.platform.decart.ai/models/realtime/lucy-2.5)
以约 30fps 生成（WebRTC 实时视频到视频）。与离线生成不同，AI 画面会跟着你动：眨眼它也眨眼，挥手它也挥手，模型延迟通常只有几十毫秒。

## 手指取景框系列

| 应用 | 生成方式 | 延迟 |
|---|---|---|
| [finger-frame-effect](https://sophiamyang.github.io/finger-frame-effect/)（[仓库](https://github.com/sophiamyang/finger-frame-effect)）— 实时摄像头 + 本地特效 | Canvas 2D（梵高、卡通、故障…） | 无 |
| [finger-frame-effect-ai](https://sophiamyang.github.io/finger-frame-effect-ai/)（[仓库](https://github.com/sophiamyang/finger-frame-effect-ai)）— 录制视频 + AI 重绘 | Gemini Omni Flash（离线视频编辑） | 数分钟 |
| **本应用** — 实时摄像头 + 实时 AI | Decart Lucy 2.5（实时视频到视频） | 近实时 |

![示例：取景框内的实时 AI 世界](examples/lucy.gif)

*实拍画面 — 框内 AI 世界随摄像头实时变化（[高清 mp4](examples/lucy.mp4)）。*

## 工作原理

- 摄像头画面（1280×720@30）镜像绘制到全屏画布，MediaPipe Hand Landmarker
  用与原版相同的管线追踪取景四边形（解剖学角点排序、手势滞回、瞬移拒绝、
  速度自适应平滑、短时丢失保持）。
- 同一路摄像头流经 WebRTC 发送到 Lucy 2.5；变换后的画面实时回传，并按屏幕对齐
  绘制在四边形内——手指取景框就是通往 AI 世界的窗口。
- 特效（按键 1–6，见下文[键盘操作](#键盘操作)）是 **实时风格提示词**：切换时会把新提示词推入当前会话，
  无需重连。「自定义 ✨」使用 🔑 面板中你自己写的提示词。

## 使用自己的密钥

到 [platform.decart.ai](https://platform.decart.ai/) 获取密钥，粘贴到 🔑 面板。
密钥只保存在浏览器中，仅用于与 Decart 的 WebRTC 会话。没有密钥时，框内会回退为
本地色彩滤镜，手势追踪仍可演示。

## 本地运行

```bash
python3 -m http.server 8125
```

打开 http://localhost:8125 并允许摄像头访问。`?demo` 使用合成画面和假手部关键点，
可在无摄像头时测试追踪（演示模式下 AI 关闭）。

## 键盘操作

| 按键 | 作用 |
|---|---|
| `1` | 3D 电影风格 |
| `2` | 动漫风格 |
| `3` | 赛博朋克风格 |
| `4` | 水彩风格 |
| `5` | 乐高定格风格 |
| `6` | 自定义 ✨（使用 🔑 面板中自己编写的提示词） |

切换风格会将新提示词推入当前 Lucy 会话，无需重连。工具栏按钮与按键等效。

## 浏览器要求与常见问题

| 现象 | 原因与处理 |
|---|---|
| 页面一直显示等待画面 | 未授予摄像头权限，请在地址栏左侧的权限图标中允许 |
| 框内是本地色彩滤镜而非 AI 画面 | 未填写 Decart 密钥，或 WebRTC 被网络/代理阻断 |
| 手势识别不稳定 | 双手保持约 30cm 距离、光线充足，避免手指交叉；追踪管线已内置滞回与瞬移拒绝 |
| 演示模式无摄像头 | 访问 `http://localhost:8125/?demo`，用合成画面测试追踪（AI 关闭） |

## 本 Fork 的改动

- 界面文案（状态提示、按键说明、错误信息）全面本地化为简体中文。
- 文档本地化：README 改为中文，补充键盘操作表与常见问题。
- 发送给 Lucy 的风格提示词**保持英文**，以获得更好的生成质量（Decart 官方模板以英文效果最佳）。
- 功能逻辑与上游保持一致，未改动追踪管线与渲染流程。

## 致谢

- 原作者 [@sophiamyang](https://github.com/sophiamyang) 及 [finger-frame-effect](https://github.com/sophiamyang/finger-frame-effect) 系列
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe) — 手部关键点追踪
- [Decart Lucy 2.5](https://docs.platform.decart.ai/models/realtime/lucy-2.5) — 实时视频到视频生成
