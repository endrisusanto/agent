use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub pc_id: String,
    pub hub_url: String,
    pub auto_root: String,
    #[serde(default)]
    pub cucian_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub serial: String,
    pub state: String,
    pub is_userdebug: bool,
    pub fingerprint: String,
    pub security_patch: String,
    pub android: String,
    pub sdk: String,
    pub sales_code: String,
    pub model: String,
    pub pda: String,
    pub cp: String,
    pub csc: String,
    pub ip: String,
    pub busy: bool,
    pub busy_reason: String,
    pub run_id: Option<String>,
    pub result_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaundryZipItem {
    pub filename: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "modifiedAt")]
    pub modified_at: u64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaundryResultInfo {
    pub id: String,
    pub suite: String,
    pub testcase: String,
    pub subtestcases: String,
    pub status: String,
    pub time: String,
    pub total: u64,
    pub passed: u64,
    pub failed: u64,
    pub suite_version: String,
    pub result_dir: String,
    pub model: String,
    #[serde(default)]
    pub ap_version: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[allow(dead_code)]
pub struct RunSuitePayload {
    pub run_id: Option<String>,
    pub auto_root: Option<String>,
    #[serde(default)]
    pub test_type: String,
    pub target_model: Option<String>,
    pub laundry_zip_path: Option<String>,
    #[serde(default)]
    pub selected_laundry_results: Vec<String>,
    #[serde(default)]
    pub selected_laundry_rows: Vec<serde_json::Value>,
    #[serde(default)]
    pub user_devices: Vec<String>,
    #[serde(default)]
    pub userdebug_devices: Vec<String>,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub wifi_enabled: bool,
    #[serde(default)]
    pub wifi_ssid: String,
    #[serde(default)]
    pub wifi_password: String,
    #[serde(default)]
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BusyRegistry {
    pub devices: HashMap<String, BusyDevice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusyDevice {
    pub serial: String,
    #[serde(default)]
    pub is_userdebug: bool,
    pub test_type: String,
    pub model: String,
    pub pda: String,
    pub run_id: String,
    pub started_at: String,
    pub result_dir: Option<String>,
    pub current_suite: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeLiveStatus {
    pub pc_id: String,
    pub hub_url: String,
    pub auto_root: String,
    pub cucian_dir: String,
    pub is_connected: bool,
    pub device_count: usize,
    pub devices: Vec<DeviceInfo>,
    pub zip_count: usize,
    pub recent_logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightItem {
    pub category: String,
    pub item: String,
    pub status: String, // "OK", "MISSING", "WARN"
    pub details: Option<String>,
    pub path: String,
    pub can_sync: bool,
    pub zip_available: bool,
    pub zip_path: Option<String>,
    pub version: Option<String>,
    pub suite: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightReport {
    pub pc_id: String,
    pub auto_root: String,
    pub items: Vec<PreflightItem>,
    pub scanned_at: u64,
}
