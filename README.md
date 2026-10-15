# Claudio

> 你的情绪和所在的地方，就是我的提示词。我讨厌算法。我有自己的品味。

本地决策优先、通过大模型 API 理解与表达的个人 AI 电台。它把一句自然语言需求变成一首真实可播放的歌和一段可播出的 DJ 台词。

<p align="center">
  <img src="photos/claudio-radio-ui.png" alt="Claudio 电台界面" width="840" />
</p>

Claudio 把两件事分开处理：本地系统负责选歌、队列和播放可用性；通过大模型 API 调用的模型只负责理解、品味与表达。这样模型失效时，电台仍能继续播放；模型工作时，主持人也不会越权改歌。

## 它解决什么问题

普通播放器会给你歌单，普通聊天机器人会给你一段话。Claudio 想做的是两者之间的那一段：你说“下雨天想听点有节奏但不吵的歌”，它先从可播放曲库选出下一首，再为这首歌写一句可以念出来的开场。

它不是“让 LLM 随便推荐一首歌”的 Demo。歌曲必须存在、可播放、经过冷却和去重；DJ 决策的核心字段必须绑定已锁定的歌曲，并使用固定 JSON contract。

## 主要功能

- 用自然语言点歌、插队、请求下一首或生成场景歌单。
- 自动 Radio 默认从已同步的 KuGou API 曲库中选择可验证的播放源；`MUSIC_LIBRARY_DIR` 可用于本地曲目扫描与直接播放。
- 根据偏好、近期播放与时间调整选歌节奏，并保留天气、日历等环境信息作为可选上下文。
- 由大模型 API 从正向范式库中选择与当前歌曲匹配的参考片段，再创作 DJ 台词；范式可按自己的审美在 `prompts/dj-fewshot.md` 中编写或替换。
- 使用 Fish Audio 合成语音；准备失败或错过窗口时继续音乐，不在歌曲中途补播过期口播。
- 歌曲歌词与 DJ 字幕分别跟随音乐和语音时钟。DJ 没有原生时间时，只有在已知语音时长和多句边界的情况下才显示标注“估算”的句级字幕；其余显示纯文本，不模拟逐字时间。
- 可选接入固定版本的 Folia 歌词舞台；舞台失败时回退基本歌词，播放由独立执行器负责。
- 支持 Web Locks 的浏览器在同一来源下保持一个音频执行页，其余页面观察；刷新后恢复停止态队列。

## 架构

产品范围、架构取舍、实施顺序、验证结果和剩余工作，统一以 [Claudio 统一实施方案](CLAUDIO_IMPLEMENTATION_PLAN.zh-CN.md) 为唯一实施依据。新的合同、核心、执行器、服务端和页面已落地，并通过本轮隔离自动验收；真实账户、目标设备试听与日常观察仍待完成。旧私人聆听、模块化和 Live OS 文档只作历史参考。

<p align="center">
  <img src="photos/claudio-core-implementation-architecture-refined-2026-08.png" alt="Claudio 核心工程架构" width="840" />
</p>

> 这张历史示意图用于理解产品方向；当前模块与验收以统一实施方案为准。应用使用 React + Vite，不要求先安装 PWA。

代码按职责组织：

| 位置 | 责任 |
| --- | --- |
| `packages/contracts` | 共享身份、请求/响应和运行时校验 |
| `packages/playback-core` | 不依赖浏览器的队列、播放与转场状态转换 |
| `packages/playback-web` | 唯一音频执行器、双音乐通道与语音通道、时钟、跨页所有权 |
| `src/app`、`src/features`、`src/playback` | 应用装配、用户操作、HTTP适配与只读状态显示 |
| `server/application`、`server/ports`、`server/adapters` | 准备歌曲、来源解析、歌词、文稿/TTS与真实开始记录 |
| `src/stage` | 固定 Folia 构建的只读歌词适配，不控制音频 |

选曲和准备不会写入已播历史；执行器确认歌曲实际开始后才提交 `started`。模型写稿绑定确定的歌曲与转场上下文，不能自行换歌。DJ 的写作参考仍来自 `prompts/dj-fewshot.md`。

迁移到 Windows 主机继续实施，请先读 [主机交接文档](HOST_HANDOFF.zh-CN.md)。主仓 Git 不包含独立 Folia 仓库及已验证舞台产物，两者随交接包提供。

## 快速开始

### 前置条件

- 推荐 Node.js 24（当前验证使用 24.19.0）
- 一个可用的 KuGou-compatible 服务与可访问的 KuGou 曲库（自动 Radio 的默认播放路径）
- 可选：OpenAI-compatible 或 DeepSeek 大模型 API Key，用于模型辅助的意图理解与 DJ 串词
- 可选：Fish Audio API Key；`MUSIC_LIBRARY_DIR` 可用于本地曲目扫描与直接播放

```powershell
git clone https://github.com/89630618/claudio-radio-wanfeng.git
cd claudio-radio-wanfeng
Copy-Item .env.example .env
npm ci
npm run dev
```

打开 `http://localhost:5173`。前端默认连接 `http://localhost:3080`。

macOS / Linux 使用：

```bash
git clone https://github.com/89630618/claudio-radio-wanfeng.git
cd claudio-radio-wanfeng
cp .env.example .env
npm ci
npm run dev
```

## 配置

所有密钥都只放在本地 `.env`；这个文件已被 Git 忽略，不能提交。

| 配置 | 用途 |
| --- | --- |
| `MUSIC_LIBRARY_DIR` | 可选，本地曲目扫描与直接播放目录；自动 Radio 仍以可验证的 KuGou 播放源为准 |
| `USER_PROFILE_DIR` | 本地口味、反馈和访谈数据目录，默认 `.data/user` |
| `KUGOU_API_BASE_URL` | KuGou API 服务地址 |
| `AI_API_KEY`、`AI_MODEL` | 默认模型与 API Key |
| `DJ_AI_MODEL` | DJ 串词模型，可单独覆盖 |
| `CHAT_AI_API_KEY`、`CHAT_AI_MODEL` | 对话模型兼容字段；当前聊天调用沿用通用模型配置 |
| `FISH_TTS_API_KEY`、`FISH_TTS_VOICE_ID` | Fish Audio 语音配置 |

`.env.example` 提供字段模板，其中 `AI_BASE_URL` 只是 OpenAI-compatible endpoint 示例。自动 Radio 默认使用 KuGou API；模型供应商、兼容 endpoint 和 API Key 由部署者自行选择。未配置模型时，模型辅助能力不可用，但规则选歌路径仍可运行。`MUSIC_LIBRARY_DIR` 留空时不会影响 KuGou API 选歌。

DJ 串词的正向范式库位于 `prompts/dj-fewshot.md`。它不是平台抓取内容，而是你为 Claudio 准备的写作参考：可保留、增删或重写成符合自己审美与节目气质的文本。每次生成时，大模型 API 会从中挑选最适合当前歌曲的参考片段。

首次运行时，Claudio 会在 `.data/user` 创建空白的口味档案。这里以及 `.data` 中的播放记录、KuGou 会话、TTS 缓存都属于个人运行数据，不会进入 Git。启用模型或天气请求时，必要字段会按配置发送给对应的第三方服务；本地保存与第三方调用是两个边界。

Claudio 的界面头像作为产品资源随仓库提供；音乐文件、账号会话与 API 凭据仍由部署者自行管理，不随项目运行数据进入 Git。

## 安全与内容边界

- 服务默认只监听 `127.0.0.1`。不要将开发服务器、`.data` 或带有账号会话的实例直接暴露到公网。
- 仓库不包含音乐文件或完整歌词库，也不包含平台账号、Cookie 或播放历史。Prompt 示例、头像、第三方依赖和平台服务可能有各自的来源与许可边界；部署者需自行取得合法的 KuGou 平台访问权限、音乐来源与模型 API 凭据。
- KuGou-compatible 服务是可替换的外部依赖；请自行审查其许可证、固定版本和平台条款。`scripts/setup-kugou-api.ps1` 固定到已审查提交 `06560e3e053bda1ab830750db6f645bab703f824`，不会自动追随上游最新代码。项目不会提供共享账号或公共音频转发服务。

## 使用方式

在输入框直接说出场景或动作，例如：

```text
下雨天想听点有节奏但不吵的歌
播放 The xx - Intro
把下一首插进队列
给我一份今晚写代码的歌单
```

系统会先返回可播放的歌曲，再生成与该歌曲绑定的 DJ 台词。偏好与近期播放参与选歌；天气和日历是否进入具体流程由请求与界面状态决定，默认不进入台词正文。

正在听歌且已有排队曲目时，聊天点歌会安排为下一首，回复会明确显示“下一首播放”；空闲时可以立即开始。点击已有队列行会切到该条目并保留其余队列。当前页面采用顺序口播；核心已支持 crossfade，但尚未提供模式切换入口，默认听感取舍仍需同稿试听。

## 输入与输出示例

先检查前后端协议：

```bash
curl http://localhost:3080/api/v1/protocol
```

当前页面要求 `protocolVersion: 1` 与 `playbackProtocol: "v1"`。版本不匹配时不会启动执行器。共享字段和校验器位于 `packages/contracts/src/api`，主要接口如下：

| 接口 | 用途 |
| --- | --- |
| `POST /api/v1/playback/prepare` | 为指定队列条目准备曲目或电台候选，不记已播 |
| `GET /api/v1/playback/preparations/:preparationId` | 读取/等待准备阶段变化 |
| `POST /api/v1/playback/resolve` | 解析或刷新同一条目的实际媒体身份与播放句柄 |
| `POST /api/v1/playback/narration` | 准备绑定前后曲目和转场的文稿/语音 |
| `POST /api/v1/playback/lyrics` | 获取绑定实际录音版本的歌词 |
| `POST /api/v1/playback/started` | 由执行器提交真实开始事实，幂等接收 |
| `PUT /api/v1/now` | 当前执行器的低频只读投影，不控制播放 |

不要用手工调用 `started` 模拟试听。旧 `/api/radio/next`、直接播放源/流和旧 DJ 副作用入口在 v1 模式返回410；回退旧版本应使用对应的完整前后端检查点，不能将新页面接到旧协议。

## 开发与验证

```bash
node scripts/test.mjs
npm run typecheck:packages
npm run build
node scripts/app-e2e/run.mjs --out /tmp/claudio-app-check
```

统一测试入口使用临时数据目录，分别运行包、服务端和UI测试并报告跳过项。KuGou上游兼容测试需要固定源码checkout：设置 `CLAUDIO_KUGOU_API_REVIEWED_DIR` 后可加 `--require-upstream`，缺失时不能把跳过说成已验证。浏览器执行器验证入口为 `npm run test:browser`；主页面验收使用 `scripts/app-e2e/run.mjs`，覆盖真实页面、播放执行器与隔离服务端。两者均需可用的Chromium；主页面工具的环境配置、场景及证据范围见 [验收工具说明](scripts/app-e2e/README.md)，实际结果以统一实施方案为准。

`npm run smoke` 已通过隔离包装器运行旧模块检查：临时工作目录、空凭据、只允许回环网络，默认清理生成的数据；它不是新核心的完整验收。DJ质量脚本仍依赖配置的曲库与外部服务。常规回归使用上述统一测试入口；生产构建后可执行 `npm run verify:artifact` 检查脱离源码的模块导入。CI固定Node和KuGou上游版本，要求上游兼容测试实际运行。开发命令直接解析workspace源码，无需先build。

可选Folia舞台使用独立仓库的已验证构建，导出到被git忽略的静态目录：

```bash
node scripts/folia-stage-export.mjs --stage ../claudio-folia-stage
```

此命令要求独立stage仓库已有干净构建，校验后更新主应用pin；不会从任意上游最新代码自动取版本。没有该构建或校验不匹配时，应用使用基本歌词。独立仓库的对应源码、构建信息与第三方许可随导出产物提供。

## 当前范围

Claudio 当前专注于“可靠播放 + 有品味的表达”。歌词、热评、故事卡、复杂 scheduler 与未经验证的外部资料不在正式 DJ 写作链路内。

Folia歌曲歌词舞台已接入为可选显示层，与DJ写作输入分开。真实账户、目标设备的后台行为和日常使用观察按统一实施方案单列；合成音频测试不能替代这些结果。

## 许可证

项目自身代码、项目文档与明确标注为原创的随仓库材料采用 [Apache License 2.0](LICENSE)。第三方依赖、头像与字体等素材、音乐内容、平台服务和模型 API 不因本项目采用 Apache-2.0 而改变其各自的许可证或使用条款。

Copyright (c) 2026 89630618

Claudio 是独立项目与虚构主持人名称，不隶属 Anthropic 或 Claude 产品。音乐、平台服务与模型 API 均为使用者自行配置的外部依赖。
