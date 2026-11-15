use std::path::Path;
use serde::{Deserialize, Serialize};
use crate::pipeline::PipelineState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub temp_dir: String,
    pub free_bytes: u64,
    pub in_use_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultFolders {
    pub output: String,
    pub temp: String,
}

pub fn compute_default_output_folder() -> std::path::PathBuf {
    let base = dirs::video_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Videos")))
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("Tween")
}

pub fn compute_default_folders(custom_temp: Option<String>) -> DefaultFolders {
    let output = compute_default_output_folder().to_string_lossy().to_string();
    let temp = custom_temp
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
    DefaultFolders { output, temp }
}

#[tauri::command]
pub fn default_folders(custom_temp: Option<String>) -> Result<DefaultFolders, String> {
    Ok(compute_default_folders(custom_temp))
}

pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    total += dir_size(&entry.path());
                } else {
                    total += meta.len();
                }
            }
        }
    }
    total
}

pub fn calculate_tween_temp_size(root: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if name.starts_with("tween-") {
                    let p = entry.path();
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_dir() {
                            total += dir_size(&p);
                        } else {
                            total += meta.len();
                        }
                    }
                }
            }
        }
    }
    total
}

pub fn delete_tween_temp_entries(root: &Path) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if name.starts_with("tween-") {
                    let p = entry.path();
                    if p.is_dir() {
                        let _ = std::fs::remove_dir_all(&p);
                    } else if p.is_file() {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
        }
    }
}

pub fn clean_temp(root: Option<&Path>) {
    let tmp = match root {
        Some(r) => r.to_path_buf(),
        None => std::env::temp_dir(),
    };
    if let Ok(entries) = std::fs::read_dir(tmp) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if name.starts_with("tween-") && !name.starts_with("tween-selftest") {
                    let p = entry.path();
                    if p.is_dir() {
                        let _ = std::fs::remove_dir_all(&p);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn storage_info() -> Result<StorageInfo, String> {
    let temp_dir_path = std::env::temp_dir();
    let free = crate::setup::free_disk_space(&temp_dir_path).unwrap_or(0);
    let in_use = calculate_tween_temp_size(&temp_dir_path);
    Ok(StorageInfo {
        temp_dir: temp_dir_path.to_string_lossy().to_string(),
        free_bytes: free,
        in_use_bytes: in_use,
    })
}

#[tauri::command]
pub async fn clear_temp(state: tauri::State<'_, PipelineState>) -> Result<(), String> {
    let lock = state.inner().0.lock().await;
    if lock.is_some() {
        return Err("Cannot clear temporary files while a job is running".into());
    }
    let temp_dir = std::env::temp_dir();
    delete_tween_temp_entries(&temp_dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_storage_helpers() {
        let test_root = std::env::temp_dir().join(format!("tween-test-storage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&test_root);
        std::fs::create_dir_all(&test_root).unwrap();

        let tween_dir = test_root.join("tween-job-123");
        std::fs::create_dir_all(&tween_dir).unwrap();
        std::fs::write(tween_dir.join("frame.png"), vec![0u8; 1024]).unwrap();

        let tween_selftest = test_root.join("tween-selftest");
        std::fs::create_dir_all(&tween_selftest).unwrap();
        std::fs::write(tween_selftest.join("test.bin"), vec![0u8; 2048]).unwrap();

        let other_dir = test_root.join("other-folder");
        std::fs::create_dir_all(&other_dir).unwrap();
        std::fs::write(other_dir.join("file.txt"), vec![0u8; 4096]).unwrap();

        let in_use = calculate_tween_temp_size(&test_root);
        assert_eq!(in_use, 1024 + 2048);

        delete_tween_temp_entries(&test_root);

        assert!(!tween_dir.exists());
        assert!(!tween_selftest.exists());
        assert!(other_dir.exists());
        assert_eq!(calculate_tween_temp_size(&test_root), 0);

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn test_default_folders() {
        let expected_base = dirs::video_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join("Videos")))
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let expected_output = expected_base.join("Tween");
        let existed_before = expected_output.exists();

        let folders = default_folders(None).expect("default_folders should succeed");
        let out_path = std::path::Path::new(&folders.output);

        // Path must end with "Tween"
        assert!(
            out_path.ends_with("Tween"),
            "Default output folder must end with 'Tween', got: {}",
            folders.output
        );
        assert!(!folders.temp.is_empty(), "Default temp folder must not be empty");

        // Verify nothing was created on disk by default_folders
        if !existed_before {
            assert!(
                !out_path.exists(),
                "default_folders must not create output directory on disk: {}",
                folders.output
            );
        }
    }

    #[test]
    fn test_default_folders_with_custom_temp() {
        let custom = "E:\\CustomTemp";
        let folders = default_folders(Some(custom.to_string())).expect("default_folders should succeed");
        assert_eq!(folders.temp, custom);
        assert!(std::path::Path::new(&folders.output).ends_with("Tween"));
    }
}
