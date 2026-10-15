# Claudio Windows 主机实施交接

交接日期：2026-10-16（Pacific/Auckland）。接收环境：Windows 主机、PowerShell。

本轮播放核心重构、完整页面接线与 Linux 隔离自动验收已完成。接手后先恢复同一代码与 Folia 产物，再验证 Windows 环境，最后接真实账号、音源和设备进行日常试听。

**产品决策、架构和后续工作的唯一真相源仍是 [统一实施方案](CLAUDIO_IMPLEMENTATION_PLAN.zh-CN.md)。** 本文只负责迁移、启动、核验与交接，不设第二套实施计划。三个旧根方案是历史材料。

## 交付版本与边界

| 项目 | 固定版本或状态 |
| --- | --- |
| 主仓 | `https://github.com/lupanpan1030/claudio-nexus-radio.git`，目标分支 `main` |
| 实施分支 | `codex/playback-core-rebuild`；保留全部小提交，快进合入 main |
| 已验收产品代码 | `769d02e`；浏览器工具 `1b32bf5`；最终验收台账 `1f5d9a2` |
| 本次交接提交 | 交接包 `TRANSFER_MANIFEST.json` 的 `mainCommit`，包内 main bundle 指向该提交 |
| Folia 独立仓 | `claudio-folia-stage`，无托管远端，分支 `codex/read-only-lyrics-stage` |
| Folia 提交 | `0d33b05d6a3f8ded16d0eea0ba6c6104318f6065`，contractVersion `2` |
| Folia 上游 | `chthollyphile/folia-major`，`a57803d09283d417497a4b951834c00d7b6f5a3c` |
| 验收运行时 | Node.js `24.19.0`、npm `11.17.0`、Linux；原生 Windows 尚未验收 |
| 变更范围 | 代码与合成测试；没有迁移真实运行库、账号或凭据 |

本次合并推送会运行主仓 CI；Showcase Pages 仅能手动触发，不随 main 推送部署。远端 CI 的实际状态以该提交的 Actions 记录为准。

## 带到主机的文件

迁移包 `claudio-host-transfer-20261016.tar.gz` 解压后得到同名目录：

| 文件 | 用途 |
| --- | --- |
| `claudio-nexus-radio.bundle` | 主仓 main 和实施分支的完整可达历史，可离线 clone |
| `claudio-folia-stage.bundle` | 独立舞台的完整源码和 Git 提交；主仓 clone 不包含它 |
| `folia-stage-dist.tar.gz` | 已验证的完整 `dist/`，含 chunks、对应源码压缩包和许可证 |
| `evidence/` | 最终测试、构建、浏览器结果、截图及独立审查报告 |
| `research/` | 既有产品审查的正文证据与公开模型结论，供历史查证 |
| `HOST_HANDOFF.zh-CN.md` | 本交接文档副本 |
| `TRANSFER_MANIFEST.json` | 两仓提交、舞台固定值、交付范围 |
| `SHA256SUMS` | 包内每个普通文件的 SHA-256；不含清单自身 |

包内不含 `.env`、真实 `.data`、账号会话、音乐、用户档案、浏览器配置、Claude 登录凭据、`node_modules` 或原始模型会话日志。研究正文是历史证据，不能覆盖统一方案。原 `/tmp` 证据路径仅说明生成位置；接手时使用包内 evidence，不依赖原机器临时目录。

## 在 PowerShell 恢复代码

以下示例把迁移包放在 `D:\ClaudioTransfer`，两个仓库放在 `D:\Projects`。替换为自己的空目录。不要覆盖主机上已有改动的 checkout；先备份或使用新目录。每一步外部命令成功后再继续，PowerShell 不一定自动因非零退出而停止。

```powershell
Set-Location D:\ClaudioTransfer
tar -xzf .\claudio-host-transfer-20261016.tar.gz
$packet = (Resolve-Path .\claudio-host-transfer-20261016).Path

Get-Content (Join-Path $packet 'SHA256SUMS') | ForEach-Object {
    $parts = $_ -split '  ', 2
    if ($parts.Count -ne 2) { throw '校验清单格式错误' }
    $file = Join-Path $packet $parts[1]
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $parts[0]) { throw "校验失败: $($parts[1])" }
}

New-Item -ItemType Directory -Force D:\Projects | Out-Null
Set-Location D:\Projects
git clone -c core.autocrlf=false --branch main "$packet\claudio-nexus-radio.bundle" claudio-nexus-radio
git -C .\claudio-nexus-radio remote set-url origin https://github.com/lupanpan1030/claudio-nexus-radio.git

git clone -c core.autocrlf=false --branch codex/read-only-lyrics-stage "$packet\claudio-folia-stage.bundle" claudio-folia-stage

$manifest = Get-Content "$packet\TRANSFER_MANIFEST.json" -Raw | ConvertFrom-Json
if ((git -C .\claudio-nexus-radio rev-parse HEAD) -ne $manifest.mainCommit) { throw '主仓提交不匹配' }
if ((git -C .\claudio-folia-stage rev-parse HEAD) -ne $manifest.stageCommit) { throw '舞台提交不匹配' }
git -C .\claudio-nexus-radio status --short
git -C .\claudio-folia-stage status --short
```

两个 status 应为空。`core.autocrlf=false` 保留舞台固定源码字节，避免 Windows 换行转换导致 provenance/hash 校验失败。Folia clone 后的 origin 暂指向 bundle，不是线上仓库；不要照搬主仓的 origin，也不要把其 AGPL 源码直接塞入主仓。

也可以从上述 GitHub 地址 clone main；仍需迁移包中的舞台仓库和产物。已有主仓只有在工作树干净且没有分叉时才执行 `git pull --ff-only origin main`。出现分叉应先查看双方提交，禁止用 `reset --hard` 覆盖本机工作。

## 安装依赖并恢复 Folia

主机先准备 Git、tar、Node.js 24；用 `node --version`、`npm --version` 检查，尽量与上述已验收版本一致。若 PowerShell 阻止 `npm.ps1`，使用 `npm.cmd`，不必为了本项目修改整机执行策略。两个仓库分别安装依赖，不能复制 Linux 的 node_modules。

```powershell
Set-Location D:\Projects\claudio-nexus-radio
npm.cmd ci

Set-Location D:\Projects\claudio-folia-stage
npm.cmd ci
tar -xzf "$packet\folia-stage-dist.tar.gz"
npm.cmd run upstream:check
npm.cmd run dist:check

Set-Location D:\Projects\claudio-nexus-radio
node scripts/folia-stage-export.mjs --stage ..\claudio-folia-stage
git diff --exit-code -- src/stage/folia-stage.pin.json
```

本段应保留既有 pin，不产生 Git 差异；不要用 `--allow-uncommitted` 跳过检查。导出必须在主仓 build 前完成，否则重建主仓以将舞台带入生产静态目录。纯源码重建舞台可运行 `npm.cmd run verify`；若重建哈希改变，先解释环境或源码差异，再做独立验证，不以自动改 pin 代替验收。

固定值供排查：

- sourceSha256：`711c667fc00f133456e7aad77bd1d9e1034573bae459cdc82460e384299fd67e`
- 入口 folia-stage.js：`5f50fc6ae75166d2a19b0ac54287c265272268afb2a09f1ae7ac7b16553f52af`
- 对应源码包：`43c0ae0710510d5a26fac813fd8c164440ff4077ec498158349e62e4bb9b20f8`

舞台必须整体传递，包含许可证、源码包和所有 chunks；单独复制入口 JS 不够。没有产物或 pin 不匹配时应用会回退基本歌词。目标浏览器需要 WebGL 与中文字体；迁移包不包含原机器字体或 Chromium。

## 配置与启动

先用新建运行目录验证，确认后才导入自己的历史数据。

```powershell
Set-Location D:\Projects\claudio-nexus-radio
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

在本机编辑 `.env`：

- `CLAUDIO_HOST=127.0.0.1`，`PORT=3080`。
- 将 `DATA_DIR`、`USER_PROFILE_DIR`、`MUSIC_LIBRARY_DIR` 改为实际 Windows 路径，不沿用 `/home/chen/...`。
- 配置自己的模型与 Fish 账号；`.env.example` 中 endpoint/model 是示例，不代表已验证或会自动提供账号。
- 自动电台默认使用 KuGou-compatible 服务，`KUGOU_API_BASE_URL` 通常为 `http://127.0.0.1:3400`；保持 `KUGOU_API_AUTOSTART=false` 并单独管理服务。没有服务或配置时不要把空队列误诊成播放器故障。
- 本地文件可扫描播放；空模型/TTS配置可验证基础播放与失败降级，不能证明真实DJ链路正常。

开发：`npm.cmd run dev`，浏览器打开 `http://localhost:5173`，API 为 `http://127.0.0.1:3080`。Vite proxy 当前固定3080；改API端口要同时改proxy。生产：先 `npm.cmd run build`，再 `npm.cmd start`，浏览器打开 `http://localhost:3080`。两种启动方式择一，不同时占用3080；不要用 preview 代替后端。

另开一个 PowerShell 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:3080/api/v1/protocol
```

应返回 `protocolVersion: 1`、`playbackProtocol: "v1"`。不要调用 `started` 来假造试听；它只能由真实播放执行器提交。

KuGou 安装脚本 `scripts/setup-kugou-api.ps1` 固定版本 `06560e3e053bda1ab830750db6f645bab703f824`，会安装外部依赖；接手时先读脚本并自行决定是否使用。这里没有启动真实服务、登录或复制会话。

## 在主机复验

既有自动验收结果：488项测试（259包/边界、144服务端、85UI）全部通过、零跳过；最终主页面6场景53项通过；生产构建、五模块导入、实际生产启动五项通过。舞台独立48单测/67浏览器检查通过。版本和各轮范围见统一方案，不将不同轮次相加成一次全量运行。

下面是 Windows 接手后的待执行命令，不是原生 Windows 已通过的声明。测试入口使用临时数据目录；服务启动与真实试听则使用所配置的数据目录。

```powershell
Set-Location D:\Projects
# 若已有固定源码checkout，可跳过clone并在--upstream传入该路径。
git clone https://github.com/MakcRe/KuGouMusicApi.git kugou-api-reviewed
git -C .\kugou-api-reviewed checkout --detach 06560e3e053bda1ab830750db6f645bab703f824

Set-Location D:\Projects\claudio-nexus-radio
node scripts/test.mjs --require-upstream --upstream ..\kugou-api-reviewed
npm.cmd run typecheck:packages
npm.cmd run build
```

`--require-upstream` 用来防止上游兼容测试跳过后仍被当成通过。生产导入检查 `npm.cmd run verify:artifact` 会创建目录符号链接，原生 Windows 需相应权限；备份测试也有 POSIX 权限假设。遇到这些平台错误应保留日志，作为 Windows 适配问题处理，或在 WSL/Linux 复验，不删除断言制造通过。WSL应使用自己的Linux Node、依赖和checkout，不与Windows共享node_modules。

主页面浏览器检查可指定主机已安装的 Chrome：

```powershell
$env:CLAUDIO_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/app-e2e/run.mjs --scenario program,dj-plain,refresh-during-talk,voice-failure,late-cue,ownership --out D:\ClaudioChecks\first-host-run
```

先确认 Chrome 路径和输出目录；每次使用新输出目录。完整14场景和环境配置见 [浏览器验收说明](scripts/app-e2e/README.md)。这套自动化尚未在原生Windows运行；合成tone不是Fish真人声，媒体会话handler调用也不是物理媒体键。

## 真实数据单独迁移

代码迁移包不包含私人状态。若要保留旧主机数据，先停止旧Claudio、KuGou服务及所有播放标签页，确认没有进程写入，再复制完整冷备；保留原件直到新机验证完成。

| 状态 | 迁移要点 |
| --- | --- |
| `.env` | 用私密渠道单独转移并修正路径；不进入Git或本迁移包 |
| 实际 `DATA_DIR` | 复制整个目录，含SQLite及遗留WAL/SHM、会话、缓存、tts与tts-v2；禁止仅复制一个正在写入的sqlite文件 |
| 实际 `USER_PROFILE_DIR` | 可在DATA_DIR之外，须单独复制；保留口味、记忆、样稿等文件 |
| 旧playlist inbox | 路径为旧工作目录的`.data/playlist-inbox`，不随DATA_DIR配置自动移动 |
| 音乐库 | 文件本身不在仓库；旧DB存储文件路径，路径还参与本地track ID计算 |
| 外部KuGou服务 | 独立checkout、配置和账号状态，主仓clone不会恢复 |
| 浏览器状态 | 队列、设置及一次导入凭证在localStorage，不在SQLite；主机/浏览器/端口变化不会自动迁移 |

跨系统改音乐目录后，改 `MUSIC_LIBRARY_DIR` 并重扫可能产生新ID，不能承诺旧历史、喜欢和路径自动重定位。自动扫描仅在整个曲库为空时发生；如需保留身份，应先在数据副本上制定和验证路径映射迁移，不删除旧库。

现有 `server/scripts/backup-state.ts` 支持 dry-run 与一致SQLite快照，但执行备份时要求POSIX私有目录权限；不要在原生NTFS上强行放宽它。它也不会自动备份.env、外部服务或浏览器状态，profile/inbox需要显式参数。此次未执行真实备份。Windows首次转移可用停服后的完整冷备，并通过NTFS访问控制保护会话和凭据。

若不需要延续队列，允许新机从空队列开始。若需要，保留 `claudio.playback.queue.v1`、`claudio.settings.v1` 及旧队列/导入凭证/备份等键的原始值，在应用未运行时于副本验证恢复；不要批量拷贝整个浏览器profile。Web Locks只管理同origin页面，不管理两台机器；切换时旧端保持停止。

## 接手后的实施规则与下一步

1. 先确认两仓提交、清洁状态、包校验、舞台pin和主机基础启动；新工作从main创建 `codex/` 分支。
2. 先读统一方案第9节当前台账和本文件的平台边界；不重新执行已撤销的“最小改动基线”，也不从历史模型意见另起方案。
3. 延续用户分工：真实Opus实施，真实Fable与Codex决策。Fable先看中性目标与冻结代码形成独立意见，再交换复现和反例；不得冒充模型或预置期望结论。主机Claude Code需使用自己的有效登录；本包不携带登录状态。每个可验证切片单独commit。
4. 首轮真实试听记录：设备/浏览器/输出、音源、TTS配置、A→DJ→B、暂停/连跳/seek、失败与迟到降级、两标签、刷新、锁屏与睡眠。真实KuGou/Fish、物理音箱及长期后台均尚未验收。
5. 当前UI默认顺序口播；core支持crossfade但无模式入口。前奏智能叠入和按窗口自动缩稿尚未启用，600 code units不等于固定说话时长。需要可信录音窗口和同稿试听后再决定接线。
6. R5按七天窗口、至少三个真实使用日记录字幕、衔接、故障与维护感受；不能用自动化或tone替代听感。仅在统一方案定义的红灯事项上停下询问。

## 回退方式

切片历史完整保留，可按单个问题用 `git revert <commit>` 撤回。需要整体回到重构前时，在新目录 checkout `03ae25814a747d5228866542668c7bf096fa535c`，使用该版本兼容的独立配置和预迁移备份；不能把旧前端接到新协议，也不能用旧服务直接写新运行库。

不要在正在播放的进程下切换checkout。停止服务和标签页后再切换，保留新旧数据副本；新started历史的保留与旧版展示范围按统一方案执行。main与Folia独立仓各自的bundle保留了此次迁移的回退依据。
