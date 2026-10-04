use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;
use zip::ZipArchive;
use crate::types::LaundryResultInfo;

pub fn resolve_zip_path(zip_path: &str) -> Option<PathBuf> {
    let p = Path::new(zip_path);
    if p.is_file() {
        return Some(p.to_path_buf());
    }

    let filename = p.file_name()?.to_string_lossy();

    // 1. Check environment variable CUCIAN_DIR
    if let Ok(cucian_env) = std::env::var("CUCIAN_DIR") {
        let candidate = PathBuf::from(cucian_env).join(filename.as_ref());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 2. Check user HOME Downloads/CUCIAN
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join("Downloads").join("CUCIAN").join(filename.as_ref());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 3. Check all user directories in /home
    if let Ok(entries) = std::fs::read_dir("/home") {
        for entry in entries.flatten() {
            let candidate = entry.path().join("Downloads").join("CUCIAN").join(filename.as_ref());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 4. Known directories
    for dir in &["/home/endri-pro/Downloads/CUCIAN", "/cucian", "/tmp/CUCIAN"] {
        let candidate = PathBuf::from(dir).join(filename.as_ref());
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

pub fn analyze_laundry_zip(zip_path: &str) -> Result<Vec<LaundryResultInfo>, String> {
    let resolved = resolve_zip_path(zip_path)
        .ok_or_else(|| format!("File zip tidak ditemukan: {zip_path}"))?;

    let temp = TempDir::new().map_err(|e| format!("Cannot create temp dir: {e}"))?;
    extract_zip_safe(&resolved, temp.path())?;
    scan_laundry_result_infos(temp.path(), &resolved)
}

fn extract_zip_safe(zip_path: &Path, dst: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("Cannot open zip: {e}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid zip: {e}"))?;

    let mut nested_zips: Vec<PathBuf> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("Zip entry error: {e}"))?;
        let name = file.name();

        let is_xml = name.ends_with("test_result.xml");
        let is_nested_zip = name.ends_with(".zip");

        if !is_xml && !is_nested_zip {
            continue;
        }

        let outpath = match file.enclosed_name() {
            Some(path) => dst.join(path),
            None => continue,
        };

        if let Some(p) = outpath.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let mut outfile = File::create(&outpath).map_err(|e| format!("Cannot write file: {e}"))?;
        let _ = std::io::copy(&mut file, &mut outfile);

        if is_nested_zip {
            nested_zips.push(outpath);
        }
    }

    // Extract nested zips
    for sub_zip in nested_zips {
        if let Some(sub_dst) = sub_zip.parent() {
            let _ = extract_zip_safe(&sub_zip, sub_dst);
        }
    }

    Ok(())
}

fn scan_laundry_result_infos(root: &Path, original_zip_path: &Path) -> Result<Vec<LaundryResultInfo>, String> {
    let mut results = Vec::new();

    let filename_model = original_zip_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .and_then(|name| extract_model_from_name(&name))
        .unwrap_or_default();

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() == "test_result.xml" {
            let xml_path = entry.path();
            if let Ok(content) = std::fs::read_to_string(xml_path) {
                let parsed_suite_name = parse_xml_string_attr(&content, "suite_name").unwrap_or_default();
                let suite = classify_suite(&parsed_suite_name)
                    .or_else(|| {
                        let path_str = xml_path.to_string_lossy().to_lowercase();
                        if path_str.contains("gts") {
                            Some("GTS".to_string())
                        } else if path_str.contains("sts") {
                            Some("STS".to_string())
                        } else if path_str.contains("cts") {
                            Some("CTS".to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| "CTS".to_string());

                let parsed_model = parse_xml_string_attr(&content, "build_model")
                    .or_else(|| parse_xml_string_attr(&content, "build_device"))
                    .or_else(|| parse_xml_entry_value(&content, "build_model"))
                    .unwrap_or_else(|| filename_model.clone());

                let formatted_model = if parsed_model.starts_with("SM-") {
                    parsed_model
                } else if !parsed_model.is_empty() {
                    format!("SM-{}", parsed_model.to_uppercase())
                } else {
                    filename_model.clone()
                };

                let parsed_ap = parse_xml_string_attr(&content, "build_version_incremental")
                    .or_else(|| parse_xml_string_attr(&content, "incremental"))
                    .or_else(|| parse_xml_entry_value(&content, "build_version_incremental"))
                    .or_else(|| parse_xml_entry_value(&content, "ro.build.version.incremental"))
                    .or_else(|| parse_xml_string_attr(&content, "build_id"))
                    .unwrap_or_default();

                let suite_version = parse_xml_string_attr(&content, "suite_version")
                    .or_else(|| parse_xml_string_attr(&content, "suite_build_number"))
                    .unwrap_or_else(|| {
                        if suite == "GTS" {
                            "14_r2".to_string()
                        } else if suite == "STS" {
                            "15_sts-r52".to_string()
                        } else {
                            "15_r9".to_string()
                        }
                    });

                let cmd_args = parse_xml_string_attr(&content, "command_line_args").unwrap_or_default();
                let suite_plan = parse_xml_string_attr(&content, "suite_plan")
                    .or_else(|| parse_xml_string_attr(&content, "plan"))
                    .unwrap_or_default();

                let detected_plan = detect_laundry_plan_kind(&content, xml_path, original_zip_path);

                let start_ms = parse_xml_attr(&content, "start");
                let end_ms = parse_xml_attr(&content, "end");
                let time_str = format_xml_duration(start_ms, end_ms);

                let summary_pass = parse_xml_attr(&content, "pass");
                let summary_fail = parse_xml_attr(&content, "failed");
                let mod_total = parse_xml_attr(&content, "modules_total").unwrap_or(0);
                let mod_done = parse_xml_attr(&content, "modules_done").unwrap_or(0);

                let passed = summary_pass.unwrap_or(mod_done);
                let failed = summary_fail.unwrap_or(0);
                let total = if passed + failed > 0 {
                    passed + failed
                } else {
                    mod_total
                };

                let raw_dir_name = xml_path
                    .parent()
                    .and_then(|p| p.file_name())
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let testcase_title = format!("{suite} {raw_dir_name}");

                let subtestcases_str = if !cmd_args.trim().is_empty() && cmd_args.trim() != "-" {
                    cmd_args.trim().to_string()
                } else if !suite_plan.trim().is_empty() && suite_plan.trim() != "-" {
                    format!("{} --subplan {}", suite.to_lowercase(), suite_plan.trim())
                } else {
                    let r_low = raw_dir_name.to_lowercase();
                    if suite == "GTS" {
                        if r_low.contains("variant") || r_low.contains("sku") {
                            "gts --subplan gts-variant".to_string()
                        } else if r_low.contains("smr") {
                            "gts-smr".to_string()
                        } else {
                            "gts --subplan Normalised".to_string()
                        }
                    } else if suite == "CTS" {
                        "cts --subplan smr".to_string()
                    } else if suite == "STS" {
                        "sts-dynamic-incremental".to_string()
                    } else {
                        format!("{} retry", suite.to_lowercase())
                    }
                };

                let devices_str = parse_xml_string_attr(&content, "devices")
                    .or_else(|| parse_xml_string_attr(&content, "device_serial"))
                    .unwrap_or_default();

                let result_dir_display = if !devices_str.is_empty() {
                    format!("{devices_str} · report-log-files/")
                } else {
                    "report-log-files/".to_string()
                };

                results.push(LaundryResultInfo {
                    id: format!("{}_{}", suite, raw_dir_name),
                    suite,
                    testcase: testcase_title,
                    subtestcases: subtestcases_str,
                    status: "Test Done".to_string(),
                    time: time_str,
                    total,
                    passed,
                    failed,
                    suite_version,
                    result_dir: result_dir_display,
                    model: formatted_model,
                    ap_version: parsed_ap,
                    plan: detected_plan,
                });
            }
        }
    }

    Ok(results)
}

fn classify_suite(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if lower.contains("verifier") || lower.contains("ctsv") {
        None
    } else if lower.contains("cts") || lower.contains("compatibility") {
        Some("CTS".to_string())
    } else if lower.contains("gts") || lower.contains("google") {
        Some("GTS".to_string())
    } else if lower.contains("sts") || lower.contains("security") {
        Some("STS".to_string())
    } else {
        None
    }
}

fn format_xml_duration(start_ms: Option<u64>, end_ms: Option<u64>) -> String {
    match (start_ms, end_ms) {
        (Some(start), Some(end)) if end >= start => {
            let total = (end - start) / 1000;
            let h = total / 3600;
            let m = (total % 3600) / 60;
            let s = total % 60;
            format!("{h:02}:{m:02}:{s:02}")
        }
        _ => "00:00:00".to_string(),
    }
}

fn detect_laundry_plan_kind(content: &str, _xml_path: &Path, original_zip_path: &Path) -> String {
    // 1. Check filename / zip path first
    let zip_str = original_zip_path.to_string_lossy().to_lowercase();
    if zip_str.contains("ctssku") || zip_str.contains("cts_sku") || zip_str.contains("sku") {
        return "SKU".to_string();
    }
    if zip_str.contains("ctssmr") || zip_str.contains("cts_smr") || zip_str.contains("gtsmr") || zip_str.contains("gtssmr") || zip_str.contains("smr") || zip_str.contains("sts") {
        return "SMR".to_string();
    }

    // 2. Extract suite_plan and command_line_args from <Result> tag
    let suite_plan = parse_xml_string_attr(content, "suite_plan").unwrap_or_default().to_lowercase();
    let cmd_args = parse_xml_string_attr(content, "command_line_args").unwrap_or_default().to_lowercase();
    let combined_plan = format!("{suite_plan} {cmd_args}");

    if combined_plan.contains("ctssku") || combined_plan.contains("cts-sku") || combined_plan.contains("subplan ctssku") || combined_plan.contains("subplan sku") {
        return "SKU".to_string();
    }
    if combined_plan.contains("ctssmr") || combined_plan.contains("cts-smr") || combined_plan.contains("gtsmr") || combined_plan.contains("gtssmr") || combined_plan.contains("subplan smr") || combined_plan.contains("sts") {
        return "SMR".to_string();
    }

    "Normal".to_string()
}

fn extract_model_from_name(filename: &str) -> Option<String> {
    let base = filename.strip_suffix(".zip").unwrap_or(filename);
    let first_token = base.split('_').next().unwrap_or(base);

    if first_token.starts_with("SM-") || first_token.starts_with("sm-") {
        return Some(first_token.to_uppercase());
    }

    let mut model_part = String::new();
    for ch in first_token.chars() {
        if ch.is_ascii_alphanumeric() {
            model_part.push(ch);
            if model_part.len() >= 5 && (model_part.ends_with('F') || model_part.ends_with('B') || model_part.ends_with('G') || model_part.ends_with('E') || model_part.ends_with('P') || model_part.ends_with('N') || model_part.ends_with('U') || model_part.ends_with('W')) {
                break;
            }
        } else {
            break;
        }
    }

    if !model_part.is_empty() && model_part.len() >= 4 {
        return Some(format!("SM-{}", model_part.to_uppercase()));
    }
    None
}

fn parse_xml_attr(content: &str, attr: &str) -> Option<u64> {
    let pattern = format!("{attr}=\"");
    if let Some(start) = content.find(&pattern) {
        let rest = &content[start + pattern.len()..];
        if let Some(end) = rest.find('"') {
            return rest[..end].parse().ok();
        }
    }
    None
}

fn parse_xml_string_attr(content: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    if let Some(start) = content.find(&pattern) {
        let rest = &content[start + pattern.len()..];
        if let Some(end) = rest.find('"') {
            let val = rest[..end].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn parse_xml_entry_value(content: &str, entry_name: &str) -> Option<String> {
    let pattern = format!("name=\"{entry_name}\"");
    if let Some(start) = content.find(&pattern) {
        let rest = &content[start + pattern.len()..];
        if let Some(val_idx) = rest.find("value=\"") {
            let val_rest = &rest[val_idx + 7..];
            if let Some(end) = val_rest.find('"') {
                let val = val_rest[..end].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}
