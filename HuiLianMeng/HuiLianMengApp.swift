import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = WebHostController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class WebHostController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        let userContentController = WKUserContentController()
        userContentController.add(self, name: "exportFile")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = userContentController
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = .default()

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }

        view.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.91, alpha: 1)
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        let webRoot =
            Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web")?
                .deletingLastPathComponent()
            ?? Bundle.main.url(forResource: "index", withExtension: "html")?
                .deletingLastPathComponent()
        guard let webRoot else {
            showStartupError("应用资源不完整：缺少 index.html。")
            return
        }

        let indexURL = webRoot.appendingPathComponent("index.html")
        webView.loadFileURL(indexURL, allowingReadAccessTo: webRoot)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            message.name == "exportFile",
            let body = message.body as? [String: Any],
            let name = body["name"] as? String,
            let base64 = body["base64"] as? String,
            let data = Data(base64Encoded: base64)
        else {
            return
        }

        let safeName = URL(fileURLWithPath: name).lastPathComponent
        let filename = safeName.isEmpty ? "download" : safeName
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent(filename)

        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: .atomic)
            presentExporter(for: fileURL)
        } catch {
            showStartupError("文件保存失败：\(error.localizedDescription)")
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        if url.isFileURL || ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    private func presentExporter(for fileURL: URL) {
        if presentedViewController != nil {
            dismiss(animated: false)
        }
        let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
        picker.shouldShowFileExtensions = true
        present(picker, animated: true)
    }

    private func showStartupError(_ message: String) {
        let alert = UIAlertController(title: "回联盟", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "关闭", style: .default))
        present(alert, animated: true)
    }
}
