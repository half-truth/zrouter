use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

static LIGHTWEIGHT_MODE: AtomicBool = AtomicBool::new(false);

/// 关闭到托盘时应该做什么，取决于平台能省下多少常驻资源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseToTrayAction {
    /// 销毁主 WebView，让 WebContent / WebKit.GPU 进程随之退出。
    HideWindow,
    /// 只隐藏窗口，WebView 与渲染进程继续存活。
    DestroyWebView,
}

/// macOS 选择销毁而非隐藏。
///
/// Tauri 2 / WKWebView 没有受支持的「禁用 GPU」开关，而 `window.hide()` 只是
/// 不可见——WKWebView、WebContent 与 WebKit.GPU 全部留着，前端的定时任务也照跑。
/// 本应用的默认状态就是关闭到托盘，所以这条路径直接决定了静置时的常驻功耗。
/// Windows / Linux 保持隐藏：托盘与任务栏语义依赖窗口本身，销毁的重建代价
/// 也大于收益。
pub(crate) fn close_to_tray_action(target_os: &str) -> CloseToTrayAction {
    if target_os == "macos" {
        CloseToTrayAction::DestroyWebView
    } else {
        CloseToTrayAction::HideWindow
    }
}

/// 关闭到托盘的统一入口，按平台分派到销毁或隐藏。
pub(crate) fn enter_close_to_tray_mode(app: &tauri::AppHandle) -> Result<(), String> {
    match close_to_tray_action(std::env::consts::OS) {
        CloseToTrayAction::DestroyWebView => enter_lightweight_mode(app),
        CloseToTrayAction::HideWindow => {
            if let Some(window) = app.get_webview_window("main") {
                window
                    .hide()
                    .map_err(|error| format!("隐藏主窗口失败: {error}"))?;
                #[cfg(target_os = "windows")]
                window
                    .set_skip_taskbar(true)
                    .map_err(|error| format!("设置 Windows 托盘模式失败: {error}"))?;
            }
            Ok(())
        }
    }
}

pub fn enter_lightweight_mode(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_skip_taskbar(true);
        }
    }
    #[cfg(target_os = "macos")]
    {
        crate::tray::apply_tray_policy(app, false);
    }

    if let Some(window) = app.get_webview_window("main") {
        crate::save_window_state_before_exit(app);
        window
            .destroy()
            .map_err(|e| format!("销毁主窗口失败: {e}"))?;
    }
    // else: already in lightweight mode or window not found, just set the flag

    LIGHTWEIGHT_MODE.store(true, Ordering::Release);
    crate::tray::refresh_tray_menu(app);
    log::info!("进入轻量模式");
    Ok(())
}

pub fn exit_lightweight_mode(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        {
            crate::linux_fix::nudge_main_window(window.clone(), "lightweight-exit");
        }
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_skip_taskbar(false);
        }
        #[cfg(target_os = "macos")]
        {
            crate::tray::apply_tray_policy(app, true);
        }
        LIGHTWEIGHT_MODE.store(false, Ordering::Release);
        crate::tray::refresh_tray_menu(app);
        log::info!("退出轻量模式");
        return Ok(());
    }

    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .ok_or("主窗口配置未找到")?;

    WebviewWindowBuilder::from_config(app, window_config)
        .map_err(|e| format!("加载主窗口配置失败: {e}"))?
        .build()
        .map_err(|e| format!("创建主窗口失败: {e}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        {
            crate::linux_fix::nudge_main_window(window.clone(), "lightweight-recreated");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_skip_taskbar(false);
        }
    }
    #[cfg(target_os = "macos")]
    {
        crate::tray::apply_tray_policy(app, true);
    }

    LIGHTWEIGHT_MODE.store(false, Ordering::Release);
    crate::tray::refresh_tray_menu(app);
    log::info!("退出轻量模式");
    Ok(())
}

pub fn is_lightweight_mode() -> bool {
    LIGHTWEIGHT_MODE.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::{close_to_tray_action, CloseToTrayAction};

    #[test]
    fn macos_close_to_tray_destroys_webview_to_release_gpu_processes() {
        assert_eq!(
            close_to_tray_action("macos"),
            CloseToTrayAction::DestroyWebView
        );
    }

    #[test]
    fn other_platforms_keep_existing_hide_window_behavior() {
        for target_os in ["windows", "linux"] {
            assert_eq!(
                close_to_tray_action(target_os),
                CloseToTrayAction::HideWindow
            );
        }
    }
}
