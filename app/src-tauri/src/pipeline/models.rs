use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDef {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub size: f64,
    pub is_default: bool,
}

pub static MODELS: &[ModelDef] = &[
    ModelDef {
        id: "rife-v4.26",
        name: "Smooth",
        desc: "Newest RIFE model. The best choice for most videos.",
        size: 11.4,
        is_default: true,
    },
    ModelDef {
        id: "rife-v4.25-heavy",
        name: "Detail",
        desc: "Bigger model. Cleaner edges in fast motion, about 2 to 3 times slower.",
        size: 43.4,
        is_default: false,
    },
    ModelDef {
        id: "rife-v4.22-lite",
        name: "Fast",
        desc: "Light model for older or integrated GPUs.",
        size: 9.8,
        is_default: false,
    },
];

pub fn rife_exe(dir: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        dir.join("rife-ncnn-vulkan.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        dir.join("rife-ncnn-vulkan")
    }
}

pub fn rife_stream_exe(dir: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        dir.join("rife-ncnn-vulkan-stream.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        dir.join("rife-ncnn-vulkan-stream")
    }
}
