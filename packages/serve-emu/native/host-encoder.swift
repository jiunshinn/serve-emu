import Foundation
import VideoToolbox
import Accelerate
import Darwin

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func check(_ status: OSStatus, _ operation: String) {
    if status != noErr { fail("\(operation): \(status)") }
}

func packet(_ data: Data, _ flags: UInt8, _ pts: UInt64) {
    var length = UInt32(data.count).bigEndian
    var timestamp = pts.bigEndian
    var output = Data(bytes: &length, count: 4)
    output.append(flags)
    output.append(Data(bytes: &timestamp, count: 8))
    output.append(data)
    FileHandle.standardOutput.write(output)
}

let startCode = Data([0, 0, 0, 1])
let outputLock = NSLock()
let keyFrameLock = NSLock()
var forceKey = true
var keyFrameRequestedAfterPTS: UInt64 = 0
let callback: VTCompressionOutputCallback = { _, _, status, infoFlags, sample in
    check(status, "Encoder output failed")
    guard !infoFlags.contains(.frameDropped), let sample else { return }
    guard let format = CMSampleBufferGetFormatDescription(sample),
          let block = CMSampleBufferGetDataBuffer(sample) else { fail("Encoder output failed: \(status)") }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
    let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool != true
    let pts = UInt64(max(0, CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), timescale: 1_000_000, method: .default).value))
    keyFrameLock.lock()
    if key && pts > keyFrameRequestedAfterPTS { forceKey = false }
    keyFrameLock.unlock()
    outputLock.lock()
    defer { outputLock.unlock() }
    if key {
        var config = Data()
        for index in 0..<2 {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            var count = 0
            var header: Int32 = 0
            check(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &header), "Parameter set")
            guard let pointer else { fail("Missing parameter set") }
            config.append(startCode)
            config.append(pointer, count: size)
        }
        packet(config, 2, pts)
    }
    let size = CMBlockBufferGetDataLength(block)
    var bytes = [UInt8](repeating: 0, count: size)
    check(CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: size, destination: &bytes), "Copy encoded data")
    var frame = Data()
    var offset = 0
    while offset < size {
        guard offset + 4 <= size else { fail("Truncated AVCC length") }
        let length = bytes[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
        offset += 4
        guard length > 0, length <= size - offset else { fail("Invalid AVCC length") }
        frame.append(startCode)
        frame.append(contentsOf: bytes[offset..<offset + length])
        offset += length
    }
    packet(frame, key ? 1 : 0, pts)
}

guard CommandLine.arguments.count == 6,
      let width = Int(CommandLine.arguments[2]), let height = Int(CommandLine.arguments[3]),
      let bitRate = Int(CommandLine.arguments[4]), let fps = Int(CommandLine.arguments[5]),
      width > 0, height > 0, width <= 16384, height <= 16384, bitRate > 0, fps > 0 else { fail("Invalid encoder arguments") }
let byteCount = width * height * 4
let fd = open(CommandLine.arguments[1], O_RDONLY)
guard fd >= 0 else { fail("Cannot open mmap file") }
var statBuffer = stat()
guard fstat(fd, &statBuffer) == 0, statBuffer.st_size >= byteCount else { fail("Mmap file too small") }
guard let mapped = mmap(nil, byteCount, PROT_READ, MAP_SHARED, fd, 0), mapped != MAP_FAILED else { fail("Cannot map pixels") }
defer { munmap(mapped, byteCount); Darwin.close(fd) }

var session: VTCompressionSession?
let specification: [CFString: Any] = [
    kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
    kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
]
check(VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264, encoderSpecification: specification as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: callback, refcon: nil, compressionSessionOut: &session), "Create encoder")
guard let session else { fail("No encoder session") }
defer { VTCompressionSessionInvalidate(session) }
for (key, value) in [
    kVTCompressionPropertyKey_RealTime: true as CFTypeRef,
    kVTCompressionPropertyKey_AllowFrameReordering: false as CFTypeRef,
    kVTCompressionPropertyKey_H264EntropyMode: kVTH264EntropyMode_CAVLC,
    kVTCompressionPropertyKey_AverageBitRate: bitRate as CFTypeRef,
    kVTCompressionPropertyKey_ExpectedFrameRate: fps as CFTypeRef,
    kVTCompressionPropertyKey_MaxKeyFrameInterval: Int32.max as CFTypeRef,
    kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Main_AutoLevel,
] { check(VTSessionSetProperty(session, key: key, value: value), "Set \(key)") }
check(VTCompressionSessionPrepareToEncodeFrames(session), "Prepare encoder")

var lastFrame: CVPixelBuffer?
var lastEncode = DispatchTime.now().uptimeNanoseconds
let epoch = lastEncode
var previousPTS: UInt64 = 0
func encode() {
    guard let frame = lastFrame else { return }
    let now = DispatchTime.now().uptimeNanoseconds
    let pts = max(previousPTS + 1, (now - epoch) / 1000)
    previousPTS = pts
    keyFrameLock.lock()
    let properties = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    keyFrameLock.unlock()
    check(VTCompressionSessionEncodeFrame(session, imageBuffer: frame, presentationTimeStamp: CMTime(value: Int64(pts), timescale: 1_000_000), duration: .invalid, frameProperties: properties, sourceFrameRefcon: nil, infoFlagsOut: nil), "Encode frame")
    lastEncode = now
}

var input = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
while true {
    let result = poll(&input, 1, 20)
    if result < 0 { if errno == EINTR { continue }; fail("stdin poll failed") }
    if result > 0 {
        var command: UInt8 = 0
        let count = Darwin.read(STDIN_FILENO, &command, 1)
        if count == 0 { break }
        if count < 0 { fail("stdin read failed") }
        if command == 102 {
            var pixel: CVPixelBuffer?
            check(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixel), "Create pixel buffer")
            guard let pixel else { fail("No pixel buffer") }
            check(CVPixelBufferLockBaseAddress(pixel, []), "Lock pixels")
            guard let destination = CVPixelBufferGetBaseAddress(pixel) else { fail("No pixel storage") }
            var source = vImage_Buffer(data: mapped, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 4)
            var target = vImage_Buffer(data: destination, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: CVPixelBufferGetBytesPerRow(pixel))
            let map: [UInt8] = [2, 1, 0, 3]
            guard vImagePermuteChannels_ARGB8888(&source, &target, map, vImage_Flags(kvImageNoFlags)) == kvImageNoError else { fail("Convert pixels failed") }
            check(CVPixelBufferUnlockBaseAddress(pixel, []), "Unlock pixels")
            lastFrame = pixel
            encode()
        } else if command == 107 {
            keyFrameLock.lock()
            forceKey = true
            keyFrameRequestedAfterPTS = previousPTS
            keyFrameLock.unlock()
            encode()
        }
    }
    if DispatchTime.now().uptimeNanoseconds - lastEncode >= 200_000_000 { encode() }
}
check(VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid), "Flush encoder")
