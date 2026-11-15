use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColourInfo {
    pub matrix: String,
    pub range: String,
    pub space: String,
    pub primaries: String,
    pub trc: String,
    pub hdr: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ColourInput {
    pub height: u32,
    pub color_space: Option<String>,
    pub color_range: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub file: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub codec: String,
    pub pix_fmt: String,
    pub fps_num: u64,
    pub fps_den: u64,
    pub fps: f64,
    pub vfr: bool,
    pub duration: f64,
    pub frames: u64,
    pub has_audio: bool,
    pub audio_codec: Option<String>,
    pub colour: ColourInfo,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum TargetValue {
    Number(f64),
    String(String),
}

impl TargetValue {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            TargetValue::Number(n) => Some(*n),
            TargetValue::String(s) => s.parse::<f64>().ok(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub mode: String, // "multiplier" | "fps"
    pub value: TargetValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatioResult {
    pub p: u64,
    pub q: u64,
    pub out_fps_expr: String,
    pub out_fps: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub a: usize,
    pub files: usize,
    pub n: usize,
    pub keep: usize,
    pub out_offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkPlan {
    pub total: usize,
    pub chunks: Vec<Chunk>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RifeMapping {
    pub sx: usize,
    pub t: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutFix {
    pub i: usize,
    pub src: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trim {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuConfig {
    pub id: i32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub integrated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineConfig {
    #[serde(default = "default_ffmpeg")]
    pub ffmpeg: String,
    #[serde(default = "default_ffprobe")]
    pub ffprobe: String,
    #[serde(default)]
    pub rife_dir: String,
    #[serde(default = "default_mode")]
    pub mode: String, // "gpu" | "cpu"
    pub gpu: Option<GpuConfig>,
    #[serde(default)]
    pub encoders: Vec<String>,
    #[serde(default)]
    pub models: Vec<String>,
    pub rife_cmd: Option<Vec<String>>,
}

fn default_ffmpeg() -> String {
    "ffmpeg".to_string()
}

fn default_ffprobe() -> String {
    "ffprobe".to_string()
}

fn default_mode() -> String {
    "gpu".to_string()
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            ffmpeg: default_ffmpeg(),
            ffprobe: default_ffprobe(),
            rife_dir: String::new(),
            mode: default_mode(),
            gpu: None,
            encoders: vec!["libx264".to_string()],
            models: vec!["rife-v4.26".to_string()],
            rife_cmd: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub info: ProbeInfo,
    pub target: Target,
    pub model: String,
    pub encoder: String,
    pub quality: Option<u32>,
    pub keep_audio: Option<bool>,
    pub output: String,
    pub temp_root: Option<String>,
    pub trim: Option<Trim>,
    pub scene_detect: Option<bool>,
    pub scene_threshold: Option<f64>,
    pub tta: Option<bool>,
    pub chunk_frames: Option<usize>,
    pub cfg: Option<PipelineConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub stage: String, // "analyse" | "interpolate" | "encode" | "done"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTimes {
    pub analyse_ms: u64,
    pub extract_ms: u64,
    pub rife_ms: u64,
    pub encode_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFinished {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuts: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_temp_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_times: Option<StageTimes>,
}
