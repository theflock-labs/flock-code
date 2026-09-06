# whisper-rs-sys 0.13.1 bundles GGML whose native CPU probe can disable i8mm
# instructions while Apple Clang still defines __ARM_FEATURE_MATMUL_INT8.
# The macOS Actions VM then fails to compile vmmlaq_s32. Use a portable Apple
# Silicon baseline instead of specializing distributed binaries to the host.
# Scope the hook to Whisper; other CMake projects retain their own settings.
if(PROJECT_NAME STREQUAL "whisper.cpp" AND APPLE)
    if(CMAKE_OSX_ARCHITECTURES STREQUAL "arm64" OR
       (NOT CMAKE_OSX_ARCHITECTURES AND CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64)$"))
        set(GGML_NATIVE OFF CACHE BOOL "Use a portable Whisper CPU baseline" FORCE)
        set(GGML_CPU_ARM_ARCH "armv8.2-a+fp16" CACHE STRING "Minimum Apple Silicon CPU features" FORCE)
    endif()
endif()
