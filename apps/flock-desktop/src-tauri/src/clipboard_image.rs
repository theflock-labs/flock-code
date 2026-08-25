// Extract an image the user copied out of a rich-text app (Apple Notes, Mail,
// TextEdit…). Those apps put the image ONLY inside an RTFD blob on the
// pasteboard — there is no standalone `public.tiff`/`public.png` type — so
// arboard's `get_image()` returns nothing. Here we read the RTFD data, parse it
// into an NSAttributedString, and pull the bytes out of its first image
// attachment.
//
// Implemented with raw `objc2` message sends rather than the typed
// objc2-app-kit bindings so it runs off the main thread (Tauri commands do):
// the typed AppKit APIs require a MainThreadMarker we can't produce on a worker
// thread, while pasteboard reads + RTFD parsing are safe off-main in practice
// (arboard already reads the pasteboard the same way).

#[cfg(not(target_os = "macos"))]
pub fn rtfd_image() -> Option<(Vec<u8>, String)> {
    None
}

#[cfg(target_os = "macos")]
pub fn rtfd_image() -> Option<(Vec<u8>, String)> {
    use objc2::encode::{Encode, Encoding, RefEncode};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::os::raw::{c_char, c_void};

    // NSRange is two NSUInteger; define locally to avoid a Foundation dep, with
    // the Objective-C encoding so it can ride through msg_send! as an out-param.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRange {
        location: usize,
        length: usize,
    }
    unsafe impl Encode for NSRange {
        const ENCODING: Encoding =
            Encoding::Struct("_NSRange", &[usize::ENCODING, usize::ENCODING]);
    }
    unsafe impl RefEncode for NSRange {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING);
    }

    unsafe fn ns_to_string(s: *mut AnyObject) -> String {
        if s.is_null() {
            return String::new();
        }
        let utf8: *const c_char = msg_send![s, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }

    unsafe fn ns_data_to_vec(data: *mut AnyObject) -> Vec<u8> {
        if data.is_null() {
            return Vec::new();
        }
        let len: usize = msg_send![data, length];
        let ptr: *const c_void = msg_send![data, bytes];
        if ptr.is_null() || len == 0 {
            return Vec::new();
        }
        std::slice::from_raw_parts(ptr as *const u8, len).to_vec()
    }

    // Identify the image format from magic bytes rather than trusting the
    // attachment's filename (which is often missing or generic).
    fn sniff_ext(b: &[u8]) -> &'static str {
        if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            "png"
        } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
            "jpg"
        } else if b.starts_with(b"GIF8") {
            "gif"
        } else if b.starts_with(&[0x49, 0x49, 0x2A, 0x00]) || b.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]) {
            "tif"
        } else if b.len() > 11 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
            "webp"
        } else {
            "png"
        }
    }

    autoreleasepool(|_| unsafe {
        let pb: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return None;
        }

        // Find whichever pasteboard type carries the RTFD (the UTI spelling
        // varies across macOS versions: public.rtfd, com.apple.flat-rtfd, the
        // legacy "NeXT RTFD pasteboard type"…). Match on substring.
        let types: *mut AnyObject = msg_send![pb, types];
        if types.is_null() {
            return None;
        }
        let count: usize = msg_send![types, count];
        let mut rtfd_type: *mut AnyObject = std::ptr::null_mut();
        for i in 0..count {
            let t: *mut AnyObject = msg_send![types, objectAtIndex: i];
            if ns_to_string(t).to_lowercase().contains("rtfd") {
                rtfd_type = t;
                break;
            }
        }
        if rtfd_type.is_null() {
            return None;
        }

        let data: *mut AnyObject = msg_send![pb, dataForType: rtfd_type];
        if data.is_null() {
            return None;
        }

        // NSAttributedString *alloc+initWithRTFD:documentAttributes:* — owned
        // (+1), so wrap in Retained to release on drop.
        let alloc: *mut AnyObject = msg_send![class!(NSAttributedString), alloc];
        // documentAttributes is an out-param `NSDictionary **` (encoding `^@`),
        // so a null *pointer-to-pointer*, not a null object.
        let astr: *mut AnyObject =
            msg_send![alloc, initWithRTFD: data, documentAttributes: std::ptr::null_mut::<*mut AnyObject>()];
        let astr = Retained::from_raw(astr)?;
        let astr_ptr = Retained::as_ptr(&astr) as *mut AnyObject;

        let len: usize = msg_send![astr_ptr, length];
        // NSAttachmentAttributeName is the constant string "NSAttachment".
        let key: *mut AnyObject = {
            let s: *mut AnyObject = msg_send![class!(NSString), alloc];
            let bytes = b"NSAttachment\0";
            let s: *mut AnyObject = msg_send![s, initWithUTF8String: bytes.as_ptr() as *const c_char];
            s
        };
        let key = Retained::from_raw(key)?;
        let key_ptr = Retained::as_ptr(&key) as *mut AnyObject;

        let mut i = 0usize;
        while i < len {
            let mut range = NSRange { location: 0, length: 0 };
            let attr: *mut AnyObject = msg_send![
                astr_ptr,
                attribute: key_ptr,
                atIndex: i,
                effectiveRange: &mut range as *mut NSRange
            ];
            if !attr.is_null() {
                // attr is an NSTextAttachment.
                let fw: *mut AnyObject = msg_send![attr, fileWrapper];
                if !fw.is_null() {
                    let is_regular: bool = msg_send![fw, isRegularFile];
                    if is_regular {
                        let contents: *mut AnyObject = msg_send![fw, regularFileContents];
                        let bytes = ns_data_to_vec(contents);
                        if !bytes.is_empty() {
                            let ext = sniff_ext(&bytes).to_string();
                            return Some((bytes, ext));
                        }
                    }
                }
            }
            let step = if range.length == 0 { 1 } else { range.length };
            i += step;
        }
        None
    })
}
