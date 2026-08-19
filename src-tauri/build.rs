fn main() {
    #[cfg(unix)]
    unshare_sherpa_libs();
    tauri_build::build()
}

// sherpa-rs-sys hardlinks its prebuilt .so from the shared ~/.cache/sherpa-rs download into
// target/<profile>/ (and deps/, examples/). tauri-build then honours bundle.resources by copying
// ../target/release/lib*.so -> target/<profile>/lib*.so; its "skip if same" guard compares paths,
// not inodes, so on a debug build src and dst are different paths but the SAME inode -> fs::copy
// opens dst with O_TRUNC and zeroes the cache copy. rustc links against that cache copy (-L points
// at it), so the next build dies with undefined SherpaOnnx* symbols. sherpa-rs only relinks when
// dst is missing, so it never repairs itself. Give the profile dir a private inode first.
#[cfg(unix)]
fn unshare_sherpa_libs() {
    use std::os::unix::fs::MetadataExt;
    use std::{env, fs, path::PathBuf};

    let Ok(out_dir) = env::var("OUT_DIR").map(PathBuf::from) else {
        return;
    };
    let Ok(profile) = env::var("PROFILE") else {
        return;
    };
    let Some(target_dir) = out_dir.ancestors().find(|p| p.ends_with(&profile)) else {
        return;
    };

    for lib in [
        "libonnxruntime.so",
        "libsherpa-onnx-c-api.so",
        "libsherpa-onnx-cxx-api.so",
    ] {
        let path = target_dir.join(lib);
        match fs::metadata(&path) {
            Ok(meta) if meta.nlink() > 1 => {}
            _ => continue,
        }
        let tmp = target_dir.join(format!("{lib}.unshared"));
        if fs::copy(&path, &tmp).is_ok() && fs::rename(&tmp, &path).is_ok() {
            continue;
        }
        let _ = fs::remove_file(&tmp);
    }
}
