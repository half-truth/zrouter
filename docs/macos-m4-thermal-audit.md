# macOS M4 发热审计与修复记录

> 基于 `debug-checklist.md` 与当前工作树静态审计。2026-09-25 完成代码修复和自动化验证；未在目标 MacBook Air M4 上采集 `powermetrics`，因此本文不声称已量化降低多少瓦特。

## 1. 审计结论

`src-tauri/tauri.conf.json:12-27` 仅启用 `titleBarStyle: "Overlay"`，没有 `transparent: true`、`macOSPrivateApi: true`、`hasShadow: true`。Tauri #15471 所述“透明窗口持续全窗合成”不适用于当前配置；未发现递归 `requestAnimationFrame`、WebGL 循环或默认永久 `animate-spin`。

Tauri 2 / WKWebView 没有受支持的“禁用 macOS GPU”开关。修改私有 WebKit 偏好既不稳定，也可能把合成负载转移到 CPU，不能作为开源软件的安全默认项。本项目采用的直接方案是：**macOS 关闭到托盘或静默启动时销毁主 WKWebView，让 WebContent/WebKit.GPU 随 WebView 一起退出；从托盘、Dock Reopen、单实例或深链唤起时再按需重建。** Rust 托盘、代理服务、数据库与同步 worker 继续运行，不受影响。

## 2. 已定位热点与证据

| 原热点 | 风险链 | 已应用修复 | 修复后证据 |
|---|---|---|---|
| `src-tauri/src/lib.rs:1283-1332`：每 60 秒 `sync_all_unlocked`，遍历 7 类会话目录并读取文件 metadata | 隐藏托盘仍运行；文件多时产生每分钟 CPU、磁盘、SQLite 峰值 | 周期改为 5 分钟 | `src-tauri/src/lib.rs:1283-1332`，`SESSION_SYNC_INTERVAL_SECS = 5 * 60` |
| `src/components/providers/ProviderCard.tsx:236-240` + `src/lib/query/failover.ts:14-25`：每张卡片每 5 秒查健康状态，代理关闭也轮询 | 10 张卡片约 120 次 IPC/锁获取/分钟 | 仅代理运行且在故障转移队列时查询；15 秒周期；隐藏暂停 | `ProviderCard.tsx:236-240`、`failover.ts:19-28` |
| `src-tauri/src/usage_events.rs:55-70` + `src/hooks/useUsageEventBridge.ts`：200ms 后端事件触发整组 usage invalidation | 多组聚合 SQL、React 更新、SVG 重绘叠加 | 后端单 Tokio worker；前端 1 秒合并；隐藏时 dirty，恢复焦点刷新一次 | `usage_events.rs:13-84`、`useUsageEventBridge.ts:7-75` |
| `src/lib/query/queries.ts:245-277`：当前供应商用量允许后台轮询 | 隐藏托盘仍访问第三方端点并唤醒网络线程 | `refetchIntervalInBackground: false`，恢复焦点刷新 | `queries.ts:259-276` |
| `src/components/usage/UsageTrendChart.tsx:244-365`：5 个 Area 数据更新时重复播放动画 | 5 秒刷新会反复计算路径、合成 SVG、模糊背景 | 5 个 Area 设置 `isAnimationActive={false}`；用量页常驻模糊层改纯色 | `UsageTrendChart.tsx:236,314-363` |
| `src/App.tsx:1287-1296`、`src/index.css:63-89`：固定模糊头部、普通玻璃卡片 | 滚动/数据更新时大面积重新采样背景 | 头部及普通卡片改不透明/高不透明度背景 | `App.tsx:1287-1289`、`index.css:75-83` |
| `src/lib/windowActivity.ts:4-31`：每 3 秒修改根 DOM 并播放 300ms 透明度动画 | 页面静止仍有周期性样式更新 | 延长至 30 秒；统一发布窗口活动状态 | `windowActivity.ts:4-83` |
| `src-tauri/src/proxy/server.rs:145-151`：`accept()` 异常固定 50ms 重试 | 持续错误时每秒约 20 次唤醒和错误日志 | 50ms→5s 可中断指数退避 | `server.rs:29-37,147-169,468-479` |
| macOS 关闭到托盘原先只 `window.hide()` | WKWebView、WebContent 和 WebKit.GPU 仍存活，前端定时任务也继续挂载 | 改为销毁主 WebView；托盘、Dock、单实例和深链路径按需重建；重建期间深链先保存在 Rust 端 | `src-tauri/src/lib.rs:268-288,448-457,1818-1850`、`src-tauri/src/lightweight.rs:7-128` |
| `AboutSection` 冷缓存挂载后自动并发检测 8 个工具 | 每个工具在 macOS 启动 `$SHELL -lic`、执行 `--version` 并访问 npm/GitHub/PyPI；打开“关于”立即形成 CPU/子进程峰值 | 改为完全手动检测；一次 IPC 顺序处理全部工具；同步子进程移入 `spawn_blocking`；移除 About 页永久旋转星标 | `src/components/settings/AboutSection.tsx`、`src-tauri/src/commands/misc.rs` |
| 代理状态、供应商、额度和 OAuth 查询仍有后台 interval | 窗口仅失焦时 WebKit 仍可能运行，继续产生 IPC/网络/SQLite 成本 | 所有周期查询显式依赖 Tauri 窗口焦点并设置 `refetchIntervalInBackground: false` | `src/lib/windowActivity.ts:13-30`、`src/lib/query/*.ts` |
| 用量页 6 个组件自行决定 `refetchInterval`，绕过窗口焦点 | 6 个聚合查询在"窗口仍可见但已失焦"时继续按用户设定周期（默认 30s）打 SQLite；`refetchIntervalInBackground` 只拦 `document.hidden`，拦不住 Tauri 失焦 | 焦点策略下沉到 `usage.ts` 的 query 工厂：调用方只声明"多久刷一次"，工厂决定"失焦时不刷"，聚焦时由 React Query 补刷一次 | `src/lib/query/usage.ts`（`useUsageRefetchInterval`，覆盖 6 个查询） |
| 3 个 footer 的相对时间 `setInterval` 缺少停止条件 | 唯一的判据是"有没有数据"，"窗口不可见时"照跑；每 30s 触发 `setState` 引发子树重渲染 | 抽取 `useRelativeTimeTicker`，停止条件收进 hook 内部（调用方只声明"有值得跟踪的时间戳"），失焦停表、聚焦立即校准 | `src/hooks/useRelativeTimeTicker.ts`、3 个 footer |
| `.glass` 的 `backdrop-filter: blur(10px)` 漏网 | 上一轮只处理了 `.glass-card` / `.glass-header`。设置页全宽 TabsList、MCP 与 Skills 页计数条、提示词库顶栏共 4 处是**常驻**模糊面，不是此前假定的"短时或局部" | `.glass` 改为与 `.glass-card` 一致的不透明 token 背景 + token 边框，去掉模糊 | `src/index.css:63-66`；使用点 `SettingsPage.tsx:227`、`common/AppCountBar.tsx`、`prompts/PromptLibrary.tsx:57` |

## 3. 未修改的条件性热点

- `src-tauri/src/services/sync_protocol.rs:149-209`：WebDAV/S3 会完整复制 SQLite、导出 SQL、压缩 Skills、计算哈希。只在配置类表变化时触发，代理请求日志不会触发；双后端启用可能重复生成快照，后续可共享 `LocalSnapshot`。
- `src-tauri/src/database/mod.rs:151-164`、`services/usage_stats.rs:1820-1864`：启动清理、rollup、vacuum 和成本回填会产生启动尖峰，不是默认持续负载；大库可继续分批与错峰。
- `src/components/providers/forms/hooks/useManagedAuth.ts`：OAuth 状态刷新现已绑定窗口焦点，但认证轮询本身仍由用户主动触发，属于低频条件性工作。
- 弹窗和 Tooltip 仍保留模糊效果（`dialog.tsx` 遮罩、表单弹窗内的面板、图表 tooltip），但属于短时或局部使用。**更正**：上一版本此条把 `.glass` 一并归为"短时或局部"是错的——其中 4 处为常驻面，已在第 2 节修复。
- 复查确认**无同类残留**（2026-09-25 全量扫描）：Rust 侧 14 处 `time::sleep` 全为一次性延时或测试；28 处 `loop {` 全为有界迭代（流式/编码/文件拷贝）、弹窗驱动的用户重试，或带 `timeout` 守卫的测试；`forward_with_retry` 同时受 `max_attempts` 与 provider 列表长度双重约束；前端 5 处 `requestAnimationFrame` 均一次性；无 WebSocket/EventSource；60 个文件的 `animate-spin` 全部位于加载条件分支内。
- macOS 托盘销毁 WebView 后，Rust 托盘、代理、SQLite 和同步 worker 仍会运行；它们不创建 WKWebView，因此不会产生 WebKit.GPU 进程，但代理高流量时仍会有预期的网络/CPU 成本。
- **托盘悬停的用量刷新刻意不按轻量模式短路**（`lib.rs` 的 `TrayIconEvent::Enter`）。托盘菜单只在切换供应商 / failover / profile 时重建，`refresh_all_usage_in_tray` 是唯一的悬停刷新路径；把它挡掉会让"关闭到托盘"——即本应用的默认状态——下的用量数字永久冻结在进入托盘那一刻，是会误导用户的陈旧值而非"略旧"。该路径由用户主动触发、内部有 10 秒防抖、且仅在指针停留时运行，不构成后台常驻负载，故保留。

## 4. 自动化验证证据

以下命令已成功执行：

```bash
pnpm typecheck
pnpm format:check
pnpm test:unit
pnpm build:renderer
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

前端全套 Vitest、Rust 2,928 个单元测试及各集成测试目标均通过。构建成功（Vite 提示主 chunk 大于 500 kB、浏览器数据过期，但退出码为 0）。新增回归测试：

- `tests/hooks/useUsageEventBridge.test.tsx`：活跃窗口合并刷新、隐藏后延迟并恢复刷新。
- `tests/lib/windowActivity.test.ts`：初始化时已聚焦及焦点切换。
- `tests/components/AboutSection.test.tsx`：打开“关于”不自动检测；点击后只发一次批量 IPC；重挂复用会话缓存。
- `src-tauri/src/proxy/server.rs`：accept 退避递增与上限。
- `tests/lib/query/usageRefetchPolicy.test.tsx`：活跃窗口按请求节奏轮询、失焦返回 `false`、显式 `false` 与 `0` 均视为关闭、默认周期也不进后台。
- `tests/hooks/useRelativeTimeTicker.test.tsx`：活跃时按期 tick、失焦不 tick、未启用不 tick、失焦后重新激活立即校准时间戳。

## 5. M4 实机验收

使用正式构建，不以 Vite HMR 作为最终功耗依据：

```bash
pnpm build
sudo powermetrics --samplers tasks,gpu_power,cpu_power -i 1000
```

每个场景连续记录 5～10 分钟的 CPU/GPU 中位数和 P95：

| 场景 | 预期 |
|---|---|
| 静默启动、隐藏托盘、代理关闭 | 仅保留 5 分钟会话扫描，无持续 WebContent 活动 |
| 供应商页静止、代理关闭 | 无健康轮询 |
| 代理运行但无请求 | 仅保留 5 秒状态轮询（`src/lib/query/proxy.ts` 的 `useProxyStatusQuery` / `useProxyTakeoverStatus`，失焦时停表），后续应事件化 |
| 用量页关闭自动刷新 | 静止页面接近后台基线 |
| 首次打开“关于” | 不启动工具版本、shell 或远端版本查询进程 |
| 手动点击“检测版本” | 一次批量 IPC 顺序探测，允许短时 CPU 峰值；静止后回落 |
| 用量页 5 秒刷新 | 有查询/SVG 更新，但无 Area 更新动画 |
| 打开用量页后隐藏 | usage 事件只标记 dirty，不重取聚合查询 |
| 持续代理请求 | 功耗随请求负载变化，不应出现 200ms 线程 churn |

同时观察 CC Switch、`com.apple.WebKit.WebContent`、`com.apple.WebKit.GPU`、`com.apple.WebKit.Networking`。比较同一台机器、相同构建和相同场景下修复前后的稳定差值；`2W`/`15W` 不作为所有 M4 的固定阈值。回滚 A/B 可逐项恢复：透明窗口检查无变化；健康轮询恢复为 5s；Area 动画恢复；模糊层恢复；心跳恢复为 3s；会话周期恢复为 60s。
