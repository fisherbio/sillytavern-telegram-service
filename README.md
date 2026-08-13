# SillyTavern Telegram Personal Bridge

面向单用户、仅本机监听的 SillyTavern ↔ Telegram 桥接服务。当前部署在 macOS 上，通过三个 LaunchAgent 分别管理 SillyTavern、Telegram 桥接和专用无头浏览器。

## 功能

- 从 Telegram 与当前 SillyTavern 角色聊天
- 选择角色、已有对话、模型和世界书
- 新建、预览、撤回、截断和删除对话
- `/wake` 与 `/stop` 管理 SillyTavern 服务
- 自动剧情：用户人格与角色自动交替生成，支持轮数、单条字数、总字数、大纲、暂停和停止
- 稳定显示或流式显示；稳定显示可规避 Telegram 消息持续增长导致的自动下滑
- 检测角色卡前端输出并把酒馆实际渲染界面截图发送到 Telegram
- 单用户 ID 白名单、一次性配对、本机 WebSocket 与共享密钥认证

## 目录说明

- `bridge.js`：Telegram Bot、菜单、状态管理与本机 WebSocket 服务
- `browser-index.js`：SillyTavern 浏览器扩展主体；部署时复制为扩展目录中的 `index.js`
- `browser-keeper.js`：等待 SillyTavern 后启动专用无头 Chrome
- `manifest.json`、`settings.html`、`style.css`：SillyTavern 扩展文件
- `bridge-config.example.js`：浏览器扩展连接配置模板
- `config.example.json`：Telegram 桥接配置模板
- `com.local.*.plist`：macOS LaunchAgent 模板，其中 `__HOME__` 与 `__NODE__` 需在安装时替换
- `test-*.mjs`：配置、自动剧情、对话删除、流式输出与历史安全相关测试
- `mtproto-*.py`：可选的 Telegram 用户会话授权与完整私聊清理工具

## 安全说明

以下文件严禁提交，已写入 `.gitignore`：

- `config.json`：包含 Telegram Bot Token 与桥接密钥
- `state.json`：包含配对用户 ID 和运行状态
- `bridge-config.js`：包含浏览器侧桥接密钥
- `mtproto-config.json`、`*.session`：包含 Telegram API 凭据或用户登录会话
- 日志、备份、私钥和临时部署文件

仓库中的所有配置均为不含真实凭据的模板。首次部署应使用密码学安全随机值生成 `bridgeSecret`，并保证 `config.json` 与 `bridge-config.js` 中的值完全一致。

## 部署概览

默认部署布局：

```text
~/SillyTavern/
~/Library/Application Support/SillyTavernTelegramBridge/
~/SillyTavern/data/default-user/extensions/st-telegram-safe/
~/Library/LaunchAgents/
```

1. 安装 Node.js 20+、SillyTavern 和 Google Chrome。
2. 将本仓库的桥接文件复制到 `~/Library/Application Support/SillyTavernTelegramBridge/`，运行 `npm ci --omit=dev`。
3. 从 `config.example.json` 创建 `config.json`，写入 Bot Token、配对码与随机桥接密钥，权限设置为 `600`。
4. 将 `browser-index.js` 复制为扩展目录的 `index.js`，并复制 `manifest.json`、`settings.html`、`style.css`。
5. 从 `bridge-config.example.js` 创建扩展目录的 `bridge-config.js`，写入与 `config.json` 一致的桥接密钥。
6. 替换三个 plist 中的 `__HOME__`、`__NODE__` 与 `__USER__`（如存在），复制到 `~/Library/LaunchAgents/` 后使用 `launchctl bootstrap` 加载。

建议每次更新前备份已部署的 `bridge.js`、扩展 `index.js` 和 `manifest.json`，完成语法检查后再原子替换并重启两个桥接 LaunchAgent。

## 验证

```bash
node --check bridge.js
node --input-type=module --check < browser-index.js
node test-auto-story.mjs bridge.js browser-index.js
node test-chat-delete.mjs bridge.js browser-index.js
node test-streaming-output.mjs browser-index.js bridge.js
node test-conversation-recovery.mjs browser-index.js
node test-trim-preserves-prefix.mjs browser-index.js bridge.js
```

部分诊断或上游模型测试依赖本机 SillyTavern 数据和私有 API 配置，不属于离线测试。

## 常用 Telegram 命令

- `/menu`：控制菜单
- `/auto`：自动剧情
- `/autopause`、`/autoresume`、`/autostop`、`/autostatus`
- `/stream`：稳定或流式显示
- `/characters`、`/chats`、`/models`、`/worlds`
- `/history`、`/undo`、`/new`、`/clear`
- `/wake`、`/stop`、`/status`
