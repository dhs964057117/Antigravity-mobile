<div align="center">
  <img src="./assets/antigravity.png" alt="Antigravity-mobile" width="300">
  <h1>Antigravity-mobile 📱</h1>
  <p><b>随时随地在手机端监控与操控您的 Antigravity AI 编程会话</b></p>
</div>

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

> 📌 **项目溯源与致谢 (Fork Attribution)**
> 
> 本项目基于 **[krishnakanthb13/antigravity_phone_chat](https://github.com/krishnakanthb13/antigravity_phone_chat)** 进行二次开发与深度重构（原始灵感启发自 [gherghett/Antigravity-Shit-Chat](https://github.com/gherghett/Antigravity-Shit-Chat)）。
> 针对最新版 **Google Antigravity (2.0)** 进行了架构升级、性能重构、体验打磨与移动端交互重塑。

---

## 🌟 核心功能升级 (Major Enhancements)

相比原上游项目，**Antigravity-mobile** 带来了以下重大升级与修复：

### 1. ⚡ 无感平滑渲染与彻底防闪烁 (MorphDOM In-place Reconciliation)
* **告别白屏重绘**：使用轻量化 DOM 局部比对算法（In-place morphing）替换了全量清空 `innerHTML` 的暴力渲染机制。
* **零频闪阅读**：彻底解决原版每隔几秒刷新一次导致的屏幕白光闪烁、图片重复重载与重排卡顿，多轮长对话依然丝滑。

### 2. 🎯 智能滚动视口锁定 (Smart Scroll Lock & Jitter-Free)
* **翻阅历史不跳动**：智能判断用户交互状态，向上翻阅历史代码或消息时强制锁定当前可视区域，绝不强制拉回底部。
* **平滑流式跟随**：仅当用户处于页面底部且大模型正在生成新内容时，才会轻柔跟进最新文字。

### 3. 🎨 样式特征缓存与暗色模式优化 (Cached Style & Dark Theme)
* **样式性能大幅提升**：加入 CSS 哈希比较机制，杜绝每次轮询重复将 50KB+ 的样式表挂载进 DOM。
* **高对比度移动端适配**：深度美化代码块高亮、引用胶囊、文件提及组件，内置便捷的移动端一键复制代码功能。

### 4. 🌐 一键安全外网穿透与免密扫码 (Cloudflare Zero-Trust Tunnel)
* **免除公网 IP**：弃用容易崩溃的旧版隧道，全自动集成开箱即用的 Ephemeral Cloudflare 隧道。
* **扫码即连 (Magic QR)**：终端生成带安全 Token 的 Magic QR Code，手机扫码即可直接免密进入，无需手动配置路由器或输入长密码。

### 5. 🗂️ 全面对齐 Antigravity 2.0 桌面端会话分组 (Desktop Grouping Parity)
* **对齐桌面端侧边栏**：不再是杂乱无序的平铺列表，而是完美呈现 Antigravity 2.0 的三层会话体系：
  * 📌 **Pinned**：置顶会话固定在最上方。
  * 📁 **Projects**：按具体工作区 / 项目文件夹（如 `SnapSave`、`gyrosApp` 等）折叠分组展示，支持项目会话折叠/展开与角标统计。
  * 💬 **Conversations**：集中呈现未绑定项目的全局或独立会话。

### 6. 🔄 坚如磐石的会话无缝切换 (Robust Session Switcher)
* **精准路由触发**：深入匹配 Antigravity 侧边栏内层 `<a href="/c/...">` 路由锚点与完整的鼠标指针事件流。
* **消除按键竞态**：消除了手机抽屉关闭时广播 `Escape` 键对桌面端弹窗的竞争打断；结合长文本语义分词与 React 原生事件，会话切换 100% 成功率。

### 7. 🚀 启动环境自愈与僵尸进程清理 (Self-Healing Launcher)
* **本地虚拟环境优先**：批处理文件智能锁定项目内部 Python 虚拟环境，杜绝外部 Conda 依赖冲突或 PyPI 下载卡死。
* **端口冲突自愈**：每次启动自动排查并清理残留的孤儿进程，确保 3000 端口即点即用。

### 8. 💻📱 桌面端与移动端双端自适应 UI 重构 (Desktop & Mobile Adaptive UI)
* **桌面端专属双栏布局**：宽屏下呈现左侧可折叠侧边栏（快捷键 `Ctrl+B` 收起/展开，`Ctrl+N` 新建会话），主聊天区自适应居中舒适阅读（最大宽度 880px），支持 `Enter` 发送、`Shift+Enter` 换行，带来现代化 Web IDE 级体验。
* **移动端原生抽屉设计**：移动端（屏幕宽度 < 768px）自适应转换为滑入式毛玻璃侧边抽屉，底部自适应虚拟键盘高度与 iOS 安全边距，触摸热区 >= 44px。

### 9. 🧠 实时模型切换 (AI Model Switcher)
* **一键无感换模**：支持直接在顶部或快捷卡片中切换底层大模型（包括 Gemini 3.8 Flash、Gemini 3.1 Pro、Claude Sonnet 4.6 Thinking、Claude Opus 4.6 Thinking、GPT-OSS 120B 等）。
* **清晰参数指引**：卡片展示厂商属性、上下文容量（1M/2M/200k）、思考推理级别（High / Thinking）与当前生效状态。

### 10. 📊 实时会话用量与配额监控 (Usage & Quota Dashboard)
* **会话用量估算**：展示当前同步页面的估算对话轮次、Tokens 和数据量，并明确标注估算来源。
* **账户模型组配额**：打开“用量与配额”，查看桌面账户实际返回的模型组、日 / 周 / 5 小时限额、已用与剩余百分比，以及补充（重置）时间和倒计时。组内模型共享额度。
* **真实数据与刷新**：面板打开时每 30 秒更新，也可点击“刷新统计”强制读取。时间按查看设备的时区显示；未提供的周期或数值明确标注，不再展示写死的每日限额和统一重置时间。
* **当前账户周期说明**：当前桌面返回 Gemini、Claude/GPT 两组的每周与 5 小时配额，未提供独立日限额或请求数 / Token 总上限。读取复用桌面已有的配额服务，不提取登录令牌，也不会打开桌面弹窗或抢占发送焦点。

### 11. 🌐 固定自定义域名支持 (Cloudflare Zero Trust Named Tunnel)
* **地址永久不变**：支持绑定 Cloudflare Zero Trust 免费 Token (`CLOUDFLARE_TUNNEL_TOKEN`) 与自定义独立域名 (`CUSTOM_DOMAIN`，如 `https://agent.yourdomain.com`)。
* **免除反复扫码**：告别临时隧道每次重启更换随机域名的痛点，手机可直接添加到桌面 PWA 或浏览器书签，永久无感直达。

### 12. 🛡️ 主动拉起自愈与全天候保活 (Auto-Healing Watchdog & Overnight Keep-Alive)
* **崩溃主动拉起**：守护进程实时监控后台 Node 服务与 Cloudflare 隧道，异常退出或中断时 3 秒内主动自动拉起自愈。
* **Windows 防休眠保活**：调用 Windows 核心电源管理 API (`SetThreadExecutionState`)，防止电脑长时间无操作后夜间休眠或网卡断电。
* **双层防掉线心跳**：25s 原生 WebSocket Ping/Pong 穿透 Cloudflare 100s 空闲切断限制；30s 后台 HTTP 心跳维持路由器与移动基站 NAT 会话活跃。
* **手机解锁即连**：移动端集成 `visibilitychange` 事件流，锁屏解锁或切换回标签页瞬间自动重连并刷新工作区，告别僵尸假死。

### 13. 工作区交互迭代（界面 v4.5）

交互参考 [OpenAI 的 Codex 远程工作指南](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)，结合本项目已有的 Antigravity 控制能力实现。

* **统一搜索与快捷操作**：`Ctrl/Cmd+K` 打开命令面板，按会话标题、项目名或操作名搜索；方向键选择、Enter 打开、Esc 返回。手机可从页头或输入区打开。提示模板添加到现有草稿，由用户发送。
* **分会话草稿与重试记录**：同一标签页中，每个会话单独保存草稿和待确认请求，切换后恢复，并在列表中显示草稿标记。浏览器存储不可用时仍在当前页面内保留；刷新或关闭页面可能丢失这些内存草稿。
* **状态与会话核对**：输入区显示草稿保存、切换、提交、失败和结果待确认。新客户端发送时携带会话 ID，桌面在写入和提交前核对路由，避免把上一会话的消息提交到另一会话；旧快照不会覆盖刚选中的对话。
* **持续可用的导航**：后台刷新保留筛选、项目折叠、列表滚动和键盘焦点；手机关闭的侧栏不会接收焦点。手机页头以两行显示主要操作、会话标题和连接状态，主题和次要操作也可从命令面板找到。

更新后重启服务并刷新页面。草稿保存在当前浏览器标签页中；会话切换及发送结果仍以实际桌面状态为准。

### 14. 桌面主题与内容渲染修复（界面 v4.6）

* **样式隔离**：桌面 CSS 通过浏览器解析后限定在对话区域；全局主题、弹窗、按钮规则不会污染网页自身的界面。主题变量通过独立别名继承，消除循环引用。
* **思考与 Review**：统一折叠栏、操作按钮的边框、间距和悬停反馈；原生折叠区在同一会话同步时保留手动展开状态。
* **Markdown**：正文、强调、链接、列表、引用、表格与代码随主题显示，覆盖来源中的黑色内联文字；宽表格和代码在区域内横向滚动。
* **模型选择**：深浅色卡片、厂商 / 名称搜索、当前模型标记、键盘与焦点管理；桌面确认成功后更新模型名称，失败可重试，切换期间阻止重复请求。

更新后重启服务，并在浏览器强制刷新（Windows：`Ctrl+F5`）。

### 15. Review 与 Markdown 排版（界面 v4.7）

* 根据桌面真实的 `files-changed-header` 和 `md-divider-spacing` / `planner-response-text` 结构适配。Review 使用完整卡片，保留增删行数颜色、独立审查按钮和可键盘展开的文件摘要。
* Markdown 使用自然文档流，统一标题、段落、嵌套列表、引用与表格间距；行内文件图标保持紧凑，不会拉大行高。
* 桌面的嵌套代码行先整理为标准代码块，仅保留一套工具栏；复制保留原有缩进、空行和单行代码。表格与长代码在各自区域内滚动，同步时保留代码区域的焦点与横向滚动位置。
* 客户端插入内容前移除嵌入样式，兼容尚未重启的旧版服务。界面更新后强制刷新即可加载。

---

## 🚀 Quick Start

连接中断与消息发送的本轮修复、生效方式和验证范围见 [稳定性修复说明](RELIABILITY.md)。

> 💡 **Tip:** While we recommend starting Antigravity first, the server is now smart enough to wait and automatically connect whenever Antigravity becomes available!

### Step 1: Launch Antigravity in Debug Mode

Start Antigravity with the remote debugging port enabled:

**Option A: Using Right-Click Context Menu (Recommended)**
- Run `install_context_menu.bat` (Windows) or `./install_context_menu.sh` (Linux) and select **[1] Install**
- Then right-click any project folder → **"Open with Antigravity (Debug)"** (now with visual icons!)

**Option B: Manual Command**
```bash
antigravity . --remote-debugging-port=9000
```

### Step 2: Open or Start a Chat

- In Antigravity, open an **existing chat** from the bottom-right panel, **OR**
- Start a **new chat** by typing a message

> 💡 The server needs an active chat session to capture snapshots. Without this, you'll see "chat container not found" errors.

### Step 3: Run the Server

**Windows:**
```
Double-click start_ag_phone_connect.bat
```

**macOS / Linux:**
```bash
chmod +x start_ag_phone_connect.sh   # First time only
./start_ag_phone_connect.sh
```

The script will:
- **Auto-setup a Python Virtual Environment (`venv`)** (Fixes PEP 668 issues on Arch/Linux)
- Verify Node.js and Python dependencies
- Auto-kill any existing server on port 3000
- **Wait for Antigravity** if it's not started yet
- Display a **QR Code** and your **Link** (e.g., `https://192.168.1.5:3000`)
- Provide numbered steps for easy connection

### Step 4: Connect Your Phone (Local Wi-Fi)

1. Ensure your phone is on the **same Wi-Fi network** as your PC
2. Open your mobile browser and enter the **URL shown in the terminal**
3. If using HTTPS: Accept the self-signed certificate warning on first visit

---

## 🌍 NEW: Global Remote Access (Web Mode)

Access your Antigravity session from **anywhere in the world** (Mobile Data, outside Wi-Fi) with secure passcode protection.

### Step 1: Choose a Tunnel Provider

You can use **ngrok** (requires account), **Cloudflare Tunnel** (requires `cloudflared`), or **Pinggy** (free SSH tunnel, no account/install needed).

#### Option A: ngrok (Default)
1. **Get an ngrok Token**: Sign up for free at [ngrok.com](https://ngrok.com) and get your "Authtoken".
2. **Setup**: Update your `.env` file:
   ```env
   TUNNEL_PROVIDER=ngrok
   NGROK_AUTHTOKEN=your_token_here
   ```

#### Option B: Cloudflare Tunnel (推荐 / Recommended)
1. **安装 cloudflared**：项目内置了 Windows `cloudflared.exe`，其他系统可参考 [Cloudflare 官方指引](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started-guide/local/instance/install-run/) 安装。
2. **选择模式**：
   - **模式 1：开箱即用临时隧道 (无需注册)**
     在 `.env` 中设置：
     ```env
     TUNNEL_PROVIDER=cloudflare
     ```
     启动时将自动分配免费的 `*.trycloudflare.com` 临时公网地址。
   - **模式 2：固定永久独立域名 (推荐，永不变动)**
     通过 Cloudflare Zero Trust 免费为自己的域名分配固定通道：
     1. 登录 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com)。
     2. 依次点击：**Networks** → **Tunnels** → **Create a tunnel** → 选择 **Cloudflared**。
     3. 复制控制台生成的 **Tunnel Token**（一长串 Base64 密钥）。
     4. 在后台 **Public Hostname** 中添加公网域名（例如 `agent.yourdomain.com`，Service 选择 `HTTP` 指向 `localhost:3000`）。
     5. 在项目 `.env` 中填入：
        ```env
        TUNNEL_PROVIDER=cloudflare
        CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...你的Token...
        CUSTOM_DOMAIN=https://agent.yourdomain.com
        ```
     配置完成后，无论重启多少次，外网访问地址永久固定为你的域名，手机添加到书签或主屏幕桌面永不失效！

#### Option C: Pinggy Tunnel
1. **No Install Required**: Pinggy works via SSH and the Python SDK. The launcher will automatically install the `pinggy` pip package.
2. **Setup**: Update your `.env` file:
   ```env
   TUNNEL_PROVIDER=pinggy
   ```
   *(Optional)* You can add `PINGGY_TOKEN=your-token` for a persistent subdomain if you have a Pinggy account.

### Step 2: Configuration
1. **Automatic Configuration**: Simply run any launcher script. They will detect if `.env` is missing and automatically create it using `.env.example` as a template.
2. **Manual Setup**: Alternatively, copy `.env.example` to `.env` manually and update the values:
   ```bash
   copy .env.example .env   # Windows
   cp .env.example .env     # Mac/Linux
   ```
   Ensure you set a secure password:
   ```env
   APP_PASSWORD=your_secure_passcode
   ```

### Usage
- **Windows**: Run `start_ag_phone_connect_web.bat`
- **Mac/Linux**: Run `./start_ag_phone_connect_web.sh`

The script will launch the server and provide a **Public URL** (e.g., `https://abcd-123.ngrok-free.app`). 

**Two Ways to Connect:**
1. **Magic Link (Easiest)**: Scan the **Magic QR Code** displayed in the terminal. It logs you in automatically!
2. **Manual**: 
   - Open the URL on your phone.
   - Enter your `APP_PASSWORD` to log in.

> 💡 **Tip:** Devices on the same local Wi-Fi still enjoy direct access without needing a password.

---

## 🔒 Enabling HTTPS (Recommended)

For a secure connection without the browser warning icon:

### Option 1: Command Line
```bash
node generate_ssl.js
```
- Uses **OpenSSL** if available (includes your IP in certificate)
- Falls back to **Node.js crypto** if OpenSSL not found
- Creates certificates in `./certs/` directory

### Option 2: Web UI
1. Start the server on HTTP
2. Look for the yellow **"⚠️ Not Secure"** banner
3. Click **"Enable HTTPS"** button
4. Restart the server when prompted

### After Generating:
1. **Restart the server** - it will automatically detect and use HTTPS.
2. **On your phone's first visit**:
   - You'll see a security warning (normal for self-signed certs).
   - Tap **"Advanced"** → **"Proceed to site"**.
   - The warning won't appear again!

---

### macOS: Adding Right-Click "Quick Action" (Optional)

Since macOS requires Automator for context menu entries, follow these steps manually:

1.  Open **Automator** (Spotlight → type "Automator").
2.  Click **File → New** and select **Quick Action**.
3.  At the top, set:
    - "Workflow receives current" → **folders**
    - "in" → **Finder**
4.  In the left sidebar, search for **"Run Shell Script"** and drag it to the right pane.
5.  Set "Shell" to `/bin/zsh` and "Pass input" to **as arguments**.
6.  Paste this script:
    ```bash
    cd "$1"
    antigravity . --remote-debugging-port=9000
    ```
7.  **Save** the Quick Action with a name like `Open with Antigravity (Debug)`.
8.  Now you can right-click any folder in Finder → **Quick Actions → Open with Antigravity (Debug)**.

---

## 🏗️ Architecture Infographic

![Repo Infographic](./assets/repo_infographic.png)

---

## 🛡️ Shielding & Account Safety

This tool is designed with a **"Local-First"** security model. 

- **Bridge Mechanism**: It uses the **Chrome DevTools Protocol (CDP)** to mirror the UI of your *already-running* desktop session. It **never** extracts OAuth tokens or interacts with Google/AI-provider APIs directly.
- **Natural Traffic**: All AI requests are still sent by your official desktop application. To the AI provider, your usage looks identical to normal desktop activity.
- **Zero Bans**: There have been **no reports** of account flags or bans. This is a "Wireless Viewport," not a third-party client that bypasses official security.

---

## ✨ Features

- **🧹 Clean Mobile View (NEW!)**: Automatically filters out redundant Desktop-specific input areas using an aggressive "Nuclear Cleanup" strategy. It targets the main desktop chat box and fixed overlays while carefully **preserving** actionable items like "Review Changes" and permission bars.
- **Glassmorphism UI (NEW!)**: Sleek and modern quick-action and settings menus featuring a beautiful glassmorphism effect for enhanced mobile usability. Includes customizable, ready-to-use prompt pills (like "Explain this code", "Continue", and "Fix Bugs").
- **🌙 Improved Dark Mode (NEW!)**: Enhanced UI styling and state capture designed to provide maximum clarity and correct model detection in dark mode.
- **🧠 Latest AI Models**: Automatically updated support for the latest model versions from Gemini, Claude, and OpenAI.
- **💖 Support the Developer (NEW!)**: A dedicated heart icon in the mobile header allows users to support the project and the developer with a single tap, opening a premium support modal.
- **📜 Premium Chat History (NEW!)**: Full-screen history management with a completely redesigned, sleek card-based UI. Features modern loading states, gorgeous gradients, and intelligent strictly-scoped scraping to safely extract past conversations without background noise. Dismissing the history view automatically triggers a remote Escape sequence on the desktop to keep your workspace clean.
- **➕ One-Tap New Chat (NEW!)**: Start a fresh conversation instantly from your phone without needing to touch your desktop.
- **🖼️ Context Menu Icons (NEW!)**: Visual icons in the right-click menu for better navigation.
- **🌍 Global Web Access**: Secure remote access via ngrok tunnel. Access your AI from mobile data with passcode protection.
- **🛡️ Auto-Cleanup**: Launchers now automatically sweep away "ghost" processes from previous sessions for a clean start every time.
- **🔒 HTTPS Support**: Secure connections with self-signed SSL certificates.
- **Local Image Support**: Local images and SVGs (`vscode-file://` paths) in the desktop chat are automatically converted to Base64 so they render perfectly on mobile without exposing local files.
- **Real-Time Mirroring**: 1-second polling interval for near-instant sync.
- **Remote Control**: Send messages, stop generations, and switch Modes (Fast/Planning) or Models (Gemini/Claude/GPT) directly from your phone.
- **Scroll Sync**: When you scroll on your phone, the desktop Antigravity scrolls too!
- **🎯 Precision Remote Control (NEW!)**: A deterministic targeting layer that prevents "Sync-Fighting". It uses leaf-node filtering to ensure clicks land exactly on buttons, even when nested inside complex DOM structures.
- **Occurrence Index Tracking**: Robustly handles multiple identical elements (like three "Run" buttons in history) by tracking the specific tapped instance.
- **Thought & Status Expansion (NEW!)**: Tap on "Thinking...", "Thought", "Worked for", "Edited", or "X files" blocks on your phone to remotely expand/collapse them with intelligent text matching.
- **Remote Action Support (NEW!)**: Direct support for "Allow", "Deny", "Allow Once", "Review Changes", "Apply", and "Save" buttons. No more walking back to your desk for simple permissions.
- **Smart Sync**: Bi-directional synchronization ensures your phone always shows the current Model and Mode selected on your desktop.
- **Premium Mobile UI**: A sleek, dark-themed interface optimized for touch interaction.
- **Context Menu Management**: Dedicated scripts to **Install, Remove, Restart, or Backup** your Right-Click integrations.
- **Health Monitoring**: Built-in `/health` endpoint for server status checks.
- **Graceful Shutdown**: Clean exit on Ctrl+C, closing all connections properly.
- **Python Virtual Environment (`venv`) Support**: Launcher scripts now automatically create and use a local `venv` (approx. 25-30MB). This ensures compatibility with modern Linux distributions (Arch, Debian 12+) that enforce PEP 668 (externally-managed-environment) and prevents package conflicts on Windows/macOS.
- **Zero-Config**: The launch scripts handle the heavy lifting of environment setup.

---

## 📂 Documentation

For more technical details, check out:
- [**Code Documentation**](CODE_DOCUMENTATION.md) - Architecture, Data Flow, and API.
- [**Security Guide**](SECURITY.md) - HTTPS setup, certificate warnings, and security model.
- [**Design Philosophy**](DESIGN_PHILOSOPHY.md) - Why it was built this way.
- [**Contributing**](CONTRIBUTING.md) - Guidelines for developers.

---

## License

Licensed under the [GNU GPL v3](LICENSE).  
Copyright (C) 2026 **Krishna Kanth B** (@krishnakanthb13)

---

## Star History

<a href="https://www.star-history.com/#krishnakanthb13/antigravity_phone_chat&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=krishnakanthb13/antigravity_phone_chat&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=krishnakanthb13/antigravity_phone_chat&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=krishnakanthb13/antigravity_phone_chat&type=date&legend=top-left" />
 </picture>
</a>

---
