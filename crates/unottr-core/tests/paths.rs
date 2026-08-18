use unottr_core::Paths;

#[test]
fn env_override_relocates_everything() {
    let dir = tempfile::tempdir().unwrap();
    // safe here: this is the only test in the binary that touches env
    unsafe {
        std::env::set_var("UNOTTR_DATA_DIR", dir.path());
        std::env::remove_var("UNOTTR_CACHE_DIR");
        std::env::remove_var("UNOTTR_STATE_DIR");
    }

    let paths = Paths::resolve().unwrap();
    assert_eq!(paths.data_dir(), dir.path());
    assert!(paths.cache_dir().starts_with(dir.path()));
    assert!(paths.state_dir().starts_with(dir.path()));
    assert!(paths.db_file().starts_with(dir.path()));

    paths.ensure().unwrap();
    assert!(paths.models_dir().is_dir());
    assert!(paths.pcm_cache_dir().is_dir());
    assert!(paths.logs_dir().is_dir());

    unsafe {
        std::env::remove_var("UNOTTR_DATA_DIR");
    }
}
