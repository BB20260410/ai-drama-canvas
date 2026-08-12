import AppKit
import Foundation

struct ReceiverReady: Codable {
    let processId: Int32
    let windowTitle: String
    let windowFrame: [String: Double]
    let dropTarget: [String: Int]
}

struct ReceiverReceipt: Codable {
    let receivedAt: String
    let sourcePath: String
    let targetPath: String
    let fileName: String
}

final class NativeFileDropView: NSView {
    private let outputDirectory: URL
    private let receiptPath: URL
    private var status = "把画布图片拖到这里"

    init(frame frameRect: NSRect, outputDirectory: URL, receiptPath: URL) {
        self.outputDirectory = outputDirectory
        self.receiptPath = receiptPath
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
        dirtyRect.fill()
        let inset = bounds.insetBy(dx: 28, dy: 28)
        let border = NSBezierPath(roundedRect: inset, xRadius: 18, yRadius: 18)
        border.lineWidth = 4
        NSColor(calibratedRed: 0.83, green: 0.65, blue: 0.25, alpha: 1).setStroke()
        border.stroke()
        let attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor(calibratedWhite: 0.94, alpha: 1),
            .font: NSFont.systemFont(ofSize: 24, weight: .semibold),
            .paragraphStyle: {
                let style = NSMutableParagraphStyle()
                style.alignment = .center
                return style
            }(),
        ]
        NSString(string: status).draw(
            in: NSRect(x: inset.minX + 20, y: inset.midY - 24, width: inset.width - 40, height: 60),
            withAttributes: attributes
        )
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) else { return [] }
        status = "松开即可复制"
        needsDisplay = true
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        status = "把画布图片拖到这里"
        needsDisplay = true
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        return true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL], let source = urls.first else { return false }
        let target = outputDirectory.appendingPathComponent(source.lastPathComponent, isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.copyItem(at: source, to: target)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let receipt = ReceiverReceipt(
                receivedAt: formatter.string(from: Date()),
                sourcePath: source.path,
                targetPath: target.path,
                fileName: source.lastPathComponent
            )
            try JSONEncoder().encode(receipt).write(to: receiptPath, options: .atomic)
            status = "已复制：\(source.lastPathComponent)"
            needsDisplay = true
            return true
        } catch {
            status = "复制失败：\(error.localizedDescription)"
            needsDisplay = true
            fputs("drop receiver failed: \(error)\n", stderr)
            return false
        }
    }
}

guard CommandLine.arguments.count == 4 else {
    fputs("usage: native-media-drag-drop-receiver <output-dir> <ready-json> <receipt-json>\n", stderr)
    exit(64)
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let readyPath = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: false)
let receiptPath = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: false)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
guard let screen = NSScreen.screens.first else {
    fputs("drop receiver cannot resolve a screen\n", stderr)
    exit(1)
}
let visible = screen.visibleFrame
let width = min(520, max(360, visible.width / 3))
let height = min(720, max(520, visible.height - 120))
let frame = NSRect(
    x: visible.maxX - width,
    y: visible.minY + (visible.height - height) / 2,
    width: width,
    height: height
)
let window = NSWindow(
    contentRect: frame,
    styleMask: [.titled, .closable],
    backing: .buffered,
    defer: false
)
window.title = "AI Canvas Native Drop Receiver"
window.contentView = NativeFileDropView(
    frame: NSRect(origin: .zero, size: frame.size),
    outputDirectory: outputDirectory,
    receiptPath: receiptPath
)
window.isReleasedWhenClosed = false
window.orderFrontRegardless()

let ready = ReceiverReady(
    processId: ProcessInfo.processInfo.processIdentifier,
    windowTitle: window.title,
    windowFrame: [
        "x": frame.origin.x,
        "y": frame.origin.y,
        "width": frame.width,
        "height": frame.height,
    ],
    dropTarget: [
        "x": Int(frame.midX.rounded()),
        "y": Int((screen.frame.maxY - frame.midY).rounded()),
    ]
)
try JSONEncoder().encode(ready).write(to: readyPath, options: .atomic)
application.run()
