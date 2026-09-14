# Fork 维护说明（DSH Desktop 社区 Fork）

这个目录只属于本 fork，上游不会改动它，因此不会与上游合并产生冲突。

本 fork 在上游 `anywhere-labs/dsh-desktop` 基础上只做两件产品性改动：

1. **打入 PR #946 的修复** —— opencode-go 渠道缺失 `x-opencode-session` 头导致 400。
2. **把应用内「检查更新」指向本 fork 的 Release**（可选，见第 3 节）。

---

## 1. 创建 fork 并推入改动

```bash
# 用 GitHub CLI（需已 gh auth login）
gh repo fork anywhere-labs/dsh-desktop --clone=false

# 或者网页点 Fork，然后：
git clone https://github.com/<你的账号>/dsh-desktop.git
cd dsh-desktop
git remote add upstream https://github.com/anywhere-labs/dsh-desktop.git
```

把已经准备好的改动提交上去（当前工作区已完成）：

```bash
git checkout -b fork/opencode-go-session-header
git add package.json yarn.lock patches/dsh-llm-pi-ai@0.1.5-rc.2.patch \
        .github/workflows/fork-release.yml .github/workflows/sync-upstream.yml fork/
git commit -m "fix(opencode-go): send x-opencode-session header (port of upstream PR #946)"
git push -u origin fork/opencode-go-session-header
```

### 关于 PR #946：为什么不能直接 cherry-pick

上游 PR #946 目前是 **open 且不可合并**（GitHub 报 `mergeable_state: dirty`）。原因是它写于运行时还是 `0.1.5-rc.1` 的时候，而当前 master 已经升到 `0.1.5-rc.2`，`vendor/dsh-runtime/0.1.5-rc.1/` 目录已不存在。

所以本 fork 的做法是**移植**，而不是应用原 PR：

| 项目 | 原 PR #946 | 本 fork |
| --- | --- | --- |
| 补丁文件 | `patches/dsh-llm-pi-ai@0.1.5-rc.1.patch` | `patches/dsh-llm-pi-ai@0.1.5-rc.2.patch` |
| resolutions | `...rc.1.tgz` 两条 | `...rc.2.tgz` 两条，改为 `patch:` 协议 |
| `yarn.lock` | **未包含**（作者环境拉不到 yarn） | 已用 `yarn@4.18.0` 重新生成 |
| 补丁正文 | 17 行新增 + 1 行改写 | 完全相同，逐字符一致 |

好消息是补丁正文**无需修改**：`lib/index.js` 中 `requestHeaders()` 与调用点的上下文在 rc.2 里完全匹配（`git apply --check` 干净通过）。

> ⚠️ `yarn.lock` 里 `patch:` 条目的 `hash=` 是 Yarn 内部计算值，**无法手写**。任何改动 `patch:` resolution 的操作之后都必须跑一次 `corepack yarn install` 重新生成锁文件，否则 CI 的 `--immutable` 会失败。

---

## 2. 用 GitHub Actions 编译（不需要本地环境）

用 `fork-release.yml`，它在 **GitHub 托管的 runner** 上构建并发布到本 fork 的 Release：

**Actions → Fork Release → Run workflow**，填入版本号（必须等于 `dsh-plugin-desktop/package.json` 的 `version`），或直接推送 tag：

```bash
git tag v2.0.10 && git push origin v2.0.10
```

产出：

| 平台 | 产物 | 签名 |
| --- | --- | --- |
| Windows x64 | `DSH-Desktop-windows-x64-Setup.exe`（NSIS）、`DSH-Desktop-windows-x64-Portable.zip` | 未签名 |
| macOS universal | `DSH-Desktop-mac-universal.dmg` | 未签名 |

这样是**可行**的，因为仓库本身就把「未签名构建」和「签名发布」分开了：`scripts/package-win.ts` 明确清掉所有签名环境变量后产出未签名 NSIS，`scripts/package-mac.ts`（`dist:mac-smoke`）产出 `notarize=false` 的通用 DMG。上游 CI 也正是这么跑的，本工作流直接复用了同样的步骤。

需要注意的现实差异：

- **macOS 签名/公证做不到**（除非你有自己的 Apple Developer ID 证书）。上游把签名发布放在「有凭据的机器上手工执行」，从不进 CI。没有证书时只能出未签名 DMG，用户首次打开需要右键「打开」或 `xattr -cr`。
- **Windows 未签名**会有 SmartScreen 警告，点「仍要运行」即可。要消除就得自己买代码签名证书，并把 `CSC_LINK`/`CSC_KEY_PASSWORD` 放进 Secrets。
- 上游 CI **不保留构建产物**（没有 `upload-artifact`），所以产不出可下载的东西；本工作流用 `gh release create/upload` 直接把产物挂到 Release，避免猜测 `upload-artifact` 的版本号。

---

## 3. 让「检查更新」指向本 fork 的 Release

**这是代码改动，不是配置项。** 更新地址是写死的字符串常量，在 `dsh-plugin-desktop` 和 `dsh-plugin-desktop-beta` 两个 workspace 里各有一份：

| 常量 | 位置 | 上游值 |
| --- | --- | --- |
| `DESKTOP_VERSION_ENDPOINT` | `src/update-checker.ts` | `https://www.dshdesktop.cn/api/desktop/version` |
| `DESKTOP_DOWNLOAD_URLS.darwin` | `src/update-download.ts` | `https://www.dshdesktop.cn/api/downloads/mac` |
| `DESKTOP_DOWNLOAD_URLS.win32` | `src/update-download.ts` | `https://www.dshdesktop.cn/api/downloads/windows` |

改这 6 处用脚本完成（可重复执行、失败即中止、不会改一半）：

```bash
node fork/repoint-updates.mjs --repo <你的账号>/dsh-desktop
node fork/repoint-updates.mjs --restore     # 想改回上游时
node fork/repoint-updates.mjs --feed-only   # 只刷新版本号文件
```

脚本会同时生成 `fork/update-feed/stable.json` 与 `beta.json`，内容是：

```json
{ "version": "2.0.10", "channel": "stable" }
```

### 为什么不能直接用 GitHub Release API

应用内的检查器（`src/update-checker.ts`）不是 electron-updater，它要求一个**返回固定 JSON 形状**的地址：字段必须是 `version`（严格 SemVer）与 `channel`，请求带 `redirect: 'error'`，响应上限 4 KiB。GitHub 的 Releases API 形状完全不同，会直接被判为失败。所以需要一个直接返回 200 的 JSON（`raw.githubusercontent.com` 可以），再加上一个能返回安装包本体的地址。

安装包地址用 `https://github.com/<账号>/<repo>/releases/latest/download/<固定资产名>` 即可 —— 下载侧是 `redirect: 'follow'`，能跟到 302 后的真实资产；而且下载后只做**魔数校验**（`.exe` 查 PE 头、`.dmg` 查尾部 DMG trailer），没有签名或哈希校验，所以自建包能通过。

### 三个可行选择

| 方案 | 效果 |
| --- | --- |
| 什么都不做 | 应用会提示并下载**上游官方安装包**，覆盖掉你打了补丁的版本 |
| 关掉检查（把 `updates` 插件的 `enabled` 设为 `false`） | 不会被覆盖，但也没有更新 |
| 指向本 fork（本节做法） | 正常自我更新，走你自己的 Release |

> 如果在中国大陆网络下 `raw.githubusercontent.com` 不可达，把 `--version-url` 换成任何你能控制的 HTTPS 静态地址（对象存储、自己的服务器）即可，代码改动完全一样。检查失败时应用只是显示「检查更新失败」，不会崩溃。

### 版本号约定

应用比较的是 `dsh-plugin-desktop/package.json` 的 `version`（测试中是 `2.0.10`），**不是** `@deepseek-ai/dsh` 的版本。所以要发布新版本时：

1. 改 `dsh-plugin-desktop/package.json` 的 `version`（stable 通道**不能带 prerelease 后缀**；beta 必须是 `X.Y.Z-beta.N`）。
2. `node fork/repoint-updates.mjs --feed-only` 刷新 `fork/update-feed/*.json`。
3. 提交，然后按第 2 节发 Release。

---

## 4. 自动拉取上游更新

`sync-upstream.yml` 每天 03:00 UTC 把 `upstream/master` **合并**进本 fork 的 `master`。

注意：因为 fork 上多了补丁提交，分支一定是 diverged 的，**GitHub 网页上的 "Sync fork" 按钮只能快进、用不了**，必须走真正的 merge，这就是该工作流存在的原因。

### 两个必须知道的坑

1. **工作流文件需要 PAT。** 默认的 `GITHUB_TOKEN` 没有 `workflows` 权限，如果上游改动了 `.github/workflows/ci.yml`，push 会被拒绝。设置 Secrets → `UPSTREAM_SYNC_TOKEN`（fine-grained PAT，勾选 Contents: write + Workflows: write）即可。
2. **上游升运行时会静默丢掉补丁。** 上游 `upstream.json` 的 `runtimePackageVersion` 一旦从 `0.1.5-rc.2` 变成新版本，`patches/dsh-llm-pi-ai@0.1.5-rc.2.patch` 就不再被引用，修复**悄悄消失**，而所有常规检查仍然通过。工作流因此在 push 之前先跑 `fork/verify-patch-retained.mjs`，它会：

   - 断言补丁文件名与当前运行时版本一致；
   - 断言两条 resolution 仍是 `patch:` 且指向该补丁；
   - 把补丁拿去对**实际 vendored tarball** 做 `git apply --check`。

   任何一条不过就中止推送、开一个 issue 并给出重新移植的步骤，fork 保持原样。

### 合并冲突

上游若改了 `package.json` resolutions 的相邻行，merge 会冲突，工作流会 `merge --abort` 并报错退出，不会留下半个合并。按提示本地解决后重跑即可。

---

## 5. 本地校验命令

```bash
node fork/verify-patch-retained.mjs              # 补丁是否仍然生效
node scripts/sync-vendored-runtime.mjs --check --channel stable
node scripts/sync-vendored-runtime.mjs --check --channel beta
corepack yarn install --immutable                # 锁文件是否与 package.json 一致
```

`check:vendored-runtime` 是仓库自带的门禁，也是验证 `patch:` resolution 字符串逐字符正确的

权威检查 —— 本 fork 的两个 channel 都已通过。
