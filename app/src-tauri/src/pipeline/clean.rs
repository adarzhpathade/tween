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
    if !root.exists() {
        return;
    }
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
        None => {
            let default_out = compute_default_output_folder();
            super::resolve_temp_root(None, &default_out.to_string_lossy())
        }
    };
    if tmp.exists() {
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
}

pub fn compute_storage_info(custom_temp: Option<&str>) -> StorageInfo {
    let default_out = compute_default_output_folder();
    let temp_dir_path = super::resolve_temp_root(custom_temp, &default_out.to_string_lossy());
    let mut check_dir = temp_dir_path.clone();
    while !check_dir.exists() {
        if let Some(parent) = check_dir.parent() {
            if parent == check_dir {
                break;
            }
            check_dir = parent.to_path_buf();
        } else {
            break;
        }
    }
    let free = crate::setup::free_disk_space(&check_dir).unwrap_or(0);
    let in_use = calculate_tween_temp_size(&temp_dir_path);
    StorageInfo {
        temp_dir: temp_dir_path.to_string_lossy().to_string(),
        free_bytes: free,
        in_use_bytes: in_use,
    }
}

pub fn execute_clear_temp(custom_temp: Option<&str>) -> std::path::PathBuf {
    let default_out = compute_default_output_folder();
    let temp_dir = super::resolve_temp_root(custom_temp, &default_out.to_string_lossy());
    delete_tween_temp_entries(&temp_dir);
    temp_dir
}

#[tauri::command]
pub fn storage_info(custom_temp: Option<String>) -> Result<StorageInfo, String> {
    Ok(compute_storage_info(custom_temp.as_deref()))
}

#[tauri::command]
pub async fn clear_temp(
    custom_temp: Option<String>,
    state: tauri::State<'_, PipelineState>,
) -> Result<(), String> {
    let lock = state.inner().0.lock().await;
    if lock.is_some() {
        return Err("Cannot clear temporary files while a job is running".into());
    }
    execute_clear_temp(custom_temp.as_deref());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_temp_dir(name: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "tween-test-clean-{}-{}-{}-{}",
            name,
            std::process::id(),
            count,
            nanos
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn test_storage_helpers() {
        let test_root = test_temp_dir("storage");

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

    #[test]
    fn test_storage_info_with_custom_temp() {
        let test_root = test_temp_dir("storage-custom");
        let tween_dir = test_root.join("tween-job-xyz");
        std::fs::create_dir_all(&tween_dir).unwrap();
        std::fs::write(tween_dir.join("frame.png"), vec![0u8; 1024]).unwrap();

        let info = compute_storage_info(Some(&test_root.to_string_lossy()));
        assert_eq!(info.temp_dir, test_root.to_string_lossy().to_string());
        assert_eq!(info.in_use_bytes, 1024);
        assert!(info.free_bytes > 0);

        let _ = std::fs::remove_dir_all(&test_root);
    }

    #[test]
    fn test_clear_temp_with_custom_temp_only_deletes_subfolder_never_parent() {
        let test_root = test_temp_dir("clear-custom");

        // Tween's own subfolder
        let tween_dir = test_root.join("tween-job-1");
        std::fs::create_dir_all(&tween_dir).unwrap();
        std::fs::write(tween_dir.join("frame.png"), vec![0u8; 2048]).unwrap();

        // Another Tween subfolder
        let tween_cache = test_root.join("tween-cache");
        std::fs::create_dir_all(&tween_cache).unwrap();
        std::fs::write(tween_cache.join("cache.dat"), vec![0u8; 512]).unwrap();

        // Non-Tween directory (user's folder)
        let user_dir = test_root.join("my-project");
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("notes.txt"), b"important user notes").unwrap();

        // Non-Tween file (user's file)
        let user_file = test_root.join("document.pdf");
        std::fs::write(&user_file, b"important doc").unwrap();

        // Verify initial state
        assert!(test_root.exists(), "Custom temp root must exist");
        assert_eq!(calculate_tween_temp_size(&test_root), 2048 + 512);

        // Run execute_clear_temp with custom temp folder
        let cleared_dir = execute_clear_temp(Some(&test_root.to_string_lossy()));
        assert_eq!(cleared_dir, test_root);

        // CRITICAL: Parent directory MUST still exist
        assert!(
            test_root.exists(),
            "clear_temp must only delete Tween's own subfolder, never the parent"
        );

        // User files and directories MUST still exist
        assert!(
            user_dir.exists(),
            "Non-Tween user directory must not be deleted by clear_temp"
        );
        assert!(
            user_file.exists(),
            "Non-Tween user file must not be deleted by clear_temp"
        );
        assert_eq!(
            std::fs::read(&user_file).unwrap(),
            b"important doc"
        );

        // Tween's own subfolders MUST be deleted
        assert!(
            !tween_dir.exists(),
            "Tween's own subfolder must be deleted by clear_temp"
        );
        assert!(
            !tween_cache.exists(),
            "Tween's own subfolder must be deleted by clear_temp"
        );
        assert_eq!(calculate_tween_temp_size(&test_root), 0);

        let _ = std::fs::remove_dir_all(&test_root);
    }
}
