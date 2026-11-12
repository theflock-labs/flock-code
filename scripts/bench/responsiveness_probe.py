#!/usr/bin/env python3
"""Measure, from outside, how quickly a running flock answers — the way a click
would need it to.

    responsiveness_probe.py PID [--seconds 30] [--every 0.25] [--csv out.csv]

Two probes, each an Accessibility request that only the app itself can answer:

  native   AXWindows of the app. Answered on flock's main thread (AppKit), the
           thread that also runs every synchronous command and hands every
           event and terminal message to the web view. When it is busy or
           blocked, the window takes no clicks and macOS shows the beach ball.
  web      the children of the window's web area. Answered by the web view's
           content process, so it also waits on the page's JavaScript thread.
           When only this one is slow, the window still moves but its content
           does not respond.

Prints a summary (median, p95, max, count over 250 ms) per probe; with --csv,
every sample. No input is sent to the app; it only asks what is on screen.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import statistics
import sys
import time

AS = ctypes.cdll.LoadLibrary(ctypes.util.find_library("ApplicationServices"))
CF = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))

CFStringRef = ctypes.c_void_p
AXUIElementRef = ctypes.c_void_p
kCFStringEncodingUTF8 = 0x08000100

CF.CFStringCreateWithCString.restype = CFStringRef
CF.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
CF.CFArrayGetCount.restype = ctypes.c_long
CF.CFArrayGetCount.argtypes = [ctypes.c_void_p]
CF.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
CF.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
CF.CFRelease.argtypes = [ctypes.c_void_p]
CF.CFGetTypeID.restype = ctypes.c_ulong
CF.CFGetTypeID.argtypes = [ctypes.c_void_p]
CF.CFArrayGetTypeID.restype = ctypes.c_ulong
CF.CFStringGetCString.restype = ctypes.c_bool
CF.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]

AS.AXUIElementCreateApplication.restype = AXUIElementRef
AS.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
AS.AXUIElementCopyAttributeValue.restype = ctypes.c_int32
AS.AXUIElementCopyAttributeValue.argtypes = [AXUIElementRef, CFStringRef, ctypes.POINTER(ctypes.c_void_p)]
AS.AXUIElementSetMessagingTimeout.restype = ctypes.c_int32
AS.AXUIElementSetMessagingTimeout.argtypes = [AXUIElementRef, ctypes.c_float]
AS.AXIsProcessTrusted.restype = ctypes.c_bool


def cfstr(s: str) -> CFStringRef:
    return CF.CFStringCreateWithCString(None, s.encode(), kCFStringEncodingUTF8)


ATTR = {name: cfstr(name) for name in ("AXWindows", "AXChildren", "AXRole")}


def copy(el, attr: str):
    out = ctypes.c_void_p()
    err = AS.AXUIElementCopyAttributeValue(el, ATTR[attr], ctypes.byref(out))
    return err, out.value


def role(el) -> str:
    err, v = copy(el, "AXRole")
    if err or not v:
        return ""
    buf = ctypes.create_string_buffer(128)
    CF.CFStringGetCString(v, buf, 128, kCFStringEncodingUTF8)
    CF.CFRelease(v)
    return buf.value.decode()


def children(el) -> list:
    err, arr = copy(el, "AXChildren")
    if err or not arr:
        return []
    return [CF.CFArrayGetValueAtIndex(arr, i) for i in range(CF.CFArrayGetCount(arr))]


def find_web_area(el, depth=0):
    if depth > 8:
        return None
    if role(el) == "AXWebArea":
        return el
    for c in children(el):
        hit = find_web_area(c, depth + 1)
        if hit:
            return hit
    return None


def timed(fn) -> tuple[float, int]:
    t = time.perf_counter()
    err = fn()
    return (time.perf_counter() - t) * 1000, err


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pid", type=int)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--every", type=float, default=0.25)
    ap.add_argument("--csv")
    a = ap.parse_args()
    if not AS.AXIsProcessTrusted():
        print("this process has no Accessibility permission; grant it to the terminal running the probe", file=sys.stderr)
        return 2
    app = AS.AXUIElementCreateApplication(a.pid)
    AS.AXUIElementSetMessagingTimeout(app, 10.0)

    err, wins = copy(app, "AXWindows")
    if err or not wins or not CF.CFArrayGetCount(wins):
        print(f"no windows reachable (AX error {err}); is the screen locked?", file=sys.stderr)
        return 3
    web = find_web_area(CF.CFArrayGetValueAtIndex(wins, 0))
    if web:
        AS.AXUIElementSetMessagingTimeout(web, 10.0)

    samples = {"native": [], "web": []}
    rows = []
    end = time.monotonic() + a.seconds
    while time.monotonic() < end:
        t0 = time.time()

        def native():
            e, v = copy(app, "AXWindows")
            if v:
                CF.CFRelease(v)
            return e

        def webq():
            e, v = copy(web, "AXChildren")
            if v:
                CF.CFRelease(v)
            return e

        n_ms, n_err = timed(native)
        w_ms, w_err = timed(webq) if web else (float("nan"), -1)
        samples["native"].append(n_ms)
        if web:
            samples["web"].append(w_ms)
        rows.append((t0, n_ms, n_err, w_ms, w_err))
        time.sleep(max(0.0, a.every - (time.time() - t0)))

    for name, xs in samples.items():
        if not xs:
            print(f"{name:7} no samples")
            continue
        xs_sorted = sorted(xs)
        p95 = xs_sorted[int(0.95 * (len(xs_sorted) - 1))]
        slow = sum(1 for x in xs if x > 250)
        print(f"{name:7} median {statistics.median(xs):7.1f} ms   p95 {p95:7.1f} ms   max {max(xs):8.1f} ms   >250ms {slow}/{len(xs)}")
    if a.csv:
        with open(a.csv, "w") as f:
            f.write("t,native_ms,native_err,web_ms,web_err\n")
            for r in rows:
                f.write(",".join(str(x) for x in r) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
