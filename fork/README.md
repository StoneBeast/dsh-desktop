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

`sync-upstream.yml` 每天 03:00 UTC（北京 11:00）把 `upstream/master` **合并**进本 fork 的 `master`，并自动修复 fork 自己的那两处改动（补丁接线、更新源 URL）。

注意：因为 fork 上多了补丁提交，分支一定是 diverged 的，**GitHub 网页上的 "Sync fork" 按钮只能快进、用不了**，必须走真正的 merge。

两件必须知道的：

1. **工作流文件需要 PAT。** 默认 `GITHUB_TOKEN` 没有 `workflows` 权限，上游一旦改动 `.github/workflows/` 下的文件，push 会被拒绝。设置见第 7 节。
2. **上游升运行时会动到 patch 接线，这一步是自动的。** 上游 `upstream.json` 的 `runtimePackageVersion` 变化后，`patches/dsh-llm-pi-ai@<旧>.patch` 就不再被引用。`fork/sync-upstream.mjs` 会把补丁改名到新版本并对着实际 tarball 验证；若上游自己修好了这个 bug，它会直接删掉补丁而不是重复修。只有补丁**真的无法应用**时才停下来交给人工（见第 8 节的表格）。

合并冲突也不再需要人工：上游每次发布都会重写 `package.json` 里补丁所在的那几行，脚本会逐文件检查「fork 侧相对 merge base 是否只动了 fork 自己的值」，成立才自动取上游版本并重新接线，不成立就中止并开 issue。

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

---

## 6. 已知问题：上游 CI 在 master 上是红的（与本 fork 无关）

本 fork 的基提交是 `d61b6f9`，而**上游自己的 CI 在这个提交上就是失败的**：

```
2026-09-14T02:35:44Z | push | failure | d61b6f96 | Merge pull request #975
2026-09-13T21:28:43Z | push | success | 697e7d78 | Merge pull request #973
```

原因在 `changes` job 的 bilingual 文档门禁，与代码无关：

```
README.i18n.yaml is stale for README.md: expected ebded1c7..., recorded 6da97144...
```

上游 PR #975 改了中文 `README.md`，但没有同步 `README.en.md`，也没有按仓库约定重新登记哈希。可以自己确认：

| 文件 | 实际 blob 哈希 | `README.i18n.yaml` 记录 | 结果 |
| --- | --- | --- | --- |
| `README.en.md` | `8f8bce95…` | `8f8bce95…` | 一致 |
| `README.md` | `ebded1c7…` | `6da97144…` | **不一致** |

这是这个门禁在正常发挥作用 —— 它抓到了真实的翻译不同步。所以**不要**用重新登记哈希的方式把它糊过去，那等于关掉门禁并掩盖上游未翻译的内容。

两个实际影响：

1. `changes` job 失败会让 `check`、`desktop-windows`、`desktop-macos` 全部 **skipped**，所以上游 CI 目前在 fork 上不提供任何产品校验。
2. 但这不影响你的构建 —— `fork-release.yml` 自己会跑 `check:win-package` 与 `check:mac-package`，这两个才是真正的产品门禁（build、typecheck、打包与运行时闭包测试）。

处理建议：**保持 `ci.yml` 与上游一致、不要改它**（改了以后每次同步都要冲突）。等上游修好 README，下一次同步就会把修复带过来，CI 自动转绿。若觉得红叉吵，可以在 fork 的 Actions 页面手动 disable 这个 workflow，不需要改文件。

## 7. 同步用的 PAT（`UPSTREAM_SYNC_TOKEN`）

`sync-upstream.yml` 默认使用 `GITHUB_TOKEN`，它**没有 `workflows` 权限**。上游只要改动了 `.github/workflows/` 下的任何文件，合并后的 push 就会被拒绝（工作流会打印出这条原因，不会留下半个合并）。

**「创建了一个 PAT」和「把它存成仓库 secret」是两件事，两个都要做。**

1. 建 fine-grained PAT：GitHub → 右上头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token。
   - **Resource owner** 选你自己的账号
   - **Repository access** → Only select repositories → 勾 `dsh-desktop`
   - **Permissions → Repository permissions**：`Contents` = **Read and write**，`Workflows` = **Read and write**（这一项是必须的，它在列表靠下的位置）
2. 存进仓库：`github.com/StoneBeast/dsh-desktop` → **Settings** → 左侧 **Secrets and variables** → **Actions** → **New repository secret**
   - Name 必须**逐字符**是 `UPSTREAM_SYNC_TOKEN`
   - Secret 填第 1 步生成的 token（`github_pat_` 开头）

两个常见错法：把 token 建成了 **Variables**（不是 Secret）——变量不会注入 `secrets.*`；或者建在 **Environments** 下而不是仓库级。

**怎么确认生效** —— 不用等上游动 workflow 文件，现在就能验：

1. **每次同步都会自我报告**：运行摘要里会写 `Pushing with UPSTREAM_SYNC_TOKEN` 或 `UPSTREAM_SYNC_TOKEN is not visible to this job`。后者说明名字写错、建成了 Variables、或者建在 Environments 下。
2. **想确定 Workflows 权限真的生效**：**Actions → Sync upstream → Run workflow**，勾上 `probe_token` 再运行。它会往一个临时分支推一个一次性的 workflow 文件，然后立刻删掉那个分支——这是唯一能真正验证该权限的办法（secret 的值读不回来，fine-grained PAT 也不对外暴露自己的 scope）。

   通过则摘要显示 **Token OK**；失败会直接告诉你去补 `Workflows: Read and write`。这个探针只在手动勾选时运行，不会碰 master，也不会自动触发（那个一次性 workflow 只有 `workflow_dispatch`）。
3. 顺带一提，同一次手动运行如果输出 `sync-upstream: fork already contains upstream ...`，说明合并链路本身是通的（上游目前没有新提交时就是这个结果，无副作用）。


## 8. 自动化流水线

三个工作流串成一条链，各管一段：

```
Sync upstream   每天 03:00 UTC（北京 11:00）或手动
   │  合并 upstream/master，只在能证明冲突属于 fork 自身时才自动解冲突
   │  重移植 vendored 补丁、重建 yarn.lock、跑门禁
   ↓  通过才 push；不通过则中止并开 issue（master 保持可构建）
Auto release    Sync upstream 成功后自动触发
   │  若 master 的版本号还没有对应 Release，就打 tag v<version>-fork.N
   ↓
Fork Release    由 tag 触发
   │  Windows NSIS + portable、macOS 通用 DMG，跑真实产品门禁
   ↓  两个平台都发布成功
                更新 update-feed，让应用开始提示新版本
```

### 三种上游变化各自会发生什么

| 上游情况 | 自动发生 | 需要你 |
| --- | --- | --- |
| 有新提交、无新发布 | 合并进 master，**不构建** | 不用管 |
| 新发布且补丁可沿用（含升运行时） | 合并 → 自动把补丁改名到新运行时版本 → 重建锁文件 → 打 tag → 构建 → 发布 → 更新 feed | 不用管；等约 40 分钟拿到新安装包 |
| 新发布且上游自己修了这个 bug | 合并 → **自动删除补丁**、resolution 还原为 `file:` → 正常构建发布 | 不用管 |
| 新发布但补丁无法应用（上游大改了那段代码） | 合并中止、master 不变、自动开一个 issue | 手工重移植补丁，然后重跑 Sync upstream |

### 几个刻意的设计选择

- **补丁的守卫判据是「这个头有没有人发」**，不是「补丁文件在不在」。`verify-patch-retained.mjs` 要么看到补丁被正确接线且能应用到实际 tarball，要么看到 vendored bundle 自己就会发 `x-opencode-session`。两种情况都放行，其余一律拦下。
- **只有 Fork Release 能写 update-feed。** 同步会因为合并上游发布而改动 `package.json` 的版本号，如果那时顺手刷新 feed，就会对外宣称一个还不存在的版本——应用会提示更新、下载到旧安装包、装完版本没变、无限循环。这条顺序现在由工作流结构保证，不靠人记。
- **feed 只在 Windows 和 macOS 都发布成功后才更新。** 否则会告诉用户一个装机包还不存在的版本。
- **合并失败不会留下半成品。** merge 用 `--no-commit` 暂存，修复和合并合成一个提交；任何一步失败就 `merge --abort`，master 保持原样。

### 想改成纯手动

- 只手动同步：删掉 `sync-upstream.yml` 里的 `schedule` 段
- 只手动发版：删掉 `auto-release.yml` 里的 `workflow_run` 触发（保留 `workflow_dispatch`）
- 重新构建同一个版本（比如构建失败后重试）：**Actions → Auto release → Run workflow** 勾上 `force`，或者直接 **Actions → Fork Release** 手动填 `version` 和 `tag`（tag 用 `v2.0.11-fork.2` 这样递增后缀）

