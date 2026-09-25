//! 使用统计实时刷新事件模块
//!
//! 当 `proxy_request_logs` 表写入新数据时（代理日志、会话同步、归档等），
//! 通过本模块向前端 emit `usage-log-recorded` 事件，让 UsageDashboard
//! 立刻 invalidate 查询缓存而无需等待轮询周期。
//!
//! 设计要点：
//! - 全局单例 AppHandle：写日志路径上不持有 AppHandle，用 OnceCell 共享。
//! - 200ms 防抖合并：流式响应等场景在短时间内可能写入多条日志，
//!   合并成一次事件可避免前端连续 invalidate。
//! - 不阻塞写入：通知失败仅记录 warn 日志，不向上传播错误。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

use tauri::{AppHandle, Emitter};

/// 前端监听的事件名
pub const EVENT_USAGE_LOG_RECORDED: &str = "usage-log-recorded";

/// 防抖窗口：合并 200ms 内的多次通知。
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static NOTIFY: OnceLock<Arc<Notify>> = OnceLock::new();
static WORKER_STARTED: AtomicBool = AtomicBool::new(false);
static NOTIFICATION_PENDING: AtomicBool = AtomicBool::new(false);

/// 在应用 setup 阶段调用一次，注入 AppHandle。
///
/// 重复调用是无害的（OnceLock 仅首次写入生效），但应用启动期只该被
/// `lib.rs::run` 调一次。
pub fn init(handle: AppHandle) {
    let notify = NOTIFY.get_or_init(|| Arc::new(Notify::new())).clone();
    if APP_HANDLE.set(handle).is_err() {
        log::debug!("usage_events::init 重复调用，已忽略");
    } else {
        if !WORKER_STARTED.swap(true, Ordering::AcqRel) {
            tauri::async_runtime::spawn(run_debounce_worker(notify));
        }
        log::info!("[usage-event] AppHandle 已注入，事件推送启用");
    }
}

async fn run_debounce_worker(notify: Arc<Notify>) {
    loop {
        notify.notified().await;

        // A permit can remain after a burst was already drained. Ignore it
        // unless a caller has marked a new notification pending.
        if !NOTIFICATION_PENDING.swap(false, Ordering::AcqRel) {
            continue;
        }

        // Fixed windows avoid starvation during sustained traffic. Notify stores
        // at most one permit, so writes arriving during this sleep are coalesced
        // into the next window instead of extending this one forever.
        tokio::time::sleep(DEBOUNCE_WINDOW).await;

        if let Some(handle) = APP_HANDLE.get() {
            if let Err(e) = handle.emit(EVENT_USAGE_LOG_RECORDED, ()) {
                log::warn!("emit {EVENT_USAGE_LOG_RECORDED} 失败: {e}");
            }
        }
    }
}

/// 通知前端有新的使用日志写入。
///
/// 调用方**不**需要持有 AppHandle，可以从任意线程/任意写入路径调用。
/// 内部 200ms 防抖合并，绝不阻塞调用线程。
pub fn notify_log_recorded() {
    #[cfg(test)]
    TEST_NOTIFY_COUNT.with(|count| count.set(count.get().saturating_add(1)));

    // AppHandle 未注入（典型出现在单元测试或 setup 之前）：直接放弃。
    let Some(notify) = NOTIFY.get() else {
        return;
    };

    NOTIFICATION_PENDING.store(true, Ordering::Release);
    notify.notify_one();
}

#[cfg(test)]
thread_local! {
    static TEST_NOTIFY_COUNT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_test_notify_count() -> u32 {
    TEST_NOTIFY_COUNT.with(|count| count.replace(0))
}
