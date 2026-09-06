fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let embedded_python = std::env::var_os("CARGO_FEATURE_EMBEDDED_PYTHON").is_some();

    if target_os == "linux" && embedded_python {
        // PyO3 asks the Linux linker to export executable symbols so native
        // Python modules can resolve the CPython C API. Without this exclusion,
        // that also exports rusqlite's bundled SQLite symbols. Python's
        // `_sqlite3.so` then binds some calls to the bundled archive and others
        // to libsqlite3.so, mixing two SQLite ABIs inside one connection.
        // `ALL` is intentional: Cargo repackages libsqlite3.a inside an rlib, so
        // excluding the original archive name does not hide its symbols.
        println!("cargo:rustc-link-arg=-Wl,--exclude-libs,ALL");
    }

    tauri_build::build()
}
