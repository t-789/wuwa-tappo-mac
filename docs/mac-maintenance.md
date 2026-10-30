# 官方更新时的 macOS 端维护流程

## 结论先行

每次官方发新版，本仓库的更新 = 抽前端 → **重锚补丁** → 重编译。工作量主要在重锚，因为所有补丁都是「精确字符串匹配 + 命中次数断言」：上游一改就抛错，不会静默产出坏包。

## 一条命令

```bash
./scripts/update-upstream.sh check    # 只看官方有没有新版
./scripts/update-upstream.sh apply    # 更新锁 -> 重抽前端 -> prepare -> 构建
```

`prepare` 失败时会打印**是哪个补丁的锚点失效**（日志同时留在 `.work/prepare.log`），照着下面「补丁清单」逐个重锚。

## 补丁清单（重锚时逐个看）

`scripts/patch-frontend.mjs` 里每个导出函数都是一个锚点：

| 补丁 | 依赖的上游特征 |
|---|---|
| patchSessionBarriers | 2 个 Tauri invoke 包装函数 |
| patchLoginReady | 登录监听桥函数 |
| patchDomesticSdkUrls | 2 个 CN SDK URL |
| patchDomesticLoginReload | CN SDK 重载函数体 |
| patchMacUpdateFeedback | 更新失败反馈 |
| patchMacUpdater | 更新地址解析两段 |
| patchMacAbout | 关于页两个标题与远程内容 |
| patchGlobalAuthListener | 国际服 OAuth 回调 |
| patchMacLayoutBarriers | 两处布局屏障（用 acorn 解析 AST） |
| patchMacCountdownPaintPolicy | 入口 module 末尾唯一 export 尾 |
| patchMacCountdownPaintCost | 倒计时 bar 的 transition 与 progress 的 drop-shadow 两条 CSS |

## 铁律

1. **个性化改在补丁函数或 Rust 侧**，不要手改 `frontend/` 或 `build/frontend/`：
   - `frontend/` 是官方包解包产物，`assets:sync` 会整目录重建；
   - `build/frontend/` 每次 `prepare:frontend` 都被 `rm -rf` 重建。
2. 每个个性化做成独立 patch 函数 —— 更新时失效是局部的，不会连坐。
3. 更新后必须跑 `node --test tests/*.test.mjs` 与
   `CARGO_HOME=$PWD/.work/cargo-home cargo test --manifest-path src-tauri/Cargo.toml --lib`。

## 环境坑

- `~/.cargo` 可能不可写：所有 cargo 命令加 `CARGO_HOME=$PWD/.work/cargo-home`。
- `src-tauri/icons` 是 gitignore 的生成物，缺失时 `tauri::generate_context!` 会 panic：先 `npm run icons`（`npm run dev`/`build` 会自动做）。
- brew 装的 rust 会忽略 `rust-toolchain.toml` 的钉版本（例如 1.99.1 编 1.97.1 的目标），通常可用。
- `node scripts/sync-upstream.mjs --update-lock` **不能与 `--installer` 同时用**，会报「必须从官方地址下载」。

---

# 实测记录：1.0.1 → 1.0.2

结论：**11 个补丁零重锚**。真正需要人工跟进的只有 4 处，都与「官方 API 面 / 版本号」有关，与补丁锚点无关。

## 完整清单

1. `node scripts/sync-upstream.mjs --update-lock` —— 从官方 manifest 更新锁文件。
2. `node scripts/sync-upstream.mjs --installer <setup.exe> --sevenzip /opt/homebrew/bin/7zz` —— 重抽 `frontend/` 并按锁里的 sha256 校验安装包。
3. `node scripts/prepare-frontend.mjs` —— 应用全部补丁。
4. `npm run inventory` —— 重新生成 `tests/contracts.json`。
5. 更新 `tests/contract-inventory.test.mjs` 里写死的官方 API 面数字（本次：CN 事件数 59 → 60；50/9/119 不变）。
6. 更新 `tests/network-contract.json`：`application` 版本串 + `source` 四个文件名：
   - `main` = `index.html` 里的入口
   - `room` = 含 `RewardCountdownBubble` 的 `index-*.js`
   - `login` = `useLogin-*.js`
   - `loginView` = 含 `countdownEndTime` 的 `login-*.js`
7. 若测试因**压缩后标识符重命名**而失败（本次 `Re({link:` → `Oe({link:`），把断言改为断言结构（`{link:[{rel:"stylesheet"` + `onload:`）而不是断言标识符。
8. 三处版本号同步：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`。
   不同步的后果：app 自称旧版本，内置更新检查会误判并尝试拉 Windows 安装包。
9. 测试：`node --test tests/*.test.mjs`（116）+ `cargo test --lib`（80）。
10. 构建：`CARGO_HOME=$PWD/.work/cargo-home npm run build`。

## 冒烟方法（不需要复现任何 bug）

- **版本**：`grep "event=boot session" ~/Library/Logs/dev.w33d.wuwatappo.cn.mac/app.log | tail -1`
- **窗口层级 / 全屏可见性**：用 `CGWindowListCopyWindowInfo` 读目标 pid 的 `kCGWindowLayer` 与 `kCGWindowIsOnscreen`；再让另一个进程进入原生全屏（`toggleFullScreen:`），此时 `onscreen=1` 才表示真的浮在别人的全屏 Space 上。
- **GPU 泄漏**：读 `com.apple.WebKit.GPU` 进程的 `footprint -p <pid>`（取 `phys_footprint`）与 `vmmap -summary` 里的 IOSurface 区域数。判据是**长区间单调上升**且出现恒定 **+102.4MB** 台阶，而不是 ±20MB 的抖动。

---

# 已知的 macOS 渲染 / 窗口陷阱（都是实测结论）

1. **倒计时进度环的重绘成本**：官方样式里 `.reward-countdown__bar` 有 `transition:stroke-dasharray .9s linear`，而 `--progress` 每秒改一次，等于约 54 次/秒重绘；该层又叠着 `filter:drop-shadow(...)` 两次，滤镜使 WebKit 无法复用 tile，必须整层重新栅格化。桌宠窗口是整屏透明覆盖层（一张整窗 backing store ≈ 33MB），于是 GPU 进程里的 IOSurface 只增不减。修复见 `patchMacCountdownPaintCost`（去掉滤镜 + 去过渡，重绘降到 1 次/秒）。
2. **激活策略的时机决定窗口能否进入别人的全屏 Space**：进程必须是 Accessory（`LSUIElement` 等价）**并且**在建窗之前就已是 Accessory；之后无论怎么改 `collectionBehavior`（`canJoinAllSpaces | fullScreenAuxiliary`）或 `NSWindow.level` 都无效——窗口已被判定为桌面 Space 的窗口。层级不是关键（level 3 即可）。见 `windows::sync_activation_policy`。
3. **层级不要与 tao 抢**：tao 0.37.2 把 `kCGFloatingWindowLevelKey` 直接当 level 用，并通过 `dispatch_async` 异步写主队列，因此任何同步 `setLevel` 都可能被 `set_always_on_top` 异步写回。主窗口的层级应由单一函数独占写入。
