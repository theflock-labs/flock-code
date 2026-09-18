#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <stdio.h>
extern bool flock_desktop_audio_available(void);
extern void *flock_desktop_audio_start(void (*)(void *, const float *, size_t), void *, char *, size_t);
extern void flock_desktop_audio_stop(void *, char *, size_t);
typedef struct { size_t count; double energy, real, imaginary; } Meter;
static void samples(void *raw, const float *values, size_t count) {
    Meter *meter = raw;
    for (size_t i = 0; i < count; i++) {
        double phase = 2 * M_PI * 997 * meter->count++ / 48000;
        meter->energy += values[i] * values[i];
        meter->real += values[i] * cos(phase);
        meter->imaginary += values[i] * sin(phase);
    }
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    if (!CGPreflightScreenCaptureAccess()) { puts("SKIP: screen/audio permission is not granted to this test process."); return 77; }
    if (!flock_desktop_audio_available()) return 77;
    NSString *tone = [NSString stringWithUTF8String:argv[1]];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        Meter meter = {0}; char error[2048] = {0};
        void *capture = flock_desktop_audio_start(samples, &meter, error, sizeof(error));
        if (!capture) { fprintf(stderr, "%s\n", error); exit(1); }
        NSTask *player = [NSTask new]; player.executableURL = [NSURL fileURLWithPath:@"/usr/bin/afplay"]; player.arguments = @[tone];
        NSError *failure;
        if (![player launchAndReturnError:&failure]) { flock_desktop_audio_stop(capture, error, sizeof(error)); exit(2); }
        [player waitUntilExit]; [NSThread sleepForTimeInterval:0.3];
        flock_desktop_audio_stop(capture, error, sizeof(error));
        double amplitude = 2 * hypot(meter.real, meter.imaginary) / MAX(meter.count, 1);
        printf("frames=%zu tone_amplitude=%.5f error=%s\n", meter.count, amplitude, error);
        exit(meter.count > 48000 && amplitude > 0.01 && !error[0] ? 0 : 1);
    });
    CFRunLoopRun(); return 2;
}
