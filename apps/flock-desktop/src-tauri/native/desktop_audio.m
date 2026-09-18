// Audio-only ScreenCaptureKit bridge. No screen output is registered or saved.
// All calls enter from a dedicated Rust capture thread, never the main thread.
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>

typedef void (*FlockAudioCallback)(void *, const float *, size_t);

static void copy_error(char *destination, size_t capacity, NSString *message) {
    if (destination && capacity) snprintf(destination, capacity, "%s", message.UTF8String ?: "");
}

API_AVAILABLE(macos(13.0))
@interface FlockDesktopAudio : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t queue;
// Only accessed on queue, including invalidation before the Rust context dies.
@property(nonatomic, assign) FlockAudioCallback callback;
@property(nonatomic, assign) void *context;
@property(nonatomic, copy) NSString *failure;
@end

@implementation FlockDesktopAudio
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample
        ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio || !self.callback || !CMSampleBufferIsValid(sample)) return;
    const AudioStreamBasicDescription *format = CMAudioFormatDescriptionGetStreamBasicDescription(
        CMSampleBufferGetFormatDescription(sample));
    if (!format || format->mFormatID != kAudioFormatLinearPCM ||
        !(format->mFormatFlags & kAudioFormatFlagIsFloat) ||
        (format->mFormatFlags & kAudioFormatFlagIsBigEndian) ||
        format->mBitsPerChannel != 32 || format->mChannelsPerFrame != 1 ||
        format->mSampleRate != 48000) {
        self.failure = @"Desktop audio returned an unsupported audio format. Stop and try again.";
        return;
    }
    // Mono Float32 has one AudioBuffer even when marked non-interleaved.
    AudioBufferList list = {0};
    CMBlockBufferRef retained = NULL;
    OSStatus result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample, NULL, &list, sizeof(list), kCFAllocatorDefault, kCFAllocatorDefault,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &retained);
    if (result == noErr && list.mNumberBuffers == 1 && list.mBuffers[0].mData) {
        self.callback(self.context, list.mBuffers[0].mData,
                      list.mBuffers[0].mDataByteSize / sizeof(float));
    } else {
        self.failure = @"Could not read desktop audio. Stop and try again.";
    }
    if (retained) CFRelease(retained);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(self.queue, ^{
        self.failure = [NSString stringWithFormat:@"Desktop audio stopped: %@", error.localizedDescription];
    });
}
@end

bool flock_desktop_audio_available(void) {
    if (@available(macOS 13.0, *)) return true;
    return false;
}

API_AVAILABLE(macos(13.0))
static NSString *stop_capture(FlockDesktopAudio *capture) {
    // Drain any callback already using Rust memory, and prevent future use.
    dispatch_sync(capture.queue, ^{ capture.callback = NULL; capture.context = NULL; });
    SCStream *stream = capture.stream;
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; dispatch_semaphore_signal(stopped); }];
    BOOL timedOut = dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0;
    [stream removeStreamOutput:capture type:SCStreamOutputTypeAudio error:NULL];
    capture.stream = nil;
    __block NSString *failure;
    dispatch_sync(capture.queue, ^{ failure = capture.failure; });
    return failure ?: (timedOut ? @"Desktop audio took too long to stop. Try again." : nil);
}

void *flock_desktop_audio_start(FlockAudioCallback callback, void *context, char *error, size_t capacity) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            __block SCShareableContent *content;
            __block NSError *contentError;
            dispatch_semaphore_t ready = dispatch_semaphore_create(0);
            [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
                completionHandler:^(SCShareableContent *result, NSError *failure) {
                    content = result; contentError = failure; dispatch_semaphore_signal(ready);
                }];
            if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)) != 0) {
                copy_error(error, capacity, @"Desktop audio permission timed out. Allow flock in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.");
                return NULL;
            }
            if (contentError || !content.displays.count) {
                copy_error(error, capacity, contentError
                    ? [NSString stringWithFormat:@"Cannot capture desktop audio. Allow flock in System Settings → Privacy & Security → Screen & System Audio Recording, then restart flock if macOS asks. %@", contentError.localizedDescription]
                    : @"Desktop audio needs an active display. Connect a display and try again.");
                return NULL;
            }
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:content.displays.firstObject
                excludingApplications:@[] exceptingWindows:@[]];
            SCStreamConfiguration *configuration = [SCStreamConfiguration new];
            configuration.capturesAudio = YES;
            configuration.excludesCurrentProcessAudio = YES;
            configuration.sampleRate = 48000;
            configuration.channelCount = 1;
            // No video output handler; keep the required display configuration tiny.
            configuration.width = 2; configuration.height = 2;
            configuration.minimumFrameInterval = CMTimeMake(1, 1);
            FlockDesktopAudio *capture = [FlockDesktopAudio new];
            capture.queue = dispatch_queue_create("sh.theflock.desktop-audio", DISPATCH_QUEUE_SERIAL);
            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:capture];
            capture.stream = stream;
            NSError *outputError;
            if (![stream addStreamOutput:capture type:SCStreamOutputTypeAudio
                    sampleHandlerQueue:capture.queue error:&outputError]) {
                copy_error(error, capacity, outputError.localizedDescription);
                capture.stream = nil;
                return NULL;
            }
            __block NSError *startError;
            __block BOOL abandoned = NO;
            dispatch_semaphore_t started = dispatch_semaphore_create(0);
            [stream startCaptureWithCompletionHandler:^(NSError *failure) {
                @synchronized(capture) {
                    startError = failure;
                    // A late successful start must not leave capture running after timeout.
                    if (abandoned) [stream stopCaptureWithCompletionHandler:^(NSError *ignored) { (void)ignored; }];
                }
                dispatch_semaphore_signal(started);
            }];
            BOOL timedOut = dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) != 0;
            @synchronized(capture) {
                if (timedOut || startError) {
                    abandoned = YES;
                    copy_error(error, capacity, timedOut ? @"Desktop audio took too long to start. Try again."
                        : [NSString stringWithFormat:@"Cannot start desktop audio: %@", startError.localizedDescription]);
                }
            }
            if (timedOut || startError) { stop_capture(capture); return NULL; }
            // Install the borrowed context only after all asynchronous startup succeeds.
            dispatch_sync(capture.queue, ^{ capture.callback = callback; capture.context = context; });
            return (__bridge_retained void *)capture;
        }
        copy_error(error, capacity, @"Desktop audio requires macOS 13 or later. Microphone dictation is still available.");
        return NULL;
    }
}

void flock_desktop_audio_stop(void *handle, char *error, size_t capacity) {
    @autoreleasepool {
        if (@available(macOS 13.0, *)) {
            FlockDesktopAudio *capture = (__bridge_transfer FlockDesktopAudio *)handle;
            copy_error(error, capacity, stop_capture(capture));
        }
    }
}
