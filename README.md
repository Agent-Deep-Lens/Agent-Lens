# Agent Lens

Agent 配置与能力工作台，用于查看 Agent 配置的各项功能，并逐步支持管理。当前版本提供只读浏览。采用接近 Codex 的三栏桌面布局，同时查看 Claude Code 与 Codex 的 Skills、Plugins、MCP 和自定义子 Agent。

## 启动

使用 `.node-version` 指定的 Node.js 26.12.0 和 `packageManager` 指定的 pnpm 12.14.0。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问 http://127.0.0.1:4317。Web 版本包含本地服务，不是可直接部署到静态托管服务的网站。

```sh
pnpm build
pnpm start       # 生产模式 Web
pnpm desktop     # 本地 Electron 桌面窗口
pnpm run pack    # 生成当前平台应用目录（pnpm pack 是 npm tarball 命令）
pnpm run dist    # 生成当前平台分发包，不上传
pnpm test:desktop # 验证打包后的桌面应用及 IPC
```

默认端口为 4317，可用 `PORT` 环境变量修改。桌面版通过 IPC 访问扫描服务，不额外开放 HTTP 端口。本机构建默认使用 macOS ad-hoc 签名或 Windows 未签名模式。

GitHub Actions **仅手动触发**，默认只构建，显式开启 `publish` 才发布 Release。支持 macOS arm64/x64、Windows x64、Linux x64；产物附带版本来源、发布清单和 SHA-256。正式发布要求 macOS 签名与公证、Windows 签名。操作步骤、固定版本构建和 Secrets 见 [构建与发布文档](docs/releases.md)。

## 已实现

- 启动自动扫描两种 Agent；选择项目后同时汇总全局与项目能力。
- Skills、Plugins、MCP、自定义子 Agent 四类列表，名称和描述搜索、Agent / 来源 / 状态筛选。
- Skills 按所属插件、项目目录、全局独立技能和系统内置分组；插件默认折叠，支持全部展开/折叠，搜索自动展开匹配组。
- 插件组件下钻、指令内容与脱敏配置预览、来源路径、复制路径。
- 共享真实文件合并，保留每个 Agent 的独立绑定；同名不同文件不合并。
- Web 文件夹浏览器、桌面原生目录选择、最近项目、浅色 / 深色外观。
- 首次打开、切换项目、重新激活时扫描，保留手动刷新、错误隔离、键盘搜索及列表方向键。
- 仅本地读取，不启动 MCP、执行技能脚本或修改 Agent 配置。

## 发现范围

| Agent | 来源 |
| --- | --- |
| Claude Code | `~/.claude/skills`、`commands`、`agents`；`~/.claude.json` 中的 MCP；插件安装记录和启用配置 |
| Claude Code 项目 | `.claude/skills`、`commands`、`agents`、项目 settings、`.mcp.json`、项目关联插件安装记录、本地插件源码 |
| Codex | `~/.agents/skills`、`~/.codex/skills`（兼容目录）、`~/.codex/agents`、`config.toml` 中的 MCP 和旧式角色声明、插件缓存与启用配置 |
| Codex 项目 | `.agents/skills`、`.codex/agents`、`.codex/config.toml`、本地插件源码 |

识别 `CODEX_HOME` 与 `CLAUDE_CONFIG_DIR`。扫描仓库祖先定义；嵌套项目扫描最多 8 层、3,000 个目录，排除依赖与构建目录，不递归跟随目录符号链接。

插件读取原生清单，以及 Codex 可移植根目录清单。支持常见的技能自定义路径、MCP 文件/内联配置和子 Agent 定义。复制到项目的文件没有可靠安装记录时，不推测它是自写还是第三方安装。

### 状态含义与当前边界

- **可发现**：标准目录或明确启用配置中的资源，不代表运行会话已经加载。
- **有条件**：项目信任、嵌套目录适用范围或本地插件源码等需要宿主进一步决定。
- **待确认**：有缓存但未确认安装状态、缓存版本存在歧义或缺少启用证据。
- **已禁用 / 被覆盖 / 配置异常**：展示已识别的配置规则及理由。

这是静态清单工具，不是宿主运行时的完全复刻。暂不枚举云端插件、运行中临时子 Agent、内置角色目录、MCP 实时 tools 和组织管理策略。部分较新的插件 manifest 字段尚不解析。项目信任与配置覆盖只实现已明确识别的规则；不确定状态保留提示，不保证所有宿主版本一致。当前来源展示区分独立定义与插件提供，不对复制文件的作者或安装来源作推断。

不监听文件变化，也不进行后台轮询。窗口从后台恢复或浏览器标签重新激活时扫描一次；同一上下文正在进行的扫描会合并，持续在前台使用不会反复扫描。第一版没有跨项目持久扫描缓存，切换项目重新读取本地文件。

## 代码结构

```text
apps/web/                 React 界面与 HTTP / IPC 客户端
apps/desktop/             Electron 主进程与受限 preload
packages/contracts/       资源、绑定、快照、接口类型
packages/core/            解析工具、扫描编排、按需扫描服务
packages/adapters/        Claude / Codex 发现与状态规则
packages/local-server/    回环地址 HTTP API
```

增加宿主时实现 `AgentAdapter` 并注册到 `packages/adapters/index.ts`；目前 Agent ID 联合类型需要同步扩展。适配器分别扫描，单个适配器失败不会中止另一种 Agent 的结果。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm test:release
pnpm build
# 可选：安装浏览器后运行浏览器回归
pnpm exec playwright install chromium
pnpm test:e2e
```

测试覆盖混合项目、符号链接共享、插件禁用与项目隔离、嵌套范围、配置错误隔离、凭据脱敏、本地接口鉴权、扫描合并和激活触发。

## 本地访问保护

Web 服务仅监听 `127.0.0.1`，校验 Host、Origin 与会话令牌。Electron 使用上下文隔离、沙箱和受限 IPC。配置在返回 UI 前脱敏，不保存包含凭据的扫描快照。Markdown 不执行 HTML，也不加载外部图片。

配置适配参考：[Claude Skills](https://code.claude.com/docs/en/skills)、[Claude Plugins](https://code.claude.com/docs/en/plugins-reference)、[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Codex Configuration](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 品牌

应用名为 **Agent Lens**，定位为 Agent 配置与能力工作台。Logo 采用直角取景框与配置条目，浅绿框角代表聚焦与发现；采用深灰、暖白与浅绿。图形按 32px 网格对齐，背景铺满画布，由界面容器统一裁切边角，避免双层圆角造成边缘留白。

- 矢量 Logo：`apps/web/public/agent-lens.svg`（同时用作网页图标）
- PNG 图标：`build/icon.png`（1024 × 1024）
- macOS 图标：`build/icon.icns`
- 应用沿用原有 appId，以保持桌面安装身份连续；源码目录名无需变更。
