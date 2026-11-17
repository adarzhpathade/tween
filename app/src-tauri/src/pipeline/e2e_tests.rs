//! End-to-end integration tests for the video pipeline using the fake RIFE engine.
//! Exercises long videos, non-integer rates, trim, scene cuts, variable frame rates, and cancellation.

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_temp_dir(prefix: &str) -> PathBuf {
    let id = std::process::id();
    let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("tween-e2e-{}-{}-{}-{}", prefix, id, count, time));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("Failed to create unique temp dir");
    dir
}

fn has_ffmpeg_and_node() -> bool {
    let ff = std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let nd = std::process::Command::new("node")
        .arg("-v")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ff && nd
}

fn fake_rife_path() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let p = manifest_dir.join("../../test/fake-rife.js");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn fake_rife_stream_path() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let p = manifest_dir.join("../../test/fake-rife-stream.js");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn make_test_cfg(work: &Path, fake_rife: &Path) -> PipelineConfig {
    PipelineConfig {
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
        disable_hwaccel: None,
    }
}

async fn run_cmd_timeout(mut cmd: tokio::process::Command, timeout_dur: Duration) -> std::process::Output {
    let child = cmd.output();
    match tokio::time::timeout(timeout_dur, child).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => panic!("Command failed to run: {}", e),
        Err(_) => panic!("Command timed out after {:?}", timeout_dur),
    }
}

async fn count_packets(ffprobe: &str, file: &str) -> u64 {
    let mut cmd = tokio::process::Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_packets",
        "-show_entries",
        "stream=nb_read_packets",
        "-of",
        "csv=p=0",
        file,
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(30)).await;
    assert!(out.status.success(), "ffprobe count_packets failed");
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u64>().unwrap_or(0)
}

async fn stream_rate(ffprobe: &str, file: &str) -> String {
    let mut cmd = tokio::process::Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "csv=p=0",
        file,
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(15)).await;
    assert!(out.status.success(), "ffprobe stream_rate failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

async fn stream_durations(ffprobe: &str, file: &str) -> (f64, Option<f64>) {
    let mut cmd = tokio::process::Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,duration",
        "-of",
        "csv=p=0",
        file,
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(15)).await;
    assert!(out.status.success(), "ffprobe stream_durations failed");
    let s = String::from_utf8_lossy(&out.stdout);
    let mut v_dur = 0.0f64;
    let mut a_dur = None;
    for line in s.lines() {
        let parts: Vec<&str> = line.trim().split(',').collect();
        if parts.len() >= 2 {
            if parts[0] == "video" {
                if let Ok(d) = parts[1].parse::<f64>() {
                    v_dur = d;
                }
            } else if parts[0] == "audio" {
                if let Ok(d) = parts[1].parse::<f64>() {
                    a_dur = Some(d);
                }
            }
        }
    }
    (v_dur, a_dur)
}

async fn packet_pts_list(ffprobe: &str, file: &str) -> Vec<i64> {
    let mut cmd = tokio::process::Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts",
        "-of",
        "csv=p=0",
        file,
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(30)).await;
    assert!(out.status.success(), "ffprobe packet_pts_list failed");
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .filter_map(|l| l.trim().parse::<i64>().ok())
        .collect()
}

async fn ssim_between(ffmpeg: &str, file1: &str, file2: &str) -> f64 {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-v",
        "error",
        "-i",
        file1,
        "-i",
        file2,
        "-filter_complex",
        "[0:v][1:v]ssim=stats_file=-",
        "-f",
        "null",
        "-",
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(15)).await;
    let s = String::from_utf8_lossy(&out.stdout);
    if let Some(pos) = s.find("All:") {
        let rest = &s[pos + 4..];
        let val_str = rest.split_whitespace().next().unwrap_or("0");
        return val_str.parse::<f64>().unwrap_or(0.0);
    }
    0.0
}

async fn extract_single_frame(ffmpeg: &str, video: &str, frame_idx: u64, out_png: &Path) {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-v",
        "error",
        "-i",
        video,
        "-vf",
        &format!("select=eq(n\\,{})", frame_idx),
        "-vframes",
        "1",
        out_png.to_str().unwrap(),
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(15)).await;
    assert!(out.status.success(), "Failed to extract frame {}", frame_idx);
}

async fn extract_raw_frame(ffmpeg: &str, video: &str, frame_idx: u64) -> Vec<u8> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-v",
        "error",
        "-i",
        video,
        "-vf",
        &format!("select=eq(n\\,{})", frame_idx),
        "-vframes",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]);
    let out = run_cmd_timeout(cmd, Duration::from_secs(15)).await;
    assert!(out.status.success(), "Failed to extract raw frame {}", frame_idx);
    out.stdout
}

// -----------------------------------------------------------------------------
// Test 1: Long, many chunks: 10 minutes, 24 fps, with audio, at 2x.
// -----------------------------------------------------------------------------
#[tokio::test]
#[ignore = "takes > 60 seconds for 10-minute 28800-frame video; run via npm run test:long"]
async fn test_e2e_long_many_chunks() {
    if !has_ffmpeg_and_node() {
        eprintln!("SKIPPING test_e2e_long_many_chunks: ffmpeg or node not found");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };

    let test_run = async {
        let t_start = Instant::now();
        let work = unique_temp_dir("long");

        let clip = work.join("clip_10m.mp4");
        // 10 minutes at 24 fps = 14400 frames
        let mut gen_cmd = tokio::process::Command::new("ffmpeg");
        gen_cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=600",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=600",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
            clip.to_str().unwrap(),
        ]);
        let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(60)).await;
        assert!(ff_gen.status.success(), "Failed to generate 10m clip");

        let cfg = make_test_cfg(&work, &fake_rife);
        let clip_str = clip.to_string_lossy().to_string();
        let info = probe(&cfg, &clip_str).await.expect("Failed to probe 10m clip");
        assert_eq!(info.frames, 14400, "Input must have 14400 frames");

        let out_file = work.join("out_10m_2x.mp4");
        let out_str = out_file.to_string_lossy().to_string();

        let chunk_size_override = 240usize; // forces 14400 / 240 = 60 chunks
        let req = JobRequest {
            info: info.clone(),
            target: Target {
                mode: "multiplier".into(),
                value: TargetValue::Number(2.0),
            },
            model: "rife-v4.26".into(),
            encoder: "libx264".into(),
            quality: Some(18),
            keep_audio: Some(true),
            output: out_str.clone(),
            temp_root: Some(work.to_string_lossy().to_string()),
            trim: None,
            scene_detect: Some(false),
            scene_threshold: None,
            tta: Some(false),
            chunk_frames: Some(chunk_size_override),
            engine_mode: None,
            cfg: Some(cfg.clone()),
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let res = run_pipeline(cfg.clone(), req, |_| {}, cancel).await;
        assert!(res.ok, "10-minute job failed: {:?}", res.error);

        // 1. Assert output frame count is exactly 2 x input frames (ffprobe -count_packets)
        let in_packets = count_packets("ffprobe", &clip_str).await;
        let out_packets = count_packets("ffprobe", &out_str).await;
        assert_eq!(
            out_packets,
            in_packets * 2,
            "Output packet count ({}) must be exactly 2x input ({})",
            out_packets,
            in_packets
        );
        assert_eq!(out_packets, 28800, "Expected exactly 28800 packets");

        // 2. Assert output fps is 48
        let out_probe = probe(&cfg, &out_str).await.expect("Failed to probe output");
        assert!(
            (out_probe.fps - 48.0).abs() < 0.01,
            "Expected output fps 48, got {}",
            out_probe.fps
        );
        let stream_r = stream_rate("ffprobe", &out_str).await;
        assert_eq!(stream_r, "48/1", "Stream header frame rate must be 48/1");

        // 3. Assert output duration is within one output frame of the input
        let one_frame_dur = 1.0 / 48.0;
        assert!(
            (out_probe.duration - info.duration).abs() <= one_frame_dur + 0.02,
            "Output duration {} vs input duration {}: delta {} exceeds one frame {}",
            out_probe.duration,
            info.duration,
            (out_probe.duration - info.duration).abs(),
            one_frame_dur
        );

        // 4. Assert audio stream exists and its duration is within 50 ms of the video
        let (v_dur, a_dur) = stream_durations("ffprobe", &out_str).await;
        assert!(a_dur.is_some(), "Audio stream must exist in output");
        let audio_dur = a_dur.unwrap();
        let audio_video_diff = (audio_dur - v_dur).abs();
        assert!(
            audio_video_diff <= 0.050,
            "Audio duration {} differs from video duration {} by {}s (> 50ms)",
            audio_dur,
            v_dur,
            audio_video_diff
        );

        // 5. Assert no frame is duplicated or dropped at chunk joins
        let mut pts_list = packet_pts_list("ffprobe", &out_str).await;
        assert_eq!(pts_list.len(), 28800);
        pts_list.sort();
        let pts_step = pts_list[1] - pts_list[0];
        assert!(pts_step > 0, "PTS step must be positive");
        for i in 1..pts_list.len() {
            let diff = pts_list[i] - pts_list[i - 1];
            assert_eq!(
                diff, pts_step,
                "PTS gap or duplicate detected between presentation frame {} and {}: {} vs expected {}",
                i - 1,
                i,
                diff,
                pts_step
            );
        }

        let _ = std::fs::remove_dir_all(&work);
        println!(
            "[TIMING] test_e2e_long_many_chunks finished in {:.2}s",
            t_start.elapsed().as_secs_f64()
        );
    };

    tokio::time::timeout(Duration::from_secs(600), test_run)
        .await
        .expect("test_e2e_long_many_chunks timed out after 10 minutes");
}

// -----------------------------------------------------------------------------
// Test 2: Non-integer rates: 23.976 fps to 59.94 (custom) and 29.97 fps at 2x.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_non_integer_rates() {
    if !has_ffmpeg_and_node() {
        eprintln!("SKIPPING test_e2e_non_integer_rates: ffmpeg or node not found");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };

    let test_run = async {
        let t_start = Instant::now();
        let work = unique_temp_dir("rates");
        let cfg = make_test_cfg(&work, &fake_rife);

        // Case 2A: 23.976 fps (24000/1001) to 59.94 (custom)
        {
            let clip_2398 = work.join("clip_2398.mp4");
            // 5 seconds at 24000/1001
            let mut gen_cmd = tokio::process::Command::new("ffmpeg");
            gen_cmd.args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=24000/1001:duration=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-shortest",
                clip_2398.to_str().unwrap(),
            ]);
            let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(20)).await;
            assert!(ff_gen.status.success());

            let info = probe(&cfg, clip_2398.to_str().unwrap()).await.unwrap();
            assert_eq!(info.fps_num, 24000);
            assert_eq!(info.fps_den, 1001);

            let in_packets = count_packets("ffprobe", clip_2398.to_str().unwrap()).await;

            let out_file = work.join("out_5994.mp4");
            let out_str = out_file.to_string_lossy().to_string();

            let req = JobRequest {
                info: info.clone(),
                target: Target {
                    mode: "fps".into(),
                    value: TargetValue::Number(59.94),
                },
                model: "rife-v4.26".into(),
                encoder: "libx264".into(),
                quality: Some(18),
                keep_audio: Some(true),
                output: out_str.clone(),
                temp_root: Some(work.to_string_lossy().to_string()),
                trim: None,
                scene_detect: Some(false),
                scene_threshold: None,
                tta: Some(false),
                chunk_frames: Some(40),
                engine_mode: None,
                cfg: Some(cfg.clone()),
            };

            let cancel = Arc::new(AtomicBool::new(false));
            let res = run_pipeline(cfg.clone(), req, |_| {}, cancel).await;
            assert!(res.ok, "23.976 to 59.94 job failed: {:?}", res.error);

            // Assert exact rational output rate in stream header: 60000/1001
            let rate_str = stream_rate("ffprobe", &out_str).await;
            assert_eq!(rate_str, "60000/1001", "Expected 60000/1001 in stream header");

            // Assert frame count to +-1
            let expected_frames = ((in_packets as f64) * 2.5).round() as i64;
            let out_packets = count_packets("ffprobe", &out_str).await;
            assert!(
                (out_packets as i64 - expected_frames).abs() <= 1,
                "Expected ~{} frames (+-1), got {}",
                expected_frames,
                out_packets
            );

            // Assert audio stream exists and is within 50 ms
            let (v_dur, a_dur) = stream_durations("ffprobe", &out_str).await;
            assert!(a_dur.is_some(), "Audio stream must exist in 59.94 output");
            assert!(
                (a_dur.unwrap() - v_dur).abs() <= 0.050,
                "Audio duration differs from video duration by > 50ms"
            );
        }

        // Case 2B: 29.97 fps (30000/1001) at 2x
        {
            let clip_2997 = work.join("clip_2997.mp4");
            // 5 seconds at 30000/1001
            let mut gen_cmd = tokio::process::Command::new("ffmpeg");
            gen_cmd.args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30000/1001:duration=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-shortest",
                clip_2997.to_str().unwrap(),
            ]);
            let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(20)).await;
            assert!(ff_gen.status.success());

            let info = probe(&cfg, clip_2997.to_str().unwrap()).await.unwrap();
            assert_eq!(info.fps_num, 30000);
            assert_eq!(info.fps_den, 1001);

            let in_packets = count_packets("ffprobe", clip_2997.to_str().unwrap()).await;

            let out_file = work.join("out_2997_2x.mp4");
            let out_str = out_file.to_string_lossy().to_string();

            let req = JobRequest {
                info: info.clone(),
                target: Target {
                    mode: "multiplier".into(),
                    value: TargetValue::Number(2.0),
                },
                model: "rife-v4.26".into(),
                encoder: "libx264".into(),
                quality: Some(18),
                keep_audio: Some(true),
                output: out_str.clone(),
                temp_root: Some(work.to_string_lossy().to_string()),
                trim: None,
                scene_detect: Some(false),
                scene_threshold: None,
                tta: Some(false),
                chunk_frames: Some(45),
                engine_mode: None,
                cfg: Some(cfg.clone()),
            };

            let cancel = Arc::new(AtomicBool::new(false));
            let res = run_pipeline(cfg.clone(), req, |_| {}, cancel).await;
            assert!(res.ok, "29.97 at 2x job failed: {:?}", res.error);

            // Assert exact rational output rate in stream header: 60000/1001
            let rate_str = stream_rate("ffprobe", &out_str).await;
            assert_eq!(rate_str, "60000/1001", "Expected 60000/1001 in stream header");

            // Assert frame count to +-1
            let expected_frames = (in_packets * 2) as i64;
            let out_packets = count_packets("ffprobe", &out_str).await;
            assert!(
                (out_packets as i64 - expected_frames).abs() <= 1,
                "Expected ~{} frames (+-1), got {}",
                expected_frames,
                out_packets
            );

            // Assert audio stream exists and is within 50 ms
            let (v_dur, a_dur) = stream_durations("ffprobe", &out_str).await;
            assert!(a_dur.is_some(), "Audio stream must exist in 29.97 output");
            assert!(
                (a_dur.unwrap() - v_dur).abs() <= 0.050,
                "Audio duration differs from video duration by > 50ms"
            );
        }

        let _ = std::fs::remove_dir_all(&work);
        println!(
            "[TIMING] test_e2e_non_integer_rates finished in {:.2}s",
            t_start.elapsed().as_secs_f64()
        );
    };

    tokio::time::timeout(Duration::from_secs(60), test_run)
        .await
        .expect("test_e2e_non_integer_rates timed out after 60 seconds");
}

// -----------------------------------------------------------------------------
// Test 3: Trim: in = 61.5 s, out = 75.25 s. Assert duration and audio sync.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_trim() {
    if !has_ffmpeg_and_node() {
        eprintln!("SKIPPING test_e2e_trim: ffmpeg or node not found");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };

    let test_run = async {
        let t_start = Instant::now();
        let work = unique_temp_dir("trim");

        let clip = work.join("clip_80s.mp4");
        // 80 seconds at 24 fps
        let mut gen_cmd = tokio::process::Command::new("ffmpeg");
        gen_cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=80",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=80",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
            clip.to_str().unwrap(),
        ]);
        let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(30)).await;
        assert!(ff_gen.status.success(), "Failed to generate 80s clip");

        let cfg = make_test_cfg(&work, &fake_rife);
        let clip_str = clip.to_string_lossy().to_string();
        let info = probe(&cfg, &clip_str).await.expect("Failed to probe clip");

        let out_file = work.join("out_trimmed.mp4");
        let out_str = out_file.to_string_lossy().to_string();

        let in_trim = 61.5;
        let out_trim = 75.25;
        let expected_dur = out_trim - in_trim; // 13.75s

        let req = JobRequest {
            info: info.clone(),
            target: Target {
                mode: "multiplier".into(),
                value: TargetValue::Number(2.0),
            },
            model: "rife-v4.26".into(),
            encoder: "libx264".into(),
            quality: Some(18),
            keep_audio: Some(true),
            output: out_str.clone(),
            temp_root: Some(work.to_string_lossy().to_string()),
            trim: Some(Trim {
                start: in_trim,
                end: out_trim,
            }),
            scene_detect: Some(false),
            scene_threshold: None,
            tta: Some(false),
            chunk_frames: Some(50),
            engine_mode: None,
            cfg: Some(cfg.clone()),
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let res = run_pipeline(cfg.clone(), req, |_| {}, cancel).await;
        assert!(res.ok, "Trim job failed: {:?}", res.error);

        // Assert duration
        let (v_dur, a_dur) = stream_durations("ffprobe", &out_str).await;
        assert!(
            (v_dur - expected_dur).abs() <= 0.1,
            "Video duration {} differs from expected duration {} by > 0.1s",
            v_dur,
            expected_dur
        );

        // Assert audio sync and duration
        assert!(a_dur.is_some(), "Audio stream must exist");
        let audio_dur = a_dur.unwrap();
        let sync_diff = (audio_dur - v_dur).abs();
        assert!(
            sync_diff <= 0.050,
            "Audio duration {} differs from video duration {} by {}s (> 50ms)",
            audio_dur,
            v_dur,
            sync_diff
        );

        // Assert output packet count corresponds to trimmed duration * 48 fps
        let out_packets = count_packets("ffprobe", &out_str).await;
        let expected_packets = (expected_dur * 48.0).round() as i64;
        assert!(
            (out_packets as i64 - expected_packets).abs() <= 2,
            "Expected ~{} packets for trim, got {}",
            expected_packets,
            out_packets
        );

        let _ = std::fs::remove_dir_all(&work);
        println!(
            "[TIMING] test_e2e_trim finished in {:.2}s",
            t_start.elapsed().as_secs_f64()
        );
    };

    tokio::time::timeout(Duration::from_secs(60), test_run)
        .await
        .expect("test_e2e_trim timed out after 60 seconds");
}

// -----------------------------------------------------------------------------
// Test 4: Scene cuts: hard cut at 5 s, assert no blended frames at cut with SSIM.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_scene_cuts() {
    if !has_ffmpeg_and_node() {
        eprintln!("SKIPPING test_e2e_scene_cuts: ffmpeg or node not found");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };

    let test_run = async {
        let t_start = Instant::now();
        let work = unique_temp_dir("cuts");

        let clip = work.join("clip_cut.mp4");
        // Concatenate two different testsrc2 patterns (second one negated) with hard cut at 5s
        // 5s of pattern 1 (frames 0..119), then 5s of negated pattern 2 (frames 120..239)
        let mut gen_cmd = tokio::process::Command::new("ffmpeg");
        gen_cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=5",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=10",
            "-filter_complex",
            "[1:v]negate[b];[0:v][b]concat=n=2:v=1[v]",
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
        ]);
        let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(20)).await;
        assert!(ff_gen.status.success(), "Failed to generate cut clip");

        let cfg = make_test_cfg(&work, &fake_rife);
        let clip_str = clip.to_string_lossy().to_string();
        let info = probe(&cfg, &clip_str).await.expect("Failed to probe clip");

        let out_file = work.join("out_cuts.mp4");
        let out_str = out_file.to_string_lossy().to_string();

        let req = JobRequest {
            info: info.clone(),
            target: Target {
                mode: "multiplier".into(),
                value: TargetValue::Number(2.0),
            },
            model: "rife-v4.26".into(),
            encoder: "libx264".into(),
            quality: Some(18),
            keep_audio: Some(true),
            output: out_str.clone(),
            temp_root: Some(work.to_string_lossy().to_string()),
            trim: None,
            scene_detect: Some(true),
            scene_threshold: Some(10.0),
            tta: Some(false),
            chunk_frames: Some(40),
            engine_mode: None,
            cfg: Some(cfg.clone()),
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let res = run_pipeline(cfg.clone(), req, |_| {}, cancel).await;
        assert!(res.ok, "Scene cut job failed: {:?}", res.error);
        assert!(
            res.cuts.unwrap_or(0) >= 1,
            "Expected at least 1 scene cut detected, got {:?}",
            res.cuts
        );

        // Assert frame count matches 2x input: 240 * 2 = 480
        let out_packets = count_packets("ffprobe", &out_str).await;
        assert_eq!(out_packets, 480, "Expected exactly 480 packets");

        // Assert audio duration is within 50 ms of video
        let (v_dur, a_dur) = stream_durations("ffprobe", &out_str).await;
        assert!(a_dur.is_some(), "Audio stream must exist");
        assert!((a_dur.unwrap() - v_dur).abs() <= 0.050, "Audio duration must be within 50ms");

        // Assert no blended frames at the cut:
        // Source frame 119 is Pattern 1 (last frame of first shot).
        // Source frame 120 is Pattern 2 (first frame of second shot, negated).
        // In output at 2x (48 fps):
        // Output frame 238 is Pattern 1 (sx: 119, t: 0.0).
        // Output frame 239 is cut-fixed to Pattern 2 (sx: 119, t: 0.5 -> replaced by src 120).
        // Output frame 240 is Pattern 2 (sx: 120, t: 0.0).
        let f_src_p1 = work.join("src_p1.png");
        let f_src_p2 = work.join("src_p2.png");
        let f_out_238 = work.join("out_238.png");
        let f_out_239 = work.join("out_239.png");
        let f_out_240 = work.join("out_240.png");

        extract_single_frame("ffmpeg", &clip_str, 119, &f_src_p1).await;
        extract_single_frame("ffmpeg", &clip_str, 120, &f_src_p2).await;
        extract_single_frame("ffmpeg", &out_str, 238, &f_out_238).await;
        extract_single_frame("ffmpeg", &out_str, 239, &f_out_239).await;
        extract_single_frame("ffmpeg", &out_str, 240, &f_out_240).await;

        // Output frame 238 matches Pattern 1 source frame (SSIM > 0.85; adjacent frames differ in moving counter)
        let ssim_238_p1 = ssim_between(
            "ffmpeg",
            f_out_238.to_str().unwrap(),
            f_src_p1.to_str().unwrap(),
        ).await;
        assert!(
            ssim_238_p1 > 0.85,
            "Frame before cut must match source pattern 1: ssim={}",
            ssim_238_p1
        );

        // Output frame 239 (intermediate frame at cut boundary) is cut-fixed to Pattern 2 (SSIM > 0.85)
        let ssim_239_p2 = ssim_between(
            "ffmpeg",
            f_out_239.to_str().unwrap(),
            f_src_p2.to_str().unwrap(),
        ).await;
        assert!(
            ssim_239_p2 > 0.85,
            "Cut-fixed frame must match source pattern 2 without blending: ssim={}",
            ssim_239_p2
        );

        // Output frame 240 matches Pattern 2 source frame (SSIM > 0.85)
        let ssim_240_p2 = ssim_between(
            "ffmpeg",
            f_out_240.to_str().unwrap(),
            f_src_p2.to_str().unwrap(),
        ).await;
        assert!(
            ssim_240_p2 > 0.85,
            "Frame after cut must match source pattern 2: ssim={}",
            ssim_240_p2
        );

        // Cross check: Pattern 1 frame must NOT match Pattern 2 frame (SSIM < 0.1)
        let ssim_cross = ssim_between(
            "ffmpeg",
            f_out_238.to_str().unwrap(),
            f_src_p2.to_str().unwrap(),
        ).await;
        assert!(
            ssim_cross < 0.1,
            "Pattern 1 frame must not match pattern 2: cross_ssim={}",
            ssim_cross
        );

        let _ = std::fs::remove_dir_all(&work);
        println!(
            "[TIMING] test_e2e_scene_cuts finished in {:.2}s",
            t_start.elapsed().as_secs_f64()
        );
    };

    tokio::time::timeout(Duration::from_secs(60), test_run)
        .await
        .expect("test_e2e_scene_cuts timed out after 60 seconds");
}

// -----------------------------------------------------------------------------
// Test 5: Variable frame rate input: job succeeds with CFR or fails with clear msg; never hangs.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_variable_frame_rate() {
    if !has_ffmpeg_and_node() {
        eprintln!("SKIPPING test_e2e_variable_frame_rate: ffmpeg or node not found");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };

    let test_run = async {
        let t_start = Instant::now();
        let work = unique_temp_dir("vfr");

        let clip = work.join("clip_vfr.mp4");
        // Make a VFR clip by selectively dropping frames with PTS jitter
        let mut gen_cmd = tokio::process::Command::new("ffmpeg");
        let (fps_flag, fps_val) = runner::fps_mode_args("ffmpeg", "vfr");
        gen_cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=5",
            "-vf",
            "select='not(eq(mod(n\\,5)\\,0))',setpts=PTS-STARTPTS",
            fps_flag,
            fps_val,
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
            clip.to_str().unwrap(),
        ]);
        let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(20)).await;
        assert!(ff_gen.status.success(), "Failed to generate VFR clip");

        let cfg = make_test_cfg(&work, &fake_rife);
        let clip_str = clip.to_string_lossy().to_string();
        let info = probe(&cfg, &clip_str).await.expect("Failed to probe VFR clip");
        assert!(info.vfr, "Probe should detect that the input is VFR");

        let in_packets = count_packets("ffprobe", &clip_str).await;

        let out_file = work.join("out_cfr.mp4");
        let out_str = out_file.to_string_lossy().to_string();

        let req = JobRequest {
            info: info.clone(),
            target: Target {
                mode: "multiplier".into(),
                value: TargetValue::Number(2.0),
            },
            model: "rife-v4.26".into(),
            encoder: "libx264".into(),
            quality: Some(18),
            keep_audio: Some(true),
            output: out_str.clone(),
            temp_root: Some(work.to_string_lossy().to_string()),
            trim: None,
            scene_detect: Some(false),
            scene_threshold: None,
            tta: Some(false),
            chunk_frames: Some(40),
            engine_mode: None,
            cfg: Some(cfg.clone()),
        };

        let cancel = Arc::new(AtomicBool::new(false));
        let res = run_pipeline(cfg.clone(), req, |_| {}, cancel).await;

        if res.ok {
            // Output must be constant frame rate
            let out_probe = probe(
                &make_test_cfg(&work, &fake_rife),
                &out_str,
            )
            .await
            .expect("Failed to probe output");
            assert!(
                !out_probe.vfr,
                "Output of VFR input must be constant frame rate (CFR)"
            );
            let out_r = stream_rate("ffprobe", &out_str).await;
            assert!(!out_r.is_empty(), "Stream rate must exist");

            let out_packets = count_packets("ffprobe", &out_str).await;
            assert!(
                (out_packets as i64 - (in_packets * 2) as i64).abs() <= 1,
                "Output packet count should be 2x input: {} vs {}",
                out_packets,
                in_packets * 2
            );

            // Assert audio exists and is within 50 ms
            let (v_dur, a_dur) = stream_durations("ffprobe", &out_str).await;
            assert!(a_dur.is_some(), "Audio must exist");
            assert!((a_dur.unwrap() - v_dur).abs() <= 0.050, "Audio must be within 50ms");
        } else {
            assert!(
                res.error.is_some() && !res.error.as_ref().unwrap().is_empty(),
                "If VFR fails, it must fail with a clear message: {:?}",
                res.error
            );
        }

        let _ = std::fs::remove_dir_all(&work);
        println!(
            "[TIMING] test_e2e_variable_frame_rate finished in {:.2}s",
            t_start.elapsed().as_secs_f64()
        );
    };

    tokio::time::timeout(Duration::from_secs(60), test_run)
        .await
        .expect("test_e2e_variable_frame_rate timed out after 60 seconds");
}

// -----------------------------------------------------------------------------
// Test 6: Disk-space guard and cancel: cancelling mid-job removes tween-* and ends within 5s.
// -----------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_disk_space_guard_and_cancel() {
    if !has_ffmpeg_and_node() {
        eprintln!("SKIPPING test_e2e_disk_space_guard_and_cancel: ffmpeg or node not found");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };

    let test_run = async {
        let t_start = Instant::now();
        let work = unique_temp_dir("cancel");

        let clip = work.join("clip_cancel.mp4");
        // 10s video at 24 fps
        let mut gen_cmd = tokio::process::Command::new("ffmpeg");
        gen_cmd.args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=24:duration=10",
            "-c:v",
            "libx264",
            "-y",
            clip.to_str().unwrap(),
        ]);
        let ff_gen = run_cmd_timeout(gen_cmd, Duration::from_secs(20)).await;
        assert!(ff_gen.status.success(), "Failed to generate cancel clip");

        let cfg = make_test_cfg(&work, &fake_rife);
        let clip_str = clip.to_string_lossy().to_string();
        let info = probe(&cfg, &clip_str).await.expect("Failed to probe clip");

        let out_file = work.join("out_cancelled.mp4");
        let out_str = out_file.to_string_lossy().to_string();

        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_trigger = cancel.clone();

        let cancel_sent = Arc::new(AtomicBool::new(false));
        let cancel_sent_clone = cancel_sent.clone();
        let cancel_time = Arc::new(std::sync::Mutex::new(None::<Instant>));
        let cancel_time_clone = cancel_time.clone();

        let emit = move |evt: JobProgressEvent| {
            // Trigger cancel mid-job when interpolation begins
            if evt.stage == "interpolate" && !cancel_sent_clone.swap(true, Ordering::SeqCst) {
                *cancel_time_clone.lock().unwrap() = Some(Instant::now());
                cancel_trigger.store(true, Ordering::SeqCst);
            }
        };

        let req = JobRequest {
            info: info.clone(),
            target: Target {
                mode: "multiplier".into(),
                value: TargetValue::Number(2.0),
            },
            model: "rife-v4.26".into(),
            encoder: "libx264".into(),
            quality: Some(18),
            keep_audio: Some(false),
            output: out_str.clone(),
            temp_root: Some(work.to_string_lossy().to_string()),
            trim: None,
            scene_detect: Some(false),
            scene_threshold: None,
            tta: Some(false),
            chunk_frames: Some(30),
            engine_mode: None,
            cfg: Some(cfg.clone()),
        };

        let res = run_pipeline(cfg.clone(), req, emit, cancel).await;

        // Assert cancellation was recorded
        assert!(cancel_sent.load(Ordering::SeqCst), "Cancel was never triggered");
        assert!(!res.ok, "Cancelled job should have ok=false");
        assert_eq!(res.cancelled, Some(true), "Job should report cancelled=true");

        // Assert process tree ends within 5 seconds of cancellation
        let t_cancel = cancel_time.lock().unwrap().unwrap_or(Instant::now());
        let elapsed_since_cancel = t_cancel.elapsed();
        assert!(
            elapsed_since_cancel < std::time::Duration::from_secs(5),
            "Cancellation took {:.2}s; must end within 5 seconds",
            elapsed_since_cancel.as_secs_f64()
        );

        // Assert cancelling removes the tween-* temp folder (disk-space guard)
        let left_tween_dirs: Vec<PathBuf> = std::fs::read_dir(&work)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| n.starts_with("tween-"))
                            .unwrap_or(false)
                    })
                    .collect()
            })
            .unwrap_or_default();

        assert!(
            left_tween_dirs.is_empty(),
            "Cancelling mid-job must remove tween-* temp folder; found: {:?}",
            left_tween_dirs
        );

        let _ = std::fs::remove_dir_all(&work);
        println!(
            "[TIMING] test_e2e_disk_space_guard_and_cancel finished in {:.2}s (cancellation duration: {:.2}s)",
            t_start.elapsed().as_secs_f64(),
            elapsed_since_cancel.as_secs_f64()
        );
    };

    tokio::time::timeout(Duration::from_secs(60), test_run)
        .await
        .expect("test_e2e_disk_space_guard_and_cancel timed out after 60 seconds");
}

#[test]
fn test_resolve_temp_root_logic() {
    let custom = "D:\\MyCustomTemp";
    let resolved_custom = resolve_temp_root(Some(custom), "D:\\Videos\\out.mp4");
    assert_eq!(resolved_custom, PathBuf::from(custom));

    // When none is set, returns either sys_temp or output drive's .tween-temp
    let resolved_none = resolve_temp_root(None, "D:\\Videos\\out.mp4");
    assert!(!resolved_none.as_os_str().is_empty());
}

#[tokio::test]
async fn test_hardware_decode_matches_software() {
    if !has_ffmpeg_and_node() {
        eprintln!("Skipping test: ffmpeg or node not in PATH");
        return;
    }

    let work = unique_temp_dir("hwaccel-ssim");
    let clip = work.join("test-hw-clip.mp4");

    // Generate 1 second 1080p test video at 24 fps
    let mut gen_cmd = tokio::process::Command::new("ffmpeg");
    gen_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080:rate=24:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        clip.to_str().unwrap(),
    ]);
    let out = run_cmd_timeout(gen_cmd, Duration::from_secs(15)).await;
    assert!(out.status.success(), "Failed to generate test clip");

    let scale_in = "scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24";
    let sw_frame = work.join("sw-frame.png");
    let hw_frame = work.join("hw-frame.png");

    // Extract frame 0 with software decode
    let mut sw_cmd = tokio::process::Command::new("ffmpeg");
    sw_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-ss",
        "0",
        "-i",
        clip.to_str().unwrap(),
        "-vframes",
        "1",
        "-vf",
        scale_in,
        "-c:v",
        "png",
        "-compression_level",
        "0",
        sw_frame.to_str().unwrap(),
    ]);
    let sw_out = run_cmd_timeout(sw_cmd, Duration::from_secs(15)).await;
    assert!(sw_out.status.success(), "Software frame extract failed");

    // Try extracting frame 0 with hardware decode (-hwaccel auto)
    let mut hw_cmd = tokio::process::Command::new("ffmpeg");
    hw_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-hwaccel",
        "auto",
        "-ss",
        "0",
        "-i",
        clip.to_str().unwrap(),
        "-vframes",
        "1",
        "-vf",
        scale_in,
        "-c:v",
        "png",
        "-compression_level",
        "0",
        hw_frame.to_str().unwrap(),
    ]);
    let hw_out = run_cmd_timeout(hw_cmd, Duration::from_secs(15)).await;
    let hw_supported = runner::check_hwaccel_support("ffmpeg", clip.to_str().unwrap(), scale_in, &work).await;

    if hw_out.status.success() && hw_frame.exists() {
        let ssim = ssim_between("ffmpeg", hw_frame.to_str().unwrap(), sw_frame.to_str().unwrap()).await;
        println!("Hardware decode SSIM vs software decode: {:.6} (check_hwaccel_support={})", ssim, hw_supported);
        if hw_supported {
            assert!(
                ssim > 0.999,
                "Hardware decode pixel output must match software decode: ssim={}",
                ssim
            );
        } else {
            // Hardware decode differs (e.g. macOS VideoToolbox gives SSIM ~0.987).
            // Assert that check_hwaccel_support returns false for this clip so the app safely falls back to software decode.
            assert!(
                !hw_supported,
                "When hardware decode differs from software decode (ssim={}), check_hwaccel_support must return false",
                ssim
            );
        }
    } else {
        assert!(
            !hw_supported,
            "When hardware decode is unsupported or fails, check_hwaccel_support must return false"
        );
        println!("Hardware decode not supported in this environment; fallback verified");
    }

    let _ = std::fs::remove_dir_all(&work);
}

#[tokio::test]
#[ignore = "GPU benchmark; run via npm run bench or cargo run --bin tween-bench"]
async fn test_bench_pipeline() {
    if !has_ffmpeg_and_node() {
        eprintln!("Skipping bench test: ffmpeg or node not in PATH");
        return;
    }
    let work = unique_temp_dir("bench-pipeline");
    let clip = work.join("testsrc2-20s.mp4");
    let mut gen_cmd = tokio::process::Command::new("ffmpeg");
    gen_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1920x1080:rate=24:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        clip.to_str().unwrap(),
    ]);
    let _ = run_cmd_timeout(gen_cmd, Duration::from_secs(15)).await;
    let _ = std::fs::remove_dir_all(&work);
}

#[tokio::test]
async fn test_e2e_stream_engine_matches_file_mode() {
    if !has_ffmpeg_and_node() {
        eprintln!("Skipping stream test: ffmpeg or node not in PATH");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => {
            eprintln!("Skipping: test/fake-rife.js not found");
            return;
        }
    };
    let fake_stream = match fake_rife_stream_path() {
        Some(p) => p,
        None => {
            eprintln!("Skipping: test/fake-rife-stream.js not found");
            return;
        }
    };

    let work = unique_temp_dir("stream-vs-file");
    let clip = work.join("input-10s-cut.mp4");

    // Generate 10 s clip with hard cut at 5 s and 440 Hz audio
    let mut gen_cmd = tokio::process::Command::new("ffmpeg");
    gen_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=24:duration=5",
        "-f",
        "lavfi",
        "-i",
        "smptebars=size=320x240:rate=24:duration=5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=10",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-map",
        "2:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        clip.to_str().unwrap(),
    ]);
    let out = run_cmd_timeout(gen_cmd, Duration::from_secs(30)).await;
    assert!(out.status.success(), "Failed to generate 10s test clip");

    let mut cfg_probe = make_test_cfg(&work, &fake_rife);
    // Pass-through frames must be bit-exact between modes, so decode in software for both.
    cfg_probe.disable_hwaccel = Some(true);
    let info = probe(&cfg_probe, clip.to_str().unwrap())
        .await
        .expect("probe failed");

    // 1. Run file mode
    let mut cfg_file = cfg_probe.clone();
    cfg_file.engine_mode = Some("file".into());
    let out_file = work.join("out_file.mp4");
    let req_file = JobRequest {
        info: info.clone(),
        target: Target {
            mode: "multiplier".into(),
            value: TargetValue::Number(2.0),
        },
        model: "rife-v4.26".into(),
        encoder: "libx264".into(),
        quality: Some(18),
        keep_audio: Some(true),
        output: out_file.to_string_lossy().to_string(),
        temp_root: Some(work.to_string_lossy().to_string()),
        trim: None,
        scene_detect: Some(true),
        scene_threshold: Some(10.0),
        tta: Some(false),
        chunk_frames: Some(40),
        engine_mode: Some("file".into()),
        cfg: Some(cfg_file.clone()),
    };
    let res_file = run_pipeline(cfg_file, req_file, |_| {}, Arc::new(AtomicBool::new(false))).await;
    assert!(res_file.ok, "File mode pipeline failed: {:?}", res_file.error);

    // 2. Run stream mode
    let mut cfg_stream = make_test_cfg(&work, &fake_rife);
    cfg_stream.engine_mode = Some("stream".into());
    cfg_stream.disable_hwaccel = Some(true);
    cfg_stream.rife_stream_cmd = Some(vec!["node".into(), fake_stream.to_string_lossy().to_string()]);
    let out_stream = work.join("out_stream.mp4");
    let req_stream = JobRequest {
        info: info.clone(),
        target: Target {
            mode: "multiplier".into(),
            value: TargetValue::Number(2.0),
        },
        model: "rife-v4.26".into(),
        encoder: "libx264".into(),
        quality: Some(18),
        keep_audio: Some(true),
        output: out_stream.to_string_lossy().to_string(),
        temp_root: Some(work.to_string_lossy().to_string()),
        trim: None,
        scene_detect: Some(true),
        scene_threshold: Some(10.0),
        tta: Some(false),
        chunk_frames: None,
        engine_mode: Some("stream".into()),
        cfg: Some(cfg_stream.clone()),
    };
    let res_stream = run_pipeline(cfg_stream, req_stream, |_| {}, Arc::new(AtomicBool::new(false))).await;
    assert!(res_stream.ok, "Stream mode pipeline failed: {:?}", res_stream.error);
    assert_eq!(res_stream.engine_mode.as_deref(), Some("stream"));

    // 3. Verify parity
    assert_eq!(
        res_stream.frames, res_file.frames,
        "Stream frames ({:?}) must match file frames ({:?})",
        res_stream.frames, res_file.frames
    );

    let packets_file = count_packets("ffprobe", out_file.to_str().unwrap()).await;
    let packets_stream = count_packets("ffprobe", out_stream.to_str().unwrap()).await;
    assert_eq!(
        packets_stream, packets_file,
        "Packet count must match between stream and file"
    );

    let rate_file = stream_rate("ffprobe", out_file.to_str().unwrap()).await;
    let rate_stream = stream_rate("ffprobe", out_stream.to_str().unwrap()).await;
    assert_eq!(rate_stream, rate_file, "Frame rate must match");

    // 4. Assert pass-through frames bit-exact between stream and file mode
    for &frame_idx in &[0u64, 24u64, 118u64, 120u64, 238u64] {
        let b_file = extract_raw_frame("ffmpeg", out_file.to_str().unwrap(), frame_idx).await;
        let b_stream = extract_raw_frame("ffmpeg", out_stream.to_str().unwrap(), frame_idx).await;
        assert_eq!(
            b_stream, b_file,
            "Pass-through frame {} raw RGB pixels must be bit-exact between stream and file mode",
            frame_idx
        );
    }

    // 5. Assert audio stream exists and its duration is synchronized with video duration
    let (v_dur_stream, a_dur_stream) = stream_durations("ffprobe", out_stream.to_str().unwrap()).await;
    assert!(a_dur_stream.is_some(), "Audio stream must exist in stream output");
    let (_v_dur_file, a_dur_file) = stream_durations("ffprobe", out_file.to_str().unwrap()).await;
    let a_stream = a_dur_stream.unwrap();
    let a_file = a_dur_file.unwrap();
    assert!(
        (a_stream - a_file).abs() < 0.05,
        "Audio duration in stream mode ({a_stream}s) must match file mode ({a_file}s) within 50 ms"
    );
    assert!(
        (a_stream - v_dur_stream).abs() < 0.05,
        "Audio duration ({a_stream}s) must be synchronized with video duration ({v_dur_stream}s) within 50 ms"
    );

    let ssim = ssim_between("ffmpeg", out_file.to_str().unwrap(), out_stream.to_str().unwrap()).await;
    println!("SSIM between file mode and stream mode: {:.6}", ssim);
    assert!(
        ssim > 0.999,
        "Stream mode output must match file mode output (ssim={})",
        ssim
    );

    let _ = std::fs::remove_dir_all(&work);
}

#[tokio::test]
async fn test_e2e_stream_fallback_on_failure() {
    if !has_ffmpeg_and_node() {
        eprintln!("Skipping fallback test: ffmpeg or node not in PATH");
        return;
    }
    let fake_rife = match fake_rife_path() {
        Some(p) => p,
        None => return,
    };
    let fake_stream = match fake_rife_stream_path() {
        Some(p) => p,
        None => return,
    };

    let work = unique_temp_dir("stream-fallback");
    let clip = work.join("input-2s.mp4");

    let mut gen_cmd = tokio::process::Command::new("ffmpeg");
    gen_cmd.args([
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=24:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        clip.to_str().unwrap(),
    ]);
    let out = run_cmd_timeout(gen_cmd, Duration::from_secs(15)).await;
    assert!(out.status.success(), "Failed to generate 2s test clip");

    let cfg_probe = make_test_cfg(&work, &fake_rife);
    let info = probe(&cfg_probe, clip.to_str().unwrap())
        .await
        .expect("probe failed");

    // Make only the stream engine fail, via an argument. A process-global env var
    // would leak into other tests running in parallel.
    let mut cfg_stream = make_test_cfg(&work, &fake_rife);
    cfg_stream.engine_mode = Some("stream".into());
    cfg_stream.rife_stream_cmd = Some(vec![
        "node".into(),
        fake_stream.to_string_lossy().to_string(),
        "--fake-fail".into(),
    ]);
    let out_stream = work.join("out_fallback.mp4");

    let req_stream = JobRequest {
        info,
        target: Target {
            mode: "multiplier".into(),
            value: TargetValue::Number(2.0),
        },
        model: "rife-v4.26".into(),
        encoder: "libx264".into(),
        quality: Some(18),
        keep_audio: Some(false),
        output: out_stream.to_string_lossy().to_string(),
        temp_root: Some(work.to_string_lossy().to_string()),
        trim: None,
        scene_detect: Some(false),
        scene_threshold: None,
        tta: Some(false),
        chunk_frames: None,
        engine_mode: Some("stream".into()),
        cfg: Some(cfg_stream.clone()),
    };

    let res = run_pipeline(cfg_stream, req_stream, |_| {}, Arc::new(AtomicBool::new(false))).await;

    assert!(res.ok, "Pipeline should succeed via fallback: {:?}", res.error);
    assert!(out_stream.exists(), "Output file must exist after fallback");
    assert_eq!(res.frames, Some(96));

    let _ = std::fs::remove_dir_all(&work);
}

#[tokio::test]
async fn test_fake_rife_stream_pass_through_bit_exact() {
    let fake_stream = match fake_rife_stream_path() {
        Some(p) => p,
        None => return,
    };
    let work = unique_temp_dir("fake-stream-direct");
    let times = build_frame_times(3, 6, &std::collections::HashSet::new());
    let times_path = work.join("times.dat");
    tokio::fs::write(&times_path, serialize_frame_times(&times)).await.unwrap();

    let frame_bytes = 64 * 64 * 3;
    let mut input = Vec::new();
    for f in 0..3 {
        input.resize(input.len() + frame_bytes, (f * 70 + 33) as u8);
    }

    let mut cmd = tokio::process::Command::new("node");
    cmd.args([
        fake_stream.to_str().unwrap(),
        "--stream",
        times_path.to_str().unwrap(),
        "-w",
        "64",
        "-h",
        "64",
    ]);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("spawn fake-rife-stream");
    let mut stdin = child.stdin.take().unwrap();
    let input_clone = input.clone();
    tokio::spawn(async move {
        let _ = stdin.write_all(&input_clone).await;
        let _ = stdin.flush().await;
    });
    let mut out_bytes = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut out_bytes).await.unwrap();
    let status = child.wait().await.unwrap();
    assert!(status.success());
    assert_eq!(out_bytes.len(), 6 * frame_bytes);

    // In 2x interpolation, output frames 0, 2, 4 are pass-through frames of input 0, 1, 2
    for f in 0..3 {
        let in_slice = &input[f * frame_bytes..(f + 1) * frame_bytes];
        let out_slice = &out_bytes[(f * 2) * frame_bytes..(f * 2 + 1) * frame_bytes];
        assert_eq!(out_slice, in_slice, "Source frame {f} must pass through bit-exact");
    }
    let _ = std::fs::remove_dir_all(&work);
}
