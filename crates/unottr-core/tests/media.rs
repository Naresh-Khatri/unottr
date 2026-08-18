//! End-to-end media tests. They synthesise their own input with ffmpeg and skip entirely
//! when it is absent, so they run in CI without the recording corpus.

use std::path::Path;
use std::process::Command;

use unottr_core::CancelToken;
use unottr_core::media::{FfmpegCli, MediaBackend, Selection, TrackRule, pcm_duration_ms, select};

fn have_ffmpeg() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Builds an mkv of `seconds` with one titled audio track per entry in `tracks`.
fn fixture(out: &Path, seconds: u32, tracks: &[(&str, u16)]) {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v", "error", "-y"]);
    cmd.args([
        "-f",
        "lavfi",
        "-i",
        &format!("color=c=black:s=64x64:d={seconds}"),
    ]);
    for (i, _) in tracks.iter().enumerate() {
        let freq = 200 + i * 150;
        cmd.args([
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={freq}:duration={seconds}"),
        ]);
    }
    cmd.args(["-map", "0:v", "-pix_fmt", "yuv420p"]);
    for (i, (title, channels)) in tracks.iter().enumerate() {
        cmd.args(["-map", &format!("{}:a", i + 1)]);
        cmd.args([&format!("-ac:a:{i}"), &channels.to_string()]);
        cmd.args([&format!("-metadata:s:a:{i}"), &format!("title={title}")]);
    }
    let status = cmd.arg(out).status().expect("spawn ffmpeg");
    assert!(status.success(), "building fixture failed");
}

#[test]
fn probes_and_extracts_a_real_file() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = dir.path().join("meeting.mkv");
    fixture(
        &media,
        3,
        &[("Mix", 2), ("Microphone", 1), ("Desktop Audio", 2)],
    );

    let backend = FfmpegCli::discover();
    let probe = backend.probe(&media).unwrap();
    assert!(probe.has_video);
    assert_eq!(probe.audio.len(), 3);
    assert_eq!(probe.audio[1].channels, 1);
    assert_eq!(probe.audio[1].title.as_deref(), Some("Microphone"));
    let duration = probe.duration_ms.unwrap();
    assert!(duration.abs_diff(3000) < 100, "duration was {duration}ms");

    let choice = select(&probe, &TrackRule::Auto).unwrap();
    assert_eq!(
        choice.selection,
        Selection::MicDesktop { mic: 1, desktop: 2 },
        "{}",
        choice.reason
    );

    let pcm = dir.path().join("nested/meeting.pcm");
    let seen = std::cell::RefCell::new(Vec::new());
    backend
        .extract_pcm(
            &media,
            1,
            &pcm,
            &|f| seen.borrow_mut().push(f),
            &CancelToken::new(),
        )
        .unwrap();

    let bytes = std::fs::metadata(&pcm).unwrap().len();
    let extracted = pcm_duration_ms(bytes);
    assert!(
        extracted.abs_diff(duration) * 100 < duration,
        "pcm was {extracted}ms vs probed {duration}ms"
    );
    assert_eq!(seen.borrow().last().copied(), Some(1.0));
}

#[test]
fn a_pre_cancelled_extract_writes_nothing() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = dir.path().join("meeting.mkv");
    fixture(&media, 1, &[("Mix", 2)]);

    let cancel = CancelToken::new();
    cancel.cancel();
    let pcm = dir.path().join("meeting.pcm");
    let err = FfmpegCli::discover()
        .extract_pcm(&media, 0, &pcm, &|_| {}, &cancel)
        .unwrap_err();
    assert!(matches!(err, unottr_core::Error::Cancelled));
    assert!(!pcm.exists());
}

#[test]
fn a_video_without_audio_is_rejected() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = dir.path().join("silent.mkv");
    fixture(&media, 1, &[]);
    assert!(matches!(
        FfmpegCli::discover().probe(&media),
        Err(unottr_core::Error::NoAudio { .. })
    ));
}

#[test]
fn a_truncated_file_is_rejected() {
    if !have_ffmpeg() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let media = dir.path().join("meeting.mp4");
    fixture(&media, 5, &[("Mix", 2)]);
    let whole = std::fs::read(&media).unwrap();
    let cut = dir.path().join("cut.mp4");
    std::fs::write(&cut, &whole[..whole.len() / 2]).unwrap();

    assert!(matches!(
        FfmpegCli::discover().probe(&cut),
        Err(unottr_core::Error::Truncated { .. })
    ));
}
