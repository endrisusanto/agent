use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    pub pc_id: String,
    pub hub_url: String,
    pub auto_root: String,
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
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunSuitePayload {
    pub run_id: Option<String>,
    pub auto_root: Option<String>,
    pub test_type: String,
    pub laundry_zip_path: Option<String>,
    #[serde(default)]
    pub selected_laundry_results: Vec<String>,
    #[serde(default)]
    pub selected_laundry_rows: Vec<serde_json::Value>,
    pub user_devices: Vec<String>,
    pub userdebug_devices: Vec<String>,
    pub retry_count: u32,
    pub wifi_enabled: bool,
    pub wifi_ssid: String,
    pub wifi_password: String,
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
    pub is_connected: bool,
    pub device_count: usize,
    pub devices: Vec<DeviceInfo>,
    pub zip_count: usize,
    pub recent_logs: Vec<String>,
}
