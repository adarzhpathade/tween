//! Ports `src/lib/pipeline.js` to Rust.

pub mod clean;
pub mod encoders;
pub mod models;
pub mod plan;
pub mod probe;
pub mod runner;
pub mod splitter;
pub mod ssim;
pub mod stats;
pub mod types;

#[cfg(test)]
mod e2e_tests;

pub use clean::{
    clean_temp, clear_temp, default_folders, storage_info, DefaultFolders, StorageInfo,
};
pub use encoders::{get_encoder, EncoderDef, ENCODERS};
pub use models::{rife_exe, rife_stream_exe, ModelDef, MODELS};
pub use plan::{
    build_frame_times, chunk_size, chunk_size_with_disk, cut_fixes, deserialize_frame_times, gcd,
    parse_rate, plan_chunks, ratio, rife_map, rife_threads, serialize_frame_times,
};
pub use probe::{colour_of, probe};
pub use runner::{
    fps_mode_args, fps_mode_args_for_support, kill_tree, parse_ffmpeg_version, resolve_temp_root,
    run_pipeline, version_supports_fps_mode,
};
pub use splitter::PngSplitter;
pub use ssim::calculate_ssim;
pub use stats::{sample_system_stats, show_in_folder, SystemMonitorState, SystemStats};
pub use types::{
    Chunk, ChunkPlan, ColourInfo, ColourInput, CutFix, GpuConfig, JobFinished, JobProgressEvent,
    JobRequest, PipelineConfig, ProbeInfo, RatioResult, RifeMapping, StageTimes, Target,
    TargetValue, Trim,
};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

pub struct JobController {
    pub cancel: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct PipelineState(pub Arc<Mutex<Option<JobController>>>);

impl PipelineState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

fn load_or_default_config(app: &tauri::AppHandle) -> PipelineConfig {
    use tauri::Manager;
    if let Ok(app_data) = app.path().app_data_dir() {
        let cfg_path = app_data.join("setup.json");
        if let Ok(content) = std::fs::read_to_string(cfg_path) {
            if let Ok(cfg) = serde_json::from_str::<PipelineConfig>(&content) {
                return cfg;
            }
        }
    }
    PipelineConfig::default()
}

// ==========================================================================
// Asset protocol runtime scope policy:
// Static scope in tauri.conf.json is strictly empty (security.assetProtocol.scope: []).
// We grant runtime access only to specific files the user opened or that the app generates:
// - Source video file explicitly probed or chosen by the user
// - Specific preview frame images emitted during interpolation
// - Target output video file produced by the job
// We NEVER allow broad directories like std::env::temp_dir() or the user's temp root.
// ==========================================================================

#[tauri::command]
pub async fn probe_video(
    app: tauri::AppHandle,
    path: String,
) -> Result<ProbeInfo, String> {
    // Runtime scope: allow only the specific source video file the user opened
    let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(&path));
    let cfg = load_or_default_config(&app);
    probe(&cfg, &path).await
}

#[tauri::command]
pub async fn extract_frame(
    app: tauri::AppHandle,
    path: String,
    time: Option<f64>,
) -> Result<String, String> {
    // Runtime scope: allow only the specific source video file the user opened
    let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(&path));
    let cfg = load_or_default_config(&app);
    probe::extract_frame(&cfg, &path, time).await
}

#[tauri::command]
pub async fn extract_thumbnails(
    app: tauri::AppHandle,
    path: String,
    count: usize,
    height: u32,
) -> Result<Vec<String>, String> {
    // Runtime scope: allow only the specific source video file the user opened
    let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(&path));
    let cfg = load_or_default_config(&app);
    probe::extract_thumbnails(&cfg, &path, count, height).await
}

#[tauri::command]
pub async fn pick_video_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Video", &["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts", "mts", "m2ts", "gif"])
        .pick_file()
        .await;
    if let Some(ref f) = file {
        // Runtime scope: allow only the specific file chosen by the user via file picker
        let _ = app.asset_protocol_scope().allow_file(f.path());
    }
    Ok(file.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn pick_output_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(ref p) = default_path {
        dialog = dialog.set_directory(p);
    }
    let folder = dialog.pick_folder().await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn start_job(
    app: tauri::AppHandle,
    state: tauri::State<'_, PipelineState>,
    job: JobRequest,
) -> Result<(), String> {
    let mut lock = state.inner().0.lock().await;
    if lock.is_some() {
        return Err("A job is already running.".into());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    *lock = Some(JobController {
        cancel: cancel.clone(),
    });
    drop(lock);

    let cfg = match job.cfg.clone() {
        Some(c) => c,
        None => load_or_default_config(&app),
    };

    // Runtime scope: allow the user's source video file and target output file.
    // Note: broad temp folders are never allowed to preserve narrow least-privilege scoping.
    let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(&job.info.file));
    let _ = app.asset_protocol_scope().allow_file(std::path::Path::new(&job.output));

    let app_clone = app.clone();
    let state_clone = state.inner().0.clone();

    tokio::spawn(async move {
        use tauri::Emitter;
        let emit_app = app_clone.clone();
        let emit = move |evt: JobProgressEvent| {
            // Runtime scope: allow each individual preview frame file as it is emitted
            if let Some(ref prev) = evt.preview {
                let _ = emit_app
                    .asset_protocol_scope()
                    .allow_file(std::path::Path::new(prev));
            }
            let _ = emit_app.emit("job-progress", evt);
        };

        let finished = run_pipeline(cfg, job, emit, cancel).await;
        if let Some(ref out) = finished.output {
            let _ = app_clone.asset_protocol_scope().allow_file(std::path::Path::new(out));
        }
        let _ = app_clone.emit("job-finished", &finished);

        let mut lock = state_clone.lock().await;
        *lock = None;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_job(state: tauri::State<'_, PipelineState>) -> Result<(), String> {
    let lock = state.inner().0.lock().await;
    if let Some(ctrl) = lock.as_ref() {
        ctrl.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn make_info24() -> ProbeInfo {
        ProbeInfo {
            file: "test.mp4".into(),
            name: "test.mp4".into(),
            width: 1920,
            height: 1080,
            codec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            fps_num: 24,
            fps_den: 1,
            fps: 24.0,
            vfr: false,
            duration: 10.0,
            frames: 240,
            has_audio: true,
            audio_codec: Some("aac".into()),
            colour: ColourInfo {
                matrix: "bt709".into(),
                range: "tv".into(),
                space: "bt709".into(),
                primaries: "bt709".into(),
                trc: "bt709".into(),
                hdr: false,
            },
            size: 1000,
        }
    }

    fn make_info2398() -> ProbeInfo {
        ProbeInfo {
            file: "test.mp4".into(),
            name: "test.mp4".into(),
            width: 1920,
            height: 1080,
            codec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            fps_num: 24000,
            fps_den: 1001,
            fps: 24000.0 / 1001.0,
            vfr: false,
            duration: 10.0,
            frames: 240,
            has_audio: true,
            audio_codec: Some("aac".into()),
            colour: ColourInfo {
                matrix: "bt709".into(),
                range: "tv".into(),
                space: "bt709".into(),
                primaries: "bt709".into(),
                trc: "bt709".into(),
                hdr: false,
            },
            size: 1000,
        }
    }

    #[test]
    fn test_ratio_multipliers_and_target_fps() {
        let info24 = make_info24();
        let r1 = ratio(
            &info24,
            &Target {
                mode: "multiplier".into(),
                value: TargetValue::Number(2.0),
            },
        );
        assert_eq!(
            r1,
            RatioResult {
                p: 2,
                q: 1,
                out_fps_expr: "48/1".into(),
                out_fps: 48.0,
            }
        );

        let r2 = ratio(
            &info24,
            &Target {
                mode: "fps".into(),
                value: TargetValue::Number(60.0),
            },
        );
        assert_eq!((r2.p as f64) / (r2.q as f64), 2.5);
        assert_eq!(r2.q, 2);

        let info2398 = make_info2398();
        let r3 = ratio(
            &info2398,
            &Target {
                mode: "fps".into(),
                value: TargetValue::Number(60.0),
            },
        );
        assert_eq!(r3.p, 1001);
        assert_eq!(r3.q, 400);
    }

    fn global_positions(count: usize, p: u64, q: u64, chunk_in: usize) -> Vec<f64> {
        let plan = plan_chunks(count, p, q, chunk_in);
        let mut pos = Vec::new();
        for c in &plan.chunks {
            assert_eq!(c.out_offset, pos.len(), "chunks must be contiguous");
            for i in 0..c.keep {
                let m = rife_map(i, c.files, c.n);
                pos.push((c.a + m.sx) as f64 + (m.t as f64));
            }
        }
        assert_eq!(pos.len(), plan.total);
        pos
    }

    #[test]
    fn test_plan_chunks_timeline_cases() {
        let cases: &[(usize, u64, u64, usize)] = &[
            (1000, 2, 1, 100),
            (1007, 3, 1, 64),
            (999, 5, 2, 120),
            (2400, 1001, 400, 450),
            (50, 2, 1, 600),
            (301, 4, 1, 100),
        ];

        for &(count, p, q, chunk) in cases {
            let pos = global_positions(count, p, q, chunk);
            let plan = plan_chunks(count, p, q, chunk);
            let last_start = plan.chunks.last().unwrap().out_offset;
            for (k, &pk) in pos.iter().enumerate() {
                let exact = (k as f64) * (q as f64) / (p as f64);
                if k < last_start {
                    assert!(
                        (pk - exact).abs() < 1e-3,
                        "case ({}, {}, {}, {}): frame {}: {} vs exact {}",
                        count, p, q, chunk, k, pk, exact
                    );
                } else if pk < (count as f64) - 1.0 {
                    assert!(
                        (pk - exact).abs() < 0.5,
                        "case ({}, {}, {}, {}): tail frame {}: {} vs exact {}",
                        count, p, q, chunk, k, pk, exact
                    );
                } else {
                    assert!(
                        exact > (count as f64) - 2.0,
                        "only very end may be held on last frame ({})",
                        k
                    );
                }
            }
            for k in 1..pos.len() {
                assert!(pos[k] >= pos[k - 1], "monotonic");
            }
        }
    }

    #[test]
    fn test_plan_chunks_never_interpolate_past_own_files() {
        let plan = plan_chunks(5000, 5, 2, 200);
        let non_final = &plan.chunks[..plan.chunks.len() - 1];
        for c in non_final {
            for i in 0..c.keep {
                let m = rife_map(i, c.files, c.n);
                assert!(m.sx < c.files - 1);
            }
        }
    }

    #[test]
    fn test_cut_fixes() {
        let ch = Chunk {
            a: 0,
            files: 10,
            n: 20,
            keep: 20,
            out_offset: 0,
        };
        let mut cuts = HashSet::new();
        cuts.insert(5);
        let fixes = cut_fixes(&ch, &cuts);
        assert_eq!(fixes, vec![CutFix { i: 9, src: 5 }]);

        let ch3 = Chunk {
            a: 0,
            files: 10,
            n: 30,
            keep: 30,
            out_offset: 0,
        };
        let fixes3 = cut_fixes(&ch3, &cuts);
        let i_vals: Vec<usize> = fixes3.iter().map(|f| f.i).collect();
        let src_vals: Vec<usize> = fixes3.iter().map(|f| f.src).collect();
        assert_eq!(i_vals, vec![13, 14]);
        assert_eq!(src_vals, vec![4, 5]);
    }

    fn make_test_png(w: u32) -> Vec<u8> {
        let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
        let mut make_chunk = |typ: &[u8; 4], data: &[u8]| {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(typ);
            out.extend_from_slice(data);
            out.extend_from_slice(&[0u8; 4]); // CRC
        };
        let mut ihdr = vec![0u8; 13];
        ihdr[0..4].copy_from_slice(&w.to_be_bytes());
        ihdr[4..8].copy_from_slice(&1u32.to_be_bytes());
        ihdr[8] = 8;
        ihdr[9] = 0;
        make_chunk(b"IHDR", &ihdr);
        make_chunk(b"IDAT", &vec![0u8; (w + 1) as usize]);
        make_chunk(b"IEND", &[]);
        out
    }

    #[test]
    fn test_png_splitter() {
        let imgs = vec![make_test_png(3), make_test_png(50), make_test_png(7)];
        let mut all = Vec::new();
        for img in &imgs {
            all.extend_from_slice(img);
        }

        let steps = [1, 5, 33, all.len()];
        for &step in &steps {
            let mut got = Vec::new();
            let mut splitter = PngSplitter::new();
            let mut offset = 0;
            while offset < all.len() {
                let end = std::cmp::min(offset + step, all.len());
                splitter.push(&all[offset..end], |img| got.push(img));
                offset = end;
            }
            assert_eq!(got.len(), imgs.len(), "Step {} got wrong count", step);
            for (i, img) in imgs.iter().enumerate() {
                assert_eq!(&got[i], img, "Step {} image {} mismatch", step, i);
            }
        }
    }

    #[test]
    fn test_colour_of() {
        assert_eq!(
            colour_of(&ColourInput {
                height: 1080,
                ..Default::default()
            })
            .matrix,
            "bt709"
        );
        assert_eq!(
            colour_of(&ColourInput {
                height: 480,
                ..Default::default()
            })
            .matrix,
            "bt601"
        );
        assert!(colour_of(&ColourInput {
            height: 2160,
            color_space: Some("bt2020nc".into()),
            color_transfer: Some("smpte2084".into()),
            ..Default::default()
        })
        .hdr);
    }

    fn test_temp_dir(name: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "tween-test-pipeline-{}-{}-{}-{}",
            name,
            std::process::id(),
            count,
            nanos
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn test_e2e_fake_rife() {
        let has_ffmpeg = std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_node = std::process::Command::new("node")
            .arg("-v")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !has_ffmpeg || !has_node {
            if std::env::var("TWEEN_REQUIRE_E2E").map(|v| v == "1").unwrap_or(false) {
                panic!("TWEEN_REQUIRE_E2E is set, but ffmpeg or node was not found on PATH (has_ffmpeg={has_ffmpeg}, has_node={has_node})");
            }
            eprintln!("SKIPPING test_e2e_fake_rife: ffmpeg or node not found on PATH");
            return;
        }

        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fake_rife = manifest_dir.join("../../test/fake-rife.js");
        if !fake_rife.exists() {
            if std::env::var("TWEEN_REQUIRE_E2E").map(|v| v == "1").unwrap_or(false) {
                panic!("TWEEN_REQUIRE_E2E is set, but fake-rife.js was not found at {:?}", fake_rife);
            }
            eprintln!("SKIPPING test_e2e_fake_rife: fake-rife.js not found at {:?}", fake_rife);
            return;
        }

        let work = test_temp_dir("fake-rife");

        let clip = work.join("clip.mp4");
        let ff_gen = std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=24:duration=5",
                "-f",
                "lavfi",
                "-i",
                "mandelbrot=size=640x360:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=10",
                "-filter_complex",
                "[1:v]trim=duration=5,setpts=PTS-STARTPTS,format=yuv420p[b];[0:v]format=yuv420p[a];[a][b]concat=n=2:v=1[v]",
                "-map",
                "[v]",
                "-map",
                "2:a",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-shortest",
                clip.to_str().unwrap(),
            ])
            .status();

        assert!(ff_gen.is_ok() && ff_gen.unwrap().success(), "Failed to generate test clip with ffmpeg");

        let cfg = PipelineConfig {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            rife_dir: work.to_string_lossy().to_string(),
            mode: "gpu".into(),
            gpu: Some(GpuConfig {
                id: 0,
                name: Some("Fake GPU".into()),
                integrated: false,
            }),
            encoders: vec!["libx264".into()],
            models: vec!["rife-v4.26".into()],
            rife_cmd: Some(vec!["node".into(), fake_rife.to_string_lossy().to_string()]),
            engine_mode: None,
            rife_stream_cmd: None,
        };

        struct TestCase {
            name: &'static str,
            target: Target,
            expect_fps: f64,
            trim: Option<Trim>,
            chunk_frames: Option<usize>,
            fail_gpu: bool,
            expect_note: bool,
        }

        let cases = vec![
            TestCase {
                name: "2x",
                target: Target {
                    mode: "multiplier".into(),
                    value: TargetValue::Number(2.0),
                },
                expect_fps: 48.0,
                trim: None,
                chunk_frames: None,
                fail_gpu: false,
                expect_note: false,
            },
            TestCase {
                name: "60fps",
                target: Target {
                    mode: "fps".into(),
                    value: TargetValue::Number(60.0),
                },
                expect_fps: 60.0,
                trim: None,
                chunk_frames: None,
                fail_gpu: false,
                expect_note: false,
            },
            TestCase {
                name: "trim-3x",
                target: Target {
                    mode: "multiplier".into(),
                    value: TargetValue::Number(3.0),
                },
                expect_fps: 72.0,
                trim: Some(Trim { start: 2.0, end: 7.0 }),
                chunk_frames: None,
                fail_gpu: false,
                expect_note: false,
            },
            TestCase {
                name: "chunked-2x",
                target: Target {
                    mode: "multiplier".into(),
                    value: TargetValue::Number(2.0),
                },
                expect_fps: 48.0,
                trim: None,
                chunk_frames: Some(37),
                fail_gpu: false,
                expect_note: false,
            },
            TestCase {
                name: "chunked-60fps",
                target: Target {
                    mode: "fps".into(),
                    value: TargetValue::Number(60.0),
                },
                expect_fps: 60.0,
                trim: None,
                chunk_frames: Some(40),
                fail_gpu: false,
                expect_note: false,
            },
            TestCase {
                name: "gpu-fails-cpu-fallback",
                target: Target {
                    mode: "multiplier".into(),
                    value: TargetValue::Number(2.0),
                },
                expect_fps: 48.0,
                trim: None,
                chunk_frames: Some(100),
                fail_gpu: true,
                expect_note: true,
            },
        ];

        for c in cases {
            let clip_str = clip.to_string_lossy().to_string();
            let probe_res = probe(&cfg, &clip_str).await;
            assert!(probe_res.is_ok(), "Failed to probe clip: {:?}", probe_res.err());
            let info = probe_res.unwrap();

            let out_file = work.join(format!("out-{}.mp4", c.name));
            let out_str = out_file.to_string_lossy().to_string();

            if c.fail_gpu {
                std::env::set_var("FAKE_RIFE_FAIL", "1");
            } else {
                std::env::remove_var("FAKE_RIFE_FAIL");
            }

            let note_seen = Arc::new(Mutex::new(None::<String>));
            let note_seen_clone = note_seen.clone();

            let emit = move |evt: JobProgressEvent| {
                if let Some(note) = evt.note {
                    if let Ok(mut lock) = note_seen_clone.try_lock() {
                        *lock = Some(note);
                    }
                }
            };

            let cancel = Arc::new(AtomicBool::new(false));
            let req = JobRequest {
                info,
                target: c.target,
                model: "rife-v4.26".into(),
                encoder: "libx264".into(),
                quality: Some(18),
                keep_audio: Some(true),
                output: out_str.clone(),
                temp_root: Some(work.to_string_lossy().to_string()),
                trim: c.trim.clone(),
                scene_detect: Some(true),
                scene_threshold: Some(10.0),
                tta: Some(false),
                chunk_frames: c.chunk_frames,
                engine_mode: None,
                cfg: Some(cfg.clone()),
            };

            let res = run_pipeline(cfg.clone(), req, emit, cancel).await;
            assert!(res.ok, "Job {} failed: {:?}", c.name, res.error);

            if c.expect_note {
                let note = note_seen.lock().await.clone();
                assert!(note.is_some(), "Expected note for {}", c.name);
            }

            if c.trim.is_none() {
                assert_eq!(res.cuts, Some(1), "Expected 1 scene cut for {}", c.name);
            }

            let out_probe = probe(&cfg, &out_str).await;
            assert!(out_probe.is_ok(), "Failed to probe output: {:?}", out_probe.err());
            let out_info = out_probe.unwrap();

            let dur = if let Some(t) = &c.trim { t.end - t.start } else { 10.0 };
            let ok = (out_info.fps - c.expect_fps).abs() < 0.01
                && (out_info.frames as f64 - dur * c.expect_fps).abs() <= 2.0
                && out_info.has_audio
                && (out_info.duration - dur).abs() < 0.15;

            assert!(
                ok,
                "Output verification failed for {}: fps={}, frames={}, dur={}, has_audio={}",
                c.name, out_info.fps, out_info.frames, out_info.duration, out_info.has_audio
            );
        }

        std::env::remove_var("FAKE_RIFE_FAIL");
        let _ = std::fs::remove_dir_all(&work);
    }
}
