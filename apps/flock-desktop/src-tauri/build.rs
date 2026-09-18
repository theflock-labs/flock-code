fn main() {
    println!("cargo:rerun-if-changed=native/desktop_audio.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/desktop_audio.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("flock_desktop_audio");
        // ScreenCaptureKit arrived after our macOS 12.0 deployment target.
        // Weak linking plus @available keeps microphone dictation working there.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
    }
    tauri_build::build()
}
