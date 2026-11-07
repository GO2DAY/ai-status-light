# AI 状态灯 · 版本存档记录

> 规则：每次打包 exe 后，把当版 exe 复制到本目录对应版本文件夹，并在本文件追加一条记录。
> 目录结构：`versions/v<版本号>/` 内存放当版 exe + 版本说明；桌面只保留最新版。

---

## v1.0.0（2026-08-29）—— 首个正式交付版

**交付物**（当前在桌面）：
- `AI状态灯-绿色版.exe`（75MB，解压即用）
- `AI状态灯-安装包.exe`（75MB，NSIS 安装包）
- `AI状态灯-使用说明.html`（客户版说明书）

**包含修复**：
- P0：SQLITE_BUSY 误判致灯忽明忽暗（agent-watcher.js 区分 ROW/DONE/错误返回码）
- P0：数据库打开失败句柄泄漏
- P1：config.json 损坏静默清空 → 备份 .bak + 禁覆盖写
- P1：quitApp 丢失最后一笔配置 → 退出前同步落盘
- P1：CORS 通配头攻击面 → 已移除
- P1：灯源无上限 → MAX_AGENTS=32
- P1：开机自启+双击建双窗口 → createWindow 幂等
- P1：supervisor 冷却期跨代持久化 + 僵尸路径走 OS 确认
- 功能：supervisor respawn（指数退避最多 8 次）、rescueOffscreenWindow（副屏漂移自动拉回）、displayCache（治 Application Hang 冻结）、error.log 轮转、出厂预置豆包/马维斯、portable 版自启修复、/debug/* 打包后 404

**验证**：端到端 ping 通、四通道全亮（workbuddy:running 显线程）、右键菜单退出链路通、HTTP API 10/10 实测通过（见 `docs/状态上报接入文档-Marvis-豆包.md` 第四节）

**已知限制**：
- 沙箱环境无法做持久进程验证，长时稳定性靠 supervisor v2 自愈兜底
- 豆包/马维斯未接入 HTTP 上报前仍走 CPU 通道（6 秒级延迟）→ 接入文档已交付，待老吴发给 Marvis/豆包启用

---

## v1.1.0（2026-08-30，已打包归档）—— 画面活动检测通道

**交付物**：
- `versions/v1.1.0/AI状态灯-1.1.0-x64.exe`（76MB 安装包）+ `AI状态灯-1.1.0-绿色版.exe`（75MB）
- 桌面已同步：`AI状态灯-1.1.0-安装包.exe` / `AI状态灯-1.1.0-绿色版.exe`
- v1.0.0 安装包/绿色版已归档至 `versions/v1.0.0/`
- 打包验证：koffi.node 原生模块入包（1,044,480B）、通道 E 代码入包（grep 核实）、signtool 签名通过

**变更**：
- 新增通道 E（`main/agent-watcher.js`）：desktopCapturer 每 2s 截目标窗口 480x270 缩略图做帧差比对，画面变化 >= 0.6% → running「画面活跃·生成中」；与 CPU 通道"或"关系融合，sticky 保护不变
- watchers 配置新增 `window` 关键词字段：doubao→[豆包, Doubao]、mavis→[Marvis, 马维斯]；老 config.json 加载时自动补齐，无需用户重置
- 新增总开关 `screenWatch`（config.json 里设 false 可整条关闭画面通道）
- 新增诊断工具 `scripts/screen-harness.js`（独立验证捕获+帧差管线，不占 17890 端口）
- 动机：豆包/马维斯是对话型 AI 无法执行 HTTP 上报，CPU 通道只能猜"在不在"；画面通道让灯不依赖对方配合即可分辨"真在生成/已答完"，2 秒级响应

**验证**：
- screen-harness 本机实测：静止豆包/马维斯窗口 13 轮 ratio 恒 0.0000（零误报）；闪烁窗口 ratio=0.0295 ACTIVE；阈值 0.006 为噪声上限 5 倍
- 三个文件 node --check 语法通过；集成点 grep 核实（tickScreen/融合/start-stop 接线/配置合并）
- 限制：沙箱内无法跑完整应用做端到端（port 17890 被生产实例占用 + BrowserWindow 在受限 shell 冻结），端到端以打包后真机为准

**已知限制**：
- AI 回答最后几个短 token 的画面变化可能低于阈值（观察期后再校）
- 窗口最小化时缩略图可能为空，该通道自动静默、退回 CPU 通道

---

## v1.2.0（2026-08-30）—— 云端版：云端上报桥 + 豆包/马维斯线程级画面检测

**变更**：
- 窗口标题/包描述写明"云端版"（老吴要求：标题体现云端特性）
- 新增 `main/mqtt-bridge.js`：订阅公共 MQTT broker（mqtts://broker.emqx.io:8883）的 `asl/qrzcfsywp3gmlvi0/status` 主题，云电脑（Ubuntu）上的 AI 发布消息即可控制灯；消息喂给同一个 applyReport 状态机（sticky/灯色规则与本地完全一致）
- 新增依赖 mqtt@5（纯 JS，+2MB 级）；断线指数退避重连 5s→5min、失败写 error.log 不刷屏
- 总开关 `cloudRelay`（config.json 设 false 关闭，30s 热生效）
- **线程级画面检测（agent-watcher.js 通道 E 升级）**：`sources.filter()` 匹配同一 AI 的全部窗口，每窗口 = 一个并行对话；每窗口独立帧差基线（screenPrevMap，窗口关闭即删防泄漏）；dialogName() 从窗口标题剥应用名后缀提取对话主题（连字符残留已修，单测 6/6）；灯文案升级：`N对话·生成中「主题」` / `桌面端在线·N对话` —— 豆包/马维斯也能像 WorkBuddy 一样看出"几个对话在跑、在聊什么"
- 动机：云电脑上的 AI 够不着本机 127.0.0.1；公共 broker 当中转站，双方都是出站连接，家用无公网 IP 也能用；电话触发走现有 aicall alert 主题零改动
- 新增 `docs/云端AI接入-状态上报与电话.md`（mosquitto_pub 一行命令 + Python paho 函数 + 电话触发）
- 老吴已拍板：自托管方向 = 绿联云 NAS（路线 B：Docker Mosquitto + Cloudflare Tunnel 公网入口，待 A 跑顺后升级）
- **配套（非 exe 内）**：AI 来电提醒 3001 中继服务公众号标题改为 `🤖 谁：什么事` 格式（标题直接写明是谁、什么事摘要，详情留正文），改动在 `D:\AI来电提醒\server\index.js` makeWxTitle()，需重启服务生效（桌面"重启AI来电提醒服务.bat"右键管理员运行）

**验证**：
- MQTT 回路本机实测：连接→订阅→发布→回环接收全通，中文 JSON 无乱码
- dialogName() 单元测试 6/6（含"标题——马维斯"双破折号、"巡检评分公式讨论 — Doubao"等）
- 语法检查通过（agent-watcher.js / mqtt-bridge.js / main.js）；启动/退出接线 grep 核实
- 3001 中继服务 index.js 语法检查通过
- 端到端（云消息→灯变色、豆包多窗口计数）随打包后真机验收

**已知限制**：
- 公共 broker 稳定性一般 + 主题名即凭据 → 长期上路线 B 自托管
- QoS0 无留存：灯离线期间的状态消息丢弃，靠云 AI 下一次心跳刷正
- 3001 服务以管理员身份运行，沙箱无法重启 → 已生成桌面 bat 供老吴一键重启

---

## v1.3.0（2026-09-05，已交付）—— 图形化设置面板 + MQTT 状态快照广播

**变更**（工程师寇豆码）：
- **图形化设置面板**（老吴诉求："后台设置留给我自己设，不然新增个什么都不行"）：右键菜单「⚙️ 设置」打开独立设置窗口（640×720，原生 HTML 无构建依赖）
  - AI 灯源管理：新增/改名/删除，id 留空自动生成（中文名兜底 agent-N），非法/重复红字提示（规则同主进程 1-24 字符 a-z0-9_-）
  - 桌面监视配置：每 agent 一条 watcher（进程名 + 逗号分隔窗口关键词），未配置显示"仅接收上报"
  - 开关区：screenWatch / cloudRelay / soundOn / 开机自启
  - 保存即落盘，提示"30 秒内自动生效"（agent-watcher 每 tick 重读配置，热生效）
- 新文件：`main/settings.html` / `main/settings-preload.js`（白名单 IPC）/ `main/settings-ops.js`（纯逻辑可单测）/ `tests/settings-ops.test.js`（15 单测全过）
- **顺手修的存量 bug**：writeConfigNow 原来只写 4 个结构化键，每次拖动窗口落盘都会把顶层 cloudRelay/screenWatch 等悄悄冲掉 → 改为提取-合并未知键永不丢；enableAutoStart 改为尊重 config 顶层 openAtLogin
- **MQTT 状态快照广播（手机端地基）**：全部 agent 状态变化 → 发布 `asl/qrzcfsywp3gmlvi0/state`（QoS0+retain，JSON 去重、500ms trailing 节流、cloudRelay 关闭停发、断线记住 lastSnapshotJson 重连补发）；main.js broadcastState() 唯一收口（applyReport/ack/增删/设置保存/心跳降级 5s tick 全覆盖），快照结构 = GET /api/state 原样（id/name/status/auto/task/lastHeartbeat），HTTP 侧零改动。供安卓悬浮窗 APP 订阅

**验证**：
- node --check 全过；15/15 单测过；包内 grep 核实 settings 三件套/koffi.node/mqtt 入包
- 首版打包打进过期 main.js 已重打核实；release/ 过期 1.3.0 坏包已清（win-unpacked.tmp 被 Defender 锁，重启后删）
- 桌面 bat + 开机自启注册表均已改指 1.3.0

**已知限制**：
- 沙箱起不了 GUI，设置面板端到端未验 → 老吴装机后右键 → ⚙️ 设置点一遍验收
- **状态广播实测通过**（真实 broker.emqx.io 回路）：实时消息中文无乱码、500ms 节流合并生效、**retain 实测——新订阅者立即收到最后快照**（手机 APP 冷启动关键路径）；测试残留 retained 消息已发空包清除
- 重打输出目录 release-v130b/（release/ 被占、release-v130/ 是首版无广播）；包内 grep：publishState×3 + state 主题 + retain:true ✓；设置面板三件套/koffi.node/mqtt 均在
- 桌面两个 exe + versions/v1.3.0/ 已用新包覆盖

---

## v1.3.1（2026-09-05，已交付）—— cloudRelay 开关收发对称修复

**变更**（QA 严过关独立验证打回，工程师修复）：
- **Bug**：cloudRelay 设为 false 时发布侧停了但**接收侧仍在工作**——桥在开关打开时已建立连接，云端消息照进 applyReport 改灯，与"整条云端中继 kill-switch"语义不符（QA 抓到）
- **修复**：mqtt-bridge.js message handler 开头加 `if (isEnabled && !isEnabled()) return;`（+4 行），收发对称
- 新增 tests/mqtt-bridge.test.js 8 用例（mock require 缓存绕过 mqtt v5 getter-only 限制）：关开关拦消息/热切换/垃圾 JSON 静默/retain 去重/关时停发/500ms 节流/断线补发

**验证**：
- 29/29 全绿（mqtt-bridge 8 + settings-ops 21）；包内 grep isEnabled 三处（发布/重连/接收）✓；release-v131/ 输出
- 桌面 bat + 开机自启注册表已改指 1.3.1

**已知限制**：
- 桌面与 versions/v1.3.0 旧包留存未清（safe-delete 拦截），分发认准 1.3.1

---

## v1.4.0（2026-09-12，已交付）—— 声音加强 + 自动发现 AI + 对话列表

**变更**（工程师寇豆码，41/41 测试全绿）：
- **提示音加强**：VOLUME_GAIN 三档（low 0.25/medium 0.55/high 0.9，原峰值 0.3 → 默认 high，指数包络防爆音）；assist 紫灯/stuck 红灯进入发声 + **30s 重复提醒**（assist 优先，soundOn/repeatAlert 双开关，ack/解除即停）；发现新 AI 播双音 chime；设置面板加音量档位 + 重复提醒开关
- **自动发现 AI**（老吴：新 AI 软件自己检测出来自动加进清单）：新文件 main/ai-signatures.js 特征库 15 条出厂（豆包/马维斯/澳龙/OpenClaw/阿布/Cherry Studio/DeepSeek/Codex++/Cumora/Kimi/通义千问/腾讯元宝/文心一言/Kimi CLI/Claude）；每 30s 扫进程表+窗口标题（0x0 缩略图零渲染开销），命中未配置 → 自动加灯（task「新发现·待确认」）；手动删除记 autoDiscoverBlacklist 不再加回；总开关 autoDiscover；设置面板注明"飞书等纯云端 AI 走 MQTT 云上报"
- **对话列表**（老吴：哪几个对话在跑一眼看清）：agent-watcher 按窗口维护 screenWindows（title+activeT，关窗即清），getDialogs()/formatScreenDialogs 活跃在前；serializeAgents 挂 dialogs 字段（/api/state + MQTT 快照，向后兼容）；详情面板列对话清单（活跃带绿点+「生成中」）
- **部署方式变更（重要）**：绿色版改名 `AI状态灯.exe` 覆盖固定路径 `C:\Users\吴建明\AI状态灯\AI状态灯.exe`（自启/bat 永不漂移），不再放桌面；归档 versions/v1.4.0/

**验证**：
- auto-discover 12 + settings-ops 21 + mqtt-bridge 8 = 41/41 全绿；vite build ✓；release-v140/ 包内 grep 全套核实 ✓
- QA 独立验证（严过关）：进行中，重点审 30s 提醒循环泄漏/特征库误报面/blacklist 持久化

**已知限制**：
- 沙箱起不了 GUI，端到端待真机：老吴重启灯后生效（固定路径已覆盖）
- 误报风险（Codex/Claude 窗口关键词误伤编辑器/浏览器）待 QA 结论

---

## v1.4.1（2026-09-12，已交付）—— P1 误删修复 + 自动发现误报收紧

**变更**（QA 严过关独立验证打回，工程师修复）：
- **P1 修复**：设置面板打开期间自动发现的新 agent，点保存会被误删+永久 blacklist（v1.4.0 回归）。修复：自动发现 agent 打标 origin:'auto'+discoveredAt（双向持久化）；settingsPanel:get 带 snapshotAt；save 删除循环按 shouldSkipDeletion 豁免（快照后自动发现的不删不拉黑，缺省 snapshotAt 走老行为）；新增 settingsPanel:unblacklist IPC + 设置面板**黑名单管理区**（中文名反查 + 解除按钮，解除即落盘）
- **误报收紧**（QA 结论：Codex/Claude 短词窗口命中误报风险高）：ai-signatures.js 新增 EXCLUDE_SUFFIXES（vs code/google chrome/edge/firefox/opera/brave 等后缀不命中）+ isWindowKeywordTrusted（含中文可信、拉丁>6 字符可信、≤6 短拉丁词仅进程通道），窗口循环双闸门
- 新增 tests/v141-fixes.test.js 15 用例（豁免三态/blacklist 幂等不可变/浏览器编辑器标题不命中/可信性矩阵/端到端零误报）

**验证**：
- 56/56 全绿（v141-fixes 15 + auto-discover 12 + settings-ops 21 + mqtt-bridge 8）；release-v141/ 包内 grep 全套核实
- 固定路径 exe 已覆盖（覆盖前核实无运行实例）；QA 第二轮回归验证进行中（含对抗用例：豁免后真删除路径/discoveredAt==snapshotAt 边界/大小写变体）

**已知限制**：
- 老吴当前若跑着 v1.4.0，重启灯（双击 bat）才上 v1.4.1

---

## v1.4.2（2026-09-12，已交付）—— Bug 2：豁免 agent 与 watcher 成对存活

**变更**（QA 第二轮对抗测试打回，工程师补修）：
- **Bug 2**：v1.4.1 的豁免只保 agent 不保 watcher——settingsPanel:save 的 `watchersConfig = value.watchers` 整体覆盖把豁免 agent 的 watcher 冲掉 → 死灯（永久 idle「新发现·待确认」，扫描不补，重启依旧）
- **修复**：settings-ops.js 新增 mergeSparedWatchers(payloadWatchers, currentWatchers, sparedIds)（面板提交在前不重复、内存中豁免 agent 的 watcher 成对并入）；save 删除循环收集 sparedIds，裸覆盖改 merge；「payload 缺豁免 agent watcher」同路径兜底
- 新增 tests/v142-fixes.test.js 7 用例（merge 单元 4 + 保存链路模拟 3：成对存活/成对消失/兜底）；QA 对抗套件 2 条 FAIL 转绿（14/14）

**验证**：
- 77/77 全绿（v142 7 + qa-v141 14 + v141 15 + auto-discover 12 + settings-ops 21 + mqtt-bridge 8）；release-v142/ 包内 grep 核实
- 固定路径 exe 已覆盖（无运行实例）
- **QA 第三轮收官判定 NoOne**：全量 90/90 零回归 + 独立落盘级成对契约 3/3（qa-v142-pairwise.test.js）+ 工程师对 QA 对抗测试的 diff 审查**未稀释**（转绿靠修源码非改测试）
- QA 三轮累计拦截 2 个真实 bug（R1 拉黑竞态、R2 watcher 丢失死灯），测试资产 30 条入库 tests/

**已知限制**：
- 重启灯（双击 bat）才上 v1.4.2
- 沙箱起不了 GUI，端到端以真机为准

---

## v1.4.3（2026-09-12，已交付）—— 拖入快捷方式快速添加 AI 源

**变更**（老吴：拖入应用快捷分身，自动检索提取名称+exe，快速添加）：
- 新文件 `main/lnk-parser.js`（~200 行纯 JS 零依赖）：手写 [MS-SHLLINK] 解析（LocalBasePath+CommonPathSuffix 两段拼接、Unicode/ANSI 双通道、零偏移防护永不抛异常）；resolveDroppedFile 三态（完整识别/ partial 黄字手动补/扩展名硬拒绝）
- settings.html 添加区变拖放区（虚线框+高亮+busy 态），drop 后复用 doSave 完整校验链（settings-ops/slugify/snapshotAt 豁免/mergeSparedWatchers 全契约生效），完整识别即"拖入即添加"；重复检测按进程名+名称忽略大小写
- settings-preload.js 用 webUtils.getPathForFile（Electron 31 的 File.path 替代）+ resolveShortcut IPC

**验证**：
- 91/91 全绿（lnk-parser 14 含 4 个真实桌面样本：豆包/Marvis/Abu/Cherry Studio）；**75 个真实桌面快捷方式全量扫荡**：56 完整解析、19 partial 全部人工核实为合法非 exe 目标，零误判
- release-v143/ 包内 grep 全套；固定路径已覆盖（无运行实例）；QA 回归验证进行中（拖放三态/重复拖入/origin 语义/系统目录黑名单评估）

**已知限制**：
- 拖放交互端到端待真机验收（沙箱起不了 GUI）

---

## v1.5.0（2026-10-18，已交付）—— 全球发布版：双语 + 两行灯名 + 不裁灯 + 全球特征库 + 脱敏

**变更**（工程师寇豆码，132/132 全绿，12 套测试）：
- **中英双语**：main/i18n.js（zh/en 两包 ~90 key UMD 单一事实来源）；设置面板语言下拉（auto/zh/en）即时重渲染；保存后右键菜单重建 + 灯条即时切换；校验报错双语化（errorKey 映射）
- **灯名两行全称**（老吴：WorkBuddy 只显 WO）：w-[52px]+line-clamp-2+leading-[11px]，strip-name.js 全称+12 字符保险丝；ROW_HEIGHT 56px 不变不裁灯
- **不裁灯**（老吴：打开齿轮后 GPT 看不到）：main/layout.js panelWindowWidth=max(请求宽, 灯条全宽)，面板下拉展开不再收缩灯条
- **×醒目化**：34×34 命中区+悬停红底（DetailPanel/内嵌面板/设置窗口页面内 ×）
- **全球特征库 +22**：国际 16（ChatGPT/Claude Desktop/Gemini/Copilot/Grok/Cursor/Perplexity/Poe/Le Chat/Meta AI/Notion AI/Windsurf/Trae/Zed/Aider/Cline）+ 国内 6（讯飞星火/智谱清言/天工/海螺AI/可灵/即梦/Suno）；短拉丁词仅进程通道有回归锁
- **脱敏批**：出厂空清单+cloudRelay:false+mqttTopic crypto 随机 12 位 hex（getTopicBase 现取+regenerateTopic IPC+面板可重新生成）；lnk-parser/mqtt-bridge 注释 scrub；author=ai-status-light contributors；privacy-scan 源码+产物 0 命中
- **迁移逻辑**：老 config 缺 cloudRelay → 补 true（保老吴云链路）；缺 mqttTopic → 生成落盘；显式 false 不动

**⚠️ 升级后动作（老吴必做）**：
- 首次启动 v1.5.0 会生成新随机 MQTT 主题（旧主题 qrzcfsywp3gmlvi0 已退役）→ 云端 AI 接入脚本/共享文件夹 02 文档/安卓 APP 的订阅主题都要换成新主题（设置面板「云端中转」下可复制）

**验证**：
- 132/132 全绿（i18n 6 + v150-features 12 + privacy-scan 3 + 回归 111）；Vite 构建 line-clamp 入 CSS；release-v150/ 包内核实全过；固定路径已覆盖（79,651,093 B）
- **QA 严过关 R4 判定 NoOne 收官**：全量 144/144 零回归 + 独立对抗 14/14（qa-v150-adversarial.test.js 入库：i18n 新控件 key 清点/迁移三连/9 种非法主题回退/regenerateTopic 节流快照不泄漏旧主题/不裁灯契约/emoji 码点截断/origin 语义顺带关闭 v1.4.3 遗留）；隐私独立复核 0 命中；包内逐字节 SAME
- QA 四轮累计拦截 2 个真实 bug，测试资产 33 条入库

**Backlog（记入不阻塞）**：
- regenerateTopic 后新主题的 retain 快照要等下一次灯态变化才发——重新生成后主动 broadcastState() 补发一次（下版顺带）

**已知限制**：
- GitHub 仓库本体发布前需清洗 docs/tests/历史 release 里的旧主题串（不进安装包但进仓库）
- 安卓 APP 主题需随新主题对齐（APP 开发中，一并改）

---

## v1.5.1（2026-10-20，已交付）—— AI 接入提示词一键复制 + assist/stuck webhook 电话告警

**变更**（工程师寇豆码，163/163 全绿，15 套测试）：
- **接入提示词一键复制**：main/integration-prompt.js（UMD 三栖纯函数，仿 i18n.js 模式）buildHttpPrompt(lang)/buildMqttPrompt(topicBase, lang) 双语言；协议事实与 main.js 源码逐条对齐（POST 127.0.0.1:17890/status、五枚举、assist/stuck 粘住需 force:true 解除、连接拒绝=忽略不重试；MQTT broker.emqx.io:8883/wss:8084、主题 <base>/status、QoS0、主题码=凭据勿外传）；非法主题码留 <你的主题码> 占位不硬拼；settings.html 新「AI 接入提示词」区两张卡片（本机 HTTP / 云端 MQTT）各带只读 textarea + 一键复制（clipboard API + execCommand 兜底，成功显示「已复制 ✓」2 秒），随语言切换即时重渲染、MQTT 卡随主题重新生成即时刷新
- **webhook 电话告警**：main/alert-webhook.js（electron-free，fetch/now/log 可注入）；payload 与 D:\AI来电提醒\server\index.js 的 POST /alert 端点逐字段对齐（key/notifyType/title/message/project/source），老吴 3001 服务零改动可用；边沿触发（prev∉{assist,stuck} ∧ next∈ 才发，持续 assist 不刷屏，ack 后再 assist 算新边沿）；同 agent+status 60 秒冷却（失败也进冷却，绝不对电话通道刷屏）；5 秒 AbortController 超时，永不抛异常、失败只 logError；title/message 第一位必为【agent显示名】（老吴铁律）
- **配置与面板**：config.alertWebhook={enabled:false,url:'',key:'',onAssist:true,onStuck:true} 出厂关闭；settings-ops 白名单校验（url 空或 http(s):// 前缀 ≤500 字符，key ≤200）；settings.html 新「电话告警 / Phone Alert」区（开关+URL+Key 密码框+assist/stuck 复选）；i18n 双包新增提示词区/告警区/校验报错 key
- **Backlog 清偿**：v1.5.0 遗留「regenerateTopic 后新主题 retain 快照要等下次灯态变化」——重新生成后主动 broadcastState() 补发，本版已修

**验证**：
- 全量 163/163 零失败（新增 integration-prompt 5 + alert-webhook 12；既有 146 条含 QA 四轮资产全部不破）
- 新增测试契约：双语言提示词协议关键串/主题插值无占位残留/非法主题占位/隐私零违禁串；边沿触发/冷却边界（60s 整放行）/类别开关/disabled 空操作/payload 逐字段对齐+【显示名】铁律/失败只记日志+AbortSignal 传入/常量契约
- 修 2 个自拦 bug：fireAlert 的 Promise.resolve().then 延迟导致同步观测不到发送（改同步调用+try/catch 收编）；提示词测试误把 JSON 示例的 {} 当占位残留（测试修正）

**已知限制**：
- 电话告警依赖老吴本机 3001「AI来电提醒」服务自启；服务没开时只记日志不打扰（符合「忽略不重试」原则）
- 固定部署路径仍跑 v1.5.0，待老吴试完后再覆盖 v1.5.1

---

## v1.5.2（2026-10-20，已交付）—— P0 紧急修复：渲染层空黑条（UMD 双通道）+ 双闸口 + dist 卫生

**事故**：老吴双击 v1.5.1，灯条窗口出现但一盏灯都不渲染（空黑条），error.log：`[renderer console] Uncaught TypeError: Cannot read properties of undefined (reading 't')`。v1.5.0 起渲染层即崩，但沙箱起不了 GUI、无人真跑过 exe，178 条单测全绿也抓不到。team-lead 已回滚固定路径到 v1.4.3。

**根因**（team-lead 定位）：main/i18n.js 等 UMD 用 `if (module) module.exports = api; else window.X = api;`——Vite 构建经 rollup commonjs 垫片后 module/exports 与 window **并存**，走 module 分支，window.ASL_I18N 永远 undefined；Node 单测 module 天然存在走同一分支，故全绿而浏览器崩。

**变更**（工程师寇豆码，170/170 全绿，17 套测试）：
- **UMD 双通道赋值**（治本）：main/i18n.js、main/strip-name.js、main/layout.js、main/integration-prompt.js 全部改为 `const api = factory(); if (module) module.exports = api; if (window) window.ASL_* = api; else root.ASL_* = api;`——不依赖 else 分支。layout.js 从纯 CJS 包为 UMD（window.ASL_LAYOUT）。排查确认 src/ 仅 statusMeta.js 副作用 import i18n + strip-name；settings.html/tooltip.html 经 script 标签裸加载（无垫片）本不受害，一并统一双通道模式
- **闸口一 tests/umd-dual-env.test.js**（5 条）：Node vm 构造 module/exports/window 同时存在的沙箱（精确模拟 rollup-cjs-wrapper），逐模块断言 window.ASL_* 赋值 + 函数可调 + module.exports 通道不丢。旧代码跑红 4/5（证据留档），新代码 5/5 绿
- **闸口二 tests/bundle-gate.test.js**（4 条）：grep 打包产物 win-unpacked 渲染 bundle 断言含 window.ASL_I18N/ASL_STRIP_NAME 赋值模式 + 语言包内容；assets 下唯一 index-*.js（旧哈希残留 = FAIL）；index.html 引用真实存在。未打包 = FAIL 不许过闸
- **dist 卫生**：构建前 `rm -rf dist`（vite.build.now.config.mjs 的 emptyOutDir:false 保留，沙箱批量删除保护所限），旧残留 bundle index-B7ifoDR5.js/index-Cb1KnCNO.js 已清，产物仅 index-JbXqPEBI.js

**验证**：
- 闸口一旧代码红字证据：4 FAIL（window.ASL_I18N/ASL_STRIP_NAME/ASL_LAYOUT/ASL_PROMPT 未赋值）→ 修复后 5/5 绿
- 闸口二打包后运行输出：4/4 绿（产物唯一 bundle、引用存在、双赋值模式命中、zh-CN 语言包在 bundle 内）
- 全量回归 170/170 零失败（含 QA 四轮资产 + v1.5.1 新增 17 条全部不破）
- 版本号三处一致：package.json / APP_VERSION / 产物内核实

**流程教训（沉淀）**：
- 打包产物必须真机/真人运行一次才算交付——单测绿 ≠ 渲染层活
- UMD 模块一律双通道赋值，禁止 else 分支；新增渲染端消费的 main/ 模块必须先过闸口一

**已知限制**：
- 沙箱无 GUI，本版仍未经真人双击验证——部署后老吴首验
- 固定部署路径（现 v1.4.3）未动，部署由 team-lead 统一做

---

## v1.6.0（2026-10-20，已交付）—— 预选库快捷添加 + 齿轮下拉 + 作者配置中心 + broker 可配置 + 自动更新 + 引流位

**变更**（工程师寇豆码，215/215 全绿，21 套测试 + 打包闸口）：
- **功能一 全球 AI 预选库**：main/ai-presets.js（UMD 双通道，window.ASL_PRESETS）四组 32 条（国内 9/国际 6/开发工具 8/地区+垂直 9），id 全过 AGENT_ID_PATTERN、url 全 https；有客户端的带 exe+窗口关键词走 watcher 自动检测，cloudOnly 不编造检测特征、面板标「云端上报」徽标点击展开 MQTT 接入提示词（复用 integration-prompt.js）；设置面板「快捷添加」区分组可折叠，[官网↗][添加]，已添加变灰；添加走 settingsPanel:save 既有链路立即生效。偏差记录：马维斯预设 id 用 'mavis' 与特征库/存量配置对齐（派单写 marvis，进程名 marvis.exe 不变）
- **功能二 齿轮单击下拉菜单**：main/gear-menu.js（UMD 双通道）定义 4 项（AI 源管理→设置窗口#agents 锚点定位 / 设置 / 重新检测→agentWatcher.refreshNow / 退出），gear:action IPC 白名单校验；灯条内浮层不调 setWidth，不裁灯契约由 panelWindowWidth 回归锁；点菜单外关闭；src/ 消费点统一锚定 statusMeta.js 转口（QA 闸口要求）
- **功能三 作者配置中心**：main/remote-config.js（纯 Node 主进程用），启动 10s 首拉 + 6h 轮询，jsDelivr→GitHub raw 顺序回退，8s 超时只 GET；成功缓存 userData/author-config-cache.json，失败用缓存，无缓存用内置默认，离线静默；presetsUpdatedAt 严格更新才覆盖内置预选库；仓库根 author-config.json 初始版（占位邮箱 author@example.com + ko-fi.com/go2day + promo 关）
- **功能四 broker 可配置**：config.mqttBroker/mqttBrokerWss（空=默认 emqx），mqtt-bridge BROKER_URL 改 getBrokerUrl 回调现取（normalizeBrokerUrl 四族前缀校验），面板云端接力区两个输入框，settings-ops 白名单校验（err.mqttBrokerInvalid/WssInvalid），保存时地址变化主动重启桥+补 retain 快照；integration-prompt.buildMqttPrompt 第三参 broker，提示词写当前配置地址
- **功能五 自动更新**：electron-updater@^6.8.9 + main/auto-updater.js 封装；安装版 30s 后 checkForUpdatesAndNotify；绿色版只派灯条横幅「有新版本 vX.Y.Z → 查看」点击开 Releases；dev/失败/无 Release 全静默；electron-builder.yml publish github 源。**沙箱无法实测真更新——发布到 GitHub 后需真人验证一次**
- **功能六 引流位+关于角**：告警 URL 为空显示金色「没有中继服务？联系作者协助部署 →」（开 remote-config.kofiUrl）；设置面板底部关于角：作者邮箱+Ko-fi+promo.enabled 时一行宣传；全部静态不弹窗

**验证**：
- 新增 4 套 28 条（ai-presets 8 / gear-menu 4 / remote-config 8 / auto-updater 8）+ 扩 4 套（settings-ops +2 broker 校验 / mqtt-bridge +1 broker 回调 / integration-prompt +1 自定义 broker / umd-dual-env +2 新模块加载）
- 闸口一 7/7、闸口二打包后 4/4；全量回归 215/215 零失败（含 QA 五轮资产全部不破）
- 自拦 2 个：App.jsx 直读 window.ASL_GEAR_MENU 被 QA 锚定闸口拦下 → 改 statusMeta 转口；vm 沙箱跨 realm deepStrictEqual 误判 → JSON 比较

**TODO-GITHUB-OWNER 占位三处**（发布前统一替换）：main/remote-config.js AUTHOR_CONFIG_URLS×2、main/auto-updater.js RELEASES_URL、electron-builder.yml publish.owner

**已知限制**：
- 自动更新与远程配置中心均需 GitHub 仓库上线 + 替换 owner 占位后才真人可验
- 沙箱无 GUI：齿轮菜单/预选库/引流位的真实渲染待部署后老吴首验

**修复记录（QA R7 两个 P1，同版本号重打，未发布不升号）**：
- P1-1：马维斯预设 id 'marvis' → 'mavis'（注释与代码漂移——注释写 mavis 数据写 marvis；对齐 ai-signatures 消除双灯风险）
- P1-2：8 条 URL 按 QA 实测落点修正（marvis→marvis.qq.com / qwen→www.qianwen.com / ernie→wenxin.baidu.com / windsurf→devin.ai / v0→v0.app / runway→runway.com / rinna→rinna.jp / krutrim→olakrutrim.com）
- 修 3：URL 域名白名单防线收编进 tests/ai-presets.test.js（双向精确匹配，新增条目必须连清单一起改）；QA 对抗套件的 DOMAIN_OWNER 同步迁移落点
- 重跑：ai-presets 9/9、qa-v160-adversarial 14/14（红灯转绿）、闸口一 7/7、全量 245/245；release-v160 重打覆盖 versions/v1.6.0/
- R2 收官：删 rinna 条目（服务 2023 年停运，三 DoH 解析器证实 rinna.jp/www.rinna.jp/rinna.co.jp 全 NXDOMAIN，无活链可换），两处白名单同步删（僵尸条目检测逼出来的双向同步，防线正常工作）；预设 32→31 条，条数锁同步；全量 245/245 不破，产物第三次重打覆盖

---

## v1.6.1（2026-10-22）—— 设置面板可用性批：冻结顶栏 + 呼吸灯保存提醒 + 去国度视角 + 手动检查更新

**变更**（老吴真机截图驱动，全部落在 settings.html / auto-updater / i18n / settings-preload 范围）：
- **冻结顶部操作栏 + 呼吸灯**：取消/保存从底部移到顶部 sticky 冻结栏（position:sticky top:0，不透明底，高 z-index）；栏内布局 左=版本号（读 APP_VERSION 经 settingsPanel:get.version）/ 中=「检查更新」/ 右=取消+保存；dirty 呼吸灯——双通道打标：捕获阶段事件委托监听面板全域 input/change（表格编辑/勾选/下拉等交互类改动）+ 程序化 rows.push 路径（手动加行/拖放/预选添加）显式 setDirty(true)，任一改动保存按钮进入 1.2s box-shadow 脉冲呼吸；保存成功停灯
- **去国度视角（神秘作者纪律）**：预选库分组「国内常用」→「中国常用」（China）；grep 全仓「国内/国外」清零（ai-presets 分组名、ai-signatures 注释、remote-config 注释三处命中全改中性表述）；新增断言锁死：i18n 全量语言包 + 预设库 + 接入提示词模板永不再现这两词
- **手动「检查更新」**：顶栏按钮 → 新 IPC update:checkNow → auto-updater.manualCheck 三态反馈（复用与自动检查相同的 checkFn 注入形态）：发现新版「发现新版本 vX.Y.Z →」（点击开 Releases）/ 同版「已是最新版本」/ dev·拉取失败·仓库无 Release「更新源暂未开放」——GitHub 仓库未发布前恒走第三态，不许静默；startAutoUpdate 返回柄新增 checkDetailed 手动入口
- **确认项（验证+顺手修）**：缓存穿透测试证明离线启动读到缓存新邮箱（get() 快照即设置面板关于角数据源）；settings.html 关于角原先兜底字面量 'author@example.com' 已删——邮箱只来自远程配置快照，防「以为生效实则写死」

**验证**：
- 新增/扩 3 套 8 条：auto-updater +5（manualCheck 三态全分支 + 三态文案双语 + checkDetailed 挂柄）、remote-config +2（缓存穿透 + 关于角无硬编码）、ai-presets +1（去国度视角 grep 断言含分组锚点「中国常用/China」）
- 全量回归 253/253（闸口二打包前 0/4 属预期，打包后复跑 4/4 转绿）；闸口一 umd-dual-env 7/7、QA 六轮对抗资产全不破
- settings.html 无 node 语法面：改动经全量回归中间接覆盖（remote-config 断言 HTML 消费路径）

**已知限制**：
- 呼吸灯/冻结栏为纯 DOM+CSS，沙箱无 GUI，真实观感待部署后老吴首验
- 「检查更新」在 GitHub 仓库发布前设计性返回「更新源暂未开放」——发布后需真人点一次验证三态切换

**修复记录（QA R8：1 个 P2 + 2 个顺手项，同版本号重打，未发布不升号）**：
- P2：呼吸灯 dirty 漏洞——程序化 rows.push 不走 input/change 事件，3 处补显式 setDirty(true)：addBtn 手动加行、drop-partial 预填行（未落盘改动，原先灯不亮点取消静默丢弃）、addPreset/drop 完整识别的自保存路径（先亮灯，doSave 成功盖回 false、失败保持亮）；上文「全覆盖」表述同步改准（事件委托 + 程序化打标双通道）
- 顺手项 1：取消防误丢（team-lead 拍板）——dirty 时点取消/× 不直接关：按钮原位变「确认放弃修改？」（sw.confirmDiscard 双语），3 秒超时自动复原，再点才真正关窗；dirty=false 维持直关。qa-v161-adversarial 取消语义锚点由工程师按派单同步更新（QA R9 复核）
- 顺手项 2：词残留 2 处——tests/ai-presets.test.js 注释「国内」→「中国区」、docs/github-release/repo-setup-checklist.md「国内外用户」→「全球用户」
- 重跑：qa-v161-adversarial 9/9（红灯转绿）、全量回归 262/262 零失败、闸口二重打后 4/4（overlay 遗留旧哈希 bundle 被闸口当场抓住，删残留后转绿——闸口又正常工作一次）；release-v161 重打覆盖 versions/v1.6.1/ 双 exe

---

## v1.6.2（2026-10-22）—— WorkBuddy 灯标题手动命名优先 + tooltip 语言链路排查固化

**变更**（老吴真机发现的两个体感问题）：
- **修 1：custom_title 优先（agent-watcher.js）**：workbuddy 灯 tooltip 的「N 线程: 标题」原来只读 sessions.title（WorkBuddy 自动标题从创建日定死从不更新，体感像写死）。改 COALESCE(NULLIF(custom_title,''), title, '未命名线程')——用户在 WorkBuddy 里手动重命名会话，灯上下一轮（≤5s）即显示新名。兼容性铁律：老版本 WorkBuddy 的 DB 可能没有 custom_title 列，直接引用会整查询报错 → 每轮先 PRAGMA table_info(sessions) 查列存在性再动态拼 SQL（tableHasColumn 查失败保守按无列处理）；查询主体抽出 queryWorkingTitlesFromDb 供单测直喂临时库；无列时旧 SQL 逐字节不变
- **修 2：tooltip 英文排查（走查结论：代码链路易语言无 bug，实证定位到部署配置）**：全链路走查——StatusLight.jsx 悬停只发 agent+锚点坐标，lang 由主进程 tooltip:show 每次现取 currentLanguage() 附在 tooltip:data 载荷；tooltip.html 全部可见文案经 i18n t()/relTime()（静态默认中文占位，i18n.js 加载失败也不会裸奔英文）；灯条本体初始语言经 getSettings().resolvedLanguage 也有推送。resolveLanguage('auto', zh*) → zh-CN 逻辑正确。**实证：部署目录 %APPDATA%\\AI-Status-Light\\config.json 的 settings.language 当前值是 "en-US"**（2026-10-22 02:06 写入，疑为测试期保存英文后忘改回）——该值生效期间 tooltip/灯条/面板全部英文是设计行为，不是 zh 误判。结论固化成行为级测试（见下），配置值留给老吴自己在面板改回「跟随系统」，代码不动用户配置

**验证**：
- 新增 tests/v162-fixes.test.js 9 条：SQL 形状×2（无列逐字节锁旧 SQL / 有列 NULLIF 优先）、真 winsqlite3 临时库集成×2（手动命名>空串回退>全空回退未命名+deleted/非 working 排除；老库无列不报错走 title）、链路锚点×2（tooltip:data 必带 lang/currentLanguage 解析路径；tooltip.html 无英文硬编码标签）、行为级×3（vm 沙箱+假 DOM 跑 tooltip.html 真实内联脚本：zh 全中文/en 全英文/auto+zh-CN 闭环中文）
- 全量回归 271/271（闸口二打包前 0/4 预期红，打包后复跑）；沙箱无法起 GUI Electron（文件系统视图隔离），locale 实证 probe 被沙箱拦截——以部署配置证据 + 纯逻辑测试替代

**已知限制**：
- tooltip 英文化若再出现，第一排查点 = config.json 的 settings.language（面板下拉即所见），第二 = 系统 locale；链路本身已被测试锁死
- custom_title 依赖 WorkBuddy DB schema，PRAGMA 兼容老库；WorkBuddy 改名后 ≤5s 生效（灯扫描周期）

---

## v1.6.3（2026-10-23）—— 灯下状态文字 + author-config 漂移锁修复

**变更**（老吴需求：看过开源宣传动图后要求「灯下显示状态文字」进真实软件——不悬停、扫一眼可见）：
- **灯下状态文字**：每盏灯 = 圆灯 → 完整中文名（不动）→ 新增一行小号状态词。五态短词走独立 i18n key `strip.status.*`（不占用 tooltip/详情面板的 `status.*` 长文案，52px 灯宽只放得下短词）：zh 离线/运行中/空闲/卡住/等你处理，en Offline/Running/Idle/Stuck/Waiting。状态词按灯色着色（STATUS_META 新增 text 类），stuck/assist 文字刻意不闪（圆灯已 animate-blink，双闪是噪音，不遮挡名称）
- **开关**：默认开启；config 新增 `settings.showStatusText`（缺省 true，老配置无此键行为不变）；设置窗口「开关」区新增双语开关（sw.showStatusText 双语文案 + settings.html checkbox/gather/回填 + settings-ops 校验 + main.js 读盘/面板视图回传/保存应用，全链路闭环）
- **行高 56→72px**：main.js `ROW_HEIGHT` 与渲染层（App.jsx 灯条行、StatusLight 按钮改 `h-[72px]`）两侧同步。拖动收起回基准高、启动初始高、面板开合、边缘吸附、齿轮菜单全部沿用既有 ROW_HEIGHT 自适应逻辑，未改算法
- **漂移锁修复（全量回归 25/27 的根因）**：remote-config.js `DEFAULT_AUTHOR_CONFIG.contactEmail` 占位 author@example.com → 与仓库根 author-config.json 同步为真实邮箱 zekaiwu747@gmail.com；tests/remote-config.test.js 的邮箱断言由「占位值纪律」改为「仓库文件与内置默认一致」漂移锁（锁定语义保留：改一边必红）。**未改 author-config.json，未改两处深等断言语义**

**验证**：
- 新增 tests/v163-status-text.test.js 15 条：状态词双语映射×3、statusMeta 锚点×3（短词函数/状态着色/灯闪文字不闪）、showStatusText 链路×4（缺省 true/显式关闭保留/非布尔兜底/写回不丢新键）、布局增高两侧一致×3、设置窗口开关锚点×1、版本三处一致×1
- 全量回归 28 套文件：**27 套全绿**（27 个既有 + 1 个新增；其中 remote-config 与 qa-v160-adversarial 两条漂移锁由红转绿）；strict-running **12/12** 未破（误判绿/僵尸黄灯回归完好）；bundle-gate 0/4 为**打包前预期红**（升版 1.6.3 后闸口找 release-v163，历版同约定：打包后复跑转绿）
- vite build 编译通过（38 modules），渲染 bundle 实测含 window.ASL_I18N / window.ASL_STRIP_NAME 双通道赋值 + strip.status.* 短词 + showStatusText 链路 + h-[72px]（bundle-gate 内容项预检全过；electron-builder 打包按边界铁律留待发布环节）

**已知限制**：
- 沙箱无 GUI：状态词 9px 真实可读性、72px 行高的视觉比例待老吴真机首验
- showStatusText=false 时窗口仍为 72px 高（不随开关收缩——高度恒定避免拖动/吸附抖动，仅文字隐藏）
- 设置窗口保存总是显式回传 showStatusText；若有第三方绕过面板直接调 settingsPanel:save 且不带该键，会被重置为缺省 true（面板自身路径无此问题）

---

## v1.7.0（2026-11-07）—— 三档显示模式（经典/精简/迷你）+ 自动收起

**变更**（老吴需求：72px 灯条遮挡屏幕内容，先做迷你聚合灯，迭代中升级为三档模式）：
- **三档显示模式**：config.settings 新增 `displayMode`（classic/compact/mini，缺省 classic，非法值兜底 classic）。classic=v1.6.3 现状（灯+名称+状态词，72px）完全不动；compact（精简）=灯+完整名称、去状态词行，行高收 56px（v1.6.2 视觉，主进程新增 `ROW_HEIGHT_COMPACT=56` 与渲染层 `h-[56px]` 两侧同步）；mini（迷你）=整窗收成一盏聚合小灯（窗口 40×40px、圆灯 20px，来自新纯函数模块 main/mini-mode.js 的 MINI_WINDOW/MINI_LIGHT_SIZE），几乎不遮挡内容
- **迷你聚合优先级**：assist(紫闪) > stuck(红闪) > running(绿闪) > idle(黄不闪) > 全 offline(灰兜底)。~~原口径 idle 归绿~~ → **rev3 修正（老吴实测反馈）**：idle 归绿导致「迷你灯绿、展开后满屏黄、绿灯凭空消失」的自相矛盾；改为与 classic 展开视图一一对应——迷你绿=真有 AI 在干活，迷你黄=开机空闲，展开必有同色灯。聚合纯函数 `aggregateStatus` 在 main/mini-mode.js（UMD 双通道，node 可单测）；闪烁差异由渲染层 MiniLight.jsx 的 MINI_DOT_META 区分
- **模式切换入口（rev2 双入口并存）**：① 灯条齿轮旁 ◐ 循环按钮保留（老吴拍板不撤，循环 classic→compact→mini，tooltip 显示「下一个模式」中英文案 strip.mode.*）；② 设置窗口**顶部冻结操作栏**新增「显示模式」下拉（与「检查更新」同栏固定，滚动/面板内容永不覆盖，desc 挂下拉悬浮 title）。两入口同写 displayMode；迷你灯单击=展开回「收起前的模式」（渲染层 lastExpandedRef 记忆，绝不开详情面板）
- **引流/打赏文案收敛（rev2）**：「没有中继服务？联系作者协助部署 →」改为「需要远程电话提醒？联系作者协助部署 →」（中英同步，不向外暴露中继原理）；Ko-fi「请作者喝杯咖啡」按钮仅英文界面显示（中文界面整行隐藏——国内用户无打赏习惯，避免留白）
- **拖动/点击区分**：迷你灯沿用统一指针处理器的 DRAG_THRESHOLD_PX 判定——按住拖动=移窗口（pointer capture），单击=展开；mini 模式下主进程 dragStart 的基准高按模式换算（baseWindowSizeForMode），debug-dragStart 同步
- **自动收起**：config.settings 新增 `autoCollapse`（布尔，缺省关）。开启时：所有 agent 无 stuck/assist 持续满 `AUTO_COLLAPSE_DELAY_MS=60000`（main.js 顶部可调常量）自动切 mini 并记住收起前模式；任一 stuck/assist 出现**立即**恢复。判定挂在 broadcastState 唯一收口（5s tick 兜底静默场景）；用户手动切模式=接管（清除自动恢复标记）；autoCollapse 关闭时零行为变化
- **窗口尺寸/位置适配**：新增 applyDisplayModeSize——切模式保持右上角锚点（右缘/上缘不动）再按 snapToWorkAreaEdges 吸附兜底；createWindow/resizeWindowToAgents/window:setWidth/dragStart 全部按三档模式换算；mini 模式下 setWidth 请求按 40 兜底、面板永不渲染
- **设置窗口**：「显示模式」三选一下拉（经典/精简/迷你，sw.mode* 双语）位于顶部冻结操作栏（rev2）；「自动收起」开关（sw.autoCollapse 双语，desc 点题 60 秒/卡住/求助）在开关区，二者同写 displayMode/autoCollapse- **i18n**：双包同步新增 strip.mode.classic/compact/mini、strip.modeAria、strip.miniAria、sw.displayMode(+Desc)、sw.modeClassic/Compact/Mini、sw.autoCollapse(+Desc)
- **升版**：package.json / APP_VERSION → 1.7.0；v163-status-text.test.js F1 写死版本号同步 1.7.0（锚点语义不变）

**验证**：
- 新增 tests/v170-mini-mode.test.js 18 条：displayMode 三值持久化/兜底×5、聚合优先级纯函数+常量+UMD 双通道×4、i18n 双语×2、三档行高与全链路锚点×6（main.js/preload/渲染层/settings.html）、版本三处一致×1
- 全量回归：tests/ 下全部 *.test.js（除 bundle-gate 打包前预期红）全绿；strict-running 12/12 未破
- vite build 编译通过；electron-builder 打包按铁律留待发布环节

**已知限制**：
- 沙箱无 GUI：迷你灯 20px/40px 窗的真实观感、模式切换动画（无动画，瞬时切换）、compact 56px 下长名两行是否局促，待老吴真机首验
- 自动收起判定粒度=5s tick（broadcastState 周期），实际收起时刻为 60~65s 区间；「立即恢复」走同一收口，延迟≤一次状态广播（毫秒级）
- 迷你灯不带 tooltip（聚合灯不代表单一 agent，悬停无详情）；如需聚合摘要 tooltip 留待下版
- v1.6.3 遗留：设置窗口保存总是显式回传 displayMode/autoCollapse；第三方绕过面板直调 settingsPanel:save 且不带键时 displayMode 会被重置为 classic（面板自身路径无此问题）

---
<!-- 下一版从这里追加
## v1.1.0（日期）—— 标题
**变更**：
**验证**：
**已知限制**：
-->
