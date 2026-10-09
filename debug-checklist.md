# Tauri 桌面应用发热 / 后台功耗审计清单

> 用途：把"机器发烫、电池掉得快"这类问题在**任何 Tauri 2 项目**上系统性地查一遍。
> 面向人类与 AI Agent 均可。语言按使用者习惯，本文件为中文。
>
> **v2 重写说明**：v1 是一份"猜渲染 bug"的假设清单（透明窗口、ProMotion 120Hz、
> backdrop-filter、图表库 WebGL）。在 cc-switch 上按 v1 逐条排查后，**这些假设
> 全部证伪**——真正的热源一个都不在 v1 的怀疑范围内。v2 保留 v1 作为"已排除项"
> （第 2 节），主体换成实际有效的方法（第 3~7 节）。不要跳过第 2 节直接照 v1 修。

---

## 1. 核心认知：这不是渲染问题，是"没人叫停"的问题

发热的根因几乎不是"画得太花"，而是**后台有一堆周期性工作在无条件跑**。

一个每 5 秒触发一次、单次成本极低的健康检查，×10 个列表项 = 每分钟 120 次 IPC。
单看每一处都"不贵"，乘起来就不便宜。**审计的单位不是"代码行"，是"每分钟发生多少次"。**

推论：不要从"哪里画得重"开始找，要从"**什么东西在反复发生**"开始找。

---

## 2. v1 假设清单 —— 已证伪，不要再花时间

在 cc-switch（React + Vite + Tauri 2.8，macOS）上逐条核对后的结论：

| v1 假设 | 实测结论 |
|---|---|
| `transparent: true` 触发 WindowServer 持续全窗合成（Tauri #15471） | **不适用**。`tauri.conf.json` 未启用 `transparent` / `macOSPrivateApi` / `hasShadow`，只有 `titleBarStyle: "Overlay"`。先查配置再信这条 bug report。 |
| 未限制的 120Hz ProMotion 渲染 | **未发现**递归 `requestAnimationFrame`、WebGL 循环。 |
| `backdrop-filter` 毛玻璃大面积重采样 | **部分成立，但不是主因**。确实要改，但它是常数级成本，不是随时间放大的成本。 |
| 图表库（Recharts/Chart.js）WebGL/Canvas 高频重绘 | **部分成立**。真实问题是数据刷新时 Area 重复播放入场动画，不是 WebGL。 |
| 全局永久 `animate-spin` | **不成立**。所有 `animate-spin` 都在加载条件分支内。 |

**教训**：外部 bug report 和社区经验是**待验证假设**，不是结论。先花 30 秒查配置
（`transparent` / `hasShadow` / `macOSPrivateApi`）证伪，能省掉后面所有弯路。

**另一条教训**：即使 v1 里的 backdrop-filter 方向对了，把它归类成"短时或局部使用、
可以留着"也是错的——实际有 4 处是**常驻**模糊面。**你对"剩下的那些"所作的假设，
必须重新验证，不能继承。**

---

## 3. 审计主流程

### Step 1 — 建地图：穷举一切周期性工作

不要读"看起来可疑"的文件，直接 grep 出**所有会重复发生的东西**。以下命令可直接复制：

```bash
# —— Rust 侧：等待、循环、并发单元、周期常量 ——
rg -n 'time::sleep|interval\(|interval_at' src-tauri/src
rg -n 'loop \{|while ' src-tauri/src
rg -n 'thread::spawn|tokio::spawn|async_runtime::spawn|spawn_blocking' src-tauri/src
rg -n 'INTERVAL|TIMEOUT|DEBOUNCE|THROTTLE|_[MS]S|RETRY' src-tauri/src

# —— 前端：定时器、轮询、逐帧、常驻动画、模糊层 ——
rg -n 'setInterval|setTimeout|requestAnimationFrame' src
rg -n 'refetchInterval|useQuery\(|refetchOnWindowFocus' src
rg -n 'animate-(spin|pulse|bounce)|infinite' src
rg -n 'backdrop-filter' src

# —— 配置：窗口合成 ——
rg -n 'transparent|hasShadow|macOSPrivateApi' src-tauri/tauri.conf.json

# —— IPC 面：谁被高频调用 ——
rg -n '#\[tauri::command\]' src-tauri/src | wc -l
```

### Step 2 — 对每一项追问停止条件（本清单的核心）

对 Step 1 命中的**每一处**，问同一个问题：

> **"在什么条件下，这个东西不执行？"**

- 答得上来且条件合理 → 保留。
- 答得上来但条件可疑 → 收紧条件。
- **答不上来 → 按默认浪费处理，改掉。**

这个问法能挖出绝大多数真凶，而且不需要先验知识。例如：

| 命中项 | 停止条件 | 判定 |
|---|---|---|
| 每 60 秒全量扫描会话目录 | 有（时间到了就跑） | ⚠️ 有条件但条件不合理 → 放宽到 5 分钟 |
| 每 5 秒查一次供应商健康 | 代理关了也查 | ❌ 条件缺失 → 加上"代理在跑" |
| 200ms 防抖后 emit 事件 | 有 | ✅ 但触发源可能高频 → 查上游 |
| 相对时间 `setInterval` 30s | "有没有数据" | ⚠️ 漏了"窗口可见吗" → 补 |
| `accept()` 失败固定 50ms 重试 | 无上限 | ❌ 把一次故障变成永久 CPU 占用 → 指数退避 + 上限 |

### Step 3 — 算乘数

对每个仍然存活的项目：`单次成本 × 每分钟次数 × 实例数`。
写下来。只看单次成本会严重低估列表型 UI（每张卡片一个轮询）。

### Step 4 — 追生命周期：隐藏 ≠ 释放

这是 macOS 上最容易漏的一层，也是本轮**最大的单点收益**。

`window.hide()` **不改变对象生命周期**。WKWebView 隐藏后，`com.apple.WebKit.WebContent`
和 `com.apple.WebKit.GPU` 子进程仍然存活，前端的定时器、渲染管线照常运行。
于是你得到一个"看不见的持续功耗"。

- **macOS**：要真正释放，托盘/静默模式必须**销毁** WebView，恢复入口（托盘点击、Dock
  Reopen、单实例、深链）再重建。
- **Windows / Linux**：WebView2 行为不同，先实测再决定是否跟着改。**不要无差别照搬。**

验证方法：`Activity Monitor` 看 `com.apple.WebKit.GPU` 是否随窗口消失而归零。

### Step 5 — 区分"用户主动触发"和"后台常驻"

不是所有省下来的功耗都值得省。判据：

- **用户主动触发 + 内部有防抖 + 生命周期短** → 不是后台常驻负载，**不要砍**。
- 典型例子：托盘菜单的悬停刷新。用户把鼠标移到托盘上本身就说明他要看数字；
  砍掉会让数字永久冻结在某个时刻，那是**误导性数据**，比"略旧"严重得多。

砍之前先问："省下的是功耗，还是让数据变得不可信？"

### Step 6 — 改完一处，全量复扫

改完 `.glass-card` 不代表 `.glass` 也没了；改完一个 footer 不代表另外两个没有。
**每次修完都重新跑一遍 Step 1 的全量 grep。** 并在文档里**显式写下对上一版结论的更正**
（"上一版本此条把 X 归为短时是错的"），否则下一个读到的人会继承那个错误假设。

### Step 7 — 平台差异收敛为可单测的纯函数

平台分支散落在业务代码里既难读又难测。把决策抽成纯函数，参数只留平台名：

```rust
pub(crate) fn close_to_tray_action(target_os: &str) -> CloseToTrayAction { ... }

#[test]
fn macos_close_to_tray_destroys_webview_to_release_gpu_processes() { ... }

#[test]
fn other_platforms_keep_existing_hide_window_behavior() {
    for target_os in ["windows", "linux"] { ... }
}
```

这样"为什么 macOS 要特殊处理"变成一条可执行的断言，而不是散落在 `#[cfg]` 里的直觉。

---

## 4. 反模式速查（症状 → 根因 → 正确做法）

### 调度层

| 症状 | 根因 | 正确做法 |
|---|---|---|
| 托盘态仍在耗电、仍有网络请求 | 托盘态的 Tauri 窗口**不是** `document.hidden`。`refetchIntervalInBackground: false` 拦得住页面隐藏，**拦不住"失焦但仍可见"** | 自己接 Tauri 的窗口 focus/blur 事件，作为独立的门控维度 |
| 停止条件散落成 `cond && active ? N : false` | 每个调用点各写一遍，新查询忘了就退化成常驻轮询 | 收进抽象层：调用方只声明"多久刷一次"，由 hook / query factory 决定"失焦时不刷" |
| 服务出一次错后 CPU 永久 100% | 固定短间隔重试且无上限（`accept()` 固定 50ms） | 指数退避 + 硬上限 + **能被 shutdown 打断**（`tokio::select!` 监听 shutdown 信号） |
| 持续流量下前端永远不刷新 | 防抖窗口被不断延长的"可重置"设计 | 固定窗口。`Notify` 最多存一个 permit，到达的通知合并进**下一个**窗口，而不是无限延长当前窗口 |
| 每次都新建一个线程/任务来"合并"通知 | 以为防抖 = 复用，实际每次都 spawn | 单一长生命周期 worker + `Notify`/channel，通知方只置位 |

### 放大器

| 症状 | 根因 | 正确做法 |
|---|---|---|
| 单处看着无害，合起来很贵 | 乘数效应（每卡片一个轮询） | 显式乘算；把条件相同的轮询合并到一处 |
| 打开某个页面瞬间 CPU 飙 | 冷缓存挂载就并发探测 N 个外部工具/端点 | 改手动触发；一次批量请求**顺序**处理；同步子进程用 `spawn_blocking` 移出 async worker |
| 异步任务偶发卡死整个 runtime | 在 async worker 上跑阻塞子进程（`$SHELL -lic`、HTTP、文件 IO） | `tokio::task::spawn_blocking`，并对 `JoinError` 做显式兜底 |

### 生命周期

| 症状 | 根因 | 正确做法 |
|---|---|---|
| 关到托盘后 GPU 进程仍在 | `hide()` 不销毁 WebView | 销毁 WebView，按需重建 |
| 销毁后用户点了深链/托盘，**毫无反应** | 事件是 `emit` 瞬时发出的，此时没有 WebView 在听 | 重建期间到达的事件**先持久化到 Rust 端**，由新页面挂载后主动拉取。禁止依赖瞬时 `emit` |
| 错误路径静默失败 | 只在 `Ok` 分支处理，`Err` 分支照样 `emit` 给不存在的 WebView | 成功和失败走同一条唤起路径，错误也持久化，由新页面弹提示 |

### 渲染层（成本较低，但顺手做掉）

| 症状 | 根因 | 正确做法 |
|---|---|---|
| 数据刷新时页面明显卡一下 | 图表入场动画在每次数据更新时重播 | 数据驱动的图表关掉 `isAnimationActive` |
| 滚动/更新时大面积重采样 | 常驻 `backdrop-filter` 模糊层 | 区分常驻面与短时面；常驻面改半透明纯色。**不要假设"剩下的都是短时的"** |
| 页面静止仍有周期性样式更新 | 心跳装饰在定时改根 DOM | 心跳间隔放宽（3s → 30s），且让它的状态成为可复用的门控信号 |

---

## 5. 门控的标准形态

把"窗口是否活跃"做成**单一事实源**，所有轮询经它收口。用 React：

```ts
// 单一事实源
export function useWindowActive() {
  return useSyncExternalStore(subscribeWindowActivity, isWindowActive, () => false);
}

// 所有轮询经此收口：调用方只声明"多久刷一次"
export function useGatedRefetchInterval(intervalMs: number, enabled = true) {
  const windowActive = useWindowActive();
  return enabled && windowActive && intervalMs > 0 ? intervalMs : false;
}
```

配套的 `getServerSnapshot` 返回 `false`：SSR / 测试环境下默认"不活跃"，
即**默认不轮询**。默认值要选安全的那一侧。

**已知的例外**：React Query 的函数式 `refetchInterval: (query) => ...` 里，
门控依赖 `query.state.data`，取到数据后才知道。这种形状改用非响应式的
`isWindowActive()` 直接读，并在注释里写明为什么它不走统一门控。

**事件驱动类**（后端 emit 前端刷新）配套两条规则：
1. 失焦时只置 dirty 标记并返回，**不**发起 invalidate；
2. 恢复焦点时若 dirty，补刷**一次**。

---

## 6. 验证与回归

**没有度量就不要声称量化收益。** 明确区分"已证明不耗电"和"应该会不耗电"。

```bash
# 静态
pnpm typecheck && pnpm format:check && pnpm test:unit
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# 实机（用正式构建，不用 Vite HMR——HMR 常驻的 dev server 会污染功耗读数）
sudo powermetrics --samplers tasks,gpu_power,cpu_power -i 1000
```

`powermetrics` 至少要覆盖这些场景，每个连续记 5~10 分钟的**中位数和 P95**（不要看瞬时值）：

1. 静默启动 / 隐藏托盘 / 代理关闭 —— 应无持续 WebContent 活动
2. 列表页静止、代理关闭 —— 应无健康轮询
3. 代理运行但无请求 —— 应只剩一个状态轮询，且失焦即停
4. 打开用量/监控页后隐藏 —— 应只置 dirty，不重取聚合查询
5. 手动触发重操作（版本检测等）后 —— 允许短时峰值，静止后应回落
6. 持续代理请求 —— 功耗随负载变化，不应出现线程 churn

同时在活动监视器观察 `WebKit.GPU` / `WebKit.WebContent` / `WebKit.Networking`。

**A/B 回滚方案要提前想好**：逐项能恢复（例如"健康轮询恢复为 5s""心跳恢复为 3s"），
否则出问题时无法定位是哪一项改动引起的。

**不要把固定瓦数阈值当验收标准**。不同机型、构建、场景差异很大，
比的是同机同构建同场景下的**差值**。

---

## 7. 交付物：审计文档该长什么样

1. **结论先行**：哪些已证伪（带 `file:line` 证据），为什么。
2. **热点表**：原热点 → 风险链 → 已应用修复 → 修复后证据（`file:line`）。
3. **未修改项也要写**，并写明"为什么判定它是条件性/低频"，附证据。
   静默跳过的地方，下一个人会当成"已经看过了没问题"。
4. **显式更正上一版的错误结论**，不要静默改掉。
5. **自动化验证证据**：实际跑过哪些命令、结果如何、新增了哪些回归测试。
6. **实机验收表**：场景 → 预期，供后续在目标机型上核对。

每个修复配一条回归测试。特别是平台差异和退避上限这类"纯逻辑"，必须可单测。

---

## 8. 参考链接（外部假设，使用前先自己验证）

- Tauri #15471 — 透明窗口导致 macOS 持续高 GPU：**先查 `transparent` 是否真的开了**
- Tauri #13978 — macOS 帧率相关讨论
- Tauri 官方调试文档 — https://v2.tauri.app/develop/debug/
- Chromium DevTools Rendering 面板的 Paint Flashing — 用于确认是否存在持续重绘

---

## 附：cc-switch 实测结果（作为 worked example）

一次完整的 6 类修复，供参考量级。原始记录见该仓库的
`docs/macos-m4-thermal-audit.md`（约 86 行，含完整 `file:line` 证据）。

| # | 类别 | 改动 | 量级 |
|---|---|---|---|
| 1 | 生命周期 | macOS 关闭到托盘/静默启动从 `hide()` 改为**销毁 WebView**，按需重建 | 最大单点收益；`WebKit.GPU` 归零 |
| 2 | 门控 | 新增窗口活动单一事实源，**12 处**轮询改为经统一门控收口 | 托盘态 IPC/SQLite/网络归零 |
| 3 | 门控 | 用量页 6 个查询各自传 `refetchInterval` → 收进 `usage.ts` 工厂 | 失焦即停；恢复焦点补刷一次 |
| 4 | 门控 | 3 个 footer 逐字重复的 30s `setInterval` → 抽 `useRelativeTimeTicker` | 失焦停表；重复逻辑消失 |
| 5 | 调度 | 后端 200ms 防抖从"每burst `thread::spawn`"改为单一 Tokio worker + `Notify` | 消除线程 churn |
| 6 | 调度 | `accept()` 固定 50ms 重试 → 50ms~5s 可中断指数退避 | 故障时不再永久烧 CPU |
| 7 | 放大器 | "关于"页冷缓存自动并发检测 8 个工具 → 手动 + 单次批量顺序 IPC + `spawn_blocking` | 消除打开页面即 CPU 峰值 |
| 8 | 周期 | 会话同步 60s → 5min | 接受 5 分钟延迟 |
| 9 | 渲染 | 图表 Area 入场动画关闭；常驻模糊层改纯色 | 常数级 |

**关键认知**（也是本清单想传达的）：

- 真凶全部属于"周期性工作没有停止条件"，**没有一条属于 v1 猜测的渲染问题**。
- 最隐蔽的一条：托盘态窗口不是 `document.hidden`，所以
  `refetchIntervalInBackground: false` 看起来设了、实际上没起作用。
- 有一条**刻意不改**：托盘悬停刷新。它是用户主动触发、有防抖、生命周期短；
  砍掉会让数字永久冻结在进入托盘那一刻，属于误导性数据。
