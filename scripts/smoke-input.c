// Synthetic mouse input for the release smoke test.
//
// Exists because three releases in one day shipped changes that compiled, type
// checked, passed every unit test, and then broke the app the first time a
// human touched it: 0.7.30 aborted on any titlebar click (an Objective-C
// selector that only resolves at runtime), and 0.7.30/0.7.31 turned the scroll
// wheel into prompt-history navigation. Nothing short of driving the real
// window could have caught either one.
//
// AppleScript's `click at` can only click. A drag and a scroll both need
// CGEvent, and both are exactly the gestures that broke — hence a small C tool
// rather than another osascript.
//
// Build: clang -o smoke-input smoke-input.c -framework ApplicationServices
// Needs Accessibility permission for whatever process runs it; scripts/smoke.sh
// checks that up front rather than letting a permission failure read as a pass.

#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Events are posted with a gap: AppKit coalesces a burst arriving in the same
// run-loop turn, which would make a drag look like a teleport and a
// double-click look like one click.
static const useconds_t STEP_US = 60000;

static void post(CGEventType type, CGPoint p) {
    CGEventRef e = CGEventCreateMouseEvent(NULL, type, p, kCGMouseButtonLeft);
    if (!e) return;
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
    usleep(STEP_US);
}

/// `clicks` rides on the event so AppKit reports `detail == 2` for the second
/// press. Posting two plain clicks is not a double-click and will not exercise
/// a double-click handler.
static void click_n(CGPoint p, int clicks) {
    post(kCGEventMouseMoved, p);
    for (int i = 1; i <= clicks; i++) {
        CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, p, kCGMouseButtonLeft);
        CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, p, kCGMouseButtonLeft);
        CGEventSetIntegerValueField(down, kCGMouseEventClickState, i);
        CGEventSetIntegerValueField(up, kCGMouseEventClickState, i);
        CGEventPost(kCGHIDEventTap, down);
        usleep(20000);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(down);
        CFRelease(up);
        usleep(40000);
    }
}

static void drag(CGPoint from, double dx, double dy) {
    post(kCGEventMouseMoved, from);
    post(kCGEventLeftMouseDown, from);
    // Stepped, not jumped: a window drag follows intermediate motion, and a
    // single leap can be dropped entirely.
    const int steps = 12;
    for (int i = 1; i <= steps; i++) {
        double t = (double)i / steps;
        post(kCGEventLeftMouseDragged, CGPointMake(from.x + dx * t, from.y + dy * t));
    }
    post(kCGEventLeftMouseUp, CGPointMake(from.x + dx, from.y + dy));
}

static void scroll(CGPoint p, int ticks) {
    post(kCGEventMouseMoved, p);
    for (int i = 0; i < abs(ticks); i++) {
        CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1,
                                                     ticks > 0 ? 3 : -3);
        if (!e) return;
        // Without a location the event goes wherever the cursor last was
        // according to the window server, which is not necessarily where we
        // just moved it.
        CGEventSetLocation(e, p);
        CGEventPost(kCGHIDEventTap, e);
        CFRelease(e);
        usleep(STEP_US);
    }
}

static void usage(void) {
    fprintf(stderr,
            "usage: smoke-input <command> ...\n"
            "  click    <x> <y>\n"
            "  dblclick <x> <y>\n"
            "  drag     <x> <y> <dx> <dy>\n"
            "  scroll   <x> <y> <ticks>   (positive = up)\n");
}

int main(int argc, char **argv) {
    if (argc < 4) {
        usage();
        return 2;
    }
    const char *cmd = argv[1];
    CGPoint p = CGPointMake(atof(argv[2]), atof(argv[3]));

    if (strcmp(cmd, "click") == 0) {
        click_n(p, 1);
    } else if (strcmp(cmd, "dblclick") == 0) {
        click_n(p, 2);
    } else if (strcmp(cmd, "drag") == 0) {
        if (argc < 6) { usage(); return 2; }
        drag(p, atof(argv[4]), atof(argv[5]));
    } else if (strcmp(cmd, "scroll") == 0) {
        if (argc < 5) { usage(); return 2; }
        scroll(p, atoi(argv[4]));
    } else {
        usage();
        return 2;
    }
    return 0;
}
