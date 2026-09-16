use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHostProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub kind: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_connected_at: Option<String>,
    pub last_user_id: Option<String>,
    pub last_username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeConfig {
    pub platform: Option<String>,
    pub host_base_url: Option<String>,
    pub active_host_id: Option<String>,
    pub hosts: Option<Vec<DesktopHostProfile>>,
    pub release_channel: Option<String>,
    pub auto_reconnect: Option<bool>,
    pub auto_check_update: Option<bool>,
    pub onboarding_completed_at: Option<String>,
    pub onboarding_role: Option<String>,
}

fn config_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法解析桌面配置目录: {error}"))?;

    fs::create_dir_all(&config_dir).map_err(|error| format!("无法创建桌面配置目录: {error}"))?;

    Ok(config_dir.join("client-runtime-config.json"))
}

pub fn read_desktop_config(app: &AppHandle) -> Result<DesktopRuntimeConfig, String> {
    let path = config_file_path(app)?;

    if !path.exists() {
        return Ok(DesktopRuntimeConfig::default());
    }

    let raw = fs::read_to_string(&path).map_err(|error| format!("读取桌面配置失败: {error}"))?;

    serde_json::from_str::<DesktopRuntimeConfig>(&raw)
        .map_err(|error| format!("桌面配置格式无效: {error}"))
}

pub fn write_desktop_config(app: &AppHandle, patch: DesktopRuntimeConfig) -> Result<(), String> {
    let path = config_file_path(app)?;
    let mut current = read_desktop_config(app).unwrap_or_default();

    apply_desktop_config_patch(&mut current, patch);

    let payload = serde_json::to_string_pretty(&current)
        .map_err(|error| format!("桌面配置序列化失败: {error}"))?;

    fs::write(&path, payload).map_err(|error| format!("写入桌面配置失败: {error}"))?;

    Ok(())
}

/// 逐字段合并配置补丁：补丁里没带的字段保持原值，不整体覆盖。
fn apply_desktop_config_patch(current: &mut DesktopRuntimeConfig, patch: DesktopRuntimeConfig) {
    if patch.platform.is_some() {
        current.platform = patch.platform;
    }
    if patch.host_base_url.is_some() {
        current.host_base_url = patch.host_base_url;
    }
    if patch.active_host_id.is_some() {
        current.active_host_id = patch.active_host_id;
        current.host_base_url = None;
    }
    if patch.hosts.is_some() {
        current.hosts = patch.hosts;
        current.host_base_url = None;
    }
    if patch.release_channel.is_some() {
        current.release_channel = patch.release_channel;
    }
    if patch.auto_reconnect.is_some() {
        current.auto_reconnect = patch.auto_reconnect;
    }
    if patch.auto_check_update.is_some() {
        current.auto_check_update = patch.auto_check_update;
    }
    if patch.onboarding_completed_at.is_some() {
        current.onboarding_completed_at = patch.onboarding_completed_at;
    }
    if patch.onboarding_role.is_some() {
        current.onboarding_role = patch.onboarding_role;
    }
}

#[cfg(test)]
mod tests {
    use super::{apply_desktop_config_patch, DesktopRuntimeConfig};

    fn parse(raw: &str) -> DesktopRuntimeConfig {
        serde_json::from_str::<DesktopRuntimeConfig>(raw).expect("配置 JSON 应该能解析")
    }

    #[test]
    fn reads_onboarding_marker_from_camel_case_payload() {
        let parsed = parse(
            r#"{"onboardingCompletedAt":"2026-09-16T01:00:00.000Z","onboardingRole":"server"}"#,
        );

        assert_eq!(
            parsed.onboarding_completed_at.as_deref(),
            Some("2026-09-16T01:00:00.000Z")
        );
        assert_eq!(parsed.onboarding_role.as_deref(), Some("server"));
    }

    #[test]
    fn writes_onboarding_marker_back_as_camel_case() {
        let parsed = parse(r#"{"onboardingRole":"client"}"#);
        let serialized = serde_json::to_string(&parsed).expect("配置应该能序列化");

        assert!(serialized.contains(r#""onboardingRole":"client""#), "{serialized}");
        assert!(serialized.contains(r#""onboardingCompletedAt":null"#), "{serialized}");
    }

    #[test]
    fn leaves_onboarding_marker_empty_when_payload_omits_it() {
        let parsed = parse("{}");

        assert!(parsed.onboarding_completed_at.is_none());
        assert!(parsed.onboarding_role.is_none());
    }

    #[test]
    fn patch_keeps_existing_marker_when_patch_omits_it() {
        let mut current = parse(
            r#"{"onboardingCompletedAt":"2026-09-16T01:00:00.000Z","onboardingRole":"server"}"#,
        );

        apply_desktop_config_patch(&mut current, parse(r#"{"autoReconnect":false}"#));

        assert_eq!(
            current.onboarding_completed_at.as_deref(),
            Some("2026-09-16T01:00:00.000Z")
        );
        assert_eq!(current.onboarding_role.as_deref(), Some("server"));
        assert_eq!(current.auto_reconnect, Some(false));
    }

    #[test]
    fn patch_overwrites_onboarding_marker() {
        let mut current = parse(r#"{"onboardingRole":"client"}"#);

        apply_desktop_config_patch(
            &mut current,
            parse(r#"{"onboardingCompletedAt":"2026-09-16T01:00:00.000Z","onboardingRole":"server"}"#),
        );

        assert_eq!(
            current.onboarding_completed_at.as_deref(),
            Some("2026-09-16T01:00:00.000Z")
        );
        assert_eq!(current.onboarding_role.as_deref(), Some("server"));
    }
}
