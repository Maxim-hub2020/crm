import SwiftUI
import WebKit

enum CRMOrigin {
    static let home = URL(string: "https://cehcrm.ru")!
    static func allows(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == home.host && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
    }
}

struct CRMWebView: UIViewRepresentable {
    let onScan: (ScanRequest) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "CEHCRM-iOS/1.0"
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.load(URLRequest(url: CRMOrigin.home))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let onScan: (ScanRequest) -> Void
        init(onScan: @escaping (ScanRequest) -> Void) { self.onScan = onScan }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "cehcrm-lidar" {
                decisionHandler(.cancel)
                if let source = action.sourceFrame.request.url, CRMOrigin.allows(source),
                   action.sourceFrame.isMainFrame, let scan = ScanRequest(url: url) { onScan(scan) }
                return
            }
            if CRMOrigin.allows(url) || url.scheme == "about" || url.scheme == "blob" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            let schemes = ["https", "tel", "mailto", "yandexmaps", "yandexnavi", "yadisk", "max"]
            if action.sourceFrame.isMainFrame, schemes.contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.targetFrame == nil, let url = action.request.url, CRMOrigin.allows(url) {
                webView.load(action.request)
            }
            return nil
        }

        private func presenter(for webView: WKWebView) -> UIViewController? {
            var controller = webView.window?.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let presenter = presenter(for: webView) else { completionHandler(); return }
            let alert = UIAlertController(title: "CEH CRM", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            presenter.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let presenter = presenter(for: webView) else { completionHandler(false); return }
            let alert = UIAlertController(title: "CEH CRM", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "Подтвердить", style: .default) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            guard let presenter = presenter(for: webView) else { completionHandler(nil); return }
            let alert = UIAlertController(title: "CEH CRM", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "Сохранить", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            presenter.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            let controller = UIAlertController(title: "CRM недоступна", message: "Проверьте интернет-соединение и повторите загрузку.", preferredStyle: .alert)
            controller.addAction(UIAlertAction(title: "Повторить", style: .default) { _ in webView.load(URLRequest(url: CRMOrigin.home)) })
            controller.addAction(UIAlertAction(title: "Закрыть", style: .cancel))
            presenter(for: webView)?.present(controller, animated: true)
        }
    }
}
