# 桌面构建与发布

本机和 GitHub Actions 共用 `scripts/package.mjs` 与 `electron-builder.yml`。Actions 只有 `workflow_dispatch` 手动入口；push、PR、合并 main、推送 Tag 均不会触发。默认只构建，不创建 Release，不上传安装包到其他服务。

## 工具链与版本

- `.node-version` 固定 Node.js **26.12.0**；`packageManager` 固定 pnpm **12.14.0**，与本次验证的本机工具链一致。
- 使用 `pnpm install --frozen-lockfile`，不要在 CI 重新解析依赖。pnpm 锁文件同时记录包管理器和应用依赖。
- 应用版本唯一来源为根 `package.json.version`。支持 `X.Y.Z` 及 `X.Y.Z-alpha.N` / `beta.N` / `rc.N`。
- Electron 和 electron-builder 由锁文件固定；本次不升级 Electron 35。公开稳定版之前，应单独完成受支持 Electron 版本的升级和三端兼容性验证。
- 安装包内 `build-info.json` 记录版本、完整 commit、工作区状态、实际工具链和构建时间。外部 `build-info-<target>.json` 另记录签名校验结果和产物哈希。
- 固定来源与工具链用于可追溯重建；签名时间戳、Runner 镜像更新等因素意味着不保证逐字节可重现。

## 本机按固定版本构建

安装 `.node-version` 指定的 Node 和 `packageManager` 指定的 pnpm 后：

```sh
pnpm install --frozen-lockfile
pnpm run pack                    # 当前平台应用目录；注意必须包含 run
pnpm run test:desktop            # 启动打包后的应用并通过 IPC 扫描临时项目
pnpm run dist                    # 当前平台、当前架构安装包
pnpm run dist -- --arch arm64    # macOS 可显式选择 arm64 或 x64
```

`pnpm pack` 是 pnpm 自带的 npm tarball 命令，不是桌面打包，请用 `pnpm run pack`。本机始终 `publish: never`，即使环境中存在 GitHub Token 也不会发布。

需要重建历史版本时，在独立 worktree 检出包含这套构建脚本的 Tag。例如以下命令中的 `v0.2.0` 是示例，需替换为真实存在的 Tag：

```sh
git worktree add --detach ../agent-lens-v0.2.0 v0.2.0
cd ../agent-lens-v0.2.0
pnpm install --frozen-lockfile
pnpm run dist
```

允许本机未提交修改的调试构建，但会标记 `dirty: true`，发布清单汇总会拒绝这类产物。输出在 `release/<version>/<target>/`；每次重建清理当前目标的输出，其他目标不受影响。同一 checkout 的构建共享暂存目录，不要并发运行两个本机打包命令。

桌面 JS 依赖由 esbuild 打进主进程 bundle；打包前生成最小 `dist/package`，不携带 Fastify 服务、开发工具和整个 node_modules。将来引入原生模块或运行时动态加载的外部资源时，需要同步调整打包文件与依赖重建策略。

## 手动运行 Actions

先将工作流提交到仓库默认分支，GitHub 才会显示手动运行入口。进入 **Actions → Desktop build and release → Run workflow**。

| 输入 | 默认 | 含义 |
| --- | --- | --- |
| `ref` | `main` | 构建源码的 branch、Tag 或完整 commit；所有任务锁定为同一 SHA |
| `platforms` | `all` | `all`、`mac-arm64`、`mac-x64`、`win-x64`、`linux-x64` |
| `publish` | `false` | 是否将验证完成的完整产物发布至 GitHub Releases |
| `prerelease` | `true` | 发布为预发布；仅构建时忽略 |

GitHub 的 “Use workflow from” 选择工作流本身的版本；上面的 `ref` 选择应用源码。通常让工作流使用 main，再通过 `ref` 指定源码。目标源码必须包含这套脚本、配置和工具链文件。

| 目标 | Runner | 安装包 |
| --- | --- | --- |
| mac-arm64 | macos-15 | DMG、ZIP |
| mac-x64 | macos-15-intel | DMG、ZIP |
| win-x64 | windows-2022 | NSIS EXE |
| linux-x64 | ubuntu-22.04 | AppImage、DEB |

流程为：解析来源 → 各目标单元测试与发布规则测试 → 编译打包 → 桌面启动/IPC 验证 → Linux Web E2E → 汇总完整性、来源和 SHA-256 → 保存 `release-bundle`。Linux 桌面测试通过 Xvfb 运行。

只构建时，从运行页 Artifacts 下载 `release-bundle`，保留 14 天。它包含所选目标的安装包、各目标构建信息、`SHA256SUMS` 和 `release-manifest.json`。构建清单的下载 URL 为 null，不指向尚不存在的 Release。

## 显式发布

1. 更新 `package.json.version`，提交并推送所有发布代码。
2. 为该提交创建、推送同名 Tag，例如版本 `0.2.0-beta.1` 对应 `v0.2.0-beta.1`。推送 Tag 不会触发工作流。
3. 手动运行，`ref` 填该 Tag，`platforms=all`，显式勾选 `publish`。早期验证保持 `prerelease=true`。
4. 所有构建和测试通过后，发布任务创建 Draft Release，上传文件，下载远端资产复核哈希，再公开为 Release。

发布必须使用与 package 版本一致且已存在于远端的 Tag，拒绝分支、任意 SHA、缺失平台或脏工作区。发布前会再次核对远端 Tag，避免构建期间移动 Tag。只有最终发布任务拥有 `contents: write`，使用同仓库内置 `GITHUB_TOKEN`，不需要 PAT。

预发布允许 Windows 未签名、macOS ad-hoc 签名，Release 说明会列出未经分发签名验证的目标。这类包用于早期测试，不能提供正式签名包的安装体验。正式版本 `prerelease=false` 要求 macOS 分发签名、公证及 staple 验证通过，Windows 应用和安装器 Authenticode 验证通过；预发布版本号不能标记为 stable。

同一 ref 的运行串行。上传失败时保留草稿，不公开半成品。对相同 Tag、相同来源重跑可重建并替换本流程的草稿资产；已公开 Release 一律拒绝覆盖，修复请增加版本号。不要手动公开失败流程留下的草稿。稳定版使用 GitHub 的版本排序选择 latest，预发布不推进 latest。

## 签名凭据

以下是仓库 **Settings → Secrets and variables → Actions** 中的 Secret 名称。只有显式发布的打包步骤接收它们；仅构建时使用 ad-hoc / unsigned 模式。

| 目标 | Secrets |
| --- | --- |
| macOS | `MAC_CSC_LINK`（P12 base64）、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK`（CI 可用的 PFX base64）、`WIN_CSC_KEY_PASSWORD` |

macOS 使用 Developer ID Application 证书。Windows 当前入口支持可在 CI 使用的 PFX；若证书提供商要求硬件或云签名，应在打包配置中接入其签名服务，不能把不可导出的私钥当成 PFX 使用。签名凭据缺失或验证失败时正式版构建失败，不会降级。预发布中一旦提供对应证书，也会执行并验证签名；配置不完整同样失败。

本机需要签名时，设置 `AGENT_LENS_SIGN=true` 并提供相应 electron-builder 环境变量。macOS 本机变量名为 `CSC_LINK` / `CSC_KEY_PASSWORD`，其余同上。此开关只控制签名，仍不发布。

## 下载与后续渠道

文件命名为 `Agent-Lens-<version>-<platform>-<arch>.<ext>`。`release-manifest.json` 包含版本、渠道、commit、平台、架构、文件大小、SHA-256、固定版本 GitHub 下载 URL 和预留的 `mirrors`。后续官网或对象存储可消费清单；本批不建设官网，也不接入应用内自动更新。

私有仓库的 Release 仍是私有的，公开下载需另行配置公开分发仓库或托管。当前发布只面向运行工作流的同一个仓库。

校验从 Actions 或 Release 下载的完整目录：

```sh
# 默认读取 release/artifacts；也可通过 RELEASE_DIRECTORY 指定已解压目录
pnpm run release:verify
```

## 验证与首发验收

```sh
pnpm test
pnpm test:release
pnpm run dist
pnpm test:desktop
pnpm exec playwright install chromium
pnpm test:e2e
```

发布规则测试覆盖手动触发、默认不发布、Tag/版本/目标约束、篡改文件、缺失目标、脏工作区和签名门禁。自动桌面测试验证打包后的可执行文件、页面渲染和 IPC 扫描；它不等同于真实安装/卸载测试。首发需在各目标机器检查安装、启动、目录选择、升级覆盖和卸载，以及 Linux AppImage 的 FUSE / 系统兼容性。

参考：[GitHub 手动工作流](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)、[electron-builder 发布配置](https://www.electron.build/v26/docs/publish/)、[签名](https://www.electron.build/v26/docs/features/code-signing/)。
