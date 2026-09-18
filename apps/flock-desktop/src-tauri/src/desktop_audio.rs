//! Audio-only macOS capture. The native bridge drains callbacks before stop
//! returns, so the borrowed Sink always outlives every callback that can use it.
use std::sync::{mpsc, Arc, Mutex};
use tauri::AppHandle;

pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        flock_desktop_audio_available()
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
extern "C" {
    fn flock_desktop_audio_available() -> bool;
    fn flock_desktop_audio_start(
        callback: extern "C" fn(*mut std::ffi::c_void, *const f32, usize),
        context: *mut std::ffi::c_void,
        error: *mut std::ffi::c_char,
        capacity: usize,
    ) -> *mut std::ffi::c_void;
    fn flock_desktop_audio_stop(
        handle: *mut std::ffi::c_void,
        error: *mut std::ffi::c_char,
        capacity: usize,
    );
}

pub fn run_capture(
    app: AppHandle,
    buffer: Arc<Mutex<Vec<f32>>>,
    stop: mpsc::Receiver<()>,
    ready: mpsc::Sender<Result<(u32, u16), String>>,
    failure: Arc<Mutex<Option<String>>>,
) {
    #[cfg(target_os = "macos")]
    {
        use std::{
            ffi::{c_char, c_void, CStr},
            time::{Duration, Instant},
        };
        struct Sink {
            app: AppHandle,
            buffer: Arc<Mutex<Vec<f32>>>,
            meter: Mutex<Instant>,
        }
        extern "C" fn samples(context: *mut c_void, data: *const f32, count: usize) {
            // No panic may cross the C ABI. Poisoning drops this block, and the
            // native contract guarantees valid aligned mono Float32 until return.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let sink = unsafe { &*(context as *const Sink) };
                let samples = unsafe { std::slice::from_raw_parts(data, count) };
                if let Ok(mut buffer) = sink.buffer.lock() {
                    append_samples(
                        &mut buffer,
                        samples,
                        48_000 * super::voice::MAX_RECORDING_SECS,
                    );
                }
                super::voice::maybe_emit_level(&sink.app, samples, &sink.meter);
            }));
        }
        buffer.lock().unwrap().reserve(48_000 * 30);
        let mut sink = Box::new(Sink {
            app,
            buffer,
            meter: Mutex::new(Instant::now()),
        });
        let mut error = [0 as c_char; 2048];
        let handle = unsafe {
            flock_desktop_audio_start(
                samples,
                (&mut *sink as *mut Sink).cast(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        let message = |error: &[c_char]| unsafe {
            CStr::from_ptr(error.as_ptr())
                .to_string_lossy()
                .into_owned()
        };
        if handle.is_null() {
            let _ = ready.send(Err(message(&error)));
            return;
        }
        let _ = ready.send(Ok((48_000, 1)));
        // Independent backstop even if the owning window disappears.
        let _ = stop.recv_timeout(Duration::from_secs(super::voice::MAX_RECORDING_SECS as u64));
        unsafe {
            flock_desktop_audio_stop(handle, error.as_mut_ptr(), error.len());
        }
        let error = message(&error);
        if !error.is_empty() {
            *failure.lock().unwrap() = Some(error);
        }
        drop(sink);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, buffer, stop, failure);
        let _ = ready.send(Err("Desktop audio requires macOS 13 or later.".into()));
    }
}

fn append_samples(buffer: &mut Vec<f32>, samples: &[f32], ceiling: usize) {
    let room = ceiling.saturating_sub(buffer.len());
    buffer.extend(
        samples
            .iter()
            .take(room)
            .map(|sample| if sample.is_finite() { *sample } else { 0.0 }),
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn capture_bounds_memory_and_rejects_non_finite_samples() {
        let mut buffer = vec![0.25];
        super::append_samples(&mut buffer, &[f32::NAN, f32::INFINITY, 0.5, 0.75], 4);
        assert_eq!(buffer, vec![0.25, 0.0, 0.0, 0.5]);
        super::append_samples(&mut buffer, &[1.0], 4);
        assert_eq!(buffer.len(), 4);
        buffer.drain(..2);
        super::append_samples(&mut buffer, &[-0.5], 4);
        assert_eq!(buffer, vec![0.0, 0.5, -0.5]);
    }
}
