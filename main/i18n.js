/**
 * main/i18n.js — 中英双语语言包（v1.5.0 全球发布版）。
 *
 * 单一事实来源：主进程（右键菜单/窗口标题/tooltip 数据）、设置窗口
 * （settings.html 经 <script src="i18n.js"> 取 window.ASL_I18N）、React
 * 渲染层（Vite import 默认导出）共用同一份 PACKS —— 不存在两处文案漂移。
 *
 * UMD 包装：node/Electron 主进程走 module.exports，浏览器（settings.html /
 * tooltip.html，均 contextIsolation 无 require）挂 window.ASL_I18N。
 *
 * key 约定：扁平点分段（surface.name）。两语言包的 key 集合必须完全一致，
 * tests/i18n.test.js 有守卫（防漏翻）。
 *
 * 插值：t(lang, 'tpl', { n: 3 }) 把 {n} 替换为参数值。
 */
(function (root, factory) {
  // 双通道赋值（v1.5.2 P0 修复）：module.exports 与 window 全局**同时**挂，
  // 绝不用 else —— Vite 构建经 rollup commonjs 垫片后 module 与 window 并存，
  // 旧 else 写法只走 module 分支，window.ASL_I18N 永远 undefined，渲染层
  // I18N.t() 崩 TypeError（空黑条事故）。Node 单测 module 天然存在走同一分支，
  // 单测全绿也抓不到——tests/umd-dual-env.test.js 专守此坑。
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ASL_I18N = api;
  else if (root && typeof root === 'object') root.ASL_I18N = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /** 可持久化的语言设置值；auto = 跟随系统 locale。 */
  const LANGUAGES = ['auto', 'zh-CN', 'en-US'];
  const DEFAULT_LANGUAGE = 'zh-CN';

  const zhCN = {
    // ---- 窗口标题 / 右键菜单（主进程） ----
    'title.main': 'AI 状态灯·云端版 {version}',
    'title.settings': 'AI 状态灯 - 设置',
    'menu.settings': '⚙️ 设置',
    'menu.refresh': '重新检测',
    'menu.quit': '退出 AI 状态灯',

    // ---- 状态文案（tooltip / 详情面板 / 源管理共用） ----
    'status.running': '运行中',
    'status.idle': '空闲/等待',
    'status.stuck': '卡住/需人工介入',
    'status.assist': '求助/已电话通知，待人工处理',
    'status.offline': '离线',
    'status.autoDowngrade': '（心跳超时自动降级）',

    // ---- 相对时间 ----
    'time.never': '从未上报',
    'time.just': '刚刚',
    'time.secAgo': '{n} 秒前',
    'time.minAgo': '{n} 分钟前',
    'time.hourAgo': '{n} 小时前',

    // ---- tooltip 小窗 ----
    'tip.status': '状态：',
    'tip.task': '任务：',
    'tip.heartbeat': '最后心跳：',
    'tip.stale': '长时间未更新',

    // ---- 灯条 ----
    'strip.empty': '暂无 AI 源，点右侧 ⚙ 添加',
    'strip.gearAria': '设置',
    'strip.gearTitle': 'AI 源管理',
    // v1.6.3 灯下状态文字：短词版状态文案（tooltip/详情用 status.* 长文案，
    // 灯条 52px 宽度下只能放短词，故单独一套 key）
    'strip.status.running': '运行中',
    'strip.status.idle': '空闲',
    'strip.status.stuck': '卡住',
    'strip.status.assist': '等你处理',
    'strip.status.offline': '离线',

    // ---- 详情面板（React） ----
    'detail.close': '关闭',
    'detail.status': '状态',
    'detail.task': '当前任务',
    'detail.noTask': '（无）',
    'detail.heartbeat': '最后心跳',
    'detail.dialogs': '对话',
    'detail.noDialogs': '无活动窗口',
    'detail.generating': '生成中',
    'detail.ack': '已人工处理，熄灭求助灯',
    'detail.ackTitle': '我已收到通知并处理完毕，熄灭紫色求助灯',
    'detail.remove': '移除该 AI',

    // ---- 灯条内嵌源管理面板（React SettingsPanel） ----
    'panel.title': 'AI 源管理',
    'panel.close': '关闭',
    'panel.sound': '提示音',
    'panel.soundHint': '求助(紫)=三响 · 卡住(红)=两响',
    'panel.delete': '删除',
    'panel.monitor': '监测:',
    'panel.monitorNone': '无（仅手动/API 上报）',
    'panel.monitorEdit': '修改',
    'panel.monitorEditing': '监测进程:',
    'panel.monitorPlaceholder': '如 Doubao.exe，留空取消监测',
    'panel.save': '保存',
    'panel.add': '添加',
    'panel.namePlaceholder': '显示名（必填，如 豆包）',
    'panel.procPlaceholder': '监测进程名（可选，如 Doubao.exe）',
    'panel.errNameRequired': '请填写显示名',
    'panel.errAddFailed': '添加失败',
    'panel.empty': '暂无 AI 源，请在下方添加。',
    'panel.guide': '使用说明',
    'panel.collapse': '收起 ▲',
    'panel.expand': '展开 ▼',
    'panel.guideColors': '灯色含义：',
    'panel.guideColorsBody': '🟢 运行中 · 🟡 在线空闲 · ⚪ 离线 · 🟣 求助（等你确认，三响）· 🔴 卡住（两响）',
    'panel.guideAdd': '添加 AI：',
    'panel.guideAddBody': '填显示名即可。想让它自动亮灯，再填监测进程名——软件开着变黄，切到它窗口 3 秒变绿，关掉变灰。删除 AI 会连同监测一起删除。改动 5 秒内生效，无需重启。',
    'panel.guideFind': '怎么找进程名：',
    'panel.guideFindBody': '按 Ctrl+Shift+Esc 打开任务管理器 → 「详细信息」标签 → 找到该软件 → 看名称列的 xxx.exe，原样填入。',
    'panel.guideApi': '进阶（API 上报）：',
    'panel.guideApiBody': '其他工具可 POST http://127.0.0.1:17890/status（JSON：agent/status/task）上报精确状态，适合有接口的 AI。',

    // ---- 独立设置窗口（settings.html） ----
    'sw.subtitle': '改完点「保存」，30 秒内自动生效，不用重启。',
    'sw.language': '语言 / Language',
    'sw.langAuto': '跟随系统',
    'sw.langZh': '中文',
    'sw.langEn': 'English',
    'sw.agents': 'AI 灯源管理',
    'sw.colName': '名称',
    'sw.colId': 'ID',
    'sw.colProcess': '桌面监视进程',
    'sw.colKeywords': '窗口关键词',
    'sw.addBtn': '＋ 新增 AI',
    'sw.addHint': '进程留空 = 未配置（仅接收上报）；窗口关键词用逗号分隔，用于画面检测',
    'sw.dropTitle': '把应用的快捷方式拖到这里，自动识别添加',
    'sw.dropHint': '支持桌面/开始菜单的 .lnk 快捷方式，或直接拖入 .exe 程序',
    'sw.switches': '开关',
    'sw.screenWatch': '画面检测',
    'sw.screenWatchDesc': '截屏比对各 AI 窗口内容，AI 生成回答时自动亮绿灯',
    // v1.6.3 灯下状态文字开关（缺省开）
    'sw.showStatusText': '灯下状态文字',
    'sw.showStatusTextDesc': '每盏灯名称下方常显一行小字状态词（运行中/空闲/卡住/等你处理/离线），不用悬停就能看清',
    'sw.cloudRelay': '云端中转（MQTT）',
    'sw.cloudRelayDesc': '接收云电脑/服务器上 AI 的状态上报；只在本地用时可以关掉',
    'sw.mqttTopic': '云端主题',
    'sw.mqttTopicDesc': '云 AI 向这个主题上报状态；每台机器随机生成，重新生成后云端脚本要同步换主题',
    'sw.regenerate': '重新生成',
    'sw.regenerated': '已生成新主题，云端脚本请同步更换',
    'sw.regenerateFail': '重新生成失败',
    'sw.soundOn': '提示音',
    'sw.soundOnDesc': 'AI 求助（紫灯）或卡死（红灯）时播放提示音',
    'sw.volume': '提示音音量',
    'sw.volumeDesc': '高档最响，建议保持「高」',
    'sw.volLow': '低',
    'sw.volMid': '中',
    'sw.volHigh': '高',
    'sw.repeatAlert': '紫灯/红灯重复提醒',
    'sw.repeatAlertDesc': 'AI 求助（紫灯）或卡死（红灯）时每 30 秒重复响一次，直到你处理',
    'sw.autoDiscover': '自动发现新 AI 软件',
    'sw.autoDiscoverDesc': '检测到新安装的 AI 软件时自动加进灯清单（误加的删掉即可，删过的不会再加回）。云端 AI（聊天机器人等）本地检测不到，请用 MQTT 云上报接入',
    'sw.openAtLogin': '开机自启',
    'sw.openAtLoginDesc': 'Windows 登录后自动启动（仅安装版/绿色版生效）',
    'sw.openAtLoginDev': '当前为开发模式，仅安装版/绿色版生效',
    'sw.blacklist': '自动发现黑名单',
    'sw.blacklistHint': '被你删掉的 AI 不会再自动加回；点「解除」后下次扫描可重新发现。',
    'sw.unblacklist': '解除',
    'sw.unblacklistOk': '已解除「{name}」的黑名单，30 秒内扫描可重新发现',
    'sw.unblacklistFail': '解除失败：{err}',
    'sw.cancel': '取消',
    'sw.confirmDiscard': '确认放弃修改？',
    'sw.save': '保存',
    'sw.saved': '已保存，30 秒内自动生效',
    'sw.saveFail': '保存失败',
    'sw.loadFail': '读取配置失败：{err}',
    'sw.close': '关闭',
    'sw.deleteRow': '删除',
    'sw.phName': '显示名称，如：豆包',
    'sw.phId': '留空自动生成',
    'sw.phProcess': '未配置（仅接收上报）',
    'sw.phKeywords': '如：豆包,Doubao',
    // 面板本地校验
    'sw.valNameEmpty': '第 {n} 行：名称不能为空',
    'sw.valIdInvalid': '第 {n} 行：id「{id}」不合法（1-24 字符：a-z 0-9 _ -）',
    'sw.valIdDup': 'id「{id}」重复',
    'sw.valKwNoProc': '第 {n} 行：填了窗口关键词但进程为空，画面检测需要先有监视进程',
    'sw.valNeedOne': '至少保留一个 AI 灯源',
    // 拖放
    'sw.dropNoPath': '取不到文件路径，请改用手动添加',
    'sw.dropIdentifying': '正在识别「{name}」…',
    'sw.dropDup': '「{name}」已在清单中，无需重复添加',
    'sw.dropPartial': '未能识别进程名，请手动补充后点「保存」',
    'sw.dropAdded': '已添加「{name}」，30 秒内自动生效',
    'sw.dropFail': '解析失败，请手动添加',
    'sw.dropFailErr': '解析失败：{err}',
    'sw.dropReject': '只支持快捷方式(.lnk)或 exe',
    // 主进程 settings-ops 校验报错（errorKey 映射；无 key 时原样展示）
    'err.payloadEmpty': '提交内容为空',
    'err.agentsNotArray': 'agents 必须是数组',
    'err.tooManyAgents': 'AI 数量超过上限 {n}',
    'err.invalidAgentEntry': '存在无效的 AI 条目',
    'err.nameEmpty': 'AI 名称不能为空',
    'err.nameTooLong': '名称「{name}…」超过 {n} 字符',
    'err.idInvalid': 'id「{id}」不合法（1-24 字符：a-z 0-9 _ -）',
    'err.idDup': 'id「{id}」重复',
    'err.idGenFail': '无法为「{name}」生成唯一 id',
    'err.watcherDangling': '监视配置的进程「{proc}」指向不存在的 AI「{agent}」',
    'err.procTooLong': '进程名「{proc}…」过长',
    'err.volumeInvalid': '音量档位「{v}」不合法（low/medium/high）',
    'err.languageInvalid': '语言设置「{v}」不合法（auto/zh/en）',
    'err.configBroken': 'config.json 已损坏，已拒绝保存（原文件已备份为 config.json.bak，请修复后重启）',
    // v1.5.1：AI 接入提示词 + 电话告警
    'sw.prompts': 'AI 接入提示词',
    'sw.promptsHint': '复制提示词发给任意 AI（让它写入永久记忆），它就会主动上报状态，不用配进程监视。',
    'sw.promptHttp': '本机 HTTP（就跑在这台电脑上的 AI）',
    'sw.promptMqtt': '云端 MQTT（云电脑/服务器上的 AI）',
    'sw.copy': '一键复制',
    'sw.copied': '已复制 ✓',
    'sw.copyFail': '复制失败，请手动全选复制',
    'sw.alert': '电话告警',
    'sw.alertDesc': 'AI 求助（紫灯）或卡死（红灯）时自动 POST 到你的 webhook（如来电提醒服务）；默认关闭，留空不启用',
    'sw.alertEnabled': '启用电话告警',
    'sw.alertUrl': 'Webhook URL',
    'sw.alertUrlPh': '如 http://127.0.0.1:3001/alert',
    'sw.alertKey': 'Key（服务端密钥，可空）',
    'sw.alertKeyPh': '留空 = 不带密钥',
    'sw.alertOnAssist': '求助（紫灯）时告警',
    'sw.alertOnStuck': '卡死（红灯）时告警',
    'err.alertWebhookInvalid': '电话告警配置格式不对',
    'err.alertUrlInvalid': '告警 URL 不合法（须以 http:// 或 https:// 开头）',
    'err.alertKeyTooLong': '告警 Key 过长（≤200 字符）',
    // v1.6.0：快捷添加 / broker 可配置 / 引流位 / 关于角 / 自动更新横幅 / 齿轮菜单
    'menu.agents': 'AI 源管理',
    'sw.quickAdd': '快捷添加（全球常用 AI）',
    'sw.quickAddHint': '点「添加」直接进灯清单；带桌面客户端的自动监测进程，标「云端上报」的需复制提示词给该 AI 接入',
    'sw.presetAdd': '添加',
    'sw.presetAdded': '已添加',
    'sw.presetAddedOk': '已添加「{name}」，30 秒内自动生效',
    'sw.presetCloud': '云端上报',
    'sw.presetSite': '官网 ↗',
    'sw.presetClosePrompt': '收起提示词 ▲',
    'sw.mqttBroker': 'Broker 地址（TCP）',
    'sw.mqttBrokerWss': 'Broker 地址（WebSocket，网页端用）',
    'sw.mqttBrokerPh': '留空 = 默认 mqtts://broker.emqx.io:8883',
    'sw.mqttBrokerWssPh': '留空 = 默认 wss://broker.emqx.io:8084/mqtt',
    'err.mqttBrokerInvalid': 'Broker（TCP）地址不合法（须以 mqtt://、mqtts://、ws:// 或 wss:// 开头）',
    'err.mqttBrokerWssInvalid': 'Broker（WebSocket）地址不合法（须以 mqtt://、mqtts://、ws:// 或 wss:// 开头）',
    'sw.alertPromo': '没有中继服务？联系作者协助部署 →',
    'sw.about': '关于与支持',
    'sw.aboutAuthor': '作者邮箱',
    'sw.aboutKofi': '请作者喝杯咖啡 ☕',
    'update.banner': '有新版本 v{version} → 查看',
    // v1.6.1：顶部冻结操作栏 + 手动检查更新三态
    'sw.checkUpdate': '检查更新',
    'sw.updateChecking': '检查中…',
    'sw.updateNew': '发现新版本 v{version} →',
    'sw.updateLatest': '已是最新版本',
    'sw.updateNotReady': '更新源暂未开放',
  };

  const enUS = {
    'title.main': 'AI Status Light · Cloud {version}',
    'title.settings': 'AI Status Light - Settings',
    'menu.settings': '⚙️ Settings',
    'menu.refresh': 'Re-scan',
    'menu.quit': 'Quit AI Status Light',

    'status.running': 'Running',
    'status.idle': 'Idle / waiting',
    'status.stuck': 'Stuck / needs attention',
    'status.assist': 'Help requested / human notified',
    'status.offline': 'Offline',
    'status.autoDowngrade': ' (auto-downgraded: heartbeat timeout)',

    'time.never': 'Never reported',
    'time.just': 'just now',
    'time.secAgo': '{n}s ago',
    'time.minAgo': '{n}m ago',
    'time.hourAgo': '{n}h ago',

    'tip.status': 'Status: ',
    'tip.task': 'Task: ',
    'tip.heartbeat': 'Last heartbeat: ',
    'tip.stale': 'Not updated for a while',

    'strip.empty': 'No AI sources yet — click ⚙ to add',
    'strip.gearAria': 'Settings',
    'strip.gearTitle': 'Manage AI sources',
    // v1.6.3 status text under lights (short words — strip is only 52px wide)
    'strip.status.running': 'Running',
    'strip.status.idle': 'Idle',
    'strip.status.stuck': 'Stuck',
    'strip.status.assist': 'Waiting',
    'strip.status.offline': 'Offline',

    'detail.close': 'Close',
    'detail.status': 'Status',
    'detail.task': 'Current task',
    'detail.noTask': '(none)',
    'detail.heartbeat': 'Last heartbeat',
    'detail.dialogs': 'Dialogs',
    'detail.noDialogs': 'No active windows',
    'detail.generating': 'Generating',
    'detail.ack': 'Handled — clear alert',
    'detail.ackTitle': 'I received the notification and handled it; turn off the purple alert light',
    'detail.remove': 'Remove this AI',

    'panel.title': 'AI Sources',
    'panel.close': 'Close',
    'panel.sound': 'Alert sound',
    'panel.soundHint': 'Help (purple) = triple beep · Stuck (red) = double beep',
    'panel.delete': 'Delete',
    'panel.monitor': 'Watch:',
    'panel.monitorNone': 'none (manual/API reports only)',
    'panel.monitorEdit': 'Edit',
    'panel.monitorEditing': 'Watch process:',
    'panel.monitorPlaceholder': 'e.g. ChatGPT.exe; empty = no watching',
    'panel.save': 'Save',
    'panel.add': 'Add',
    'panel.namePlaceholder': 'Display name (required)',
    'panel.procPlaceholder': 'Process name (optional, e.g. ChatGPT.exe)',
    'panel.errNameRequired': 'Display name is required',
    'panel.errAddFailed': 'Add failed',
    'panel.empty': 'No AI sources yet. Add one below.',
    'panel.guide': 'Usage guide',
    'panel.collapse': 'Collapse ▲',
    'panel.expand': 'Expand ▼',
    'panel.guideColors': 'Light colors: ',
    'panel.guideColorsBody': '🟢 running · 🟡 online idle · ⚪ offline · 🟣 help requested (triple beep) · 🔴 stuck (double beep)',
    'panel.guideAdd': 'Add an AI: ',
    'panel.guideAddBody': 'A display name is enough. To light it up automatically, also fill in the process name — app running turns it yellow, focusing its window for 3s turns it green, closing it turns it grey. Removing an AI also removes its watcher. Changes apply within 5 seconds, no restart needed.',
    'panel.guideFind': 'Find a process name: ',
    'panel.guideFindBody': 'Press Ctrl+Shift+Esc to open Task Manager → "Details" tab → find the app → copy the xxx.exe name as-is.',
    'panel.guideApi': 'Advanced (API reports): ',
    'panel.guideApiBody': 'Other tools can POST http://127.0.0.1:17890/status (JSON: agent/status/task) to report precise states — ideal for AIs with scripting interfaces.',

    'sw.subtitle': 'Click "Save" after editing; changes apply within 30 seconds, no restart needed.',
    'sw.language': 'Language / 语言',
    'sw.langAuto': 'System default',
    'sw.langZh': '中文',
    'sw.langEn': 'English',
    'sw.agents': 'AI Sources',
    'sw.colName': 'Name',
    'sw.colId': 'ID',
    'sw.colProcess': 'Watched process',
    'sw.colKeywords': 'Window keywords',
    'sw.addBtn': '+ Add AI',
    'sw.addHint': 'Empty process = report-only; comma-separated window keywords enable screen detection',
    'sw.dropTitle': 'Drop an app shortcut here to add it automatically',
    'sw.dropHint': 'Supports .lnk shortcuts (Desktop / Start Menu) or a .exe file',
    'sw.switches': 'Switches',
    'sw.screenWatch': 'Screen detection',
    'sw.screenWatchDesc': 'Compares AI window screenshots; the light turns green while the AI is generating',
    // v1.6.3 status text under lights (default on)
    'sw.showStatusText': 'Status text under lights',
    'sw.showStatusTextDesc': 'Always shows a short status word under each light name (Running / Idle / Stuck / Waiting / Offline) — no hovering needed',
    'sw.cloudRelay': 'Cloud relay (MQTT)',
    'sw.cloudRelayDesc': 'Receives status reports from AIs on cloud machines/servers; turn off for local-only use',
    'sw.mqttTopic': 'Cloud topic',
    'sw.mqttTopicDesc': 'Cloud AIs report to this MQTT topic; randomly generated per machine — after regenerating, update your cloud scripts to the new topic',
    'sw.regenerate': 'Regenerate',
    'sw.regenerated': 'New topic generated — update your cloud scripts to match',
    'sw.regenerateFail': 'Regenerate failed',
    'sw.soundOn': 'Alert sound',
    'sw.soundOnDesc': 'Plays a tone when an AI asks for help (purple) or gets stuck (red)',
    'sw.volume': 'Alert volume',
    'sw.volumeDesc': 'High is loudest; recommended',
    'sw.volLow': 'Low',
    'sw.volMid': 'Med',
    'sw.volHigh': 'High',
    'sw.repeatAlert': 'Repeat alerts',
    'sw.repeatAlertDesc': 'Repeats the alert every 30s while an AI is asking for help (purple) or stuck (red), until you handle it',
    'sw.autoDiscover': 'Auto-discover new AI apps',
    'sw.autoDiscoverDesc': 'Newly installed AI apps are added to the strip automatically (delete false positives; deleted ones stay deleted). Cloud AIs (chat bots etc.) cannot be detected locally — connect them via MQTT cloud relay',
    'sw.openAtLogin': 'Launch at login',
    'sw.openAtLoginDesc': 'Starts AI Status Light after Windows sign-in (installed/portable builds only)',
    'sw.openAtLoginDev': 'Development mode — only installed/portable builds honor this',
    'sw.blacklist': 'Auto-discovery blacklist',
    'sw.blacklistHint': 'AIs you deleted are never re-added automatically; click "Unblock" to allow rediscovery on the next scan.',
    'sw.unblacklist': 'Unblock',
    'sw.unblacklistOk': '"{name}" unblocked; the next scan (within 30s) can rediscover it',
    'sw.unblacklistFail': 'Unblock failed: {err}',
    'sw.cancel': 'Cancel',
    'sw.confirmDiscard': 'Discard changes?',
    'sw.save': 'Save',
    'sw.saved': 'Saved; applies within 30 seconds',
    'sw.saveFail': 'Save failed',
    'sw.loadFail': 'Failed to load config: {err}',
    'sw.close': 'Close',
    'sw.deleteRow': 'Delete',
    'sw.phName': 'Display name, e.g. ChatGPT',
    'sw.phId': 'Auto-generated if empty',
    'sw.phProcess': 'Not configured (report-only)',
    'sw.phKeywords': 'e.g. ChatGPT,GPT',
    'sw.valNameEmpty': 'Row {n}: name cannot be empty',
    'sw.valIdInvalid': 'Row {n}: id "{id}" is invalid (1-24 chars: a-z 0-9 _ -)',
    'sw.valIdDup': 'Duplicate id "{id}"',
    'sw.valKwNoProc': 'Row {n}: window keywords set but no process — screen detection needs a watched process first',
    'sw.valNeedOne': 'Keep at least one AI source',
    'sw.dropNoPath': 'Could not get the file path; please add manually',
    'sw.dropIdentifying': 'Identifying "{name}"…',
    'sw.dropDup': '"{name}" is already in the list',
    'sw.dropPartial': 'Could not detect the process name — fill it in and click "Save"',
    'sw.dropAdded': 'Added "{name}"; applies within 30 seconds',
    'sw.dropFail': 'Parse failed; please add manually',
    'sw.dropFailErr': 'Parse failed: {err}',
    'sw.dropReject': 'Only shortcuts (.lnk) or .exe files are supported',
    'err.payloadEmpty': 'Empty submission',
    'err.agentsNotArray': 'agents must be an array',
    'err.tooManyAgents': 'Too many AI sources (max {n})',
    'err.invalidAgentEntry': 'Invalid AI entry',
    'err.nameEmpty': 'AI name cannot be empty',
    'err.nameTooLong': 'Name "{name}…" exceeds {n} chars',
    'err.idInvalid': 'id "{id}" is invalid (1-24 chars: a-z 0-9 _ -)',
    'err.idDup': 'Duplicate id "{id}"',
    'err.idGenFail': 'Cannot generate a unique id for "{name}"',
    'err.watcherDangling': 'Watched process "{proc}" points to unknown AI "{agent}"',
    'err.procTooLong': 'Process name "{proc}…" is too long',
    'err.volumeInvalid': 'Invalid volume "{v}" (low/medium/high)',
    'err.languageInvalid': 'Invalid language "{v}" (auto/zh/en)',
    'err.configBroken': 'config.json is corrupted; save refused (backed up as config.json.bak — fix it and restart)',
    // v1.5.1: integration prompts + phone alert
    'sw.prompts': 'AI Integration Prompt',
    'sw.promptsHint': 'Copy a prompt and send it to any AI (ask it to store it in permanent memory) — it will then report its status proactively, no process watching needed.',
    'sw.promptHttp': 'Local HTTP (AIs running on this machine)',
    'sw.promptMqtt': 'Cloud MQTT (AIs on cloud machines / servers)',
    'sw.copy': 'Copy',
    'sw.copied': 'Copied ✓',
    'sw.copyFail': 'Copy failed — please select all and copy manually',
    'sw.alert': 'Phone Alert',
    'sw.alertDesc': 'When an AI asks for help (purple) or gets stuck (red), automatically POST to your webhook (e.g. a call-reminder service); off by default, empty URL = disabled',
    'sw.alertEnabled': 'Enable phone alert',
    'sw.alertUrl': 'Webhook URL',
    'sw.alertUrlPh': 'e.g. http://127.0.0.1:3001/alert',
    'sw.alertKey': 'Key (server secret, optional)',
    'sw.alertKeyPh': 'Empty = no key',
    'sw.alertOnAssist': 'Alert on help request (purple)',
    'sw.alertOnStuck': 'Alert on stuck (red)',
    'err.alertWebhookInvalid': 'Invalid phone alert config',
    'err.alertUrlInvalid': 'Invalid alert URL (must start with http:// or https://)',
    'err.alertKeyTooLong': 'Alert key too long (max 200 chars)',
    // v1.6.0: quick add / configurable broker / promo slot / about corner / update banner / gear menu
    'menu.agents': 'AI Sources',
    'sw.quickAdd': 'Quick Add (Popular AI Apps)',
    'sw.quickAddHint': 'Click "Add" to put one on the strip; apps with a desktop client are auto-watched, ones tagged "Cloud" need the integration prompt',
    'sw.presetAdd': 'Add',
    'sw.presetAdded': 'Added',
    'sw.presetAddedOk': 'Added "{name}"; applies within 30 seconds',
    'sw.presetCloud': 'Cloud',
    'sw.presetSite': 'Site ↗',
    'sw.presetClosePrompt': 'Hide prompt ▲',
    'sw.mqttBroker': 'Broker (TCP)',
    'sw.mqttBrokerWss': 'Broker (WebSocket, for web clients)',
    'sw.mqttBrokerPh': 'Empty = default mqtts://broker.emqx.io:8883',
    'sw.mqttBrokerWssPh': 'Empty = default wss://broker.emqx.io:8084/mqtt',
    'err.mqttBrokerInvalid': 'Invalid broker (TCP) URL (must start with mqtt://, mqtts://, ws:// or wss://)',
    'err.mqttBrokerWssInvalid': 'Invalid broker (WebSocket) URL (must start with mqtt://, mqtts://, ws:// or wss://)',
    'sw.alertPromo': 'No relay? Get it set up by the author →',
    'sw.about': 'About & Support',
    'sw.aboutAuthor': 'Author',
    'sw.aboutKofi': 'Buy the author a coffee ☕',
    'update.banner': 'New version v{version} → View',
    // v1.6.1: sticky top action bar + manual update check tri-state
    'sw.checkUpdate': 'Check for updates',
    'sw.updateChecking': 'Checking…',
    'sw.updateNew': 'New version v{version} →',
    'sw.updateLatest': 'You are up to date',
    'sw.updateNotReady': 'Update source not available yet',
  };

  const PACKS = { 'zh-CN': zhCN, 'en-US': enUS };

  /**
   * 规范化语言设置值：auto/zh-CN/en-US 原样收，zh/en 补全，其余 null（非法）。
   * @param {*} v 用户配置值
   * @returns {'auto'|'zh-CN'|'en-US'|null}
   */
  function normalizeLanguage(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (s === 'auto' || s === 'zh-CN' || s === 'en-US') return s;
    if (/^zh([-_].*)?$/i.test(s)) return 'zh-CN';
    if (/^en([-_].*)?$/i.test(s)) return 'en-US';
    return null;
  }

  /**
   * 解析出实际使用的语言包。
   * @param {*} value 配置值（auto/zh/en/zh-CN/en-US；非法按 auto 处理）
   * @param {string} [systemLocale] 系统 locale（app.getLocale()），仅 auto 时用
   * @returns {'zh-CN'|'en-US'}
   */
  function resolveLanguage(value, systemLocale) {
    const norm = normalizeLanguage(value);
    if (norm === 'zh-CN' || norm === 'en-US') return norm;
    // auto（含非法值兜底）：系统 locale 以 zh 开头用中文，否则英文。
    const loc = String(systemLocale || '');
    return /^zh/i.test(loc) ? 'zh-CN' : 'en-US';
  }

  /**
   * 取文案。fallback 链：指定语言包 -> 中文包 -> key 本身（开发期防呆）。
   * @param {string} lang 已解析语言（zh-CN/en-US；其他值按 zh-CN）
   * @param {string} key
   * @param {object} [params] 插值参数：{ n: 3 } 替换文案里的 {n}
   */
  function t(lang, key, params) {
    const pack = PACKS[lang] || PACKS[DEFAULT_LANGUAGE];
    let s = pack[key];
    if (s === undefined) s = PACKS[DEFAULT_LANGUAGE][key];
    if (s === undefined) s = key;
    if (params && typeof params === 'object') {
      for (const k of Object.keys(params)) {
        s = s.split(`{${k}}`).join(String(params[k]));
      }
    }
    return s;
  }

  return { LANGUAGES, DEFAULT_LANGUAGE, PACKS, normalizeLanguage, resolveLanguage, t };
});
