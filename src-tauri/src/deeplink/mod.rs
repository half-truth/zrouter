//! Deep link import functionality for CC Switch
//!
//! This module implements the ccswitch:// protocol for importing configurations
//! via deep links. Supports importing:
//! - Provider configurations (Claude/Codex/Gemini)
//! - MCP server configurations
//! - Prompts
//! - Skills
//!

mod mcp;
mod parser;
mod prompt;
mod provider;
mod skill;
mod utils;

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

/// 深链解析失败信息，形状与 `deeplink-error` 事件载荷一致。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkParseError {
    pub url: String,
    pub error: String,
}

/// macOS 关闭到托盘后 WKWebView 已被销毁，此时 `emit` 无处可去——事件不会排队，
/// 监听者还没挂上就发出去了。到达的请求先存进这两个单槽，由新页面挂载后经 IPC
/// 主动拉取。
///
/// 每格只放一个：每条到达的深链都会立刻 `exit_lightweight_mode` 唤起窗口，第二个
/// 请求理论上无处容身。覆盖仍会打 warn——真发生时要能从日志里看见，而不是静默
/// 丢一次用户的点击。
static PENDING_DEEPLINK: OnceLock<Mutex<Option<DeepLinkImportRequest>>> = OnceLock::new();
static PENDING_DEEPLINK_ERROR: OnceLock<Mutex<Option<DeepLinkParseError>>> = OnceLock::new();

fn pending_deeplink_slot() -> &'static Mutex<Option<DeepLinkImportRequest>> {
    PENDING_DEEPLINK.get_or_init(|| Mutex::new(None))
}

fn pending_deeplink_error_slot() -> &'static Mutex<Option<DeepLinkParseError>> {
    PENDING_DEEPLINK_ERROR.get_or_init(|| Mutex::new(None))
}

pub(crate) fn take_pending_deeplink() -> Option<DeepLinkImportRequest> {
    pending_deeplink_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

pub(crate) fn store_pending_deeplink(request: &DeepLinkImportRequest) {
    let mut pending = pending_deeplink_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(dropped) = pending.replace(request.clone()) {
        log::warn!(
            "轻量模式下的待处理深链被覆盖，丢弃前一条: resource={}, name={:?}",
            dropped.resource,
            dropped.name
        );
    }
}

pub(crate) fn take_pending_deeplink_error() -> Option<DeepLinkParseError> {
    pending_deeplink_error_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

pub(crate) fn store_pending_deeplink_error(error: &DeepLinkParseError) {
    let mut pending = pending_deeplink_error_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(dropped) = pending.replace(error.clone()) {
        log::warn!(
            "轻量模式下的待处理深链错误被覆盖，丢弃前一条: {}",
            dropped.error
        );
    }
}

// Re-export public API
pub use mcp::import_mcp_from_deeplink;
pub use parser::parse_deeplink_url;
pub use prompt::import_prompt_from_deeplink;
pub use provider::{import_provider_from_deeplink, parse_and_merge_config};
pub use skill::import_skill_from_deeplink;

/// Deep link import request model
///
/// Represents a parsed ccswitch:// URL ready for processing.
/// This struct contains all possible fields for all resource types.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkImportRequest {
    /// Protocol version (e.g., "v1")
    pub version: String,
    /// Resource type to import: "provider" | "prompt" | "mcp" | "skill"
    pub resource: String,

    // ============ Common fields ============
    /// Target application (claude/codex/gemini) - for provider, prompt, skill
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// Resource name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Whether to enable after import (default: false)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,

    // ============ Provider-specific fields ============
    /// Provider homepage URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// API endpoint/base URL (supports comma-separated multiple URLs)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// API key
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Optional provider icon name (maps to built-in SVG)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Optional model name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional notes/description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Optional Haiku model (Claude only, v3.7.1+)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub haiku_model: Option<String>,
    /// Optional Sonnet model (Claude only, v3.7.1+)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sonnet_model: Option<String>,
    /// Optional Opus model (Claude only, v3.7.1+)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opus_model: Option<String>,

    // ============ Prompt-specific fields ============
    /// Base64 encoded Markdown content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Prompt description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    // ============ MCP-specific fields ============
    /// Target applications for MCP (comma-separated: "claude,codex,gemini")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apps: Option<String>,

    // ============ Skill-specific fields ============
    /// GitHub repository (format: "owner/name")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Skill directory name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,

    // ============ Config file fields (v3.8+) ============
    /// Base64 encoded config content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    /// Config format (json/toml)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_format: Option<String>,
    /// Remote config URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_url: Option<String>,

    // ============ Usage script fields (v3.9+) ============
    /// Whether to enable usage query. Defaults to **disabled** — carrying a script
    /// is not itself a decision to run it; the link must say `usageEnabled=true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_enabled: Option<bool>,
    /// Base64 encoded usage query script code
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_script: Option<String>,
    /// Usage query API key (if different from provider API key)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_api_key: Option<String>,
    /// Usage query base URL (if different from provider endpoint)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_base_url: Option<String>,
    /// Usage query access token (for NewAPI template)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_access_token: Option<String>,
    /// Usage query user ID (for NewAPI template)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_user_id: Option<String>,
    /// Auto query interval in minutes (0 to disable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_auto_interval: Option<u64>,
}
