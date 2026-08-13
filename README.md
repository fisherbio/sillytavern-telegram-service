# SillyTavern Telegram Personal Bridge

面向单用户、仅本机监听的 SillyTavern ↔ Telegram 桥接服务。当前部署在 macOS 上，通过三个 LaunchAgent 分别管理 SillyTavern、Telegram 桥接和专用无头浏览器。

## 功能

- 从 Telegram 与当前 SillyTavern 角色聊天
- 选择角色、已有对话、模型和世界书
- Telegram 与普通酒馆网页双向同步世界书选中状态
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
- `com.local.*.plist`：macOS LaunchAgent 模板，由安装脚本填入本机目录、用户和 Node.js 路径
- `test-*.mjs`：配置、自动剧情、对话删除、流式输出与历史安全相关测试
- `mtproto-*.py`：可选的 Telegram 用户会话授权与完整私聊清理工具
- `install.sh`：新 Mac 的交互式一键部署和幂等更新脚本
- `status.sh`：检查三个 LaunchAgent、SillyTavern HTTP 和本机桥接端口

## 安全说明

以下文件严禁提交，已写入 `.gitignore`：

- `config.json`：包含 Telegram Bot Token 与桥接密钥
- `state.json`：包含配对用户 ID 和运行状态
- `bridge-config.js`：包含浏览器侧桥接密钥
- `mtproto-config.json`、`*.session`：包含 Telegram API 凭据或用户登录会话
- 日志、备份、私钥和临时部署文件

仓库中的所有配置均为不含真实凭据的模板。首次部署应使用密码学安全随机值生成 `bridgeSecret`，并保证 `config.json` 与 `bridge-config.js` 中的值完全一致。

## 新 Mac 一条命令部署

前提：新 Mac 已登录你的 GitHub 账号并配置好访问 Private Repo 的 SSH Key；你还需要从 BotFather 取得 Telegram Bot Token。

打开“终端”，整行复制并执行：

```bash
if [ -d "$HOME/sillytavern-telegram-service/.git" ]; then git -C "$HOME/sillytavern-telegram-service" pull --ff-only; else git clone git@github.com:fisherbio/sillytavern-telegram-service.git "$HOME/sillytavern-telegram-service"; fi && "$HOME/sillytavern-telegram-service/install.sh"
```

脚本会自动完成：

- 检查 macOS、Node.js 20+ 和 Google Chrome；缺少时询问是否通过 Homebrew 安装
- 没有 SillyTavern 时，从官方仓库的 `release` 分支安装到 `~/SillyTavern`
- 安装桥接依赖并部署浏览器扩展
- 隐藏输入 Telegram Bot Token，自动生成 256 位本机桥接密钥和一次性配对码
- 生成并加载三个 LaunchAgent，启动服务并等待健康检查
- 重复执行时更新程序，但保留 `config.json`、`state.json`、Telegram 配对和密钥

部署结束会显示一次性配对码。向机器人发送：

```text
/start 显示的配对码
```

如需更换 Bot Token 或重新配对：

```bash
~/sillytavern-telegram-service/install.sh --reconfigure
```

检查运行状态：

```bash
~/sillytavern-telegram-service/status.sh
```

## 自动部署的目录

默认部署布局：

```text
~/SillyTavern/
~/Library/Application Support/SillyTavernTelegramBridge/
~/SillyTavern/data/default-user/extensions/st-telegram-safe/
~/Library/LaunchAgents/
```

`install.sh` 可重复执行。运行时配置和对话状态位于 Application Support 目录，不会因代码更新而被覆盖；SillyTavern 的角色卡、聊天记录和世界书仍保存在 `~/SillyTavern/data/`，也不会上传到本仓库。

## 验证

```bash
node --check bridge.js
node --input-type=module --check < browser-index.js
node test-auto-story.mjs bridge.js browser-index.js
node test-chat-delete.mjs bridge.js browser-index.js
node test-streaming-output.mjs browser-index.js bridge.js
node test-conversation-recovery.mjs browser-index.js
node test-trim-preserves-prefix.mjs browser-index.js bridge.js
node test-world-sync.mjs browser-index.js bridge.js
./test-installer.sh
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
