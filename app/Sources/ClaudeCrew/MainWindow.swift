import AppKit
import WebKit

@MainActor
final class MainWindow: NSWindow {
    let webView: WKWebView

    init(port: Int) {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        self.webView = webView

        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        self.title = "Claude Crew"
        self.contentView = webView
        self.center()
        self.setFrameAutosaveName("ClaudeCrewMainWindow")
        self.minSize = NSSize(width: 640, height: 480)
        self.backgroundColor = NSColor(red: 0.059, green: 0.059, blue: 0.102, alpha: 1.0) // #0f0f1a
        self.isReleasedWhenClosed = false
        self.titlebarAppearsTransparent = true
        self.titleVisibility = .hidden

        // Toolbar styling
        let toolbar = NSToolbar(identifier: "MainToolbar")
        toolbar.showsBaselineSeparator = false
        self.toolbar = toolbar
    }

    func loadUI(port: Int) {
        guard let url = URL(string: "http://127.0.0.1:\(port)") else { return }
        webView.load(URLRequest(url: url))
    }
}
