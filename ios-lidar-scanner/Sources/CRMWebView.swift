import SwiftUI
import WebKit

enum CRMOrigin {
    static let home = URL(string: "https://cehcrm.ru")!
    static func allows(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == home.host && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
    }
}

struct YandexRouteLink {
    let webURL: URL
    let mapsURL: URL
    let navigatorURL: URL?

    init?(message: [String: String]) {
        guard message["action"] == "openRoute",
              let webRaw = message["url"], let webURL = URL(string: webRaw),
              webURL.scheme == "https", webURL.host == "yandex.ru", ["/maps", "/maps/"].contains(webURL.path),
              webURL.port == nil, webURL.user == nil, webURL.password == nil,
              let webQuery = URLComponents(url: webURL, resolvingAgainstBaseURL: false)?.queryItems,
              webQuery.contains(where: { $0.name == "mode" && $0.value == "routes" }),
              webQuery.contains(where: { $0.name == "rtext" && !($0.value ?? "").isEmpty }),
              let mapsRaw = message["mapsUrl"], let mapsURL = URL(string: mapsRaw),
              mapsURL.scheme == "yandexmaps",
              (mapsRaw.hasPrefix("yandexmaps://build_route_on_map/?") &&
                mapsRaw.contains("lat_to=") && mapsRaw.contains("lon_to=") ||
                mapsRaw.hasPrefix("yandexmaps://maps.yandex.ru/?") && mapsRaw.contains("mode=routes")) else { return nil }
        if let navigatorRaw = message["navigatorUrl"], !navigatorRaw.isEmpty {
            guard let navigatorURL = URL(string: navigatorRaw), navigatorURL.scheme == "yandexnavi",
                  navigatorRaw.hasPrefix("yandexnavi://build_route_on_map?") else { return nil }
            self.navigatorURL = navigatorURL
        } else {
            navigatorURL = nil
        }
        self.webURL = webURL
        self.mapsURL = mapsURL
    }
}

struct CRMWebView: UIViewRepresentable {
    var reloadID = 0
    var visitProjectID: Int?
    var visitOpenSequence = 0
    let onScan: (ScanRequest) -> Void

    static var versionLabel: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(version) (\(build))"
    }

    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        configuration.applicationNameForUserAgent = "CEHCRM-iOS/\(versionLabel)"
        let info: [String: String] = ["version": versionLabel, "origin": CRMOrigin.home.absoluteString]
        let json = String(data: try! JSONSerialization.data(withJSONObject: info), encoding: .utf8)!
        // Announce the native capabilities before the CRM's first render.
        let script = """
        (() => {
          const info = \(json);
          if (location.origin !== info.origin) return;
          window.CEHCRMNative = Object.freeze({
            version: info.version,
            capabilities: Object.freeze({route: true, visitAlerts: true}),
            postMessage: (message) => window.webkit.messageHandlers.cehCRM.postMessage(message)
          });
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.dataset.cehNative = info.version;
          }, {once: true});
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return configuration
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = Self.configuration()
        configuration.userContentController.add(context.coordinator, name: "cehCRM")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.load(URLRequest(url: CRMOrigin.home, cachePolicy: .reloadRevalidatingCacheData))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        if let visitProjectID, context.coordinator.visitOpenSequence != visitOpenSequence {
            context.coordinator.visitOpenSequence = visitOpenSequence
            var url = URLComponents(url: CRMOrigin.home.appendingPathComponent("projects"), resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "visit", value: String(visitProjectID))]
            if let target = url.url { uiView.load(URLRequest(url: target)) }
            return
        }
        guard context.coordinator.reloadID != reloadID else { return }
        context.coordinator.reloadID = reloadID
        uiView.load(URLRequest(url: CRMOrigin.home, cachePolicy: .reloadRevalidatingCacheData))
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "cehCRM")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let onScan: (ScanRequest) -> Void
        var reloadID = 0
        var visitOpenSequence = 0
        init(onScan: @escaping (ScanRequest) -> Void) { self.onScan = onScan }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  origin.host == CRMOrigin.home.host, origin.`protocol` == "https",
                  origin.port == 0 || origin.port == 443,
                  let body = message.body as? [String: Any],
                  let webView = message.webView else { return }
            if body["action"] as? String == "syncVisitLocations",
               let projects = body["projects"] as? [[String: Any]] {
                VisitProximityManager.shared.sync(projects)
                return
            }
            if body["action"] as? String == "clearVisitLocations" {
                VisitProximityManager.shared.clear()
                return
            }
            guard let body = body as? [String: String],
                  let rawURL = body["url"], let url = URL(string: rawURL) else { return }
            if body["action"] == "scan", let scan = ScanRequest(url: url) { onScan(scan) }
            if body["action"] == "openRoute" {
                if let route = YandexRouteLink(message: body) {
                    openRoute(route, from: webView)
                } else if url.scheme == "https", url.host == "yandex.ru", ["/maps", "/maps/"].contains(url.path) {
                    openExternal(url, from: webView)
                }
            }
            if body["action"] == "openExternal", url.scheme == "https", url.user == nil, url.password == nil {
                openExternal(url, from: webView)
            }
        }

        private func openRoute(_ route: YandexRouteLink, from webView: WKWebView) {
            let candidates = [route.mapsURL, route.navigatorURL].compactMap { $0 }
            openRouteCandidate(candidates, index: 0, fallback: route.webURL, from: webView)
        }

        private func openRouteCandidate(_ candidates: [URL], index: Int, fallback: URL, from webView: WKWebView) {
            guard index < candidates.count else {
                openExternal(fallback, from: webView)
                return
            }
            UIApplication.shared.open(candidates[index]) { opened in
                if !opened {
                    DispatchQueue.main.async {
                        self.openRouteCandidate(candidates, index: index + 1, fallback: fallback, from: webView)
                    }
                }
            }
        }

        private func openExternal(_ url: URL, from webView: WKWebView) {
            UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
                guard !opened else { return }
                DispatchQueue.main.async {
                    guard ["disk.yandex.ru", "disk.yandex.com", "yadi.sk"].contains(url.host ?? "") else {
                        UIApplication.shared.open(url)
                        return
                    }
                    let alert = UIAlertController(title: "Не удалось открыть папку в приложении Диска",
                        message: "Яндекс.Диск не принял эту ссылку. Для закрытых папок переход может быть недоступен. Открыть ту же папку в браузере?", preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: "Остаться в CRM", style: .cancel))
                    alert.addAction(UIAlertAction(title: "Открыть в браузере", style: .default) { _ in UIApplication.shared.open(url) })
                    self.presenter(for: webView)?.present(alert, animated: true)
                }
            }
        }

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
                if url.scheme == "https" { openExternal(url, from: webView) }
                else { UIApplication.shared.open(url) }
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
